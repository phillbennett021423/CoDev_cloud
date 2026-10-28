// Big files and image making (mobile/www/media-tools.js): long PDFs read in full
// and paged through with read_attachment, spreadsheets queried over every row
// with query_table, video and audio through Gemini or Whisper, and pictures from
// generate_image. Every outside service is answered by page.route, so no key or
// network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat, answerApprovals } = require('./helpers/page-driver');

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function openPlainPage(t, steps) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-media-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const opened = await openPage(launched.browser, url, { steps });
    await opened.page.uncheck('#isSandboxCheckbox');
    return opened;
}

// A PDF with one line of text per page.
function makePdf(pageTexts) {
    const objects = [];
    const add = body => { objects.push(body); return objects.length; };
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const pagesId = objects.length + 1;
    objects.push(null);   // the Pages object, filled in below
    const kids = pageTexts.map(text => {
        // pdf.js skips text past the page's edge, so long text goes on several lines.
        const lines = text.replace(/[()\\]/g, '').match(/.{1,80}(\s|$)/g) || [''];
        const stream = `BT /F1 10 Tf 14 TL 40 760 Td ${lines.map(line => `(${line}) Tj T*`).join(' ')} ET`;
        const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
        return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
    });
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    let out = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

function crc32(buf) {
    let crc = ~0;
    for (const byte of buf) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (~crc) >>> 0;
}

// A zip with deflated entries, as Excel writes them.
function makeZip(files) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const data = Buffer.from(text);
        const packed = zlib.deflateRawSync(data);
        const nameBuf = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
        local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, packed);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + packed.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}

function makeXlsx() {
    const shared = ['Team', 'Player', 'Points', 'Date', 'Lakers', 'Celtics', 'James', 'Tatum', 'Davis', 'Brown'];
    const s = text => shared.indexOf(text);
    const rows = [
        ['Team', 'Player', 'Points', 'Date'],
        ['Lakers', 'James', 31, 45292],
        ['Celtics', 'Tatum', 28, 45293],
        ['Lakers', 'Davis', 22, 45294],
        ['Celtics', 'Brown', 19, 45295]
    ];
    const cells = rows.map((row, r) => `<row r="${r + 1}">` + row.map((v, c) => {
        const ref = `${'ABCD'[c]}${r + 1}`;
        if (typeof v === 'string') return `<c r="${ref}" t="s"><v>${s(v)}</v></c>`;
        return `<c r="${ref}"${c === 3 ? ' s="1"' : ''}><v>${v}</v></c>`;
    }).join('') + '</row>').join('');
    return makeZip({
        '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Box scores" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map(t => `<si><t>${t}</t></si>`).join('')}</sst>`,
        'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
        'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`
    });
}

async function attach(page, name, mimeType, buffer) {
    await page.setInputFiles('#attachmentInput', { name, mimeType, buffer });
    await page.waitForFunction(name => pendingAttachments.some(a => a.name === name && !a.processing), name, { timeout: 30000 });
    return page.evaluate(name => {
        const att = pendingAttachments.find(a => a.name === name);
        return { kind: att.kind, text: att.text, pageCount: att.pageCount, fullLength: (att.fullText || '').length, rows: att.sheets ? att.sheets.map(s => s.rows.length) : null };
    }, name);
}

test('a long PDF goes in as its start, and read_attachment reads any page or finds a phrase', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const filler = 'Background notes about the league schedule and travel. '.repeat(18);
    const pages = Array.from({ length: 60 }, (_, i) => `Page body ${i + 1}. ${i === 46 ? 'The secret rebate code is MANGO-77.' : ''} ${filler}`);
    const { page, errors } = await openPlainPage(t, [
        [{ name: 'read_attachment', arguments: { pages: '47' } }],
        [{ name: 'read_attachment', arguments: { query: 'rebate code' } }],
        'The rebate code is MANGO-77, on page 47.'
    ]);
    const att = await attach(page, 'season-guide.pdf', 'application/pdf', makePdf(pages));
    assert.equal(att.kind, 'pdf');
    assert.equal(att.pageCount, 60);
    assert.ok(att.fullLength > 60000, `kept all the text (${att.fullLength})`);
    assert.match(att.text, /Only the first 12,000 are below/);
    assert.match(att.text, /read_attachment/);
    assert.ok(att.text.length < 14000);

    await sendPrompt(page, 'What is the rebate code in this guide?');
    await waitForChat(page, /MANGO-77, on page 47/);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(calls[0].tools.includes('read_attachment'));
    const results = calls.at(-1).messages.filter(m => m.role === 'tool').map(m => m.content);
    assert.match(results[0], /--- Page 47 ---[\s\S]*MANGO-77/);
    assert.doesNotMatch(results[0], /--- Page 48 ---/);
    assert.match(results[1], /\[page 47\][\s\S]*MANGO-77/);

    // The file is kept for this chat: a later message can still read it.
    const kept = await page.evaluate(() => chatAttachments(activeChatId).then(list => list.map(e => e.name)));
    assert.deepEqual(kept, ['season-guide.pdf']);
    assert.deepEqual(errors, []);
});

