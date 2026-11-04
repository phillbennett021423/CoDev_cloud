#!/usr/bin/env node
// A stand-in for Roblox Studio's built-in MCP server, for tests and the end-to-end check
// (scripts/roblox-bridge-e2e.js). It speaks MCP over stdio with the same tool names and
// shapes as Studio's (list_roblox_studios, get_studio_state, execute_luau, start_stop_play,
// get_console_output, screen_capture, search_game_tree), and every tool needs a studio_id
// like the real one. Luau really runs: the code goes to the real Luau VM (luau-web) over a
// small mock of Roblox's DataModel (roblox-mock.luau), and Play runs the place's Scripts
// and LocalScripts, so a script that errors at runtime shows its error in the output.
//
//   node tests/fixtures/fake-roblox-studio.js
//   --log <file> appends each tool call (name and arguments) to the file as a JSON line.
const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const STUDIO_ID = 'studio-7f3a';
// A 1x1 PNG: the "game view".
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const id = { type: 'string', description: 'The Studio instance, from list_roblox_studios.' };
const TOOLS = [
    { name: 'list_roblox_studios', description: 'List open Studio instances.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_studio_state', description: 'Play state and data model types.', inputSchema: { type: 'object', properties: { studio_id: id }, required: ['studio_id'] } },
    { name: 'execute_luau', description: 'Run Luau in a data model.', inputSchema: { type: 'object', properties: { studio_id: id, datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] }, code: { type: 'string' } }, required: ['studio_id', 'datamodel_type', 'code'] } },
    { name: 'start_stop_play', description: 'Start or stop a playtest.', inputSchema: { type: 'object', properties: { studio_id: id, mode: { type: 'string', enum: ['start_play', 'stop'] } }, required: ['studio_id', 'mode'] } },
    { name: 'get_console_output', description: 'The output log.', inputSchema: { type: 'object', properties: { studio_id: id }, required: ['studio_id'] } },
    { name: 'screen_capture', description: 'Capture the viewport.', inputSchema: { type: 'object', properties: { studio_id: id }, required: ['studio_id'] } },
    { name: 'search_game_tree', description: 'The place\'s instance tree.', inputSchema: { type: 'object', properties: { studio_id: id }, required: ['studio_id'] } }
];

async function main() {
    const { LuauState } = await import('luau-web');
    const console = [];
    let lua;
    lua = await LuauState.createAsync({
        jsprint: line => { console.push(String(line)); },
        jsload: (source, name) => lua.loadstring(String(source), String(name), false)
    });
    const prelude = lua.loadstring(fs.readFileSync(path.join(__dirname, 'roblox-mock.luau'), 'utf8'), 'roblox-mock', true);
    await prelude();
    const call = async expr => {
        const fn = lua.loadstring(`return ${expr}`, 'host', true);
        const out = await fn();
        return Array.isArray(out) ? out[0] : out;
    };
    const at = process.argv.indexOf('--log');
    const logFile = at > 0 ? process.argv[at + 1] : '';
    const text = (t, isError) => ({ content: [{ type: 'text', text: String(t) }], ...(isError ? { isError: true } : {}) });

    const server = new Server({ name: 'Roblox_Studio', version: '0.0.0-test' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async req => {
        const { name, arguments: args = {} } = req.params;
        if (logFile) fs.appendFileSync(logFile, JSON.stringify({ name, args }) + '\n');
        if (name === 'list_roblox_studios') return text(JSON.stringify([{ studio_id: STUDIO_ID, place: 'Test Place' }]));
        if (args.studio_id !== STUDIO_ID) return text(`Unknown studio_id "${args.studio_id}". Call list_roblox_studios.`, true);
        const playing = Boolean(await call('__codev_playing()'));
        if (name === 'get_studio_state') return text(JSON.stringify({ mode: playing ? 'Play' : 'Edit', datamodel_types: playing ? ['Edit', 'Client', 'Server'] : ['Edit'] }));
        if (name === 'execute_luau') {
            if (!['Edit', 'Client', 'Server'].includes(args.datamodel_type)) return text('datamodel_type must be Edit, Client or Server.', true);
            const start = console.length;
            try {
                const fn = lua.loadstring(String(args.code), 'CommandBar', false);
                if (typeof fn === 'string') return text(fn, true);
                const runner = (await lua.loadstring('return __codev_run', 'host', true)())[0];
                await runner(String(args.code));
                return text(console.slice(start).join('\n'));
            } catch (err) {
                return text(`${console.slice(start).join('\n')}\n${err.message}`.trim(), true);
            }
        }
        if (name === 'start_stop_play') {
            if (args.mode === 'start_play') {
                if (playing) return text('Already playing.', true);
                await call('__codev_play()');
                return text('Started play mode.');
            }
            if (args.mode === 'stop') { await call('__codev_stop()'); return text('Stopped.'); }
            return text('mode must be start_play or stop.', true);
        }
        if (name === 'get_console_output') return text(console.join('\n'));
        if (name === 'screen_capture') return { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] };
        if (name === 'search_game_tree') {
            const lines = await call('table.concat(__codev_tree(), "\\n")');
            return text(lines);
        }
        return text(`Unknown tool ${name}`, true);
    });
    await server.connect(new StdioServerTransport());
}

main().catch(err => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
