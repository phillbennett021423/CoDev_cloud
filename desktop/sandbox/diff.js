// Git-format unified diffs ("diff --git a/x b/x" with @@ hunks) in plain JS, so
// the review screen works on computers without git. The output applies with
// `git apply`. Lines are compared with Myers' O(ND) algorithm after trimming the
// common start and end, which keeps typical agent edits cheap.
const CONTEXT_LINES = 3;
const MAX_EDIT_DISTANCE = 4000;
const NO_EOL = '\u0000';

function splitLines(text) {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

// Edit script between two line arrays: [{ op: ' ' | '-' | '+', line }].
// Past MAX_EDIT_DISTANCE it gives up and reports the middle as replaced.
function diffLines(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const head = a.slice(0, start).map(line => ({ op: ' ', line }));
    const tail = a.slice(endA).map(line => ({ op: ' ', line }));
    const middle = myers(a.slice(start, endA), b.slice(start, endB));
    return head.concat(middle, tail);
}

function myers(a, b) {
    const n = a.length, m = b.length;
    if (!n) return b.map(line => ({ op: '+', line }));
    if (!m) return a.map(line => ({ op: '-', line }));
    const max = Math.min(n + m, MAX_EDIT_DISTANCE);
    const offset = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        const next = v.slice();
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            next[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, a, b, d);
        }
        v = next;
    }
    return a.map(line => ({ op: '-', line })).concat(b.map(line => ({ op: '+', line })));
}

function backtrack(trace, a, b, dEnd) {
    const ops = [];
    let x = a.length, y = b.length;
    for (let d = dEnd; d > 0; d--) {
        // trace[d] holds v from before step d, for k in [-d-1, d+1].
        const v = trace[d];
        const at = k => v[k + d + 1];
        const k = x - y;
        const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { ops.push({ op: ' ', line: a[x - 1] }); x--; y--; }
        if (x === prevX) ops.push({ op: '+', line: b[y - 1] });
        else ops.push({ op: '-', line: a[x - 1] });
        x = prevX; y = prevY;
    }
    while (x > 0 && y > 0) { ops.push({ op: ' ', line: a[x - 1] }); x--; y--; }
    return ops.reverse();
}

function hunkRange(start, count) {
    if (count === 1) return String(start);
    return `${count === 0 ? start - 1 : start},${count}`;
}

// A file's patch. oldText/newText are null for an added/deleted file.
function unifiedDiff(path, oldText, newText) {
    const header = [`diff --git a/${path} b/${path}`];
    if (oldText === null) header.push('new file mode 100644');
    if (newText === null) header.push('deleted file mode 100644');
    header.push(oldText === null ? '--- /dev/null' : `--- a/${path}`, newText === null ? '+++ /dev/null' : `+++ b/${path}`);
    // A last line without a newline is marked so it differs from the same line
    // with one, and gets git's "\\ No newline at end of file" after it.
    const mark = (text, lines) => {
        if (text && !text.endsWith('\n') && lines.length) lines[lines.length - 1] += NO_EOL;
        return lines;
    };
    const ops = diffLines(mark(oldText, splitLines(oldText || '')), mark(newText, splitLines(newText || '')));
    let oi = 0, ni = 0;
    const rows = ops.map(op => {
        const row = { ...op, oi, ni };
        if (op.op !== '+') oi++;
        if (op.op !== '-') ni++;
        return row;
    });
    const changed = rows.map((r, i) => (r.op !== ' ' ? i : -1)).filter(i => i >= 0);
    if (!changed.length) return '';
    const out = header;
    for (let i = 0; i < changed.length; i++) {
        const from = Math.max(0, changed[i] - CONTEXT_LINES);
        let to = Math.min(rows.length - 1, changed[i] + CONTEXT_LINES);
        while (i + 1 < changed.length && changed[i + 1] - CONTEXT_LINES <= to + 1) {
            i++;
            to = Math.min(rows.length - 1, changed[i] + CONTEXT_LINES);
        }
        const slice = rows.slice(from, to + 1);
        const oldCount = slice.filter(r => r.op !== '+').length, newCount = slice.filter(r => r.op !== '-').length;
        out.push(`@@ -${hunkRange(slice[0].oi + 1, oldCount)} +${hunkRange(slice[0].ni + 1, newCount)} @@`);
        for (const r of slice) {
            const noEol = r.line.endsWith(NO_EOL);
            out.push(r.op + (noEol ? r.line.slice(0, -1) : r.line));
            if (noEol) out.push('\\ No newline at end of file');
        }
    }
    return out.join('\n') + '\n';
}

function diffStats(patch) {
    let added = 0, removed = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
}

module.exports = { unifiedDiff, diffLines, diffStats };
