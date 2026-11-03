// Tester kit: a friendly first-run setup for people who aren't technical, and a feedback form
// testers can send back in a tap.
//
//   CodevTesterKit.ROLES                    the "what do you do?" choices and the playbook each saves
//   CodevTesterKit.feedbackText(entry, info)  the feedback as plain text, ready to send
//   CodevTesterKit.createWelcome(deps)      { shouldShow(), open(), markDone() }
//   CodevTesterKit.createFeedback(deps)     { open(), entries(), mount(button) }
//
// The welcome is three short steps: what you do (so agents work in your field from the first
// message), connect the AI (skipped when this copy already has a key), and what to try. It
// shows once, never in automated browsers (tests, the cloud runner), and Settings can open it
// again. Feedback stays on this device until the tester sends it with their phone's share
// sheet, email or copy and paste: there is no server.
//
// Everything typed by the user is set with textContent. The same file runs in the page and
// in Node (tests).
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(root.CodevWorkKit || (typeof require === "function" ? require("./work-kit.js") : null));
    else root.CodevTesterKit = factory(root.CodevWorkKit);
})(typeof self !== "undefined" ? self : this, function (WorkKit) {
    "use strict";

    const KEYS = { welcomeDone: "codev_welcome_done", feedback: "codev_tester_feedback", testerName: "codev_tester_name" };
    const MAX_FEEDBACK = 50;
    const { el, modal } = WorkKit;

    // profession: what's saved as the user's profession (it picks the playbook and the Work kit).
    const ROLES = [
        { id: "benefits", label: "🩺 Health insurance & benefits (at a company)", profession: "Employee benefits and health insurance advisor" },
        { id: "insurance", label: "🛡️ Insurance agent (my own clients)", profession: "Insurance agent" },
        { id: "support", label: "🎧 Customer support", profession: "Customer service and support" },
        { id: "office", label: "💼 Office or remote work", profession: "Remote office work" },
        { id: "software", label: "💻 Coding", profession: "Software developer" },
        { id: "student", label: "📚 School", profession: "Student" },
        { id: "other", label: "✏️ Something else", profession: "" }
    ];

    const LEVEL_CHOICES = [["new", "🌱 New to it"], ["some", "👍 Some experience"], ["pro", "🏆 Very experienced"]];
    const MODE_CHOICES = [["do", "⚡ Do it for me"], ["teach", "🎓 Teach me how"], ["auto", "🤖 You decide"]];

    const PROVIDERS = {
        anthropic: { name: "Claude", note: "The best results. Paid: most tasks cost a few cents, and CoDev has spending limits.", url: "https://console.anthropic.com/settings/keys", site: "console.anthropic.com", prefix: "sk-ant-",
            steps: ["Tap the button to open Anthropic's site, and sign up or log in.", "Add a little credit under Billing (even $5 lasts a long time).", "Under API keys, tap Create Key, name it CoDev, and copy it."] },
        groq: { name: "Groq", note: "Free, no card needed. Good for trying CoDev; its daily limits run out on big tasks.", url: "https://console.groq.com/keys", site: "console.groq.com", prefix: "gsk_",
            steps: ["Tap the button to open Groq's site, and sign up or log in (Google sign-in works).", "Tap Create API Key, name it CoDev, and copy it."] }
    };

    function readJson(storage, key, fallback) {
        try { const v = JSON.parse(storage.getItem(key) || "null"); return v == null ? fallback : v; } catch (err) { return fallback; }
    }
    const get = (storage, key) => { try { return storage.getItem(key) || ""; } catch (err) { return ""; } };
    const put = (storage, key, value) => { try { storage.setItem(key, value); } catch (err) { /* private mode */ } };

    const STYLE = {
        primary: "padding: 12px 16px; border-radius: 8px; border: none; background: var(--accent); color: var(--bg-dark); font-weight: bold; cursor: pointer; font-size: 0.95rem;",
        choice: "text-align: left; padding: 11px 12px; border-radius: 8px; font-size: 0.9rem; cursor: pointer;",
        input: "width: 100%; box-sizing: border-box; font-family: inherit; padding: 11px; border-radius: 8px; background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); font-size: 16px;",
        muted: "font-size: 0.83rem; color: var(--text-muted); line-height: 1.5;"
    };

    // A row of choice buttons; the picked one is outlined. Returns { node, value() }.
    function choices(doc, name, items, picked) {
        let value = picked;
        const node = el(doc, "div", { role: "radiogroup", "aria-label": name, style: "display: flex; flex-direction: column; gap: 6px;" });
        const paint = () => [...node.children].forEach(b => {
            const on = b.dataset.value === value;
            b.setAttribute("aria-checked", on ? "true" : "false");
            b.style.outline = on ? "2px solid var(--accent)" : "none";
            b.style.fontWeight = on ? "bold" : "normal";
        });
        for (const [v, label] of items) {
            const b = el(doc, "button", { type: "button", role: "radio", class: "btn-secondary", "data-value": v, style: STYLE.choice, onclick: () => { value = v; paint(); if (node.onpick) node.onpick(v); } });
            b.textContent = label;
            node.appendChild(b);
        }
        paint();
        return { node, value: () => value };
    }

    // ---- Welcome ----

    // deps: storage, document, expertise (expert-coach's createExpertise), hasKey() -> bool,
    // saveKey(provider, key) -> Promise<"" | problem>, isWeb() -> bool, automated() -> bool,
    // openSettings(), openWorkKit() optional.
    function createWelcome(deps = {}) {
        const storage = deps.storage;
        const doc = deps.document || (typeof document !== "undefined" ? document : null);
        const markDone = () => put(storage, KEYS.welcomeDone, "1");
        const shouldShow = () => !get(storage, KEYS.welcomeDone) && !(deps.automated && deps.automated());

        function open() {
            if (!doc) return null;
            const { box, close } = modal(doc, "welcomeModal", "Welcome to CoDev", 520);
            const finish = () => { markDone(); close(); };
            const profile = deps.expertise ? deps.expertise.profile() : { profession: "", level: "", mode: "auto" };
            const state = { role: (ROLES.find(r => r.profession && r.profession === profile.profession) || {}).id || "", other: "", level: profile.level, mode: profile.mode === "auto" ? "" : profile.mode, provider: "anthropic" };
            const dots = n => el(doc, "div", { style: "display: flex; gap: 6px; justify-content: center;" }, [1, 2, 3].map(i => el(doc, "span", { style: `width: 8px; height: 8px; border-radius: 50%; background: ${i === n ? "var(--accent)" : "var(--border-color)"};` })));
            const skip = el(doc, "button", { type: "button", class: "btn-secondary", id: "welcomeSkip", text: "Skip setup", style: "padding: 8px 12px; border-radius: 8px; font-size: 0.8rem;", onclick: finish });

            function frame(n, title, ...children) {
                box.replaceChildren(
                    el(doc, "div", { style: "display: flex; align-items: center; justify-content: space-between; gap: 8px;" }, [el(doc, "h3", { style: "margin: 0;", text: title }), skip]),
                    ...children, dots(n));
            }

            function step1() {
                const roles = choices(doc, "What do you do", ROLES.map(r => [r.id, r.label]), state.role);
                const other = el(doc, "input", { type: "text", id: "welcomeOther", placeholder: "Your job, in your words (e.g. dental office manager)", style: STYLE.input + (state.role === "other" ? "" : " display: none;") });
                other.value = state.other;
                roles.node.onpick = v => { other.style.display = v === "other" ? "" : "none"; if (v === "other") other.focus(); };
                const level = choices(doc, "Experience", LEVEL_CHOICES, state.level);
                level.node.style.flexDirection = "row"; level.node.style.flexWrap = "wrap";
                const mode = choices(doc, "How should it help", MODE_CHOICES, state.mode);
                mode.node.style.flexDirection = "row"; mode.node.style.flexWrap = "wrap";
                const next = el(doc, "button", { type: "button", id: "welcomeNext1", style: STYLE.primary, text: "Next →", onclick: () => {
                    state.role = roles.value(); state.other = other.value.trim(); state.level = level.value() || ""; state.mode = mode.value() || "";
                    const role = ROLES.find(r => r.id === state.role);
                    const profession = role ? (role.id === "other" ? state.other : role.profession) : "";
                    if (deps.expertise) deps.expertise.save({ ...(role ? { profession } : {}), level: state.level, mode: state.mode || "auto" });
                    step2();
                } });
                frame(1, "👋 Welcome! Let's set CoDev up for you",
                    el(doc, "div", { style: STYLE.muted, text: "Three quick questions so CoDev's agents work like a pro in your job from the first message. About a minute. You can change all of it later in ⚙️ Settings." }),
                    el(doc, "div", { style: "font-weight: bold;", text: "What kind of work do you do?" }), roles.node, other,
                    el(doc, "div", { style: "font-weight: bold;", text: "How experienced are you at it?" }), level.node,
                    el(doc, "div", { style: "font-weight: bold;", text: "When you ask for something, should CoDev…" }), mode.node,
                    next);
            }

            function step2() {
                const back = el(doc, "button", { type: "button", class: "btn-secondary", text: "← Back", style: "padding: 12px; border-radius: 8px;", onclick: step1 });
                if (deps.hasKey && deps.hasKey()) {
                    frame(2, "🔌 Connect the AI",
                        el(doc, "div", { id: "welcomeKeyReady", style: "padding: 14px; border-radius: 8px; background: var(--bg-dark); border: 1px solid var(--success); line-height: 1.5;", text: "✅ You're all set: this copy of CoDev already has an AI connected. Nothing to paste." }),
                        el(doc, "div", { style: "display: flex; gap: 8px;" }, [back, el(doc, "button", { type: "button", id: "welcomeNext2", style: STYLE.primary + " flex: 1;", text: "Next →", onclick: step3 })]));
                    return;
                }
                const tabs = choices(doc, "Which AI", Object.entries(PROVIDERS).map(([k, p]) => [k, `${k === "anthropic" ? "⭐" : "🆓"} ${p.name}: ${p.note}`]), state.provider);
                const guide = el(doc, "div", { style: "display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 8px; background: var(--bg-dark); border: 1px solid var(--border-color);" });
                const key = el(doc, "input", { type: "text", id: "welcomeKey", autocomplete: "off", spellcheck: "false", style: STYLE.input + " font-family: monospace;" });
                const status = el(doc, "div", { id: "welcomeKeyStatus", role: "status", style: "font-size: 0.85rem; min-height: 1.2em;" });
                const paint = () => {
                    const p = PROVIDERS[state.provider];
                    key.placeholder = `Paste your key here (it starts with ${p.prefix})`;
                    guide.replaceChildren(
                        ...p.steps.map((s, i) => el(doc, "div", { style: "font-size: 0.88rem;", text: `${i + 1}. ${s}` })),
                        el(doc, "a", { href: p.url, target: "_blank", rel: "noopener", style: "background: var(--codev-blue); color: white; text-align: center; padding: 10px; border-radius: 8px; text-decoration: none; font-weight: bold;", text: `🔑 Open ${p.site}` }),
                        el(doc, "div", { style: "font-size: 0.88rem;", text: `${p.steps.length + 1}. Come back here and paste it:` }));
                };
                tabs.node.onpick = v => { state.provider = v; status.textContent = ""; paint(); };
                paint();
                const pasteBtn = el(doc, "button", { type: "button", class: "btn-secondary", text: "📋 Paste", style: "padding: 10px 12px; border-radius: 8px; white-space: nowrap;", onclick: async () => {
                    try { key.value = (await navigator.clipboard.readText()).trim(); } catch (err) { status.textContent = "Press and hold in the box, then tap Paste."; key.focus(); }
                } });
                const save = el(doc, "button", { type: "button", id: "welcomeSaveKey", style: STYLE.primary + " flex: 1;", text: "Connect ✓", onclick: async () => {
                    const value = key.value.replace(/\s+/g, "");
                    const p = PROVIDERS[state.provider];
                    if (!value) { status.style.color = "var(--warning)"; status.textContent = "Paste your key first."; key.focus(); return; }
                    const other = Object.entries(PROVIDERS).find(([k, x]) => k !== state.provider && value.startsWith(x.prefix));
                    if (other) { state.provider = other[0]; tabs.node.querySelector(`[data-value="${other[0]}"]`).click(); }
                    else if (!value.startsWith(p.prefix)) { status.style.color = "var(--warning)"; status.textContent = `That doesn't look like a ${p.name} key: it should start with ${p.prefix}. Copy the whole key and try again.`; return; }
                    save.disabled = true; status.style.color = "var(--text-muted)"; status.textContent = "Checking the key…";
                    const problem = deps.saveKey ? await deps.saveKey(state.provider, value) : "";
                    save.disabled = false;
                    if (problem) { status.style.color = "var(--warning)"; status.textContent = problem; return; }
                    step3(`✅ ${PROVIDERS[state.provider].name} is connected.`);
                } });
                frame(2, "🔌 Connect the AI",
                    el(doc, "div", { style: STYLE.muted, text: "CoDev needs a key from an AI company to think. It's saved only on this device. Easiest of all: ask whoever sent you CoDev for the copy with the key built in, then skip this step." }),
                    tabs.node, guide,
                    el(doc, "div", { style: "display: flex; gap: 8px;" }, [key, pasteBtn]), status,
                    el(doc, "div", { style: "display: flex; gap: 8px;" }, [back, save]),
                    el(doc, "button", { type: "button", class: "btn-secondary", id: "welcomeLater", text: "I'll do this later", style: "padding: 10px; border-radius: 8px; font-size: 0.85rem;", onclick: () => step3() }));
            }

            function step3(banner) {
                const tips = [
                    ["💼", "Work kit (by Send): one tap for everyday jobs. Pick one, paste the email or notes, done. You can save your own."],
                    ["🔒", "Privacy check: if a message has an SSN, bank number, birth date or member ID, CoDev offers to hide it before it goes to the AI."],
                    ["🎓", "Say \"show me how\" to learn it yourself, or \"just do it\" to have it done. The 🤖 button by Send switches the default."],
                    ["📎", "Attach files, screenshots or spreadsheets and ask about them."],
                    ["💬", "Feedback (top bar): tell us what worked and what didn't. It takes a minute and helps a lot."]
                ];
                const honest = "Good to know: CoDev can't log into your company's own systems. Copy and paste what you need, and only use work info your employer allows with AI tools.";
                const start = el(doc, "button", { type: "button", id: "welcomeDone", style: STYLE.primary, text: "Start using CoDev", onclick: finish });
                const kit = deps.openWorkKit ? el(doc, "button", { type: "button", class: "btn-secondary", text: "💼 Open the Work kit", style: "padding: 12px; border-radius: 8px;", onclick: () => { finish(); deps.openWorkKit(); } }) : null;
                frame(3, "🎉 You're ready",
                    banner ? el(doc, "div", { style: "color: var(--success); font-weight: bold;", text: banner }) : null,
                    !banner && deps.hasKey && !deps.hasKey() ? el(doc, "div", { style: "color: var(--warning); font-size: 0.85rem;", text: "No AI connected yet: add a key any time in ⚙️ Settings, or open this guide again from there." }) : null,
                    el(doc, "div", { style: "display: flex; flex-direction: column; gap: 8px;" }, tips.map(([icon, text]) => el(doc, "div", { style: "display: flex; gap: 10px; font-size: 0.88rem; line-height: 1.45;" }, [el(doc, "span", { text: icon }), el(doc, "span", { text })]))),
                    el(doc, "div", { style: STYLE.muted + " border-left: 3px solid var(--warning); padding-left: 10px;", text: honest }),
                    el(doc, "div", { style: "display: flex; gap: 8px; flex-wrap: wrap;" }, [kit, start].filter(Boolean)));
            }

            step1();
            return { close };
        }

        return { shouldShow, open, markDone };
    }

    // ---- Feedback ----

    const COMPARE = [["better", "Better"], ["same", "About the same"], ["worse", "Worse"], ["none", "I don't use other AI apps"]];
    const AGAIN = [["yes", "Yes"], ["maybe", "Maybe"], ["no", "No"]];

    function feedbackText(e, info = {}) {
        const label = (list, v) => (list.find(([k]) => k === v) || [, "—"])[1];
        return [
            `CoDev feedback${e.name ? ` from ${e.name}` : ""} (${String(e.at || "").slice(0, 16).replace("T", " ")})`,
            `Rating: ${e.rating ? "★".repeat(e.rating) + "☆".repeat(5 - e.rating) : "—"}`,
            `Tried to do: ${e.tried || "—"}`,
            `Worked well: ${e.good || "—"}`,
            `Confusing, slow or broken: ${e.bad || "—"}`,
            `Compared to other AI apps: ${label(COMPARE, e.compare)}`,
            `Would use it again for real work: ${label(AGAIN, e.again)}`,
            `Device: ${[info.app, info.platform, info.screen, info.provider && `AI: ${info.provider}`, info.profession && `Field: ${info.profession}`].filter(Boolean).join(" · ")}`,
            e.log ? `Recent activity log:\n${e.log}` : ""
        ].filter(Boolean).join("\n");
    }

    // deps: storage, document, info() -> { app, platform, screen, provider, profession },
    // feedbackTo (an email address, optional), log() -> recent activity lines (optional).
    function createFeedback(deps = {}) {
        const storage = deps.storage;
        const doc = deps.document || (typeof document !== "undefined" ? document : null);
        const entries = () => readJson(storage, KEYS.feedback, []);
        const keep = entry => { try { storage.setItem(KEYS.feedback, JSON.stringify([entry, ...entries()].slice(0, MAX_FEEDBACK))); } catch (err) { /* full */ } };

        function open() {
            if (!doc) return null;
            const { box, close } = modal(doc, "feedbackModal", "Send feedback", 520);
            const field = (id, label, rows, placeholder) => el(doc, "div", { class: "form-group" }, [el(doc, "label", { for: id, text: label }),
                el(doc, rows ? "textarea" : "input", { id, ...(rows ? { rows: String(rows) } : { type: "text" }), placeholder, style: STYLE.input + (rows ? " resize: vertical;" : "") })]);
            let rating = 0;
            const stars = el(doc, "div", { role: "radiogroup", "aria-label": "Rating", style: "display: flex; gap: 4px;" });
            const paintStars = () => [...stars.children].forEach((s, i) => { s.textContent = i < rating ? "★" : "☆"; s.setAttribute("aria-checked", i + 1 === rating ? "true" : "false"); });
            for (let i = 1; i <= 5; i++) stars.appendChild(el(doc, "button", { type: "button", role: "radio", "aria-label": `${i} star${i > 1 ? "s" : ""}`, "data-star": String(i), style: "font-size: 1.8rem; background: none; border: none; color: var(--warning); cursor: pointer; padding: 0 2px;", onclick: () => { rating = i; paintStars(); } }));
            paintStars();
            const compare = choices(doc, "Compared to other AI apps", COMPARE, "");
            compare.node.style.flexDirection = "row"; compare.node.style.flexWrap = "wrap";
            const again = choices(doc, "Use it again", AGAIN, "");
            again.node.style.flexDirection = "row";
            const logBox = el(doc, "input", { type: "checkbox", id: "feedbackLog" });
            const status = el(doc, "div", { id: "feedbackStatus", role: "status", style: "font-size: 0.85rem; min-height: 1.2em; color: var(--success);" });
            box.append(
                el(doc, "div", { style: "display: flex; align-items: center; justify-content: space-between; gap: 8px;" }, [el(doc, "h3", { style: "margin: 0;", text: "💬 How's CoDev working for you?" }), el(doc, "button", { type: "button", class: "btn-secondary", text: "Close", onclick: close })]),
                el(doc, "div", { style: STYLE.muted, text: "Honest is best: what's confusing or broken is the most useful thing to hear. Nothing is sent until you tap a send button below." }),
                field("feedbackName", "Your name", 0, "So we know who it's from"),
                el(doc, "div", { style: "font-weight: bold;", text: "Overall" }), stars,
                field("feedbackTried", "What did you try to do?", 2, "e.g. answer a customer email, compare two plans"),
                field("feedbackGood", "What worked well?", 2, ""),
                field("feedbackBad", "What was confusing, slow or broken?", 3, "The more specific the better: what you tapped, what you expected, what happened"),
                el(doc, "div", { style: "font-weight: bold;", text: "Compared to other AI apps you use (ChatGPT, Gemini, Copilot…), CoDev was:" }), compare.node,
                el(doc, "div", { style: "font-weight: bold;", text: "Would you use it again tomorrow for real work?" }), again.node,
                deps.log ? el(doc, "label", { class: "checkbox-group", style: "font-size: 0.82rem;" }, [logBox, " Include the app's recent activity log (helps find bugs; keys are taken out)"]) : null,
                status);
            const nameInput = doc.getElementById("feedbackName");
            nameInput.value = get(storage, KEYS.testerName);

            const collect = () => {
                const v = id => doc.getElementById(id).value.trim().slice(0, 4000);
                const entry = { at: new Date().toISOString(), name: v("feedbackName").slice(0, 60), rating, tried: v("feedbackTried"), good: v("feedbackGood"), bad: v("feedbackBad"), compare: compare.value(), again: again.value() };
                if (deps.log && logBox.checked) entry.log = String(deps.log() || "").slice(-3000);
                if (entry.name) put(storage, KEYS.testerName, entry.name);
                return entry;
            };
            const empty = e => !e.rating && !e.tried && !e.good && !e.bad && !e.compare && !e.again;
            const sendWith = how => async () => {
                const entry = collect();
                if (empty(entry)) { status.style.color = "var(--warning)"; status.textContent = "Fill in at least one thing first."; return; }
                const text = feedbackText(entry, deps.info ? deps.info() : {});
                keep(entry);
                status.style.color = "var(--success)";
                try {
                    if (how === "share") {
                        await navigator.share({ title: "CoDev feedback", text });
                        status.textContent = "Sent. Thank you!";
                    } else if (how === "email") {
                        const to = deps.feedbackTo ? encodeURIComponent(deps.feedbackTo) : "";
                        (doc.defaultView || window).open(`mailto:${to}?subject=${encodeURIComponent("CoDev feedback")}&body=${encodeURIComponent(text)}`, "_blank");
                        status.textContent = "Your email app should open with it filled in. Thank you!";
                    } else {
                        await navigator.clipboard.writeText(text);
                        status.textContent = "Copied. Paste it in a text or email to whoever sent you CoDev. Thank you!";
                    }
                } catch (err) {
                    if (err && err.name === "AbortError") { status.textContent = "Saved on this device. Send it whenever you're ready."; return; }
                    status.style.color = "var(--warning)";
                    status.textContent = "Couldn't open that. Select the text below and copy it.";
                    const pre = el(doc, "textarea", { rows: "8", readonly: "readonly", style: STYLE.input });
                    pre.value = text;
                    status.after(pre);
                    pre.select();
                }
            };
            const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
            const btn = (id, text, primary, how) => el(doc, "button", { type: "button", id, text, class: primary ? "" : "btn-secondary", style: primary ? STYLE.primary : "padding: 12px; border-radius: 8px;", onclick: sendWith(how) });
            box.append(el(doc, "div", { style: "display: flex; gap: 8px; flex-wrap: wrap;" }, [
                canShare ? btn("feedbackShare", "📤 Send (text, WhatsApp…)", true, "share") : null,
                btn("feedbackEmail", "✉️ Email it", !canShare, "email"),
                btn("feedbackCopy", "📋 Copy", false, "copy")
            ].filter(Boolean)));
            return { close };
        }

        function mount(button) {
            if (!button) return null;
            button.addEventListener("click", open);
            return { refresh() {} };
        }

        return { open, entries, mount };
    }

    return { KEYS, ROLES, PROVIDERS, feedbackText, createWelcome, createFeedback };
});
