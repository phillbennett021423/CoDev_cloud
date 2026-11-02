// Saved web logins and signed-in browser sessions for the agents' headless browser.
// Everything is kept in one file on this computer, encrypted with AES-256-GCM. The
// AES key is protected by the first of these that's available:
//  - Windows app: Electron's safeStorage (DPAPI on Windows, Keychain on macOS).
//  - A passphrase (CODEV_VAULT_KEY for server.js, or CODEV_VAULT_PASSPHRASE): the key is derived from it with scrypt.
//  - server.js on Windows: DPAPI for the current Windows user, through PowerShell.
//  - Otherwise: a random key in a file next to the vault that only this user can read.
// Passwords never leave this module except to be typed into the matching site by the
// browser tools; list() only ever returns labels, sites and user names.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VAULT_VERSION = 1;
const MAX_SESSIONS = 50;

class VaultError extends Error {}

// Each protector wraps and unwraps the vault's 32-byte AES key.
function safeStorageProtector(safeStorage) {
    return {
        name: 'safeStorage',
        wrap: key => safeStorage.encryptString(key.toString('base64')).toString('base64'),
        unwrap: wrapped => Buffer.from(safeStorage.decryptString(Buffer.from(wrapped, 'base64')), 'base64')
    };
}

function dpapiProtector() {
    // The key goes in on stdin, so it never shows up in a process list.
    const run = method => input => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); ' +
        `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}([Convert]::FromBase64String($in), $null, 'CurrentUser'))`],
    { input, windowsHide: true, timeout: 20000 }).toString().trim();
    return {
        name: 'dpapi',
        wrap: key => run('Protect')(key.toString('base64')),
        unwrap: wrapped => Buffer.from(run('Unprotect')(wrapped), 'base64')
    };
}

function passphraseProtector(passphrase) {
    // Nothing is stored for the key: it's derived again from the passphrase and the salt.
    return {
        name: 'passphrase',
        derive: salt => crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    };
}

function keyFileProtector(keyFile) {
    return {
        name: 'keyfile',
        wrap: key => {
            fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
            return path.basename(keyFile);
        },
        unwrap: () => Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64')
    };
}

// Picks the strongest protector this platform has.
function defaultProtector({ safeStorage, passphrase, dir }) {
    if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorageProtector(safeStorage);
    if (passphrase) return passphraseProtector(passphrase);
    if (process.platform === 'win32') return dpapiProtector();
    return keyFileProtector(path.join(dir, 'browser-vault.key'));
}

function normalizeOrigin(url) {
    let parsed;
    try { parsed = new URL(String(url || '').trim()); } catch { throw new VaultError(`"${url}" is not a web address.`); }
    if (!/^https?:$/.test(parsed.protocol)) throw new VaultError('Only http:// and https:// sites can have saved logins.');
    return parsed.origin;
}

