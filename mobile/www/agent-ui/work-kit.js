// Work kit: one-tap actions for everyday work, and a privacy check before anything is sent.
//
//   CodevWorkKit.KITS                       ready-made actions by kind of work
//   CodevWorkKit.actionsFor(professionId)   the user's field actions first, then everyday office ones
//   CodevWorkKit.buildPrompt(action, pasted, extra)   the message an action sends
//   CodevWorkKit.findSensitive(text)        SSNs, card and bank numbers, tax IDs, birth dates,
//                                           Medicare and member IDs in a message
//   CodevWorkKit.maskSensitive(text)        the same message with each of them replaced
//   CodevWorkKit.createWorkKit(deps)        { actions(), saveCustom(), removeCustom(), open(), mount(button) }
//   CodevWorkKit.createPrivacyGuard(deps)   { enabled(), setEnabled(on), review(text) -> Promise<{ send, text }> }
//
// Why: someone who uses CoDev at work pastes the same kinds of things all day (a customer
// email, call notes, a plan summary). An action asks for the paste in a big box (the chat bar
// is one line) and wraps it in a prompt written for that job, so the work takes one tap
// instead of retyping instructions. The privacy check catches customer details that
// shouldn't go to an AI provider before they leave the device; it never sends anything itself.
//
// Everything typed by the user is set with textContent. The same file runs in the page and
// in Node (tests), like expert-coach.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevWorkKit = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const KEYS = { custom: "codev_work_kit_custom", guard: "codev_privacy_guard" };
    const MAX_CUSTOM = 30;
    const MAX_PASTE = 60000;

    // An action: id, label, what to paste (ask), and the instructions sent with the paste.
    // {extra} is the optional "anything else" line, left out when empty.
    const KITS = {
        benefits: { name: "Benefits and health insurance", actions: [
            { id: "ben-reply", label: "✉️ Reply to a client or employee", ask: "Paste their email or chat message", prompt: "Draft a reply to this message from a client or employee about their benefits. Answer what they actually asked in plain words, be warm and brief, give the next step and any deadline, and don't promise coverage: where the answer depends on the plan, say what to check (SBC, carrier, plan documents). Flag anything I should confirm before sending. Keep any personal details out of the reply unless they're needed." },
            { id: "ben-explain", label: "📄 Explain a plan in plain words", ask: "Paste the plan summary, SBC text or the plan details", prompt: "Explain this health plan in plain words for an employee who isn't an insurance person: what they pay each paycheck if it's given, then the deductible, copays and coinsurance, the out-of-pocket max, the network type and what that means for picking doctors. Add a short example of a doctor visit and a hospital stay. Only use numbers that are in the text; say which ones are missing." },
            { id: "ben-compare", label: "⚖️ Compare plans side by side", ask: "Paste the plan options (or attach the rate sheet with 📎)", prompt: "Compare these plans side by side in a table: monthly premium (employee and employer share if given), deductible, out-of-pocket max, copays, coinsurance, network, HSA eligibility. Then show the yearly cost for a light, a typical and a heavy user, and say which kind of person each plan suits. Do the math exactly and only from the numbers given." },
            { id: "ben-qle", label: "👶 Life event: what happens next", ask: "Describe the life event (marriage, baby, move, lost coverage...) and the plan type", prompt: "Someone had a qualifying life event. Lay out what happens next: whether it's likely a qualifying event, the enrollment window they have (employer plans must allow at least 30 days; the Marketplace allows 60), what documents they usually need, when coverage would start, and the exact steps in order. Say what depends on the plan or state and should be checked with the carrier." },
            { id: "ben-oe", label: "🗓️ Open enrollment checklist", ask: "Paste what you know: company size, state, plans offered, dates", prompt: "Make an open enrollment checklist for this company with dates counted back from the deadline: what to send employees and when, reminders, waivers to collect, carrier participation minimums to watch, and the follow-ups after enrollment closes. Also write the short announcement email to employees." },
            { id: "ben-cobra", label: "🧾 COBRA or termination question", ask: "Paste the question and what you know (company size, state, dates)", prompt: "Answer this COBRA or termination question. Say whether federal COBRA likely applies (20 or more employees) or a state continuation law might, the usual notice and election timelines, what the person pays, and what I should confirm with compliance or the carrier. Be clear about what's general guidance versus what depends on the plan or state." },
            { id: "ben-note", label: "🗒️ Call notes → case note", ask: "Paste your rough call or chat notes", prompt: "Turn these rough notes into a clean case note: who, the issue, what was explained, what was promised, next steps with owners and dates, and anything to escalate. Short bullet points. Then list any open questions. Replace SSNs, birth dates and health details with [hidden] if any are still in the notes." },
            { id: "ben-check", label: "✅ Check my reply before I send it", ask: "Paste the reply you wrote", prompt: "Review this reply I wrote to a client or employee about benefits. Check it for accuracy risks (promising coverage, wrong deadlines, numbers that need confirming), unclear wording, tone and anything that shares personal or health details it shouldn't. Give me the corrected version, then a short list of what you changed and why." }
        ] },
        insurance: { name: "Insurance agent", actions: [
            { id: "ins-reply", label: "✉️ Reply to a client", ask: "Paste the client's message", prompt: "Draft a reply to this insurance client. Answer what they asked in plain words, give the next step, and never promise coverage the policy doesn't spell out; say what to check with the carrier where it depends on the policy." },
            { id: "ins-explain", label: "📄 Explain a policy simply", ask: "Paste the policy or plan details", prompt: "Explain this policy in plain words: what it covers, what it doesn't, what it costs and when, and the terms a client usually misunderstands. Only use facts in the text." },
            { id: "ins-note", label: "🗒️ Call notes → client note", ask: "Paste your rough notes", prompt: "Turn these notes into a clean client note: needs, what was discussed, products considered, compliance steps done, next steps and dates." }
        ] },
        support: { name: "Customer support", actions: [
            { id: "sup-reply", label: "✉️ Draft a ticket reply", ask: "Paste the customer's message (and any notes)", prompt: "Draft a reply to this support ticket. Acknowledge the issue in one line, solve it or give clear numbered steps, set expectations on timing, and close kindly. Don't promise anything that isn't in my notes; mark anything I need to confirm with [check]." },
            { id: "sup-deescalate", label: "🧯 Calm an upset customer", ask: "Paste the upset message", prompt: "This customer is upset. Draft a calm, sincere reply that names their frustration without being defensive, says exactly what happens next and when, and offers one concrete thing. No corporate filler." },
            { id: "sup-summary", label: "📌 Summarize a long thread", ask: "Paste the whole ticket or email thread", prompt: "Summarize this ticket thread for a handoff: the customer's issue, what's been tried, what was promised, the current status and the next step. Five bullets at most." },
            { id: "sup-article", label: "📚 Turn a fix into a help article", ask: "Paste how you solved it", prompt: "Turn this fix into a short help article: a clear title, who it's for, numbered steps, and what to do if it doesn't work." }
        ] },
        office: { name: "Everyday work", actions: [
            { id: "off-reply", label: "✉️ Draft an email reply", ask: "Paste the email you got", prompt: "Draft a reply to this email. Match its tone, answer every question it asks, keep it short, and end with a clear next step. Give me a subject line if it needs a new one." },
            { id: "off-summary", label: "📌 Summarize this", ask: "Paste the email thread, document or chat", prompt: "Summarize this in five bullets or fewer: the main point, decisions made, what's being asked of me, and deadlines. Then one line on what I should do first." },
            { id: "off-actions", label: "🧑‍🤝‍🧑 Meeting notes → action items", ask: "Paste your meeting notes or the transcript", prompt: "Turn these meeting notes into: a three-line summary, decisions made, and a table of action items with owner and due date (write \"unassigned\" or \"no date\" where it's missing). Then draft a short follow-up message to the attendees." },
            { id: "off-rewrite", label: "✍️ Make this clearer", ask: "Paste what you wrote", prompt: "Rewrite this so it's clear, friendly and professional, about a third shorter, without changing what it says. Then give one even shorter version for chat." },
            { id: "off-checklist", label: "☑️ Turn steps into a checklist", ask: "Paste the process, SOP or instructions", prompt: "Turn this into a numbered checklist I can follow while working, with any warnings or deadlines called out. Keep each step to one line." },
            { id: "off-sheet", label: "📊 Help with a spreadsheet", ask: "Describe what you need (or attach the file with 📎)", prompt: "Help with this spreadsheet task. Give me the exact formula or steps for Google Sheets and Excel, explain it in one line, and show an example with made-up numbers." },
            { id: "off-plan", label: "🗂️ Plan my day", ask: "Paste your to-do list, meetings and deadlines", prompt: "Plan my workday from this list: put the deadline and high-impact tasks first, group small tasks, leave breaks, and give me a time-blocked schedule. Flag anything that won't fit and what to push." }
        ] }
    };

    // Which kit a profession playbook gets, ahead of the everyday office actions.
    const KIT_FOR = { benefits: "benefits", insurance: "insurance", support: "support", hr: "benefits", admin: "office" };

    function actionsFor(professionId, custom = []) {
        const kit = KIT_FOR[professionId];
        const own = kit && kit !== "office" ? KITS[kit].actions.map(a => ({ ...a, kit })) : [];
        return [...custom.map(a => ({ ...a, kit: "custom" })), ...own, ...KITS.office.actions.map(a => ({ ...a, kit: "office" }))];
    }

    function buildPrompt(action, pasted, extra) {
        const text = String(pasted || "").slice(0, MAX_PASTE).trim();
        const more = String(extra || "").trim();
        return [action.prompt, more ? `Also: ${more}` : "", text ? `---\n${text}\n---` : ""].filter(Boolean).join("\n\n");
    }

    // ---- Privacy check ----

    // Luhn, for card numbers; the ABA checksum, for bank routing numbers.
    function luhn(digits) {
        let sum = 0;
        for (let i = 0; i < digits.length; i++) {
            let d = +digits[digits.length - 1 - i];
            if (i % 2) { d *= 2; if (d > 9) d -= 9; }
            sum += d;
        }
        return sum % 10 === 0;
    }
    function abaOk(d) {
        if (!/^\d{9}$/.test(d)) return false;
        const n = d.split("").map(Number);
        return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
    }

    // Each check: kind, label for the user, the mask, and a pattern; ok() filters false alarms.
    const MBI_L = "[AC-HJKMNP-RT-Y]";
    const CHECKS = [
        { kind: "ssn", label: "Social Security number", mask: "[SSN hidden]", re: /\b(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}\b/g },
        { kind: "ssn", label: "Social Security number", mask: "[SSN hidden]", re: /\b(?:ssn|social security(?: number| no\.?| #)?|ss#)\s*[:#]?\s*(\d{9})\b/gi, group: 1 },
        { kind: "card", label: "card number", mask: "[card number hidden]", re: /\b(?:\d[ -]?){12,18}\d\b/g, ok: m => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d); } },
        { kind: "routing", label: "bank routing number", mask: "[routing number hidden]", re: /\b(?:routing|aba|rtn)(?:\s*(?:number|no\.?|#))?\s*[:#]?\s*(\d{9})\b/gi, group: 1, ok: m => abaOk(m) },
        { kind: "account", label: "bank account number", mask: "[account number hidden]", re: /\b(?:account|acct)(?:\s*(?:number|no\.?|#))?\s*[:#]?\s*(\d[\d -]{4,18}\d)\b/gi, group: 1, ok: m => m.replace(/\D/g, "").length >= 6 },
        { kind: "ein", label: "tax ID (EIN)", mask: "[EIN hidden]", re: /\b(?:ein|fein|tax id|tin)\s*[:#]?\s*(\d{2}-?\d{7})\b/gi, group: 1 },
        { kind: "ein", label: "tax ID (EIN)", mask: "[EIN hidden]", re: /\b\d{2}-\d{7}\b/g },
        { kind: "dob", label: "date of birth", mask: "[birth date hidden]", re: /\b(?:dob|d\.o\.b\.?|date of birth|birth ?date|born(?: on)?)\s*[:#]?\s*((?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})|(?:\d{4}-\d{2}-\d{2})|(?:[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}))/gi, group: 1 },
        { kind: "mbi", label: "Medicare number", mask: "[Medicare number hidden]", re: new RegExp(`\\b[1-9]${MBI_L}[${MBI_L.slice(1, -1)}0-9]\\d-?${MBI_L}[${MBI_L.slice(1, -1)}0-9]\\d-?${MBI_L}{2}\\d{2}\\b`, "g") },
        { kind: "member", label: "member or policy ID", mask: "[member ID hidden]", re: /\b(?:member|subscriber|policy|group)\s*(?:id|number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,19})\b/gi, group: 1, ok: m => /\d/.test(m) }
    ];

    // Every sensitive item in the text, without overlaps, in order.
    function findSensitive(text) {
        const s = String(text || "");
        const found = [];
        for (const check of CHECKS) {
            check.re.lastIndex = 0;
            let m;
            while ((m = check.re.exec(s))) {
                const value = check.group ? m[check.group] : m[0];
                const start = check.group ? m.index + m[0].lastIndexOf(value) : m.index;
                if (check.ok && !check.ok(value)) continue;
                const end = start + value.length;
                if (found.some(f => start < f.end && end > f.start)) continue;
                found.push({ kind: check.kind, label: check.label, mask: check.mask, start, end, value });
            }
        }
        return found.sort((a, b) => a.start - b.start);
    }

    function maskSensitive(text) {
        const s = String(text || "");
        const found = findSensitive(s);
        let out = "";
        let at = 0;
        for (const f of found) { out += s.slice(at, f.start) + f.mask; at = f.end; }
        return { text: out + s.slice(at), count: found.length, kinds: [...new Set(found.map(f => f.label))] };
    }

    // "123-45-6789" -> "•••-••-6789": enough for the user to recognise it.
    const hint = value => value.replace(/[A-Za-z0-9](?=(?:[^A-Za-z0-9]*[A-Za-z0-9]){4})/g, "•");

    // ---- Shared DOM helpers ----

    function el(doc, tag, props = {}, children = []) {
        const node = doc.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (k === "style") node.style.cssText = v;
            else if (k === "text") node.textContent = v;
            else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        }
        for (const c of [].concat(children)) if (c) node.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
        return node;
    }

    // A modal on the page's own overlay styles; closes on the backdrop or Escape.
    function modal(doc, id, title, width = 560) {
        const old = doc.getElementById(id);
        if (old) old.remove();
        const box = el(doc, "div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title, style: `width: ${width}px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); overflow-y: auto;` });
        const overlay = el(doc, "div", { class: "modal-overlay", id, style: "display: flex; z-index: 1200;" }, [box]);
        const close = () => { overlay.remove(); doc.removeEventListener("keydown", onKey); };
        const onKey = e => { if (e.key === "Escape") close(); };
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
        doc.addEventListener("keydown", onKey);
        doc.body.appendChild(overlay);
        return { overlay, box, close };
    }

    function readJson(storage, key, fallback) {
        try { const v = JSON.parse(storage.getItem(key) || "null"); return v == null ? fallback : v; } catch (err) { return fallback; }
    }
    function writeJson(storage, key, value) {
        try { storage.setItem(key, JSON.stringify(value)); return true; } catch (err) { return false; }
    }

    // ---- Work kit ----

    // deps: storage, document, professionId() (the user's playbook id or ""), send(text)
    // (sends a message to the agents), attach() optional (opens the 📎 picker).
    function createWorkKit(deps = {}) {
        const storage = deps.storage;
        const doc = deps.document || (typeof document !== "undefined" ? document : null);

        const custom = () => readJson(storage, KEYS.custom, []).filter(a => a && a.label && a.prompt).slice(0, MAX_CUSTOM);
        function saveCustom({ label, prompt, ask }) {
            const l = String(label || "").trim().slice(0, 60);
            const p = String(prompt || "").trim().slice(0, 2000);
            if (!l || !p) return { error: "Give it a name and say what it should do." };
            const list = custom();
            if (list.length >= MAX_CUSTOM) return { error: `You can keep up to ${MAX_CUSTOM} of your own.` };
            const action = { id: `my-${Date.now().toString(36)}`, label: `⭐ ${l.replace(/^⭐\s*/, "")}`, ask: String(ask || "").trim().slice(0, 120) || "Paste what it should work on", prompt: p };
            list.unshift(action);
            writeJson(storage, KEYS.custom, list);
            return { action };
        }
        function removeCustom(id) { writeJson(storage, KEYS.custom, custom().filter(a => a.id !== id)); }
        const actions = () => actionsFor(deps.professionId ? deps.professionId() : "", custom());

        function open() {
            if (!doc) return null;
            const { box, close } = modal(doc, "workKitModal", "Work kit");
            const head = el(doc, "h3", { style: "display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0;" }, ["💼 Work kit", el(doc, "button", { class: "btn-secondary", type: "button", text: "Close", onclick: close })]);
            const body = el(doc, "div", { style: "display: flex; flex-direction: column; gap: 10px;" });
            box.append(head, body);
            const id = deps.professionId ? deps.professionId() : "";
            const kit = KITS[KIT_FOR[id]];

            function showList() {
                body.replaceChildren();
                body.appendChild(el(doc, "div", { style: "font-size: 0.82rem; color: var(--text-muted); line-height: 1.5;", text: `Pick a job, paste the text, and the agents do it.${kit && KIT_FOR[id] !== "office" ? ` Your ${kit.name.toLowerCase()} actions are first.` : " Set your field in ⚙️ Settings > 🎓 Your field & level to get actions for your job."} Only paste work info your employer allows you to use with AI tools.` }));
                const grid = el(doc, "div", { style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px;" });
                for (const a of actions()) {
                    const btn = el(doc, "button", { type: "button", class: "btn-secondary work-kit-action", "data-id": a.id, style: "text-align: left; padding: 10px; border-radius: 8px; font-size: 0.85rem; line-height: 1.3; cursor: pointer;", onclick: () => showAction(a) });
                    btn.textContent = a.label;
                    grid.appendChild(btn);
                }
                body.appendChild(grid);
                body.appendChild(el(doc, "button", { type: "button", class: "btn-secondary", id: "workKitAddOwn", style: "padding: 10px; border-radius: 8px;", text: "➕ Save one of my own (for something you do every day)", onclick: showAdd }));
            }

            function showAction(a) {
                body.replaceChildren();
                const paste = el(doc, "textarea", { id: "workKitPaste", rows: "9", placeholder: a.ask, style: "width: 100%; box-sizing: border-box; font-family: inherit; background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px; font-size: 16px; resize: vertical;" });
                const extra = el(doc, "input", { id: "workKitExtra", type: "text", placeholder: "Anything else? (optional, e.g. \"keep it under 100 words\")", style: "width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); font-size: 16px;" });
                const status = el(doc, "div", { style: "font-size: 0.8rem; color: var(--warning); min-height: 1em;" });
                const run = el(doc, "button", { type: "button", class: "send-btn", id: "workKitRun", style: "padding: 12px; border-radius: 8px; border: none; background: var(--accent); color: var(--bg-dark); font-weight: bold; cursor: pointer;", text: "Do it ▶", onclick: () => {
                    if (!paste.value.trim() && !extra.value.trim()) { status.textContent = "Paste something first (or attach a file with 📎 and say what it is)."; paste.focus(); return; }
                    close();
                    deps.send(buildPrompt(a, paste.value, extra.value));
                } });
                const row = [el(doc, "button", { type: "button", class: "btn-secondary", text: "← Back", style: "padding: 10px; border-radius: 8px;", onclick: showList })];
                if (deps.attach) row.push(el(doc, "button", { type: "button", class: "btn-secondary", text: "📎 Attach a file", style: "padding: 10px; border-radius: 8px;", onclick: () => deps.attach() }));
                if (a.kit === "custom") row.push(el(doc, "button", { type: "button", class: "btn-secondary", text: "🗑️ Remove", style: "padding: 10px; border-radius: 8px;", onclick: () => { removeCustom(a.id); showList(); } }));
                body.append(el(doc, "div", { style: "font-weight: bold;", text: a.label }), paste, extra, status,
                    el(doc, "div", { style: "display: flex; gap: 8px; flex-wrap: wrap;" }, [...row, run]));
                paste.focus();
            }

            function showAdd() {
                body.replaceChildren();
                const field = (id, label, tag, attrs) => el(doc, "div", { class: "form-group" }, [el(doc, "label", { for: id, text: label }), el(doc, tag, { id, ...attrs, style: "width: 100%; box-sizing: border-box; font-family: inherit; font-size: 16px; padding: 10px; border-radius: 8px; background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color);" })]);
                const status = el(doc, "div", { style: "font-size: 0.8rem; color: var(--warning); min-height: 1em;" });
                body.append(
                    el(doc, "div", { style: "font-size: 0.82rem; color: var(--text-muted);", text: "Write the instructions once, the way you'd explain the job to a new coworker. Next time it's one tap: paste and go." }),
                    field("workKitOwnLabel", "Name", "input", { type: "text", placeholder: "e.g. Weekly status email" }),
                    field("workKitOwnPrompt", "What should the agent do with what you paste?", "textarea", { rows: "5", placeholder: "e.g. Turn my notes into our weekly status email: wins, blockers, next week. Friendly, under 150 words." }),
                    field("workKitOwnAsk", "What will you paste? (optional)", "input", { type: "text", placeholder: "e.g. Paste this week's notes" }),
                    status,
                    el(doc, "div", { style: "display: flex; gap: 8px;" }, [
                        el(doc, "button", { type: "button", class: "btn-secondary", text: "← Back", style: "padding: 10px; border-radius: 8px;", onclick: showList }),
                        el(doc, "button", { type: "button", id: "workKitOwnSave", style: "flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--accent); color: var(--bg-dark); font-weight: bold; cursor: pointer;", text: "💾 Save", onclick: () => {
                            const r = saveCustom({ label: doc.getElementById("workKitOwnLabel").value, prompt: doc.getElementById("workKitOwnPrompt").value, ask: doc.getElementById("workKitOwnAsk").value });
                            if (r.error) status.textContent = r.error; else showList();
                        } })
                    ]));
            }

            showList();
            return { close };
        }

        function mount(button) {
            if (!button) return null;
            button.addEventListener("click", open);
            return { refresh() {} };
        }

        return { actions, saveCustom, removeCustom, open, mount };
    }

    // ---- Privacy guard ----

    // deps: storage, document. review(text) resolves { send: false } when the user cancels,
    // or { send: true, text } with the text they chose (masked or as typed).
    function createPrivacyGuard(deps = {}) {
        const storage = deps.storage;
        const doc = deps.document || (typeof document !== "undefined" ? document : null);
        const enabled = () => { try { return storage.getItem(KEYS.guard) !== "0"; } catch (err) { return true; } };
        const setEnabled = on => { try { storage.setItem(KEYS.guard, on ? "1" : "0"); } catch (err) { /* private mode */ } };

        function review(text) {
            const found = enabled() ? findSensitive(text) : [];
            if (!found.length || !doc) return Promise.resolve({ send: true, text });
            return new Promise(resolve => {
                const { box, close } = modal(doc, "privacyGuardModal", "Private details found", 480);
                let done = false;
                const finish = result => { if (done) return; done = true; close(); resolve(result); };
                // Closing any other way (backdrop, Escape) is a cancel.
                const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(() => { if (!box.isConnected) { observer.disconnect(); finish({ send: false }); } }) : null;
                if (observer) observer.observe(doc.body, { childList: true });
                const list = el(doc, "ul", { style: "margin: 0; padding-left: 20px; font-size: 0.85rem; line-height: 1.6;" });
                for (const f of found.slice(0, 8)) list.appendChild(el(doc, "li", { text: `${f.label}: ${hint(f.value)}` }));
                if (found.length > 8) list.appendChild(el(doc, "li", { text: `and ${found.length - 8} more` }));
                const btn = (id, text, primary, onclick) => el(doc, "button", { type: "button", id, text, onclick, class: primary ? "" : "btn-secondary",
                    style: `padding: 12px; border-radius: 8px; font-weight: bold; cursor: pointer; ${primary ? "border: none; background: var(--accent); color: var(--bg-dark);" : ""}` });
                box.append(
                    el(doc, "h3", { style: "margin: 0;", text: "🔒 This message has private details" }),
                    el(doc, "div", { style: "font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;", text: "Anything you send goes to the AI provider (Anthropic, Groq or OpenRouter). Customer and employee details like these usually shouldn't, and many employers don't allow it. CoDev can hide them and the agents can still do the job." }),
                    list,
                    el(doc, "div", { style: "display: flex; flex-direction: column; gap: 8px;" }, [
                        btn("privacyMask", "Hide them and send (recommended)", true, () => finish({ send: true, text: maskSensitive(text).text })),
                        btn("privacySendAnyway", "Send as is: these are mine or I'm allowed", false, () => finish({ send: true, text })),
                        btn("privacyCancel", "Cancel and edit", false, () => finish({ send: false }))
                    ]),
                    el(doc, "div", { style: "font-size: 0.75rem; color: var(--text-muted);", text: "Turn this check off in ⚙️ Settings > 🔒 Privacy check." }));
                doc.getElementById("privacyMask").focus();
            });
        }

        // Settings > 🔒 Privacy check.
        function mountSettings(details) {
            if (!details || !doc) return null;
            details.replaceChildren();
            const box = el(doc, "input", { type: "checkbox", id: "privacyGuardOn" });
            box.checked = enabled();
            box.addEventListener("change", () => setEnabled(box.checked));
            details.append(el(doc, "summary", { text: "🔒 Privacy check" }),
                el(doc, "div", { style: "font-size: 0.8rem; color: var(--text-muted);", text: "Before a message goes to the AI provider, CoDev looks for Social Security numbers, card and bank numbers, tax IDs (EIN), birth dates, Medicare numbers and member or policy IDs, and offers to hide them. It runs on this device only and catches the common formats, not everything: you're still the judge of what your employer allows." }),
                el(doc, "label", { class: "checkbox-group" }, [box, " Check my messages for private details before sending"]));
            return { refresh: () => { box.checked = enabled(); } };
        }

        return { enabled, setEnabled, review, mountSettings };
    }

    return { KEYS, KITS, KIT_FOR, actionsFor, buildPrompt, findSensitive, maskSensitive, createWorkKit, createPrivacyGuard, el, modal };
});