test('a spreadsheet is summarized, and query_table does exact math over every row', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const lines = ['Team,Player,Points,Note'];
    for (let i = 0; i < 3000; i++) lines.push(`${['Lakers', 'Celtics', 'Knicks'][i % 3]},Player ${i},${i % 50},"note, with comma ${i}"`);
    const { page, errors } = await openPlainPage(t, [
        [{ name: 'query_table', arguments: { action: 'group', group_by: 'Team', value_column: 'Points', aggregate: 'sum' } }],
        [{ name: 'query_table', arguments: { action: 'rows', filters: [{ column: 'Points', op: '>=', value: '49' }, { column: 'Team', op: '=', value: 'knicks' }], columns: ['Player', 'Points'], limit: 3 } }],
        'Totals are in.'
    ]);
    const att = await attach(page, 'box.csv', 'text/csv', Buffer.from(lines.join('\n')));
    assert.equal(att.kind, 'sheet');
    assert.deepEqual(att.rows, [3000]);
    assert.match(att.text, /3,000 rows × 4 columns/);
    assert.match(att.text, /Points \(number: min 0, max 49/);
    assert.match(att.text, /call query_table/);

    await sendPrompt(page, 'Total points per team?');
    await waitForChat(page, /Totals are in\./);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(calls[0].tools.includes('query_table'));
    const results = calls.at(-1).messages.filter(m => m.role === 'tool').map(m => m.content);
    // Exact sums: team k gets rows i ≡ k (mod 3), points i mod 50.
    const sums = [0, 0, 0];
    for (let i = 0; i < 3000; i++) sums[i % 3] += i % 50;
    assert.match(results[0], new RegExp(`Lakers,${sums[0]},1000`));
    assert.match(results[0], new RegExp(`Celtics,${sums[1]},1000`));
    assert.match(results[0], new RegExp(`Knicks,${sums[2]},1000`));
    assert.match(results[1], /Player,Points\nPlayer 149,49\nPlayer 299,49\nPlayer 449,49/);
    assert.deepEqual(errors, []);
});

test('an .xlsx workbook is read with its sheet names, shared strings and dates', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    const att = await attach(page, 'stats.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', makeXlsx());
    assert.equal(att.kind, 'sheet');
    assert.deepEqual(att.rows, [4]);
    assert.match(att.text, /Sheet "Box scores": 4 rows × 4 columns/);
    assert.match(att.text, /Lakers,James,31,2024-01-01/);
    const stats = await page.evaluate(() => runTableQuery({ name: 'stats.xlsx', sheets: pendingAttachments[0].sheets }, { action: 'stats', columns: ['Points'] }));
    assert.match(stats, /Points: count 4, sum 100, average 25, median 25, min 19, max 31/);
    const old = await page.evaluate(async () => {
        await handleAttachmentPick({ files: [new File(['x'], 'old.xls')], set value(v) {} });
        return pendingAttachments.some(a => a.name === 'old.xls');
    }).catch(err => err.message);
    assert.equal(old, false);
    assert.deepEqual(errors, []);
});

test('generate_image makes a picture with the free service when no key is set, and shows it under the reply', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, [
        [{ name: 'generate_image', arguments: { prompt: 'A red panda astronaut, studio lighting', aspect_ratio: '16:9' } }],
        'Here is your red panda astronaut.'
    ]);
    const requested = [];
    await page.route('https://image.pollinations.ai/**', route => {
        requested.push(route.request().url());
        route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX, headers: { 'access-control-allow-origin': '*' } });
    });
    page.on('dialog', dialog => dialog.dismiss());
    await answerApprovals(page, () => false);
    await sendPrompt(page, 'Make me a picture of a red panda astronaut');
    await waitForChat(page, /Here is your red panda astronaut/);
    assert.equal(requested.length, 1);
    assert.match(requested[0], /red%20panda%20astronaut/);
    assert.match(requested[0], /width=1344&height=768/);
    const reply = await page.evaluate(() => chatSessions.find(s => s.id === activeChatId).messages.at(-1));
    assert.equal(reply.attachments.length, 1);
    assert.match(reply.attachments[0].thumb, /^data:image\/jpeg/);
    assert.equal(reply.attachments[0].fullUrl, undefined);
    const saved = await page.evaluate(id => loadGeneratedImage(id), reply.attachments[0].generatedId);
    assert.match(saved.url, /^data:image\/png;base64,/);
    assert.equal(await page.locator('#chatFeed img.generated').count(), 1);
    await page.click('#chatFeed img.generated');
    await page.waitForSelector('#generatedImageViewer a[download]');
    const usage = await page.evaluate(() => imageUsageToday());
    assert.equal(usage.count, 1);
    assert.deepEqual(errors, []);
});

