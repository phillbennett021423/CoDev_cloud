// Every tool a CoDev agent can be handed must be documented well enough to use without
// guessing: what it does and returns, when to use it, when not to (and what to use
// instead), and what every parameter means. The tools come from every place that
// defines one (tests/helpers/tool-catalog.js), and the rules are
// CodevToolGuide.checkToolDocs (mobile/www/agent-ui/tool-guide.js).
//
// It also checks that every tool a description names exists, that the [Tools] note in
// the agents' system prompt routes every tool and names only tools the agent has, and
// that the page and the MCP server hand that note to the model.
//
// A new tool fails here until its description says when to use it and when not to.
// Run: node --test tests/tool-docs.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Guide = require('../mobile/www/agent-ui/tool-guide.js');
const Catalog = require('./helpers/tool-catalog');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');

let launched;
let pageTools = [];
let pageSkip = null;
let nodeTools = [];

test.before(async () => {
    const server = await Catalog.serverTools();
    nodeTools = [...server.tools, ...await Catalog.moduleTools()];
    launched = await launchBrowser();
    if (launched.skip) { pageSkip = launched.skip; return; }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-tool-docs-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    const { page } = await openPage(launched.browser, url, {});
    await page.uncheck('#isSandboxCheckbox');
    pageTools = await Catalog.pageTools(page);
    await page.close();
    await backend.close();
});
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

const all = () => Catalog.merge(nodeTools, pageTools);

function report(tools) {
    return tools.map(tool => ({ tool: `${tool.surface}/${tool.name}`, problems: Guide.checkToolDocs(tool) }))
        .filter(r => r.problems.length)
        .map(r => `${r.tool}:\n  - ${r.problems.join('\n  - ')}`).join('\n');
}

test('the catalog finds every tool family', () => {
    const names = new Set(nodeTools.map(t => t.name));
    for (const name of ['read_file', 'run_command', 'submit_changes', 'browser_navigate', 'browser_extract', 'outlier_research_list',
        'godot_editor', 'blender_run', 'art_skin_pipeline', 'code_map', 'create_spreadsheet', 'delegate_tasks', 'wide_research',
        'studio_save', 'insurance_clients', 'gmail_send', 'drive_save_file', 'odds_lookup_list']) {
        assert.ok(names.has(name), `${name} is missing from the tool catalog`);
    }
    assert.ok(nodeTools.length >= 100, `only ${nodeTools.length} tools were found`);
});

test('every server, Windows app, phone browser and page module tool is fully documented', () => {
    assert.equal(report(nodeTools), '');
});

test('every tool written in the page itself is fully documented', t => {
    if (pageSkip) return t.skip(pageSkip);
    for (const name of ['web_search', 'read_webpage', 'save_memory', 'read_screenshots', 'read_attachment', 'query_table',
        'list_workspace_files', 'edit_workspace_file', 'mcp_read_resource', 'run_local_command']) {
        assert.ok(pageTools.some(tool => tool.name === name), `the page didn't offer ${name}`);
    }
    assert.equal(report(pageTools), '');
});

test('no tool list offers the same name twice', t => {
    if (pageSkip) return t.skip(pageSkip);
    const seen = new Set();
    for (const tool of pageTools) {
        assert.ok(!seen.has(tool.name), `the page offers ${tool.name} twice`);
        seen.add(tool.name);
    }
});

