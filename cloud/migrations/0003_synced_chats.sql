-- Synced chats, memory and agents. Everything here is locked on the person's own
-- device with their passphrase before upload; the server can't read any of it.
CREATE TABLE IF NOT EXISTS vaults (
    user_id INTEGER PRIMARY KEY,
    salt TEXT NOT NULL,
    check_iv TEXT NOT NULL,
    check_data TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_items (
    user_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    data TEXT NOT NULL,
    size INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    stored_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, item_key)
);
CREATE INDEX IF NOT EXISTS sync_items_stored ON sync_items (user_id, stored_at);
