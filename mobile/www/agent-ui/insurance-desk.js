// Insurance Desk: a health and life insurance agent's book of business, kept on this device.
//
//   CodevInsuranceDesk.createDeskStore(storage, opts)   clients, policies, SOAs, statements, settings (localStorage)
//   CodevInsuranceDesk.computeAlerts(clients, today)    Turning 65, AEP, OEP, renewals, pending policies, SOAs, follow-ups
//   CodevInsuranceDesk.reconcile(store, opts)           carrier commission statements against the book
//   CodevInsuranceDesk.buildDeskTools(store, deps)      insurance_* tools for agents (only when the user allows it)
//   CodevInsuranceDesk.mount(container, store, deps)    the 🩺 Insurance view
//
// Client records hold health details (doctors, prescriptions), so:
//   - Nothing leaves the device unless the user exports it. There is no server copy.
//   - A passphrase encrypts the book and its documents (AES-GCM, key from PBKDF2), and the
//     view locks itself after a while idle. Without the passphrase the data can't be read back.
//   - Agents see client data only when the user turns that on, because the agents' model
//     provider then receives it. Agents can't delete, sign SOAs, or submit applications.
//   - Each client keeps an append-only activity log, and SOAs and documents keep a SHA-256
//     fingerprint so an audit can tell they weren't changed after signing or upload.
//
// The dates follow CMS and HealthCare.gov rules as of 2026 (see ENROLLMENT_NOTES). They are
// reminders, not compliance advice: the agent's FMO and carriers have the final word.
//
// Everything typed by the user or written by a model is set with textContent.
// The same file runs in the page and in Node (tests), like story-studio.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevInsuranceDesk = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const STORE_KEY = "codev_insurance_desk";
    const DOCS_DB = "codev_insurance_docs";
    const MAX_CLIENTS = 5000;
    const MAX_TEXT = 4000;
    const MAX_NOTES = 400;
    const MAX_LOG = 600;
    const MAX_DOC_BYTES = 25 * 1024 * 1024;
    const MAX_STATEMENT_LINES = 20000;
    const PBKDF2_ITERATIONS = 210000;
    const AUTO_LOCK_MS = 15 * 60 * 1000;
    const DAY = 86400000;

    const PLAN_TYPES = [
        ["aca", "ACA / Marketplace", "health"], ["ma", "Medicare Advantage", "medicare"], ["mapd", "Medicare Advantage + drugs (MAPD)", "medicare"],
        ["medsupp", "Medicare Supplement", "medicare"], ["pdp", "Part D drug plan (PDP)", "medicare"], ["group", "Group health", "health"],
        ["ichra", "ICHRA", "health"], ["shortterm", "Short-term medical", "health"], ["dvh", "Dental / vision / hearing", "ancillary"],
        ["hip", "Hospital indemnity", "ancillary"], ["critical", "Critical illness / cancer", "ancillary"],
        ["term", "Term life", "life"], ["whole", "Whole life", "life"], ["final", "Final expense", "life"], ["iul", "Indexed universal life", "life"],
        ["annuity", "Annuity", "life"], ["other", "Other", "other"]
    ];
    const PLAN_LABEL = Object.fromEntries(PLAN_TYPES.map(([k, l]) => [k, l]));
    const PLAN_GROUP = Object.fromEntries(PLAN_TYPES.map(([k, , g]) => [k, g]));
    const MA_TYPES = new Set(["ma", "mapd"]);
    const AEP_TYPES = new Set(["ma", "mapd", "pdp"]);
    const POLICY_STATUS = [["quoted", "Quoted"], ["pending", "Pending"], ["active", "Active"], ["terminated", "Terminated"], ["cancelled", "Cancelled"]];
    const CLIENT_STATUS = [["lead", "Lead"], ["prospect", "Prospect"], ["client", "Client"], ["inactive", "Inactive"]];
    const COMMISSION_TYPES = [
        ["", "Not set"], ["pmpm", "$ per member per month"], ["monthly", "$ per month"], ["percent", "% of monthly premium"],
        ["annual_monthly", "$ per year, paid monthly"], ["annual_lump", "$ per year, paid in the anniversary month"]
    ];
    // The five product types on CMS's model Scope of Appointment form.
    const SOA_PRODUCTS = [["pdp", "Stand-alone Medicare prescription drug plans (Part D)"], ["ma", "Medicare Advantage plans (Part C) and Cost plans"],
        ["dvh", "Dental, vision, hearing products"], ["hip", "Hospital indemnity products"], ["medsupp", "Medicare Supplement (Medigap) products"]];
    const SOA_METHODS = [["in_person", "In person"], ["phone", "Phone"], ["virtual", "Video call"]];
    const SIGN_METHODS = [["drawn", "Signed on this device"], ["typed", "Typed name (e-signature)"], ["recorded", "Verbal consent on a recorded call"]];
    const RELATIONS = [["spouse", "Spouse"], ["child", "Child"], ["dependent", "Other dependent"]];
    const DOC_KINDS = [["application", "Signed application"], ["soa", "Scope of Appointment"], ["recording", "Call recording"], ["drug_list", "Drug list"],
        ["id_card", "ID card"], ["statement", "Carrier letter / statement"], ["other", "Other"]];
    const DEFAULT_PORTALS = [
        { name: "Medicare Plan Finder", url: "https://www.medicare.gov/plan-compare/", note: "Free, public. MA, MAPD, PDP and Medigap with drug costs." },
        { name: "HealthCare.gov window shopping", url: "https://www.healthcare.gov/see-plans/", note: "Free, public. ACA plans and subsidy estimates (federal states)." },
        { name: "HealthSherpa", url: "https://www.healthsherpa.com/", note: "Your agent account. ACA quoting and enrollment." },
        { name: "Sunfire", url: "https://www.sunfirematrix.com/", note: "Your FMO's Sunfire link. Medicare quoting and enrollment." },
        { name: "Quotit", url: "https://www.quotit.com/", note: "Your Quotit account. Individual, family and small group." }
    ];
    const ENROLLMENT_NOTES = {
        turning65: "Initial Enrollment Period: the 3 months before the 65th birthday month, that month, and the 3 months after. Coverage can start the 1st of the birthday month (the month before when the birthday is on the 1st).",
        medigap: "Medigap Open Enrollment: 6 months from the month Part B starts at 65 or older. Plans must accept them without health questions.",
        aep: "Annual Enrollment Period: October 15 to December 7, changes start January 1. Marketing for next year may start October 1.",
        maOep: "Medicare Advantage Open Enrollment: January 1 to March 31. One switch to another MA plan or back to Original Medicare.",
        acaOep: "ACA Open Enrollment on HealthCare.gov: November 1 to January 15 (enroll by December 15 for January 1). State exchanges can differ.",
        soa: "CMS: document the SOA at least 48 hours before a scheduled appointment, except walk-ins the beneficiary starts and the last 4 days of an enrollment period. An SOA is good for 12 months after it's signed. Keep records 10 years."
    };

    // ---------- small helpers ----------

    function nowIso() { return new Date().toISOString(); }
    function newId(prefix) { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }
    function clip(text, max = MAX_TEXT) { return String(text == null ? "" : text).slice(0, max); }
    function clean(text, max = MAX_TEXT) { return clip(text, max).replace(/\r\n?/g, "\n").trim(); }
    function norm(text) { return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
    function sameName(a, b) { return String(a || "").trim().toLowerCase().replace(/\s+/g, " ") === String(b || "").trim().toLowerCase().replace(/\s+/g, " "); }
    function num(value) {
        if (value == null || value === "") return null;
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        let s = String(value).trim();
        // ($12.00), -12, $-12 and 12- are all negative.
        const negative = /^\(.*\)$/.test(s) || /^\$?\s*-/.test(s) || /-$/.test(s);
        s = s.replace(/[()$,\s%]/g, "").replace(/^-|-$/g, "");
        if (!s || !/^\d*\.?\d+$/.test(s)) return null;
        const n = Number(s);
        return negative ? -n : n;
    }
    function money(n) { return n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`; }
    function round2(n) { return Math.round(n * 100) / 100; }

    // Dates are "YYYY-MM-DD" strings in the user's own calendar; arithmetic is on whole days.
    function pad(n) { return String(n).padStart(2, "0"); }
    function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
    function todayStr(date = new Date()) {
        if (typeof date === "string") return parseDate(date) || todayStr();
        return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate());
    }
    const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    // Reads 2026-03-15, 3/15/2026, 03-15-26, 2026/3/15, 20260315 and Mar 15 2026; null if it isn't a date.
    function parseDate(text) {
        if (!text) return null;
        if (text instanceof Date) return isNaN(text) ? null : todayStr(text);
        const s = String(text).trim();
        let y, m, d, x;
        if ((x = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [y, m, d] = [+x[1], +x[2], +x[3]];
        else if ((x = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) [m, d, y] = [+x[1], +x[2], +x[3]];
        else if ((x = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [y, m, d] = [+x[1], +x[2], +x[3]];
        else if ((x = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/))) [m, d, y] = [MONTHS.indexOf(x[1].toLowerCase()) + 1, +x[2], +x[3]];
        else return null;
        if (y < 100) y += y > 50 ? 1900 : 2000;
        if (!(m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m))) return null;
        return ymd(y, m, d);
    }
    // A statement's month: 2026-03, 03/2026, Mar 2026, March 2026, or any full date.
    function parseMonth(text) {
        if (!text) return null;
        const s = String(text).trim();
        let x;
        if ((x = s.match(/^(\d{4})[-/.](\d{1,2})$/))) return +x[2] >= 1 && +x[2] <= 12 ? `${x[1]}-${pad(+x[2])}` : null;
        if ((x = s.match(/^(\d{1,2})[-/.](\d{4})$/))) return +x[1] >= 1 && +x[1] <= 12 ? `${x[2]}-${pad(+x[1])}` : null;
        if ((x = s.match(/^([A-Za-z]{3})[a-z]*\.?\s*[-,]?\s*(\d{4})$/))) { const m = MONTHS.indexOf(x[1].toLowerCase()) + 1; return m ? `${x[2]}-${pad(m)}` : null; }
        const full = parseDate(s);
        return full ? full.slice(0, 7) : null;
    }
    function parts(date) { const [y, m, d] = date.split("-").map(Number); return { y, m, d }; }
    function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
    function dayNum(date) { const { y, m, d } = parts(date); return Date.UTC(y, m - 1, d) / DAY; }
    function fromDayNum(n) { const t = new Date(n * DAY); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
    function addDays(date, n) { return fromDayNum(dayNum(date) + n); }
    function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
    function addMonths(date, n) {
        const { y, m, d } = parts(date);
        const total = y * 12 + (m - 1) + n;
        const ny = Math.floor(total / 12), nm = total % 12 + 1;
        return ymd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
    }
    function monthStart(date) { return date.slice(0, 8) + "01"; }
    function monthEnd(date) { const { y, m } = parts(date); return ymd(y, m, daysInMonth(y, m)); }
    function monthsBetween(fromMonth, toMonth) {
        const out = [];
        let [y, m] = fromMonth.split("-").map(Number);
        const [ty, tm] = toMonth.split("-").map(Number);
        while ((y < ty || (y === ty && m <= tm)) && out.length < 120) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
        return out;
    }
    function ageOn(dob, date) {
        const b = parts(dob), t = parts(date);
        return t.y - b.y - (t.m < b.m || (t.m === b.m && t.d < b.d) ? 1 : 0);
    }
    function niceDate(date) {
        if (!date) return "";
        const { y, m, d } = parts(date);
        return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${d}, ${y}`;
    }
    // The next time month/day of `date` comes round, on or after `from`.
    function nextAnniversary(date, from) {
        const { y } = parts(from);
        const start = parts(date);
        if (start.y > y || date >= from) return date;
        for (let year = y; year <= y + 1; year++) {
            const candidate = ymd(year, start.m, Math.min(start.d, daysInMonth(year, start.m)));
            if (candidate >= from) return candidate;
        }
        return null;
    }

    // ---------- the record shapes ----------

    function normalizeMember(m) {
        if (!m || typeof m !== "object") return null;
        const name = clean(m.name, 120);
        if (!name) return null;
        return { id: m.id || newId("mem"), name, relation: RELATIONS.some(([k]) => k === m.relation) ? m.relation : "dependent",
            dob: parseDate(m.dob) || "", tobacco: Boolean(m.tobacco), notes: clean(m.notes, 1000) };
    }
    function normalizeMed(m) {
        if (typeof m === "string") m = { name: m };
        if (!m || typeof m !== "object" || !clean(m.name, 160)) return null;
        return { name: clean(m.name, 160), dose: clean(m.dose, 80), frequency: clean(m.frequency, 80) };
    }
    function normalizeDoctor(d) {
        if (typeof d === "string") d = { name: d };
        if (!d || typeof d !== "object" || !clean(d.name, 160)) return null;
        return { name: clean(d.name, 160), specialty: clean(d.specialty, 80), location: clean(d.location, 200), npi: clean(d.npi, 20).replace(/\D/g, "") };
    }
    function normalizePolicy(p, old = {}) {
        const merged = { ...old, ...p };
        const type = PLAN_LABEL[merged.planType] ? merged.planType : (old.planType || "other");
        const commission = { ...(old.commission || {}), ...(p.commission || {}) };
        return {
            id: old.id || merged.id || newId("pol"),
            planType: type,
            carrier: clean(merged.carrier, 120),
            planName: clean(merged.planName, 200),
            policyNumber: clean(merged.policyNumber, 60),
            memberId: clean(merged.memberId, 60),
            status: POLICY_STATUS.some(([k]) => k === merged.status) ? merged.status : "active",
            effectiveDate: parseDate(merged.effectiveDate) || "",
            renewalDate: parseDate(merged.renewalDate) || "",
            termDate: parseDate(merged.termDate) || "",
            conversionDeadline: parseDate(merged.conversionDeadline) || "",
            premium: num(merged.premium),
            membersCovered: Math.max(1, Math.round(num(merged.membersCovered) || 1)),
            faceAmount: num(merged.faceAmount),
            beneficiary: clean(merged.beneficiary, 200),
            writingAgent: clean(merged.writingAgent, 120),
            commission: {
                type: COMMISSION_TYPES.some(([k]) => k === commission.type) ? commission.type : "",
                amount: num(commission.amount),
                renewalAmount: num(commission.renewalAmount),
                notes: clean(commission.notes, 500)
            },
            notes: clean(merged.notes, 2000),
            createdAt: old.createdAt || nowIso(),
            updatedAt: nowIso()
        };
    }
    const CLIENT_FIELDS = ["name", "phone", "email", "dob", "address", "city", "state", "zip", "county", "status", "leadSource", "tags",
        "householdIncome", "householdSize", "tobacco", "partADate", "partBDate", "pharmacy", "followUp", "followUpNote", "summary"];
    function normalizeClient(data, old = null) {
        const c = old ? { ...old } : { id: newId("cli"), createdAt: nowIso(), members: [], policies: [], doctors: [], medications: [], notes: [], documents: [], quotes: [], log: [] };
        for (const key of CLIENT_FIELDS) if (data[key] !== undefined) c[key] = data[key];
        c.name = clean(c.name, 120);
        c.phone = clean(c.phone, 40); c.email = clean(c.email, 160);
        for (const key of ["dob", "partADate", "partBDate", "followUp"]) c[key] = parseDate(c[key]) || "";
        for (const key of ["address", "city", "county", "leadSource", "pharmacy", "followUpNote", "summary"]) c[key] = clean(c[key], key === "summary" ? 1000 : 200);
        c.state = clean(c.state, 2).toUpperCase();
        c.zip = clean(c.zip, 10).replace(/[^\d-]/g, "");
        c.status = CLIENT_STATUS.some(([k]) => k === c.status) ? c.status : (old ? old.status : "lead");
        c.tags = (Array.isArray(c.tags) ? c.tags : String(c.tags || "").split(",")).map(t => clean(t, 40)).filter(Boolean).slice(0, 20);
        c.householdIncome = num(c.householdIncome);
        c.householdSize = c.householdSize == null || c.householdSize === "" ? null : Math.max(1, Math.round(num(c.householdSize) || 1));
        c.tobacco = Boolean(c.tobacco);
        if (data.members !== undefined) c.members = (Array.isArray(data.members) ? data.members : []).map(normalizeMember).filter(Boolean).slice(0, 15);
        if (data.doctors !== undefined) c.doctors = (Array.isArray(data.doctors) ? data.doctors : []).map(normalizeDoctor).filter(Boolean).slice(0, 40);
        if (data.medications !== undefined) c.medications = (Array.isArray(data.medications) ? data.medications : []).map(normalizeMed).filter(Boolean).slice(0, 60);
        for (const key of ["members", "policies", "doctors", "medications", "notes", "documents", "quotes", "log"]) if (!Array.isArray(c[key])) c[key] = [];
        c.updatedAt = nowIso();
        return c;
    }

    // ---------- encryption (WebCrypto: the page, Node 18+) ----------

    function subtle() {
        const c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
        return c && c.subtle ? c : null;
    }
    function toB64(bytes) {
        bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
    }
    function fromB64(text) {
        if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
        const s = atob(text);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }
    async function sha256Hex(data) {
        const c = subtle();
        if (!c) return "";
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        const hash = new Uint8Array(await c.subtle.digest("SHA-256", bytes));
        return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
    }
    async function deriveKey(passphrase, salt) {
        const c = subtle();
        if (!c) throw new Error("This browser can't encrypt (no WebCrypto).");
        const base = await c.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
        return c.subtle.deriveKey({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    }
    async function encryptBytes(key, bytes) {
        const c = subtle();
        const iv = c.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await c.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
        return { iv: toB64(iv), ct: toB64(ct) };
    }
    async function decryptBytes(key, box) {
        const c = subtle();
        return new Uint8Array(await c.subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct)));
    }

    // ---------- the store ----------

    function emptyState() {
        return {
            clients: [], soas: [], statements: [],
            settings: { agentName: "", npn: "", agency: "", agentAccess: false, tolerance: 1, alertDays: 90, portals: DEFAULT_PORTALS.map(p => ({ ...p })) }
        };
    }
    function adoptState(saved) {
        const state = emptyState();
        if (!saved || typeof saved !== "object") return state;
        if (Array.isArray(saved.clients)) state.clients = saved.clients.filter(c => c && c.id && c.name).map(c => normalizeClient({}, c));
        state.clients.forEach(c => { c.policies = (c.policies || []).filter(p => p && p.id); });
        if (Array.isArray(saved.soas)) state.soas = saved.soas.filter(s => s && s.id);
        if (Array.isArray(saved.statements)) state.statements = saved.statements.filter(s => s && s.id && Array.isArray(s.lines));
        if (saved.settings && typeof saved.settings === "object") state.settings = { ...state.settings, ...saved.settings };
        if (!Array.isArray(state.settings.portals) || !state.settings.portals.length) state.settings.portals = DEFAULT_PORTALS.map(p => ({ ...p }));
        return state;
    }

    // storage: localStorage (or a stand-in with getItem/setItem). opts.docs: a document backend
    // ({ put(id, record), get(id), remove(id), keys() }); the page passes IndexedDB, tests a Map.
    function createDeskStore(storage, opts = {}) {
        const key = opts.key || STORE_KEY;
        const docsBackend = opts.docs || memoryDocs();
        let state = emptyState();
        let envelope = null;           // { salt, iv, ct } while a passphrase is set
        let cryptoKey = null;          // the derived key, only while unlocked
        let locked = false;
        let writing = Promise.resolve();
        let lastError = "";
        const listeners = new Set();

        try {
            const raw = storage && storage.getItem(key);
            const saved = raw ? JSON.parse(raw) : null;
            if (saved && saved.enc) { envelope = saved.enc; locked = true; } else if (saved) state = adoptState(saved.data || saved);
        } catch (err) { /* start empty */ }

        function notify() { listeners.forEach(fn => { try { fn(); } catch (err) { /* a view's problem */ } }); }
        function write() {
            if (locked) return "The desk is locked.";
            const snapshot = JSON.stringify(state);
            if (!cryptoKey) {
                try { storage && storage.setItem(key, JSON.stringify({ v: 1, data: JSON.parse(snapshot) })); lastError = ""; } catch (err) {
                    lastError = "Couldn't save: this device's storage is full. Export a backup, then delete old statements.";
                }
                notify();
                return lastError;
            }
            const k = cryptoKey, salt = envelope.salt;
            writing = writing.then(async () => {
                const box = await encryptBytes(k, new TextEncoder().encode(snapshot));
                envelope = { salt, ...box };
                try { storage && storage.setItem(key, JSON.stringify({ v: 1, enc: envelope })); lastError = ""; } catch (err) { lastError = "Couldn't save: this device's storage is full."; }
            }).catch(err => { lastError = `Couldn't save: ${err.message}`; });
            notify();
            return "";
        }
        function logTo(client, what) {
            client.log.push({ at: nowIso(), what: clip(what, 300) });
            if (client.log.length > MAX_LOG) client.log.splice(0, client.log.length - MAX_LOG);
        }

        function clients() { return locked ? [] : state.clients; }
        function client(idOrName) {
            if (locked || !idOrName) return null;
            return state.clients.find(c => c.id === idOrName) || state.clients.find(c => sameName(c.name, idOrName))
                || state.clients.find(c => c.members.some(m => sameName(m.name, idOrName))) || null;
        }
        function search(query) {
            const q = String(query || "").toLowerCase().trim();
            if (!q) return clients();
            const digits = q.replace(/\D/g, "");
            return clients().filter(c => {
                const hay = [c.name, c.email, c.city, c.county, c.state, c.zip, c.status, c.tags.join(" "), ...c.members.map(m => m.name),
                    ...c.policies.map(p => `${p.carrier} ${p.planName} ${PLAN_LABEL[p.planType]} ${p.policyNumber} ${p.memberId}`)].join(" ").toLowerCase();
                return hay.includes(q) || (digits.length >= 4 && String(c.phone).replace(/\D/g, "").includes(digits));
            });
        }
        function saveClient(data = {}) {
            if (locked) return { error: "The desk is locked." };
            // A new client from the form (_new) never merges into an existing one with the same name.
            const old = data.id ? state.clients.find(c => c.id === data.id) : (data.name && !data._new ? state.clients.find(c => sameName(c.name, data.name)) : null);
            if (!old && !clean(data.name, 120)) return { error: "A client needs a name." };
            if (!old && state.clients.length >= MAX_CLIENTS) return { error: `CoDev keeps up to ${MAX_CLIENTS} clients on one device.` };
            const c = normalizeClient(data, old);
            if (!c.name) return { error: "A client needs a name." };
            const clash = state.clients.find(x => x !== old && sameName(x.name, c.name));
            if (clash) return { error: `There's already a client named "${c.name}".` };
            if (old) {
                const changed = Object.keys(data).filter(k => !["id", "_by", "_new"].includes(k) && JSON.stringify(old[k]) !== JSON.stringify(c[k]));
                if (changed.length) logTo(c, `Edited ${changed.join(", ")}${data._by ? ` (${data._by})` : ""}`);
                state.clients[state.clients.indexOf(old)] = c;
            } else {
                logTo(c, `Client added${data._by ? ` by ${data._by}` : ""}`);
                state.clients.push(c);
            }
            return { client: c, created: !old, error: write() || undefined };
        }
        async function removeClient(id) {
            const c = client(id);
            if (!c) return false;
            for (const d of c.documents) await docsBackend.remove(d.id);
            state.clients = state.clients.filter(x => x !== c);
            state.soas = state.soas.filter(s => s.clientId !== c.id);
            write();
            return true;
        }
        function savePolicy(clientId, data = {}) {
            const c = client(clientId);
            if (!c) return { error: "No such client." };
            const old = data.id ? c.policies.find(p => p.id === data.id) : null;
            const p = normalizePolicy(data, old || {});
            if (old) c.policies[c.policies.indexOf(old)] = p; else c.policies.push(p);
            logTo(c, `${old ? "Updated" : "Added"} policy: ${PLAN_LABEL[p.planType]}${p.carrier ? `, ${p.carrier}` : ""}${p.planName ? ` ${p.planName}` : ""} (${p.status})${data._by ? ` (${data._by})` : ""}`);
            if (p.status === "active" && c.status !== "client") c.status = "client";
            c.updatedAt = nowIso();
            return { policy: p, created: !old, error: write() || undefined };
        }
        function removePolicy(clientId, policyId) {
            const c = client(clientId);
            const p = c && c.policies.find(x => x.id === policyId);
            if (!p) return false;
            c.policies = c.policies.filter(x => x !== p);
            logTo(c, `Removed policy: ${PLAN_LABEL[p.planType]}${p.carrier ? `, ${p.carrier}` : ""}`);
            write();
            return true;
        }
        function addNote(clientId, text, { kind = "note", by = "" } = {}) {
            const c = client(clientId);
            const body = clean(text, MAX_TEXT);
            if (!c || !body) return { error: c ? "The note is empty." : "No such client." };
            const note = { id: newId("note"), at: nowIso(), kind: kind === "call" ? "call" : "note", text: body, by: clean(by, 80) };
            c.notes.push(note);
            if (c.notes.length > MAX_NOTES) c.notes.splice(0, c.notes.length - MAX_NOTES);
            logTo(c, `${note.kind === "call" ? "Call note" : "Note"} added${by ? ` by ${by}` : ""}`);
            write();
            return { note };
        }
        function addQuote(clientId, quote = {}) {
            const c = client(clientId);
            if (!c) return { error: "No such client." };
            const plans = (Array.isArray(quote.plans) ? quote.plans : []).slice(0, 20).map(p => ({
                carrier: clean(p.carrier, 120), plan: clean(p.plan, 200), premium: num(p.premium), deductible: num(p.deductible), moop: num(p.moop),
                drugCost: num(p.drugCost), doctorsInNetwork: clean(p.doctorsInNetwork, 300), stars: clean(p.stars, 10), notes: clean(p.notes, 500)
            })).filter(p => p.carrier || p.plan);
            const q = { id: newId("quote"), at: nowIso(), portal: clean(quote.portal, 120), summary: clean(quote.summary, 2000), plans, by: clean(quote.by, 80) };
            c.quotes.push(q);
            if (c.quotes.length > 50) c.quotes.shift();
            logTo(c, `Quote saved from ${q.portal || "a quoting site"} (${plans.length} plans)${q.by ? ` by ${q.by}` : ""}`);
            write();
            return { quote: q };
        }

        // Documents: bytes in the backend (encrypted when a passphrase is set), the list on the client.
        async function addDocument(clientId, { name, type = "application/octet-stream", bytes, kind = "other" }) {
            const c = client(clientId);
            if (!c) return { error: "No such client." };
            bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
            if (!bytes.length) return { error: "The file is empty." };
            if (bytes.length > MAX_DOC_BYTES) return { error: `Files up to ${MAX_DOC_BYTES / 1024 / 1024} MB.` };
            const id = newId("doc");
            const sha256 = await sha256Hex(bytes);
            const record = cryptoKey ? { enc: await encryptBytes(cryptoKey, bytes) } : { b64: toB64(bytes) };
            await docsBackend.put(id, record);
            const meta = { id, name: clean(name, 200) || "document", type: clip(type, 100), size: bytes.length, sha256, kind: DOC_KINDS.some(([k]) => k === kind) ? kind : "other", addedAt: nowIso() };
            c.documents.push(meta);
            logTo(c, `Document added: ${meta.name} (SHA-256 ${sha256.slice(0, 12)}…)`);
            write();
            return { document: meta };
        }
        async function readDocument(docId) {
            if (locked) return null;
            const record = await docsBackend.get(docId);
            if (!record) return null;
            const bytes = record.enc ? await decryptBytes(cryptoKey, record.enc) : fromB64(record.b64 || "");
            const meta = state.clients.flatMap(c => c.documents).find(d => d.id === docId) || {};
            return { ...meta, bytes };
        }
        async function removeDocument(clientId, docId) {
            const c = client(clientId);
            const d = c && c.documents.find(x => x.id === docId);
            if (!d) return false;
            await docsBackend.remove(docId);
            c.documents = c.documents.filter(x => x !== d);
            logTo(c, `Document deleted: ${d.name}`);
            write();
            return true;
        }

        // SOAs can't be edited once signed: a correction is a new SOA.
        async function addSoa(data) {
            const c = client(data.clientId);
            if (!c) return { error: "Pick the client first." };
            const products = (data.products || []).filter(p => SOA_PRODUCTS.some(([k]) => k === p));
            if (!products.length) return { error: "Tick at least one product type to discuss." };
            const method = SIGN_METHODS.some(([k]) => k === data.signatureMethod) ? data.signatureMethod : "";
            if (!method) return { error: "Choose how the beneficiary signed." };
            if (method === "drawn" && !/^data:image\/png;base64,/.test(data.signatureImage || "")) return { error: "The beneficiary hasn't signed in the box yet." };
            if (method === "typed" && !clean(data.typedName, 120)) return { error: "Type the beneficiary's full name as their signature." };
            const signedAt = data.signedAt || nowIso();
            const soa = {
                id: newId("soa"), clientId: c.id, beneficiary: clean(data.beneficiary || c.name, 120), products,
                appointmentDate: parseDate(data.appointmentDate) || "", appointmentTime: clean(data.appointmentTime, 10),
                appointmentMethod: SOA_METHODS.some(([k]) => k === data.appointmentMethod) ? data.appointmentMethod : "phone",
                initiatedBy: data.initiatedBy === "agent" ? "agent" : "beneficiary", walkIn: Boolean(data.walkIn), firstContact: clean(data.firstContact, 200),
                signatureMethod: method, signatureImage: method === "drawn" ? clip(data.signatureImage, 400000) : "", typedName: clean(data.typedName, 120),
                representative: clean(data.representative, 120), recordingRef: clean(data.recordingRef, 200),
                agent: { name: clean(data.agentName || state.settings.agentName, 120), npn: clean(data.npn || state.settings.npn, 20), agency: clean(state.settings.agency, 120) },
                signedAt, createdAt: nowIso(), notes: clean(data.notes, 1000)
            };
            soa.sha256 = await soaHash(soa);
            state.soas.push(soa);
            logTo(c, `Scope of Appointment signed (${products.join(", ")}), fingerprint ${soa.sha256.slice(0, 12)}…`);
            write();
            return { soa };
        }

        function addStatement({ carrier = "", month = "", fileName = "", lines = [] }) {
            if (locked) return { error: "The desk is locked." };
            const kept = lines.slice(0, MAX_STATEMENT_LINES).map(l => ({
                policy: clean(l.policy, 60), name: clean(l.name, 120), amount: round2(Number(l.amount) || 0),
                month: parseMonth(l.month) || parseMonth(month) || "", carrier: clean(l.carrier || carrier, 120), kind: clean(l.kind, 40)
            })).filter(l => l.amount !== 0 || l.policy || l.name);
            if (!kept.length) return { error: "No payment lines were found in that file." };
            const s = { id: newId("stmt"), carrier: clean(carrier, 120), month: parseMonth(month) || "", fileName: clean(fileName, 200), importedAt: nowIso(), lines: kept };
            state.statements.push(s);
            write();
            return { statement: s };
        }
        function removeStatement(id) {
            const before = state.statements.length;
            state.statements = state.statements.filter(s => s.id !== id);
            if (state.statements.length !== before) write();
        }
        function saveSettings(patch) {
            if (locked) return;
            const s = { ...state.settings, ...patch };
            s.agentName = clean(s.agentName, 120); s.npn = clean(s.npn, 20); s.agency = clean(s.agency, 120);
            s.agentAccess = Boolean(s.agentAccess);
            s.tolerance = Math.max(0, num(s.tolerance) ?? 1);
            s.alertDays = Math.min(365, Math.max(7, Math.round(num(s.alertDays) || 90)));
            s.portals = (Array.isArray(s.portals) ? s.portals : []).map(p => ({ name: clean(p.name, 80), url: clean(p.url, 300), note: clean(p.note, 200) }))
                .filter(p => p.name && /^https:\/\//i.test(p.url)).slice(0, 20);
            state.settings = s;
            write();
        }

        // ---- the passphrase ----
        async function unlock(passphrase) {
            if (!locked) return { ok: true };
            try {
                const k = await deriveKey(String(passphrase || ""), fromB64(envelope.salt));
                const plain = await decryptBytes(k, envelope);
                state = adoptState(JSON.parse(new TextDecoder().decode(plain)));
                cryptoKey = k;
                locked = false;
                notify();
                return { ok: true };
            } catch (err) {
                return { error: "That passphrase doesn't open this desk." };
            }
        }
        function lock() {
            if (!envelope) return false;
            state = emptyState();
            cryptoKey = null;
            locked = true;
            notify();
            return true;
        }
        // Sets or changes the passphrase, re-encrypting every document with the new key.
        async function setPassphrase(passphrase) {
            if (locked) return { error: "Unlock the desk first." };
            if (String(passphrase || "").length < 8) return { error: "Use at least 8 characters." };
            const salt = subtle().getRandomValues(new Uint8Array(16));
            const k = await deriveKey(passphrase, salt);
            await recryptDocs(cryptoKey, k);
            cryptoKey = k;
            envelope = { salt: toB64(salt) };
            write();
            await writing;
            return { ok: true };
        }
        async function removePassphrase() {
            if (locked) return { error: "Unlock the desk first." };
            if (!cryptoKey) return { ok: true };
            await writing;
            await recryptDocs(cryptoKey, null);
            cryptoKey = null;
            envelope = null;
            write();
            return { ok: true };
        }
        async function recryptDocs(fromKey, toKey) {
            for (const c of state.clients) for (const d of c.documents) {
                const record = await docsBackend.get(d.id);
                if (!record) continue;
                const bytes = record.enc ? await decryptBytes(fromKey, record.enc) : fromB64(record.b64 || "");
                await docsBackend.put(d.id, toKey ? { enc: await encryptBytes(toKey, bytes) } : { b64: toB64(bytes) });
            }
        }

        // A backup is the book plus every document, in one JSON file. With a passphrase set it
        // is encrypted with it, so it opens only with that passphrase.
        async function exportBackup() {
            if (locked) throw new Error("Unlock the desk first.");
            const docs = {};
            for (const c of state.clients) for (const d of c.documents) {
                const record = await docsBackend.get(d.id);
                if (record) docs[d.id] = record.enc ? toB64(await decryptBytes(cryptoKey, record.enc)) : record.b64;
            }
            const payload = JSON.stringify({ state, docs });
            if (!cryptoKey) return JSON.stringify({ codevInsuranceBackup: 1, exportedAt: nowIso(), data: JSON.parse(payload) });
            const box = await encryptBytes(cryptoKey, new TextEncoder().encode(payload));
            return JSON.stringify({ codevInsuranceBackup: 1, exportedAt: nowIso(), enc: { salt: envelope.salt, ...box } });
        }
        // Replaces this device's desk with the backup's. An encrypted backup needs its passphrase,
        // and the desk then keeps that passphrase.
        async function importBackup(text, passphrase = "") {
            let file;
            try { file = JSON.parse(text); } catch (err) { return { error: "That isn't a CoDev insurance backup." }; }
            if (!file || !file.codevInsuranceBackup) return { error: "That isn't a CoDev insurance backup." };
            let payload, k = null, salt = null;
            if (file.enc) {
                try {
                    salt = file.enc.salt;
                    k = await deriveKey(String(passphrase || ""), fromB64(salt));
                    payload = JSON.parse(new TextDecoder().decode(await decryptBytes(k, file.enc)));
                } catch (err) { return { error: "That passphrase doesn't open the backup.", needsPassphrase: true }; }
            } else payload = file.data;
            if (!payload || !payload.state) return { error: "The backup is empty." };
            for (const c of state.clients) for (const d of c.documents) await docsBackend.remove(d.id);
            const next = adoptState(payload.state);
            for (const [id, b64] of Object.entries(payload.docs || {})) {
                await docsBackend.put(id, k ? { enc: await encryptBytes(k, fromB64(b64)) } : { b64 });
            }
            state = next;
            cryptoKey = k;
            envelope = k ? { salt } : null;
            locked = false;
            write();
            await writing;
            return { ok: true, clients: state.clients.length };
        }

        return {
            clients, client, search, saveClient, removeClient, savePolicy, removePolicy, addNote, addQuote,
            addDocument, readDocument, removeDocument, addSoa,
            soas: (clientId) => locked ? [] : state.soas.filter(s => !clientId || s.clientId === clientId),
            statements: () => locked ? [] : state.statements, addStatement, removeStatement,
            settings: () => state.settings, saveSettings,
            isLocked: () => locked, isEncrypted: () => Boolean(envelope), unlock, lock, setPassphrase, removePassphrase,
            exportBackup, importBackup,
            flush: () => writing, lastError: () => lastError,
            onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
        };
    }

    function memoryDocs() {
        const map = new Map();
        return { put: async (id, v) => { map.set(id, v); }, get: async id => map.get(id) || null, remove: async id => { map.delete(id); }, keys: async () => [...map.keys()], map };
    }
    // The page's document backend: IndexedDB, which holds far more than localStorage.
    function indexedDbDocs(name = DOCS_DB) {
        let dbp = null;
        function db() {
            if (!dbp) dbp = new Promise((resolve, reject) => {
                const req = indexedDB.open(name, 1);
                req.onupgradeneeded = () => req.result.createObjectStore("docs");
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            return dbp;
        }
        async function run(mode, fn) {
            const d = await db();
            return new Promise((resolve, reject) => {
                const tx = d.transaction("docs", mode);
                const req = fn(tx.objectStore("docs"));
                tx.oncomplete = () => resolve(req && req.result);
                tx.onerror = () => reject(tx.error);
            });
        }
        return {
            put: (id, v) => run("readwrite", s => s.put(v, id)),
            get: async id => (await run("readonly", s => s.get(id))) || null,
            remove: id => run("readwrite", s => s.delete(id)),
            keys: () => run("readonly", s => s.getAllKeys())
        };
    }

    // ---------- SOA rules ----------

    function soaCanonical(soa) {
        const { sha256, ...rest } = soa;
        return JSON.stringify(rest, Object.keys(rest).sort());
    }
    function soaHash(soa) { return sha256Hex(soaCanonical(soa)); }
    async function verifySoa(soa) { return Boolean(soa.sha256) && (await soaHash(soa)) === soa.sha256; }

    // The last 4 days of AEP, MA OEP and the client's IEP are exempt from the 48-hour wait.
    function inLastFourDays(date, client) {
        const { m, d } = parts(date);
        if (m === 12 && d >= 4 && d <= 7) return "the last 4 days of AEP";
        if (m === 3 && d >= 28) return "the last 4 days of the Medicare Advantage OEP";
        const iep = client && client.dob ? iepWindow(client.dob) : null;
        if (iep && date <= iep.end && daysBetween(date, iep.end) < 4) return "the last 4 days of the Initial Enrollment Period";
        return "";
    }
    // [{ level: "ok"|"warn"|"bad", text }] for one SOA.
    function soaChecks(soa, client = null, today = todayStr()) {
        const out = [];
        const signed = parseDate(String(soa.signedAt).slice(0, 10));
        if (soa.appointmentDate && signed) {
            const apptMs = Date.parse(`${soa.appointmentDate}T${soa.appointmentTime || "00:00"}:00`);
            const hours = (apptMs - Date.parse(soa.signedAt)) / 3600000;
            const exempt = soa.walkIn && soa.initiatedBy === "beneficiary" ? "a walk-in the beneficiary started" : inLastFourDays(soa.appointmentDate, client);
            if (hours < 0) out.push({ level: "warn", text: "Signed after the appointment time. CMS expects the SOA before the meeting." });
            else if (hours < 48 && !exempt) out.push({ level: "bad", text: `Signed ${Math.max(0, Math.round(hours))} hours before the appointment. CMS asks for 48 hours unless an exception applies.` });
            else if (hours < 48) out.push({ level: "ok", text: `Under 48 hours, allowed for ${exempt}.` });
            else out.push({ level: "ok", text: "Signed at least 48 hours before the appointment." });
        }
        if (signed) {
            const expires = addMonths(signed, 12);
            if (today > expires) out.push({ level: "warn", text: `Expired ${niceDate(expires)}. Get a new SOA before the next appointment.` });
            else out.push({ level: "ok", text: `Good until ${niceDate(expires)}.` });
        }
        if (soa.signatureMethod === "recorded" && !soa.recordingRef) out.push({ level: "warn", text: "Verbal consent: add the call recording's reference or attach the recording." });
        return out;
    }

    // ---------- alerts ----------

    function iepWindow(dob) {
        const b = parts(dob);
        const birthday65 = ymd(b.y + 65, b.m, Math.min(b.d, daysInMonth(b.y + 65, b.m)));
        const birthMonth = monthStart(birthday65);
        const start = addMonths(birthMonth, -3);
        const end = monthEnd(addMonths(birthMonth, 3));
        const medicareStart = b.d === 1 ? addMonths(birthMonth, -1) : birthMonth;
        return { birthday65, start, end, medicareStart };
    }
    function hasActive(c, types) { return c.policies.some(p => (p.status === "active" || p.status === "pending") && types.has(p.planType)); }
    function hasMedicare(c) { return c.policies.some(p => (p.status === "active" || p.status === "pending") && PLAN_GROUP[p.planType] === "medicare"); }

    // Every alert due by today + horizon days, oldest first. An alert has the window it's about
    // (start..end) and when to start working it (from).
    function computeAlerts(clientList, today = todayStr(), { horizon = 90, soas = [] } = {}) {
        today = parseDate(today) || todayStr();
        const until = addDays(today, horizon);
        const out = [];
        const add = (c, type, from, start, end, title, detail, policy) => {
            if (end && end < today) return;
            if (from > until) return;
            out.push({ id: `${type}:${c.id}:${policy ? policy.id : ""}:${start}`, type, clientId: c.id, clientName: c.name, policyId: policy ? policy.id : "",
                from, start, end: end || start, title, detail,
                urgency: start <= today ? "now" : daysBetween(today, start) <= 14 ? "soon" : daysBetween(today, start) <= 45 ? "upcoming" : "later" });
        };
        const { y } = parts(today);
        for (const c of clientList) {
            if (c.status === "inactive") continue;
            const people = [{ name: c.name, dob: c.dob }, ...c.members.map(m => ({ name: m.name, dob: m.dob }))].filter(p => p.dob);
            for (const person of people) {
                const age = ageOn(person.dob, today);
                if (age >= 63 && age <= 65) {
                    const w = iepWindow(person.dob);
                    if (!(person.name === c.name && hasMedicare(c))) {
                        add(c, "turning65", addDays(w.start, -90), w.start, w.end, `${person.name} turns 65 on ${niceDate(w.birthday65)}`,
                            `Initial Enrollment Period ${niceDate(w.start)} to ${niceDate(w.end)}. Medicare can start ${niceDate(w.medicareStart)} if they enroll before then.`);
                    }
                }
            }
            if (c.partBDate && c.dob && ageOn(c.dob, c.partBDate) >= 65) {
                const start = monthStart(c.partBDate), end = monthEnd(addMonths(start, 5));
                add(c, "medigap", addDays(start, -30), start, end, `Medigap open enrollment for ${c.name}`,
                    `Guaranteed issue for Medicare Supplement until ${niceDate(end)}: plans must accept them without health questions.`);
            }
            // The yearly windows: this year's, or next year's once this one is over.
            for (const year of [y - 1, y, y + 1]) {
                if (hasActive(c, AEP_TYPES)) add(c, "aep", ymd(year, 9, 1), ymd(year, 10, 15), ymd(year, 12, 7), `AEP review for ${c.name}`,
                    "Check next year's premium, drugs and doctors before December 7; changes start January 1. Marketing for next year may start October 1.");
                if (hasActive(c, MA_TYPES)) add(c, "maOep", ymd(year - 1, 12, 8), ymd(year, 1, 1), ymd(year, 3, 31), `MA open enrollment for ${c.name}`,
                    "One switch to another Medicare Advantage plan, or back to Original Medicare, by March 31.");
                if (hasActive(c, new Set(["aca"]))) add(c, "acaOep", ymd(year, 10, 1), ymd(year, 11, 1), ymd(year + 1, 1, 15), `ACA open enrollment for ${c.name}`,
                    "Update income and household, and re-shop by December 15 for a January 1 start. State exchanges can have other dates.");
            }
            for (const p of c.policies) {
                const label = `${PLAN_LABEL[p.planType]}${p.carrier ? ` (${p.carrier})` : ""}`;
                if (p.status === "pending" && p.effectiveDate) {
                    if (p.effectiveDate < today) add(c, "pending", p.effectiveDate, today, today, `${c.name}'s ${label} is still pending`,
                        `It was due to start ${niceDate(p.effectiveDate)}. Check with the carrier and mark it active once it's in force.`, p);
                    else add(c, "effective", addDays(p.effectiveDate, -30), p.effectiveDate, p.effectiveDate, `${c.name}'s ${label} starts ${niceDate(p.effectiveDate)}`,
                        "Confirm the first premium is paid and the ID cards arrived.", p);
                }
                if (p.status !== "active") continue;
                if (p.termDate) add(c, "term", addDays(p.termDate, -60), p.termDate, p.termDate, `${c.name}'s ${label} ends ${niceDate(p.termDate)}`,
                    "Line up replacement coverage before it ends.", p);
                if (p.conversionDeadline) add(c, "conversion", addDays(p.conversionDeadline, -90), p.conversionDeadline, p.conversionDeadline,
                    `Conversion deadline for ${c.name}'s ${label}`, `The term policy can be converted without new underwriting until ${niceDate(p.conversionDeadline)}.`, p);
                // ACA and Medicare plans renew with their enrollment periods; others on their anniversary.
                const renewOn = p.renewalDate ? nextAnniversary(p.renewalDate, today)
                    : (p.effectiveDate && !["aca", "ma", "mapd", "pdp"].includes(p.planType) ? nextAnniversary(p.effectiveDate, addDays(today, 1)) : null);
                if (renewOn && renewOn !== p.effectiveDate) add(c, "renewal", addDays(renewOn, -60), renewOn, renewOn, `${c.name}'s ${label} renews ${niceDate(renewOn)}`,
                    PLAN_GROUP[p.planType] === "life" ? "Annual review: beneficiaries, coverage amount, premium." : "Review the renewal rate and re-shop if it jumped.", p);
            }
            if (c.followUp) add(c, "followUp", c.followUp, c.followUp, c.followUp, `Follow up with ${c.name}`, c.followUpNote || "Follow-up you set.");
        }
        const byClient = Object.fromEntries(clientList.map(c => [c.id, c]));
        const latest = {};
        for (const s of soas) if (!latest[s.clientId] || s.signedAt > latest[s.clientId].signedAt) latest[s.clientId] = s;
        for (const s of Object.values(latest)) {
            const c = byClient[s.clientId];
            const signed = parseDate(String(s.signedAt).slice(0, 10));
            if (!c || !signed || c.status === "inactive") continue;
            const expires = addMonths(signed, 12);
            add(c, "soa", addDays(expires, -30), expires, expires, `${c.name}'s Scope of Appointment expires ${niceDate(expires)}`,
                "Get a new SOA before the next Medicare appointment.");
        }
        return out.filter(a => a.from <= until).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.clientName.localeCompare(b.clientName)));
    }

    // Alerts as an iCalendar file, to add to Google or Outlook calendars.
    function alertsToIcs(alerts) {
        const esc = s => String(s || "").replace(/[\\;,]/g, m => `\\${m}`).replace(/\n/g, "\\n");
        const stamp = nowIso().replace(/[-:]/g, "").replace(/\.\d+/, "");
        const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CoDev//Insurance Desk//EN", "CALSCALE:GREGORIAN"];
        for (const a of alerts) {
            lines.push("BEGIN:VEVENT", `UID:${a.id.replace(/[^\w:.-]/g, "")}@codev-insurance`, `DTSTAMP:${stamp}`,
                `DTSTART;VALUE=DATE:${a.start.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${addDays(a.start, 1).replace(/-/g, "")}`,
                `SUMMARY:${esc(a.title)}`, `DESCRIPTION:${esc(a.detail)}`, "END:VEVENT");
        }
        lines.push("END:VCALENDAR");
        return lines.join("\r\n") + "\r\n";
    }

    // ---------- commission statements ----------

    function parseCsv(text) {
        const rows = [];
        let row = [], field = "", quoted = false;
        text = String(text || "").replace(/^﻿/, "");
        const delim = (text.split("\n", 1)[0].match(/\t/g) || []).length > (text.split("\n", 1)[0].match(/,/g) || []).length ? "\t" : ",";
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
            } else if (ch === '"') quoted = true;
            else if (ch === delim) { row.push(field); field = ""; }
            else if (ch === "\n" || ch === "\r") {
                if (ch === "\r" && text[i + 1] === "\n") i++;
                row.push(field); field = "";
                if (row.some(f => f.trim())) rows.push(row.map(f => f.trim()));
                row = [];
            } else field += ch;
        }
        row.push(field);
        if (row.some(f => f.trim())) rows.push(row.map(f => f.trim()));
        return rows;
    }
    // Which header can hold which field, and which of those to prefer.
    const COLUMN_HINTS = {
        policy: { test: h => /(policy|member|subscriber|contract|certificate|cert|application|app)\s*(#|no\.?|num(ber)?|id)\b|^policy$|\bmbi\b|\bhicn\b/i.test(h), prefer: /policy|member\s*id|subscriber\s*id/i },
        name: { test: h => /name|^insured$|^member$|^client$|^subscriber$/i.test(h) && !/plan|carrier|agent|product|company|agency|writing|upline|file/i.test(h), prefer: /insured|member|client|subscriber|customer|holder|^name$/i },
        amount: { test: h => /commission|\bcomm\b|paid|payment|net|amount|\bamt\b|total/i.test(h) && !/rate|%|percent|date|period|month|premium/i.test(h), prefer: /commission|amount|net/i },
        month: { test: h => /period|month|date|cycle/i.test(h) && !/effective|birth|dob|term|issue|submit/i.test(h), prefer: /period|month|pa(id|y)/i },
        carrier: { test: h => /carrier|company|issuer|insurer/i.test(h), prefer: null },
        kind: { test: h => /type|description|transaction|reason|desc/i.test(h) && !/plan|product/i.test(h), prefer: null }
    };
    // Picks the likeliest column for each field from the header row; the user can change it.
    function detectColumns(headers) {
        const used = new Set();
        const pick = field => {
            const { test, prefer } = COLUMN_HINTS[field];
            const order = headers.map((h, i) => [String(h || ""), i]).filter(([h, i]) => !used.has(i) && test(h));
            const best = (prefer ? order.find(([h]) => prefer.test(h)) : null) || order[0];
            if (!best) return -1;
            used.add(best[1]);
            return best[1];
        };
        const policy = pick("policy");
        const amount = pick("amount");
        const name = pick("name");
        const month = pick("month");
        const carrier = pick("carrier");
        const kind = pick("kind");
        return { policy, name, amount, month, carrier, kind };
    }
    // Rows (with the header first) to statement lines: { policy, name, amount, month, carrier, kind }.
    function statementLines(rows, map, { month = "", carrier = "" } = {}) {
        const out = [];
        const at = (r, i) => (i >= 0 && i < r.length ? r[i] : "");
        for (const r of rows.slice(1)) {
            const amount = num(at(r, map.amount));
            if (amount == null) continue;
            const kind = at(r, map.kind);
            const signed = /charge\s*back|chargeback|reversal|recapture|clawback/i.test(kind) && amount > 0 ? -amount : amount;
            out.push({ policy: at(r, map.policy), name: at(r, map.name), amount: signed, month: parseMonth(at(r, map.month)) || parseMonth(month) || "",
                carrier: at(r, map.carrier) || carrier, kind });
        }
        return out;
    }
    // What a policy should pay in a month, or null when its commission isn't set.
    function expectedForMonth(policy, month) {
        const c = policy.commission || {};
        if (!c.type || c.amount == null) return null;
        if (policy.status !== "active" && policy.status !== "terminated") return null;
        if (!policy.effectiveDate || policy.effectiveDate.slice(0, 7) > month) return null;
        if (policy.termDate && policy.termDate.slice(0, 7) < month) return null;
        const firstYear = monthsBetween(policy.effectiveDate.slice(0, 7), month).length <= 12;
        const amount = !firstYear && c.renewalAmount != null ? c.renewalAmount : c.amount;
        switch (c.type) {
            case "pmpm": return round2(amount * (policy.membersCovered || 1));
            case "monthly": return round2(amount);
            case "percent": return policy.premium == null ? null : round2(policy.premium * amount / 100);
            case "annual_monthly": return round2(amount / 12);
            case "annual_lump": return month.slice(5) === policy.effectiveDate.slice(5, 7) ? round2(amount) : 0;
            default: return null;
        }
    }
    function nameKey(name) {
        // "SMITH, JOHN A" and "John Smith" both become "john smith".
        let s = String(name || "").toLowerCase().trim();
        if (s.includes(",")) { const [last, first] = s.split(",", 2); s = `${first.trim().split(/\s+/)[0] || ""} ${last.trim()}`; }
        const w = s.replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter(Boolean);
        return w.length >= 2 ? `${w[0]} ${w[w.length - 1]}` : w.join(" ");
    }
    // Matches every statement line to a policy (by policy or member number, then by name and
    // carrier) and compares what was paid with what each policy should pay, month by month.
    function reconcile(clientList, statements, { from, to, tolerance = 1 } = {}) {
        const lines = statements.flatMap(s => s.lines.map(l => ({ ...l, statementId: s.id, carrier: l.carrier || s.carrier })));
        const months = lines.map(l => l.month).filter(Boolean).sort();
        from = parseMonth(from) || months[0] || todayStr().slice(0, 7);
        to = parseMonth(to) || months[months.length - 1] || from;
        const policies = clientList.flatMap(c => c.policies.map(p => ({ c, p })));
        const byNumber = new Map();
        for (const item of policies) for (const n of [item.p.policyNumber, item.p.memberId]) if (norm(n)) byNumber.set(norm(n), item);
        const byName = new Map();
        for (const item of policies) for (const nm of [item.c.name, ...item.c.members.map(m => m.name)]) {
            const k = nameKey(nm);
            if (k) byName.set(k, [...(byName.get(k) || []), item]);
        }
        const paid = new Map();       // policyId|month -> { amount, lines }
        const unmatched = [], chargebacks = [];
        for (const l of lines) {
            if (!l.month || l.month < from || l.month > to) continue;
            let item = norm(l.policy) ? byNumber.get(norm(l.policy)) : null, by = "number";
            if (!item) {
                const named = byName.get(nameKey(l.name)) || [];
                const sameCarrier = named.filter(x => !l.carrier || !x.p.carrier || norm(x.p.carrier).includes(norm(l.carrier)) || norm(l.carrier).includes(norm(x.p.carrier)));
                item = sameCarrier.length === 1 ? sameCarrier[0] : null;
                by = "name";
            }
            if (!item) { unmatched.push(l); continue; }
            if (l.amount < 0) chargebacks.push({ ...l, clientId: item.c.id, clientName: item.c.name, policyId: item.p.id, matchedBy: by });
            const k = `${item.p.id}|${l.month}`;
            const entry = paid.get(k) || { amount: 0, lines: [], matchedBy: by };
            entry.amount = round2(entry.amount + l.amount);
            entry.lines.push(l);
            if (by === "name") entry.matchedBy = "name";
            paid.set(k, entry);
        }
        const rows = [];
        for (const { c, p } of policies) for (const month of monthsBetween(from, to)) {
            const expected = expectedForMonth(p, month);
            const got = paid.get(`${p.id}|${month}`);
            const amount = got ? got.amount : 0;
            if (expected == null && !got) continue;
            if (expected === 0 && !got) continue;
            let status;
            if (expected == null) status = "no_rate";
            else if (got && got.lines.some(l => l.amount < 0) && amount < expected - tolerance) status = "chargeback";
            else if (!got || amount === 0) status = expected > 0 ? "missing" : "paid";
            else if (amount < expected - tolerance) status = "short";
            else if (amount > expected + tolerance) status = "over";
            else status = "paid";
            rows.push({ status, month, clientId: c.id, clientName: c.name, policyId: p.id, carrier: p.carrier, plan: PLAN_LABEL[p.planType],
                policyNumber: p.policyNumber || p.memberId, expected, paid: amount, difference: expected == null ? null : round2(amount - expected), matchedBy: got ? got.matchedBy : "" });
        }
        const sum = (list, f) => round2(list.reduce((t, r) => t + (Number(r[f]) || 0), 0));
        const owed = rows.filter(r => r.status === "missing" || r.status === "short" || r.status === "chargeback");
        return {
            from, to, rows, unmatched, chargebacks,
            totals: { expected: sum(rows, "expected"), paid: round2(sum(rows, "paid") + sum(unmatched, "amount")), shortfall: round2(-owed.reduce((t, r) => t + Math.min(0, r.difference || 0), 0)),
                missing: rows.filter(r => r.status === "missing").length, short: rows.filter(r => r.status === "short").length, chargebacks: chargebacks.length, unmatched: unmatched.length }
        };
    }
    function reconcileCsv(result) {
        const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
        const head = ["Status", "Month", "Client", "Carrier", "Plan", "Policy #", "Expected", "Paid", "Difference", "Matched by"];
        const lines = result.rows.filter(r => r.status !== "paid").map(r => [r.status, r.month, r.clientName, r.carrier, r.plan, r.policyNumber, r.expected, r.paid, r.difference, r.matchedBy].map(q).join(","));
        for (const u of result.unmatched) lines.push(["unmatched", u.month, u.name, u.carrier, "", u.policy, "", u.amount, "", ""].map(q).join(","));
        return [head.map(q).join(","), ...lines].join("\n");
    }

    // ---------- quoting ----------

    // Everything a quoting site asks for, from the client's file.
    function quoteBrief(c, today = todayStr()) {
        const lines = [`Client: ${c.name}`];
        const people = [{ name: c.name, relation: "primary", dob: c.dob, tobacco: c.tobacco }, ...c.members];
        lines.push("Household:");
        for (const p of people) lines.push(`- ${p.name} (${p.relation}${p.dob ? `, born ${p.dob}, age ${ageOn(p.dob, today)}` : ", birth date missing"}${p.tobacco ? ", tobacco user" : ""})`);
        lines.push(`Location: ${[c.zip && `ZIP ${c.zip}`, c.county && `${c.county} County`, c.state].filter(Boolean).join(", ") || "missing (ZIP and county are needed to quote)"}`);
        if (c.householdIncome != null) lines.push(`Expected household income: $${c.householdIncome.toLocaleString("en-US")} for ${c.householdSize || people.length} people (for ACA subsidies)`);
        if (c.partADate || c.partBDate) lines.push(`Medicare: Part A ${c.partADate || "?"}, Part B ${c.partBDate || "?"}`);
        if (c.doctors.length) { lines.push("Doctors to keep in network:"); c.doctors.forEach(d => lines.push(`- ${d.name}${d.specialty ? `, ${d.specialty}` : ""}${d.location ? `, ${d.location}` : ""}${d.npi ? ` (NPI ${d.npi})` : ""}`)); }
        if (c.medications.length) { lines.push("Prescriptions:"); c.medications.forEach(m => lines.push(`- ${m.name}${m.dose ? ` ${m.dose}` : ""}${m.frequency ? `, ${m.frequency}` : ""}`)); }
        if (c.pharmacy) lines.push(`Pharmacy: ${c.pharmacy}`);
        const current = c.policies.filter(p => p.status === "active");
        if (current.length) { lines.push("Current coverage:"); current.forEach(p => lines.push(`- ${PLAN_LABEL[p.planType]}: ${[p.carrier, p.planName].filter(Boolean).join(" ")}${p.premium != null ? `, ${money(p.premium)}/mo` : ""}`)); }
        const missing = [];
        if (!c.zip) missing.push("ZIP code");
        if (!c.dob) missing.push("birth date");
        if (missing.length) lines.push(`Missing before quoting: ${missing.join(", ")}.`);
        return lines.join("\n");
    }
    function quotePrompt(c, portal, today = todayStr()) {
        return `[Insurance Desk] Quote ${c.name} on ${portal.name} (${portal.url}).\n\n${quoteBrief(c, today)}\n\n`
            + "Use the browser tools: open the site, and if it needs a sign-in, ask me to sign in through the live view (don't type a password I haven't saved for you). "
            + "Enter the household, add the doctors and prescriptions, and compare the best 3 to 5 plans side by side: monthly premium, deductible, out-of-pocket max, estimated yearly drug cost, whether each doctor is in network, and star rating where shown. "
            + "Don't start or submit an application, and don't e-sign anything. Save the comparison to the client's file with insurance_save_quote, then show it to me.";
    }

    // ---------- agents ----------

    // Words that make a request about the insurance book. Not "policy" or "carrier" alone:
    // those turn up in code ("privacy policy", "carrier pigeon") too often.
    const DESK_TASK = /\b(insurance|insured|medicare|medicaid|medigap|med\s*supp|aca|obamacare|healthsherpa|sunfire|quotit|plan\s*finder|aep|annual enrollment|open enrollment|turning\s*65|soa|scope of appointment|premiums?|deductibles?|policyholders?|commission statements?|chargebacks?|my (clients?|book)|book of business|final expense|term life|whole life|annuit(y|ies)|ichra|humana|aetna|unitedhealth(care)?|uhc|bcbs|blue cross|cigna|ambetter|wellcare|anthem|mutual of omaha|insurance desk)\b/i;

    function isDeskTask(store, task) {
        if (store.isLocked() || !store.settings().agentAccess) return false;
        const t = String(task || "");
        if (/^\[Insurance Desk\]/.test(t) || DESK_TASK.test(t)) return true;
        return store.clients().some(c => c.name.length > 3 && t.toLowerCase().includes(c.name.toLowerCase()));
    }
    function deskPromptBlock(store, task, today = todayStr()) {
        if (!isDeskTask(store, task)) return "";
        const s = store.settings();
        const alerts = computeAlerts(store.clients(), today, { horizon: 30, soas: store.soas() }).filter(a => a.urgency === "now" || a.urgency === "soon");
        return [`[Insurance Desk] The user is a licensed health and life insurance agent${s.agentName ? ` (${s.agentName}${s.agency ? `, ${s.agency}` : ""})` : ""} with ${store.clients().length} clients in CoDev's 🩺 Insurance tab.`,
            "Use insurance_clients to look clients up, insurance_alerts for what's due, insurance_save_client and insurance_add_note to update the book, insurance_quote_brief before quoting, insurance_save_quote after, and insurance_commissions for statement checks.",
            "Client records are private health information: use them only for this task, never put names, birth dates, drugs or doctors into web searches or other sites except the quoting site the user named, and don't repeat more of it than the answer needs.",
            "Never submit an application, sign or e-sign anything, or pay, and never invent plan prices: read them from the site. Compliance dates are reminders, not legal advice.",
            alerts.length ? `Due now: ${alerts.slice(0, 6).map(a => a.title).join("; ")}${alerts.length > 6 ? `; and ${alerts.length - 6} more` : ""}.` : ""].filter(Boolean).join("\n");
    }

    function describeClient(c, store, today = todayStr()) {
        const lines = [`${c.name} — ${CLIENT_STATUS.find(([k]) => k === c.status)[1]}${c.dob ? `, born ${c.dob} (age ${ageOn(c.dob, today)})` : ""}`];
        const contact = [c.phone, c.email, [c.address, c.city, c.state, c.zip].filter(Boolean).join(", "), c.county && `${c.county} County`].filter(Boolean);
        if (contact.length) lines.push(`Contact: ${contact.join(" · ")}`);
        if (c.members.length) lines.push(`Household: ${c.members.map(m => `${m.name} (${m.relation}${m.dob ? `, ${m.dob}` : ""})`).join("; ")}`);
        for (const p of c.policies) lines.push(`Policy: ${PLAN_LABEL[p.planType]} · ${[p.carrier, p.planName].filter(Boolean).join(" ") || "carrier not set"} · ${p.status}${p.policyNumber ? ` · #${p.policyNumber}` : ""}${p.effectiveDate ? ` · effective ${p.effectiveDate}` : ""}${p.premium != null ? ` · ${money(p.premium)}/mo` : ""}${p.faceAmount != null ? ` · face ${money(p.faceAmount)}` : ""}`);
        if (c.doctors.length) lines.push(`Doctors: ${c.doctors.map(d => d.name + (d.specialty ? ` (${d.specialty})` : "")).join("; ")}`);
        if (c.medications.length) lines.push(`Prescriptions: ${c.medications.map(m => [m.name, m.dose, m.frequency].filter(Boolean).join(" ")).join("; ")}`);
        if (c.followUp) lines.push(`Follow-up: ${c.followUp}${c.followUpNote ? ` — ${c.followUpNote}` : ""}`);
        const soa = store ? store.soas(c.id).slice(-1)[0] : null;
        if (soa) lines.push(`Latest SOA: signed ${soa.signedAt.slice(0, 10)} for ${soa.products.join(", ")}`);
        if (c.notes.length) lines.push(`Recent notes:\n${c.notes.slice(-3).map(n => `- ${n.at.slice(0, 10)}: ${n.text.slice(0, 300)}`).join("\n")}`);
        if (c.quotes.length) { const q = c.quotes[c.quotes.length - 1]; lines.push(`Last quote: ${q.at.slice(0, 10)} on ${q.portal || "a site"}, ${q.plans.length} plans`); }
        return lines.join("\n");
    }

    function buildDeskTools(store, deps = {}) {
        if (store.isLocked() || !store.settings().agentAccess) return [];
        return deskTools(store, deps).map(tool => ({ ...tool, run: async (args, ctx) => {
            // Checked again on every call: the user may have locked the desk or turned access off mid-task.
            if (store.isLocked()) return "The Insurance Desk is locked. Ask the user to unlock it in the 🩺 Insurance tab.";
            if (!store.settings().agentAccess) return "The user turned off agent access to client files.";
            const reply = await tool.run(args || {}, ctx);
            if (/^(Added|Updated|Saved|Note added)/.test(reply) && deps.onSaved) deps.onSaved();
            return reply;
        } }));
    }
    function deskTools(store, deps) {
        const by = deps.agentName || "an agent";
        const find = name => store.client(name);
        const noClient = name => `No client named "${name}". ${store.clients().length ? `Try insurance_clients with a query.` : "The book is empty; the user adds clients in the 🩺 Insurance tab, or you can add one with insurance_save_client."}`;
        const planEnum = PLAN_TYPES.map(([k]) => k);
        return [
            {
                name: "insurance_clients",
                description: "Look up the user's insurance clients in CoDev's Insurance Desk. With name, returns that client's full file (household, policies, doctors, prescriptions, latest SOA, notes). With query, finds clients by name, carrier, plan, ZIP, tag or status. With neither, lists everyone.",
                inputSchema: { type: "object", properties: { name: { type: "string" }, query: { type: "string" } } },
                run: async args => {
                    if (args.name) { const c = find(args.name); return c ? describeClient(c, store) : noClient(args.name); }
                    const list = store.search(args.query || "");
                    if (!list.length) return args.query ? `No clients match "${args.query}".` : "No clients yet.";
                    return `${list.length} client${list.length === 1 ? "" : "s"}:\n` + list.slice(0, 60).map(c => `- ${c.name} (${c.status}${c.policies.length ? `; ${c.policies.map(p => `${PLAN_LABEL[p.planType]}${p.carrier ? ` ${p.carrier}` : ""} ${p.status}`).join(", ")}` : ""})`).join("\n")
                        + (list.length > 60 ? `\n…and ${list.length - 60} more; narrow it with a query.` : "");
                }
            },
            {
                name: "insurance_alerts",
                description: "What's due in the user's book: clients turning 65 (Initial Enrollment Period), Medigap open enrollment, AEP and OEP reviews, renewals, pending policies, term-life conversion deadlines, expiring Scopes of Appointment and follow-ups.",
                inputSchema: { type: "object", properties: { days: { type: "integer", description: "Look this many days ahead. Default 30." } } },
                run: async args => {
                    const alerts = computeAlerts(store.clients(), todayStr(), { horizon: Math.min(365, Math.max(1, args.days || 30)), soas: store.soas() });
                    return alerts.length ? alerts.slice(0, 80).map(a => `- [${a.urgency}] ${a.title} (${a.start === a.end ? niceDate(a.start) : `${niceDate(a.start)} to ${niceDate(a.end)}`})`).join("\n") : "Nothing due in that window.";
                }
            },
            {
                name: "insurance_save_client",
                description: "Add a client or update one in the Insurance Desk; only the fields you pass change. You can also add or update one policy at a time. You can't delete clients or policies. Every change is written to the client's activity log.",
                inputSchema: { type: "object", properties: {
                    name: { type: "string", description: "The client's full name (finds an existing client by it)." },
                    phone: { type: "string" }, email: { type: "string" }, dob: { type: "string", description: "YYYY-MM-DD" },
                    address: { type: "string" }, city: { type: "string" }, state: { type: "string", description: "Two letters" }, zip: { type: "string" }, county: { type: "string" },
                    status: { type: "string", enum: CLIENT_STATUS.map(([k]) => k) }, tags: { type: "array", items: { type: "string" } },
                    householdIncome: { type: "number" }, householdSize: { type: "integer" }, tobacco: { type: "boolean" },
                    partADate: { type: "string" }, partBDate: { type: "string" }, pharmacy: { type: "string" },
                    followUp: { type: "string", description: "YYYY-MM-DD" }, followUpNote: { type: "string" },
                    members: { type: "array", description: "Replaces the household members.", items: { type: "object", properties: { name: { type: "string" }, relation: { type: "string", enum: RELATIONS.map(([k]) => k) }, dob: { type: "string" }, tobacco: { type: "boolean" } }, required: ["name"] } },
                    doctors: { type: "array", description: "Replaces the doctor list.", items: { type: "object", properties: { name: { type: "string" }, specialty: { type: "string" }, location: { type: "string" }, npi: { type: "string" } }, required: ["name"] } },
                    medications: { type: "array", description: "Replaces the prescription list.", items: { type: "object", properties: { name: { type: "string" }, dose: { type: "string" }, frequency: { type: "string" } }, required: ["name"] } },
                    policy: { type: "object", description: "One policy to add, or to update when policyNumber matches one on file.", properties: {
                        planType: { type: "string", enum: planEnum }, carrier: { type: "string" }, planName: { type: "string" }, policyNumber: { type: "string" }, memberId: { type: "string" },
                        status: { type: "string", enum: POLICY_STATUS.map(([k]) => k) }, effectiveDate: { type: "string" }, renewalDate: { type: "string" }, termDate: { type: "string" },
                        premium: { type: "number" }, membersCovered: { type: "integer" }, faceAmount: { type: "number" }, beneficiary: { type: "string" }, notes: { type: "string" } } }
                }, required: ["name"] },
                run: async args => {
                    const { policy, ...fields } = args;
                    const existing = find(args.name);
                    const saved = store.saveClient({ ...fields, id: existing ? existing.id : undefined, _by: by });
                    if (!saved.client) return `Not saved: ${saved.error}`;
                    let extra = "";
                    if (policy && typeof policy === "object") {
                        const match = policy.policyNumber ? saved.client.policies.find(p => norm(p.policyNumber) === norm(policy.policyNumber)) : null;
                        const { commission, ...safe } = policy; // commission rates are the user's to set
                        void commission;
                        const p = store.savePolicy(saved.client.id, { ...safe, id: match ? match.id : undefined, _by: by });
                        extra = p.policy ? ` ${p.created ? "Added" : "Updated"} its ${PLAN_LABEL[p.policy.planType]} policy.` : ` The policy wasn't saved: ${p.error}`;
                    }
                    return `${saved.created ? "Added" : "Updated"} ${saved.client.name}.${extra} The user sees it in the 🩺 Insurance tab.`;
                }
            },
            {
                name: "insurance_add_note",
                description: "Add a note or a call summary to a client's file in the Insurance Desk.",
                inputSchema: { type: "object", properties: { client: { type: "string" }, text: { type: "string" }, kind: { type: "string", enum: ["note", "call"] } }, required: ["client", "text"] },
                run: async args => {
                    const c = find(args.client);
                    if (!c) return noClient(args.client);
                    const r = store.addNote(c.id, args.text, { kind: args.kind, by });
                    return r.note ? `Note added to ${c.name}'s file.` : `Not saved: ${r.error}`;
                }
            },
            {
                name: "insurance_quote_brief",
                description: "Everything a quoting site needs for one client: household ages, ZIP and county, income, doctors, prescriptions, pharmacy and current coverage, plus the quoting sites the user uses. Read it before quoting on a site.",
                inputSchema: { type: "object", properties: { client: { type: "string" } }, required: ["client"] },
                run: async args => {
                    const c = find(args.client);
                    if (!c) return noClient(args.client);
                    return `${quoteBrief(c)}\n\nThe user's quoting sites:\n${store.settings().portals.map(p => `- ${p.name}: ${p.url}${p.note ? ` (${p.note})` : ""}`).join("\n")}`;
                }
            },
            {
                name: "insurance_save_quote",
                description: "Save a plan comparison you read from a quoting site to a client's file. Only use numbers the site showed; leave out what it didn't.",
                inputSchema: { type: "object", properties: {
                    client: { type: "string" }, portal: { type: "string", description: "The site the quotes came from." }, summary: { type: "string", description: "Your recommendation in a few sentences." },
                    plans: { type: "array", items: { type: "object", properties: {
                        carrier: { type: "string" }, plan: { type: "string" }, premium: { type: "number", description: "Monthly" }, deductible: { type: "number" }, moop: { type: "number", description: "Out-of-pocket max" },
                        drugCost: { type: "number", description: "Estimated yearly drug cost" }, doctorsInNetwork: { type: "string" }, stars: { type: "string" }, notes: { type: "string" } } } }
                }, required: ["client", "plans"] },
                run: async args => {
                    const c = find(args.client);
                    if (!c) return noClient(args.client);
                    const r = store.addQuote(c.id, { ...args, by });
                    return r.quote ? `Saved ${r.quote.plans.length} plans to ${c.name}'s file.` : `Not saved: ${r.error}`;
                }
            },
            {
                name: "insurance_commissions",
                description: "Check imported carrier commission statements against the book: missing payments, short payments, chargebacks and payments that match no policy, with the total shortfall.",
                inputSchema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM" }, to: { type: "string", description: "YYYY-MM" } } },
                run: async args => {
                    if (!store.statements().length) return "No commission statements imported yet. The user imports carrier CSVs in 🩺 Insurance > Commissions.";
                    const r = reconcile(store.clients(), store.statements(), { from: args.from, to: args.to, tolerance: store.settings().tolerance });
                    const flagged = r.rows.filter(x => ["missing", "short", "chargeback"].includes(x.status));
                    return [`${r.from} to ${r.to}: expected ${money(r.totals.expected)}, paid ${money(r.totals.paid)}, shortfall ${money(r.totals.shortfall)}.`,
                        `${r.totals.missing} missing, ${r.totals.short} short, ${r.totals.chargebacks} chargebacks, ${r.totals.unmatched} lines matching no policy.`,
                        ...flagged.slice(0, 40).map(x => `- ${x.status}: ${x.clientName}, ${x.carrier || "?"} ${x.plan}, ${x.month}: expected ${money(x.expected)}, paid ${money(x.paid)}`),
                        ...r.unmatched.slice(0, 15).map(u => `- no match: ${u.name || "?"} #${u.policy || "?"} ${u.month} ${money(u.amount)}`)].join("\n");
                }
            }
        ];
    }

    // ---------- printable SOA ----------

    function esc(text) { return String(text == null ? "" : text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function soaHtml(soa) {
        const ticked = new Set(soa.products);
        const signature = soa.signatureMethod === "drawn" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(soa.signatureImage)
            ? `<img src="${soa.signatureImage}" alt="Signature" style="max-height:90px;border-bottom:1px solid #000">`
            : `<p style="font-family:cursive;font-size:22px;border-bottom:1px solid #000">${esc(soa.typedName || (soa.signatureMethod === "recorded" ? "Verbal consent (recorded)" : ""))}</p>`;
        return `<!doctype html><html><head><meta charset="utf-8"><title>Scope of Appointment — ${esc(soa.beneficiary)}</title>
<style>body{font:14px/1.45 Arial,sans-serif;max-width:760px;margin:24px auto;color:#111}h1{font-size:20px}td{padding:4px 8px;vertical-align:top}.box{display:inline-block;width:14px;height:14px;border:1px solid #000;margin-right:6px;text-align:center;line-height:14px}small{color:#555}</style></head><body>
<h1>Scope of Sales Appointment Confirmation</h1>
<p>The Centers for Medicare &amp; Medicaid Services requires agents to document the scope of a marketing appointment before any face-to-face or phone sales meeting. The beneficiary agreed to discuss only the products ticked below. Signing does not obligate the beneficiary to enroll in a plan or affect current or future enrollment.</p>
${SOA_PRODUCTS.map(([k, label]) => `<p><span class="box">${ticked.has(k) ? "✓" : ""}</span>${esc(label)}</p>`).join("")}
<table>
<tr><td>Beneficiary</td><td><b>${esc(soa.beneficiary)}</b></td></tr>
${soa.representative ? `<tr><td>Authorized representative</td><td>${esc(soa.representative)}</td></tr>` : ""}
<tr><td>Appointment</td><td>${esc(soa.appointmentDate)} ${esc(soa.appointmentTime)} (${esc((SOA_METHODS.find(([k]) => k === soa.appointmentMethod) || [, ""])[1])})</td></tr>
<tr><td>Initiated by</td><td>${soa.initiatedBy === "agent" ? "Agent" : "Beneficiary"}${soa.walkIn ? ", walk-in" : ""}${soa.firstContact ? `; first contact: ${esc(soa.firstContact)}` : ""}</td></tr>
<tr><td>Agent</td><td>${esc(soa.agent.name)}${soa.agent.npn ? `, NPN ${esc(soa.agent.npn)}` : ""}${soa.agent.agency ? `, ${esc(soa.agent.agency)}` : ""}</td></tr>
<tr><td>Signed</td><td>${esc(soa.signedAt)} — ${esc((SIGN_METHODS.find(([k]) => k === soa.signatureMethod) || [, ""])[1])}${soa.recordingRef ? ` (recording: ${esc(soa.recordingRef)})` : ""}</td></tr>
</table>
<p>Beneficiary signature:</p>${signature}
${soa.notes ? `<p>Notes: ${esc(soa.notes)}</p>` : ""}
<p><small>Record ${esc(soa.id)} · SHA-256 ${esc(soa.sha256)} · Keep for 10 years.</small></p>
</body></html>`;
    }

    // ---------- the view ----------

    const STYLE_ID = "codev-insurance-desk-style";
    const CSS = `
.ins { display: flex; flex-direction: column; gap: 12px; min-width: 0; max-width: 100%; }
.ins > * { min-width: 0; max-width: 100%; }
.ins h3 { margin: 0; font-size: 1.05rem; }
.ins-bar, .ins-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ins-row > label { flex: 1 1 180px; min-width: 0; }
.ins input[type=text], .ins input[type=search], .ins input[type=password], .ins input[type=date], .ins input[type=time], .ins input[type=number], .ins input[type=email], .ins input[type=tel], .ins textarea, .ins select {
  background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 6px; padding: 7px 9px; font-size: 0.85rem; font-family: inherit; max-width: 100%; box-sizing: border-box; }
.ins label > input, .ins label > select, .ins label > textarea { width: 100%; }
.ins textarea { min-height: 60px; resize: vertical; width: 100%; }
.ins-btn { background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 6px; padding: 7px 12px; cursor: pointer; font-size: 0.82rem; white-space: nowrap; }
.ins-btn.primary { background: var(--accent); color: #031623; border-color: var(--accent); font-weight: bold; }
.ins-btn.danger { color: var(--danger); }
.ins-btn.small { padding: 3px 8px; font-size: 0.75rem; }
.ins-btn:disabled { opacity: 0.5; cursor: default; }
.ins-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border-color); overflow-x: auto; }
.ins-tabs button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-muted); padding: 8px 12px; cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
.ins-tabs button.on { color: var(--text-main); border-bottom-color: var(--accent); font-weight: bold; }
.ins-tabs .ins-count { background: var(--danger); color: #fff; border-radius: 999px; padding: 0 6px; margin-left: 4px; font-size: 0.7rem; }
.ins-note { font-size: 0.8rem; color: var(--text-muted); }
.ins-msg { font-size: 0.8rem; color: var(--accent); min-height: 1em; white-space: pre-wrap; }
.ins-msg.bad { color: var(--danger); }
.ins-panel { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.ins-panel label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; color: var(--text-muted); }
.ins-panel label.ins-check { flex-direction: row; align-items: center; gap: 6px; color: var(--text-main); }
.ins-list { display: flex; flex-direction: column; gap: 6px; }
.ins-item { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 8px; padding: 9px 11px; display: flex; gap: 10px; align-items: center; justify-content: space-between; text-align: left; color: var(--text-main); font: inherit; cursor: pointer; min-width: 0; }
.ins-item:hover { border-color: var(--accent); }
.ins-item > div { min-width: 0; }
.ins-item b { display: block; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-item small { color: var(--text-muted); font-size: 0.76rem; display: block; overflow: hidden; text-overflow: ellipsis; }
.ins-pill { border-radius: 999px; padding: 2px 8px; font-size: 0.72rem; border: 1px solid var(--border-color); color: var(--text-muted); white-space: nowrap; }
.ins-pill.now, .ins-pill.bad, .ins-pill.missing, .ins-pill.short, .ins-pill.chargeback { border-color: var(--danger); color: var(--danger); }
.ins-pill.soon, .ins-pill.warn, .ins-pill.over, .ins-pill.no_rate, .ins-pill.unmatched { border-color: var(--warning); color: var(--warning); }
.ins-pill.ok, .ins-pill.paid { border-color: var(--success); color: var(--success); }
.ins-sub { border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.ins-sub summary { cursor: pointer; font-weight: bold; font-size: 0.86rem; }
.ins-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.ins-table th, .ins-table td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--border-color); vertical-align: top; }
.ins-scroll { overflow-x: auto; max-width: 100%; }
.ins-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
.ins-stat { background: var(--bg-card); border-radius: 8px; padding: 8px 10px; }
.ins-stat b { display: block; font-size: 1.1rem; }
.ins-stat span { font-size: 0.75rem; color: var(--text-muted); }
.ins-sign { width: 100%; max-width: 520px; height: 160px; background: #fff; border-radius: 8px; touch-action: none; cursor: crosshair; }
.ins-log { font-size: 0.76rem; color: var(--text-muted); max-height: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.ins-lock { max-width: 420px; margin: 40px auto; }
/* CRM-style pages: object home, record highlights, stage path, related lists, activity timeline */
.ins-card { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ins-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 0.88rem; }
.ins-objhead { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.ins-objtitle { display: flex; gap: 10px; align-items: center; min-width: 0; }
.ins-objtitle > div { min-width: 0; }
.ins-objtitle small { display: block; font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.ins-objtitle h3 { overflow: hidden; text-overflow: ellipsis; }
.ins-objtitle select { font-weight: bold; font-size: 0.95rem; }
.ins-avatar { width: 40px; height: 40px; border-radius: 8px; background: var(--accent); color: #031623; display: flex; align-items: center; justify-content: center; font-weight: bold; flex: none; font-size: 1rem; }
.ins-icon { width: 24px; height: 24px; border-radius: 6px; background: var(--bg-card); display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; }
.ins-hls { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px 14px; border-top: 1px solid var(--border-color); padding-top: 8px; }
.ins-hl, .ins-field { display: flex; flex-direction: column; min-width: 0; font-size: 0.84rem; }
.ins-hl small, .ins-field small { font-size: 0.72rem; color: var(--text-muted); }
.ins-hl span, .ins-field span { overflow-wrap: anywhere; }
.ins-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 14px; }
.ins-field { border-bottom: 1px solid var(--border-color); padding-bottom: 4px; }
.ins-path { display: flex; gap: 2px; overflow-x: auto; }
.ins-step { flex: 1 1 0; min-width: 84px; background: var(--bg-card); color: var(--text-muted); border: none; padding: 8px 14px 8px 20px; font-size: 0.8rem; cursor: pointer; white-space: nowrap;
  clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%, 10px 50%); }
.ins-step:first-child { clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%); border-radius: 999px 0 0 999px; }
.ins-step:last-child { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 10px 50%); border-radius: 0 999px 999px 0; }
.ins-step.done { background: color-mix(in srgb, var(--success) 35%, var(--bg-card)); color: var(--text-main); }
.ins-step.current { background: var(--accent); color: #031623; font-weight: bold; }
.ins-step:hover:not(.current) { color: var(--text-main); }
.ins-record { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; align-items: start; }
.ins-record-main, .ins-record-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ins-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.ins-timeline li { display: flex; gap: 8px; align-items: flex-start; position: relative; font-size: 0.82rem; min-width: 0; }
.ins-timeline li > div { min-width: 0; }
.ins-timeline li:not(:last-child)::after { content: ""; position: absolute; left: 13px; top: 28px; bottom: -10px; width: 2px; background: var(--border-color); }
.ins-timeline b { display: block; }
.ins-timeline small { color: var(--text-muted); font-size: 0.72rem; }
.ins-timeline li.due.now b { color: var(--danger); }
.ins-dot { width: 28px; height: 28px; border-radius: 50%; background: var(--bg-card); display: flex; align-items: center; justify-content: center; flex: none; font-size: 0.8rem; }
.ins-tl-body { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-main); margin-top: 2px; }
.ins-listview tr[data-client] { cursor: pointer; }
.ins-listview tr[data-client]:hover td { background: var(--bg-card); }
.ins-listview td { white-space: nowrap; }
.ins-sortable { cursor: pointer; user-select: none; white-space: nowrap; }
.ins-link { color: var(--accent); }
.ins-seg { display: inline-flex; }
.ins-seg .ins-btn { border-radius: 0; }
.ins-seg .ins-btn:first-child { border-radius: 6px 0 0 6px; }
.ins-seg .ins-btn:last-child { border-radius: 0 6px 6px 0; }
.ins-btn.on { background: var(--accent); color: #031623; border-color: var(--accent); }
.ins-board { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; align-items: flex-start; }
.ins-lane { flex: 0 0 250px; max-width: 80vw; background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.ins-lane.over { border-color: var(--accent); }
.ins-lane-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; border-bottom: 2px solid var(--accent); padding-bottom: 4px; }
.ins-kcard { background: var(--bg-card); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 4px; cursor: grab; font-size: 0.82rem; min-width: 0; }
.ins-kcard small { color: var(--text-muted); font-size: 0.74rem; }
.ins-kcard .ins-pill { align-self: flex-start; white-space: normal; }
.ins-kcard select { font-size: 0.74rem; padding: 3px 6px; }
.ins-pill.stage-client { border-color: var(--success); color: var(--success); }
.ins-pill.stage-prospect { border-color: var(--accent); color: var(--accent); }
.ins-brief { white-space: pre-wrap; font-size: 0.8rem; background: var(--bg-dark); border-radius: 8px; padding: 10px; max-height: 300px; overflow: auto; }
@media (max-width: 900px) { .ins-record { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { .ins-row > label { flex-basis: 100%; } .ins-table { font-size: 0.74rem; } .ins-hide-sm { display: none; } .ins-hls { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

    function el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === "class") node.className = v;
            else if (k === "text") node.textContent = v;
            else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
            else if (k === "value") node.value = v;
            else if (k === "checked") node.checked = Boolean(v);
            else node.setAttribute(k, v === true ? "" : v);
        }
        for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
        return node;
    }
    function field(label, input) { return el("label", {}, label, input); }
    function textInput(value, attrs = {}) { return el("input", { type: "text", value: value == null ? "" : String(value), ...attrs }); }
    function select(options, value, attrs = {}) {
        const s = el("select", attrs, options.map(([k, l]) => el("option", { value: k, text: l })));
        s.value = value == null ? "" : value;
        return s;
    }

    const SECTIONS = [
        { id: "clients", label: "👥 Clients" },
        { id: "alerts", label: "🔔 Alerts" },
        { id: "soa", label: "✍️ Scope of Appointment" },
        { id: "commissions", label: "💵 Commissions" },
        { id: "quote", label: "🧭 Quoting" },
        { id: "privacy", label: "🔒 Privacy & backup" }
    ];

    // deps: askAgent(text), saveFile(name, content, mime), saveBytes(name, bytes, mime), pickFile(accept) -> text,
    // printHtml(html, name), confirm(text) -> bool, today() -> "YYYY-MM-DD" (tests)
    function mount(container, store, deps = {}) {
        if (!document.getElementById(STYLE_ID)) document.head.append(el("style", { id: STYLE_ID, text: CSS }));
        const today = () => (deps.today ? deps.today() : todayStr());
        const confirmIt = async text => (deps.confirm ? deps.confirm(text) : true);
        const ui = { section: "clients", clientId: "", editing: null, query: "", listView: "all", display: "table", sort: { key: "name", dir: "asc" }, recordTab: "details", composer: "call",
            activityFilter: "all", mapping: null, pending: null, quoteClient: "", soaClient: "" };
        const root = el("div", { class: "ins" });
        container.textContent = "";
        container.append(root);
        const msg = el("div", { class: "ins-msg" });
        function say(text, bad = false) { msg.textContent = text || ""; msg.className = `ins-msg${bad ? " bad" : ""}`; }

        let idleTimer = null;
        function touch() {
            clearTimeout(idleTimer);
            if (store.isEncrypted() && !store.isLocked()) idleTimer = setTimeout(() => { store.lock(); render(); }, deps.autoLockMs || AUTO_LOCK_MS);
        }
        root.addEventListener("pointerdown", touch);
        root.addEventListener("keydown", touch);

        function render() {
            const scroll = container.scrollTop;
            root.textContent = "";
            if (store.isLocked()) { root.append(lockScreen()); return; }
            touch();
            const due = computeAlerts(store.clients(), today(), { horizon: 14, soas: store.soas() }).filter(a => a.urgency === "now" || a.urgency === "soon").length;
            root.append(el("div", { class: "ins-bar" },
                el("h3", { text: "🩺 Insurance Desk" }),
                el("span", { class: "ins-note", text: `${store.clients().length} clients · kept on this device${store.isEncrypted() ? " · encrypted" : ""}` }),
                store.isEncrypted() ? el("button", { class: "ins-btn small", text: "🔒 Lock", onclick: () => { store.lock(); render(); } }) : null));
            root.append(el("div", { class: "ins-tabs", role: "tablist" }, SECTIONS.map(s => el("button", {
                class: ui.section === s.id ? "on" : "", "data-section": s.id, role: "tab",
                onclick: () => { ui.section = s.id; say(""); render(); }
            }, s.label, s.id === "alerts" && due ? el("span", { class: "ins-count", text: String(due) }) : null))));
            if (!store.isEncrypted() && store.clients().length && ui.section !== "privacy") {
                root.append(el("div", { class: "ins-note" }, "⚠️ This book isn't encrypted yet. ",
                    el("button", { class: "ins-btn small", text: "Set a passphrase", onclick: () => { ui.section = "privacy"; render(); } })));
            }
            root.append(msg);
            const body = { clients: clientsSection, alerts: alertsSection, soa: soaSection, commissions: commissionsSection, quote: quoteSection, privacy: privacySection }[ui.section]();
            root.append(body);
            container.scrollTop = scroll;
        }

        function lockScreen() {
            const pass = el("input", { type: "password", placeholder: "Passphrase", autocomplete: "current-password" });
            const note = el("div", { class: "ins-msg" });
            const go = async () => {
                note.textContent = "Unlocking…";
                const r = await store.unlock(pass.value);
                if (r.error) { note.textContent = r.error; note.className = "ins-msg bad"; return; }
                render();
            };
            pass.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
            setTimeout(() => pass.focus(), 0);
            return el("div", { class: "ins-panel ins-lock" }, el("h3", { text: "🔒 Insurance Desk is locked" }),
                el("div", { class: "ins-note", text: "Your clients' files are encrypted on this device. Enter your passphrase to open them." }),
                pass, el("button", { class: "ins-btn primary", text: "Unlock", onclick: go }), note);
        }

        // ---- clients: list views (table or Kanban), like a CRM's object home ----
        // [id, label, filter(client, today)]
        const LIST_VIEWS = [
            ["all", "All clients", () => true],
            ["open", "Leads and prospects", c => c.status === "lead" || c.status === "prospect"],
            ["clients", "Clients", c => c.status === "client"],
            ["t65", "Turning 65 in the next year", (c, t) => [c.dob, ...c.members.map(m => m.dob)].some(d => d && ageOn(d, t) >= 63 && ageOn(d, t) <= 64 && addMonths(d, 65 * 12) <= addMonths(t, 12))],
            ["medicare", "Medicare", c => c.policies.some(p => p.status !== "cancelled" && PLAN_GROUP[p.planType] === "medicare")],
            ["health", "ACA and health", c => c.policies.some(p => p.status !== "cancelled" && PLAN_GROUP[p.planType] === "health")],
            ["life", "Life and annuity", c => c.policies.some(p => p.status !== "cancelled" && PLAN_GROUP[p.planType] === "life")],
            ["followups", "Follow-ups due", (c, t) => c.followUp && c.followUp <= addDays(t, 7)],
            ["recent", "Recently changed", (c, t) => String(c.updatedAt).slice(0, 10) >= addDays(t, -14)]
        ];
        const premiumOf = c => round2(c.policies.filter(p => p.status === "active" && p.premium != null).reduce((t, p) => t + p.premium, 0));
        const coverageOf = c => c.policies.filter(p => p.status === "active" || p.status === "pending").map(p => `${PLAN_LABEL[p.planType]}${p.carrier ? ` · ${p.carrier}` : ""}`).join("; ");
        const stageLabel = s => (CLIENT_STATUS.find(([k]) => k === s) || CLIENT_STATUS[0])[1];
        const initials = name => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
        const COLUMNS = [
            ["name", "Name", c => c.name], ["status", "Stage", c => CLIENT_STATUS.findIndex(([k]) => k === c.status)],
            ["dob", "Birth date", c => c.dob || "9999"], ["age", "Age", c => (c.dob ? ageOn(c.dob, today()) : -1)], ["phone", "Phone", c => c.phone], ["email", "Email", c => c.email],
            ["place", "City", c => [c.city, c.state].filter(Boolean).join(", ")], ["zip", "ZIP", c => c.zip], ["coverage", "Coverage", c => coverageOf(c)],
            ["premium", "Premium/mo", c => premiumOf(c)], ["next", "Next date", c => c._next ? c._next.start : "9999"],
            ["updated", "Updated", c => String(c.updatedAt)]
        ];

        function clientsSection() {
            if (ui.clientId) {
                const c = store.client(ui.clientId);
                if (c) return clientDetail(c);
                ui.clientId = "";
            }
            if (ui.editing) return clientForm(ui.editing === "new" ? null : store.client(ui.editing));
            const t = today();
            const view = LIST_VIEWS.find(v => v[0] === ui.listView) || LIST_VIEWS[0];
            const picker = select(LIST_VIEWS.map(([k, l]) => [k, l]), view[0], { "data-field": "list-view", "aria-label": "List view" });
            picker.addEventListener("change", () => { ui.listView = picker.value; render(); });
            const q = el("input", { type: "search", placeholder: "Search this list…", value: ui.query, style: "flex: 1 1 200px" });
            const body = el("div", { class: "ins" });
            const next = {};
            for (const a of computeAlerts(store.clients(), t, { horizon: 365, soas: store.soas() })) if (!next[a.clientId]) next[a.clientId] = a;
            const rows = () => store.search(ui.query).filter(c => view[2](c, t)).map(c => Object.assign(Object.create(c), { _next: next[c.id] || null, _real: c }));
            const draw = () => {
                ui.query = q.value;
                body.textContent = "";
                const shown = rows();
                count.textContent = `${shown.length} item${shown.length === 1 ? "" : "s"} · sorted by ${(COLUMNS.find(([k]) => k === ui.sort.key) || COLUMNS[0])[1].toLowerCase()}`;
                if (!shown.length) return body.append(el("div", { class: "ins-note", text: store.clients().length ? "Nothing in this list view." : "No clients yet. Add your first one, or import a CSV from your old CRM." }));
                body.append(ui.display === "kanban" ? kanban(shown) : table(shown));
            };
            const table = shown => {
                const col = COLUMNS.find(([k]) => k === ui.sort.key) || COLUMNS[0];
                const dir = ui.sort.dir === "desc" ? -1 : 1;
                shown.sort((a, b) => { const x = col[2](a), y = col[2](b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * dir; });
                const head = el("tr", {}, COLUMNS.map(([k, label]) => el("th", { class: "ins-sortable", "data-sort": k, onclick: () => {
                    ui.sort = { key: k, dir: ui.sort.key === k && ui.sort.dir === "asc" ? "desc" : "asc" }; draw();
                } }, label, ui.sort.key === k ? (ui.sort.dir === "desc" ? " ▼" : " ▲") : "")));
                return el("div", { class: "ins-scroll ins-card" }, el("table", { class: "ins-table ins-listview" }, head, shown.slice(0, 500).map(c => el("tr", {
                    "data-client": c.name, tabindex: "0", onclick: () => { ui.clientId = c.id; render(); }, onkeydown: e => { if (e.key === "Enter") { ui.clientId = c.id; render(); } }
                },
                    el("td", {}, el("a", { class: "ins-link", text: c.name })), el("td", {}, el("span", { class: `ins-pill stage-${c.status}`, text: stageLabel(c.status) })),
                    el("td", { text: c.dob || "" }), el("td", { text: c.dob ? String(ageOn(c.dob, t)) : "" }), el("td", { text: c.phone }), el("td", { text: c.email }),
                    el("td", { text: [c.city, c.state].filter(Boolean).join(", ") }), el("td", { text: c.zip }),
                    el("td", { text: coverageOf(c) }), el("td", { text: premiumOf(c) ? money(premiumOf(c)) : "" }),
                    el("td", { title: c._next ? c._next.title : "" }, c._next ? el("span", { class: `ins-pill ${c._next.urgency}`, text: `${c._next.type} · ${c._next.start.slice(5)}` }) : ""),
                    el("td", { text: String(c.updatedAt).slice(0, 10) })))),
                    shown.length > 500 ? el("div", { class: "ins-note", text: `Showing 500 of ${shown.length}. Search to narrow it down.` }) : null);
            };
            // Drag a card to another stage, or pick it from the card's menu (phones can't drag).
            const kanban = shown => el("div", { class: "ins-board" }, CLIENT_STATUS.map(([stage, label]) => {
                const cards = shown.filter(c => c.status === stage).sort((a, b) => a.name.localeCompare(b.name));
                const total = round2(cards.reduce((s, c) => s + premiumOf(c), 0));
                const lane = el("div", { class: "ins-lane", "data-stage": stage,
                    ondragover: e => { e.preventDefault(); lane.classList.add("over"); }, ondragleave: () => lane.classList.remove("over"),
                    ondrop: e => { e.preventDefault(); lane.classList.remove("over"); moveTo(e.dataTransfer.getData("text/plain"), stage); } },
                    el("div", { class: "ins-lane-head" }, el("b", { text: label }), el("span", { class: "ins-note", text: `${cards.length}${total ? ` · ${money(total)}/mo` : ""}` })),
                    cards.slice(0, 200).map(c => {
                        const move = select(CLIENT_STATUS.map(([k, l]) => [k, `Move to ${l}`]), stage, { "aria-label": `Stage for ${c.name}`, onclick: e => e.stopPropagation() });
                        move.addEventListener("change", () => moveTo(c.id, move.value));
                        return el("div", { class: "ins-kcard", draggable: "true", "data-client": c.name,
                            ondragstart: e => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; },
                            onclick: () => { ui.clientId = c.id; render(); } },
                            el("b", { text: c.name }), el("small", { text: [c.dob && `age ${ageOn(c.dob, t)}`, [c.city, c.state].filter(Boolean).join(", "), coverageOf(c)].filter(Boolean).join(" · ") }),
                            c._next ? el("span", { class: `ins-pill ${c._next.urgency}`, text: c._next.title }) : null, move);
                    }));
                return lane;
            }));
            const moveTo = (id, stage) => {
                const c = store.client(id);
                if (!c || c.status === stage) return;
                store.saveClient({ id: c.id, status: stage });
                say(`${c.name} moved to ${stageLabel(stage)}.`);
                draw();
            };
            const count = el("span", { class: "ins-note" });
            q.addEventListener("input", draw);
            const toggle = (mode, icon, label) => el("button", { class: `ins-btn small${ui.display === mode ? " on" : ""}`, title: label, "aria-pressed": String(ui.display === mode), "data-display": mode,
                onclick: () => { ui.display = mode; render(); } }, icon, el("span", { class: "ins-hide-sm", text: ` ${label}` }));
            draw();
            return el("div", { class: "ins" },
                el("div", { class: "ins-objhead" },
                    el("div", { class: "ins-objtitle" }, el("span", { class: "ins-avatar", text: "👥" }), el("div", {}, el("small", { text: "Clients" }), picker)),
                    el("div", { class: "ins-bar" },
                        el("button", { class: "ins-btn primary", text: "+ New", "aria-label": "+ New client", onclick: () => { ui.editing = "new"; render(); } }),
                        el("button", { class: "ins-btn", text: "⬆ Import", title: "Import CSV", onclick: importClientsCsv }),
                        el("button", { class: "ins-btn", text: "⬇ Export", title: "Export CSV", onclick: exportClientsCsv }))),
                el("div", { class: "ins-bar" }, count, el("span", { style: "flex: 1" }), q, el("span", { class: "ins-seg" }, toggle("table", "☰", "Table"), toggle("kanban", "▦", "Kanban"))),
                body);
        }

        function clientForm(c) {
            const v = c || { members: [], doctors: [], medications: [], tags: [] };
            const f = {};
            const input = (key, label, type = "text", extra = {}) => { f[key] = el("input", { type, value: v[key] == null ? "" : String(v[key]), ...extra }); return field(label, f[key]); };
            f.status = select(CLIENT_STATUS, v.status || "lead");
            f.tobacco = el("input", { type: "checkbox", checked: v.tobacco });
            f.summary = el("textarea", { placeholder: "What they need, in a sentence or two" }); f.summary.value = v.summary || "";
            f.tags = textInput((v.tags || []).join(", "), { placeholder: "comma, separated" });
            f.followUpNote = textInput(v.followUpNote || "");
            const listEditor = (rows, cols, make) => {
                const box = el("div", { class: "ins-list" });
                const add = row => {
                    const inputs = cols.map(([key, label, opts]) => opts ? select(opts, row[key] || opts[0][0]) : el("input", { type: key === "dob" ? "date" : "text", placeholder: label, value: row[key] || "" }));
                    const line = el("div", { class: "ins-row" }, inputs, el("button", { class: "ins-btn small danger", text: "✕", type: "button", onclick: () => line.remove() }));
                    line._read = () => make(Object.fromEntries(cols.map(([key], i) => [key, inputs[i].value])));
                    box.append(line);
                };
                rows.forEach(add);
                return { box, add: () => add({}), read: () => [...box.children].map(l => l._read()).filter(Boolean) };
            };
            const members = listEditor(v.members, [["name", "Name"], ["relation", "Relation", RELATIONS], ["dob", "Birth date"]], r => r.name.trim() ? r : null);
            const doctors = listEditor(v.doctors, [["name", "Doctor"], ["specialty", "Specialty"], ["location", "City / clinic"], ["npi", "NPI"]], r => r.name.trim() ? r : null);
            const meds = listEditor(v.medications, [["name", "Drug"], ["dose", "Dose"], ["frequency", "How often"]], r => r.name.trim() ? r : null);
            const save = () => {
                const data = { id: c ? c.id : undefined, _new: !c, members: members.read(), doctors: doctors.read(), medications: meds.read(), tobacco: f.tobacco.checked, status: f.status.value,
                    summary: f.summary.value, tags: f.tags.value, followUpNote: f.followUpNote.value };
                for (const key of ["name", "phone", "email", "dob", "address", "city", "state", "zip", "county", "leadSource", "householdIncome", "householdSize", "partADate", "partBDate", "pharmacy", "followUp"]) data[key] = f[key].value;
                const r = store.saveClient(data);
                if (r.error && !r.client) return say(r.error, true);
                ui.editing = null; ui.clientId = r.client.id;
                say(r.error || `Saved ${r.client.name}.`, Boolean(r.error));
                render();
            };
            return el("div", { class: "ins-panel" },
                el("h3", { text: c ? `Edit ${c.name}` : "New client" }),
                el("div", { class: "ins-row" }, input("name", "Full name", "text", { "data-field": "name" }), field("Status", f.status), input("dob", "Birth date", "date", { "data-field": "dob" })),
                el("div", { class: "ins-row" }, input("phone", "Phone", "tel"), input("email", "Email", "email"), input("leadSource", "Lead source")),
                el("div", { class: "ins-row" }, input("address", "Street address"), input("city", "City")),
                el("div", { class: "ins-row" }, input("state", "State", "text", { maxlength: "2" }), input("zip", "ZIP", "text", { "data-field": "zip" }), input("county", "County")),
                field("Summary", f.summary),
                el("details", { class: "ins-sub", open: c && c.members.length ? true : null }, el("summary", { text: `Household (${v.members.length})` }),
                    el("div", { class: "ins-row" }, input("householdIncome", "Expected yearly household income ($)", "number"), input("householdSize", "Household size (tax)", "number"),
                        el("label", { class: "ins-check" }, f.tobacco, "Tobacco user")),
                    members.box, el("button", { class: "ins-btn small", type: "button", text: "+ Add household member", onclick: members.add })),
                el("details", { class: "ins-sub" }, el("summary", { text: "Medicare" }),
                    el("div", { class: "ins-row" }, input("partADate", "Part A start", "date"), input("partBDate", "Part B start", "date"), input("pharmacy", "Pharmacy"))),
                el("details", { class: "ins-sub", open: c && (c.doctors.length || c.medications.length) ? true : null }, el("summary", { text: "Doctors and prescriptions" }),
                    el("div", { class: "ins-note", text: "Private health information. It stays on this device and goes into quotes only when you ask." }),
                    doctors.box, el("button", { class: "ins-btn small", type: "button", text: "+ Add doctor", onclick: doctors.add }),
                    meds.box, el("button", { class: "ins-btn small", type: "button", text: "+ Add prescription", onclick: meds.add })),
                el("div", { class: "ins-row" }, input("followUp", "Follow up on", "date"), field("Follow-up note", f.followUpNote), field("Tags", f.tags)),
                el("div", { class: "ins-bar" }, el("button", { class: "ins-btn primary", text: "Save client", "data-action": "save-client", onclick: save }),
                    el("button", { class: "ins-btn", text: "Cancel", onclick: () => { ui.editing = null; render(); } })));
        }

        function policyForm(c, p) {
            const v = p || { planType: "aca", status: "active", commission: {} };
            const f = {
                planType: select(PLAN_TYPES.map(([k, l]) => [k, l]), v.planType), status: select(POLICY_STATUS, v.status),
                commissionType: select(COMMISSION_TYPES, (v.commission || {}).type || "")
            };
            const input = (key, label, type = "text", value) => { f[key] = el("input", { type, value: value != null ? String(value) : v[key] == null ? "" : String(v[key]), "data-field": key }); return field(label, f[key]); };
            const box = el("div", { class: "ins-panel" },
                el("b", { text: p ? "Edit policy" : "New policy" }),
                el("div", { class: "ins-row" }, field("Plan type", f.planType), input("carrier", "Carrier"), input("planName", "Plan name"), field("Status", f.status)),
                el("div", { class: "ins-row" }, input("policyNumber", "Policy #"), input("memberId", "Member ID"), input("premium", "Monthly premium ($)", "number"), input("membersCovered", "People covered", "number")),
                el("div", { class: "ins-row" }, input("effectiveDate", "Effective", "date"), input("renewalDate", "Renewal (if not the anniversary)", "date"), input("termDate", "Ends", "date")),
                el("details", { class: "ins-sub" }, el("summary", { text: "Life insurance" }),
                    el("div", { class: "ins-row" }, input("faceAmount", "Face amount ($)", "number"), input("beneficiary", "Beneficiary"), input("conversionDeadline", "Conversion deadline (term)", "date"))),
                el("details", { class: "ins-sub", open: true }, el("summary", { text: "Commission" }),
                    el("div", { class: "ins-row" }, field("Paid as", f.commissionType), input("commissionAmount", "First-year amount ($ or %)", "number", (v.commission || {}).amount),
                        input("renewalAmount", "Renewal amount (after 12 months)", "number", (v.commission || {}).renewalAmount))),
                el("div", { class: "ins-bar" },
                    el("button", { class: "ins-btn primary", text: "Save policy", "data-action": "save-policy", onclick: () => {
                        const data = { id: p ? p.id : undefined, planType: f.planType.value, status: f.status.value,
                            commission: { type: f.commissionType.value, amount: f.commissionAmount.value, renewalAmount: f.renewalAmount.value } };
                        for (const key of ["carrier", "planName", "policyNumber", "memberId", "premium", "membersCovered", "effectiveDate", "renewalDate", "termDate", "faceAmount", "beneficiary", "conversionDeadline"]) data[key] = f[key].value;
                        const r = store.savePolicy(c.id, data);
                        say(r.error || "Policy saved.", Boolean(r.error));
                        ui.pending = null; render();
                    } }),
                    el("button", { class: "ins-btn", text: "Cancel", onclick: () => { ui.pending = null; render(); } })));
            return box;
        }

        // ---- a client's record page: highlights, stage path, related lists and details, activity ----
        function clientDetail(c) {
            const t = today();
            const alerts = computeAlerts([c], t, { horizon: 120, soas: store.soas(c.id) });
            const active = c.policies.filter(p => p.status === "active");
            const soas = store.soas(c.id);
            const back = el("button", { class: "ins-btn small", text: "← Clients", onclick: () => { ui.clientId = ""; ui.pending = null; render(); } });

            // Highlights panel: who they are and the numbers that matter, at a glance.
            const highlight = (label, value) => el("div", { class: "ins-hl" }, el("small", { text: label }), el("span", { text: value || "—" }));
            const highlights = el("div", { class: "ins-card ins-highlights" },
                el("div", { class: "ins-objhead" },
                    el("div", { class: "ins-objtitle" }, el("span", { class: "ins-avatar", text: initials(c.name) }), el("div", {}, el("small", { text: "Client" }), el("h3", { text: c.name }))),
                    el("div", { class: "ins-bar" },
                        el("button", { class: "ins-btn small", text: "Edit", onclick: () => { ui.editing = c.id; ui.clientId = ""; render(); } }),
                        el("button", { class: "ins-btn small", text: "✍️ New SOA", onclick: () => { ui.section = "soa"; ui.soaClient = c.id; render(); } }),
                        el("button", { class: "ins-btn small", text: "🧭 Quote", onclick: () => { ui.section = "quote"; ui.quoteClient = c.id; render(); } }),
                        el("button", { class: "ins-btn small danger", text: "Delete", title: "Delete client", onclick: async () => {
                            if (!(await confirmIt(`Delete ${c.name}, their documents and SOAs from this device? CMS expects Medicare records kept for 10 years, so export a backup first if you may need them.`))) return;
                            await store.removeClient(c.id); ui.clientId = ""; render();
                        } }))),
                el("div", { class: "ins-hls" },
                    highlight("Stage", stageLabel(c.status)), highlight("Phone", c.phone), highlight("Age", c.dob ? `${ageOn(c.dob, t)} (born ${niceDate(c.dob)})` : ""),
                    highlight("Location", [c.city, c.state, c.zip].filter(Boolean).join(", ")), highlight("Active policies", String(active.length)),
                    highlight("Premium", premiumOf(c) ? `${money(premiumOf(c))}/mo` : ""), highlight("Next date", alerts[0] ? `${niceDate(alerts[0].start)}: ${alerts[0].title}` : "")));

            // The stage path: done stages are ticked, the current one is filled; click one to move there.
            const stages = CLIENT_STATUS.map(([k]) => k);
            const at = stages.indexOf(c.status);
            const path = el("div", { class: "ins-path", role: "list", "aria-label": "Stage" }, CLIENT_STATUS.map(([k, label], i) => el("button", {
                class: `ins-step${i < at ? " done" : ""}${i === at ? " current" : ""}`, role: "listitem", "data-stage": k, "aria-current": i === at ? "step" : null,
                title: i === at ? "Current stage" : `Mark as ${label}`,
                onclick: () => { if (k !== c.status) { store.saveClient({ id: c.id, status: k }); say(`${c.name} is now ${label}.`); render(); } }
            }, i < at ? "✓ " : "", label)));

            // Related lists.
            const card = (icon, title, count, body, action) => el("div", { class: "ins-card ins-related", "data-related": title },
                el("div", { class: "ins-card-head" }, el("span", { class: "ins-icon", text: icon }), el("b", { text: `${title} (${count})` }), el("span", { style: "flex: 1" }), action || null),
                body);
            const policies = el("div", { class: "ins-list" });
            for (const p of c.policies) {
                if (ui.pending === p.id) { policies.append(policyForm(c, p)); continue; }
                const comm = p.commission && p.commission.type ? `${COMMISSION_TYPES.find(([k]) => k === p.commission.type)[1]}: ${p.commission.type === "percent" ? `${p.commission.amount}%` : money(p.commission.amount)}` : "commission not set";
                policies.append(el("div", { class: "ins-item", style: "cursor: default" },
                    el("div", {}, el("b", { text: `${PLAN_LABEL[p.planType]}${p.carrier ? ` · ${p.carrier}` : ""}${p.planName ? ` ${p.planName}` : ""}` }),
                        el("small", { text: [p.policyNumber && `#${p.policyNumber}`, p.effectiveDate && `effective ${p.effectiveDate}`, p.termDate && `ends ${p.termDate}`, p.premium != null && `${money(p.premium)}/mo`, p.faceAmount != null && `face ${money(p.faceAmount)}`, comm].filter(Boolean).join(" · ") })),
                    el("div", { class: "ins-bar" }, el("span", { class: `ins-pill ${p.status === "active" ? "ok" : p.status === "pending" ? "warn" : ""}`, text: p.status }),
                        el("button", { class: "ins-btn small", text: "Edit", onclick: () => { ui.pending = p.id; render(); } }),
                        el("button", { class: "ins-btn small danger", text: "✕", title: "Delete policy", onclick: async () => { if (await confirmIt(`Delete this ${PLAN_LABEL[p.planType]} policy from ${c.name}'s file?`)) { store.removePolicy(c.id, p.id); render(); } } }))));
            }
            if (ui.pending === "new") policies.append(policyForm(c, null));
            if (!c.policies.length && ui.pending !== "new") policies.append(el("div", { class: "ins-note", text: "No policies yet." }));

            const fileKind = select(DOC_KINDS, "application", { "aria-label": "Document type" });
            const fileInput = el("input", { type: "file", style: "display:none", onchange: async () => {
                const file = fileInput.files[0];
                if (!file) return;
                say(`Saving ${file.name}…`);
                const r = await store.addDocument(c.id, { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()), kind: fileKind.value });
                say(r.error || `Saved ${file.name}.`, Boolean(r.error));
                render();
            } });
            const docs = el("div", { class: "ins-list" },
                el("div", { class: "ins-note", text: "Signed applications, drug lists, call recordings. Each keeps a SHA-256 fingerprint so you can show it wasn't changed." }),
                el("div", { class: "ins-row" }, fileKind, el("button", { class: "ins-btn small", text: "⬆ Add file", onclick: () => fileInput.click() }), fileInput),
                c.documents.map(d => el("div", { class: "ins-item", style: "cursor: default" },
                    el("div", {}, el("b", { text: d.name }), el("small", { text: `${(DOC_KINDS.find(([k]) => k === d.kind) || [, "Other"])[1]} · ${Math.max(1, Math.round(d.size / 1024))} KB · added ${d.addedAt.slice(0, 10)} · SHA-256 ${d.sha256.slice(0, 16)}…` })),
                    el("div", { class: "ins-bar" },
                        el("button", { class: "ins-btn small", text: "Open", onclick: async () => {
                            const doc = await store.readDocument(d.id);
                            if (!doc) return say("That file is missing from this device.", true);
                            if ((await sha256Hex(doc.bytes)) !== d.sha256) say("Warning: this file's fingerprint doesn't match the one taken when it was added.", true);
                            if (deps.saveBytes) deps.saveBytes(d.name, doc.bytes, d.type);
                        } }),
                        el("button", { class: "ins-btn small danger", text: "✕", onclick: async () => { if (await confirmIt(`Delete ${d.name}? Audit rules may require you to keep it.`)) { await store.removeDocument(c.id, d.id); render(); } } })))));
            const household = el("div", { class: "ins-list" }, c.members.length ? c.members.map(m => el("div", { class: "ins-item", style: "cursor: default" },
                el("div", {}, el("b", { text: m.name }), el("small", { text: [RELATIONS.find(([k]) => k === m.relation)[1], m.dob && `age ${ageOn(m.dob, t)}`, m.tobacco && "tobacco"].filter(Boolean).join(" · ") })))) : el("div", { class: "ins-note", text: "Only the client." }));
            const related = el("div", { class: "ins" },
                card("📄", "Policies", c.policies.length, policies, ui.pending ? null : el("button", { class: "ins-btn small", text: "New", "data-action": "add-policy", onclick: () => { ui.pending = "new"; render(); } })),
                card("👪", "Household", c.members.length, household, el("button", { class: "ins-btn small", text: "Edit", onclick: () => { ui.editing = c.id; ui.clientId = ""; render(); } })),
                card("✍️", "Scopes of Appointment", soas.length, soaList(soas), el("button", { class: "ins-btn small", text: "New", onclick: () => { ui.section = "soa"; ui.soaClient = c.id; render(); } })),
                card("🗂️", "Documents", c.documents.length, docs),
                card("🧭", "Quotes", c.quotes.length, c.quotes.length ? el("div", { class: "ins-list" }, c.quotes.slice().reverse().map(quoteTable)) : el("div", { class: "ins-note", text: "No quotes saved yet." })));

            // Details: every field, read-only, in sections.
            const fieldBox = (label, value) => el("div", { class: "ins-field" }, el("small", { text: label }), el("span", { text: value == null || value === "" ? "—" : String(value) }));
            const section = (title, ...fields) => el("div", { class: "ins-card" }, el("div", { class: "ins-card-head" }, el("b", { text: title })), el("div", { class: "ins-fields" }, fields));
            const details = el("div", { class: "ins" },
                section("Contact", fieldBox("Name", c.name), fieldBox("Stage", stageLabel(c.status)), fieldBox("Phone", c.phone), fieldBox("Email", c.email), fieldBox("Birth date", c.dob ? niceDate(c.dob) : ""), fieldBox("Lead source", c.leadSource), fieldBox("Tags", c.tags.join(", "))),
                section("Address", fieldBox("Street", c.address), fieldBox("City", c.city), fieldBox("State", c.state), fieldBox("ZIP", c.zip), fieldBox("County", c.county)),
                section("Household and income", fieldBox("Household size", c.householdSize), fieldBox("Expected income", c.householdIncome == null ? "" : money(c.householdIncome)), fieldBox("Tobacco", c.tobacco ? "Yes" : "No"), fieldBox("Members", c.members.map(m => m.name).join(", "))),
                section("Medicare", fieldBox("Part A", c.partADate), fieldBox("Part B", c.partBDate), fieldBox("Pharmacy", c.pharmacy)),
                section("Doctors and prescriptions", fieldBox("Doctors", c.doctors.map(d => [d.name, d.specialty, d.location, d.npi && `NPI ${d.npi}`].filter(Boolean).join(", ")).join("; ")), fieldBox("Prescriptions", c.medications.map(m => [m.name, m.dose, m.frequency].filter(Boolean).join(" ")).join("; "))),
                section("Coverage", ...(c.policies.length ? c.policies.map(p => fieldBox(`${PLAN_LABEL[p.planType]} (${p.status})`, [[p.carrier, p.planName].filter(Boolean).join(" "), p.policyNumber && `#${p.policyNumber}`, p.memberId && `member ${p.memberId}`,
                    p.effectiveDate && `effective ${p.effectiveDate}`, p.premium != null && `${money(p.premium)}/mo`, p.faceAmount != null && `face ${money(p.faceAmount)}`, p.beneficiary && `beneficiary ${p.beneficiary}`].filter(Boolean).join(" · "))) : [fieldBox("Policies", "")])),
                section("Summary", fieldBox("What they need", c.summary), fieldBox("Follow up", c.followUp ? `${niceDate(c.followUp)}${c.followUpNote ? `: ${c.followUpNote}` : ""}` : "")),
                el("div", { class: "ins-bar" }, el("button", { class: "ins-btn", text: "✏️ Edit details", onclick: () => { ui.editing = c.id; ui.clientId = ""; render(); } })));
            // Details opens first, so all of the client's information is on screen when the record opens.
            const tab = ui.recordTab === "related" ? "related" : "details";
            const mainTabs = el("div", { class: "ins-tabs" }, [["details", "Details"], ["related", `Related (${c.policies.length + c.documents.length + soas.length + c.quotes.length})`]].map(([k, l]) => el("button", { class: tab === k ? "on" : "", "data-record-tab": k, onclick: () => { ui.recordTab = k; render(); }, text: l })));

            return el("div", { class: "ins" }, el("div", { class: "ins-bar" }, back), highlights, path,
                el("div", { class: "ins-record" },
                    el("div", { class: "ins-record-main" }, mainTabs, tab === "details" ? details : related),
                    el("div", { class: "ins-record-side" }, activityPanel(c, alerts))));
        }

        // The activity timeline: quick actions at the top, what's coming up, then everything that happened.
        function activityPanel(c, alerts) {
            const mode = ui.composer || "call";
            const text = el("textarea", { placeholder: mode === "call" ? "What did you talk about?" : mode === "note" ? "Write a note…" : "What to follow up on", "data-field": "activity-text" });
            const when = el("input", { type: "date", value: c.followUp || addDays(today(), 3), "aria-label": "Follow-up date" });
            const save = () => {
                if (mode === "followup") {
                    if (!when.value) return say("Pick a date.", true);
                    store.saveClient({ id: c.id, followUp: when.value, followUpNote: text.value });
                    say(`Follow-up set for ${niceDate(when.value)}.`);
                } else {
                    const r = store.addNote(c.id, text.value, { kind: mode });
                    if (r.error) return say(r.error, true);
                }
                render();
            };
            const composer = el("div", { class: "ins-card" },
                el("div", { class: "ins-tabs" }, [["call", "📞 Log a call"], ["note", "📝 New note"], ["followup", "📅 Follow-up"]].map(([k, l]) => el("button", { class: mode === k ? "on" : "", "data-composer": k, text: l, onclick: () => { ui.composer = k; render(); } }))),
                mode === "followup" ? field("Follow up on", when) : null, text,
                el("div", { class: "ins-bar" }, el("span", { style: "flex: 1" }), el("button", { class: "ins-btn primary small", text: "Save", "data-action": "save-activity", onclick: save })));
            const filter = ui.activityFilter || "all";
            const items = [];
            for (const n of c.notes) items.push({ at: n.at, kind: n.kind === "call" ? "call" : "note", icon: n.kind === "call" ? "📞" : "📝", title: n.kind === "call" ? `Call${n.by ? ` (${n.by})` : ""}` : `Note${n.by ? ` (${n.by})` : ""}`, body: n.text });
            for (const s of store.soas(c.id)) items.push({ at: s.signedAt, kind: "compliance", icon: "✍️", title: "Scope of Appointment signed", body: s.products.map(p => SOA_PRODUCTS.find(([k]) => k === p)[1]).join("; ") });
            for (const q of c.quotes) items.push({ at: q.at, kind: "quote", icon: "🧭", title: `Quote from ${q.portal || "a quoting site"}`, body: q.summary || `${q.plans.length} plans` });
            for (const d of c.documents) items.push({ at: d.addedAt, kind: "compliance", icon: "🗂️", title: `Document: ${d.name}`, body: "" });
            for (const l of c.log) if (!/^(Call note|Note) added|^Document added|^Scope of Appointment|^Quote saved/.test(l.what)) items.push({ at: l.at, kind: "change", icon: "✏️", title: l.what, body: "" });
            items.sort((a, b) => (a.at < b.at ? 1 : -1));
            const shown = items.filter(i => filter === "all" || i.kind === filter || (filter === "note" && i.kind === "call"));
            const filters = select([["all", "All activity"], ["call", "Calls"], ["note", "Calls and notes"], ["compliance", "SOAs and documents"], ["quote", "Quotes"], ["change", "Changes"]], filter, { "aria-label": "Show" });
            filters.addEventListener("change", () => { ui.activityFilter = filters.value; render(); });
            const upcoming = alerts.slice(0, 6);
            return el("div", { class: "ins" }, composer,
                el("div", { class: "ins-card" },
                    el("div", { class: "ins-card-head" }, el("b", { text: "Upcoming and overdue" })),
                    upcoming.length ? el("ul", { class: "ins-timeline" }, upcoming.map(a => el("li", { class: `due ${a.urgency}`, "data-upcoming": a.type },
                        el("span", { class: "ins-dot", text: "🔔" }), el("div", {}, el("b", { text: a.title }), el("small", { text: a.start === a.end ? niceDate(a.start) : `${niceDate(a.start)} → ${niceDate(a.end)}` })))))
                        : el("div", { class: "ins-note", text: "Nothing due in the next 4 months." })),
                el("div", { class: "ins-card" },
                    el("div", { class: "ins-card-head" }, el("b", { text: "Activity" }), el("span", { style: "flex: 1" }), filters),
                    shown.length ? el("ul", { class: "ins-timeline", "data-timeline": "past" }, shown.slice(0, 60).map(i => el("li", { "data-kind": i.kind },
                        el("span", { class: "ins-dot", text: i.icon }), el("div", {}, el("b", { text: i.title }), el("small", { text: i.at.slice(0, 16).replace("T", " ") }), i.body ? el("div", { class: "ins-tl-body", text: i.body }) : null))))
                        : el("div", { class: "ins-note", text: "No activity yet." })));
        }

        function quoteTable(q) {
            return el("div", { class: "ins-panel" }, el("b", { text: `${q.at.slice(0, 10)} · ${q.portal || "Quote"}${q.by ? ` · by ${q.by}` : ""}` }),
                q.summary ? el("div", { class: "ins-note", text: q.summary }) : null,
                el("div", { class: "ins-scroll" }, el("table", { class: "ins-table" },
                    el("tr", {}, ["Carrier", "Plan", "Premium", "Deductible", "Max OOP", "Drugs/yr", "Doctors", "Stars"].map(h => el("th", { text: h }))),
                    q.plans.map(p => el("tr", {}, [p.carrier, p.plan, money(p.premium), money(p.deductible), money(p.moop), money(p.drugCost), p.doctorsInNetwork, p.stars].map(v => el("td", { text: v || "" })))))));
        }

        // ---- alerts ----
        function alertsSection() {
            const days = store.settings().alertDays || 90;
            const alerts = computeAlerts(store.clients(), today(), { horizon: days, soas: store.soas() });
            const groups = [["now", "Now"], ["soon", "Next 2 weeks"], ["upcoming", "Next 6 weeks"], ["later", "Later"]];
            const horizon = select([["30", "30 days"], ["60", "60 days"], ["90", "90 days"], ["180", "6 months"], ["365", "A year"]], String(days));
            horizon.addEventListener("change", () => { store.saveSettings({ alertDays: Number(horizon.value) }); render(); });
            return el("div", { class: "ins" },
                el("div", { class: "ins-bar" }, el("span", { class: "ins-note", text: "Look ahead" }), horizon,
                    el("button", { class: "ins-btn", text: "📅 Add to calendar (.ics)", disabled: !alerts.length, onclick: () => deps.saveFile && deps.saveFile("insurance-alerts.ics", alertsToIcs(alerts), "text/calendar") })),
                alerts.length ? null : el("div", { class: "ins-note", text: "Nothing due. Alerts come from birth dates, policies and their dates, SOAs and follow-ups." }),
                groups.map(([g, label]) => {
                    const list = alerts.filter(a => a.urgency === g);
                    if (!list.length) return null;
                    return el("div", { class: "ins-panel" }, el("b", { text: `${label} (${list.length})` }),
                        el("div", { class: "ins-list" }, list.map(a => el("button", { class: "ins-item", "data-alert": a.type, onclick: () => { ui.section = "clients"; ui.clientId = a.clientId; render(); } },
                            el("div", {}, el("b", { text: a.title }), el("small", { text: `${a.start === a.end ? niceDate(a.start) : `${niceDate(a.start)} → ${niceDate(a.end)}`} · ${a.detail}` })),
                            el("span", { class: `ins-pill ${a.urgency}`, text: a.type })))));
                }),
                el("div", { class: "ins-note", text: "Dates follow CMS and HealthCare.gov rules as of 2026. They're reminders, not compliance advice; your FMO and carriers have the final word." }));
        }

        // ---- SOA ----
        function soaList(list) {
            if (!list.length) return el("div", { class: "ins-note", text: "None yet." });
            return el("div", { class: "ins-list" }, list.slice().reverse().map(s => {
                const c = store.client(s.clientId);
                const checks = soaChecks(s, c, today());
                const verified = el("span", { class: "ins-pill", text: "checking…" });
                verifySoa(s).then(ok => { verified.textContent = ok ? "unchanged ✓" : "ALTERED"; verified.className = `ins-pill ${ok ? "ok" : "bad"}`; });
                return el("div", { class: "ins-panel" },
                    el("div", { class: "ins-bar" }, el("b", { text: `${s.beneficiary} · signed ${s.signedAt.slice(0, 16).replace("T", " ")}` }), verified,
                        el("button", { class: "ins-btn small", text: "🖨 Print / save", onclick: () => deps.printHtml && deps.printHtml(soaHtml(s), `SOA-${s.beneficiary.replace(/\W+/g, "-")}-${s.signedAt.slice(0, 10)}.html`) })),
                    el("div", { class: "ins-note", text: `Products: ${s.products.map(p => SOA_PRODUCTS.find(([k]) => k === p)[1]).join("; ")}. Appointment ${s.appointmentDate || "?"} ${s.appointmentTime || ""}, ${SOA_METHODS.find(([k]) => k === s.appointmentMethod)[1].toLowerCase()}.` }),
                    checks.map(ch => el("div", { class: "ins-bar" }, el("span", { class: `ins-pill ${ch.level}`, text: ch.level === "ok" ? "ok" : ch.level === "bad" ? "check" : "note" }), el("span", { class: "ins-note", text: ch.text }))));
            }));
        }

        function soaSection() {
            const clientList = store.clients().slice().sort((a, b) => a.name.localeCompare(b.name));
            if (!clientList.length) return el("div", { class: "ins-note", text: "Add the client first in 👥 Clients, then capture their Scope of Appointment here." });
            const who = select(clientList.map(c => [c.id, c.name]), ui.soaClient || clientList[0].id, { "data-field": "soa-client" });
            const products = SOA_PRODUCTS.map(([k, label]) => { const box = el("input", { type: "checkbox", value: k, checked: k === "ma" || k === "pdp" }); return { k, box, label: el("label", { class: "ins-check" }, box, label) }; });
            const appt = el("input", { type: "date", "data-field": "soa-date" });
            const time = el("input", { type: "time", value: "10:00" });
            const method = select(SOA_METHODS, "phone");
            const initiated = select([["beneficiary", "The beneficiary"], ["agent", "Me (the agent)"]], "beneficiary");
            const walkIn = el("input", { type: "checkbox" });
            const firstContact = textInput("", { placeholder: "e.g. inbound call from a Medicare ad" });
            const rep = textInput("", { placeholder: "Only if someone signs for them" });
            const signMethod = select(SIGN_METHODS, "drawn", { "data-field": "soa-sign-method" });
            const typed = textInput("", { placeholder: "Beneficiary types their full name", "data-field": "soa-typed" });
            const recording = textInput("", { placeholder: "Call ID or recording file name" });
            const notes = el("textarea", { placeholder: "Anything else for the record" });
            const pad = el("canvas", { class: "ins-sign", width: "520", height: "160" });
            let drawn = false;
            (function signaturePad() {
                const ctx = pad.getContext && pad.getContext("2d");
                if (!ctx) return;
                ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pad.width, pad.height);
                ctx.strokeStyle = "#111"; ctx.lineWidth = 2.2; ctx.lineCap = "round";
                let down = false;
                const at = e => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
                pad.addEventListener("pointerdown", e => { down = true; drawn = true; ctx.beginPath(); ctx.moveTo(...at(e)); pad.setPointerCapture && pad.setPointerCapture(e.pointerId); });
                pad.addEventListener("pointermove", e => { if (!down) return; ctx.lineTo(...at(e)); ctx.stroke(); });
                pad.addEventListener("pointerup", () => { down = false; });
                pad.clearPad = () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pad.width, pad.height); drawn = false; };
            })();
            const signBox = el("div", { class: "ins-list" });
            const drawSign = () => {
                signBox.textContent = "";
                if (signMethod.value === "drawn") signBox.append(el("div", { class: "ins-note", text: "Hand the device to the beneficiary to sign with a finger or mouse." }), pad,
                    el("button", { class: "ins-btn small", type: "button", text: "Clear", onclick: () => pad.clearPad && pad.clearPad() }));
                else if (signMethod.value === "typed") signBox.append(field("Typed signature", typed));
                else signBox.append(field("Recording reference", recording), el("div", { class: "ins-note", text: "Read the SOA aloud on the recorded line and get a clear yes. Attach the recording to the client's documents." }));
            };
            signMethod.addEventListener("change", drawSign);
            drawSign();
            const save = async () => {
                const r = await store.addSoa({
                    clientId: who.value, products: products.filter(p => p.box.checked).map(p => p.k), appointmentDate: appt.value, appointmentTime: time.value,
                    appointmentMethod: method.value, initiatedBy: initiated.value, walkIn: walkIn.checked, firstContact: firstContact.value, representative: rep.value,
                    signatureMethod: signMethod.value, signatureImage: signMethod.value === "drawn" && drawn ? pad.toDataURL("image/png") : "", typedName: typed.value, recordingRef: recording.value, notes: notes.value
                });
                if (r.error) return say(r.error, true);
                const checks = soaChecks(r.soa, store.client(r.soa.clientId), today());
                say(`SOA saved for ${r.soa.beneficiary}. ${checks.filter(c => c.level !== "ok").map(c => c.text).join(" ")}`.trim(), checks.some(c => c.level === "bad"));
                ui.soaClient = who.value;
                render();
            };
            return el("div", { class: "ins" },
                el("div", { class: "ins-panel" },
                    el("div", { class: "ins-row" }, field("Beneficiary", who), field("Appointment date", appt), field("Time", time), field("Meeting", method)),
                    el("b", { text: "Products the beneficiary agrees to discuss" }), products.map(p => p.label),
                    el("div", { class: "ins-row" }, field("Who asked for the meeting", initiated), field("How they first reached out", firstContact),
                        el("label", { class: "ins-check" }, walkIn, "Unscheduled walk-in")),
                    field("Authorized representative", rep),
                    field("How they sign", signMethod), signBox, field("Notes", notes),
                    el("div", { class: "ins-note", text: ENROLLMENT_NOTES.soa }),
                    el("button", { class: "ins-btn primary", text: "Save signed SOA", "data-action": "save-soa", onclick: save })),
                el("b", { text: "Recent SOAs" }), soaList(store.soas().slice(-20)));
        }

        // ---- commissions ----
        function commissionsSection() {
            const statements = store.statements();
            const box = el("div", { class: "ins" });
            const tolerance = el("input", { type: "number", value: String(store.settings().tolerance), step: "0.01", style: "width: 90px" });
            tolerance.addEventListener("change", () => store.saveSettings({ tolerance: tolerance.value }));
            box.append(el("div", { class: "ins-panel" },
                el("div", { class: "ins-note", text: "Import each carrier's commission statement as CSV (most carrier portals export one; from Excel use Save As › CSV). Set each policy's commission under Clients so CoDev knows what to expect." }),
                el("div", { class: "ins-bar" }, el("button", { class: "ins-btn primary", text: "⬆ Import statement CSV", "data-action": "import-statement", onclick: importStatement }),
                    el("span", { class: "ins-note", text: "Allowed difference $" }), tolerance)));
            if (ui.mapping) box.append(mappingPanel());
            if (statements.length) box.append(el("details", { class: "ins-sub" }, el("summary", { text: `Imported statements (${statements.length})` }),
                el("div", { class: "ins-list" }, statements.slice().reverse().map(s => el("div", { class: "ins-item", style: "cursor: default" },
                    el("div", {}, el("b", { text: `${s.carrier || "Carrier"} · ${s.month || "mixed months"}` }), el("small", { text: `${s.fileName} · ${s.lines.length} lines · ${money(round2(s.lines.reduce((t, l) => t + l.amount, 0)))}` })),
                    el("button", { class: "ins-btn small danger", text: "✕", onclick: async () => { if (await confirmIt(`Remove ${s.fileName}?`)) { store.removeStatement(s.id); ui.recon = null; render(); } } }))))));
            if (!statements.length) return box;
            const r = reconcile(store.clients(), statements, { from: ui.reconFrom, to: ui.reconTo, tolerance: store.settings().tolerance });
            const from = el("input", { type: "month", value: r.from }), to = el("input", { type: "month", value: r.to });
            const rerun = () => { ui.reconFrom = from.value; ui.reconTo = to.value; render(); };
            from.addEventListener("change", rerun); to.addEventListener("change", rerun);
            const showAll = el("input", { type: "checkbox", checked: ui.showPaid });
            showAll.addEventListener("change", () => { ui.showPaid = showAll.checked; render(); });
            const rows = r.rows.filter(x => ui.showPaid || x.status !== "paid");
            box.append(el("div", { class: "ins-panel" },
                el("div", { class: "ins-bar" }, el("b", { text: "Reconciliation" }), field("From", from), field("To", to), el("label", { class: "ins-check" }, showAll, "Show paid too"),
                    el("button", { class: "ins-btn", text: "⬇ Export issues CSV", onclick: () => deps.saveFile && deps.saveFile(`commission-issues-${r.from}-to-${r.to}.csv`, reconcileCsv(r), "text/csv") })),
                el("div", { class: "ins-stats" },
                    [["Expected", money(r.totals.expected)], ["Paid", money(r.totals.paid)], ["Owed to you", money(r.totals.shortfall)], ["Missing", r.totals.missing], ["Short", r.totals.short], ["Chargebacks", r.totals.chargebacks], ["No match", r.totals.unmatched]]
                        .map(([k, v]) => el("div", { class: "ins-stat", "data-stat": k }, el("b", { text: String(v) }), el("span", { text: k })))),
                el("div", { class: "ins-scroll" }, el("table", { class: "ins-table" },
                    el("tr", {}, ["", "Month", "Client", "Carrier / plan", "Policy #", "Expected", "Paid", "Diff"].map(h => el("th", { text: h }))),
                    rows.slice(0, 500).map(x => el("tr", { "data-status": x.status },
                        el("td", {}, el("span", { class: `ins-pill ${x.status}`, text: x.status.replace("_", " ") })),
                        el("td", { text: x.month }), el("td", { text: x.clientName }), el("td", { text: `${x.carrier || ""} ${x.plan}` }), el("td", { text: x.policyNumber || "" }),
                        el("td", { text: money(x.expected) }), el("td", { text: money(x.paid) }), el("td", { text: x.difference == null ? "" : money(x.difference) }))),
                    r.unmatched.slice(0, 200).map(u => el("tr", { "data-status": "unmatched" }, el("td", {}, el("span", { class: "ins-pill unmatched", text: "no match" })),
                        el("td", { text: u.month }), el("td", { text: u.name }), el("td", { text: u.carrier }), el("td", { text: u.policy }), el("td", { text: "" }), el("td", { text: money(u.amount) }), el("td", { text: "" }))))),
                el("div", { class: "ins-note", text: "Missing: nothing paid for an active policy that month. Short: paid less than expected. Chargeback: money taken back. No match: a payment CoDev couldn't tie to a policy (check the policy number on file)." })));
            return box;
        }

        async function importStatement() {
            const text = deps.pickFile ? await deps.pickFile(".csv,.txt,.tsv,text/csv") : null;
            if (!text) return;
            const rows = parseCsv(text);
            // Skip title lines above the header: the header is the first row with 3+ cells and a money-ish column name.
            const headerAt = Math.max(0, rows.findIndex(r => r.length >= 3 && r.some(h => COLUMN_HINTS.amount.test(h))));
            const table = rows.slice(headerAt);
            if (table.length < 2) return say("That file has no rows.", true);
            ui.mapping = { rows: table, map: detectColumns(table[0]), carrier: "", month: "", fileName: "statement.csv" };
            render();
        }
        function mappingPanel() {
            const m = ui.mapping;
            const headers = m.rows[0];
            const opts = [["-1", "(none)"], ...headers.map((h, i) => [String(i), h || `Column ${i + 1}`])];
            const pickers = {};
            const fields = [["policy", "Policy / member #"], ["name", "Insured name"], ["amount", "Commission amount"], ["month", "Date or period"], ["carrier", "Carrier"], ["kind", "Type / description"]];
            const carrier = textInput(m.carrier, { placeholder: "e.g. Humana", "data-field": "stmt-carrier" });
            const month = el("input", { type: "month", value: m.month });
            const preview = el("div", { class: "ins-note" });
            const read = () => Object.fromEntries(fields.map(([k]) => [k, Number(pickers[k].value)]));
            const show = () => {
                const lines = statementLines(m.rows, read(), { month: month.value, carrier: carrier.value });
                preview.textContent = `${lines.length} payment lines, total ${money(round2(lines.reduce((t, l) => t + l.amount, 0)))}. First: ${lines.slice(0, 2).map(l => `${l.name || l.policy} ${money(l.amount)} ${l.month || "(no month)"}`).join("; ")}`;
            };
            for (const [k] of fields) { pickers[k] = select(opts, String(m.map[k])); pickers[k].addEventListener("change", show); }
            month.addEventListener("change", show);
            show();
            return el("div", { class: "ins-panel" }, el("b", { text: "Match the statement's columns" }),
                el("div", { class: "ins-row" }, fields.map(([k, label]) => field(label, pickers[k]))),
                el("div", { class: "ins-row" }, field("Carrier (if the file doesn't say)", carrier), field("Statement month (if lines have no date)", month)),
                preview,
                el("div", { class: "ins-bar" },
                    el("button", { class: "ins-btn primary", text: "Import", "data-action": "confirm-statement", onclick: () => {
                        const map = read();
                        if (map.amount < 0) return say("Pick the column with the commission amount.", true);
                        const r = store.addStatement({ carrier: carrier.value, month: month.value, fileName: m.fileName, lines: statementLines(m.rows, map, { month: month.value, carrier: carrier.value }) });
                        if (r.error) return say(r.error, true);
                        ui.mapping = null;
                        say(`Imported ${r.statement.lines.length} lines.`);
                        render();
                    } }),
                    el("button", { class: "ins-btn", text: "Cancel", onclick: () => { ui.mapping = null; render(); } })));
        }

        // ---- quoting ----
        function quoteSection() {
            const s = store.settings();
            const clientList = store.clients().slice().sort((a, b) => a.name.localeCompare(b.name));
            const box = el("div", { class: "ins" });
            if (clientList.length) {
                const who = select(clientList.map(c => [c.id, c.name]), ui.quoteClient || clientList[0].id);
                const portal = select(s.portals.map((p, i) => [String(i), p.name]), "0");
                const brief = el("div", { class: "ins-brief" });
                const show = () => { ui.quoteClient = who.value; brief.textContent = quoteBrief(store.client(who.value), today()); };
                who.addEventListener("change", show);
                show();
                box.append(el("div", { class: "ins-panel" },
                    el("div", { class: "ins-row" }, field("Client", who), field("Quoting site", portal)),
                    brief,
                    el("div", { class: "ins-bar" },
                        el("button", { class: "ins-btn primary", text: "🤖 Quote with an agent", "data-action": "quote-agent", onclick: () => {
                            if (!s.agentAccess) return say("Turn on \"Let agents use client files\" in 🔒 Privacy first. The agent's AI provider will see this client's details.", true);
                            const c = store.client(who.value);
                            if (deps.askAgent) deps.askAgent(quotePrompt(c, s.portals[Number(portal.value)], today()));
                        } }),
                        el("button", { class: "ins-btn", text: "📋 Copy brief", onclick: async () => { try { await navigator.clipboard.writeText(brief.textContent); say("Copied."); } catch (err) { say("Couldn't copy here; select the text instead.", true); } } }),
                        el("button", { class: "ins-btn", text: "↗ Open site", onclick: () => { const p = s.portals[Number(portal.value)]; if (p) window.open(p.url, "_blank", "noopener"); } })),
                    el("div", { class: "ins-note", text: "The agent opens the site in CoDev's browser (watch it in 🖥️ Live view and sign in there when asked), enters the household, doctors and drugs, compares plans and saves them to the client's file. It never submits an application or signs anything." })));
            } else box.append(el("div", { class: "ins-note", text: "Add a client first; the brief comes from their file." }));
            // The quoting sites list.
            const list = el("div", { class: "ins-list" });
            const rows = s.portals.map(p => ({ ...p }));
            const draw = () => {
                list.textContent = "";
                rows.forEach((p, i) => {
                    const name = textInput(p.name), url = textInput(p.url), note = textInput(p.note);
                    name.addEventListener("input", () => { p.name = name.value; }); url.addEventListener("input", () => { p.url = url.value; }); note.addEventListener("input", () => { p.note = note.value; });
                    list.append(el("div", { class: "ins-row" }, field("Name", name), field("https:// link", url), field("Note", note),
                        el("button", { class: "ins-btn small danger", text: "✕", onclick: () => { rows.splice(i, 1); draw(); } })));
                });
            };
            draw();
            box.append(el("details", { class: "ins-sub" }, el("summary", { text: `Your quoting sites (${s.portals.length})` }),
                el("div", { class: "ins-note", text: "CoDev doesn't include Sunfire, HealthSherpa or Quotit: those come with your own agent accounts and FMO contracts. Add your FMO's links and carrier portals here." }),
                list,
                el("div", { class: "ins-bar" }, el("button", { class: "ins-btn small", text: "+ Add site", onclick: () => { rows.push({ name: "", url: "https://", note: "" }); draw(); } }),
                    el("button", { class: "ins-btn small primary", text: "Save sites", onclick: () => { store.saveSettings({ portals: rows }); say("Saved. Links must start with https://."); render(); } }))));
            return box;
        }

        // ---- privacy ----
        function privacySection() {
            const s = store.settings();
            const agentName = textInput(s.agentName), npn = textInput(s.npn), agency = textInput(s.agency);
            const access = el("input", { type: "checkbox", checked: s.agentAccess, "data-field": "agent-access" });
            access.addEventListener("change", async () => {
                if (access.checked && !(await confirmIt("Agents will send the client details they need to your AI provider (Groq, OpenRouter or Anthropic) to answer. Most AI providers don't sign a HIPAA business associate agreement on these plans. Turn it on?"))) { access.checked = false; return; }
                store.saveSettings({ agentAccess: access.checked });
                say(access.checked ? "Agents can now read and update client files." : "Agents can't see client files.");
            });
            const p1 = el("input", { type: "password", placeholder: "New passphrase (8+ characters)", autocomplete: "new-password", "data-field": "pass1" });
            const p2 = el("input", { type: "password", placeholder: "Type it again", autocomplete: "new-password", "data-field": "pass2" });
            return el("div", { class: "ins" },
                el("div", { class: "ins-panel" }, el("b", { text: "You (printed on SOAs)" }),
                    el("div", { class: "ins-row" }, field("Agent name", agentName), field("NPN", npn), field("Agency", agency)),
                    el("button", { class: "ins-btn", text: "Save", onclick: () => { store.saveSettings({ agentName: agentName.value, npn: npn.value, agency: agency.value }); say("Saved."); } })),
                el("div", { class: "ins-panel" }, el("b", { text: store.isEncrypted() ? "🔐 Encrypted with your passphrase" : "🔓 Not encrypted" }),
                    el("div", { class: "ins-note", text: "With a passphrase, clients, SOAs, statements and documents are encrypted on this device (AES-256) and the desk locks after 15 minutes idle. CoDev can't recover a forgotten passphrase, so keep it somewhere safe and export backups." }),
                    el("div", { class: "ins-row" }, p1, p2),
                    el("div", { class: "ins-bar" },
                        el("button", { class: "ins-btn primary", text: store.isEncrypted() ? "Change passphrase" : "Encrypt with passphrase", "data-action": "set-pass", onclick: async () => {
                            if (p1.value !== p2.value) return say("The two passphrases don't match.", true);
                            say("Encrypting…");
                            const r = await store.setPassphrase(p1.value);
                            say(r.error || "Encrypted. You'll need this passphrase to open the desk.", Boolean(r.error));
                            if (!r.error) render();
                        } }),
                        store.isEncrypted() ? el("button", { class: "ins-btn danger", text: "Remove encryption", onclick: async () => {
                            if (!(await confirmIt("Store client files unencrypted on this device?"))) return;
                            await store.removePassphrase(); say("Encryption removed."); render();
                        } }) : null)),
                el("div", { class: "ins-panel" }, el("b", { text: "Agents" }),
                    el("label", { class: "ins-check" }, access, "Let agents use client files (look up, update, quote, check commissions)"),
                    el("div", { class: "ins-note", text: "Off by default. When on, the agents get the insurance_* tools for insurance requests, and the client details they read go to your AI provider. Agents can't delete records, sign SOAs or submit applications." })),
                el("div", { class: "ins-panel" }, el("b", { text: "Backup" }),
                    el("div", { class: "ins-note", text: "One file with every client, SOA, statement and document. Encrypted with your passphrase when one is set. Restoring replaces what's on this device." }),
                    el("div", { class: "ins-bar" },
                        el("button", { class: "ins-btn", text: "⬇ Export backup", onclick: async () => {
                            try { deps.saveFile && deps.saveFile(`insurance-desk-backup-${today()}.json`, await store.exportBackup(), "application/json"); } catch (err) { say(err.message, true); }
                        } }),
                        el("button", { class: "ins-btn", text: "⬆ Restore backup", onclick: async () => {
                            const text = deps.pickFile ? await deps.pickFile(".json,application/json") : null;
                            if (!text) return;
                            if (!(await confirmIt("Replace everything in the Insurance Desk on this device with this backup?"))) return;
                            let r = await store.importBackup(text);
                            if (r.needsPassphrase) {
                                const pass = deps.prompt ? await deps.prompt("This backup is encrypted. Its passphrase:") : "";
                                r = await store.importBackup(text, pass || "");
                            }
                            say(r.error || `Restored ${r.clients} clients.`, Boolean(r.error));
                            if (!r.error) render();
                        } }))),
                el("div", { class: "ins-note", text: "HIPAA: keep this device locked with a screen lock, don't share its login, and use the passphrase. CoDev doesn't send client files anywhere unless you export them or turn on agent access." }));
        }

        // ---- client CSV in and out ----
        const CSV_COLUMNS = [["name", /^(full\s*)?name$|client|insured/i], ["firstName", /^first/i], ["lastName", /^last/i], ["phone", /phone|mobile|cell/i], ["email", /e-?mail/i],
            ["dob", /dob|birth/i], ["address", /address|street/i], ["city", /city/i], ["state", /^state$|^st$/i], ["zip", /zip|postal/i], ["county", /county/i],
            ["carrier", /carrier/i], ["planType", /plan\s*type|product|line/i], ["planName", /plan(\s*name)?$/i], ["policyNumber", /policy|member\s*id/i], ["effectiveDate", /effective/i], ["premium", /premium/i], ["status", /status/i]];
        async function importClientsCsv() {
            const text = deps.pickFile ? await deps.pickFile(".csv,text/csv") : null;
            if (!text) return;
            const rows = parseCsv(text);
            if (rows.length < 2) return say("That file has no rows.", true);
            const idx = {};
            rows[0].forEach((h, i) => { const hit = CSV_COLUMNS.find(([k, re]) => idx[k] === undefined && re.test(h)); if (hit) idx[hit[0]] = i; });
            const typeFor = t => { const s = String(t || "").toLowerCase(); return (PLAN_TYPES.find(([k, l]) => s === k || s.includes(l.toLowerCase())) || [s.includes("supp") || s.includes("medigap") ? "medsupp" : s.includes("advantage") ? "ma" : s.includes("part d") ? "pdp" : s.includes("aca") || s.includes("obamacare") ? "aca" : s.includes("life") ? "term" : "other"])[0]; };
            let added = 0, updated = 0, skipped = 0;
            for (const r of rows.slice(1)) {
                const get = k => (idx[k] === undefined ? "" : r[idx[k]] || "");
                const name = get("name") || [get("firstName"), get("lastName")].filter(Boolean).join(" ");
                if (!name.trim()) { skipped++; continue; }
                const status = get("status").toLowerCase();
                const saved = store.saveClient({ name, phone: get("phone"), email: get("email"), dob: get("dob"), address: get("address"), city: get("city"), state: get("state"), zip: get("zip"), county: get("county"),
                    status: CLIENT_STATUS.some(([k]) => k === status) ? status : undefined });
                if (!saved.client) { skipped++; continue; }
                if (saved.created) added++; else updated++;
                if (get("carrier") || get("policyNumber") || get("planType")) {
                    const exists = get("policyNumber") && saved.client.policies.some(p => norm(p.policyNumber) === norm(get("policyNumber")));
                    if (!exists) store.savePolicy(saved.client.id, { planType: typeFor(get("planType")), carrier: get("carrier"), planName: get("planName"), policyNumber: get("policyNumber"), effectiveDate: get("effectiveDate"), premium: get("premium"), status: "active" });
                }
            }
            say(`Imported: ${added} new, ${updated} updated${skipped ? `, ${skipped} rows skipped (no name)` : ""}.`);
            render();
        }
        function exportClientsCsv() {
            const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
            const head = ["Name", "Status", "DOB", "Phone", "Email", "Address", "City", "State", "ZIP", "County", "Plan type", "Carrier", "Plan", "Policy #", "Policy status", "Effective", "Premium"];
            const lines = [head.map(q).join(",")];
            for (const c of store.clients()) {
                const base = [c.name, c.status, c.dob, c.phone, c.email, c.address, c.city, c.state, c.zip, c.county];
                if (!c.policies.length) lines.push([...base, "", "", "", "", "", "", ""].map(q).join(","));
                for (const p of c.policies) lines.push([...base, PLAN_LABEL[p.planType], p.carrier, p.planName, p.policyNumber, p.status, p.effectiveDate, p.premium].map(q).join(","));
            }
            if (deps.saveFile) deps.saveFile(`insurance-clients-${today()}.csv`, lines.join("\n"), "text/csv");
        }

        const off = store.onChange(() => { if (!root.isConnected) off(); });
        render();
        return { refresh: render, open(section) { if (SECTIONS.some(s => s.id === section)) ui.section = section; render(); }, root };
    }

    return {
        STORE_KEY, PLAN_TYPES, SOA_PRODUCTS, ENROLLMENT_NOTES, DEFAULT_PORTALS,
        createDeskStore, memoryDocs, indexedDbDocs,
        parseDate, parseMonth, addMonths, ageOn, iepWindow,
        computeAlerts, alertsToIcs, soaChecks, verifySoa, soaHtml,
        parseCsv, detectColumns, statementLines, expectedForMonth, reconcile, reconcileCsv,
        quoteBrief, quotePrompt, isDeskTask, deskPromptBlock, buildDeskTools, describeClient,
        mount
    };
});
