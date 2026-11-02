// The art pipeline (art_* tools: ComfyUI concepts and edits, LoRA training, PBR maps,
// weathering, Blender remesh/UV/bake/rig/retarget, playable ads, audio) as a server.js
// agent-tools service. The code is in desktop/creative, where the Windows app's
// installer can include it; this folder only points it at the workspace.
function createService(config = {}, { log = console.log } = {}) {
    const { createCreativeService } = require('../../desktop/creative');
    const workspace = config.workspace || {};
    return createCreativeService({ getProjectDir: () => workspace.root || workspace.projectDir || '', log });
}

module.exports = { createService };
