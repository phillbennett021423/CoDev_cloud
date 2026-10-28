// CoDev's Google tools: the account module (desktop/google-connect.js: sign-in,
// tokens, which addresses it will call), the page's tools (agent-ui/google-apps.js:
// what each returns, what is offered when, the free fallbacks, the phone link), and
// one run in the real page where an agent reads Gmail and the user approves or
// declines a send. Google itself is a stand-in, so no account or key is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGoogleConnect, isGoogleApiUrl, READ_SCOPES, WRITE_SCOPES } = require('../desktop/google-connect');
const Google = require('../mobile/www/agent-ui/google-apps.js');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const b64url = text => Buffer.from(text).toString('base64url');

// A stand-in for Google's token and API endpoints. routes: { 'GET https://...': (url, init) => Response }.
function fakeGoogle(routes = {}) {
    const calls = [];
    let tokenCount = 0;
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(String(input));
        const method = (init.method || 'GET').toUpperCase();
        calls.push({ method, url: url.href, headers: init.headers || {}, body: init.body });
        if (url.href === 'https://oauth2.googleapis.com/token') {
            const form = new URLSearchParams(init.body);
            if (form.get('grant_type') === 'authorization_code') {
                if (form.get('code') !== 'good-code' || !form.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
                return json({ access_token: `access-${++tokenCount}`, refresh_token: 'refresh-1', expires_in: 3600, scope: READ_SCOPES.join(' ') });
            }
            if (form.get('refresh_token') === 'revoked') return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
            return json({ access_token: `access-${++tokenCount}`, expires_in: 3600 });
        }
        if (url.href.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
        if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ email: 'pb@example.com' });
        const key = `${method} ${url.origin}${url.pathname}`;
        if (routes[key]) return routes[key](url, init);
        return json({ error: { message: `no stand-in for ${key}` } }, 404);
    };
    return { fetchImpl, calls };
}

function tempTokenFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-google-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'google-account.json');
}

test('only Google API addresses are allowed', () => {
    assert.equal(isGoogleApiUrl('https://gmail.googleapis.com/gmail/v1/users/me/messages'), true);
    assert.equal(isGoogleApiUrl('https://places.googleapis.com/v1/places:searchText'), true);
    assert.equal(isGoogleApiUrl('http://gmail.googleapis.com/x'), false);
    assert.equal(isGoogleApiUrl('https://evil.example/www.googleapis.com'), false);
    assert.equal(isGoogleApiUrl('https://www.googleapis.com.evil.example/'), false);
    assert.equal(isGoogleApiUrl('https://user@www.googleapis.com/'), false);
    assert.equal(Google.isGoogleApiUrl('https://oauth2.googleapis.com/token'), false);
});

test('sign-in: PKCE on a loopback address, the account saved, then API calls carry its token', async t => {
    const tokenFile = tempTokenFile(t);
    const google = fakeGoogle({ 'GET https://gmail.googleapis.com/gmail/v1/users/me/profile': () => json({ emailAddress: 'pb@example.com' }) });
    const connect = createGoogleConnect({ tokenFile, fetchImpl: google.fetchImpl });
    t.after(() => connect.close());
    assert.match((await connect.handle({ op: 'signin' })).error, /client ID/);

    const { url } = await connect.handle({ op: 'signin', clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' });
    const auth = new URL(url);
    assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('access_type'), 'offline');
    assert.deepEqual(auth.searchParams.get('scope').split(' '), READ_SCOPES);
    const redirect = auth.searchParams.get('redirect_uri');
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await connect.handle({ op: 'status' })).signingIn, true);

    // A forged state is turned away; the real one finishes the sign-in.
    assert.equal((await fetch(`${redirect}/?code=good-code&state=wrong`)).status, 400);
    const done = await fetch(`${redirect}/?code=good-code&state=${auth.searchParams.get('state')}`);
    assert.match(await done.text(), /connected to Google as pb@example\.com/);

    const status = await connect.handle({ op: 'status' });
    assert.equal(status.signedIn, true);
    assert.equal(status.email, 'pb@example.com');
    assert.equal(status.signingIn, false);
    const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    assert.equal(saved.refreshToken, 'refresh-1');
    if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);

    const reply = await connect.handle({ op: 'request', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.emailAddress, 'pb@example.com');
    assert.equal(google.calls.at(-1).headers.Authorization, 'Bearer access-1');

    // The phone link code carries the account; sign-out revokes and forgets it.
    const { code } = await connect.handle({ op: 'link' });
    assert.equal(JSON.parse(Buffer.from(code, 'base64').toString()).refreshToken, 'refresh-1');
    await connect.handle({ op: 'signout' });
    assert.ok(google.calls.some(c => c.url.startsWith('https://oauth2.googleapis.com/revoke')));
    assert.equal(fs.existsSync(tokenFile), false);
    assert.equal((await connect.handle({ op: 'status' })).signedIn, false);
});

