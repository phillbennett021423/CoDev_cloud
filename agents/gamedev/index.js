// The game engine tools (Godot editor bridge, headless Godot checks, Blender) as a
// server.js agent-tools service. The code is in desktop/gamedev, where the Windows
// app's installer can include it; this folder only points it at the workspace.
function createService(config = {}, { log = console.log } = {}) {
    const { createGameDevService } = require('../../desktop/gamedev');
    const workspace = config.workspace || {};
    return createGameDevService({ getProjectDir: () => workspace.root || workspace.projectDir || '', log });
}

module.exports = { createService };
