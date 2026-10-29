-- The owner's agents: the API agent and the Sign-up agent. Each has a name the
-- owner picks, standing instructions and a memory the owner can read and edit.
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    memory TEXT NOT NULL DEFAULT '',
    last_run INTEGER NOT NULL DEFAULT 0,
    last_report TEXT NOT NULL DEFAULT '',
    last_warned_day TEXT NOT NULL DEFAULT ''
);