// passphrase defaults to CODEV_VAULT_PASSPHRASE; it's ignored where safeStorage works.
function createCredentialVault({ dir, safeStorage, passphrase = process.env.CODEV_VAULT_PASSPHRASE, protector, log = console.warn } = {}) {
    if (!dir) throw new Error('createCredentialVault needs a folder to keep the vault in.');
    const file = path.join(dir, 'browser-vault.json');
    const keeper = protector || defaultProtector({ safeStorage, passphrase, dir });
    let key = null;
    let salt = null;
    let data = null;

    function load() {
        if (data) return data;
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(file)) {
            data = { credentials: [], sessions: [] };
            return data;
        }
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (stored.version !== VAULT_VERSION) throw new VaultError(`The saved logins file was made by a newer CoDev (${file}).`);
        if (stored.protector !== keeper.name) {
            throw new VaultError(`The saved logins in ${file} were locked with "${stored.protector}", but CoDev is now using "${keeper.name}". ` +
                (stored.protector === 'passphrase' ? 'Set CODEV_VAULT_PASSPHRASE again, or ' : '') + 'delete the file to start over.');
        }
        if (keeper.derive) salt = Buffer.from(stored.salt, 'base64');
        key = keeper.derive ? keeper.derive(salt) : keeper.unwrap(stored.wrappedKey);
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
            decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
            data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8'));
        } catch {
            key = null;
            throw new VaultError(`CoDev couldn't unlock the saved logins in ${file} (wrong passphrase, another user or another computer).`);
        }
        return data;
    }

    function save() {
        const stored = { version: VAULT_VERSION, protector: keeper.name };
        if (!key) {
            if (keeper.derive) {
                salt = crypto.randomBytes(16);
                key = keeper.derive(salt);
            } else {
                key = crypto.randomBytes(32);
                if (keeper.name === 'keyfile') log(`Saved logins are encrypted with a key file only this user can read (${path.join(dir, 'browser-vault.key')}). Set CODEV_VAULT_PASSPHRASE for stronger protection.`);
            }
        }
        if (keeper.derive) stored.salt = salt.toString('base64');
        else stored.wrappedKey = keeper.wrap(key);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
        Object.assign(stored, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
        // Written next to the old file and renamed, so a crash never leaves half a vault.
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
        fs.renameSync(tmp, file);
    }

    const shownCredential = c => ({ id: c.id, label: c.label, origin: c.origin, loginUrl: c.loginUrl, username: c.username,
        createdAt: c.createdAt, lastUsedAt: c.lastUsedAt || null });
    const shownSession = s => ({ id: s.id, name: s.name, origins: s.origins, cookieCount: s.storageState.cookies.length, savedAt: s.savedAt });

    return {
        file,
        protectorName: keeper.name,

        // What the user and the agents may see: never a password or a cookie value.
        list() {
            const { credentials, sessions } = load();
            return { credentials: credentials.map(shownCredential), sessions: sessions.map(shownSession) };
        },

        addCredential({ label, loginUrl, username, password, usernameSelector, passwordSelector, submitSelector } = {}) {
            if (typeof password !== 'string' || !password) throw new VaultError('A saved login needs a password.');
            if (typeof username !== 'string' || !username.trim()) throw new VaultError('A saved login needs a user name or email.');
            const origin = normalizeOrigin(loginUrl);
            load();
            const credential = {
                id: `cred_${crypto.randomBytes(6).toString('hex')}`,
                label: String(label || '').trim().slice(0, 80) || new URL(origin).hostname,
                origin, loginUrl: new URL(loginUrl).href, username: username.trim(), password,
                usernameSelector: usernameSelector ? String(usernameSelector) : '',
                passwordSelector: passwordSelector ? String(passwordSelector) : '',
                submitSelector: submitSelector ? String(submitSelector) : '',
                createdAt: new Date().toISOString()
            };
            data.credentials.push(credential);
            save();
            return shownCredential(credential);
        },

        removeCredential(id) {
            load();
            const before = data.credentials.length;
            data.credentials = data.credentials.filter(c => c.id !== id);
            if (data.credentials.length === before) throw new VaultError(`No saved login with id ${id}.`);
            save();
        },

        // Only for the browser tools, after the user approved this use.
        useCredential(id) {
            const credential = load().credentials.find(c => c.id === id);
            if (!credential) throw new VaultError(`No saved login with id "${id}". Call browser_list_credentials to see them.`);
            credential.lastUsedAt = new Date().toISOString();
            save();
            return { ...credential };
        },

        peekCredential(id) {
            const credential = load().credentials.find(c => c.id === id);
            return credential ? shownCredential(credential) : null;
        },

        // storageState is Playwright's { cookies, origins: [{ origin, localStorage }] }.
        saveSession(name, storageState) {
            load();
            const origins = [...new Set([...storageState.cookies.map(c => c.domain.replace(/^\./, '')),
                ...storageState.origins.map(o => new URL(o.origin).hostname)])];
            const trimmed = String(name || '').trim().slice(0, 80) || origins[0] || 'session';
            const existing = data.sessions.find(s => s.name === trimmed);
            const session = { id: existing ? existing.id : `sess_${crypto.randomBytes(6).toString('hex')}`, name: trimmed,
                origins, storageState, savedAt: new Date().toISOString() };
            data.sessions = [session, ...data.sessions.filter(s => s !== existing)].slice(0, MAX_SESSIONS);
            save();
            return shownSession(session);
        },

        getSession(id) {
            const session = load().sessions.find(s => s.id === id || s.name === id);
            if (!session) throw new VaultError(`No saved session "${id}". Call browser_list_credentials to see them.`);
            return session;
        },

        peekSession(id) {
            const session = load().sessions.find(s => s.id === id || s.name === id);
            return session ? shownSession(session) : null;
        },

        removeSession(id) {
            load();
            const before = data.sessions.length;
            data.sessions = data.sessions.filter(s => s.id !== id);
            if (data.sessions.length === before) throw new VaultError(`No saved session with id ${id}.`);
            save();
        }
    };
}

module.exports = { createCredentialVault, VaultError, normalizeOrigin, safeStorageProtector, dpapiProtector, passphraseProtector, keyFileProtector };