test('sending and saving scopes are asked for only when the user turns them on', async t => {
    const connect = createGoogleConnect({ tokenFile: tempTokenFile(t), fetchImpl: fakeGoogle().fetchImpl, env: { clientId: 'env-client' } });
    t.after(() => connect.close());
    const { url } = await connect.handle({ op: 'signin', allowWrite: true });
    const scopes = new URL(url).searchParams.get('scope').split(' ');
    for (const scope of WRITE_SCOPES) assert.ok(scopes.includes(scope));
    assert.equal(new URL(url).searchParams.get('client_id'), 'env-client');
});

test('requests: API keys, refreshed tokens, an expired sign-in, and addresses that are refused', async t => {
    const tokenFile = tempTokenFile(t);
    fs.writeFileSync(tokenFile, JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'refresh-1', scopes: READ_SCOPES, email: 'pb@example.com' }));
    const google = fakeGoogle({
        'GET https://www.googleapis.com/youtube/v3/videos': url => json({ key: url.searchParams.get('key') }),
        'POST https://places.googleapis.com/v1/places:searchText': (url, init) => json({ mask: init.headers['X-Goog-FieldMask'], key: url.searchParams.get('key'), body: JSON.parse(init.body) })
    });
    const connect = createGoogleConnect({ tokenFile, fetchImpl: google.fetchImpl, env: { apiKey: 'AIza-env' } });
    assert.equal((await connect.handle({ op: 'request', url: 'https://www.googleapis.com/youtube/v3/videos?id=x', auth: 'key' })).body.key, 'AIza-env');
    assert.equal((await connect.handle({ op: 'request', url: 'https://www.googleapis.com/youtube/v3/videos?id=x', auth: 'key', apiKey: 'AIza-page' })).body.key, 'AIza-page');
    const places = await connect.handle({ op: 'request', method: 'POST', url: 'https://places.googleapis.com/v1/places:searchText', auth: 'key', headers: { 'X-Goog-FieldMask': 'places.displayName', Cookie: 'no' }, body: { textQuery: 'tacos' } });
    assert.deepEqual(places.body, { mask: 'places.displayName', key: 'AIza-env', body: { textQuery: 'tacos' } });
    assert.ok(!google.calls.at(-1).headers.Cookie, 'only allowed headers are passed on');

    assert.match((await connect.handle({ op: 'request', url: 'https://example.com/steal' })).error, /only sends Google requests/);
    assert.match((await connect.handle({ op: 'request', method: 'DELETE', url: 'https://www.googleapis.com/drive/v3/files/x' })).error, /DELETE isn't allowed/);

    // One refresh serves later calls until it expires.
    await connect.handle({ op: 'request', url: 'https://www.googleapis.com/youtube/v3/videos?id=x' });
    await connect.handle({ op: 'request', url: 'https://www.googleapis.com/youtube/v3/videos?id=y' });
    assert.equal(google.calls.filter(c => c.url === 'https://oauth2.googleapis.com/token').length, 1);

    fs.writeFileSync(tokenFile, JSON.stringify({ clientId: 'c', refreshToken: 'revoked', scopes: READ_SCOPES }));
    const expired = createGoogleConnect({ tokenFile, fetchImpl: google.fetchImpl });
    assert.match((await expired.handle({ op: 'request', url: 'https://www.googleapis.com/youtube/v3/videos?id=x' })).error, /expired or was removed/);
    assert.equal((await expired.handle({ op: 'status' })).signedIn, false);
});

