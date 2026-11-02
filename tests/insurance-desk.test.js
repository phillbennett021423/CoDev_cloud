// Insurance Desk (mobile/www/agent-ui/insurance-desk.js): the client book, enrollment-date
// alerts, Scopes of Appointment, commission reconciliation, encryption and backups, the
// agents' insurance_* tools, and runs in the real page. The model is a stand-in, so no key
// is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Desk = require('../mobile/www/agent-ui/insurance-desk.js');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');

function memoryStorage() {
    const data = {};
    return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

function sampleBook() {
    const storage = memoryStorage();
    const docs = Desk.memoryDocs();
    const store = Desk.createDeskStore(storage, { docs });
    const ruth = store.saveClient({ name: 'Ruth Alvarez', dob: '1962-01-15', zip: '33101', county: 'Miami-Dade', state: 'fl', phone: '(305) 555-0142',
        doctors: [{ name: 'Dr. Ana Pérez', specialty: 'Cardiology' }], medications: [{ name: 'Eliquis', dose: '5 mg', frequency: 'twice a day' }] }).client;
    const ben = store.saveClient({ name: 'Ben Okafor', dob: '1955-06-02' }).client;
    store.savePolicy(ben.id, { planType: 'mapd', carrier: 'Humana', planName: 'Gold Plus HMO', policyNumber: 'H1036-077', effectiveDate: '2025-01-01', status: 'active',
        commission: { type: 'annual_monthly', amount: 720 } });
    const kim = store.saveClient({ name: 'Kim Tran', dob: '1988-03-09', members: [{ name: 'Leo Tran', relation: 'child', dob: '2015-08-01' }] }).client;
    store.savePolicy(kim.id, { planType: 'aca', carrier: 'Ambetter', policyNumber: 'U7781234', memberId: 'AMB-55', effectiveDate: '2026-01-01', status: 'active', membersCovered: 2,
        premium: 412.5, commission: { type: 'pmpm', amount: 20 } });
    const sam = store.saveClient({ name: 'Sam Reed', dob: '1970-12-20' }).client;
    store.savePolicy(sam.id, { planType: 'term', carrier: 'Mutual of Omaha', policyNumber: 'TL-99', effectiveDate: '2020-12-10', status: 'active', faceAmount: 250000, conversionDeadline: '2027-01-20' });
    store.savePolicy(sam.id, { planType: 'dvh', carrier: 'Delta', effectiveDate: '2026-10-01', status: 'pending' });
    return { store, storage, docs, ruth, ben, kim, sam };
}

test('dates read loosely, and the Initial Enrollment Period is 3 months either side of the 65th birthday month', () => {
    assert.equal(Desk.parseDate('3/15/2026'), '2026-03-15');
    assert.equal(Desk.parseDate('2026-02-30'), null);
    assert.equal(Desk.parseDate('Mar 5, 1960'), '1960-03-05');
    assert.equal(Desk.parseMonth('March 2026'), '2026-03');
    assert.equal(Desk.parseMonth('04/2026'), '2026-04');
    assert.equal(Desk.ageOn('1962-01-15', '2027-01-14'), 64);
    assert.equal(Desk.ageOn('1962-01-15', '2027-01-15'), 65);
    assert.deepEqual(Desk.iepWindow('1962-01-15'), { birthday65: '2027-01-15', start: '2026-10-01', end: '2027-04-30', medicareStart: '2027-01-01' });
    assert.equal(Desk.iepWindow('1962-05-01').medicareStart, '2027-04-01', 'a birthday on the 1st starts Medicare the month before');
});

test('clients and policies save, merge only the fields given, log every change and survive a reload', () => {
    const { store, storage, ruth } = sampleBook();
    assert.equal(store.saveClient({ name: 'ruth alvarez', _new: true }).error, 'There\'s already a client named "ruth alvarez".');
    const r = store.saveClient({ id: ruth.id, email: 'ruth@example.com' });
    assert.equal(r.created, false);
    assert.equal(r.client.zip, '33101');
    assert.equal(r.client.state, 'FL');
    assert.match(r.client.log[r.client.log.length - 1].what, /^Edited email/);
    assert.equal(store.client('Ben Okafor').status, 'client', 'an active policy makes a lead a client');
    assert.equal(store.client('Leo Tran').name, 'Kim Tran', 'a household member finds the household');
    assert.deepEqual(store.search('humana').map(c => c.name), ['Ben Okafor']);
    assert.deepEqual(store.search('555-0142').map(c => c.name), ['Ruth Alvarez']);

    const again = Desk.createDeskStore(storage);
    assert.equal(again.clients().length, 4);
    assert.equal(again.client('Kim Tran').policies[0].commission.amount, 20);
    assert.equal(again.client('Ruth Alvarez').medications[0].name, 'Eliquis');
});

test('alerts: turning 65, AEP, MA and ACA open enrollment, renewals, pending policies, conversions and follow-ups', () => {
    const { store, ruth, ben } = sampleBook();
    store.saveClient({ id: ben.id, followUp: '2026-11-03', followUpNote: 'Send the AEP comparison' });
    const alerts = Desk.computeAlerts(store.clients(), '2026-11-01', { horizon: 90 });
    const find = (type, name) => alerts.find(a => a.type === type && a.clientName === name);
    const t65 = find('turning65', 'Ruth Alvarez');
    assert.equal(t65.urgency, 'now');
    assert.equal(t65.start, '2026-10-01');
    assert.match(t65.title, /turns 65 on Jan 15, 2027/);
    assert.equal(find('aep', 'Ben Okafor').urgency, 'now');
    assert.equal(find('maOep', 'Ben Okafor').start, '2027-01-01');
    assert.equal(find('acaOep', 'Kim Tran').urgency, 'now');
    assert.equal(find('renewal', 'Sam Reed').start, '2026-12-10');
    assert.equal(find('pending', 'Sam Reed').urgency, 'now', 'a policy still pending past its start date');
    assert.equal(find('conversion', 'Sam Reed').start, '2027-01-20');
    assert.equal(find('followUp', 'Ben Okafor').urgency, 'soon');
    assert.equal(find('turning65', 'Ben Okafor'), undefined, 'already 65 and on Medicare');
    assert.equal(alerts.filter(a => a.type === 'renewal' && a.clientName === 'Kim Tran').length, 0, 'ACA plans renew at open enrollment');

    // In January the open enrollment that started last November is still running.
    const jan = Desk.computeAlerts(store.clients(), '2027-01-10', { horizon: 30 });
    assert.equal(jan.find(a => a.type === 'acaOep').end, '2027-01-15');
    // Once Ruth has a Medicare plan, her turning-65 alert goes away.
    store.savePolicy(ruth.id, { planType: 'medsupp', carrier: 'Aetna', status: 'pending', effectiveDate: '2027-01-01' });
    assert.equal(Desk.computeAlerts(store.clients(), '2026-11-01').some(a => a.type === 'turning65'), false);

    const ics = Desk.alertsToIcs(alerts);
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.equal(ics.match(/BEGIN:VEVENT/g).length, alerts.length);
    assert.match(ics, /DTSTART;VALUE=DATE:20261001/);
});

test('an SOA needs products and a signature, follows the 48-hour rule and its exceptions, and shows tampering', async () => {
    const { store, ben } = sampleBook();
    assert.match((await store.addSoa({ clientId: ben.id, products: [], signatureMethod: 'typed', typedName: 'Ben Okafor' })).error, /Tick at least one/);
    assert.match((await store.addSoa({ clientId: ben.id, products: ['ma'], signatureMethod: 'drawn' })).error, /hasn't signed/);

    const rushed = (await store.addSoa({ clientId: ben.id, products: ['ma', 'pdp'], signatureMethod: 'typed', typedName: 'Ben Okafor',
        appointmentDate: '2026-11-03', appointmentTime: '10:00', signedAt: new Date('2026-11-02T15:00:00').toISOString() })).soa;
    const checks = Desk.soaChecks(rushed, ben, '2026-11-02');
    assert.equal(checks[0].level, 'bad');
    assert.match(checks[0].text, /Signed 19 hours before/);
    assert.match(checks[1].text, /Good until Nov 2, 2027/);

    const walkIn = (await store.addSoa({ clientId: ben.id, products: ['ma'], signatureMethod: 'typed', typedName: 'Ben Okafor', walkIn: true, initiatedBy: 'beneficiary',
        appointmentDate: '2026-11-02', appointmentTime: '16:00', signedAt: new Date('2026-11-02T15:00:00').toISOString() })).soa;
    assert.match(Desk.soaChecks(walkIn, ben)[0].text, /allowed for a walk-in/);
    const lastDays = (await store.addSoa({ clientId: ben.id, products: ['ma'], signatureMethod: 'typed', typedName: 'Ben Okafor',
        appointmentDate: '2026-12-06', appointmentTime: '16:00', signedAt: new Date('2026-12-06T09:00:00').toISOString() })).soa;
    assert.match(Desk.soaChecks(lastDays, ben)[0].text, /last 4 days of AEP/);

    assert.equal(await Desk.verifySoa(rushed), true);
    assert.equal(await Desk.verifySoa({ ...rushed, products: ['ma', 'pdp', 'medsupp'] }), false, 'a changed SOA no longer matches its fingerprint');
    const html = Desk.soaHtml(rushed);
    assert.match(html, /Scope of Sales Appointment Confirmation/);
    assert.match(html, /SHA-256 [0-9a-f]{64}/);
    assert.ok(Desk.computeAlerts(store.clients(), '2027-10-20', { soas: store.soas() }).some(a => a.type === 'soa'), 'expiring SOA alert');
});

test('commission statements: columns are found, chargebacks and short, missing and unmatched payments are flagged', () => {
    const { store } = sampleBook();
    const csv = [
        'Ambetter Health - Agent Commission Statement',
        'Run date: 04/02/2026',
        'Member Name,Member ID,Plan Name,Pay Period,Commission Amount,Transaction Type',
        '"TRAN, KIM",AMB-55,Ambetter Balanced Care,01/2026,$40.00,New',
        '"TRAN, KIM",AMB-55,Ambetter Balanced Care,02/2026,$20.00,Renewal',
        '"TRAN, KIM",AMB-55,Ambetter Balanced Care,03/2026,($40.00),Chargeback',
        'Pat Doe,AMB-99,Ambetter Value,03/2026,$18.00,New'
    ].join('\n');
    const rows = Desk.parseCsv(csv);
    const table = rows.slice(2);
    const map = Desk.detectColumns(table[0]);
    assert.deepEqual(map, { policy: 1, name: 0, amount: 4, month: 3, carrier: -1, kind: 5 });
    const lines = Desk.statementLines(table, map, { carrier: 'Ambetter' });
    assert.deepEqual(lines.map(l => [l.month, l.amount]), [['2026-01', 40], ['2026-02', 20], ['2026-03', -40], ['2026-03', 18]]);
    assert.ok(store.addStatement({ carrier: 'Ambetter', fileName: 'ambetter.csv', lines }).statement);

    // Humana pays Ben by name only ("OKAFOR, BEN") and skips March.
    store.addStatement({ carrier: 'Humana', month: '2026-01', fileName: 'humana-jan.csv', lines: [{ name: 'OKAFOR, BEN', amount: 60 }] });
    store.addStatement({ carrier: 'Humana', month: '2026-02', fileName: 'humana-feb.csv', lines: [{ name: 'Ben Okafor', amount: 45 }] });

    const r = Desk.reconcile(store.clients(), store.statements(), { from: '2026-01', to: '2026-03', tolerance: 1 });
    const row = (name, month) => r.rows.find(x => x.clientName === name && x.month === month);
    assert.equal(row('Kim Tran', '2026-01').status, 'paid');
    assert.equal(row('Kim Tran', '2026-02').status, 'short');
    assert.equal(row('Kim Tran', '2026-03').status, 'chargeback');
    assert.equal(row('Ben Okafor', '2026-01').status, 'paid');
    assert.equal(row('Ben Okafor', '2026-01').matchedBy, 'name');
    assert.equal(row('Ben Okafor', '2026-02').status, 'short');
    assert.equal(row('Ben Okafor', '2026-03').status, 'missing');
    assert.equal(r.unmatched.length, 1);
    assert.equal(r.unmatched[0].name, 'Pat Doe');
    assert.equal(r.totals.chargebacks, 1);
    assert.equal(r.totals.shortfall, 20 + 80 + 15 + 60);
    assert.match(Desk.reconcileCsv(r), /"missing","2026-03","Ben Okafor","Humana"/);
});

test('a passphrase encrypts the book and its documents; a backup restores on another device', async () => {
    const { store, storage, docs, ruth } = sampleBook();
    const added = await store.addDocument(ruth.id, { name: 'drug-list.txt', type: 'text/plain', bytes: new TextEncoder().encode('Eliquis 5mg'), kind: 'drug_list' });
    assert.match(added.document.sha256, /^[0-9a-f]{64}$/);
    assert.equal((await store.setPassphrase('short')).error, 'Use at least 8 characters.');
    assert.ok((await store.setPassphrase('correct horse battery')).ok);
    await store.flush();
    const raw = storage.data[Desk.STORE_KEY];
    assert.doesNotMatch(raw, /Ruth|Eliquis|33101/, 'nothing readable in storage');
    assert.ok(JSON.parse(raw).enc.ct);
    const docRecord = await docs.get(added.document.id);
    assert.ok(docRecord.enc && !docRecord.b64, 'documents are re-encrypted with the passphrase');

    const reopened = Desk.createDeskStore(storage, { docs });
    assert.equal(reopened.isLocked(), true);
    assert.deepEqual(reopened.clients(), []);
    assert.equal((await reopened.unlock('wrong passphrase')).error, 'That passphrase doesn\'t open this desk.');
    assert.ok((await reopened.unlock('correct horse battery')).ok);
    assert.equal(reopened.client('Ruth Alvarez').county, 'Miami-Dade');
    assert.equal(new TextDecoder().decode((await reopened.readDocument(added.document.id)).bytes), 'Eliquis 5mg');

    const backup = await reopened.exportBackup();
    assert.doesNotMatch(backup, /Ruth/);
    const phone = Desk.createDeskStore(memoryStorage(), { docs: Desk.memoryDocs() });
    assert.equal((await phone.importBackup(backup)).needsPassphrase, true);
    assert.equal((await phone.importBackup(backup, 'correct horse battery')).clients, 4);
    assert.equal(phone.isEncrypted(), true);
    assert.equal(new TextDecoder().decode((await phone.readDocument(added.document.id)).bytes), 'Eliquis 5mg');

    assert.equal(reopened.lock(), true);
    assert.equal(reopened.saveClient({ name: 'X' }).error, 'The desk is locked.');
    await reopened.unlock('correct horse battery');
    assert.ok((await reopened.removePassphrase()).ok);
    await reopened.flush();
    assert.match(storage.data[Desk.STORE_KEY], /Ruth Alvarez/);
    assert.equal(new TextDecoder().decode((await reopened.readDocument(added.document.id)).bytes), 'Eliquis 5mg');
});

test('agents get no client data until the user allows it; then they look up, update, quote and check commissions', async () => {
    const { store, kim } = sampleBook();
    assert.equal(Desk.isDeskTask(store, 'Who on my book is turning 65?'), false, 'agent access is off by default');
    assert.deepEqual(Desk.buildDeskTools(store), []);
    assert.equal(Desk.deskPromptBlock(store, 'medicare question'), '');

    store.saveSettings({ agentAccess: true, agentName: 'Pat Agent' });
    assert.equal(Desk.isDeskTask(store, 'Who on my book is turning 65?'), true);
    assert.equal(Desk.isDeskTask(store, 'fix the privacy policy page'), false);
    assert.equal(Desk.isDeskTask(store, 'Call Ruth Alvarez back tomorrow'), true, 'a client\'s name counts');
    assert.match(Desk.deskPromptBlock(store, 'medicare question'), /never put names, birth dates, drugs or doctors into web searches/);

    let saved = 0;
    const tools = Object.fromEntries(Desk.buildDeskTools(store, { agentName: 'Scout', onSaved: () => saved++ }).map(t => [t.name, t]));
    assert.deepEqual(Object.keys(tools), ['insurance_clients', 'insurance_alerts', 'insurance_save_client', 'insurance_add_note', 'insurance_quote_brief', 'insurance_save_quote', 'insurance_commissions']);
    assert.match(await tools.insurance_clients.run({ name: 'Ruth Alvarez' }), /Prescriptions: Eliquis 5 mg twice a day/);
    assert.match(await tools.insurance_clients.run({ query: 'ambetter' }), /Kim Tran/);

    assert.match(await tools.insurance_save_client.run({ name: 'Kim Tran', phone: '555-1000', policy: { policyNumber: 'U7781234', premium: 430, commission: { type: 'monthly', amount: 999 } } }), /Updated Kim Tran\. Updated its ACA/);
    const pol = store.client(kim.id).policies[0];
    assert.equal(pol.premium, 430);
    assert.equal(pol.commission.type, 'pmpm', 'agents can\'t change commission rates');
    assert.match(store.client(kim.id).log.slice(-1)[0].what, /\(Scout\)/);
    assert.match(await tools.insurance_save_client.run({ name: 'Dana Fox', dob: '1961-09-30', zip: '30301' }), /Added Dana Fox/);

    assert.match(await tools.insurance_add_note.run({ client: 'Kim Tran', text: 'Wants a lower deductible.', kind: 'call' }), /Note added/);
    const brief = await tools.insurance_quote_brief.run({ client: 'Ruth Alvarez' });
    assert.match(brief, /ZIP 33101, Miami-Dade County, FL/);
    assert.match(brief, /Dr\. Ana Pérez, Cardiology/);
    assert.match(brief, /Medicare Plan Finder: https:\/\/www\.medicare\.gov\/plan-compare\//);
    assert.match(await tools.insurance_save_quote.run({ client: 'Ruth Alvarez', portal: 'Medicare Plan Finder', plans: [{ carrier: 'Humana', plan: 'Gold Plus', premium: 0, moop: 4900 }] }), /Saved 1 plans/);
    assert.equal(store.client('Ruth Alvarez').quotes[0].plans[0].moop, 4900);
    assert.match(await tools.insurance_alerts.run({ days: 30 }), /Ruth Alvarez turns 65/);
    assert.match(await tools.insurance_commissions.run({}), /No commission statements/);
    assert.equal(saved, 4);
    assert.doesNotMatch(Object.keys(tools).join(), /remove|delete|soa/, 'no tools to delete or sign');

    store.saveSettings({ agentAccess: false });
    assert.match(await tools.insurance_clients.run({ name: 'Kim Tran' }), /turned off agent access/);
});

// ---------- in the real page ----------

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

async function openDeskPage(t, steps, viewport) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-insurance-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const opened = await openPage(launched.browser, url, { steps });
    if (viewport) await opened.page.setViewportSize(viewport);
    await opened.page.uncheck('#isSandboxCheckbox').catch(() => {});
    // Dialogs answer yes, and prompts with the test passphrase.
    opened.page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'test passphrase 1' : undefined));
    return opened;
}

