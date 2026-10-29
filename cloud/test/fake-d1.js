// An in-memory SQLite database with the parts of D1's API the Worker uses.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

export function fakeD1() {
    const db = new DatabaseSync(':memory:');
    for (const file of fs.readdirSync(MIGRATIONS).sort()) db.exec(fs.readFileSync(new URL(file, MIGRATIONS), 'utf8'));
    const statement = (sql, args = []) => ({
        bind: (...values) => statement(sql, values),
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => { db.prepare(sql).run(...args); return { success: true }; }
    });
    return { prepare: sql => statement(sql), raw: db };
}