// The page module over a transport that is the real account module.
function appsOver(connect, extra = {}) {
    const transport = Google.backendTransport(req => connect.handle(req), 'computer');
    return Google.createGoogleApps({ transport, confirmWrite: async () => true, ...extra });
}

test('tools are offered only when they can work', async t => {
    const tokenFile = tempTokenFile(t);
    const none = createGoogleConnect({ tokenFile, fetchImpl: fakeGoogle().fetchImpl });
    let names = (await appsOver(none).buildTools()).map(tool => tool.name);
    assert.deepEqual(names, ['google_apps_status']);
    names = (await appsOver(none, { webSearch: async () => ({ results: [] }), fetchText: async () => ({ status: 200, html: '{}' }) }).buildTools()).map(tool => tool.name);
    assert.deepEqual(names, ['google_apps_status', 'youtube_search', 'youtube_video', 'maps_search_places', 'maps_directions']);

    fs.writeFileSync(tokenFile, JSON.stringify({ clientId: 'c', refreshToken: 'r', scopes: [...READ_SCOPES, WRITE_SCOPES[0]] }));
    const signedIn = createGoogleConnect({ tokenFile, fetchImpl: fakeGoogle().fetchImpl });
    names = (await appsOver(signedIn).buildTools()).map(tool => tool.name);
    assert.deepEqual(names, ['google_apps_status', 'youtube_search', 'youtube_video', 'gmail_search', 'gmail_read', 'gmail_send', 'drive_search', 'drive_read_file']);
    assert.match(await appsOver(signedIn).TOOLS.google_apps_status.run(), /Gmail \(read and send, asking first\)/);
});

