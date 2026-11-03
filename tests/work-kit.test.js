// Using CoDev at work, and handing it to testers (mobile/www/agent-ui/work-kit.js and
// tester-kit.js): the benefits playbook, the Work kit's one-tap actions, the privacy check
// that offers to hide customer details before a message goes to the AI provider, the
// first-run setup guide and the feedback form. The last tests drive the real page.
// Run: node --test tests/work-kit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kit = require('../mobile/www/agent-ui/work-kit.js');
const Tester = require('../mobile/www/agent-ui/tester-kit.js');
const Expert = require('../mobile/www/agent-ui/expert-coach.js');
const { memoryStorage } = require('./helpers/tool-catalog');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, waitForChat } = require('./helpers/page-driver');

test('benefits and office work get their playbooks', () => {
    assert.equal(Expert.findProfession('benefits advisor').id, 'benefits');
    assert.equal(Expert.findProfession('Employee benefits and health insurance advisor').id, 'benefits');
    assert.equal(Expert.findProfession('Remote office work').id, 'admin');
    assert.deepEqual(Expert.detectProfessions('write the open enrollment email').map(p => p.id), ['benefits']);
    const p = Expert.PROFESSIONS.find(x => x.id === 'benefits');
    assert.match(p.caution, /can't see the user's company systems/);
    // Every role the setup guide offers lands on a playbook, except "something else".
    for (const role of Tester.ROLES.filter(r => r.profession)) assert.ok(Expert.findProfession(role.profession), role.profession);
});

test('the privacy check finds customer details and leaves ordinary numbers alone', () => {
    const text = 'SSN 123-45-6789, DOB: 04/12/1988, card 4111 1111 1111 1111, routing 021000021, acct # 12345678, EIN 12-3456789, MBI 1EG4-TE5-MK73, Member ID: XJH123456789.';
    assert.deepEqual(Kit.findSensitive(text).map(f => f.kind), ['ssn', 'dob', 'card', 'routing', 'account', 'ein', 'mbi', 'member']);
    const masked = Kit.maskSensitive(text);
    assert.equal(masked.count, 8);
    assert.doesNotMatch(masked.text, /6789|1988|1111|021000021|12345678|3456789|MK73|XJH/);
    assert.match(masked.text, /\[SSN hidden\][\s\S]*\[member ID hidden\]/);
    for (const fine of ['Deductible $1,500, out of pocket $6,000', 'Call 1-800-555-1234 or 555-123-4567', 'Ticket #4829173 on 2026-11-03', 'zip 90210', 'card 4111 1111 1111 1112', 'routing 123456789', 'SSN 000-12-3456']) {
        assert.deepEqual(Kit.findSensitive(fine), [], fine);
    }
});

test('the Work kit puts the user field first and wraps the paste in the job prompt', () => {
    const ids = Kit.actionsFor('benefits').map(a => a.id);
    assert.equal(ids[0], 'ben-reply');
    assert.ok(ids.includes('off-summary'));
    assert.equal(Kit.actionsFor('').filter(a => a.kit !== 'office').length, 0);
    const prompt = Kit.buildPrompt(Kit.KITS.office.actions[0], 'Line one\nLine two', 'keep it short');
    assert.match(prompt, /^Draft a reply[\s\S]*Also: keep it short\n\n---\nLine one\nLine two\n---$/);
    const storage = memoryStorage();
    const kit = Kit.createWorkKit({ storage, professionId: () => 'support' });
    assert.ok(kit.saveCustom({ label: '', prompt: 'x' }).error);
    const { action } = kit.saveCustom({ label: 'Weekly status', prompt: 'Turn notes into the weekly status email.' });
    assert.equal(kit.actions()[0].id, action.id);
    assert.equal(kit.actions()[1].id, 'sup-reply');
    kit.removeCustom(action.id);
    assert.equal(kit.actions()[0].id, 'sup-reply');
});

test('feedback reads well as plain text', () => {
    const text = Tester.feedbackText({ at: '2026-11-03T12:00:00Z', name: 'Sam', rating: 4, tried: 'reply to a client', good: 'fast', bad: '', compare: 'better', again: 'yes' }, { app: 'Android app', provider: 'Anthropic', profession: 'Insurance agent' });
    assert.match(text, /^CoDev feedback from Sam \(2026-11-03 12:00\)\nRating: ★★★★☆\nTried to do: reply to a client\nWorked well: fast\nConfusing, slow or broken: —\nCompared to other AI apps: Better\nWould use it again for real work: Yes\nDevice: Android app · AI: Anthropic · Field: Insurance agent$/);
});