test('in the page: add a client and a policy, see the alert, sign an SOA, import a statement, encrypt and unlock', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openDeskPage(t, []);
    await page.evaluate(() => switchView('insurance'));
    await page.click('#view-insurance button[aria-label="+ New client"]');
    await page.fill('#view-insurance input[data-field="name"]', 'Gloria Mendes');
    // Born 64 years and 11 months ago, so her Initial Enrollment Period is open now.
    const dob = await page.evaluate(() => { const d = new Date(); d.setFullYear(d.getFullYear() - 65); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10); });
    await page.fill('#view-insurance input[data-field="dob"]', dob);
    await page.fill('#view-insurance input[data-field="zip"]', '85004');
    await page.click('#view-insurance [data-action="save-client"]');
    await page.waitForSelector('#view-insurance h3:has-text("Gloria Mendes")');
    // The record opens on Details, with the client's information in view.
    await page.waitForSelector('#view-insurance .ins-field:has-text("85004")');

    await page.click('#view-insurance [data-record-tab="related"]');
    await page.click('#view-insurance [data-action="add-policy"]');
    await page.selectOption('#view-insurance .ins-panel select >> nth=0', 'dvh');
    await page.fill('#view-insurance input[data-field="carrier"]', 'Delta Dental');
    await page.fill('#view-insurance input[data-field="policyNumber"]', 'DD-1');
    await page.click('#view-insurance [data-action="save-policy"]');
    await page.waitForSelector('#view-insurance .ins-item:has-text("Delta Dental")');

    await page.click('#view-insurance [data-section="alerts"]');
    await page.waitForSelector('#view-insurance [data-alert="turning65"]:has-text("Gloria Mendes turns 65")');
    assert.ok(await page.$('#view-insurance [data-section="alerts"] .ins-count'), 'the tab shows a count');

    await page.click('#view-insurance [data-section="soa"]');
    await page.selectOption('#view-insurance select[data-field="soa-sign-method"]', 'typed');
    await page.fill('#view-insurance input[data-field="soa-typed"]', 'Gloria Mendes');
    await page.click('#view-insurance [data-action="save-soa"]');
    await page.waitForSelector('#view-insurance .ins-pill:has-text("unchanged ✓")');
    const soa = await page.evaluate(() => insuranceDesk.soas()[0]);
    assert.deepEqual(soa.products, ['pdp', 'ma']);
    assert.equal(soa.typedName, 'Gloria Mendes');

    await page.evaluate(() => {
        window.pickTextFileFromUser = async () => 'Policy Number,Insured Name,Paid Date,Net Commission\nDD-1,Gloria Mendes,2026-05-03,12.50\nZZ-9,Nobody Known,2026-05-03,7.00\n';
    });
    await page.click('#view-insurance [data-section="commissions"]');
    await page.click('#view-insurance [data-action="import-statement"]');
    await page.fill('#view-insurance input[data-field="stmt-carrier"]', 'Delta');
    await page.click('#view-insurance [data-action="confirm-statement"]');
    await page.waitForSelector('#view-insurance tr[data-status="unmatched"]:has-text("Nobody Known")');
    assert.equal(await page.textContent('#view-insurance [data-stat="No match"] b'), '1');

    await page.click('#view-insurance [data-section="privacy"]');
    await page.fill('#view-insurance input[data-field="pass1"]', 'test passphrase 1');
    await page.fill('#view-insurance input[data-field="pass2"]', 'test passphrase 1');
    await page.click('#view-insurance [data-action="set-pass"]');
    await page.waitForSelector('#view-insurance button:has-text("🔒 Lock")');
    const raw = await page.evaluate(() => localStorage.getItem('codev_insurance_desk'));
    assert.doesNotMatch(raw, /Gloria/);
    await page.click('#view-insurance button:has-text("🔒 Lock")');
    await page.fill('#view-insurance .ins-lock input[type=password]', 'test passphrase 1');
    await page.click('#view-insurance .ins-lock button:has-text("Unlock")');
    await page.waitForSelector('#view-insurance [data-section="clients"]');
    assert.equal(await page.evaluate(() => insuranceDesk.client('Gloria Mendes').policies[0].carrier), 'Delta Dental');
    assert.deepEqual(errors, []);
});

