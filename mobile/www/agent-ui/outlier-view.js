// The Outlier view: runs the Outlier pipeline on CoDev's server (agents/outlier)
// and shows the entries it recommends, the entries you played and their results,
// and how the filters have tuned themselves from those results.
//
//   CodevOutlierView.mount(container, { postJson, getJson, available })
//     available: false when the page isn't served by CoDev's server (Android, or
//     the file opened directly); the view then says how to get it.
//
// Everything scraped from Outlier is set with textContent, never as HTML.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevOutlierView = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const STYLE_ID = "codev-outlier-style";
    const AUTO_KEY = "codev.outlier.autoMinutes";
    const CSS = `
.ov-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.ov-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ov-btn { background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 0.82rem; }
.ov-btn.primary { background: var(--success); color: #06281d; border-color: var(--success); font-weight: bold; }
.ov-btn:disabled { opacity: 0.5; cursor: default; }
.ov-status { font-size: 0.82rem; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 12px; }
.ov-status .bad { color: var(--danger); }
.ov-status .good { color: var(--success); }
.ov-note { font-size: 0.78rem; color: var(--text-muted); border-left: 3px solid var(--warning); padding: 4px 10px; }
.ov-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; }
.ov-card { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ov-card h4 { font-size: 0.95rem; display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.ov-pill { font-size: 0.72rem; padding: 2px 8px; border-radius: 4px; background: rgba(16,185,129,0.15); color: var(--success); font-weight: bold; }
.ov-pill.neg { background: rgba(239,68,68,0.15); color: var(--danger); }
.ov-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
.ov-table th { text-align: left; color: var(--text-muted); font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--border-color); white-space: nowrap; }
.ov-table td { padding: 4px 6px; border-bottom: 1px solid rgba(55,65,81,0.5); vertical-align: top; }
.ov-scroll { overflow-x: auto; }
.ov-section h3 { font-size: 0.95rem; margin: 8px 0; }
.ov-section details summary { cursor: pointer; font-size: 0.9rem; font-weight: 600; margin: 6px 0; }
.ov-why { color: var(--text-muted); }
.ov-form { display: flex; flex-direction: column; gap: 8px; font-size: 0.82rem; }
.ov-form textarea, .ov-form input[type=text] { background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; font-family: monospace; font-size: 0.8rem; }
.ov-form textarea { min-height: 70px; }
.ov-select { background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 4px; font-size: 0.78rem; }
.ov-error { color: var(--danger); font-size: 0.82rem; white-space: pre-wrap; }
`;

    function el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (value == null || value === false) continue;
            if (key === "class") node.className = value;
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else if (key === "text") node.textContent = value;
            else node.setAttribute(key, value === true ? "" : value);
        }
        for (const child of children.flat()) {
            if (child == null || child === false) continue;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }

    const pct = (v, digits = 0) => (v == null ? "–" : `${(v * 100).toFixed(digits)}%`);
    const price = v => (v == null ? "–" : v > 0 ? `+${v}` : String(v));
    const when = iso => (iso ? new Date(iso).toLocaleString() : "never");
    const legLabel = l => `${l.side === "under" ? "U" : "O"} ${l.line}${l.market ? ` ${l.market}` : ""}`;

    function legRows(legs, extraHead, extraCell) {
        return el("div", { class: "ov-scroll" }, el("table", { class: "ov-table" },
            el("thead", {}, el("tr", {}, ["Player", "Pick", "Odds", "L5", "Floor", "Hit chance", ...(extraHead || [])].map(h => el("th", { text: h })))),
            el("tbody", {}, legs.map(l => el("tr", {},
                el("td", { text: l.player || "?" }),
                el("td", { text: legLabel(l) }),
                el("td", { text: price(l.metrics && l.metrics.consensus) }),
                el("td", { text: pct(l.metrics && l.metrics.l5) }),
                el("td", { text: l.metrics && l.metrics.floorMargin != null ? `${l.metrics.floorMargin >= 0 ? "+" : ""}${pct(l.metrics.floorMargin)}` : "–" }),
                el("td", { text: pct(l.metrics && l.metrics.p) }),
                ...(extraCell ? extraCell(l) : [])
            )))));
    }

    function mount(container, { postJson, getJson, available = true } = {}) {
        if (!document.getElementById(STYLE_ID)) document.head.append(el("style", { id: STYLE_ID, text: CSS }));
        let state = null;
        let error = "";
        let info = "";
        let working = "";
        let autoTimer = null;
        let pollTimer = null;

        async function load() {
            try { state = await getJson("/outlier/state"); error = ""; } catch (err) { error = err.message; }
            render();
            // While the sign-in window is open, watch for it to close.
            clearTimeout(pollTimer);
            if (state && state.busy) pollTimer = setTimeout(load, 3000);
        }

        async function act(label, url, body = {}, { reload = true } = {}) {
            working = label;
            error = "";
            info = "";
            render();
            try {
                const reply = await postJson(url, body);
                if (reply && reply.result !== undefined && reply.history) state = reply;
                else if (reload) await load();
                return reply;
            } catch (err) {
                error = err.message;
            } finally {
                working = "";
                render();
            }
            return null;
        }

        function setAuto(minutes) {
            clearInterval(autoTimer);
            autoTimer = null;
            try { localStorage.setItem(AUTO_KEY, String(minutes)); } catch { /* not kept */ }
            if (minutes > 0) autoTimer = setInterval(() => {
                // Only while this view is on screen and nothing else is running.
                if (container.offsetParent !== null && !working && !(state && state.busy)) act("Reading Outlier…", "/outlier/scrape");
            }, minutes * 60 * 1000);
        }

        function header() {
            const busy = Boolean(working || (state && state.busy));
            let auto = 0;
            try { auto = Number(localStorage.getItem(AUTO_KEY)) || 0; } catch { /* default off */ }
            return el("div", { class: "ov-bar" },
                el("h3", { text: "📈 Outlier slips" }),
                el("div", { class: "ov-actions" },
                    el("button", { class: "ov-btn", disabled: busy, onclick: () => act("Opening the sign-in window…", "/outlier/signin") }, "🔑 Sign in to Outlier"),
                    el("button", { class: "ov-btn primary", disabled: busy, onclick: () => act("Reading Outlier…", "/outlier/scrape") }, "⟳ Scrape & analyze"),
                    el("button", { class: "ov-btn", disabled: busy || !(state && state.scrapedAt), onclick: () => act("Scoring…", "/outlier/analyze") }, "Re-score"),
                    el("label", { class: "ov-status" }, "Auto ",
                        el("select", { class: "ov-select", onchange: e => setAuto(Number(e.target.value)) },
                            [0, 5, 10, 15, 30].map(m => el("option", { value: m, selected: m === auto }, m ? `every ${m} min` : "off"))))));
        }

        function statusLine() {
            if (!state) return el("div", { class: "ov-status" }, "Loading…");
            const signed = state.signedIn === true ? el("span", { class: "good", text: "● Signed in to Outlier" })
                : state.signedIn === false ? el("span", { class: "bad", text: "● Signed out: click Sign in to Outlier" })
                    : el("span", { text: state.profileSaved ? "● Saved Outlier sign-in (checked on the next scrape)" : "● Not signed in yet" });
            return el("div", { class: "ov-status" }, signed,
                el("span", { text: `Last scrape: ${when(state.scrapedAt)}` }),
                state.result ? el("span", { text: `${state.result.counts.passed} of ${state.result.counts.props} props passed the filters` }) : null,
                state.busy === "signin" ? el("span", { text: "Sign-in window open: sign in, then close it." }) : null,
                working ? el("span", { text: working }) : null);
        }

        function slipsSection() {
            const result = state && state.result;
            if (!result) return el("div", { class: "ov-note" }, "No analysis yet. Sign in to Outlier once, then click Scrape & analyze.");
            const legs = new Map(result.legs.map(l => [l.id, l]));
            const cards = result.slips.map(slip => el("div", { class: "ov-card" },
                el("h4", {}, `${slip.size}-leg ${slip.type === "flex" ? "Flex" : "Power"}`,
                    el("span", { class: `ov-pill${slip.ev < 0 ? " neg" : ""}`, text: `EV ${slip.ev >= 0 ? "+" : ""}${pct(slip.ev, 1)}` })),
                el("div", { class: "ov-status" },
                    el("span", { text: `All legs hit: ${pct(slip.allHitProb, 1)}` }),
                    el("span", { text: `Pays something: ${pct(slip.profitProb, 1)}` })),
                legRows(slip.legs.map(id => legs.get(id)).filter(Boolean)),
                el("div", { class: "ov-actions" },
                    el("button", { class: "ov-btn", disabled: Boolean(working), onclick: () => act("Tracking…", "/outlier/track", { slipId: slip.id }) }, "✓ I played this"))));
            return el("div", { class: "ov-section" },
                el("div", { class: "ov-grid" }, cards.length ? cards : el("div", { class: "ov-note" }, "No entries this time.")),
                result.notes.map(n => el("div", { class: "ov-note", text: n })));
        }

        function trackedSection() {
            const entries = (state && state.history.entries) || [];
            if (!entries.length) return null;
            const open = entries.filter(e => e.legs.some(l => !l.result)).reverse();
            const done = entries.filter(e => e.legs.every(l => l.result)).reverse();
            const entryCard = entry => {
                const picks = {};
                return el("div", { class: "ov-card" },
                    el("h4", {}, `${entry.size}-leg ${entry.type === "flex" ? "Flex" : "Power"}`, el("span", { class: "ov-why", text: when(entry.recordedAt) })),
                    legRows(entry.legs, ["Result"], leg => [el("td", {}, el("select", {
                        class: "ov-select",
                        onchange: e => { picks[leg.id] = e.target.value || null; }
                    }, ["", "hit", "miss", "push"].map(v => el("option", { value: v, selected: (leg.result || "") === v }, v || "pending"))))]),
                    el("div", { class: "ov-actions" },
                        el("button", { class: "ov-btn primary", disabled: Boolean(working), onclick: () => act("Learning from results…", "/outlier/outcomes", { entryId: entry.id, results: picks }) }, "Save results"),
                        el("button", { class: "ov-btn", disabled: Boolean(working), onclick: () => act("Removing…", "/outlier/untrack", { entryId: entry.id }) }, "Remove")));
            };
            return el("div", { class: "ov-section" },
                el("h3", { text: "Entries you played" }),
                el("div", { class: "ov-note" }, "Mark each leg when it settles (or let the scrape read them from Outlier's history pages, if you add one under Pages). The filters retune after each save."),
                el("div", { class: "ov-grid" }, open.map(entryCard)),
                done.length ? el("details", {}, el("summary", { text: `Settled (${done.length})` }), el("div", { class: "ov-grid" }, done.map(entryCard))) : null);
        }

        function learningSection() {
            if (!state) return null;
            const filters = (state.result && state.result.filters) || (state.weights && state.weights.filters) || {};
            const report = state.learnReport;
            const labels = { min_juice: v => `Odds at least -${v}`, min_l5_hit_rate: v => `L5 hit rate ≥ ${pct(v)}`, min_floor_margin: v => `Floor ≥ ${pct(v)} past the line`,
                max_volatility: v => `Volatility ≤ ${Number(v).toFixed(2)}`, min_leg_probability: v => `Estimated hit chance ≥ ${pct(v)}`, min_books: v => `At least ${v} book(s)` };
            return el("div", { class: "ov-section" },
                el("details", {},
                    el("summary", { text: "Filters and what they've learned" }),
                    el("ul", { class: "ov-status", style: "flex-direction: column; gap: 4px; padding-left: 18px;" },
                        Object.entries(filters).map(([k, v]) => el("li", { text: labels[k] ? labels[k](v) : `${k}: ${v}` }))),
                    report ? el("div", { class: "ov-form" },
                        el("div", { text: `From ${report.settledLegs} settled leg(s)${report.hitRate != null ? `: hit ${pct(report.hitRate)} vs ${pct(report.predictedRate)} predicted` : ""}.` }),
                        (report.changes || []).map(c => el("div", {}, el("strong", { text: `${c.setting}: ${c.from ?? "–"} → ${c.to}` }), " ", el("span", { class: "ov-why", text: c.why }))),
                        (report.notes || []).map(n => el("div", { class: "ov-why", text: n })),
                        (report.missTraits || []).length ? el("div", { class: "ov-why", text: "Misses vs hits: " + report.missTraits.map(t => `${t.metric} ${t.misses} vs ${t.hits}`).join(" · ") }) : null
                    ) : el("div", { class: "ov-why", text: "No results recorded yet." }),
                    el("button", { class: "ov-btn", disabled: Boolean(working), onclick: () => act("Resetting…", "/outlier/reset-weights") }, "Reset filters to defaults")));
        }

        function propsSection() {
            const result = state && state.result;
            if (!result || !result.legs.length) return null;
            return el("div", { class: "ov-section" },
                el("details", {},
                    el("summary", { text: `All props read (${result.legs.length})` }),
                    legRows(result.legs, ["Why not"], l => [el("td", { class: "ov-why", text: l.rejected.length ? l.rejected.join("; ") : "✓ passed" })])));
        }

        function settingsSection() {
            const cfg = (state && state.config) || { pages: [], signInUrl: "" };
            const pages = el("textarea", { "aria-label": "Pages to read" });
            pages.value = cfg.pages.map(p => `${p.kind} ${p.url}`).join("\n");
            const signIn = el("input", { type: "text", value: cfg.signInUrl || "", "aria-label": "Sign-in page" });
            const show = el("input", { type: "checkbox", checked: Boolean(cfg.showBrowser) });
            const save = () => act("Saving…", "/outlier/config", {
                signInUrl: signIn.value,
                showBrowser: show.checked,
                pages: pages.value.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
                    const [first, ...rest] = l.split(/\s+/);
                    return /^https?:/i.test(first) ? { kind: "props", url: first } : { kind: first.toLowerCase(), url: rest.join(" ") };
                })
            });
            return el("div", { class: "ov-section" },
                el("details", {},
                    el("summary", { text: "Pages and sign-in" }),
                    el("div", { class: "ov-form" },
                        el("div", { class: "ov-why", text: "One page per line: a kind (props, odds, slips or history) and its address. Copy the addresses from Outlier while signed in." }),
                        pages,
                        el("label", {}, "Sign-in page ", signIn),
                        el("label", {}, show, " Show the browser while reading (try this if Outlier blocks the hidden one)"),
                        el("div", { class: "ov-actions" },
                            el("button", { class: "ov-btn primary", disabled: Boolean(working), onclick: save }, "Save"),
                            el("button", { class: "ov-btn", disabled: Boolean(working), onclick: async () => {
                                const reply = await act("Saving page snapshots…", "/outlier/snapshot", {}, { reload: false });
                                if (reply) info = reply.detail;
                                render();
                            } }, "Save page snapshot"),
                            el("button", { class: "ov-btn", disabled: Boolean(working), onclick: () => act("Forgetting…", "/outlier/forget-signin") }, "Forget Outlier sign-in")),
                        el("div", { class: "ov-why", text: state ? `Profile, results and history are kept in ${state.dataDir}` : "" }))));
        }

        function render() {
            container.replaceChildren();
            if (!available) {
                container.append(el("h3", { text: "📈 Outlier slips" }),
                    el("div", { class: "ov-note", text: "The Outlier pipeline runs on your computer: start CoDev there (start-codev.bat or npm start) and open http://localhost:3000." }));
                return;
            }
            container.append(...[header(), statusLine(),
                el("div", { class: "ov-note", text: "Hit chances and EV are estimates from market odds and recent games, not guarantees. Bet what you can afford to lose." }),
                error ? el("div", { class: "ov-error", role: "alert", text: error }) : null,
                info ? el("div", { class: "ov-note", role: "status", text: info }) : null,
                (state && state.lastError && !error) ? el("div", { class: "ov-error", text: state.lastError }) : null,
                slipsSection(), trackedSection(), learningSection(), propsSection(), settingsSection()].filter(Boolean));
        }

        render();
        if (available) {
            load();
            let auto = 0;
            try { auto = Number(localStorage.getItem(AUTO_KEY)) || 0; } catch { /* off */ }
            if (auto) setAuto(auto);
        }
        return { refresh: load };
    }

    return { mount };
});