test('with a Gemini key, pictures come from Nano Banana, and the per-task and daily limits hold', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    const bodies = [];
    await page.route('https://generativelanguage.googleapis.com/**', route => {
        bodies.push({ url: route.request().url(), key: route.request().headers()['x-goog-api-key'], body: JSON.parse(route.request().postData() || '{}') });
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: PNG_1PX.toString('base64') }] }] }) });
    });
    const result = await page.evaluate(async () => {
        geminiKey = 'AIzaTestKeyForCoDevMediaTools123';
        const ctx = { attachedImages: ['data:image/jpeg;base64,AAAA'] };
        const tools = await buildMediaTools(ctx);
        const tool = tools.find(t => t.name === 'generate_image');
        const outs = [];
        outs.push(await tool.run({ prompt: 'Put a hat on him', edit_attached_images: true }, ctx));
        for (let i = 0; i < 4; i++) outs.push(await tool.run({ prompt: `Picture ${i}` }, ctx));
        dailyImageLimit = 4;
        const daily = await tool.run({ prompt: 'One more' }, { });
        return { description: tool.description, outs, made: ctx.generatedImages.length, daily };
    });
    assert.match(result.description, /Gemini \(Nano Banana\)/);
    assert.match(result.outs[0], /Made the picture/);
    assert.match(result.outs[4], /4 pictures is the limit for one task/);
    assert.equal(result.made, 4);
    assert.match(result.daily, /today's limit of 4/);
    assert.equal(bodies[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(bodies[0].key, 'AIzaTestKeyForCoDevMediaTools123');
    assert.equal(bodies[0].body.model, 'gemini-3.1-flash-lite-image');
    assert.deepEqual(bodies[0].body.input.map(p => p.type), ['image', 'text']);
    assert.deepEqual(errors, []);
});

test('a video gets frames plus Gemini watching it with sound, or Whisper transcribing it', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    const seen = [];
    await page.route('https://generativelanguage.googleapis.com/**', route => {
        seen.push(JSON.parse(route.request().postData() || '{}'));
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '0:03 the guard hits a three; commentator says "what a shot".' }] }] }) });
    });
    await page.route('https://api.groq.com/openai/v1/audio/transcriptions', route => route.fulfill({
        status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ text: 'What a shot from downtown.' }) }));
    const out = await page.evaluate(async () => {
        const file = new File([new Uint8Array(2048)], 'clip.mp4', { type: 'video/mp4' });
        geminiKey = 'AIzaTestKeyForCoDevMediaTools123';
        const withGemini = { text: 'Video clip "clip.mp4".', images: [] };
        await addVideoUnderstanding(file, withGemini, 12);
        geminiKey = '';
        const withWhisper = { text: 'Video clip "clip.mp4".', images: [] };
        await addVideoUnderstanding(file, withWhisper, 12);
        const audio = { name: 'call.m4a', images: [] };
        await prepareAudio(new File([new Uint8Array(512)], 'call.m4a', { type: 'audio/mp4' }), audio);
        groqKey = '';
        const none = { text: 'Video clip "clip.mp4".', images: [] };
        await addVideoUnderstanding(file, none, 12);
        return { gemini: withGemini.text, whisper: withWhisper.text, audio: audio.text, none: none.text };
    });
    assert.match(out.gemini, /\[Gemini watched the whole video with sound\][\s\S]*what a shot/);
    assert.equal(seen[0].model, 'gemini-3.5-flash-lite');
    assert.equal(seen[0].input[0].type, 'video');
    assert.equal(seen[0].input[0].mime_type, 'video/mp4');
    assert.ok(seen[0].input[0].data.length > 100);
    assert.match(out.whisper, /\[Transcript of the video's sound, by Whisper\]\nWhat a shot from downtown\./);
    assert.match(out.audio, /Audio "call.m4a", transcribed by Whisper:\nWhat a shot/);
    assert.match(out.none, /free Gemini key/);
    assert.deepEqual(errors, []);
});

test('Settings saves the Gemini key and image choices, and refuses a key that isn\'t one', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    await page.evaluate(() => openSettingsModal());
    await page.evaluate(() => { document.getElementById('mediaSettings').open = true; });
    await page.fill('#modalGeminiKey', 'not-a-key');
    await page.click('#modalLaunchBtn');
    await page.waitForFunction(() => /start with AIza/.test(document.getElementById('settingsError').textContent));
    await page.fill('#modalGeminiKey', 'AIzaSyTestKeyForCoDevSettings12345');
    await page.selectOption('#modalImageProvider', 'gemini');
    await page.selectOption('#modalImageQuality', 'pro');
    await page.fill('#modalDailyImageLimit', '7');
    await page.click('#modalLaunchBtn');
    await page.waitForFunction(() => localStorage.getItem('codev_gemini_key') === 'AIzaSyTestKeyForCoDevSettings12345');
    const saved = await page.evaluate(() => ({ provider: localStorage.getItem('codev_image_provider'), quality: geminiImageQuality, limit: dailyImageLimit, service: imageService() }));
    assert.deepEqual(saved, { provider: 'gemini', quality: 'pro', limit: 7, service: 'gemini' });
    assert.deepEqual(errors, []);
});
