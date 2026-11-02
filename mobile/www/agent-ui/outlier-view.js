// The Outlier view: runs the Outlier pipeline (agents/outlier, in the Windows app or on CoDev's server)
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
div.ov-why { font-size: 0.78rem; }
.ov-form { display: flex; flex-direction: column; gap: 8px; font-size: 0.82rem; }
.ov-form textarea, .ov-form input[type=text] { background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; font-family: monospace; font-size: 0.8rem; }
.ov-form textarea { min-height: 70px; }
.ov-select { background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 4px; font-size: 0.78rem; }
.ov-error { color: var(--danger); font-size: 0.82rem; white-space: pre-wrap; }
.ov-pill.var { background: rgba(245,158,11,0.15); color: var(--warning); }
.ov-pill.anchor { background: var(--accent-glow); color: var(--accent); }
.ov-odds { font-size: 1.15rem; font-weight: bold; color: var(--accent); }
.ov-ticket { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-glow); }
.ov-pill.sharp { background: var(--accent); color: var(--bg-dark); }
.ov-pill.under { background: var(--accent-glow); color: var(--accent); border: 1px solid var(--accent); }
.ov-pill.vac { background: rgba(168,85,247,0.15); color: #c084fc; }
.ov-roll { font-family: monospace; white-space: nowrap; }
.ov-mode { display: inline-flex; border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; }
.ov-mode button { background: var(--bg-dark); color: var(--text-muted); border: none; padding: 5px 10px; cursor: pointer; font-size: 0.78rem; }
.ov-mode button.on { background: var(--accent); color: #031623; font-weight: bold; }
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
        for (const child of children.flat(Infinity)) {
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
                el("td", { title: l.metrics && l.metrics.openPrice != null ? `Opened ${price(l.metrics.openPrice)}` : null },
                    price(l.metrics && l.metrics.consensus),
                    l.metrics && l.metrics.marketBooks ? el("span", { class: "ov-why", text: ` · ${l.metrics.books} books${l.metrics.fairSource === "sharp" ? ", sharp" : ""}` }) : null,
                    l.metrics && l.metrics.openPrice != null && l.metrics.openPrice !== l.metrics.consensus
                        ? el("span", { class: "ov-why", text: ` (from ${price(l.metrics.openPrice)})` }) : null),
                el("td", { text: pct(l.metrics && l.metrics.l5) }),
                el("td", { text: l.metrics && l.metrics.floorMargin != null ? `${l.metrics.floorMargin >= 0 ? "+" : ""}${pct(l.metrics.floorMargin)}` : "–" }),
                el("td", { text: pct(l.metrics && l.metrics.p) }),
                ...(extraCell ? extraCell(l) : [])
            )))));
    }

    // Rolling 3/4/5-game averages (✓ when every window clears the line) and the
    // matchup, usage, pace, volume and role signals behind the hit chance.
    function insightCells(l) {
        const m = l.metrics || {};
        const roll = (m.rolling || []).map(w => `${w.games}g ${w.avg}`).join(" · ");
        const tier = l.tier === "variance" ? el("span", { class: "ov-pill var", title: (l.varianceReasons || []).join("; "), text: "variance" })
            : l.tier === "anchor" ? el("span", { class: "ov-pill anchor", text: "high floor" }) : null;
        const div = m.divergence;
        const orphan = div && div.orphaned ? el("span", { class: "ov-pill sharp", title: `Sharp books ${price(div.sharpPrice)} (no-vig ${pct(div.sharpFair, 1)}) vs ${price(div.softPrice)}${div.softBook ? ` at ${div.softBook}` : ""}: ${div.gap >= 0 ? "+" : ""}${pct(div.gap, 1)} edge`, text: `sharp ${price(div.sharpPrice)}` }) : null;
        const vac = m.vacuum && m.vacuum.statLift ? el("span", { class: "ov-pill vac", title: `${m.vacuum.out.join(", ")} out: ${pct(m.vacuum.vacated)} usage freed${m.vacuum.usageAfter ? `, usage to about ${pct(m.vacuum.usageAfter)}` : ""}`, text: `vacuum +${pct(m.vacuum.statLift)}` }) : null;
        return [
            el("td", { class: "ov-roll", title: m.baselineVerified ? "Every 3-5 game window clears the line" : "Not every 3-5 game window clears the line" },
                roll ? `${m.baselineVerified ? "✓ " : m.baselineVerified === false ? "✗ " : ""}${roll}` : "–",
                m.minutesFloor != null ? el("span", { class: "ov-why", text: ` · ${m.minutesFloor} min floor` }) : null),
            el("td", {}, tier, orphan ? [" ", orphan] : null, vac ? [" ", vac] : null, (m.signals || []).length
                ? el("div", { class: "ov-why", text: `${m.insightAdjust ? `${m.insightAdjust > 0 ? "+" : ""}${(m.insightAdjust * 100).toFixed(1)} pts: ` : ""}${m.signals.join("; ")}` }) : null)
        ];
    }

    // openLive(id): shows the live view on the signed-in Outlier browser (the page's).
    function mount(container, { postJson, getJson, available = true, openLive = null } = {}) {
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
            else if (state && state.capture && state.capture.on) pollTimer = setTimeout(watchCapture, 5000);
        }

        // While passive capture runs, pick up new props, but only redraw when something
        // changed and you aren't typing in one of the view's fields.
        async function watchCapture() {
            let next;
            try { next = await getJson("/outlier/state"); } catch { pollTimer = setTimeout(watchCapture, 5000); return; }
            const changed = !state || !next.capture || next.capture.props !== (state.capture || {}).props || !next.capture.on
                || (next.result && next.result.generatedAt) !== (state.result && state.result.generatedAt);
            const typing = container.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
            if (changed && !typing) { state = next; render(); } else if (changed) state = { ...state, capture: next.capture };
            clearTimeout(pollTimer);
            if (next.capture && next.capture.on) pollTimer = setTimeout(watchCapture, 5000);
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
                    // Browse the signed-in browser yourself, then read whatever page is open.
                    state && state.liveSession && openLive ? el("button", { class: "ov-btn", disabled: busy, title: "Open the signed-in Outlier browser in the live view to browse or search it yourself", onclick: () => openLive(state.liveSession) }, "🖥️ Browse") : null,
                    state && state.liveSession ? el("button", { class: "ov-btn", disabled: busy, title: "Read the props on the page open in the Outlier browser now and add them to the analysis", onclick: async () => {
                        const reply = await act("Reading the open page…", "/outlier/read-page", {}, { reload: false });
                        if (reply && reply.read) { info = `Read ${reply.read.props} prop(s) from the open page.`; render(); }
                    } }, "📄 Read this page") : null,
                    state && state.liveSession ? el("button", { class: `ov-btn${state.capture && state.capture.on ? " primary" : ""}`, disabled: Boolean(working),
                        title: "Collect props quietly while you scroll Outlier in the live view: nothing scrolls or clicks for you",
                        onclick: () => act(state.capture && state.capture.on ? "Stopping capture…" : "Starting capture…", "/outlier/capture", { on: !(state.capture && state.capture.on) }) },
                    state.capture && state.capture.on ? "⏺ Capturing" : "⏺ Passive capture") : null,
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
                state.result ? el("span", { text: `${state.result.strategy === "consistency" ? "Consistency (-119)" : "Sharp (-130)"}: ${state.result.counts.passed} of ${state.result.counts.props} props passed${state.result.counts.variance ? `, ${state.result.counts.variance} variance leg(s)` : ""}${state.result.counts.orphaned ? `, ${state.result.counts.orphaned} orphaned line(s)` : ""}` }) : null,
                state.board && state.board.dump ? el("span", { text: `Board written to ${state.board.dump.path.split(/[\\/]/).slice(-2).join("/")}` }) : null,
                state.board && state.board.lastImport ? el("span", { text: `Imported ${state.board.lastImport.props} prop(s) from ${state.board.lastImport.file}` }) : null,
                state.result && state.result.counts.under ? el("span", { text: `${state.result.counts.under} under value leg(s)` }) : null,
                state.capture && (state.capture.on || state.capture.props) ? el("span", { class: state.capture.on ? "good" : "", text: `${state.capture.on ? "● Capturing" : "Capture off"}: ${state.capture.props} prop(s) in the scratchpad${state.capture.error ? ` (${state.capture.error})` : ""}` }) : null,
                state.result && (state.result.ruledOut || []).length ? el("span", { text: `Ruled out: ${state.result.ruledOut.map(o => o.player).join(", ")}` }) : null,
                state.busy === "signin" ? el("span", { text: "Sign-in window open: sign in, then close it." }) : null,
                state.busy && state.progress ? el("span", { class: "good", text: `● ${state.progress}` }) : null,
                working ? el("span", { text: working }) : null);
        }

        // 4-6 leg parlay tickets at the legs' combined book odds.
        function ticketsSection() {
            const result = state && state.result;
            if (!result || !result.tickets) return null;
            const legs = new Map(result.legs.map(l => [l.id, l]));
            const cards = result.tickets.map(t => el("div", { class: "ov-card ov-ticket" },
                el("h4", {}, `${t.size}-leg parlay`,
                    el("span", { class: `ov-pill${t.ev < 0 ? " neg" : ""}`, text: `EV ${t.ev >= 0 ? "+" : ""}${pct(t.ev, 1)}` })),
                el("div", { class: "ov-actions" },
                    el("span", { class: "ov-odds", text: price(t.american) }),
                    el("span", { class: "ov-status", text: `${t.decimal}× · book ${pct(t.impliedProb, 1)} vs model ${pct(t.modelProb, 1)} to hit` })),
                el("div", { class: "ov-why", text: `${t.anchors} high-floor leg(s)${t.varianceLegs ? ` + ${t.varianceLegs} variance leg` : ""} · game script: ${t.script === "reinforcing" ? "legs reinforce each other" : "no same-game links"}` }),
                legRows(t.legs.map(id => legs.get(id)).filter(Boolean), ["3/4/5 games", "Signals"], insightCells),
                (t.matrix || t.correlations || []).map(c => el("div", { class: "ov-why" },
                    `🔗 ${c.legs.map(id => (legs.get(id) || {}).player || id).join(" + ")}: ${c.rho > 0 ? "+" : ""}${c.rho} ${c.why ? `(${c.why})` : ""}`)),
                stakeRow(t)));
            return el("div", { class: "ov-section" },
                el("h3", { text: "Parlay tickets" }),
                el("div", { class: "ov-grid" }, cards.length ? cards : el("div", { class: "ov-note" }, "No tickets this time: not enough legs qualify.")));
        }

        // Soft books still near -119 on props the sharp books have moved to -130 or past.
        function orphanSection() {
            const result = state && state.result;
            const legs = ((result && result.legs) || []).filter(l => l.metrics && l.metrics.divergence && l.metrics.divergence.orphaned);
            if (!legs.length) return null;
            return el("div", { class: "ov-section" },
                el("h3", { text: `Orphaned lines (${legs.length})` }),
                el("div", { class: "ov-why", text: "The sharp books have moved; these books haven't. Edge = sharp no-vig chance minus the soft price's implied chance." }),
                legRows(legs, ["Sharp vs soft", "Signals"], l => {
                    const d = l.metrics.divergence;
                    return [el("td", { text: `${price(d.sharpPrice)} vs ${price(d.softPrice)}${d.softBook ? ` (${d.softBook})` : ""} · ${d.gap >= 0 ? "+" : ""}${pct(d.gap, 1)}` }), insightCells(l)[1]];
                }));
        }

        // Props the core strategy passed on whose under side lines up (routing switch:
        // a prop shows here or in the core picks, never both).
        function underSection() {
            const result = state && state.result;
            const legs = (result && result.underLegs) || [];
            if (!legs.length) return null;
            return el("div", { class: "ov-section" },
                el("h3", {}, `Under value legs (${legs.length}) `, el("span", { class: "ov-pill under", text: "under engine" })),
                el("div", { class: "ov-why", text: "Only props the core strategy didn't keep are checked from the under side, so a prop is never an over pick and an under pick at once. Each needs enough under signals and an edge at the under price." }),
                legRows(legs, ["Edge", "Why under"], l => [
                    el("td", { text: `${l.metrics.p - l.metrics.impliedProb >= 0 ? "+" : ""}${pct(l.metrics.p - l.metrics.impliedProb, 1)}` }),
                    el("td", {}, el("span", { class: "ov-pill under", text: l.tag || "Under Value Leg" }), el("div", { class: "ov-why", text: (l.metrics.underSignals || []).join("; ") }))
                ]));
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
                (slip.correlations || []).map(c => el("div", { class: "ov-why" },
                    `🔗 ${c.legs.map(id => (legs.get(id) || {}).player || id).join(" + ")}: ${c.rho > 0 ? "+" : ""}${c.rho} ${c.why ? `(${c.why})` : ""}`)),
                stakeRow(slip)));
            return el("div", { class: "ov-section" },
                el("div", { class: "ov-grid" }, cards.length ? cards : el("div", { class: "ov-note" }, "No entries this time.")),
                result.notes.map(n => el("div", { class: "ov-note", text: n })));
        }

        // Kelly stake, editable before tracking: what you actually bet is what the bankroll counts.
        function stakeRow(slip) {
            const bank = (state.result && state.result.bankroll) || {};
            const input = el("input", { type: "number", min: "0", step: "0.01", value: slip.stakeUnits ?? 0, class: "ov-select", style: "width: 80px;", "aria-label": "Stake in units" });
            const label = slip.stakeUnits
                ? `Stake ${slip.stakeUnits} u (${pct(slip.stakePct, 1)} of ${bank.current ?? "?"} u; full Kelly ${pct(slip.kellyFull, 1)} × ${bank.kelly_fraction ?? "?"})`
                : "No stake: no edge after the payouts";
            return el("div", { class: "ov-actions" },
                el("span", { class: "ov-status", text: label }),
                input,
                el("button", { class: "ov-btn", disabled: Boolean(working), onclick: () => act("Tracking…", "/outlier/track", { slipId: slip.id, stake: Number(input.value) }) }, "✓ I played this"));
        }

        function trackedSection() {
            const entries = (state && state.history.entries) || [];
            if (!entries.length) return null;
            const open = entries.filter(e => e.legs.some(l => !l.result)).reverse();
            const done = entries.filter(e => e.legs.every(l => l.result)).reverse();
            const entryCard = entry => {
                const picks = {};
                return el("div", { class: "ov-card" },
                    el("h4", {}, `${entry.size}-leg ${entry.type === "parlay" ? `parlay ${price(entry.american)}` : entry.type === "flex" ? "Flex" : "Power"}${entry.stake ? ` · ${entry.stake} u` : ""}`, el("span", { class: "ov-why", text: when(entry.recordedAt) })),
                    legRows(entry.legs, ["Close", "Result"], leg => [el("td", {
                        title: "Closing line value: how far the market's fair chance moved after you took it",
                        text: leg.closeFair != null && leg.metrics && leg.metrics.fairProb != null
                            ? `${price(leg.closePrice)} (${leg.closeFair >= leg.metrics.fairProb ? "+" : ""}${((leg.closeFair - leg.metrics.fairProb) * 100).toFixed(1)} pts)` : "–"
                    }), el("td", {}, el("select", {
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
                        report.clv && report.clv.legs ? el("div", { text: `Closing line value: ${report.clv.average >= 0 ? "+" : ""}${(report.clv.average * 100).toFixed(1)} pts on average over ${report.clv.legs} leg(s), beat the close ${pct(report.clv.beatClose)} of the time${report.clv.verdict ? ` (${report.clv.verdict})` : ""}.` }) : null,
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
                    legRows(result.legs, ["3/4/5 games", "Signals", "Why not"], l => [...insightCells(l),
                        el("td", { class: "ov-why", text: l.rejected.length ? l.rejected.join("; ") : l.tier === "variance" ? `variance leg: ${(l.varianceReasons || []).join("; ")}` : "✓ passed" })])));
        }

        function marketSection() {
            const m = state && state.market;
            if (!m) return null;
            const sum = m.summary;
            const odds = (m.config && m.config.odds_api) || {};
            const espn = (m.config && m.config.espn) || {};
            const cfg = state.config || {};
            const sports = el("input", { type: "text", value: (odds.sports || ["basketball_nba"]).join(", "), "aria-label": "Odds API sports" });
            const props = el("input", { type: "text", value: (odds.prop_markets || []).join(", "), placeholder: "player_points, player_rebounds", "aria-label": "Odds API prop markets" });
            const leagues = el("input", { type: "text", value: (espn.leagues || ["basketball/nba"]).join(", "), "aria-label": "ESPN leagues" });
            const boards = el("textarea", { "aria-label": "Public odds pages", placeholder: "https://… one public odds-comparison page per line" });
            boards.value = (cfg.publicBoards || []).join("\n");
            const on = el("input", { type: "checkbox", checked: cfg.market !== false });
            const feedLine = f => f.error ? `error: ${f.error}` : `${f.source}: ${f.skipped ? f.skipped : `${f.quotes} quotes from ${f.calls} call(s)`}`;
            return el("div", { class: "ov-section" },
                el("details", {},
                    el("summary", { text: `Market odds${sum ? ` (${sum.lines} lines across ${(sum.bookHold || []).length} books)` : ""}` }),
                    el("div", { class: "ov-form" },
                        el("div", { class: "ov-status" },
                            el("span", { class: m.hasOddsApiKey ? "good" : "bad", text: m.hasOddsApiKey ? "● Odds API key set" : "● No ODDS_API_KEY (free at the-odds-api.com; add it to .env)" }),
                            sum && sum.oddsApiRemaining != null ? el("span", { text: `${sum.oddsApiRemaining} free credits left this month` }) : null,
                            m.last ? el("span", { text: `Last refresh ${when(m.last.at)}` }) : null),
                        m.last ? el("div", { class: "ov-why", text: [...(m.last.feeds || []).map(feedLine), ...(m.last.boards || []).map(b => b.error ? `${b.source || "boards"}: ${b.error}` : `${b.source}: ${b.props} props`)].join(" · ") }) : null,
                        sum && sum.bookHold && sum.bookHold.length ? el("div", {},
                            el("strong", { text: "Juice by book " }), el("span", { class: "ov-why", text: "(average hold; lower is sharper)" }),
                            el("div", { class: "ov-why", text: sum.bookHold.map(b => `${b.book} ${pct(b.hold, 1)}`).join(" · ") })) : null,
                        sum && sum.bestEdges && sum.bestEdges.length ? el("div", { class: "ov-scroll" }, el("strong", { text: "Prices better than the no-vig line" }),
                            el("table", { class: "ov-table" },
                                el("thead", {}, el("tr", {}, ["Bet", "Book", "Price", "Fair", "Edge", "Books"].map(h => el("th", { text: h })))),
                                el("tbody", {}, sum.bestEdges.map(e => el("tr", {},
                                    el("td", { text: `${e.subject && e.subject !== "game" ? `${e.subject} ` : ""}${e.side} ${e.line ?? ""} ${e.market}${e.game ? ` (${e.game})` : ""}` }),
                                    el("td", { text: e.book }), el("td", { text: price(e.price) }), el("td", { text: price(e.fairPrice) }),
                                    el("td", { text: `+${(e.edge * 100).toFixed(1)} pts` }), el("td", { text: e.books })))))) : null,
                        el("div", { class: "ov-actions" },
                            el("button", { class: "ov-btn", disabled: Boolean(working || state.busy), onclick: () => act("Refreshing market odds…", "/outlier/market/refresh") }, "⟳ Refresh market odds")),
                        el("label", {}, on, " Cross-reference every scrape with these feeds"),
                        el("label", {}, "Odds API sports ", sports),
                        el("label", {}, "Odds API prop markets (cost credits per game) ", props),
                        el("label", {}, "ESPN leagues ", leagues),
                        el("div", { class: "ov-why", text: "Public odds-comparison pages, one per line. They're read with a fresh, signed-out browser; check each site's terms." }),
                        boards,
                        el("div", { class: "ov-actions" },
                            el("button", { class: "ov-btn primary", disabled: Boolean(working), onclick: async () => {
                                const ok = await act("Saving…", "/outlier/config", { market: on.checked, publicBoards: boards.value.split("\n").map(x => x.trim()).filter(Boolean) }, { reload: false });
                                if (ok) await act("Saving…", "/outlier/market/config", { odds_api: { sports: sports.value, prop_markets: props.value }, espn: { leagues: leagues.value } });
                            } }, "Save")))));
        }

        function strategySection() {
            const result = state && state.result;
            const bank = (result && result.bankroll) || (state && state.weights && state.weights.bankroll) || { units: 100, kelly_fraction: 0.25, max_stake_pct: 0.03 };
            const sizes = (state && state.weights && state.weights.slips && state.weights.slips.sizes) || [4];
            const units = el("input", { type: "number", min: "1", step: "1", value: bank.units ?? bank.start, class: "ov-select", style: "width: 90px;" });
            const kelly = el("select", { class: "ov-select" },
                [[1, "Full Kelly"], [0.5, "Half Kelly"], [0.25, "Quarter Kelly"], [0.125, "Eighth Kelly"]].map(([v, t]) => el("option", { value: v, selected: Number(bank.kelly_fraction) === v }, t)));
            const cap = el("input", { type: "number", min: "0.1", max: "100", step: "0.1", value: ((bank.max_stake_pct ?? 0.03) * 100).toFixed(1), class: "ov-select", style: "width: 70px;" });
            const four = el("input", { type: "checkbox", checked: sizes.includes(4) });
            const six = el("input", { type: "checkbox", checked: sizes.includes(6) });
            const w = (state && state.weights) || {};
            const c = { target_juice: 119, juice_band: 12, hit_rate_min: 0.6, hit_rate_max: 0.75, min_minutes: 24, ...(w.consistency || (result && result.consistency) || {}) };
            let mode = w.strategy || (result && result.strategy) || "sharp";
            const modeBtns = [["sharp", "Sharp: -130+, L5 ≥ 70%"], ["consistency", "Consistency: -119, 60–75%"]].map(([v, t]) => el("button", { type: "button", class: mode === v ? "on" : "", onclick: e => {
                mode = v;
                [...e.target.parentNode.children].forEach(b => b.classList.toggle("on", b === e.target));
            } }, t));
            const numIn = (v, step, width = 64) => el("input", { type: "number", step, value: v, class: "ov-select", style: `width: ${width}px;` });
            const juiceIn = numIn(c.target_juice, 1), bandIn = numIn(c.juice_band, 1, 52), loIn = numIn(Math.round(c.hit_rate_min * 100), 1, 52), hiIn = numIn(Math.round(c.hit_rate_max * 100), 1, 52), minIn = numIn(c.min_minutes, 1, 52);
            const ticketSizes = (w.tickets && w.tickets.sizes) || [4, 5, 6];
            const tBoxes = [4, 5, 6].map(n => [n, el("input", { type: "checkbox", checked: ticketSizes.includes(n) })]);
            const u = { enabled: true, min_signals: 2, ...(w.under || {}) };
            const underOn = el("input", { type: "checkbox", checked: u.enabled !== false });
            const underSignals = numIn(u.min_signals, 1, 52);
            const outs = el("textarea", { "aria-label": "Players ruled out", placeholder: "Joel Embiid, PHI, 31" });
            outs.value = ((w.vacuum && w.vacuum.manual_out) || []).map(o => [o.player, o.team || "", o.usage ?? ""].join(", ").replace(/(, )+$/, "")).join("\n");
            const strategyBox = el("div", { class: "ov-form" },
                el("div", { class: "ov-mode", role: "group", "aria-label": "Strategy" }, modeBtns),
                el("div", { class: "ov-why", text: "Consistency targets props near standard juice whose hit rate sits in a steady band (locked-in role, minutes floor), with every rolling 3-5 game window clearing the line. High-variance legs that otherwise qualify can fill one ticket spot." }),
                el("label", {}, "Target juice -", juiceIn, " ± ", bandIn),
                el("label", {}, "Hit-rate band ", loIn, " % to ", hiIn, " %  · minutes floor ", minIn),
                el("label", {}, "Parlay tickets: ", tBoxes.map(([n, box]) => [box, ` ${n}-leg  `])),
                el("label", {}, underOn, " Under value engine: tag props the strategy passed on when at least ", underSignals, " under signals line up (slow pace, lockdown defense, usage coming back, inflated chalk)"),
                el("div", { class: "ov-why", text: "Ruled out (one per line: player, team, usage %). Their usage is shared out to teammates' scoring, playmaking and rebounding props; players the pages list as out are added on their own." }),
                outs);
            return el("div", { class: "ov-section" },
                el("details", { open: true },
                    el("summary", { text: "Strategy, bankroll and sizes" }),
                    strategyBox,
                    el("div", { class: "ov-form" },
                        bank.current != null ? el("div", { text: `Bankroll ${bank.current} u (started ${bank.start}, peak ${bank.peak}${bank.drawdown ? `, ${pct(bank.drawdown)} below peak` : ""}). Stakes halve when it is ${pct(bank.drawdown_cut)} below its peak.` }) : null,
                        el("label", {}, "Starting bankroll (units) ", units),
                        el("label", {}, "Stake size ", kelly, " capped at ", cap, " % of bankroll per entry"),
                        el("label", {}, four, " 4-leg entries  ", six, " 6-leg entries"),
                        el("div", { class: "ov-actions" },
                            el("button", { class: "ov-btn primary", disabled: Boolean(working), onclick: () => act("Saving…", "/outlier/strategy", {
                                bankroll: { units: Number(units.value), kelly_fraction: Number(kelly.value), max_stake_pct: Number(cap.value) / 100 },
                                sizes: [four.checked && 4, six.checked && 6].filter(Boolean),
                                strategy: mode,
                                consistency: { target_juice: Number(juiceIn.value), juice_band: Number(bandIn.value), hit_rate_min: Number(loIn.value) / 100,
                                    hit_rate_max: Number(hiIn.value) / 100, min_minutes: Number(minIn.value) },
                                ticketSizes: tBoxes.filter(([, box]) => box.checked).map(([n]) => n),
                                under: { enabled: underOn.checked, min_signals: Number(underSignals.value) },
                                ruledOut: outs.value.split("\n").map(line => line.split(",").map(x => x.trim())).filter(([player]) => player)
                                    .map(([player, team, usage]) => ({ player, team: team || null, usage: usage || null }))
                            }) }, "Save")))));
        }

        function settingsSection() {
            const cfg = (state && state.config) || { pages: [], signInUrl: "" };
            const pages = el("textarea", { "aria-label": "Pages to read" });
            pages.value = cfg.pages.map(p => `${p.kind} ${p.url}`).join("\n");
            const signIn = el("input", { type: "text", value: cfg.signInUrl || "", "aria-label": "Sign-in page" });
            const show = el("input", { type: "checkbox", checked: Boolean(cfg.showBrowser) });
            const dump = el("input", { type: "text", value: cfg.boardDump || "", placeholder: "off", "aria-label": "Board dump file" });
            const importDir = el("input", { type: "text", value: cfg.importDir || "", placeholder: "off", "aria-label": "Board import folder" });
            const autoImport = el("input", { type: "checkbox", checked: cfg.autoImport !== false });
            const save = () => act("Saving…", "/outlier/config", {
                signInUrl: signIn.value,
                showBrowser: show.checked,
                boardDump: dump.value,
                importDir: importDir.value,
                autoImport: autoImport.checked,
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
                        el("div", { class: "ov-why", text: "In the project folder: every analysis writes the board (props, tickets, under legs) as JSON to the dump file, and board JSON files saved in the import folder are analyzed as they appear. Leave a field empty to turn it off." }),
                        el("label", {}, "Board dump file ", dump),
                        el("label", {}, "Import folder ", importDir, " ", autoImport, " import automatically"),
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
                ticketsSection(), orphanSection(), underSection(), slipsSection(), trackedSection(), learningSection(), strategySection(), marketSection(), propsSection(), settingsSection()].filter(Boolean));
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
