// Live search and deep research: Google Search through a Gemini key, Claude's own
// web search, dated news headlines for fresh questions, and the deep research
// pipeline. Every outside service is stubbed in the page, so no key is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

async function openPlainPage(t, steps) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-search-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const opened = await openPage(launched.browser, url, { steps });
    await opened.page.uncheck('#isSandboxCheckbox');
    return opened;
}

const NEWS_RSS = `<?xml version="1.0"?><rss xmlns:News="https://www.bing.com/news/search?q=x&amp;format=rss"><channel>
<item><title>Star guard ruled out with ankle injury</title><link>http://www.bing.com/news/apiclick.aspx?ref=x&amp;url=https%3a%2f%2fexample.com%2finjury&amp;c=1</link>
<description>The guard will miss Tuesday's game.</description><pubDate>Mon, 27 Oct 2026 22:10:00 GMT</pubDate><News:Source>Example Sports</News:Source></item>
</channel></rss>`;
const DDG_HTML = '<div class="result__body"><h2><a class="result__a" href="https://example.org/team">Team page</a></h2><a class="result__snippet">Roster and schedule.</a></div>';

test('without a Gemini key, a fresh question gets dated news headlines first, then DuckDuckGo', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    const asked = [];
    await page.route('**/web/fetch', route => {
        const message = JSON.parse(route.request().postData());
        asked.push(message);
        const html = message.kind === 'search' ? DDG_HTML : NEWS_RSS;
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 200, html }) });
    });
    const search = await page.evaluate(() => localWebSearch('Lakers injury report today', { recency: 'day' }));
    assert.equal(search.source, "Bing News + DuckDuckGo via CoDev's server");
    assert.equal(search.results[0].href, 'https://example.com/injury');
    assert.match(search.results[0].body, /^\[2026-10-27 22:10 UTC, Example Sports\] The guard will miss/);
    assert.equal(search.results[1].href, 'https://example.org/team');
    assert.equal(asked.find(m => m.kind === 'search').df, 'd');
    assert.match(asked.find(m => m.kind === 'page').url, /bing\.com\/news\/search\?q=.*format=rss/);

    // A plain coding question isn't fresh: no news feed.
    asked.length = 0;
    await page.evaluate(() => localWebSearch('how to reverse a list in python'));
    assert.deepEqual(asked.map(m => m.kind), ['search']);
    assert.deepEqual(errors, []);
});

test('with a Gemini key, web_search is Google Search grounding, and falls back when it fails', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    let googleCalls = 0;
    await page.route('https://generativelanguage.googleapis.com/**', route => {
        googleCalls++;
        const body = JSON.parse(route.request().postData());
        assert.deepEqual(body.tools, [{ google_search: {} }]);
        assert.equal(route.request().headers()['x-goog-api-key'], 'AIzaTestKey');
        if (googleCalls > 1) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'quota exceeded' } }) });
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{
            content: { parts: [{ text: '- The Lakers beat the Suns 112-104 on Oct 27, 2026.' }] },
            groundingMetadata: {
                webSearchQueries: ['lakers score'],
                groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'nba.com' } }],
                groundingSupports: [{ segment: { text: 'The Lakers beat the Suns 112-104 on Oct 27, 2026.' }, groundingChunkIndices: [0] }]
            }
        }] }) });
    });
    await page.route('**/web/fetch', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 200, html: DDG_HTML }) }));
    await page.evaluate(() => localStorage.setItem('codev_gemini_key', 'AIzaTestKey'));
    const result = await page.evaluate(() => buildLocalTools({ sources: [] }).then(tools => tools.find(x => x.name === 'web_search').run({ query: 'lakers score last night' }, { sources: [] })));
    assert.match(result, /^\[Google Search \(via Gemini\)/);
    assert.match(result, /Summary of what the search found:\n- The Lakers beat the Suns 112-104/);
    assert.match(result, /\[1\] nba\.com\nhttps:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/abc\nThe Lakers beat/);

    // Quota gone: DuckDuckGo answers instead of an error.
    const fallback = await page.evaluate(() => localWebSearch('celtics roster'));
    assert.equal(googleCalls, 2);
    assert.match(fallback.source, /DuckDuckGo/);
    // Turned off in Settings: Google isn't asked at all.
    await page.evaluate(() => { googleSearchEnabled = false; return localWebSearch('knicks roster'); });
    assert.equal(googleCalls, 2);
    assert.deepEqual(errors, []);
});