test('YouTube, Maps, Gmail and Drive results read well, and writes wait for the user', async t => {
    const tokenFile = tempTokenFile(t);
    fs.writeFileSync(tokenFile, JSON.stringify({ clientId: 'c', refreshToken: 'r', scopes: [...READ_SCOPES, ...WRITE_SCOPES], email: 'pb@example.com' }));
    const sent = [];
    const html = '<p>Hi &amp; welcome</p><br>Line two';
    const google = fakeGoogle({
        'GET https://www.googleapis.com/youtube/v3/search': url => json({ items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: `Clip: ${url.searchParams.get('q')}`, channelTitle: 'NBA', publishedAt: '2026-10-27T00:00:00Z', description: 'Highlights' } }] }),
        'GET https://www.googleapis.com/youtube/v3/videos': () => json({ items: [{ id: 'abcdefghijk', snippet: { title: 'Clip', channelTitle: 'NBA', publishedAt: '2026-10-27T00:00:00Z', description: 'Full description' }, statistics: { viewCount: '1530000', likeCount: '2000', commentCount: '10' }, contentDetails: { duration: 'PT1H2M3S' } }] }),
        'GET https://www.googleapis.com/youtube/v3/commentThreads': () => json({ items: [{ snippet: { topLevelComment: { snippet: { authorDisplayName: 'fan', likeCount: 5, textDisplay: 'great game' } } } }] }),
        'POST https://places.googleapis.com/v1/places:searchText': () => json({ places: [{ displayName: { text: 'Taco Spot' }, formattedAddress: '1 Main St', rating: 4.6, userRatingCount: 1200, currentOpeningHours: { openNow: true, weekdayDescriptions: Array(7).fill('Day: 9 AM–9 PM') }, googleMapsUri: 'https://maps.google.com/?cid=1' }] }),
        'POST https://routes.googleapis.com/directions/v2:computeRoutes': (url, init) => json({ routes: [{ description: 'I-35', localizedValues: { duration: { text: '25 mins' }, staticDuration: { text: '20 mins' }, distance: { text: '12 mi' } }, legs: [{ steps: [{ navigationInstruction: { instructions: 'Head north' }, localizedValues: { distance: { text: '1 mi' } } }] }], mode: JSON.parse(init.body).travelMode }] }),
        'GET https://gmail.googleapis.com/gmail/v1/users/me/messages': () => json({ messages: [{ id: 'm1' }] }),
        'GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1': url => url.searchParams.get('format') === 'full'
            ? json({ id: 'm1', snippet: 's', payload: { headers: [{ name: 'From', value: 'Dabble <hi@dabble.com>' }, { name: 'Subject', value: 'Your slip' }], mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/html', body: { data: b64url(html) } }, { filename: 'slip.png', mimeType: 'image/png', body: { size: 4096 } }] } })
            : json({ id: 'm1', threadId: 't1', labelIds: ['UNREAD'], snippet: 'Your slip won', payload: { headers: [{ name: 'From', value: 'Dabble' }, { name: 'Subject', value: 'Your slip' }, { name: 'Date', value: 'Mon' }, { name: 'Message-ID', value: '<abc@dabble>' }] } }),
        'POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send': (url, init) => { sent.push(JSON.parse(init.body)); return json({ id: 'sent-1' }); },
        'GET https://www.googleapis.com/drive/v3/files': url => json({ files: [{ id: 'f1', name: 'Notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T00:00:00Z', webViewLink: 'https://docs.google.com/d/f1', q: url.searchParams.get('q') }] }),
        'GET https://www.googleapis.com/drive/v3/files/f1': () => json({ id: 'f1', name: 'Notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T00:00:00Z' }),
        'GET https://www.googleapis.com/drive/v3/files/f1/export': () => new Response('Doc text here', { headers: { 'content-type': 'text/plain' } }),
        'POST https://www.googleapis.com/upload/drive/v3/files': (url, init) => { sent.push(init.body); return json({ id: 'new', name: 'out.md', webViewLink: 'https://drive.google.com/new' }); }
    });
    const connect = createGoogleConnect({ tokenFile, fetchImpl: google.fetchImpl, env: { apiKey: 'AIza-env' } });
    let approve = true;
    const asked = [];
    const apps = appsOver(connect, { confirmWrite: async message => { asked.push(message); return approve; } });
    const { TOOLS } = apps;
    const ctx = { sources: [] };

    const yt = await TOOLS.youtube_search.run({ query: 'Lakers', recent_days: 3 }, ctx);
    assert.match(yt, /Clip: Lakers \(NBA, 2026-10-27\) · 1\.5M views · 1:02:03/);
    assert.match(yt, /watch\?v=abcdefghijk/);
    assert.equal(ctx.sources[0].href, 'https://www.youtube.com/watch?v=abcdefghijk');
    const video = await TOOLS.youtube_video.run({ video: 'https://youtu.be/abcdefghijk', comments: true }, ctx);
    assert.match(video, /Length: 1:02:03/);
    assert.match(video, /- fan \(5 likes\): great game/);

    const places = await TOOLS.maps_search_places.run({ query: 'tacos', near: 'Austin' });
    assert.match(places, /Taco Spot \(4\.6★ \(1\.2K reviews\) · open now\)/);
    assert.match(places, /Today: Day: 9 AM–9 PM/);
    const route = await TOOLS.maps_directions.run({ from: 'A', to: 'B', mode: 'transit' });
    assert.match(route, /Time: 25 mins \(20 mins without traffic\) · Distance: 12 mi/);
    assert.match(route, /1\. Head north \(1 mi\)/);

    assert.match(await TOOLS.gmail_search.run({ query: 'from:dabble' }), /\[m1\] Mon · unread\nFrom: Dabble\nSubject: Your slip/);
    const mail = await TOOLS.gmail_read.run({ id: 'm1' });
    assert.match(mail, /Hi & welcome\n+Line two/);
    assert.match(mail, /Attachments: slip\.png \(image\/png, 4 KB\)/);

    approve = false;
    assert.match(await TOOLS.gmail_send.run({ to: 'a@b.com', subject: 'Hi', body: 'Hello' }), /declined/);
    assert.equal(sent.length, 0);
    approve = true;
    assert.match(await TOOLS.gmail_send.run({ to: 'a@b.com', body: 'Thanks — got it', reply_to_id: 'm1' }), /Sent to a@b\.com/);
    assert.match(asked[1], /To: a@b\.com\nSubject: Re: Your slip/);
    assert.equal(sent[0].threadId, 't1');
    const raw = Buffer.from(sent[0].raw, 'base64url').toString('utf8');
    assert.match(raw, /In-Reply-To: <abc@dabble>/);
    assert.match(raw, /Thanks — got it/);

    assert.match(await TOOLS.drive_search.run({ query: "Bennett's notes" }), /\[f1\] Notes\nGoogle document/);
    assert.ok(google.calls.some(c => c.url.includes('drive/v3/files?') && new URL(c.url).searchParams.get('q').includes("name contains 'Bennett\\'s notes'")));
    assert.match(await TOOLS.drive_read_file.run({ id: 'f1' }), /Doc text here/);
    assert.match(await TOOLS.drive_save_file.run({ name: 'out.md', content: '# Picks' }), /Saved "out\.md" to Google Drive/);
    assert.match(sent[1], /Content-Type: text\/markdown; charset=UTF-8\r\n\r\n# Picks/);
    assert.match(asked[2], /Save a new file to your Google Drive\?/);
});

test('without a key, YouTube and Maps use the free web search and OpenStreetMap', async t => {
    const connect = createGoogleConnect({ tokenFile: tempTokenFile(t), fetchImpl: fakeGoogle().fetchImpl });
    const fetched = [];
    const apps = appsOver(connect, {
        webSearch: async query => ({ results: [{ title: 'Lakers vs Warriors', href: 'https://www.youtube.com/watch?v=abcdefghijk', body: 'Highlights', query }, { title: 'Other', href: 'https://example.com', body: '' }] }),
        fetchText: async url => {
            fetched.push(url);
            if (url.includes('oembed')) return { status: 200, html: JSON.stringify({ title: 'Lakers vs Warriors', author_name: 'NBA' }) };
            if (url.includes('nominatim')) return { status: 200, html: JSON.stringify([{ name: 'Moody Center', type: 'stadium', display_name: 'Moody Center, Austin, Texas', osm_type: 'way', osm_id: 1, lat: '30.28', lon: '-97.73', extratags: { opening_hours: 'Mo-Su 10:00-22:00' } }]) };
            if (url.includes('project-osrm')) return { status: 200, html: JSON.stringify({ routes: [{ duration: 1500, distance: 16093, legs: [{ steps: [{ maneuver: { type: 'depart' }, name: 'Main St', distance: 300 }, { maneuver: { type: 'turn', modifier: 'left' }, name: 'I-35', distance: 15000 }] }] }] }) };
            return { status: 404, html: '' };
        }
    });
    const yt = await apps.TOOLS.youtube_search.run({ query: 'Lakers' }, { sources: [] });
    assert.match(yt, /\[1\] Lakers vs Warriors\nhttps:\/\/www\.youtube\.com\/watch\?v=abcdefghijk/);
    assert.doesNotMatch(yt, /example\.com/);
    assert.match(await apps.TOOLS.youtube_video.run({ video: 'abcdefghijk' }, {}), /Title: Lakers vs Warriors\nChannel: NBA/);
    assert.match(await apps.TOOLS.maps_search_places.run({ query: 'Moody Center' }), /Moody Center \(stadium\)[\s\S]*Hours: Mo-Su 10:00-22:00/);
    const route = await apps.TOOLS.maps_directions.run({ from: 'A', to: 'B' });
    assert.match(route, /Time: about 25 min \(no live traffic\) · Distance: 10\.0 mi/);
    assert.match(route, /2\. Turn left onto I-35/);
    assert.match(await apps.TOOLS.maps_directions.run({ from: 'A', to: 'B', mode: 'transit' }), /Transit directions need a Google API key/);
    assert.ok(fetched.every(url => /^https:\/\/(nominatim\.openstreetmap\.org\/search\?|router\.project-osrm\.org\/route\/v1\/|www\.youtube\.com\/oembed\?)/.test(url)), 'only the hosts the Windows app allows');
});

test('the phone links the computer\'s sign-in and calls Google itself', async () => {
    const store = new Map();
    const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const google = fakeGoogle({ 'GET https://gmail.googleapis.com/gmail/v1/users/me/messages': () => json({ messages: [] }) });
    const phone = Google.phoneTransport({ http: null, storage, fetchImpl: google.fetchImpl });
    assert.match((await phone.handle({ op: 'signin' })).error, /computer/);
    assert.match((await phone.handle({ op: 'import', code: 'nonsense' })).error, /isn't a CoDev phone link code/);
    const code = Buffer.from(JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'refresh-1', scopes: READ_SCOPES, email: 'pb@example.com' })).toString('base64');
    assert.deepEqual(await phone.handle({ op: 'import', code }), { ok: true, email: 'pb@example.com' });
    assert.equal((await phone.handle({ op: 'status' })).signedIn, true);
    const apps = Google.createGoogleApps({ transport: phone });
    assert.match(await apps.TOOLS.gmail_search.run({ query: 'x' }), /No emails match "x"/);
    assert.equal(google.calls.at(-1).headers.Authorization, 'Bearer access-1');
    assert.match((await phone.handle({ op: 'request', url: 'https://example.com/' })).error, /only sends Google requests/);
    await phone.handle({ op: 'signout' });
    assert.equal(store.size, 0);
});

