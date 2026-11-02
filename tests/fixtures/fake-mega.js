// A stand-in for megajs's Storage (see tests/mega-cloud.test.js), so the MEGA and
// notes tests need no account and no network.
const assert = require('node:assert/strict');

// A stand-in for megajs's Storage, with the parts CoDev uses: sign-in (with 2FA),
// toJSON/fromJSON, reload, nodes with parents and children, downloadBuffer,
// upload and close. drive: the account's cloud, shared by every Storage made.
function fakeMega({ password = 'right-pass', twoFactor = null } = {}) {
    const drive = { nextId: 1, nodes: [], uploads: [], closed: [], deleted: [], logins: 0, sessionValid: true };
    const add = (name, parentId, { folder = false, text = null, ts = 1761955200 } = {}) => {
        const id = `n${drive.nextId++}`;
        drive.nodes.push({ id, name, parentId, folder, text, ts });
        return id;
    };
    drive.rootId = add('Cloud Drive', null, { folder: true });
    drive.trashId = add('Rubbish Bin', null, { folder: true });
    drive.add = add;

    class Node {
        constructor(storage, raw) {
            Object.assign(this, { storage, nodeId: raw.id, name: raw.name, directory: raw.folder, timestamp: raw.ts, children: raw.folder ? [] : undefined });
            this.size = raw.folder ? 0 : Buffer.byteLength(raw.text || '');
            this.raw = raw;
        }
        async downloadBuffer() { return Buffer.from(this.raw.text || ''); }
        async mkdir(name) {
            const id = add(typeof name === 'string' ? name : name.name, this.nodeId, { folder: true });
            return this.storage._import(drive.nodes.find(n => n.id === id));
        }
        // Not permanent: to the Rubbish Bin, as megajs does.
        async delete(permanent) {
            assert.equal(permanent, false, 'old versions go to the Rubbish Bin');
            const raw = this.raw;
            raw.parentId = drive.trashId;
            drive.deleted.push(raw.name);
            if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
            this.parent = this.storage.trash;
            this.storage.trash.children.push(this);
        }
        upload(opts, bytes, cb) {
            assert.ok(bytes instanceof Uint8Array, 'uploads bytes');
            assert.equal(opts.size, bytes.length, 'the size is the byte length');
            const id = add(opts.name, this.nodeId, { text: Buffer.from(bytes).toString('utf8'), ts: 1762000000 });
            drive.uploads.push({ name: opts.name, folder: this.nodeId, text: Buffer.from(bytes).toString('utf8') });
            const node = this.storage._import(drive.nodes.find(n => n.id === id));
            setTimeout(() => cb(null, node), 0);
            return { on() {} };
        }
    }

    class Storage {
        constructor(options) {
            this.options = options;
            this.files = {};
            this.ready = (async () => {
                if (options.password !== password) throw new Error('ENOENT (-9): Object (typically, node or user) not found. Wrong password?');
                if (twoFactor && options.secondFactorCode !== twoFactor) throw new Error('EMFAREQUIRED (-26): Multi-Factor Authentication Required');
                drive.logins++;
                drive.sessionValid = true;
                this.sid = `sid-${drive.logins}`;
                this.key = 'a2V5';
                await this.reload(true);
                return this;
            })();
        }
        _import(raw) {
            if (this.files[raw.id]) return this.files[raw.id];
            const node = this.files[raw.id] = new Node(this, raw);
            if (raw.id === drive.rootId) this.root = node;
            if (raw.id === drive.trashId) this.trash = node;
            const parent = this.files[raw.parentId];
            if (parent) { parent.children.push(node); node.parent = parent; }
            return node;
        }
        async reload() {
            if (!drive.sessionValid) throw new Error('ESID (-15): Invalid or expired user session, please relogin');
            drive.nodes.forEach(raw => this._import(raw));
            return [];
        }
        toJSON() { return { key: this.key, sid: this.sid, name: 'P', user: 'u1', options: this.options }; }
        static fromJSON(json) {
            const storage = Object.create(Storage.prototype);
            Object.assign(storage, { files: {}, key: json.key, sid: json.sid, options: json.options });
            return storage;
        }
        async close() { drive.closed.push(this.sid); drive.sessionValid = false; }
    }
    return { Storage, drive };
}

module.exports = { fakeMega };
