#!/usr/bin/env node
// CoDev as an MCP server: hands CoDev's art pipeline (art_*) and its Godot and
// Blender tools (godot_*, blender_run, gamedev_status) to any MCP client on this
// computer, such as Claude Code, Cursor or Claude Desktop, over stdio. A coding agent
// can then train a LoRA, generate and edit concepts, bake PBR maps, rig a skin, build
// a playable ad and drop the .glb into the Godot project, all by calling tools.
//
//   node codev-mcp.js --workspace C:\path\to\game
//
// Claude Code:   claude mcp add codev -- node C:\path\to\CoDev_cloud\codev-mcp.js --workspace C:\path\to\game
// Cursor/others: { "mcpServers": { "codev": { "command": "node", "args": ["C:\\path\\to\\CoDev_cloud\\codev-mcp.js", "--workspace", "C:\\path\\to\\game"] } } }
//
// The workspace is the project folder (default: CODEV_WORKSPACE, then the folder the
// client starts it in). Its codev-studio.json (the studio rules: art direction, poly
// and texture budgets, naming) goes to the client as the server's instructions and as
// the resource codev://studio-rules, so the agent follows them from the first call.
// .env next to this file is read for CODEV_* settings (ComfyUI URL, Blender path...).
// The client's own permission prompts apply to every tool call.
const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('./env');

function workspaceFrom(argv, env) {
    const i = argv.indexOf('--workspace');
    const raw = (i >= 0 && argv[i + 1]) || env.CODEV_WORKSPACE || process.cwd();
    return path.resolve(raw);
}

function createCodevMcp({ workspace, env = process.env, services } = {}) {
    const R = require('./desktop/creative/rules');
    const getProjectDir = () => workspace;
    const list = services || [
        require('./desktop/creative').createCreativeService({ getProjectDir, env, log: line => process.stderr.write(`[codev] ${line}\n`) }),
        require('./desktop/gamedev').createGameDevService({ getProjectDir, env, log: line => process.stderr.write(`[codev] ${line}\n`) })
    ];
    const owner = new Map();
    for (const s of list) for (const t of s.tools) if (!owner.has(t.name)) owner.set(t.name, s);

    function instructions() {
        let rules = '';
        try { rules = R.summary(R.loadRules(workspace)); } catch (err) { rules = err.message; }
        return [
            `CoDev's game-art pipeline for the project at ${workspace}. Every file path is relative to that folder.`,
            'Start with art_status. The studio rules below are the project\'s memory: follow its budgets, naming and art direction, and record new rules with art_rules (op "note" or "set") instead of keeping them in your head.',
            rules,
            toolGuide()
        ].filter(Boolean).join('\n\n');
    }

    // Which tool fits which request, and how to recover from a failed call: the same
    // guide CoDev's own agents get (mobile/www/agent-ui/tool-guide.js).
    function toolGuide() {
        try { return require('./mobile/www/agent-ui/tool-guide.js').toolGuideNote(tools()); } catch { return ''; }
    }

    function tools() {
        // _meta is CoDev's own; MCP clients get the standard fields.
        return [...owner.entries()].map(([name, s]) => s.tools.find(t => t.name === name))
            .map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) }));
    }

    async function call(name, args) {
        const s = owner.get(name);
        if (!s) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        return s.callTool(name, args || {});
    }

    function resources() {
        return [{ uri: 'codev://studio-rules', name: 'Studio rules (codev-studio.json)', mimeType: 'application/json', description: 'Art direction, budgets, naming and notes every art tool follows' }];
    }

    function readResource(uri) {
        if (uri !== 'codev://studio-rules') throw new Error(`Unknown resource ${uri}`);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(R.loadRules(workspace), null, 2) }] };
    }

    async function close() { for (const s of list) { try { await s.close(); } catch { /* closing */ } } }

    return { instructions, tools, call, resources, readResource, close };
}

async function main() {
    loadEnvFile();
    const workspace = workspaceFrom(process.argv.slice(2), process.env);
    if (!fs.existsSync(workspace)) {
        process.stderr.write(`[codev] The workspace ${workspace} doesn't exist.\n`);
        process.exit(1);
    }
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    const codev = createCodevMcp({ workspace });
    const server = new Server({ name: 'codev', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} }, instructions: codev.instructions() });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: codev.tools() }));
    server.setRequestHandler(CallToolRequestSchema, async req => codev.call(req.params.name, req.params.arguments));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: codev.resources() }));
    server.setRequestHandler(ReadResourceRequestSchema, async req => codev.readResource(req.params.uri));
    const stop = async () => { await codev.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await server.connect(new StdioServerTransport());
    process.stderr.write(`[codev] MCP server ready for ${workspace}\n`);
}

if (require.main === module) main().catch(err => { process.stderr.write(`[codev] ${err.stack || err}\n`); process.exit(1); });

module.exports = { createCodevMcp, workspaceFrom };