// The Android app: Google's sign-in opens in the phone's browser and comes back to the
// app's one-time listener on 127.0.0.1 (stood in for here), with no computer needed.
test('the Android app signs in to Google on the phone itself', async () => {
    const store = new Map();
    const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const google = fakeGoogle();
    let onRedirect = null;
    const opened = [];
    const loopback = {
        addListener: async (name, f) => { assert.equal(name, 'loopback'); onRedirect = f; return { remove() {} }; },
        loopbackStart: async () => ({ port: 41234 }),
        loopbackStop: async () => {},
        openExternal: async ({ url }) => { opened.push(url); }
    };
    const phone = Google.phoneTransport({ http: null, storage, fetchImpl: google.fetchImpl, loopback });
    assert.equal(phone.canSignIn, true);
    assert.match((await phone.handle({ op: 'signin' })).error, /client ID/);
    const reply = await phone.handle({ op: 'signin', clientId: 'my-client', clientSecret: 'shh', allowWrite: false });
    assert.equal(reply.opened, true);
    const auth = new URL(opened[0]);
    assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(auth.searchParams.get('redirect_uri'), 'http://127.0.0.1:41234');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.doesNotMatch(auth.searchParams.get('scope'), /gmail\.send/);
    assert.equal((await phone.handle({ op: 'status' })).signingIn, true);

    // A redirect with the wrong state (another tab, an old link) is ignored.
    await onRedirect({ port: 41234, query: 'code=good-code&state=wrong' });
    assert.equal((await phone.handle({ op: 'status' })).signedIn, false);
    await onRedirect({ port: 41234, query: `code=good-code&state=${auth.searchParams.get('state')}` });
    const status = await phone.handle({ op: 'status' });
    assert.equal(status.signedIn, true);
    assert.equal(status.onPhone, true);
    assert.equal(status.email, 'pb@example.com');
    assert.equal(status.signingIn, false);
    const exchange = google.calls.find(c => c.url === 'https://oauth2.googleapis.com/token');
    assert.equal(new URLSearchParams(exchange.body).get('redirect_uri'), 'http://127.0.0.1:41234');

    // Signing out of a sign-in made on the phone also removes CoDev's access.
    await phone.handle({ op: 'signout' });
    assert.ok(google.calls.some(c => c.url.startsWith('https://oauth2.googleapis.com/revoke')));
    assert.equal((await phone.handle({ op: 'status' })).signedIn, false);
});

