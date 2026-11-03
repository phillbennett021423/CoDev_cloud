// Every tool CoDev's agents can be handed, gathered from each place that defines one,
// so tests/tool-docs.test.js can hold all of them to the same documentation rules.
//
//  - serverTools():  the agent services server.js serves at /agent-tools (sandbox,
//                    headless browser, Outlier, Godot/Blender, the art pipeline), plus
//                    the Windows app's built-in folder tools (desktop/mcp-tools.js)
//  - moduleTools():  the page's tool modules that also load in Node (code map, project brain, files,
//                    workers, page extraction, story studio, insurance desk, Google
//                    apps, MEGA, notes and tables, Azgaar maps, Odds API, the phone
//                    browser), with every tool switched on
//  - pageTools(page): the tools written inline in index.html and media-tools.js, read
//                    from the real page in Chromium with every optional tool switched on
//
// Each entry is { surface, name, description, inputSchema, annotations }. surface says
// which tool list it lands in; one name can appear on several surfaces (read_file is a
// sandbox tool and a Windows app tool), but never twice on one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = path.join(ROOT, 'mobile', 'www', 'agent-ui');

const strip = (surface, tools) => tools.map(t => ({ surface, name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));

function memoryStorage() {
    const data = new Map();
    return {
        getItem: k => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: k => data.delete(k),
        clear: () => data.clear(),
        key: i => [...data.keys()][i] ?? null,
        get length() { return data.size; }
    };
}

async function serverTools() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-tool-docs-'));
    const saved = { ...process.env };
    Object.assign(process.env, {
        CODEV_WORKSPACE: scratch, CODEV_DATA_DIR: path.join(scratch, 'data'),
        XDG_CONFIG_HOME: path.join(scratch, 'config'), APPDATA: path.join(scratch, 'config')
    });
    const { loadServices } = require(path.join(ROOT, 'agent-services.js'));
    const { loadConfig } = require(path.join(ROOT, 'config.js'));
    const router = await loadServices(loadConfig({ argv: [] }), { log: () => {} });
    try {
        const list = await router.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const desktop = require(path.join(ROOT, 'desktop', 'mcp-tools.js')).createMcpTools(() => scratch);
        const desk = await desktop({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        // The media tools are listed only where Docker runs, so read them from the module.
        const media = require(path.join(ROOT, 'desktop', 'media')).createMedia({ dataDir: path.join(scratch, 'media') });
        const mediaTools = [...media.TOOLS, ...media.LOCAL_TOOLS];
        return {
            skipped: router.skipped,
            tools: [...strip('server', list.result.tools), ...strip('windows-app', desk.result.tools), ...strip('server', mediaTools.filter(t => !list.result.tools.some(s => s.name === t.name)))]
        };
    } finally {
        await router.close();
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

async function moduleTools() {
    const CodeIntel = require(path.join(UI, 'code-intel.js'));
    const Files = require(path.join(UI, 'file-builder.js'));
    const Tasks = require(path.join(UI, 'task-runner.js'));
    const Studio = require(path.join(UI, 'story-studio.js'));
    const Desk = require(path.join(UI, 'insurance-desk.js'));
    const Google = require(path.join(UI, 'google-apps.js'));
    const Odds = require(path.join(UI, 'odds-api.js'));
    const Model = require(path.join(UI, 'prop-model.js'));
    const Phone = require(path.join(UI, 'phone-browser.js'));
    const Mega = require(path.join(UI, 'mega-cloud.js'));
    const Notes = require(path.join(UI, 'notes-tables.js'));
    const Maps = require(path.join(UI, 'azgaar-maps.js'));
    const Brain = require(path.join(UI, 'project-brain.js'));
    const Code = require(path.join(UI, 'code-runner.js'));
    const Expert = require(path.join(UI, 'expert-coach.js'));

    const desk = Desk.createDeskStore(memoryStorage(), { docs: Desk.memoryDocs() });
    desk.saveSettings({ agentAccess: true });
    const deskTools = Desk.buildDeskTools(desk, {});

    const google = Google.createGoogleApps({ transport: { request: async () => ({}) } });
    const odds = Odds.createOddsTracker({ storage: memoryStorage(), http: { get: async () => ({}) } });
    const phone = Phone.createPhoneBrowser({ native: { addListener: () => ({ remove() {} }) }, timers: { setInterval: () => 0, clearInterval: () => {} } });

    const mega = Mega.createMegaCloud({ transport: { handle: async () => ({}) } });
    const notes = Notes.createNotesTables({ getStore: () => null });
    const maps = Maps.createAzgaarTools({ readFile: async () => null, generate: async () => ({}), saveFile: async () => ({}) });

    const deps = { saveFile: async () => ({ id: 'x' }), datasets: Files.createDatasetStore(), compile: () => {}, writeProjectFile: async () => '' };
    return [
        ...strip('page', CodeIntel.buildTools({ getIndex: async () => null })),
        ...strip('page', Brain.createProjectBrain(Brain.memoryFiles(memoryStorage())).buildTools()),
        ...strip('page', Files.buildFileTools(deps)),
        ...strip('page', Code.buildCodeTools({ runner: { run: async () => ({}) } })),
        ...strip('page', Tasks.buildTaskTools({ limits: () => Tasks.LIMITS.groq, datasets: deps.datasets })),
        ...strip('page', Studio.buildStudioTools(Studio.createStudioStore(memoryStorage()), {})),
        ...strip('page', deskTools),
        ...strip('page', Object.entries(google.TOOLS).map(([name, t]) => ({ name, ...t }))),
        ...strip('page', Object.entries(odds.TOOLS).map(([name, t]) => ({ name, ...t }))),
        ...strip('page', Model.createPropModel({ storage: memoryStorage(), http: async () => ({ status: 404, body: {} }), tracker: odds, odds: Odds }).buildTools()),
        ...strip('page', Object.entries(mega.TOOLS).map(([name, t]) => ({ name, ...t }))),
        ...strip('page', Object.entries(notes.TOOLS).map(([name, t]) => ({ name, ...t }))),
        ...strip('page', Object.entries(maps.TOOLS).map(([name, t]) => ({ name, ...t }))),
        ...strip('page', Expert.createExpertise({ storage: memoryStorage() }).buildTools()),
        ...strip('phone-browser', phone.tools)
    ];
}

// The page's own tools, from the running page: every optional one is switched on by
// standing in for the checks that decide whether it is offered.
async function pageTools(page) {
    const tools = await page.evaluate(async () => {
        window.fetchMcpResources = async () => [{ server: 'docs', uri: 'docs://readme', name: 'README' }];
        window.fetchHelperCommands = async () => [{ name: 'tests', description: 'Run the tests', argv: ['npm', 'test'] }];
        window.fetchAllMcpTools = async () => [];
        window.qKeyAvailable = async () => true;
        window.chatAttachments = async () => [
            { name: 'report.pdf', text: 'Page 1 text' },
            { name: 'stats.xlsx', sheets: [{ name: 'Sheet1', columns: ['Player', 'Points'] }] }
        ];
        const list = await buildLocalTools({ sources: [], kind: 'code', task: 'make a spreadsheet', sessionId: 'tool-docs' });
        return list.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
    });
    return strip('page', tools);
}

// One entry per surface and name: the page's live list already holds the module
// tools it could offer right now, and the module list adds the rest.
function merge(...lists) {
    const seen = new Map();
    for (const tool of lists.flat()) {
        const key = `${tool.surface}/${tool.name}`;
        if (!seen.has(key)) seen.set(key, tool);
    }
    return [...seen.values()];
}

module.exports = { serverTools, moduleTools, pageTools, merge, memoryStorage };
