// Screenshots in a folder anywhere on this computer, named by its full path (like
// G:\My Drive\continuumUniverse\New folder), for the page's read_screenshots tool:
// the Windows app answers over IPC and server.js on POST /screenshots. Read-only,
// image files only, and never hidden folders or files that can hold keys. A Google
// Drive or OneDrive online-only file downloads as it's read.
const fs = require('fs');
const path = require('path');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_LISTED = 500;
const MAX_DEPTH = 2;
const SECRET_NAME = /^\.|\.(env|pem|key|pfx|p12|keystore|jks)$|^(secrets|credentials)\./i;

class ImageFolderError extends Error {}

function checkedPath(raw, what) {
    const text = String(raw || '').trim().replace(/^["']|["']$/g, '');
    const expanded = text.startsWith('~') ? path.join(require('os').homedir(), text.slice(1)) : text;
    if (!expanded || !path.isAbsolute(expanded)) throw new ImageFolderError(`Give the ${what}'s full path, like G:\\My Drive\\Screenshots.`);
    const full = path.resolve(expanded);
    if (full.split(/[\\/]/).some(part => part && part !== '.' && part !== '..' && SECRET_NAME.test(part) && !/^[A-Za-z]:$/.test(part))) {
        throw new ImageFolderError(`${full} is in a hidden folder or names a key file, which CoDev doesn't read.`);
    }
    return full;
}

// The images in a folder and the folders inside it (two levels), newest first.
function listImages(folder) {
    const root = checkedPath(folder, 'folder');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ImageFolderError(`No folder at ${root}.`);
    const found = [];
    const walk = (dir, depth) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (found.length >= MAX_LISTED || SECRET_NAME.test(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (depth < MAX_DEPTH) walk(full, depth + 1); continue; }
            if (!IMAGE_TYPES[path.extname(entry.name).toLowerCase()]) continue;
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            found.push({ path: full, name: path.relative(root, full).split(path.sep).join('/'), size: stat.size, modified: stat.mtimeMs });
        }
    };
    walk(root, 0);
    return { folder: root, images: found.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name)) };
}

function readImage(file) {
    const full = checkedPath(file, 'image');
    const mimeType = IMAGE_TYPES[path.extname(full).toLowerCase()];
    if (!mimeType) throw new ImageFolderError(`${full} isn't a PNG, JPG, WebP, GIF or BMP image.`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new ImageFolderError(`No image at ${full}.`);
    if (fs.statSync(full).size > MAX_IMAGE_BYTES) throw new ImageFolderError(`${full} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    return { mimeType, data: fs.readFileSync(full).toString('base64') };
}

// One request from the page: { op: "list", folder } or { op: "read", path }.
async function handleImageFolder(req = {}) {
    try {
        if (req.op === 'list') return { ok: true, ...listImages(req.folder) };
        if (req.op === 'read') return { ok: true, ...readImage(req.path) };
        return { ok: false, error: `Unknown op ${req.op}` };
    } catch (err) {
        return { ok: false, error: err instanceof ImageFolderError ? err.message : `${err.code || err.name}: ${err.message}` };
    }
}

module.exports = { handleImageFolder, listImages, readImage };
