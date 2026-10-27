// Files that can hold API keys (.env and other hidden files, *.env, key files,
// secrets.* and credentials.*) stay out of agents' reach in the host-side folder
// tools: the Windows app's built-in tools (desktop/mcp-tools.js) and the Python
// helper (tools/ddgs-helper). The sandbox has its own test in desktop/sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createMcpTools } = require('../desktop/mcp-tools');

const FAKE_KEY = 'sk-ant-not-a-real-key';
const FILES = {
    'app.js': 'const key = process.env.KEY;\n',
    '.env': `KEY=${FAKE_KEY}\n`,
    'config/production.env': `KEY=${FAKE_KEY}\n`,
    'certs/server.key': `${FAKE_KEY}\n`,
    'certs/cert.pem': `${FAKE_KEY}\n`,
    'secrets.json': `{"key": "${FAKE_KEY}"}\n`,
    'credentials.yaml': `key: ${FAKE_KEY}\n`,
    '.github/workflows/ci.yml': `# key ${FAKE_KEY}\n`,
    'sub/.secrets/token.txt': `key ${FAKE_KEY}\n`
};
const SECRET_PATHS = Object.keys(FILES).filter(p => p !== 'app.js').concat(['./.env', 'sub/../.env', 'config\\production.env']);

function makeProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-secrets-'));
    for (const [rel, content] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

test("the Windows app's folder tools never list, search, read or write secret files", async t => {
    const project = makeProject();
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    const handle = createMcpTools(() => project);
    const call = async (name, args) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
    const text = result => result.content[0].text;

    assert.deepEqual(text(await call('list_files', {})).split('\n'), ['app.js']);
    assert.match(text(await call('search_files', { query: 'key' })), /^app\.js:1:[^\n]*$/);
    for (const rel of SECRET_PATHS) {
        for (const [name, args] of [['read_file', {}], ['write_file', { content: 'x' }], ['edit_file', { old_text: 'KEY', new_text: 'K' }]]) {
            const result = await call(name, { path: rel, ...args });
            assert.equal(result.isError, true, `${name} ${rel}`);
            assert.match(text(result), /hidden or env file/, `${name} ${rel}`);
            assert.doesNotMatch(text(result), /sk-ant/);
        }
    }
    assert.match(text(await call('list_files', { path: '.github' })), /hidden or env file/);
    // read_image, for the screenshot reader: images only, never a secret file.
    assert.match(text(await call('read_image', { path: '.env' })), /hidden or env file/);
    assert.match(text(await call('read_image', { path: 'app.js' })), /isn't a PNG/);
    fs.writeFileSync(path.join(project, 'slip.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = await call('read_image', { path: 'slip.png' });
    assert.deepEqual(image.content, [{ type: 'image', data: 'iVBORw==', mimeType: 'image/png' }]);
    for (const [rel, content] of Object.entries(FILES)) assert.equal(fs.readFileSync(path.join(project, rel), 'utf8'), content, rel);
});

const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

test("the Python helper's folder tools never list, search, read or write secret files", { skip: !python && 'Python not installed' }, t => {
    const project = makeProject();
    // A stand-in for the ddgs library, which these tools don't use.
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-ddgs-stub-'));
    fs.writeFileSync(path.join(stub, 'ddgs.py'), 'class DDGS:\n    pass\n');
    t.after(() => { fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(stub, { recursive: true, force: true }); });
    const script = `
import json, sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
import ddgs_helper as h
h.PROJECT_DIR = sys.argv[3]
def run(fn, args):
    try:
        return {"ok": True, "text": fn(args)}
    except h.ToolError as err:
        return {"ok": False, "text": str(err)}
out = {"list": run(h.tool_list_files, {}), "search": run(h.tool_search_files, {"query": "key"}), "secret": {}}
for rel in json.loads(sys.argv[4]):
    out["secret"][rel] = [run(h.tool_read_file, {"path": rel}), run(h.tool_write_file, {"path": rel, "content": "x"}),
                          run(h.tool_edit_file, {"path": rel, "old_text": "KEY", "new_text": "K"})]
out["github"] = run(h.tool_list_files, {"path": ".github"})
print(json.dumps(out))
`;
    const done = spawnSync(python, ['-c', script, stub, path.join(__dirname, '..', 'tools', 'ddgs-helper'), project, JSON.stringify(SECRET_PATHS)], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    const out = JSON.parse(done.stdout);
    assert.deepEqual(out.list.text.split('\n'), ['app.js']);
    assert.match(out.search.text, /^app\.js:1:[^\n]*$/);
    for (const [rel, results] of Object.entries(out.secret)) {
        for (const result of results) {
            assert.equal(result.ok, false, rel);
            assert.match(result.text, /hidden or env file/, rel);
            assert.doesNotMatch(result.text, /sk-ant/);
        }
    }
    assert.equal(out.github.ok, false);
    for (const [rel, content] of Object.entries(FILES)) assert.equal(fs.readFileSync(path.join(project, rel), 'utf8'), content, rel);
});