test('the page: Work kit, privacy check, setup guide and feedback', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-work-kit-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: ['Here is your reply.', 'Done.'] });
    await page.uncheck('#isSandboxCheckbox');
    // Automated browsers never get the setup guide on their own.
    assert.equal(await page.$('#welcomeModal'), null);

    // Work kit: pick a job, paste text with line breaks, and it goes to the agents whole.
    await page.evaluate(() => { localStorage.setItem('codev_expert_profession', 'benefits advisor'); });
    await page.click('#workKitBtn');
    assert.equal(await page.getAttribute('.work-kit-action >> nth=0', 'data-id'), 'ben-reply');
    await page.click('.work-kit-action[data-id="ben-reply"]');
    await page.fill('#workKitPaste', 'Hi,\nCan I add my newborn to my plan?\nMember ID: XJH123456789');
    await page.click('#workKitRun');
    // The privacy check stops it first.
    await page.waitForSelector('#privacyGuardModal');
    assert.match(await page.textContent('#privacyGuardModal'), /member or policy ID: •+6789/);
    await page.click('#privacyMask');
    await waitForChat(page, /Here is your reply/);
    const [call] = await page.evaluate(() => window.__modelCalls);
    const asked = call.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    assert.match(asked, /Draft a reply to this message from a client or employee about their benefits[\s\S]*Hi,\nCan I add my newborn to my plan\?\nMember ID: \[member ID hidden\]/);
    assert.doesNotMatch(asked, /XJH123456789/);
    assert.match(call.system, /Employee benefits and health insurance advisor playbook/);

    // Cancel keeps the message in the bar and sends nothing; off in Settings means no check.
    await page.fill('#userInput', 'SSN 123-45-6789 please');
    await page.press('#userInput', 'Enter');
    await page.click('#privacyCancel');
    assert.equal(await page.inputValue('#userInput'), 'SSN 123-45-6789 please');
    assert.equal((await page.evaluate(() => window.__modelCalls)).length, 1);
    await page.evaluate(() => { document.getElementById('settingsModal').style.display = 'flex'; document.getElementById('privacySettings').open = true; });
    await page.uncheck('#privacyGuardOn');
    await page.evaluate(() => { document.getElementById('settingsModal').style.display = 'none'; });
    await page.press('#userInput', 'Enter');
    await page.waitForFunction(() => window.__modelCalls.length === 2);
    assert.equal(await page.$('#privacyGuardModal'), null);

    // The setup guide: pick a job, and with a key already saved, step 2 says it's ready.
    await page.evaluate(() => testerWelcome.open());
    await page.click('#welcomeModal [data-value="benefits"]');
    await page.click('#welcomeModal [data-value="new"]');
    await page.click('#welcomeModal [data-value="do"]');
    await page.click('#welcomeNext1');
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_expert_profession')), 'Employee benefits and health insurance advisor');
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_expert_mode')), 'do');
    await page.waitForSelector('#welcomeKeyReady');
    await page.click('#welcomeNext2');
    await page.click('#welcomeDone');
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_welcome_done')), '1');

    // Feedback: saved on the device and copied as text.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    await page.click('#feedbackBtn');
    await page.click('#feedbackModal [data-star="5"]');
    await page.fill('#feedbackBad', 'The menu was hard to find');
    await page.click('#feedbackModal [data-value="better"]');
    await page.click('#feedbackCopy');
    await page.waitForFunction(() => /Copied|copy it/.test(document.getElementById('feedbackStatus').textContent));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('codev_tester_feedback')));
    assert.equal(saved[0].rating, 5);
    assert.equal(saved[0].compare, 'better');
    assert.deepEqual(errors, []);
    await page.close();
});

test('a person opening CoDev the first time gets the setup guide, and can connect a key', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-welcome-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); localStorage.setItem('codev_chime', '0'); });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#welcomeModal');
    await page.click('#welcomeModal [data-value="office"]');
    await page.click('#welcomeNext1');
    // No key yet: Groq's free key is checked for its shape, then saved.
    await page.click('#welcomeModal [data-value="groq"]');
    await page.fill('#welcomeKey', 'not-a-key');
    await page.click('#welcomeSaveKey');
    assert.match(await page.textContent('#welcomeKeyStatus'), /should start with gsk_/);
    await page.fill('#welcomeKey', ' gsk_abcdefghijklmnopqrstuvwxyz123456 ');
    await page.click('#welcomeSaveKey');
    await page.waitForSelector('#welcomeDone');
    assert.match(await page.textContent('#welcomeModal'), /Groq is connected/);
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_groq_key')), 'gsk_abcdefghijklmnopqrstuvwxyz123456');
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_backend')), 'groq');
    // Nothing wider than the phone.
    assert.ok(await page.evaluate(() => document.querySelector('#welcomeModal .modal').getBoundingClientRect().right <= window.innerWidth));
    await page.click('#welcomeDone');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    assert.equal(await page.$('#welcomeModal'), null);
    assert.deepEqual(errors, []);
    await page.close();
});
