// Bundles the official MCP client SDK for the page (Android app and web), which
// has no build step: npm run build:mcp-sdk writes www/vendor/mcp/mcp-sdk.min.js,
// a plain script that sets window.CodevMcpSdk. Commit the result.
import { build } from "esbuild";

await build({
    stdin: {
        contents: `
            export { Client } from "@modelcontextprotocol/sdk/client/index.js";
            export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
            export { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
            export { ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
        `,
        resolveDir: process.cwd()
    },
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "CodevMcpSdk",
    platform: "browser",
    target: "es2020",
    legalComments: "eof",
    outfile: "www/vendor/mcp/mcp-sdk.min.js"
});