test('email helpers: headers, bodies and links', () => {
    assert.equal(Google.encodeHeader('Plain subject'), 'Plain subject');
    const encoded = Google.encodeHeader('Picks ✅');
    assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
    assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString(), 'Picks ✅');
    assert.equal(Google.encodeHeader('a\r\nBcc: x@y.com'), 'a Bcc: x@y.com', 'no header injection');
    assert.equal(Google.base64UrlToText(Google.textToBase64Url('héllo — ✅')), 'héllo — ✅');
    assert.equal(Google.youtubeId('https://www.youtube.com/shorts/abcdefghijk?feature=x'), 'abcdefghijk');
    assert.equal(Google.youtubeId('https://www.youtube.com/watch?v=abcdefghijk&t=10'), 'abcdefghijk');
    assert.equal(Google.youtubeId('not a video'), null);
    assert.equal(Google.formatDuration('PT4M5S'), '4:05');
});

// The real page, with server.js's /google route served by the real account module.
test('in CoDev, an agent reads Gmail and the user approves one send and declines another', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const tokenFile = tempTokenFile(t);
    fs.writeFileSync(tokenFile, JSON.stringify({ clientId: 'c', refreshToken: 'r', scopes: [...READ_SCOPES, ...WRITE_SCOPES], email: 'pb@example.com' }));
    const sent = [];
    const google = fakeGoogle({
        'GET https://gmail.googleapis.com/gmail/v1/users/me/messages': () => json({ messages: [{ id: 'm1' }] }),
        'GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1': () => json({ id: 'm1', snippet: 'Your Dabble slip won $40', payload: { headers: [{ name: 'Subject', value: 'Slip settled' }] } }),
        'POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send': (url, init) => { sent.push(JSON.parse(init.body)); return json({ id: 'sent-1' }); }
    });
    const connect = createGoogleConnect({ tokenFile, fetchImpl: google.fetchImpl });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-google-page-'));
    const backend = createMockBackend({ workspace, google: req => connect.handle(req) });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: [
        [{ name: 'gmail_search', arguments: { query: 'from:dabble' } }],
        [{ name: 'gmail_send', arguments: { to: 'friend@example.com', subject: 'Won', body: 'The slip hit.' } }],
        [{ name: 'gmail_send', arguments: { to: 'friend@example.com', subject: 'Again', body: 'Second one.' } }],
        'Done: read your Dabble email and sent one note.'
    ] });
    await page.uncheck('#isSandboxCheckbox');
    const dialogs = [];
    page.on('dialog', dialog => {
        dialogs.push(dialog.message());
        if (dialogs.length === 1) dialog.accept(); else dialog.dismiss();
    });
    await sendPrompt(page, 'Check my Gmail for Dabble and email my friend that the slip hit.');
    await waitForChat(page, /Done: read your Dabble email/);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(calls[0].tools.includes('gmail_search') && calls[0].tools.includes('gmail_send') && calls[0].tools.includes('drive_save_file'));
    assert.match(calls[1].messages.at(-1).content, /Your Dabble slip won \$40/);
    assert.equal(dialogs.length, 2);
    assert.match(dialogs[0], /Send this email from your Gmail\?\n\nTo: friend@example\.com\nSubject: Won/);
    assert.equal(sent.length, 1);
    assert.match(Buffer.from(sent[0].raw, 'base64url').toString(), /The slip hit\./);
    assert.match(calls[3].messages.at(-1).content, /declined/);
    const steps = await page.evaluate(() => [...document.querySelectorAll('.msg-steps li')].map(li => li.textContent));
    assert.ok(steps.some(s => /📧 Searching Gmail: from:dabble/.test(s)));
    // Settings shows the account.
    await page.evaluate(() => { document.getElementById('settingsModal').style.display = 'flex'; document.getElementById('googleSettings').open = true; });
    await page.waitForFunction(() => /Signed in as pb@example\.com/.test(document.querySelector('#googleSettings [data-g="status"]').textContent));
    assert.deepEqual(errors, []);
});
