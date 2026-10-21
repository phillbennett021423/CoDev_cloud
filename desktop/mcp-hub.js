// The MCP client hub on a computer (Windows app main process, or server.js):
// the shared hub from mobile/www/mcp with the official SDK's Node transports,
// so stdio servers (npx, uvx, python, any .exe) work as well as remote ones.
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');

// desktop/www is a copy of mobile/www made by `npm start` / `npm run dist`;
// server.js runs straight from the repo, where only mobile/www exists.
const coreFile = [path.join(__dirname, 'www', 'mcp', 'mcp-hub-core.js'), path.join(__dirname, '..', 'mobile', 'www', 'mcp', 'mcp-hub-core.js')]
    .find(file => fs.existsSync(file));
const { createMcpHub } = require(coreFile);

function makeStdioTransport(config, onStderrLine) {
    const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        // Servers get PATH, APPDATA and the other basics, plus their own env, not all of ours.
        env: { ...getDefaultEnvironment(), ...config.env },
        cwd: config.cwd,
        stderr: 'pipe'
    });
    let partial = '';
    transport.stderr.on('data', chunk => {
        const lines = (partial + chunk.toString()).split(/\r?\n/);
        partial = lines.pop();
        lines.filter(Boolean).forEach(line => onStderrLine(line.slice(0, 500)));
    });
    return transport;
}

// readConfig/writeConfig keep the server list wherever this platform stores settings.
function createNodeMcpHub({ readConfig, writeConfig, log }) {
    const hub = createMcpHub({
        sdk: { Client, StreamableHTTPClientTransport, SSEClientTransport, ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema },
        makeStdioTransport,
        platform: 'desktop',
        log: log || (line => console.log(line))
    });
    try { hub.configure(readConfig() || '{}'); } catch (err) { console.error(err.message); }
    const handle = hub.handle;
    hub.handle = async req => {
        const reply = await handle(req);
        if (req && req.op === 'configure' && !reply.error) writeConfig(typeof req.config === 'string' ? req.config : JSON.stringify(req.config, null, 2));
        return reply;
    };
    return hub;
}

module.exports = { createNodeMcpHub };