test('in the page: with access on, an insurance request gets the tools and the privacy rules; other requests don\'t', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openDeskPage(t, [
        [{ name: 'insurance_save_client', arguments: { name: 'Omar Haddad', dob: '1961-12-02', zip: '60601' } }],
        'Added Omar.',
        'The answer is 4.'
    ]);
    await page.evaluate(() => insuranceDesk.saveSettings({ agentAccess: true }));
    await sendPrompt(page, 'Add Omar Haddad to my book, he is turning 65 and needs a Medicare Supplement');
    await waitForChat(page, /Added Omar\./);
    assert.equal(await page.evaluate(() => insuranceDesk.client('Omar Haddad').zip), '60601');
    const first = await page.evaluate(() => window.__modelCalls[0]);
    assert.ok(first.tools.includes('insurance_save_client') && first.tools.includes('insurance_quote_brief'));
    assert.match(first.system, /\[Insurance Desk\] The user is a licensed health and life insurance agent/);

    await sendPrompt(page, 'What is 2 + 2?');
    await waitForChat(page, /The answer is 4\./);
    const last = await page.evaluate(() => window.__modelCalls[window.__modelCalls.length - 1]);
    assert.ok(!last.tools.includes('insurance_clients'));
    assert.doesNotMatch(last.system, /\[Insurance Desk\]/);
    assert.deepEqual(errors, []);
});

