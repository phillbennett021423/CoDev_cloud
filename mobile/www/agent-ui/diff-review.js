// The diff review screen: shows what agents changed in their sandbox, file by
// file, with each file's syntax checks, and writes nothing to the real project
// until the user approves. Files whose checks failed can't be approved.
//
//   CodevDiffReview.open({ changeset, client }) -> Promise<{ decision, paths, result }>
//     decision: "approved" (result is the server's { written, skipped }; left
//               lists the files not approved, which stay pending on the server),
//               "rejected", or "deferred" (closed with Keep for later or Esc;
//               the changeset stays pending on the server).
//
// Needs agent-client.js loaded first (CodevAgentClient.buildReviewModel). All text
// from the diff is set with textContent, never as HTML.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("./agent-client.js"));
    else root.CodevDiffReview = factory(root.CodevAgentClient);
})(typeof self !== "undefined" ? self : this, function (AgentClient) {
    "use strict";

    const MAX_LINES_PER_FILE = 2000;
    const STATUS_BADGE = { added: "A", modified: "M", deleted: "D", renamed: "R" };
    const STYLE_ID = "codev-diff-review-style";
    const CSS = `
.cdr-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; z-index: 2000; padding: 16px; }
.cdr-panel { background: var(--bg-panel, #111827); color: var(--text-main, #f3f4f6); border: 1px solid var(--border-color, #374151); border-radius: 10px; width: min(1100px, 100%); max-height: calc(100dvh - 32px); display: flex; flex-direction: column; box-shadow: 0 10px 25px rgba(0,0,0,0.5); overflow: hidden; }
.cdr-head { padding: 16px 20px 12px; border-bottom: 1px solid var(--border-color, #374151); display: flex; flex-direction: column; gap: 6px; }
.cdr-head h3 { font-size: 1.05rem; margin: 0; }
.cdr-sub { font-size: 0.8rem; color: var(--text-muted, #9ca3af); overflow-wrap: anywhere; }
.cdr-stats { font-size: 0.8rem; display: flex; gap: 12px; flex-wrap: wrap; }
.cdr-add { color: var(--success, #10b981); }
.cdr-del { color: var(--danger, #ef4444); }
.cdr-warn { color: var(--warning, #f59e0b); }
.cdr-body { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; min-height: 0; flex: 1; }
.cdr-files { border-right: 1px solid var(--border-color, #374151); overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.cdr-file { display: grid; grid-template-columns: auto auto 1fr; gap: 6px 8px; align-items: center; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
.cdr-file:hover, .cdr-file.cdr-current { background: var(--bg-card, #1f2937); }
.cdr-file input { margin: 0; width: 16px; height: 16px; }
.cdr-path { font-family: monospace; overflow-wrap: anywhere; }
.cdr-file .cdr-meta { grid-column: 2 / 4; display: flex; gap: 6px; flex-wrap: wrap; font-size: 0.72rem; }
.cdr-badge { display: inline-block; min-width: 18px; text-align: center; border-radius: 4px; font-size: 0.7rem; font-weight: 700; padding: 1px 4px; background: var(--bg-card, #1f2937); border: 1px solid var(--border-color, #374151); }
.cdr-badge[data-status="added"] { color: var(--success, #10b981); }
.cdr-badge[data-status="deleted"] { color: var(--danger, #ef4444); }
.cdr-badge[data-status="modified"], .cdr-badge[data-status="renamed"] { color: var(--accent, #0ea5e9); }
.cdr-check { border-radius: 10px; padding: 0 6px; border: 1px solid currentColor; }
.cdr-check[data-state="ok"] { color: var(--success, #10b981); }
.cdr-check[data-state="failed"] { color: var(--danger, #ef4444); }
.cdr-check[data-state="skipped"] { color: var(--text-muted, #9ca3af); }
.cdr-diffs { overflow: auto; padding: 8px 12px 16px; min-width: 0; }
.cdr-diff { border: 1px solid var(--border-color, #374151); border-radius: 6px; margin-top: 10px; overflow: hidden; }
.cdr-diff > summary { cursor: pointer; padding: 8px 10px; background: var(--bg-card, #1f2937); font-family: monospace; font-size: 0.8rem; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cdr-blocked-note { padding: 8px 10px; font-size: 0.78rem; color: var(--danger, #ef4444); border-bottom: 1px solid var(--border-color, #374151); overflow-wrap: anywhere; white-space: pre-wrap; }
.cdr-table { width: 100%; border-collapse: collapse; font-family: monospace; font-size: 0.76rem; line-height: 1.45; }
.cdr-table td { padding: 0 8px; vertical-align: top; white-space: pre; }
.cdr-table td.cdr-no { width: 1%; text-align: right; color: var(--text-muted, #9ca3af); user-select: none; }
.cdr-table td.cdr-mark { width: 1%; user-select: none; padding: 0 2px; }
.cdr-table tr.cdr-l-add { background: rgba(16,185,129,0.14); }
.cdr-table tr.cdr-l-del { background: rgba(239,68,68,0.14); }
.cdr-table tr.cdr-l-hunk td { color: var(--codev-purple, #8b5cf6); background: rgba(139,92,246,0.08); padding: 2px 8px; }
.cdr-table tr.cdr-l-meta td { color: var(--text-muted, #9ca3af); font-style: italic; }
.cdr-empty { padding: 10px; font-size: 0.8rem; color: var(--text-muted, #9ca3af); }
.cdr-error { margin: 0 20px; padding: 8px 10px; border: 1px solid var(--danger, #ef4444); color: var(--danger, #ef4444); border-radius: 6px; font-size: 0.8rem; overflow-wrap: anywhere; }
.cdr-foot { padding: 12px 20px; border-top: 1px solid var(--border-color, #374151); display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; align-items: center; }
.cdr-foot .cdr-note { margin-right: auto; font-size: 0.75rem; color: var(--text-muted, #9ca3af); }
.cdr-btn { border-radius: 4px; padding: 10px 14px; font-weight: 700; font-size: 0.8rem; cursor: pointer; border: 1px solid var(--border-color, #374151); background: var(--bg-card, #1f2937); color: var(--text-main, #f3f4f6); min-height: 40px; }
.cdr-btn:disabled { opacity: 0.5; cursor: default; }
.cdr-btn-approve { background: var(--success, #10b981); border-color: var(--success, #10b981); color: #04130d; }
.cdr-btn-reject { color: var(--danger, #ef4444); border-color: var(--danger, #ef4444); }
@media (max-width: 760px) {
  .cdr-overlay { padding: 0; }
  .cdr-panel { max-height: 100dvh; height: 100dvh; border-radius: 0; }
  .cdr-body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .cdr-files { border-right: none; border-bottom: 1px solid var(--border-color, #374151); max-height: 32dvh; }
  .cdr-foot .cdr-note { flex-basis: 100%; }
  .cdr-foot .cdr-btn { flex: 1; }
}`;

    function el(doc, tag, attrs, children) {
        const node = doc.createElement(tag);
        for (const [key, value] of Object.entries(attrs || {})) {
            if (value === undefined || value === null || value === false) continue;
            if (key === "text") node.textContent = value;
            else if (key === "className") node.className = value;
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? "" : String(value));
        }
        for (const child of children || []) if (child) node.appendChild(child);
        return node;
    }

    function ensureStyle(doc) {
        if (doc.getElementById(STYLE_ID)) return;
        doc.head.appendChild(el(doc, "style", { id: STYLE_ID, text: CSS }));
    }

    function checkPill(doc, check) {
        const state = check.skipped ? "skipped" : check.ok === false ? "failed" : "ok";
        const icon = state === "ok" ? "✓" : state === "failed" ? "✗" : "–";
        return el(doc, "span", { className: "cdr-check", "data-state": state, title: check.message || "", text: `${icon} ${check.name}` });
    }

    function renderDiffTable(doc, file) {
        if (file.binary) return el(doc, "div", { className: "cdr-empty", text: "Binary file: no text diff to show." });
        if (!file.hunks.length) return el(doc, "div", { className: "cdr-empty", text: file.status === "deleted" ? "File deleted." : "No line changes (empty file or mode change)." });
        const tbody = el(doc, "tbody");
        let shown = 0;
        let total = 0;
        for (const hunk of file.hunks) {
            total += hunk.lines.length + 1;
            if (shown >= MAX_LINES_PER_FILE) continue;
            tbody.appendChild(el(doc, "tr", { className: "cdr-l-hunk" }, [el(doc, "td", { colspan: 4, text: hunk.header })]));
            shown++;
            for (const line of hunk.lines) {
                if (shown >= MAX_LINES_PER_FILE) break;
                const mark = line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "meta" ? "\\" : " ";
                tbody.appendChild(el(doc, "tr", { className: `cdr-l-${line.type}` }, [
                    el(doc, "td", { className: "cdr-no", text: line.oldNo ?? "" }),
                    el(doc, "td", { className: "cdr-no", text: line.newNo ?? "" }),
                    el(doc, "td", { className: "cdr-mark", text: mark }),
                    el(doc, "td", { text: line.text })
                ]));
                shown++;
            }
        }
        const table = el(doc, "table", { className: "cdr-table" }, [tbody]);
        if (total <= shown) return table;
        const wrap = el(doc, "div", {}, [table]);
        wrap.appendChild(el(doc, "div", { className: "cdr-empty", text: `${total - shown} more diff lines not shown.` }));
        return wrap;
    }

    // Opens the review screen. Resolves once the user approves (and the server
    // wrote the files), rejects, or keeps the changes for later.
    function open({ changeset, client, document: doc = (typeof document !== "undefined" ? document : null), title } = {}) {
        if (!doc) return Promise.reject(new Error("The diff review needs a page to show in."));
        if (!client) return Promise.reject(new Error("The diff review needs an agent client."));
        ensureStyle(doc);
        const model = AgentClient.buildReviewModel(changeset);
        const selected = new Set(model.approvable);
        const previousFocus = doc.activeElement;

        return new Promise(resolve => {
            const fileRows = [];
            const diffBlocks = new Map();
            let busy = false;

            const errorBox = el(doc, "div", { className: "cdr-error", role: "alert" });
            errorBox.hidden = true;

            const approveBtn = el(doc, "button", { className: "cdr-btn cdr-btn-approve", type: "button", "data-action": "approve" });
            const rejectBtn = el(doc, "button", { className: "cdr-btn cdr-btn-reject", type: "button", "data-action": "reject", text: "Reject all" });
            const laterBtn = el(doc, "button", { className: "cdr-btn", type: "button", "data-action": "defer", text: "Keep for later" });

            function refreshApprove() {
                approveBtn.textContent = `Approve & save (${selected.size})`;
                approveBtn.disabled = busy || selected.size === 0;
                rejectBtn.disabled = busy;
                laterBtn.disabled = busy;
            }

            function close(outcome) {
                doc.removeEventListener("keydown", onKey, true);
                overlay.remove();
                if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
                resolve(outcome);
            }

            function showError(err) {
                errorBox.textContent = err && err.message ? err.message : String(err);
                errorBox.hidden = false;
            }

            async function act(kind) {
                if (busy) return;
                busy = true;
                errorBox.hidden = true;
                refreshApprove();
                try {
                    if (kind === "approve") {
                        const paths = model.approvable.filter(p => selected.has(p));
                        // Send the paths only when the user narrowed the selection; the
                        // server then applies its own default (every file that passed).
                        const narrowed = paths.length !== model.approvable.length;
                        const result = await client.approve(model.id, narrowed ? paths : undefined);
                        // Unselected and blocked files stay staged on the server for a later review.
                        const left = model.files.map(f => f.path).filter(p => !paths.includes(p));
                        close({ decision: "approved", paths, left, result: result || {} });
                    } else {
                        await client.reject(model.id, "Rejected in the review screen");
                        close({ decision: "rejected", paths: [], result: null });
                    }
                } catch (err) {
                    busy = false;
                    refreshApprove();
                    showError(err);
                }
            }

            function onKey(event) {
                if (event.key === "Escape" && !busy) {
                    event.preventDefault();
                    close({ decision: "deferred", paths: [], result: null });
                }
            }

            function focusFile(path) {
                fileRows.forEach(r => r.row.classList.toggle("cdr-current", r.path === path));
                const block = diffBlocks.get(path);
                if (block) {
                    block.open = true;
                    if (typeof block.scrollIntoView === "function") block.scrollIntoView({ block: "start", behavior: "smooth" });
                }
            }

            const fileList = el(doc, "div", { className: "cdr-files", role: "list", "aria-label": "Changed files" });
            const diffs = el(doc, "div", { className: "cdr-diffs" });

            model.files.forEach((file, index) => {
                const box = el(doc, "input", { type: "checkbox", "aria-label": `Include ${file.path}`, "data-path": file.path });
                box.checked = selected.has(file.path);
                box.disabled = file.blocked;
                box.addEventListener("click", event => event.stopPropagation());
                box.addEventListener("change", () => {
                    if (box.checked) selected.add(file.path); else selected.delete(file.path);
                    refreshApprove();
                });
                const meta = el(doc, "div", { className: "cdr-meta" }, [
                    el(doc, "span", { className: "cdr-add", text: `+${file.additions}` }),
                    el(doc, "span", { className: "cdr-del", text: `−${file.deletions}` }),
                    ...file.checks.map(c => checkPill(doc, c))
                ]);
                const row = el(doc, "div", {
                    className: "cdr-file", role: "listitem", "data-path": file.path, "data-blocked": file.blocked ? "true" : "false",
                    title: file.blocked ? `Can't be saved: ${file.blockedReason}` : file.path,
                    onclick: () => focusFile(file.path)
                }, [
                    box,
                    el(doc, "span", { className: "cdr-badge", "data-status": file.status, text: STATUS_BADGE[file.status] || "?" }),
                    el(doc, "span", { className: "cdr-path", text: file.path }),
                    meta
                ]);
                fileRows.push({ path: file.path, row });
                fileList.appendChild(row);

                const details = el(doc, "details", { className: "cdr-diff", "data-path": file.path }, [
                    el(doc, "summary", {}, [
                        el(doc, "span", { className: "cdr-badge", "data-status": file.status, text: STATUS_BADGE[file.status] || "?" }),
                        el(doc, "span", { text: file.path }),
                        el(doc, "span", { className: "cdr-add", text: `+${file.additions}` }),
                        el(doc, "span", { className: "cdr-del", text: `−${file.deletions}` })
                    ]),
                    file.blocked ? el(doc, "div", { className: "cdr-blocked-note", text: `Blocked, won't be saved: ${file.blockedReason}` }) : null,
                    renderDiffTable(doc, file)
                ]);
                // Big reviews start with only the first few files expanded.
                details.open = index < 6;
                diffBlocks.set(file.path, details);
                diffs.appendChild(details);
            });
            if (!model.files.length) diffs.appendChild(el(doc, "div", { className: "cdr-empty", text: "This change set has no file changes." }));

            const totals = model.totals;
            const head = el(doc, "div", { className: "cdr-head" }, [
                el(doc, "h3", { id: "cdrTitle", text: title || "Review agent changes before saving" }),
                (model.summary || model.submittedBy) ? el(doc, "div", { className: "cdr-sub", text: [model.submittedBy, model.summary].filter(Boolean).join(": ") }) : null,
                el(doc, "div", { className: "cdr-stats" }, [
                    el(doc, "span", { text: `${totals.files} file${totals.files === 1 ? "" : "s"}` }),
                    el(doc, "span", { className: "cdr-add", text: `+${totals.additions}` }),
                    el(doc, "span", { className: "cdr-del", text: `−${totals.deletions}` }),
                    totals.blocked ? el(doc, "span", { className: "cdr-warn", text: `${totals.blocked} blocked by failed checks` }) : null
                ])
            ]);

            approveBtn.addEventListener("click", () => act("approve"));
            rejectBtn.addEventListener("click", () => act("reject"));
            laterBtn.addEventListener("click", () => { if (!busy) close({ decision: "deferred", paths: [], result: null }); });

            const panel = el(doc, "div", { className: "cdr-panel" }, [
                head,
                el(doc, "div", { className: "cdr-body" }, [fileList, diffs]),
                errorBox,
                el(doc, "div", { className: "cdr-foot" }, [
                    el(doc, "span", { className: "cdr-note", text: "Nothing is written to your project until you approve." }),
                    laterBtn, rejectBtn, approveBtn
                ])
            ]);
            const overlay = el(doc, "div", { className: "cdr-overlay", id: "diffReviewOverlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "cdrTitle", "data-changeset": model.id }, [panel]);
            refreshApprove();
            doc.body.appendChild(overlay);
            doc.addEventListener("keydown", onKey, true);
            (selected.size ? approveBtn : laterBtn).focus();
        });
    }

    return { open, MAX_LINES_PER_FILE };
});
