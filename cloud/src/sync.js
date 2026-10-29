// Synced chats, memory and agents. The app locks each item on the person's own
// device (AES-GCM, with a key made from a passphrase only they know) before it
// uploads it, so all this stores is scrambled text it can't open, the owner's
// account included.
//
//   GET  /sync/vault          the passphrase check: {salt, check_iv, check_data} or null
//   PUT  /sync/vault          sets it once; {reset: true} starts over and deletes everything synced
//   GET  /sync/items?since=   items stored after that server time (ms), and the new cursor
//   PUT  /sync/items          {items: [{key, iv, data, updated_at, deleted}]}; newest updated_at wins
const MAX_ITEM_CHARS = 1_900_000;   // D1 rows top out at 2 MB
const MAX_ITEMS_PER_CALL = 50;
const KEY_PATTERN = /^[a-z]+(:[A-Za-z0-9_.-]{1,80})?$/;
const B64 = /^[A-Za-z0-9_-]*$/;

export async function syncRoute(request, env, user, plan, method, path, helpers) {
    const { json, readJson, HttpError } = helpers;

    if (path === '/sync/vault' && method === 'GET') {
        const vault = await env.DB.prepare('SELECT salt, check_iv, check_data FROM vaults WHERE user_id = ?').bind(user.id).first();
        return json(200, { vault: vault || null });
    }
    if (path === '/sync/vault' && method === 'PUT') {
        const body = await readJson(request);
        for (const field of ['salt', 'check_iv', 'check_data']) {
            if (typeof body[field] !== 'string' || !body[field] || body[field].length > 512 || !B64.test(body[field])) throw new HttpError(400, `${field} is missing or not valid.`);
        }
        const existing = await env.DB.prepare('SELECT user_id FROM vaults WHERE user_id = ?').bind(user.id).first();
        if (existing && body.reset !== true) throw new HttpError(409, 'This account already has a passphrase. Unlock with it, or start over.', 'vault_exists');
        if (existing) {
            await env.DB.prepare('DELETE FROM sync_items WHERE user_id = ?').bind(user.id).run();
            await env.DB.prepare('DELETE FROM vaults WHERE user_id = ?').bind(user.id).run();
        }
        await env.DB.prepare('INSERT INTO vaults (user_id, salt, check_iv, check_data, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind(user.id, body.salt, body.check_iv, body.check_data, Date.now()).run();
        return json(200, { vault: { salt: body.salt, check_iv: body.check_iv, check_data: body.check_data } });
    }

    const vault = await env.DB.prepare('SELECT user_id FROM vaults WHERE user_id = ?').bind(user.id).first();
    if (path.startsWith('/sync/items') && !vault) throw new HttpError(409, 'Set a passphrase for synced chats first.', 'no_vault');

    if (path === '/sync/items' && method === 'GET') {
        const since = Math.max(0, Number(new URL(request.url).searchParams.get('since')) || 0);
        const now = Date.now();
        const rows = (await env.DB.prepare(`SELECT item_key AS key, iv, data, updated_at, deleted, stored_at FROM sync_items
            WHERE user_id = ? AND stored_at > ? AND stored_at <= ? ORDER BY stored_at LIMIT 200`).bind(user.id, since, now).all()).results || [];
        // A full page may have more behind it: the cursor is the last row's time.
        const cursor = rows.length === 200 ? rows[rows.length - 1].stored_at : now;
        return json(200, { items: rows.map(({ stored_at, deleted, ...r }) => ({ ...r, deleted: Boolean(deleted) })), cursor, more: rows.length === 200 });
    }

    if (path === '/sync/items' && method === 'PUT') {
        const body = await readJson(request, MAX_ITEMS_PER_CALL * (MAX_ITEM_CHARS + 1000));
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length || items.length > MAX_ITEMS_PER_CALL) throw new HttpError(400, `Send 1 to ${MAX_ITEMS_PER_CALL} items at a time.`);
        for (const item of items) {
            if (typeof item.key !== 'string' || !KEY_PATTERN.test(item.key)) throw new HttpError(400, 'An item has a bad key.');
            if (!Number.isFinite(item.updated_at)) throw new HttpError(400, 'An item has no updated_at.');
            if (item.deleted) { item.iv = ''; item.data = ''; continue; }
            if (typeof item.iv !== 'string' || typeof item.data !== 'string' || !B64.test(item.iv) || !B64.test(item.data)) throw new HttpError(400, 'An item is not locked data.');
            if (item.data.length > MAX_ITEM_CHARS) throw new HttpError(413, 'A chat is too big to sync. Start a new chat for new work.', 'item_too_big');
        }
        if (plan.syncMB != null) {
            const keys = items.map(i => i.key);
            const used = await env.DB.prepare(`SELECT COALESCE(SUM(size), 0) AS total FROM sync_items WHERE user_id = ? AND item_key NOT IN (${keys.map(() => '?').join(',')})`)
                .bind(user.id, ...keys).first();
            const adding = items.reduce((n, i) => n + i.data.length + i.iv.length, 0);
            if (used.total + adding > plan.syncMB * 1024 * 1024) {
                throw new HttpError(413, `Synced chats are full (${plan.syncMB} MB on your plan). Delete old chats to make room.`, 'sync_full');
            }
        }
        const now = Date.now();
        for (const item of items) {
            await env.DB.prepare(`INSERT INTO sync_items (user_id, item_key, iv, data, size, updated_at, stored_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, item_key) DO UPDATE SET iv = excluded.iv, data = excluded.data, size = excluded.size,
                    updated_at = excluded.updated_at, stored_at = excluded.stored_at, deleted = excluded.deleted
                WHERE excluded.updated_at >= sync_items.updated_at`)
                .bind(user.id, item.key, item.iv, item.data, item.data.length + item.iv.length, Math.floor(item.updated_at), now, item.deleted ? 1 : 0).run();
        }
        return json(200, { stored: items.length });
    }
    throw new HttpError(404, 'Not found.');
}