test('in the page: the desk fits a phone screen', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openDeskPage(t, [], { width: 360, height: 760 });
    await page.evaluate(() => {
        const c = insuranceDesk.saveClient({ name: 'A very long client name that goes on and on forever', city: 'Fort Lauderdale', state: 'FL', phone: '954-555-0100' }).client;
        insuranceDesk.savePolicy(c.id, { planType: 'mapd', carrier: 'UnitedHealthcare', planName: 'AARP Medicare Advantage Choice Plan 2 (PPO)', status: 'active' });
        mobileTab('insurance');
    });
    await page.waitForSelector('#view-insurance tr[data-client]');
    for (const section of ['clients', 'alerts', 'soa', 'commissions', 'quote', 'privacy']) {
        await page.click(`#view-insurance [data-section="${section}"]`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 1, `${section} scrolls sideways by ${overflow}px`);
    }
    await page.click('#view-insurance [data-section="clients"]');
    await page.click('#view-insurance tr[data-client]');
    await page.waitForSelector('#view-insurance .ins-highlights');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `client page scrolls sideways by ${overflow}px`);
    assert.ok(await page.$('.mobile-tab[data-view="insurance"].active'), 'the Clients tab is lit');
    assert.deepEqual(errors, []);
});

test('in the page: list views, a Kanban board, the stage path and the activity timeline', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openDeskPage(t, []);
    await page.evaluate(() => {
        const d = insuranceDesk;
        d.saveClient({ name: 'Ann Lee', status: 'lead', phone: '555-0101', email: 'ann@example.com', zip: '10001' });
        const b = d.saveClient({ name: 'Bo Diaz', status: 'client' }).client;
        d.savePolicy(b.id, { planType: 'medsupp', carrier: 'Aetna', status: 'active', premium: 150 });
        switchView('insurance');
    });
    await page.waitForSelector('#view-insurance tr[data-client="Ann Lee"]:has-text("ann@example.com")');
    await page.selectOption('#view-insurance select[data-field="list-view"]', 'medicare');
    assert.deepEqual(await page.$$eval('#view-insurance tr[data-client]', rows => rows.map(r => r.dataset.client)), ['Bo Diaz']);
    await page.selectOption('#view-insurance select[data-field="list-view"]', 'all');
    await page.click('#view-insurance th[data-sort="name"]');
    assert.deepEqual(await page.$$eval('#view-insurance tr[data-client]', rows => rows.map(r => r.dataset.client)), ['Bo Diaz', 'Ann Lee'], 'a second click sorts the other way');

    await page.click('#view-insurance [data-display="kanban"]');
    await page.dragAndDrop('#view-insurance .ins-kcard[data-client="Ann Lee"]', '#view-insurance .ins-lane[data-stage="prospect"]', { sourcePosition: { x: 12, y: 10 } });
    await page.waitForSelector('#view-insurance .ins-lane[data-stage="prospect"] .ins-kcard[data-client="Ann Lee"]');
    assert.equal(await page.evaluate(() => insuranceDesk.client('Ann Lee').status), 'prospect');
    await page.selectOption('#view-insurance select[aria-label="Stage for Ann Lee"]', 'client');
    await page.waitForSelector('#view-insurance .ins-lane[data-stage="client"] .ins-kcard[data-client="Ann Lee"]');

    await page.click('#view-insurance .ins-kcard[data-client="Ann Lee"] b');
    await page.waitForSelector('#view-insurance .ins-step.current[data-stage="client"]');
    assert.equal(await page.locator('#view-insurance .ins-step.done').count(), 2);
    await page.click('#view-insurance .ins-step[data-stage="prospect"]');
    await page.waitForSelector('#view-insurance .ins-step.current[data-stage="prospect"]');

    await page.fill('#view-insurance textarea[data-field="activity-text"]', 'Wants dental added.');
    await page.click('#view-insurance [data-action="save-activity"]');
    await page.waitForSelector('#view-insurance [data-timeline="past"] li[data-kind="call"]:has-text("Wants dental added.")');
    await page.click('#view-insurance [data-composer="followup"]');
    await page.fill('#view-insurance textarea[data-field="activity-text"]', 'Send dental quotes');
    await page.click('#view-insurance [data-action="save-activity"]');
    await page.waitForSelector('#view-insurance li[data-upcoming="followUp"]');
    assert.ok(await page.$('#view-insurance [data-timeline="past"] li[data-kind="change"]:has-text("Edited status")'), 'stage changes show in the timeline');
    assert.deepEqual(errors, []);
});
