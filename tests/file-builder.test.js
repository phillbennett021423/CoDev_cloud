// Native files (mobile/www/agent-ui/file-builder.js): the zip, the formula engine, xlsx
// sheets with formulas and formats, pptx and docx parts, CSV quoting, web app checks, and
// the tools. When Python with openpyxl / python-pptx / python-docx is installed, the files
// are also opened by those libraries, as Excel and PowerPoint readers would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../mobile/www/agent-ui/file-builder.js');

const text = bytes => new TextDecoder().decode(bytes);

test('the zip is readable and its CRCs are right', () => {
    const bytes = F.zip([['a.txt', 'hello'], ['dir/b.txt', new Uint8Array([1, 2, 3])]]);
    const files = F.unzipStored(bytes);
    assert.equal(text(files['a.txt']), 'hello');
    assert.deepEqual([...files['dir/b.txt']], [1, 2, 3]);
    assert.equal(F.crc32(new TextEncoder().encode('hello')), 0x3610a686);
});

test('formulas: arithmetic, ranges, other sheets, functions and errors', () => {
    const cells = { 'S!0:0': 2, 'S!1:0': 3, 'S!2:0': 'x', 'Other!0:1': 10 };
    const lookup = (sheet, r, c) => cells[`${sheet}!${r}:${c}`] ?? null;
    const ev = f => F.evaluateFormula(f, 'S', lookup);
    assert.equal(ev('A1*A2+1'), 7);
    assert.equal(ev('SUM(A1:A3)'), 5);
    assert.equal(ev('AVERAGE(A1:A2)'), 2.5);
    assert.equal(ev("Other!B1/2"), 5);
    assert.equal(ev("'Other'!B1+A1"), 12);
    assert.equal(ev('ROUND(10/3, 2)'), 3.33);
    assert.equal(ev('IF(A2>A1,"up","down")'), 'up');
    assert.equal(ev('IFERROR(1/0, 0)'), 0);
    assert.equal(ev('2^3-10%'), 7.9);
    assert.throws(() => ev('1/0'), /#DIV\/0!/);
    assert.throws(() => ev('NOPE(1)'), /#NAME\?/);
});

test('a workbook: sheets, header, formats, totals row, cached formula values and checks', () => {
    const built = F.buildXlsx({ sheets: [
        { name: 'Sales: Q1?', columns: ['Region', { header: 'Revenue', format: 'currency' }, 'Share'], rows: [['N', '$1,000', '=B2/B$4'], ['S', 3000, '=B3/B$4']], total_row: true },
        { name: 'Summary', rows: [['Total', "='Sales Q1'!B4"], ['Broken', '=1/0']] }
    ] });
    assert.deepEqual(built.sheets.map(s => s.name), ['Sales Q1', 'Summary']);
    const files = F.unzipStored(built.bytes);
    const sheet = text(files['xl/worksheets/sheet1.xml']);
    assert.match(sheet, /<c r="B2" s="2"><v>1000<\/v><\/c>/, 'text money became a currency number');
    assert.match(sheet, /<c r="B4" s="10"><f>SUM\(B2:B3\)<\/f><v>4000<\/v><\/c>/);
    assert.match(sheet, /<pane ySplit="1"/);
    assert.match(sheet, /<autoFilter ref="A1:C3"\/>/);
    assert.match(text(files['xl/workbook.xml']), /fullCalcOnLoad="1"/);
    const byCell = Object.fromEntries(built.checks.map(c => [`${c.sheet}!${c.cell}`, c.value]));
    assert.equal(byCell['Sales Q1!C2'], 0.25);
    assert.equal(byCell['Summary!B1'], 4000);
    assert.equal(byCell['Summary!B2'], '#DIV/0!');
    assert.match(text(files['xl/worksheets/sheet2.xml']), /t="e"><f>1\/0<\/f><v>#DIV\/0!<\/v>/);
});

test('slides and documents have every part Office needs', () => {
    const deck = F.unzipStored(F.buildPptx({ title: 'Deck', slides: [{ title: 'One', bullets: ['a', '  b'], notes: 'hi' }, { layout: 'stats', title: 'KPIs', stats: [{ value: '9', label: 'x' }] }, { title: 'T', table: { columns: ['A'], rows: [[1]] } }] }).bytes);
    for (const part of ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/slides/slide4.xml', 'ppt/notesSlides/notesSlide2.xml']) assert.ok(deck[part], part);
    assert.match(text(deck['ppt/slides/slide3.xml']), /KPIs/);
    assert.match(text(deck['ppt/slides/slide4.xml']), /<a:tbl>/);
    const doc = F.unzipStored(F.buildDocx({ markdown: '# Title\n\nSome **bold** text.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |' }).bytes);
    const body = text(doc['word/document.xml']);
    assert.match(body, /w:val="Title"/);
    assert.match(body, /<w:b\/><\/w:rPr><w:t xml:space="preserve">bold/);
    assert.match(body, /<w:numId w:val="1"\/>/);
    assert.match(body, /<w:tbl>/);
    assert.throws(() => F.buildPptx({ slides: [] }), /at least one slide/);
});

test('CSV quoting, web app checks and preview inlining', () => {
    assert.equal(F.buildCsv(['a', 'b'], [['x,y', 'say "hi"'], { a: 1, b: null }]), '﻿a,b\r\n"x,y","say ""hi"""\r\n1,\r\n');
    const app = F.buildWebApp({ files: { 'index.html': '<head><link rel="stylesheet" href="./s.css"></head><script src="a.js"></script><img src="gone.png">', 's.css': 'p{}', 'a.js': 'let x = ;', 'data.json': '{bad' } }, { compile: code => new Function(code) });
    assert.ok(app.problems.some(p => /^a\.js:/.test(p)));
    assert.ok(app.problems.some(p => /data\.json/.test(p)));
    assert.ok(app.problems.some(p => /gone\.png/.test(p)));
    assert.match(app.preview, /<style>\/\* s\.css \*\/\np\{\}/);
    assert.match(app.preview, /<script>\/\* a\.js \*\//);
    assert.throws(() => F.buildWebApp({ files: { '../x.html': '' } }), /valid file path/);
    assert.throws(() => F.buildWebApp({ files: { 'a.png': 'x' } }), /only text files/);
});

test('the tools deliver files to the reply and fill sheets from datasets', async () => {
    const datasets = F.createDatasetStore();
    const ds = datasets.add({ name: 'Scraped', rows: [{ name: 'A', price: '$5.00' }, { name: 'B', price: '$7.50' }] });
    const saved = [];
    const tools = Object.fromEntries(F.buildFileTools({ datasets, saveFile: async r => { saved.push(r); return { id: `f${saved.length}` }; } }).map(t => [t.name, t]));
    const ctx = {};
    const out = await tools.create_spreadsheet.run({ filename: 'prices', sheets: [{ name: 'Prices', dataset: ds.id, total_row: true }] }, ctx);
    assert.match(out, /Prices!B4 =SUM\(B2:B3\) → 12\.5/);
    assert.equal(ctx.generatedFiles[0].name, 'prices.xlsx');
    assert.match(await tools.create_spreadsheet.run({ sheets: [{ dataset: 'ds9' }] }, ctx), /no dataset "ds9"/);
    assert.match(await tools.create_csv.run({ dataset: ds.id, filename: 'p' }, ctx), /Made p\.csv \(2 rows/);
    assert.match(await tools.list_datasets.run({}), /ds1 "Scraped": 2 rows × 2 columns/);
    assert.match(await tools.create_web_app.run({ files: { 'index.html': '<p>hi</p>' } }, ctx), /Syntax check: passed/);
    assert.deepEqual(ctx.generatedFiles.map(f => f.format), ['xlsx', 'csv', 'webapp']);
});

// The files opened by real readers, when this computer has them.
test('openpyxl, python-pptx and python-docx open the files', t => {
    let python = null;
    for (const cmd of ['python3', 'python']) {
        try { execFileSync(cmd, ['-c', 'import openpyxl, pptx, docx'], { stdio: 'ignore' }); python = cmd; break; } catch { /* next */ }
    }
    if (!python) return t.skip('Python with openpyxl, python-pptx and python-docx is not installed');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-office-'));
    fs.writeFileSync(path.join(dir, 'a.xlsx'), F.buildXlsx({ sheets: [{ name: 'S', columns: ['n', 'v'], rows: [['a', 2], ['b', 3]], total_row: true }] }).bytes);
    fs.writeFileSync(path.join(dir, 'a.pptx'), F.buildPptx({ title: 'T', slides: [{ title: 'One', bullets: ['x'], notes: 'n' }, { title: 'Tab', table: { columns: ['a'], rows: [[1]] } }] }).bytes);
    fs.writeFileSync(path.join(dir, 'a.docx'), F.buildDocx({ markdown: '# Doc\n\n- item\n\n| a |\n|---|\n| 1 |' }).bytes);
    const script = 'import sys, openpyxl, pptx, docx\nd = sys.argv[1]\nwb = openpyxl.load_workbook(d + "/a.xlsx", data_only=True)\nprint(wb["S"]["B4"].value)\nprint(len(pptx.Presentation(d + "/a.pptx").slides))\ndoc = docx.Document(d + "/a.docx")\nprint(doc.paragraphs[0].text, len(doc.tables))';
    const out = execFileSync(python, ['-c', script, dir]).toString().trim().split('\n');
    assert.deepEqual(out, ['5', '3', 'Doc 1']);
});