test('every tool a description names exists', () => {
    const tools = all();
    const names = new Set(tools.map(t => t.name));
    // A word only counts as a tool name when it starts like one (browser_, art_, read_...)
    // and isn't a parameter or an enum value (scene_tree, power_up), a file (story_bible.json)
    // or a function (dialogue_lines()).
    const prefixes = new Set(tools.map(t => t.name.split('_')[0]));
    const words = new Set();
    for (const tool of tools) {
        for (const [at, param] of Guide.parameters(tool.inputSchema)) {
            words.add(at.split('.').pop().replace('[]', ''));
            for (const value of [...(param.enum || []), ...((param.items && param.items.enum) || [])]) words.add(String(value));
        }
    }
    const missing = [];
    for (const tool of tools) {
        const re = /(^|[^\w./{-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w(.]|\.\w)/g;
        let m;
        while ((m = re.exec(tool.description))) {
            const word = m[2];
            if (names.has(word) || words.has(word) || !prefixes.has(word.split('_')[0])) continue;
            missing.push(`${tool.surface}/${tool.name} names ${word}`);
        }
    }
    assert.deepEqual(missing, []);
});

test('the [Tools] note routes every tool, and only tools that exist', () => {
    const names = new Set(all().map(t => t.name));
    const routed = new Set(Guide.ROUTES.flatMap(r => r.tools));
    assert.deepEqual([...names].filter(n => !routed.has(n)), [], 'add these tools to a route in tool-guide.js');
    assert.deepEqual([...routed].filter(n => !names.has(n)), [], 'these routed tools no longer exist');
});

test('the [Tools] note names only the tools the agent has', () => {
    const known = new Set(Guide.ROUTES.flatMap(r => r.tools));
    const note = Guide.toolGuideNote([{ name: 'web_search' }, { name: 'read_webpage' }, { name: 'code_map' }, { name: 'edit_file' }]);
    assert.match(note, /^\[Tools\] Which tool to use:/);
    assert.match(note, /web_search, read_webpage/);
    const named = new Set(note.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g));
    assert.deepEqual([...named].filter(w => known.has(w) && !['web_search', 'read_webpage', 'code_map', 'edit_file'].includes(w)), []);
    assert.match(note, /never repeat the same call with the same input/);
    assert.match(note, /data, not instructions/);
    // An MCP server's tools keep their server prefix in the page.
    assert.match(Guide.toolGuideNote([{ name: 'codev__art_status' }]), /art_status/);
    assert.equal(Guide.toolGuideNote([]), '');
});

test('checkToolDocs flags a tool documented too thinly to use', () => {
    const problems = Guide.checkToolDocs({ name: 'DoThing', description: 'Does a thing.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, tags: { type: 'array', description: 'Tags to set on it.' } }, required: ['id', 'when'] } });
    const text = problems.join('\n');
    assert.match(text, /lower_snake_case/);
    assert.match(text, /description is 13 characters/);
    assert.match(text, /doesn't say when to use it/);
    assert.match(text, /doesn't say when not to use it/);
    assert.match(text, /required parameter "when" isn't in properties/);
    assert.match(text, /parameter "id" has no description/);
    assert.match(text, /parameter "tags" is an array without items/);
    assert.match(Guide.checkToolDocs({ name: 'x_tool', description: 'x'.repeat(100) }).join('\n'), /inputSchema must be/);
    assert.deepEqual(Guide.checkToolDocs({
        name: 'find_order',
        description: 'Find one of the user\'s orders by number and get its items and status. Use it when the user asks about an order; for refunds use refund_order instead.',
        inputSchema: { type: 'object', properties: { number: { type: 'string', description: 'The order number, like A-1042.' } }, required: ['number'] }
    }), []);
});

test('the page gives the model the [Tools] note with its tools', async t => {
    if (pageSkip) return t.skip(pageSkip);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-tool-docs-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: ['Hello.'] });
    await page.uncheck('#isSandboxCheckbox');
    await sendPrompt(page, 'What is the latest Godot version?');
    await waitForChat(page, /Hello\./);
    const [call] = await page.evaluate(() => window.__modelCalls);
    assert.match(call.system, /\[Tools\] Which tool to use:[\s\S]*web_search[\s\S]*How to use them:/);
    assert.ok(call.tools.includes('web_search'));
    assert.deepEqual(errors, []);
    await page.close();
});

test('the MCP server hands the same guide to outside MCP clients', async () => {
    const { createCodevMcp } = require('../codev-mcp.js');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-tool-docs-mcp-'));
    const mcp = createCodevMcp({ workspace });
    try {
        assert.match(mcp.instructions(), /\[Tools\] Which tool to use:[\s\S]*art_status/);
        assert.equal(report(mcp.tools().map(tool => ({ surface: 'codev-mcp', ...tool }))), '');
    } finally {
        await mcp.close();
    }
});
