// The CoDev account: sign-in to CoDev's online server (cloud/), which holds the
// owner's API keys and forwards AI requests within the account's plan, so the
// keys never reach this device. Draws the account box in Settings and, for the
// owner's account only, the Owner page (keys, sign-ups and testers, limits, and
// the owner's own agents).
//
// The page asks CodevCloud.covers(provider) before a chat request; when it's
// true and there's no key of the user's own, the request goes to
// CodevCloud.relayUrl(provider) with CodevCloud.authHeader().
(function (root) {
    "use strict";

    // Filled in once the server is online (see cloud/README.md). Settings can override it.
    const DEFAULT_URL = "";
    const STORE = { url: "codev_cloud_url", token: "codev_cloud_token", account: "codev_cloud_account" };
    const RELAY_PATHS = { groq: "/v1/groq/chat/completions", openrouter: "/v1/openrouter/chat/completions", anthropic: "/v1/anthropic/messages" };
    const KEY_LABELS = { groq: "Groq", openrouter: "OpenRouter", anthropic: "Anthropic" };

    const read = name => { try { return localStorage.getItem(name) || ""; } catch (err) { return ""; } };
    const write = (name, value) => { try { value ? localStorage.setItem(name, value) : localStorage.removeItem(name); } catch (err) { /* storage off */ } };

    let account = null;
    try { account = JSON.parse(read(STORE.account) || "null"); } catch (err) { account = null; }
    let pendingEmail = "";
    const listeners = [];

    function serverUrl() {
        return (read(STORE.url) || DEFAULT_URL).replace(/\/+$/, "");
    }

    function signedIn() {
        return Boolean(serverUrl() && read(STORE.token) && account);
    }

    function covers(provider) {
        return signedIn() && Array.isArray(account.plan?.providers) && account.plan.providers.includes(provider);
    }

    function relayUrl(provider) {
        return serverUrl() + RELAY_PATHS[provider];
    }

    function authHeader() {
        return { "Authorization": `Bearer ${read(STORE.token)}` };
    }

    function setAccount(next) {
        account = next;
        write(STORE.account, next ? JSON.stringify(next) : "");
        listeners.forEach(fn => { try { fn(account); } catch (err) { console.error(err); } });
    }

    // Reads the server's error message; a sign-in the server no longer knows signs out here too.
    async function call(method, path, body) {
        const url = serverUrl();
        if (!url) throw new Error("CoDev's server address isn't set yet.");
        let response;
        try {
            response = await fetch(url + path, {
                method,
                headers: { ...(read(STORE.token) ? authHeader() : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
                body: body !== undefined ? JSON.stringify(body) : undefined
            });
        } catch (err) {
            throw new Error(`Couldn't reach CoDev's server (${err.message}). Check that this device is online.`);
        }
        const data = await response.json().catch(() => ({}));
        if (response.status === 401 && data.error?.code === "signed_out") { write(STORE.token, ""); setAccount(null); }
        if (!response.ok) throw new Error(data.error?.message || `CoDev's server answered ${response.status}.`);
        return data;
    }

    // Turns a relay error into the message the chat shows. Returns null when the
    // response isn't one of the server's own errors.
    function relayError(status, data) {
        const err = data && data.error;
        if (!err || !err.code) return null;
        if (err.code === "signed_out") { write(STORE.token, ""); setAccount(null); }
        return err.message;
    }

    async function refresh() {
        if (!serverUrl() || !read(STORE.token)) return account;
        try { setAccount(await call("GET", "/me")); } catch (err) { /* offline: keep the saved account */ }
        return account;
    }

    // ---- The account box in Settings -------------------------------------------

    function el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === "style") node.style.cssText = v;
            else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        }
        for (const child of children) if (child != null) node.append(child.nodeType ? child : String(child));
        return node;
    }

    const BOX = "background: var(--bg-dark); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 0.85rem;";
    const MUTED = "color: var(--text-muted); font-size: 0.8rem;";

    function renderPanel(container) {
        if (!container) return;
        container.replaceChildren();
        const status = el("div", { role: "alert", style: "display: none; color: var(--danger); font-size: 0.8rem;" });
        const fail = message => { status.textContent = message; status.style.display = message ? "block" : "none"; };
        const busy = async (button, work) => {
            button.disabled = true; fail("");
            try { await work(); } catch (err) { fail(err.message); } finally { button.disabled = false; }
        };
        const box = el("div", { style: BOX });
        container.append(box);

        if (signedIn()) {
            const plan = account.plan || {};
            const usage = account.usage || {};
            const lines = [];
            if (plan.chatTotal != null) lines.push(`${Math.max(0, plan.chatTotal - (usage.trialUsed || 0))} of ${plan.chatTotal} trial messages left`);
            else if (plan.chatPerDay != null) lines.push(`${usage.chatToday || 0} of ${plan.chatPerDay} messages used today`);
            else lines.push("No limits");
            box.append(
                el("div", { style: "font-weight: bold; color: var(--accent);" }, "CoDev account"),
                el("div", {}, account.email, " · ", el("strong", {}, plan.name || "")),
                el("div", { style: MUTED }, lines.join(" · ")),
                el("div", { style: MUTED }, "AI runs on CoDev's own keys, so you don't need one. A key of your own below is used instead when you add one.")
            );
            const row = el("div", { style: "display: flex; gap: 8px; flex-wrap: wrap;" });
            if (account.owner) row.append(el("button", { type: "button", class: "btn-primary", onclick: () => openOwnerPage() }, "Owner page"));
            const out = el("button", { type: "button", class: "btn-secondary", onclick: () => busy(out, async () => {
                try { await call("POST", "/auth/signout"); } catch (err) { /* signed out here either way */ }
                write(STORE.token, ""); setAccount(null); renderPanel(container);
            }) }, "Sign out");
            row.append(out);
            box.append(row, status);
            return;
        }

        box.append(el("div", { style: "font-weight: bold; color: var(--accent);" }, "Sign in to CoDev (no API key needed)"));
        const email = el("input", { type: "email", placeholder: "you@example.com", autocomplete: "email", style: "width: 100%;" });
        const code = el("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "6-digit code", maxlength: "6", style: "width: 100%; font-family: monospace;" });
        email.value = pendingEmail;
        const send = el("button", { type: "button", class: "btn-primary", onclick: () => busy(send, async () => {
            pendingEmail = email.value.trim();
            await call("POST", "/auth/start", { email: pendingEmail });
            renderPanel(container);
            container.querySelector("input[inputmode=numeric]")?.focus();
        }) }, "Email me a code");
        const verify = el("button", { type: "button", class: "btn-primary", onclick: () => busy(verify, async () => {
            const reply = await call("POST", "/auth/verify", { email: pendingEmail, code: code.value.trim() });
            write(STORE.token, reply.token);
            pendingEmail = "";
            setAccount(reply.account);
            renderPanel(container);
        }) }, "Sign in");

        if (pendingEmail) {
            box.append(el("div", {}, `We emailed a code to ${pendingEmail}.`), code,
                el("div", { style: "display: flex; gap: 8px;" }, verify,
                    el("button", { type: "button", class: "btn-secondary", onclick: () => { pendingEmail = ""; renderPanel(container); } }, "Use another email")));
        } else {
            box.append(email, send);
        }

        // The server address, for setting up before it's built into the app.
        const urlInput = el("input", { type: "url", placeholder: "https://codev-cloud.example.workers.dev", style: "width: 100%; font-family: monospace;" });
        urlInput.value = read(STORE.url);
        const saveUrl = el("button", { type: "button", class: "btn-secondary", onclick: () => { write(STORE.url, urlInput.value.trim()); fail(""); renderPanel(container); } }, "Save address");
        const advanced = el("details", { style: MUTED }, el("summary", {}, "Server address"), urlInput, saveUrl);
        if (!DEFAULT_URL && !read(STORE.url)) advanced.open = true;
        box.append(advanced, el("div", { style: MUTED }, "Or skip this and paste your own API key below."), status);
        if (!serverUrl()) [send, verify].forEach(b => { b.disabled = true; });
    }

    // ---- The Owner page ---------------------------------------------------------

    function openOwnerPage() {
        let overlay = document.getElementById("ownerModal");
        if (!overlay) {
            overlay = el("div", { class: "modal-overlay", id: "ownerModal", style: "z-index: 1100;", onclick: e => { if (e.target === overlay) overlay.style.display = "none"; } });
            overlay.append(el("div", { class: "modal", style: "width: 640px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); overflow: auto;" }));
            document.body.append(overlay);
        }
        overlay.style.display = "flex";
        drawOwnerPage(overlay.firstChild, overlay);
    }

    async function drawOwnerPage(modal, overlay) {
        modal.replaceChildren(el("h3", {}, "Owner page"), el("div", { style: MUTED }, "Loading…"));
        let users, keys, agents;
        try {
            [users, keys, agents] = await Promise.all([call("GET", "/owner/users"), call("GET", "/owner/keys"), call("GET", "/owner/agents")]);
        } catch (err) {
            modal.replaceChildren(el("h3", {}, "Owner page"), el("div", { style: "color: var(--danger);" }, err.message));
            return;
        }
        const redraw = () => drawOwnerPage(modal, overlay);
        const status = el("div", { role: "alert", style: "display: none; color: var(--danger); font-size: 0.85rem;" });
        const act = async (button, work) => {
            button.disabled = true; status.style.display = "none";
            try { await work(); await redraw(); } catch (err) { status.textContent = err.message; status.style.display = "block"; button.disabled = false; }
        };

        modal.replaceChildren(
            el("h3", { style: "display: flex; justify-content: space-between; align-items: center;" }, "Owner page",
                el("button", { type: "button", class: "btn-secondary", onclick: () => { overlay.style.display = "none"; } }, "Close")),
            el("div", { style: MUTED }, "Only your account can open this page. Everyone else's requests use these keys without ever seeing them."),
            status
        );

        // Keys
        const keyBox = el("div", { style: BOX }, el("div", { style: "font-weight: bold;" }, "API keys"));
        for (const [name, masked] of Object.entries(keys.keys)) {
            const shown = el("code", { style: "flex: 1; overflow-wrap: anywhere;" }, masked || "not set");
            const input = el("input", { type: "text", placeholder: `Paste a new ${KEY_LABELS[name] || name} key`, style: "width: 100%; font-family: monospace;" });
            const save = el("button", { type: "button", class: "btn-primary", onclick: () => act(save, () => call("PUT", `/owner/keys/${name}`, { value: input.value })) }, "Save");
            const row = el("div", { style: "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;" }, el("strong", { style: "min-width: 90px;" }, KEY_LABELS[name] || name), shown);
            if (masked) {
                const reveal = el("button", { type: "button", class: "btn-secondary", onclick: async () => {
                    try { shown.textContent = (await call("GET", `/owner/keys/${name}/reveal`)).value; reveal.remove(); } catch (err) { status.textContent = err.message; status.style.display = "block"; }
                } }, "Show");
                const remove = el("button", { type: "button", class: "btn-secondary", onclick: () => act(remove, () => call("DELETE", `/owner/keys/${name}`)) }, "Remove");
                row.append(reveal, remove);
            }
            keyBox.append(row, el("div", { style: "display: flex; gap: 8px;" }, input, save));
        }
        modal.append(keyBox);

        // Sign-ups and testers
        const people = el("div", { style: BOX }, el("div", { style: "font-weight: bold;" },
            `Accounts${users.pending ? ` · ${users.pending} new sign-up${users.pending === 1 ? "" : "s"} to review` : ""}`));
        const labels = { trial: "Trial", tester: "Tester (shows as Pro plan)", pro: "Pro plan", owner: "Owner" };
        for (const u of users.users) {
            const row = el("div", { style: "display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border-top: 1px solid var(--border-color); padding-top: 6px;" },
                el("div", { style: "flex: 1; min-width: 180px;" }, u.email, el("div", { style: MUTED },
                    `${labels[u.owner ? "owner" : u.plan] || u.plan} · joined ${new Date(u.created_at).toLocaleDateString()} · ${u.chat_today} messages today`)));
            if (!u.owner && u.plan === "trial") {
                const approve = el("button", { type: "button", class: "btn-primary", onclick: () => act(approve, () => call("POST", `/owner/users/${u.id}`, { action: "approve" })) }, "Approve as tester");
                row.append(approve);
                if (!u.reviewed) {
                    const ignore = el("button", { type: "button", class: "btn-secondary", onclick: () => act(ignore, () => call("POST", `/owner/users/${u.id}`, { action: "ignore" })) }, "Ignore");
                    row.append(ignore);
                }
            }
            if (u.plan === "tester") {
                const remove = el("button", { type: "button", class: "btn-secondary", onclick: () => act(remove, () => call("POST", `/owner/users/${u.id}`, { action: "remove" })) }, "Remove tester");
                row.append(remove);
            }
            people.append(row);
        }
        if (!users.users.length) people.append(el("div", { style: MUTED }, "No accounts yet."));
        modal.append(people);

        // The owner's agents: each one's name, instructions and memory, and its last note.
        const agentBox = el("div", { style: BOX }, el("div", { style: "font-weight: bold;" }, "Your agents"),
            el("div", { style: MUTED }, "They work only for you and see usage numbers and sign-up emails, never anyone's chats. They email you; with your Groq key saved they write their notes with it."));
        const AGENT_JOBS = { api: "Watches API spending, warns you at 80% of the daily total and sends a summary each day.", signups: "Writes your notice for every new sign-up, with a suggestion to approve or skip." };
        for (const agent of agents.agents) {
            const name = el("input", { type: "text", maxlength: "60", style: "width: 100%; font-weight: bold;" });
            name.value = agent.name;
            const instructions = el("textarea", { rows: "3", style: "width: 100%;" });
            instructions.value = agent.instructions;
            const memory = el("textarea", { rows: "4", style: "width: 100%; font-family: monospace; font-size: 0.75rem;" });
            memory.value = agent.memory;
            const save = el("button", { type: "button", class: "btn-primary", onclick: () => act(save, () => call("PUT", `/owner/agents/${agent.id}`, { name: name.value, instructions: instructions.value, memory: memory.value })) }, "Save");
            const run = el("button", { type: "button", class: "btn-secondary", onclick: () => act(run, () => call("POST", `/owner/agents/${agent.id}/run`)) }, "Run now");
            agentBox.append(el("div", { style: "display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 8px;" },
                name,
                el("div", { style: MUTED }, AGENT_JOBS[agent.id] || ""),
                el("label", { style: MUTED }, "Instructions"), instructions,
                el("label", { style: MUTED }, "Memory (its notes, newest last; edit or clear it any time)"), memory,
                agent.last_report ? el("details", { style: MUTED }, el("summary", {}, `Last note${agent.last_run ? `, ${new Date(agent.last_run).toLocaleString()}` : ""}`),
                    el("div", { style: "white-space: pre-wrap;" }, agent.last_report)) : null,
                el("div", { style: "display: flex; gap: 8px;" }, save, run)));
        }
        modal.append(agentBox);

        // Limits
        const cap = el("input", { type: "number", min: "0", value: String(users.settings.daily_cap), style: "width: 120px;" });
        const testers = el("input", { type: "number", min: "0", value: String(users.settings.tester_cap), style: "width: 120px;" });
        const saveLimits = el("button", { type: "button", class: "btn-primary", onclick: () => act(saveLimits, () => call("PUT", "/owner/settings", { daily_cap: cap.value, tester_cap: testers.value })) }, "Save limits");
        modal.append(el("div", { style: BOX },
            el("div", { style: "font-weight: bold;" }, "Limits"),
            el("label", { style: "display: flex; gap: 8px; align-items: center; justify-content: space-between;" }, "Messages a day for everyone but you, together", cap),
            el("label", { style: "display: flex; gap: 8px; align-items: center; justify-content: space-between;" }, "Most testers at once", testers),
            el("div", { style: MUTED }, "Past the daily total, shared AI pauses for everyone but you until midnight (UTC)."),
            saveLimits));
    }

    root.CodevCloud = { serverUrl, signedIn, covers, relayUrl, authHeader, relayError, refresh, renderPanel, openOwnerPage,
        onChange: fn => listeners.push(fn), get account() { return account; } };
})(typeof self !== "undefined" ? self : this);
