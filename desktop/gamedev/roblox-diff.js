// Line diffs between the project's scripts on disk and what the place open in Studio has,
// for roblox_diff (review before syncing) and roblox_sync (never overwrite an edit the user
// made in Studio without saying so).
//
//   readStudioLuau(entries, nonce) -> Luau that prints each mapped script's class and source
//   parseStudioSources(output, nonce, count) -> [{ exists, className, source }]
//   lineDiff(before, after, context) -> { added, removed, hunks: [string] }
//   hashSource(source) -> short sha256, kept per script in .codev/roblox-sync.json
const crypto = require('crypto');

function luauString(value) { return JSON.stringify(String(value)); }

function readStudioLuau(entries, nonce) {
    const lines = [
        'local function find(names)',
        '    local ok, inst = pcall(function() return game:GetService(names[1]) end)',
        '    if not ok then return nil end',
        '    for i = 2, #names do',
        '        inst = inst and inst:FindFirstChild(names[i])',
        '    end',
        '    return inst',
        'end'
    ];
    entries.forEach((e, i) => {
        lines.push(`do local s = find({ ${e.instancePath.map(p => luauString(p.name)).join(', ')} })`);
        lines.push(`    if s and s:IsA("LuaSourceContainer") then print("<<${nonce} ${i} " .. s.ClassName) print(s.Source) print(">>${nonce} ${i}")`);
        lines.push(`    else print("<<${nonce} ${i} MISSING") print(">>${nonce} ${i}") end end`);
    });
    return lines.join('\n');
}

function parseStudioSources(output, nonce, count) {
    const out = Array.from({ length: count }, () => ({ exists: false, className: '', source: '' }));
    const re = new RegExp(`<<${nonce} (\\d+) (\\w+)\\r?\\n([\\s\\S]*?)\\r?\\n?>>${nonce} \\1`, 'g');
    let m;
    while ((m = re.exec(String(output)))) {
        const i = Number(m[1]);
        if (i >= count) continue;
        out[i] = m[2] === 'MISSING' ? { exists: false, className: '', source: '' } : { exists: true, className: m[2], source: m[3].replace(/\r\n/g, '\n') };
    }
    return out;
}

// The longest common subsequence of lines, as edit operations (removed lines before the
// added lines that replace them, like git). Big files fall back to a
// count when the table would be too large.
function lineDiff(before, after, context = 2) {
    const a = String(before).replace(/\n$/, '').split('\n');
    const b = String(after).replace(/\n$/, '').split('\n');
    if (before === after) return { added: 0, removed: 0, hunks: [] };
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length; let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    if (midA.length * midB.length > 4e6) {
        return { added: midB.length, removed: midA.length, hunks: [`@@ lines ${start + 1}-${endA} replaced (${midA.length} lines out, ${midB.length} in; too big to show line by line)`] };
    }
    const n = midA.length; const m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    const ops = [];
    for (let i = 0; i < start; i++) ops.push([' ', a[i], i + 1]);
    let i = 0; let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && midA[i] === midB[j]) { ops.push([' ', midA[i], start + i + 1]); i++; j++; } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) { ops.push(['-', midA[i], start + i + 1]); i++; } else { ops.push(['+', midB[j], start + i + 1]); j++; }
    }
    for (let k = endA; k < a.length; k++) ops.push([' ', a[k], k + 1]);
    const added = ops.filter(o => o[0] === '+').length;
    const removed = ops.filter(o => o[0] === '-').length;
    // Hunks: changed lines with `context` unchanged lines around them.
    const keep = ops.map((o, idx) => o[0] !== ' ' || ops.slice(Math.max(0, idx - context), idx + context + 1).some(x => x[0] !== ' '));
    const hunks = [];
    let cur = null;
    ops.forEach((o, idx) => {
        if (!keep[idx]) { if (cur) { hunks.push(cur.join('\n')); cur = null; } return; }
        if (!cur) cur = [`@@ line ${o[2]}`];
        cur.push(`${o[0]} ${o[1]}`);
    });
    if (cur) hunks.push(cur.join('\n'));
    return { added, removed, hunks };
}

function hashSource(source) {
    return crypto.createHash('sha256').update(String(source).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

module.exports = { readStudioLuau, parseStudioSources, lineDiff, hashSource };