test('with Anthropic, web_search is Claude\'s own search, cited inline and listed as a step', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    const request = await page.evaluate(() => toAnthropicRequest({ messages: [{ role: 'user', content: 'Hi' }], tools: [
        { type: 'function', function: { name: 'web_search', description: 'x', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'read_webpage', description: 'y', parameters: { type: 'object', properties: {} } } }
    ] }));
    assert.deepEqual(request.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    assert.equal(request.tools[1].name, 'read_webpage');

    const sources = [{ title: 'Earlier', href: 'https://earlier.example' }];
    const out = await page.evaluate(sources => {
        const content = [
            { type: 'text', text: 'Let me check.' },
            { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'suns injuries' } },
            { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://espn.example/suns', title: 'Suns injuries' }] },
            { type: 'text', text: 'Booker is questionable.', citations: [{ type: 'web_search_result_location', url: 'https://espn.example/suns', title: 'Suns injuries', cited_text: 'Booker questionable' }] }
        ];
        const result = claudeSearchResults(content, sources);
        return { result, sources };
    }, sources);
    assert.equal(out.result.text, 'Let me check.Booker is questionable. [2]');
    assert.deepEqual(out.result.searches, [{ query: 'suns injuries', count: 1, error: '' }]);
    assert.equal(out.sources[1].href, 'https://espn.example/suns');

    // An account without web search: CoDev's own web_search from then on.
    const sent = await page.evaluate(async () => {
        anthropicKey = 'sk-ant-test';
        const bodies = [];
        window.fetch = async (url, init) => {
            bodies.push(JSON.parse(init.body));
            if (bodies.length === 1) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'web_search is not enabled for this organization' } }), { status: 400 });
            return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }), { status: 200 });
        };
        const reply = await anthropicChatMessage({ messages: [{ role: 'user', content: 'Hi' }], tools: [{ type: 'function', function: { name: 'web_search', description: 'x', parameters: { type: 'object', properties: {} } } }] });
        return { reply: reply.content, first: bodies[0].tools[0], second: bodies[1].tools[0], active: claudeWebSearchActive() };
    });
    assert.equal(sent.reply, 'ok');
    assert.equal(sent.first.type, 'web_search_20250305');
    assert.equal(sent.second.name, 'web_search');
    assert.equal(sent.second.type, undefined);
    assert.equal(sent.active, false);
    assert.deepEqual(errors, []);
});

test('deep research plans, searches, reads, follows up once and writes a cited report', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, [
        '["phoenix suns injuries", "suns schedule this week"]',
        '["booker ankle update"]',
        '## Answer\nBooker is questionable [1].'
    ]);
    await page.evaluate(() => {
        let n = 0;
        window.localWebSearch = async query => ({ source: 'Stub', results: [{ title: `Result for ${query}`, href: `https://example.com/${++n}`, body: 'snippet' }] });
        window.fetchPageHtml = async url => ({ status: 200, html: `<html><title>t</title><body><main><p>Page text from ${url}</p></main></body></html>` });
    });
    await page.click('#deepResearchBtn');
    assert.equal(await page.getAttribute('#deepResearchBtn', 'aria-pressed'), 'true');
    await sendPrompt(page, 'What is the latest on the Suns injuries?');
    await waitForChat(page, /Booker is questionable \[1\]/);
    // One-shot: the button is off again after the run.
    assert.equal(await page.getAttribute('#deepResearchBtn', 'aria-pressed'), 'false');
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.equal(calls.length, 3);
    assert.match(calls[0].system, /JSON array of \d short, distinct search queries/);
    assert.match(calls[2].messages[0].content, /\[1\] Result for phoenix suns injuries\nhttps:\/\/example\.com\/1\nPage text from https:\/\/example\.com\/1/);
    assert.match(calls[2].messages[0].content, /\[3\] Result for booker ankle update/);
    const reply = await page.evaluate(() => chatSessions.find(s => s.id === activeChatId).messages.at(-1));
    assert.equal(reply.sender, '🔬 Deep research');
    assert.equal(reply.sources.length, 3);
    assert.ok(reply.toolLog.some(line => /^🧭 Follow-up: booker ankle update/.test(line)));

    // Typing "deep research" starts it too, without the button.
    await page.evaluate(() => { window.__modelCalls = []; });
    await sendPrompt(page, 'deep research: best budget gaming mouse');
    await waitForChat(page, /Deep research\n(The model returned|Done)/);
    assert.match((await page.evaluate(() => window.__modelCalls))[0].messages[0].content, /^best budget gaming mouse$/);
    assert.deepEqual(errors, []);
});
