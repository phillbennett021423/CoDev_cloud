// Story Studio: game projects, each with its own story bible (characters, factions,
// abilities, places, timeline, lore, quests, items, dialogue, scenes), for any user's game.
//
//   CodevStoryStudio.createStudioStore(storage)       the projects, kept in localStorage
//   CodevStoryStudio.buildStudioTools(store, deps)    studio_read / studio_save / studio_remove / studio_export
//   CodevStoryStudio.studioPromptBlock(store, task)   a short index of the bible for the agent's prompt
//   CodevStoryStudio.exportFiles(project, format)     Godot-ready files: JSON, a GDScript data file, dialogue, cutscenes, Markdown
//   CodevStoryStudio.mount(container, store, deps)    the 🎭 Story Studio view
//
// Agents read the bible before they write about a project and save what they make
// back into it, so a character made today is still known next week. Talking to a
// character and the Scene Builder go through deps.chat, the page's normal model
// call, so the spending limits in Settings apply to them like any other request;
// a scene also stops after MAX_SCENE_CALLS agent turns until the user says go on.
//
// More story tools are added by adding a kind to KINDS (it then shows in the
// bible, the agents' tools and every export) or a tab to SECTIONS. Art and 3D
// tools belong in their own section, not here.
//
// Everything typed by the user or written by a model is set with textContent.
// The same file runs in the page and in Node (tests), like agent-client.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevStoryStudio = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const STORE_KEY = "codev_story_studio";
    const MAX_PROJECTS = 30;
    const MAX_ENTRIES = 600;
    const MAX_FIELD_CHARS = 6000;
    const MAX_SUMMARY_CHARS = 400;
    const MAX_LINES = 200;
    const MAX_LINKS = 40;
    const MAX_SNAPSHOTS = 10;
    const MAX_BEATS = 40;
    const MAX_SCENE_LINES = 60;        // lines in one scene
    const MAX_SCENE_CALLS = 30;        // model calls per scene in one sitting, to keep its cost down
    const MAX_SCENE_FRAMES = 4;        // storyboard pictures per scene
    const MAX_BATCH_LINES = 8;
    const PROMPT_INDEX_CHARS = 1800;
    const CHAT_HISTORY_TURNS = 12;

    // [key, label] for each field. "art: true" kinds get a concept-art button.
    const KINDS = {
        character: { label: "Character", plural: "Characters", icon: "🧍", art: true, fields: [
            ["role", "Role in the story"], ["appearance", "Appearance"], ["personality", "Personality"], ["backstory", "Backstory"],
            ["powers", "Powers and abilities"], ["speaking_style", "How they talk"], ["goals", "Goals and fears"], ["relationships", "Relationships"]] },
        faction: { label: "Faction", plural: "Factions", icon: "🛡️", fields: [
            ["purpose", "What they want"], ["members", "Leaders and members"], ["territory", "Territory"], ["history", "History"]] },
        ability: { label: "Ability", plural: "Abilities", icon: "✨", fields: [
            ["owner", "Who has it"], ["effect", "What it does"], ["limits", "Limits and cost"], ["gameplay", "In gameplay (button, cooldown, damage)"]] },
        location: { label: "Place", plural: "Places", icon: "🗺️", art: true, fields: [
            ["description", "Description"], ["history", "History"], ["inhabitants", "Who is there"]] },
        event: { label: "Timeline event", plural: "Timeline", icon: "⏳", fields: [
            ["when", "When"], ["what", "What happened"], ["who", "Who was involved"], ["consequences", "What it changed"]] },
        lore: { label: "Lore", plural: "Lore", icon: "📜", fields: [["details", "Details"]] },
        quest: { label: "Quest", plural: "Quests", icon: "🎯", fields: [
            ["giver", "Who gives it"], ["objective", "Objective"], ["steps", "Steps"], ["reward", "Reward"]] },
        item: { label: "Item", plural: "Items", icon: "🗡️", art: true, fields: [
            ["description", "Description"], ["effect", "Effect and stats"], ["where", "Where to find it"]] },
        dialogue: { label: "Dialogue", plural: "Dialogue", icon: "💬", lines: true, fields: [["scene", "When it plays"]] },
        scene: { label: "Scene", plural: "Scenes", icon: "🎬", lines: true, fields: [
            ["location", "Where"], ["characters", "Who is in it"], ["goal", "Goal or conflict"]] },
        arc: { label: "Story arc", plural: "Story arcs", icon: "📈", beats: true, fields: [
            ["characters", "Whose arc"], ["goal", "Where it starts and where it ends"], ["stakes", "What's at stake"]] }
    };

    // 🕸 Relationship types for the web, with their colors.
    const LINK_TYPES = [["ally", "Ally", "#10b981"], ["enemy", "Enemy", "#ef4444"], ["rival", "Rival", "#f59e0b"], ["family", "Family", "#a855f7"],
        ["love", "Love", "#ec4899"], ["mentor", "Mentor", "#38bdf8"], ["member", "Member of", "#94a3b8"], ["other", "Other", "#64748b"]];
    // 📈 Where a beat of an arc stands.
    const BEAT_STATUS = [["idea", "💡 Idea"], ["written", "✍️ Written"], ["in_game", "🎮 In the game"]];
    const KIND_NAMES = Object.keys(KINDS);

    // 🎭 Mood faces: one portrait per mood, picked by a line's emotion word.
    const MOODS = [["neutral", "Calm"], ["happy", "Happy"], ["angry", "Angry"], ["sad", "Sad"], ["scared", "Scared"], ["determined", "Determined"], ["surprised", "Surprised"]];
    const MOOD_WORDS = {
        happy: /happ|joy|glad|amus|laugh|smil|cheer|excit|warm|playful|smug|delight|relie/,
        angry: /ang|rage|furi|mad\b|hostil|cold|irrit|annoy|snarl|bitter|defian|menac|threat/,
        sad: /sad|grie|sorrow|tear|melanch|regret|hurt|guilt|tired|weary|lonel/,
        scared: /scar|fear|afraid|panic|nerv|anxi|terr|wary|uneas/,
        determined: /determin|resol|firm|confident|fierce|focus|serious|stern|proud|brave/,
        surprised: /surpri|shock|amaz|stun|confus|disbel|startl/
    };
    function moodFor(emotion) {
        const e = String(emotion || "").toLowerCase();
        for (const [mood, pattern] of Object.entries(MOOD_WORDS)) if (pattern.test(e)) return mood;
        return "neutral";
    }
    // The face for a line: that mood's portrait, else the calm one, else the concept art.
    function portraitFor(entry, emotion) {
        if (!entry) return "";
        const faces = entry.portraits || {};
        const face = faces[moodFor(emotion)] || faces.neutral || entry.art;
        return face && face.thumb ? face.thumb : "";
    }

    // 🔊 A character's voice: the device's own voices (free), or ElevenLabs with the user's key.
    function normalizeVoice(v) {
        if (!v || typeof v !== "object") return undefined;
        const num = (x, lo, hi, d) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : d; };
        return { engine: v.engine === "elevenlabs" ? "elevenlabs" : "device", name: clip(v.name, 120), rate: num(v.rate, 0.5, 2, 1), pitch: num(v.pitch, 0, 2, 1), elevenId: clip(String(v.elevenId || "").replace(/[^\w-]/g, ""), 60) };
    }

    // Requests that are about a game's story or design get the studio tools and index.
    // (Not "scene" or "script" alone: in Godot those are code.)
    const STUDIO_TASK = /\b(stor(y|ies)|storyline|lore|characters?|backstor(y|ies)|plot|dialog(ue)?s?|villains?|heroe?s?|factions?|quests?|npcs?|cutscenes?|story bible|story studio|timeline|world-?building)\b/i;

    function now() { return new Date().toISOString(); }
    function newId(prefix) { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
    function clip(text, max) { return String(text == null ? "" : text).slice(0, max); }
    function clean(text, max) { return clip(text, max).replace(/\r\n?/g, "\n").trim(); }
    function sameName(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }
    function slug(text) { return String(text || "").toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "untitled"; }
    function words(text) { return new Set(String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || []); }

    function normalizeKind(kind) {
        const k = String(kind || "").toLowerCase().trim().replace(/s$/, "");
        if (KINDS[k]) return k;
        const aliases = { place: "location", timeline: "event", dialog: "dialogue", power: "ability", abilitie: "ability", weapon: "item", npc: "character", hero: "character", villain: "character", group: "faction", script: "dialogue", cutscene: "scene", mission: "quest" };
        return aliases[k] || "";
    }

    // Pictures are kept as data URLs made on this device, never outside addresses.
    function isPicture(url) { return typeof url === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(url); }

    function normalizeLines(lines) {
        if (!Array.isArray(lines)) return [];
        return lines.slice(0, MAX_LINES).map(line => {
            const out = { speaker: clean(line && line.speaker, 80), text: clean(line && line.text, 1200) };
            if (line && (line.type === "direction" || line.type === "narration")) out.type = line.type;
            if (line && line.emotion) out.emotion = clean(line.emotion, 40);
            if (line && line.frame && isPicture(line.frame.thumb)) out.frame = { id: clip(line.frame.id, 80), thumb: String(line.frame.thumb) };
            if (line && Array.isArray(line.choices) && line.choices.length) {
                out.choices = line.choices.slice(0, 6).map(c => ({ text: clean(c && c.text, 300), next: clean(c && c.next, 80) })).filter(c => c.text);
            }
            return out;
        }).filter(line => line.text);
    }

    // ---------- The store ----------

    function createStudioStore(storage, key = STORE_KEY) {
        let state = { projects: [], activeId: "" };
        try {
            const saved = JSON.parse((storage && storage.getItem(key)) || "null");
            if (saved && Array.isArray(saved.projects)) state = { projects: saved.projects.filter(p => p && p.id && p.name), activeId: saved.activeId || "" };
        } catch (err) { /* start empty */ }
        state.projects.forEach(p => { p.entries = Array.isArray(p.entries) ? p.entries : []; });
        const listeners = new Set();

        function save() {
            try { if (storage) storage.setItem(key, JSON.stringify(state)); } catch (err) {
                return "Couldn't save: this device's storage is full. Export the project, then delete pictures or old projects.";
            }
            listeners.forEach(fn => { try { fn(); } catch (err) { /* a view's problem */ } });
            return "";
        }

        function projects() { return state.projects; }
        function project(nameOrId) {
            if (!nameOrId) return state.projects.find(p => p.id === state.activeId) || state.projects[0] || null;
            return state.projects.find(p => p.id === nameOrId || sameName(p.name, nameOrId)) || null;
        }
        function active() { return project(""); }
        function setActive(id) { if (state.projects.some(p => p.id === id)) { state.activeId = id; save(); } }

        function createProject({ name, engine = "Godot 4", pitch = "", activate = true } = {}) {
            name = clean(name, 80);
            if (!name) return { error: "A project needs a name." };
            if (project(name)) return { error: `There's already a project named "${name}".` };
            if (state.projects.length >= MAX_PROJECTS) return { error: `CoDev keeps up to ${MAX_PROJECTS} game projects. Delete one first.` };
            const p = { id: newId("game"), name, engine: clean(engine, 40) || "Godot 4", pitch: clean(pitch, 1000), entries: [], createdAt: now(), updatedAt: now() };
            state.projects.push(p);
            if (activate || !project(state.activeId)) state.activeId = p.id;
            const error = save();
            return error ? { error } : { project: p };
        }

        function updateProject(id, patch) {
            const p = project(id);
            if (!p) return "No such project.";
            if (patch.name != null) {
                const name = clean(patch.name, 80);
                if (!name) return "A project needs a name.";
                if (state.projects.some(o => o !== p && sameName(o.name, name))) return `There's already a project named "${name}".`;
                p.name = name;
            }
            if (patch.engine != null) p.engine = clean(patch.engine, 40) || "Godot 4";
            if (patch.pitch != null) p.pitch = clean(patch.pitch, 1000);
            if (patch.narrator !== undefined) p.narrator = normalizeVoice(patch.narrator);
            p.updatedAt = now();
            return save();
        }

        function deleteProject(id) {
            state.projects = state.projects.filter(p => p.id !== id);
            if (state.activeId === id) state.activeId = state.projects[0] ? state.projects[0].id : "";
            return save();
        }

        function findEntry(p, nameOrId, kind) {
            if (!p || !nameOrId) return null;
            const k = kind ? normalizeKind(kind) : "";
            return p.entries.find(e => e.id === nameOrId)
                || p.entries.find(e => sameName(e.name, nameOrId) && (!k || e.kind === k))
                || (k ? null : null);
        }

        // Adds or updates one entry. Only the fields given change; the rest stay.
        // A locked entry changes only when data.locked turns the lock off first.
        function saveEntry(projectRef, data) {
            const p = project(projectRef);
            if (!p) return { error: "No game project yet. Create one first." };
            const kind = normalizeKind(data.kind);
            const name = clean(data.name, 120);
            let entry = (data.id && p.entries.find(e => e.id === data.id)) || (name && findEntry(p, name, kind || undefined));
            if (entry && entry.locked && data.locked !== false) return { error: `"${entry.name}" is locked, so it can't change. Unlock it in Story Studio first.`, locked: true };
            if (!entry && !kind) return { error: `Pick a kind: ${KIND_NAMES.join(", ")}.` };
            if (!entry && !name) return { error: "An entry needs a name." };
            const created = !entry;
            if (created) {
                if (p.entries.length >= MAX_ENTRIES) return { error: `A project holds up to ${MAX_ENTRIES} entries.` };
                entry = { id: newId("e"), kind, name, summary: "", fields: {}, tags: [], createdAt: now() };
                p.entries.push(entry);
            }
            if (kind) entry.kind = kind;
            if (name && name !== entry.name) {
                entry.name = name;
                p.entries.forEach(e => (e.links || []).forEach(l => { if (l.to === entry.id) l.name = name; }));
            }
            if (data.summary != null) entry.summary = clean(data.summary, MAX_SUMMARY_CHARS);
            if (data.fields && typeof data.fields === "object") {
                for (const [k, v] of Object.entries(data.fields)) {
                    const fieldKey = slug(k).slice(0, 40);
                    const value = clean(typeof v === "string" ? v : JSON.stringify(v), MAX_FIELD_CHARS);
                    if (value) entry.fields[fieldKey] = value; else delete entry.fields[fieldKey];
                }
            }
            if (Array.isArray(data.tags)) entry.tags = data.tags.map(t => clean(t, 40)).filter(Boolean).slice(0, 20);
            if (Array.isArray(data.lines)) entry.lines = normalizeLines(data.lines);
            if (Array.isArray(data.links)) {
                // Each link points at another entry by id (or by name, from an agent).
                const seen = new Set();
                entry.links = data.links.map(l => {
                    const target = l && (p.entries.find(e => e.id === l.to) || p.entries.find(e => sameName(e.name, l.to || l.name)));
                    if (!target || target === entry) return null;
                    const type = LINK_TYPES.some(([t]) => t === l.type) ? l.type : "other";
                    const key = `${target.id}:${type}`;
                    if (seen.has(key)) return null;
                    seen.add(key);
                    return { to: target.id, name: target.name, type, ...(l.note ? { note: clean(l.note, 200) } : {}) };
                }).filter(Boolean).slice(0, MAX_LINKS);
                if (!entry.links.length) delete entry.links;
            }
            if (Array.isArray(data.beats)) {
                entry.beats = data.beats.slice(0, MAX_BEATS).map(b => ({ text: clean(b && b.text, 600), status: BEAT_STATUS.some(([k]) => k === (b && b.status)) ? b.status : "idea",
                    ...(b && b.scene ? { scene: clip(b.scene, 80) } : {}) })).filter(b => b.text);
            }
            if (typeof data.growth === "boolean") entry.growth = data.growth || undefined;
            if (data.order !== undefined) entry.order = Number.isFinite(Number(data.order)) ? Number(data.order) : undefined;
            if (typeof data.locked === "boolean") entry.locked = data.locked || undefined;
            if (data.art !== undefined) entry.art = data.art && isPicture(data.art.thumb) ? { id: clip(data.art.id, 80), thumb: String(data.art.thumb) } : undefined;
            if (data.voice !== undefined) entry.voice = normalizeVoice(data.voice);
            if (data.portraits && typeof data.portraits === "object") {
                const faces = Object.assign({}, entry.portraits);
                for (const [mood, face] of Object.entries(data.portraits)) {
                    if (!MOODS.some(([m]) => m === mood)) continue;
                    if (face && isPicture(face.thumb)) faces[mood] = { id: clip(face.id, 80), thumb: String(face.thumb) }; else delete faces[mood];
                }
                entry.portraits = Object.keys(faces).length ? faces : undefined;
            }
            entry.updatedAt = now();
            p.updatedAt = now();
            const error = save();
            return error ? { error } : { entry, created, project: p };
        }

        function removeEntry(projectRef, nameOrId) {
            const p = project(projectRef);
            const entry = findEntry(p, nameOrId);
            if (!entry || entry.locked) return null;
            p.entries = p.entries.filter(e => e !== entry);
            p.entries.forEach(e => { if (e.links) { e.links = e.links.filter(l => l.to !== entry.id); if (!e.links.length) delete e.links; } });
            p.updatedAt = now();
            save();
            return entry;
        }

        // 📸 Snapshots: an entry's words (not its pictures) saved under a label, newest first.
        function snapshot(projectRef, id, label) {
            const p = project(projectRef);
            const entry = findEntry(p, id);
            if (!entry) return { error: "No such entry." };
            const data = JSON.parse(JSON.stringify({ name: entry.name, summary: entry.summary, fields: entry.fields, tags: entry.tags, links: entry.links, lines: entry.lines, beats: entry.beats }));
            entry.snapshots = [{ at: now(), label: clean(label, 80) || "Snapshot", data }, ...(entry.snapshots || [])].slice(0, MAX_SNAPSHOTS);
            const error = save();
            return error ? { error } : { entry };
        }

        // Puts a snapshot back, after saving the current version as one, so nothing is lost.
        function restoreSnapshot(projectRef, id, index) {
            const p = project(projectRef);
            const entry = findEntry(p, id);
            const snap = entry && (entry.snapshots || [])[index];
            if (!snap) return { error: "No such snapshot." };
            if (entry.locked) return { error: `"${entry.name}" is locked. Unlock it first.`, locked: true };
            snapshot(p.id, entry.id, `Before going back to "${snap.label}"`);
            const d = snap.data;
            Object.assign(entry, { summary: d.summary || "", fields: Object.assign({}, d.fields), tags: (d.tags || []).slice() });
            ["links", "lines", "beats"].forEach(k => { if (d[k]) entry[k] = JSON.parse(JSON.stringify(d[k])); else delete entry[k]; });
            if (d.name && !p.entries.some(e => e !== entry && e.kind === entry.kind && sameName(e.name, d.name))) entry.name = d.name;
            entry.updatedAt = now();
            const error = save();
            return error ? { error } : { entry };
        }

        function dropSnapshot(projectRef, id, index) {
            const entry = findEntry(project(projectRef), id);
            if (!entry || !entry.snapshots) return;
            entry.snapshots.splice(index, 1);
            if (!entry.snapshots.length) delete entry.snapshots;
            save();
        }

        // A project exported as story_bible.json, from another device or a backup.
        function importProject(text) {
            let data;
            try { data = JSON.parse(text); } catch (err) { return { error: "That isn't a CoDev story bible file (it isn't JSON)." }; }
            const info = data && (data.project || data);
            const entries = data && (data.entries || (data.entries_by_kind && Object.values(data.entries_by_kind).flat()));
            if (!info || !info.name || !Array.isArray(entries)) return { error: "That file has no project name or entries. Export it from CoDev's Story Studio." };
            let name = clean(info.name, 80);
            for (let n = 2; project(name); n++) name = `${clean(info.name, 70)} (${n})`;
            const made = createProject({ name, engine: info.engine, pitch: info.pitch });
            if (made.error) return made;
            const known = new Set(["id", "kind", "name", "summary", "tags", "lines", "fields"]);
            for (const raw of entries.slice(0, MAX_ENTRIES)) {
                if (!raw || !raw.name) continue;
                const fields = Object.assign({}, raw.fields || {});
                for (const [k, v] of Object.entries(raw)) if (!known.has(k) && typeof v === "string") fields[k] = v;
                const kind = normalizeKind(raw.kind) || "lore";
                made.project.entries.push({ id: newId("e"), kind, name: clean(raw.name, 120), summary: clean(raw.summary, MAX_SUMMARY_CHARS),
                    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [slug(k).slice(0, 40), clean(v, MAX_FIELD_CHARS)]).filter(([, v]) => v)),
                    tags: Array.isArray(raw.tags) ? raw.tags.map(t => clean(t, 40)).filter(Boolean) : [],
                    ...(Array.isArray(raw.lines) ? { lines: normalizeLines(raw.lines) } : {}), createdAt: now(), updatedAt: now() });
            }
            const error = save();
            return error ? { error } : { project: made.project };
        }

        return {
            get state() { return state; }, save, projects, project, active, setActive,
            createProject, updateProject, deleteProject, findEntry, saveEntry, removeEntry, importProject, snapshot, restoreSnapshot, dropSnapshot,
            onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
        };
    }

    // ---------- Reading the bible as text ----------

    function fieldLabel(kind, key) {
        const found = (KINDS[kind] ? KINDS[kind].fields : []).find(([k]) => k === key);
        return found ? found[1] : key.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());
    }

    function lineText(l) {
        if (l.type === "direction") return `(Direction: ${l.text})`;
        if (l.type === "narration") return `[Narration] ${l.text}`;
        return `${l.speaker || "?"}${l.emotion ? ` (${l.emotion})` : ""}: ${l.text}`;
    }

    function linkLabel(type) { return (LINK_TYPES.find(([t]) => t === type) || LINK_TYPES[LINK_TYPES.length - 1])[1]; }

    function describeEntry(entry) {
        const kind = KINDS[entry.kind] || KINDS.lore;
        const out = [`${kind.label}: ${entry.name}${entry.locked ? " (locked: the user keeps it exactly as it is)" : ""}`];
        if (entry.summary) out.push(`Summary: ${entry.summary}`);
        const order = kind.fields.map(([k]) => k);
        const keys = Object.keys(entry.fields || {}).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
        for (const k of keys) out.push(`${fieldLabel(entry.kind, k)}: ${entry.fields[k]}`);
        if (entry.links && entry.links.length) out.push(`Relationships: ${entry.links.map(l => `${linkLabel(l.type)} of ${l.name}${l.note ? ` (${l.note})` : ""}`).join("; ")}`);
        if (entry.beats && entry.beats.length) out.push("Beats:", ...entry.beats.map((b, i) => `${i + 1}. [${b.status}] ${b.text}`));
        if (entry.tags && entry.tags.length) out.push(`Tags: ${entry.tags.join(", ")}`);
        if (entry.lines && entry.lines.length) {
            out.push("Lines:");
            entry.lines.forEach((l, i) => out.push(`${i + 1}. ${lineText(l)}${l.choices ? ` [choices: ${l.choices.map(c => c.text + (c.next ? ` -> ${c.next}` : "")).join(" | ")}]` : ""}`));
        }
        return out.join("\n");
    }

    function indexLines(p, task = "", maxChars = PROMPT_INDEX_CHARS) {
        const want = words(task);
        const scored = p.entries.map((e, i) => {
            const have = words(`${e.name} ${e.summary} ${(e.tags || []).join(" ")}`);
            const named = String(task).toLowerCase().includes(e.name.toLowerCase()) ? 100 : 0;
            return { e, score: named + [...have].filter(w => want.has(w)).length * 5 + (e.kind === "character" ? 2 : 0) - i / 1000 };
        }).sort((a, b) => b.score - a.score);
        const lines = [];
        let used = 0, left = 0;
        for (const { e } of scored) {
            const line = `- ${(KINDS[e.kind] || KINDS.lore).label}: ${e.name}${e.summary ? ` (${clip(e.summary, 140)})` : ""}`;
            if (used + line.length > maxChars) { left++; continue; }
            lines.push(line);
            used += line.length + 1;
        }
        if (left) lines.push(`- …and ${left} more (studio_read lists them all)`);
        return lines;
    }

    function isStudioTask(store, task) {
        const text = String(task || "");
        if (/^\[Story Studio\]/.test(text) || STUDIO_TASK.test(text)) return true;
        const lower = text.toLowerCase();
        return store.projects().some(p => (p.name.length >= 3 && lower.includes(p.name.toLowerCase()))
            || p.entries.some(e => e.name.length >= 4 && lower.includes(e.name.toLowerCase())));
    }

    // The bible's index for the agent's prompt, or "" when the task isn't about a game's story.
    function studioPromptBlock(store, task) {
        if (!store.projects().length || !isStudioTask(store, task)) return "";
        const lower = String(task || "").toLowerCase();
        const p = store.projects().find(x => lower.includes(x.name.toLowerCase())) || store.active();
        const others = store.projects().filter(x => x !== p).map(x => `"${x.name}"`);
        return `[Story Studio] The user's game project "${p.name}" (${p.engine})${p.pitch ? `: ${clip(p.pitch, 300)}` : ""}. `
            + `Before writing about its characters, world or story, read the entries you need with studio_read so what you write fits what is already canon, and save what you create or change with studio_save. `
            + (others.length ? `Other projects: ${others.join(", ")}. ` : "")
            + (p.entries.length ? `Its story bible (${p.entries.length} entries):\n${indexLines(p, task).join("\n")}` : "Its story bible is empty so far.");
    }

    // ---------- Exports ----------

    const GD_CONSTANTS = { character: "CHARACTERS", faction: "FACTIONS", ability: "ABILITIES", location: "LOCATIONS", event: "TIMELINE", lore: "LORE", quest: "QUESTS", item: "ITEMS", dialogue: "DIALOGUE", scene: "SCENES", arc: "ARCS" };

    // One entry as plain data: id, name, summary, its fields at the top level, tags, lines.
    function entryData(entry, ids) {
        const data = { id: ids.get(entry), kind: entry.kind, name: entry.name };
        if (entry.summary) data.summary = entry.summary;
        Object.assign(data, entry.fields || {});
        if (entry.tags && entry.tags.length) data.tags = entry.tags.slice();
        if (entry.links && entry.links.length) {
            const byId = new Map();
            ids.forEach((id, e) => byId.set(e.id, { id, kind: e.kind }));
            data.links = entry.links.filter(l => byId.has(l.to)).map(l => ({ to: byId.get(l.to).id, to_kind: byId.get(l.to).kind, type: l.type, ...(l.note ? { note: l.note } : {}) }));
        }
        if (entry.beats && entry.beats.length) data.beats = entry.beats.map(b => {
            const scene = b.scene && [...ids.keys()].find(e => e.id === b.scene);
            return { text: b.text, status: b.status, ...(scene ? { scene: ids.get(scene) } : {}) };
        });
        if (entry.order !== undefined) data.order = entry.order;
        if (entry.kind === "dialogue" || entry.kind === "scene") {
            const byName = new Map();
            ids.forEach((id, e) => { if (e.kind === "character") byName.set(e.name.toLowerCase(), id); });
            // Each line is a node with an id and the next node's id, so a game can walk it
            // as a dialogue tree (choices point elsewhere) or play it straight as a cutscene.
            const lines = entry.lines || [];
            data.lines = lines.map((l, i) => {
                const line = { id: `n${i + 1}`, type: l.type || "line" };
                if (line.type === "line") { line.speaker = l.speaker; line.speaker_id = byName.get(String(l.speaker || "").toLowerCase()) || slug(l.speaker); }
                line.text = l.text;
                if (l.emotion) line.emotion = l.emotion;
                if (l.choices) line.choices = l.choices;
                if (l.frame) line.storyboard_frame = true;
                line.next = i + 1 < lines.length ? `n${i + 2}` : "";
                return line;
            });
        }
        return data;
    }

    function entryIds(p) {
        const ids = new Map();
        const used = new Set();
        for (const e of p.entries) {
            let id = slug(e.name);
            for (let n = 2; used.has(`${e.kind}:${id}`); n++) id = `${slug(e.name)}_${n}`;
            used.add(`${e.kind}:${id}`);
            ids.set(e, id);
        }
        return ids;
    }

    // Timeline events in story order: by their order number, then as they were added.
    function timelineOrder(list) {
        return list.map((e, i) => ({ e, i })).sort((a, b) => (a.e.order ?? 1e9) - (b.e.order ?? 1e9) || a.i - b.i).map(x => x.e);
    }

    function byKind(p) {
        const groups = {};
        for (const kind of KIND_NAMES) {
            const list = p.entries.filter(e => e.kind === kind);
            if (list.length) groups[kind] = kind === "event" ? timelineOrder(list) : list;
        }
        return groups;
    }

    function toJson(p) {
        const ids = entryIds(p);
        const groups = byKind(p);
        const entries_by_kind = {};
        for (const [kind, list] of Object.entries(groups)) entries_by_kind[GD_CONSTANTS[kind].toLowerCase()] = list.map(e => entryData(e, ids));
        return JSON.stringify({ format: "codev-story-bible", version: 1, project: { name: p.name, engine: p.engine, pitch: p.pitch }, exported_at: now(), entries_by_kind }, null, 2) + "\n";
    }

    function toGdscript(p) {
        const ids = entryIds(p);
        const groups = byKind(p);
        const out = [
            `# ${p.name}: game data from CoDev's Story Studio, exported ${now().slice(0, 10)}.`,
            "# Export again from CoDev to update it; changes made here are replaced.",
            "# Use it from any script:",
            `#   const GameData = preload("res://game_data/game_data.gd")`,
            `#   var hero: Dictionary = GameData.CHARACTERS["${ids.get((groups.character || [])[0]) || "some_id"}"]`,
            "#   for line in GameData.dialogue_lines(\"some_dialogue_id\"): print(line.speaker, \": \", line.text)",
            "extends RefCounted",
            "",
            `const PROJECT := ${JSON.stringify({ name: p.name, engine: p.engine, pitch: p.pitch })}`
        ];
        for (const kind of KIND_NAMES) {
            const map = {};
            for (const e of groups[kind] || []) map[ids.get(e)] = entryData(e, ids);
            out.push("", `const ${GD_CONSTANTS[kind]} := ${JSON.stringify(map, null, "\t")}`);
        }
        out.push("",
            "static func dialogue_lines(dialogue_id: String) -> Array:",
            "\treturn DIALOGUE.get(dialogue_id, {}).get(\"lines\", [])",
            "",
            "static func scene_beats(scene_id: String) -> Array:",
            "\treturn SCENES.get(scene_id, {}).get(\"lines\", [])",
            "",
            "static func character(character_id: String) -> Dictionary:",
            "\treturn CHARACTERS.get(character_id, {})",
            "");
        return out.join("\n");
    }

    function toMarkdown(p) {
        const out = [`# ${p.name}`, "", `Engine: ${p.engine}`];
        if (p.pitch) out.push("", p.pitch);
        for (const [kind, list] of Object.entries(byKind(p))) {
            out.push("", `## ${KINDS[kind].plural}`);
            for (const e of list) {
                out.push("", `### ${e.name}`);
                if (e.summary) out.push("", `*${e.summary}*`);
                for (const [k, v] of Object.entries(e.fields || {})) out.push("", `**${fieldLabel(e.kind, k)}:** ${v}`);
                if (e.lines && e.lines.length) out.push("", ...e.lines.map(l => l.type === "direction" ? `- *(${l.text})*` : l.type === "narration" ? `- *${l.text}*` : `- **${l.speaker || "?"}:** ${l.text}`));
            }
        }
        return out.join("\n") + "\n";
    }

    // 🌿 A "what if" scene names the scene it branched from and the line it left at.
    function branchInfo(p, e, ids) {
        const parent = e.fields.branch_of && p.entries.find(x => x.kind === "scene" && sameName(x.name, e.fields.branch_of));
        return parent ? { branch_of: ids.get(parent), branch_from: `n${Number(e.fields.branch_at) || 1}` } : {};
    }

    // format: all | json | gdscript | dialogue | scenes | markdown. Returns { "path": content }.
    function exportFiles(p, format = "all", folder = "game_data") {
        const base = String(folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        const at = name => base ? `${base}/${name}` : name;
        const files = {};
        if (format === "all" || format === "json") files[at("story_bible.json")] = toJson(p);
        if (format === "all" || format === "gdscript") files[at("game_data.gd")] = toGdscript(p);
        if (format === "all" || format === "markdown") files[at("story_bible.md")] = toMarkdown(p);
        if (format === "all" || format === "dialogue") {
            const ids = entryIds(p);
            for (const e of p.entries.filter(x => x.kind === "dialogue")) {
                const data = entryData(e, ids);
                files[at(`dialogue/${ids.get(e)}.json`)] = JSON.stringify({ id: data.id, title: e.name, scene: e.fields.scene || "", start: data.lines.length ? "n1" : "", lines: data.lines }, null, 2) + "\n";
            }
        }
        if (format === "all" || format === "scenes") {
            const ids = entryIds(p);
            for (const e of p.entries.filter(x => x.kind === "scene")) {
                const data = entryData(e, ids);
                const cast = String(e.fields.characters || "").split(/\s*,\s*/).filter(Boolean);
                files[at(`scenes/${ids.get(e)}.json`)] = JSON.stringify({ format: "codev-cutscene", version: 1, id: data.id, title: e.name,
                    location: e.fields.location || "", characters: cast.map(name => ({ name, id: (p.entries.find(c => c.kind === "character" && sameName(c.name, name)) && ids.get(p.entries.find(c => c.kind === "character" && sameName(c.name, name)))) || slug(name) })),
                    goal: e.fields.goal || "", start: data.lines.length ? "n1" : "", ...branchInfo(p, e, ids), beats: data.lines }, null, 2) + "\n";
            }
        }
        return files;
    }

    // ---------- Talking to characters ----------

    function relatedEntries(p, character, limit = 6) {
        const text = describeEntry(character).toLowerCase();
        return p.entries.filter(e => e !== character && e.kind !== "dialogue" && e.name.length >= 3 && text.includes(e.name.toLowerCase())).slice(0, limit);
    }

    function characterSystemPrompt(p, character) {
        const related = relatedEntries(p, character);
        return [
            `You are ${character.name}, a character in the game "${p.name}". Stay in character for the whole conversation: speak only as ${character.name} would, in their voice, with their knowledge, attitude and way of talking. `
            + "Never mention being an AI or a model. Keep each reply short, a few sentences, like a line of game dialogue, unless the user asks for more. "
            + `If the user writes "(ooc)" or "out of character", step out briefly and answer as a writing assistant, then go back to being ${character.name}. `
            + "Start every in-character reply with your mood in square brackets, one word, like [angry] or [amused].",
            `[Character card]\n${describeEntry(character)}`,
            p.pitch && `[The game] ${p.pitch}`,
            related.length && `[What ${character.name} knows about]\n${related.map(describeEntry).join("\n\n")}`
        ].filter(Boolean).join("\n\n");
    }

    // The scene's cast and place, as entries from the bible where they exist.
    function sceneCast(p, scene) {
        return String((scene.fields || {}).characters || "").split(/\s*,\s*/).filter(Boolean)
            .map(name => p.entries.find(e => e.kind === "character" && sameName(e.name, name)) || { kind: "character", name, summary: "", fields: {} });
    }

    function scenePlace(p, scene) {
        const where = String((scene.fields || {}).location || "");
        return p.entries.find(e => e.kind === "location" && where && (sameName(e.name, where) || where.toLowerCase().includes(e.name.toLowerCase()))) || null;
    }

    // Stays the same for every turn of a scene, so a provider's prompt cache can reuse it.
    function sceneDirectorPrompt(p, scene) {
        const cast = sceneCast(p, scene);
        const place = scenePlace(p, scene);
        const f = scene.fields || {};
        return [
            `You write a scene for the game "${p.name}", one turn at a time. You play every character in it, each strictly in their own voice from their card: their speaking style, personality, goals and what they know. `
            + "Follow the director's notes. Lines are what a character says out loud, short like game dialogue (one to three sentences), with at most one word of emotion. Never write for the player unless asked, and never step outside the story.",
            ...cast.map(c => `[Character card]\n${describeEntry(c)}`),
            place && `[Place]\n${describeEntry(place)}`,
            p.pitch && `[The game] ${p.pitch}`,
            `[Scene] ${scene.name}\nWhere: ${f.location || "not set"}\nWho is in it: ${cast.map(c => c.name).join(", ") || "not set"}\nGoal or conflict: ${f.goal || "not set"}`
        ].filter(Boolean).join("\n\n");
    }

    // opts: speaker (a cast member, or "" for whoever fits), count, direction, avoid (a line to write differently).
    function sceneTurnMessage(scene, opts = {}) {
        const count = Math.max(1, Math.min(MAX_BATCH_LINES, opts.count || 1));
        const lines = scene.lines || [];
        const sofar = lines.slice(-30).map(lineText).join("\n");
        return `[Scene so far]\n${sofar ? `${lines.length > 30 ? "…\n" : ""}${sofar}` : "(It hasn't started. Open the scene.)"}\n\n`
            + (opts.direction ? `[Director's note] ${opts.direction}\n\n` : "")
            + (opts.avoid ? `Rewrite this line a different way: "${opts.avoid}"\n\n` : "")
            + `Write the next ${count > 1 ? `${count} lines` : "line"}${opts.speaker ? `, spoken by ${opts.speaker}` : ", spoken by whoever should speak next"}. `
            + (count > 1 ? `Answer with only a JSON array: [{"speaker": "Name", "text": "what they say", "emotion": "word"}]`
                : `Answer with only JSON: {"speaker": "Name", "text": "what they say", "emotion": "word"}`);
    }

    // 🎤 Interview questions that dig into a character.
    const INTERVIEW_QUESTIONS = [
        "What's your earliest memory?", "What do you fear more than anything?", "Who do you trust, and why?", "What's the worst thing you've ever done?",
        "What do you want more than anything?", "What would make you betray your friends?", "Who taught you how to fight, or how to survive?",
        "What do you do when no one is watching?", "What's a secret you've never told anyone?", "Who do you hate, and what did they do?",
        "What would you change about your past?", "What makes you laugh?", "Where do you feel at home?", "What do people get wrong about you?",
        "What would you die for?", "How do you want to be remembered?", "What's in your pockets right now?", "What's your biggest regret?",
        "What do you think of the people in charge?", "What keeps you going on the worst days?"
    ];

    // 🔍 Lore checker: the entry or scene to check against the rest of the bible.
    function loreCheckPrompt(p, target, maxChars = 10000) {
        const targets = Array.isArray(target) ? target : [target];
        const text = targets.map(t => describeEntry(t)).join("\n\n").toLowerCase();
        const rest = p.entries.filter(e => !targets.includes(e))
            .map(e => ({ e, score: (text.includes(e.name.toLowerCase()) ? 10 : 0) + (["character", "event", "lore", "faction", "ability", "location"].includes(e.kind) ? 1 : 0) }))
            .sort((a, b) => b.score - a.score);
        const bible = [];
        let used = 0;
        for (const { e } of rest) {
            const d = describeEntry(e);
            if (used + d.length > maxChars) continue;
            bible.push(d);
            used += d.length;
        }
        return [
            { role: "system", content: `You check the story bible of the game "${p.name}" for contradictions. Compare what is being checked with the bible and with itself: names, ages, dates and the order of events, powers and their limits, who knows what, relationships, places, who is alive or dead. `
                + "Report only real contradictions or clear inconsistencies, not style or missing detail. Answer with only a JSON array, empty if there are none: "
                + '[{"problem": "what contradicts what, in one sentence", "conflicts_with": "the bible entry name, or \"itself\"", "suggestion": "one way to fix it"}]' },
            { role: "user", content: `[Story bible]\n${bible.join("\n\n") || "(nothing else yet)"}\n\n[Check this]\n${targets.map(t => describeEntry(t)).join("\n\n")}` }
        ];
    }

    function parseIssues(text) {
        const match = String(text || "").match(/\[[\s\S]*\]/);
        if (!match) return null;
        try {
            const list = JSON.parse(match[0]);
            return Array.isArray(list) ? list.filter(i => i && i.problem).slice(0, 20).map(i => ({ problem: clean(i.problem, 400), conflicts_with: clean(i.conflicts_with, 120), suggestion: clean(i.suggestion, 400) })) : null;
        } catch (err) { return null; }
    }

    // 🌱 Growth: changes a scene or chat could justify, only ever suggested. The user approves each one.
    const GROWTH_FIELDS = ["summary", "personality", "backstory", "goals", "relationships", "powers", "speaking_style", "appearance"];
    function growthPrompt(p, characters, sourceText) {
        return [
            { role: "system", content: `You help the writer of the game "${p.name}" decide whether characters have grown after what just happened. Be conservative: suggest a change only when the events clearly justify it, at most 3 in all, and none if nothing important changed. `
                + `Each suggestion replaces one field with its full new text, keeping everything that still holds. Fields: ${GROWTH_FIELDS.join(", ")}. Answer with only a JSON array: `
                + '[{"character": "Name", "field": "goals", "new_text": "the whole new text of that field", "why": "one sentence pointing at what happened"}]' },
            { role: "user", content: `${characters.map(c => `[Character card]\n${describeEntry(c)}`).join("\n\n")}\n\n[What happened]\n${clip(sourceText, 8000)}` }
        ];
    }

    function parseGrowth(text, characters) {
        const match = String(text || "").match(/\[[\s\S]*\]/);
        if (!match) return null;
        let list;
        try { list = JSON.parse(match[0]); } catch (err) { return null; }
        if (!Array.isArray(list)) return null;
        return list.map(g => {
            const c = g && characters.find(x => sameName(x.name, g.character));
            const field = g && slug(g.field);
            if (!c || !GROWTH_FIELDS.includes(field) || !clean(g.new_text, 10)) return null;
            return { entryId: c.id, name: c.name, field, new_text: clean(g.new_text, MAX_FIELD_CHARS), why: clean(g.why, 300) };
        }).filter(Boolean).slice(0, 3);
    }

    // 🖨️ A character sheet as a standalone page, light colors for printing.
    function esc(text) { return String(text == null ? "" : text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function characterSheetHtml(p, entry) {
        const kind = KINDS[entry.kind] || KINDS.lore;
        const face = (entry.portraits && entry.portraits.neutral) || entry.art;
        const faces = MOODS.filter(([m]) => m !== "neutral" && entry.portraits && entry.portraits[m]);
        const order = kind.fields.map(([k]) => k);
        const fields = Object.keys(entry.fields || {}).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
        const relations = (entry.links || []).map(l => `<li><b>${esc(linkLabel(l.type))}</b> of ${esc((p.entries.find(e => e.id === l.to) || l).name)}${l.note ? ` (${esc(l.note)})` : ""}</li>`);
        p.entries.forEach(e => (e.links || []).forEach(l => { if (l.to === entry.id) relations.push(`<li>${esc(e.name)}: <b>${esc(linkLabel(l.type).toLowerCase())}</b>${l.note ? ` (${esc(l.note)})` : ""}</li>`); }));
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(entry.name)} · ${esc(p.name)}</title>
<style>body{font-family:Georgia,"Times New Roman",serif;color:#1f2937;background:#fff;margin:0;padding:32px;max-width:820px;margin:auto}header{display:flex;gap:24px;align-items:center;border-bottom:3px solid #1f2937;padding-bottom:16px}
header img{width:180px;height:180px;object-fit:cover;border-radius:12px;border:1px solid #d1d5db}h1{margin:0;font-size:2.2rem}.game{color:#6b7280;text-transform:uppercase;letter-spacing:.1em;font-size:.8rem}.sum{font-style:italic;font-size:1.1rem;margin-top:8px}
h2{font-size:1rem;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin:22px 0 4px;border-bottom:1px solid #e5e7eb}p{margin:4px 0 0;white-space:pre-wrap;line-height:1.45}.faces{display:flex;gap:10px;flex-wrap:wrap}.faces figure{margin:0;text-align:center;font-size:.75rem;color:#6b7280}
.faces img{width:84px;height:84px;object-fit:cover;border-radius:8px;display:block}footer{margin-top:28px;font-size:.75rem;color:#9ca3af}@media print{body{padding:0}}</style></head><body>
<header>${face ? `<img src="${esc(face.thumb)}" alt="">` : ""}<div><div class="game">${esc(p.name)} · ${esc(kind.label)}</div><h1>${esc(entry.name)}</h1>${entry.summary ? `<div class="sum">${esc(entry.summary)}</div>` : ""}</div></header>
${fields.map(k => `<h2>${esc(fieldLabel(entry.kind, k))}</h2><p>${esc(entry.fields[k])}</p>`).join("\n")}
${relations.length ? `<h2>Relationships</h2><ul>${relations.join("")}</ul>` : ""}
${faces.length ? `<h2>Moods</h2><div class="faces">${faces.map(([m, label]) => `<figure><img src="${esc(entry.portraits[m].thumb)}" alt=""><figcaption>${esc(label)}</figcaption></figure>`).join("")}</div>` : ""}
${entry.tags && entry.tags.length ? `<h2>Tags</h2><p>${esc(entry.tags.join(", "))}</p>` : ""}
<footer>Character sheet from CoDev Story Studio · ${esc(now().slice(0, 10))}</footer></body></html>`;
    }

    // "[angry] Get out." -> { mood: "angry", text: "Get out." }
    function splitMood(reply) {
        const m = /^\s*\[([^\]\n]{1,24})\]\s*/.exec(String(reply || ""));
        return m ? { mood: m[1].trim().toLowerCase(), text: String(reply).slice(m[0].length).trim() } : { mood: "", text: String(reply || "").trim() };
    }

    function parseSceneLines(text, characters) {
        const raw = String(text || "");
        let lines = [];
        const array = raw.match(/\[[\s\S]*\]/);
        const object = raw.match(/\{[\s\S]*\}/);
        for (const match of [array, object]) {
            if (!match || lines.length) continue;
            try { const parsed = JSON.parse(match[0]); lines = Array.isArray(parsed) ? parsed : [parsed]; } catch (err) { lines = []; }
        }
        if (!lines.length) {
            // Plain "Name: text" lines, when the model ignored the JSON instruction.
            const names = characters.map(c => c.name.toLowerCase());
            lines = raw.split(/\n+/).map(l => /^\**([^:*]{1,60}?)\**\s*:\s*\**\s*(.+)$/.exec(l.trim())).filter(m => m && names.includes(m[1].trim().toLowerCase()))
                .map(m => ({ speaker: m[1].trim(), text: m[2].trim() }));
        }
        // A speaker the model misspelled keeps the cast's spelling.
        lines.forEach(l => { const c = characters.find(x => l && sameName(x.name, l.speaker)); if (c) l.speaker = c.name; });
        return normalizeLines(lines.filter(l => l && typeof l === "object")).map(l => { delete l.type; return l; });
    }

    function framePrompt(p, scene, line) {
        const cast = sceneCast(p, scene);
        const place = scenePlace(p, scene);
        const looks = cast.map(c => `${c.name}: ${clip((c.fields || {}).appearance || c.summary, 160)}`).join("; ");
        return `Storyboard frame for a video game cutscene${p.pitch ? ` (${clip(p.pitch, 150)})` : ""}. Place: ${clip((scene.fields || {}).location || "", 120)}${place ? `, ${clip(place.fields.description || place.summary, 160)}` : ""}. `
            + `Characters: ${looks}. Moment: ${line.speaker ? `${line.speaker}${line.emotion ? ` (${line.emotion})` : ""} says "${clip(line.text, 200)}"` : clip(line.text, 200)}. Cinematic shot, concept art.`;
    }

    // ---------- The agents' tools ----------

    function buildStudioTools(store, deps = {}) {
        const pick = name => store.project(name) || null;
        const kindList = KIND_NAMES.join(", ");
        const noProject = () => store.projects().length
            ? `No project named that. Projects: ${store.projects().map(p => `"${p.name}"`).join(", ")}.`
            : "There are no game projects yet. Create one by calling studio_save with project set to the game's name (or ask the user for it); the user can also make one in the 🎭 Story Studio tab.";
        return [
            {
                name: "studio_read",
                description: "Read the user's game projects in CoDev's Story Studio: each one's story bible of characters, factions, abilities, places, timeline events, lore, quests, items and dialogue. "
                    + "With no name it lists the project's entries; with name it returns that entry in full; with query it finds entries that mention something. Read what you need before writing new story, characters or dialogue for a project, so it stays consistent.",
                inputSchema: { type: "object", properties: {
                    project: { type: "string", description: "The project's name. Leave it out for the one open in Story Studio." },
                    name: { type: "string", description: "Optional: an entry's name, to read it in full." },
                    kind: { type: "string", enum: KIND_NAMES, description: "Optional: list only this kind." },
                    query: { type: "string", description: "Optional: words to find in every entry." }
                } },
                run: async args => {
                    const p = pick(args.project);
                    if (!p) return noProject();
                    if (args.name) {
                        const e = store.findEntry(p, args.name, args.kind);
                        return e ? describeEntry(e) : `No entry named "${args.name}" in "${p.name}". Entries: ${p.entries.map(x => x.name).join(", ") || "(none yet)"}.`;
                    }
                    let list = p.entries;
                    const kind = normalizeKind(args.kind);
                    if (kind) list = list.filter(e => e.kind === kind);
                    if (args.query) {
                        const q = String(args.query).toLowerCase();
                        const hits = list.filter(e => describeEntry(e).toLowerCase().includes(q));
                        return hits.length ? hits.slice(0, 8).map(describeEntry).join("\n\n---\n\n") : `Nothing in "${p.name}" mentions "${args.query}".`;
                    }
                    const head = `Project "${p.name}" (${p.engine})${p.pitch ? `: ${p.pitch}` : ""}. ${store.projects().length > 1 ? `Other projects: ${store.projects().filter(x => x !== p).map(x => `"${x.name}"`).join(", ")}. ` : ""}`;
                    return head + (list.length ? `\n${indexLines({ entries: list }, "", 12000).join("\n")}` : "\nNo entries yet.");
                }
            },
            {
                name: "studio_save",
                description: `Add or update an entry in a game project's story bible in CoDev's Story Studio. Kinds: ${kindList}. Saving an existing name updates it, and only the fields you pass change. `
                    + "Character fields: role, appearance, personality, backstory, powers, speaking_style, goals, relationships. Faction: purpose, members, territory, history. Ability: owner, effect, limits, gameplay. Place: description, history, inhabitants. "
                    + "Timeline event: when, what, who, consequences. Lore: details. Quest: giver, objective, steps, reward. Item: description, effect, where. Dialogue: scene, plus lines. Scene (a cutscene script): location, characters (comma-separated names), goal, plus lines; lines can have type \"direction\" or \"narration\". Story arc: characters, goal, stakes, plus beats. Other field names are kept too. "
                    + "Save everything you create for the user's game here (characters, scripts, dialogue), so it's remembered and can be exported to their game. If the project doesn't exist yet, it is created.",
                inputSchema: { type: "object", properties: {
                    project: { type: "string", description: "The project's name. Leave it out for the one open in Story Studio." },
                    kind: { type: "string", enum: KIND_NAMES },
                    name: { type: "string", description: "The entry's name (a character's name, a quest title, a dialogue's title)." },
                    summary: { type: "string", description: "One or two sentences." },
                    fields: { type: "object", description: "Field name to text, like {\"personality\": \"...\", \"powers\": \"...\"}.", additionalProperties: { type: "string" } },
                    tags: { type: "array", items: { type: "string" } },
                    links: { type: "array", description: "Relationships to other entries, for the relationship web. This replaces the entry's old links.", items: { type: "object", properties: {
                        to: { type: "string", description: "The other entry's name." }, type: { type: "string", enum: LINK_TYPES.map(([t]) => t) }, note: { type: "string" } }, required: ["to", "type"] } },
                    order: { type: "number", description: "Timeline events only: its place in story order (lower comes first)." },
                    beats: { type: "array", description: "Story arcs only: the arc's beats in order. This replaces the old beats.", items: { type: "object", properties: {
                        text: { type: "string" }, status: { type: "string", enum: BEAT_STATUS.map(([k]) => k) } }, required: ["text"] } },
                    lines: { type: "array", description: "Dialogue and scenes only: every line in order (this replaces the old lines).", items: { type: "object", properties: {
                        speaker: { type: "string" }, text: { type: "string" }, emotion: { type: "string" },
                        type: { type: "string", enum: ["line", "direction", "narration"], description: "Default line (spoken)." },
                        choices: { type: "array", items: { type: "object", properties: { text: { type: "string" }, next: { type: "string", description: "The id or title of the dialogue this choice leads to." } } } }
                    }, required: ["text"] } }
                }, required: ["name"] },
                run: async args => {
                    let p = pick(args.project);
                    if (!p && args.project) {
                        const made = store.createProject({ name: args.project, activate: false });
                        if (made.error) return made.error;
                        p = made.project;
                    }
                    if (!p) return noProject();
                    // Only story content: pictures, voices, locks, snapshots and growth stay the user's.
                    const data = {};
                    for (const k of ["kind", "name", "summary", "fields", "tags", "lines", "links", "order", "beats"]) if (args[k] !== undefined) data[k] = args[k];
                    const saved = store.saveEntry(p.id, data);
                    if (saved.locked) return `Not saved: the user locked "${data.name}" so it stays exactly as it is. Don't change it; if a change would help, suggest it in your reply and let the user decide.`;
                    if (saved.error) return `Not saved: ${saved.error}`;
                    if (deps.onSaved) deps.onSaved(saved.entry, p);
                    return `${saved.created ? "Added" : "Updated"} ${KINDS[saved.entry.kind].label.toLowerCase()} "${saved.entry.name}" in "${p.name}". The user sees it in the 🎭 Story Studio tab.`;
                }
            },
            {
                name: "studio_remove",
                description: "Delete one entry from a game project's story bible, only when the user asks for it to be removed. CoDev asks the user first.",
                inputSchema: { type: "object", properties: { project: { type: "string" }, name: { type: "string" } }, required: ["name"] },
                run: async args => {
                    const p = pick(args.project);
                    if (!p) return noProject();
                    const e = store.findEntry(p, args.name);
                    if (!e) return `No entry named "${args.name}" in "${p.name}".`;
                    if (e.locked) return `"${e.name}" is locked by the user and can't be deleted.`;
                    if (deps.confirm && !(await deps.confirm(`An agent wants to delete "${e.name}" from ${p.name}'s story bible. Delete it?`))) return "The user kept it.";
                    store.removeEntry(p.id, e.id);
                    return `Deleted "${e.name}" from "${p.name}".`;
                }
            },
            {
                name: "studio_export",
                description: "Write a game project's story bible into the user's connected project folder as files the game can use: story_bible.json, game_data.gd (a GDScript file of constants: CHARACTERS, ABILITIES, DIALOGUE, SCENES and so on, plus dialogue_lines() and scene_beats()), one JSON file per dialogue in dialogue/, one cutscene JSON per scene in scenes/, and story_bible.md to read. "
                    + "Use it when the user wants the characters or dialogue in their game.",
                inputSchema: { type: "object", properties: {
                    project: { type: "string" },
                    format: { type: "string", enum: ["all", "json", "gdscript", "dialogue", "scenes", "markdown"], description: "Default all." },
                    folder: { type: "string", description: "Folder inside the project. Default game_data." }
                } },
                run: async args => {
                    const p = pick(args.project);
                    if (!p) return noProject();
                    const files = exportFiles(p, args.format || "all", args.folder == null ? "game_data" : args.folder);
                    if (!deps.writeFile) return "No project folder can be written here. Tell the user to open 🎭 Story Studio and use Export to download the files.";
                    const results = [];
                    for (const [path, content] of Object.entries(files)) results.push(await deps.writeFile(path, content));
                    return `Exported "${p.name}":\n${results.join("\n")}`;
                }
            }
        ];
    }

    // ---------- The view ----------

    const STYLE_ID = "codev-story-studio-style";
    const CSS = `
.gs { display: flex; flex-direction: column; gap: 12px; min-width: 0; max-width: 100%; }
.gs > * { min-width: 0; max-width: 100%; }
.gs-row > *, .gs-bar > * { min-width: 0; }
.gs-row input[type=text], .gs-bar input[type=text] { flex: 1 1 180px; }
.gs-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.gs-bar select, .gs input[type=text], .gs input[type=password], .gs textarea, .gs select { background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 6px; padding: 7px 9px; font-size: 0.85rem; font-family: inherit; max-width: 100%; }
.gs textarea { min-height: 64px; resize: vertical; width: 100%; box-sizing: border-box; }
.gs input[type=text] { box-sizing: border-box; }
.gs-btn { background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 6px; padding: 7px 12px; cursor: pointer; font-size: 0.82rem; white-space: nowrap; }
.gs-btn.primary { background: var(--accent); color: #031623; border-color: var(--accent); font-weight: bold; }
.gs-btn.danger { color: var(--danger); }
.gs-btn:disabled { opacity: 0.5; cursor: default; }
.gs-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border-color); overflow-x: auto; }
.gs-tabs button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-muted); padding: 8px 12px; cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
.gs-tabs button.on { color: var(--text-main); border-bottom-color: var(--accent); font-weight: bold; }
.gs-note { font-size: 0.8rem; color: var(--text-muted); }
.gs-msg { font-size: 0.8rem; color: var(--accent); min-height: 1em; white-space: pre-wrap; }
.gs-msg.bad { color: var(--danger); }
.gs-kinds { display: flex; flex-wrap: wrap; gap: 6px; }
.gs-chip { background: var(--bg-card); border: 1px solid var(--border-color); color: var(--text-muted); border-radius: 999px; padding: 4px 10px; font-size: 0.78rem; cursor: pointer; }
.gs-chip.on { border-color: var(--accent); color: var(--text-main); }
.gs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.gs-card { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 10px; cursor: pointer; display: flex; gap: 10px; min-width: 0; text-align: left; color: var(--text-main); font: inherit; }
.gs-card:hover { border-color: var(--accent); }
.gs-card img, .gs-art img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; flex: none; }
.gs-card .gs-icon { width: 56px; height: 56px; display: flex; align-items: center; justify-content: center; font-size: 1.6rem; background: var(--bg-card); border-radius: 8px; flex: none; }
.gs-card b { display: block; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs-card span.gs-sum { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 0.78rem; color: var(--text-muted); }
.gs-card div { min-width: 0; }
.gs-form { display: flex; flex-direction: column; gap: 10px; background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 12px; }
.gs-form label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; color: var(--text-muted); }
.gs-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.gs-row > label { flex: 1 1 200px; }
.gs-art img { width: 160px; height: 160px; cursor: zoom-in; }
.gs-lines { display: flex; flex-direction: column; gap: 6px; }
.gs-line { display: grid; grid-template-columns: minmax(80px, 140px) 1fr auto; gap: 6px; align-items: start; }
.gs-chat { display: flex; flex-direction: column; gap: 8px; background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 10px; max-height: 50vh; overflow-y: auto; min-height: 120px; }
.gs-bubble { max-width: 85%; padding: 8px 11px; border-radius: 12px; font-size: 0.88rem; white-space: pre-wrap; word-wrap: break-word; }
.gs-bubble.me { align-self: flex-end; background: var(--accent); color: #031623; }
.gs-bubble.them { align-self: flex-start; background: var(--bg-card); color: var(--text-main); }
.gs-bubble small { display: block; font-weight: bold; font-size: 0.72rem; opacity: 0.8; margin-bottom: 2px; }
.gs-send { display: flex; gap: 8px; }
.gs-section { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 8px 12px; }
.gs-section summary { cursor: pointer; font-weight: bold; font-size: 0.88rem; padding: 2px 0; }
.gs-section > * + * { margin-top: 8px; }
.gs-faces { display: flex; flex-wrap: wrap; gap: 8px; }
.gs-face { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 84px; font-size: 0.75rem; }
.gs-face img, .gs-face .gs-icon { width: 72px; height: 72px; border-radius: 10px; object-fit: cover; cursor: zoom-in; display: flex; align-items: center; justify-content: center; background: var(--bg-card); font-size: 1.6rem; }
.gs-face .gs-btn { padding: 3px 8px; font-size: 0.72rem; }
.gs-inline { flex-direction: row !important; align-items: center; gap: 6px !important; }
.gs-said { display: flex; gap: 8px; align-items: flex-start; }
.gs-said > img { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex: none; }
.gs-bubble.playing { outline: 2px solid var(--warning); }
.gs-web-box { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; overflow: hidden; }
.gs-web { width: 100%; height: auto; max-height: 70vh; display: block; }
.gs-web-node { cursor: pointer; }
.gs-web-name, .gs-web-label { paint-order: stroke; stroke: var(--bg-panel); stroke-width: 4px; stroke-linejoin: round; }
.gs-web-name { fill: var(--text-main); font-size: 14px; font-weight: bold; }
.gs-web-label { font-size: 12px; }
.gs-timeline { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--border-color); display: flex; flex-direction: column; gap: 10px; }
.gs-timeline li { display: flex; gap: 8px; align-items: center; position: relative; flex-wrap: wrap; }
.gs-timeline li::before { content: ""; position: absolute; left: -21px; top: 50%; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); transform: translateY(-50%); }
.gs-when { font-size: 0.75rem; color: var(--accent); min-width: 90px; }
.gs-updown { display: flex; gap: 4px; }
.gs-board { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 6px; align-items: flex-start; }
.gs-arc { flex: 0 0 280px; max-width: 85vw; background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.gs-arc-head { background: none; border: none; text-align: left; color: var(--text-main); cursor: pointer; padding: 0; font: inherit; }
.gs-arc-head .gs-sum { display: block; font-size: 0.75rem; color: var(--text-muted); }
.gs-beat { background: var(--bg-card); border-radius: 8px; padding: 8px; font-size: 0.85rem; border-left: 3px solid var(--border-color); display: flex; flex-direction: column; gap: 6px; }
.gs-beat.s-written { border-left-color: var(--warning); }
.gs-beat.s-in_game { border-left-color: var(--success); }
.gs-beat .gs-btn, .gs-beat select { padding: 3px 7px; font-size: 0.72rem; }
.gs-issues { display: flex; flex-direction: column; gap: 6px; }
.gs-issue { background: var(--bg-card); border-left: 3px solid var(--warning); border-radius: 6px; padding: 8px 10px; font-size: 0.85rem; display: flex; flex-direction: column; gap: 3px; }
.gs-growth { border-color: var(--success); }
.gs label.gs-chip { flex-direction: row; align-items: center; gap: 6px; color: var(--text-main); }
.gs-speak { background: none; border: none; cursor: pointer; font-size: 0.85rem; padding: 0 2px; opacity: 0.75; }
.gs-send input { flex: 1; min-width: 0; }
@media (max-width: 600px) { .gs-line { grid-template-columns: 1fr; } .gs-grid { grid-template-columns: 1fr; } }
`;

    function el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === "class") node.className = v;
            else if (k === "text") node.textContent = v;
            else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
            else if (k === "value") node.value = v;
            else node.setAttribute(k, v === true ? "" : v);
        }
        for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
        return node;
    }

    // Tabs of the view. New game-dev tools add a section here.
    const SECTIONS = [
        { id: "bible", label: "📖 Story bible" },
        { id: "talk", label: "🗣️ Talk to a character" },
        { id: "scenes", label: "🎬 Scene Builder" },
        { id: "web", label: "🕸️ Relationships" },
        { id: "timeline", label: "⏳ Timeline" },
        { id: "arcs", label: "📈 Story arcs" },
        { id: "export", label: "📦 Export to your game" }
    ];

    // deps: chat(messages) -> text, makeArt(prompt) -> { id, thumb } | { error }, openArt(id),
    // askAgent(text), saveFile(name, content, mime), writeFile(path, content) -> message | null,
    // canWriteFolder() -> bool, pickFile() -> text, confirm(text) -> bool
    function mount(container, store, deps = {}) {
        if (!document.getElementById(STYLE_ID)) document.head.append(el("style", { id: STYLE_ID, text: CSS }));
        const ui = { section: "bible", kindFilter: "", search: "", editing: null, talkWith: "", talkLog: [], sceneId: "", sceneSetup: false, sceneCalls: {}, loreResults: {}, asked: new Set(), growth: [], busy: false };
        const confirmFn = deps.confirm || (text => window.confirm(text));
        let msgTimer = null;

        function say(node, text, bad) {
            node.textContent = text || "";
            node.classList.toggle("bad", !!bad);
            clearTimeout(msgTimer);
            if (text && !bad) msgTimer = setTimeout(() => { node.textContent = ""; }, 6000);
        }

        function render() {
            container.replaceChildren(el("div", { class: "gs" }, header(), body()));
        }

        function header() {
            const projects = store.projects();
            const p = store.active();
            const msg = el("div", { class: "gs-msg" });
            const picker = el("select", { "aria-label": "Game project", onchange: e => { store.setActive(e.target.value); ui.editing = null; ui.talkWith = ""; ui.talkLog = []; ui.sceneId = ""; ui.sceneSetup = false; render(); } },
                projects.map(x => el("option", { value: x.id, selected: p && x.id === p.id, text: `🎮 ${x.name}` })));
            const newBtn = el("button", { class: "gs-btn primary", type: "button", text: "＋ New game project", onclick: () => { ui.section = "new"; render(); } });
            const bar = el("div", { class: "gs-bar" }, projects.length ? picker : null, newBtn,
                p ? el("button", { class: "gs-btn", type: "button", text: "✏️ Project details", onclick: () => { ui.section = "details"; render(); } }) : null,
                el("button", { class: "gs-btn", type: "button", text: "⬆ Import", title: "Load a story_bible.json exported from CoDev (from another device or a backup)", onclick: async () => {
                    const text = deps.pickFile ? await deps.pickFile() : null;
                    if (!text) return;
                    const done = store.importProject(text);
                    if (done.error) return say(msg, done.error, true);
                    ui.section = "bible";
                    render();
                } }));
            const intro = el("div", { class: "gs-note", text: "Build your game's world with your agents: characters, factions, powers, places, timeline, quests, items and dialogue. Agents read this story bible before they write and save what they make here, then you export it into your game." });
            const tabs = p ? el("div", { class: "gs-tabs", role: "tablist" }, SECTIONS.map(s => el("button", { type: "button", class: ui.section === s.id ? "on" : "", text: s.label, onclick: () => { ui.section = s.id; render(); } }))) : null;
            return el("div", { class: "gs" }, el("h3", { text: "🎭 Story Studio" }), intro, bar, msg, tabs);
        }

        function body() {
            const p = store.active();
            const panel = p && growthPanel(p);
            const view = section(p);
            return panel ? el("div", { class: "gs" }, panel, view) : view;
        }

        function section(p) {
            if (ui.section === "new" || !p) return projectForm(null);
            if (ui.section === "details") return projectForm(p);
            if (ui.section === "talk") return talkView(p);
            if (ui.section === "scenes") return scenesView(p);
            if (ui.section === "web") return webView(p);
            if (ui.section === "timeline") return timelineView(p);
            if (ui.section === "arcs") return arcsView(p);
            if (ui.section === "export") return exportView(p);
            return ui.editing ? entryForm(p, ui.editing) : bibleView(p);
        }

        function projectForm(p) {
            const msg = el("div", { class: "gs-msg" });
            const name = el("input", { type: "text", value: p ? p.name : "", placeholder: "Your game's name", maxlength: "80" });
            const engine = el("input", { type: "text", value: p ? p.engine : "Godot 4", placeholder: "Godot 4, Unity, Unreal…", maxlength: "40" });
            const pitch = el("textarea", { placeholder: "What the game is about: genre, setting, tone, the main story in a few lines.", maxlength: "1000" });
            pitch.value = p ? p.pitch : "";
            const save = el("button", { class: "gs-btn primary", type: "button", text: p ? "Save" : "Create project", onclick: () => {
                if (p) {
                    const error = store.updateProject(p.id, { name: name.value, engine: engine.value, pitch: pitch.value });
                    if (error) return say(msg, error, true);
                } else {
                    const made = store.createProject({ name: name.value, engine: engine.value, pitch: pitch.value });
                    if (made.error) return say(msg, made.error, true);
                }
                ui.section = "bible";
                render();
            } });
            const remove = p ? el("button", { class: "gs-btn danger", type: "button", text: "🗑 Delete project", onclick: () => {
                if (!confirmFn(`Delete "${p.name}" and its ${p.entries.length} entries? Export it first if you want a copy. This can't be undone.`)) return;
                store.deleteProject(p.id);
                ui.section = "bible";
                render();
            } }) : null;
            const cancel = store.projects().length ? el("button", { class: "gs-btn", type: "button", text: "Cancel", onclick: () => { ui.section = "bible"; render(); } }) : null;
            return el("div", { class: "gs-form" }, el("b", { text: p ? `Project details: ${p.name}` : "New game project" }),
                el("div", { class: "gs-row" }, el("label", {}, "Name", name), el("label", {}, "Engine", engine)),
                el("label", {}, "About the game", pitch),
                p ? voicePicker(p.narrator, false, narrator => store.updateProject(p.id, { narrator }), () => `This is the narrator of ${p.name}.`) : null,
                p ? el("div", { class: "gs-note", text: "The voice above is the narrator's, for narration when a scene is read aloud." }) : null,
                p && deps.setElevenLabsKey ? elevenLabsBox() : null,
                msg, el("div", { class: "gs-row" }, save, cancel, remove));
        }

        function bibleView(p) {
            const counts = {};
            p.entries.forEach(e => { counts[e.kind] = (counts[e.kind] || 0) + 1; });
            const chips = el("div", { class: "gs-kinds" },
                el("button", { type: "button", class: `gs-chip ${ui.kindFilter ? "" : "on"}`, text: `All (${p.entries.length})`, onclick: () => { ui.kindFilter = ""; render(); } }),
                KIND_NAMES.map(k => el("button", { type: "button", class: `gs-chip ${ui.kindFilter === k ? "on" : ""}`, text: `${KINDS[k].icon} ${KINDS[k].plural}${counts[k] ? ` (${counts[k]})` : ""}`, onclick: () => { ui.kindFilter = k; render(); } })));
            const search = el("input", { type: "text", placeholder: "Search the story bible", value: ui.search, "aria-label": "Search the story bible" });
            const grid = el("div", { class: "gs-grid" });
            const fill = () => {
                const q = ui.search.toLowerCase();
                const list = p.entries.filter(e => (!ui.kindFilter || e.kind === ui.kindFilter) && (!q || describeEntry(e).toLowerCase().includes(q)));
                grid.replaceChildren(...list.map(card));
                if (!list.length) grid.append(el("div", { class: "gs-note", text: p.entries.length ? "Nothing matches." : "Empty so far. Add an entry yourself, or ask an agent below." }));
            };
            search.addEventListener("input", () => { ui.search = search.value; fill(); });
            fill();
            const addKind = ui.kindFilter || "character";
            const add = el("button", { class: "gs-btn primary", type: "button", text: `＋ New ${KINDS[addKind].label.toLowerCase()}`, onclick: () => { ui.editing = { kind: addKind, isNew: true }; render(); } });
            const ask = el("input", { type: "text", placeholder: `Ask an agent, like "create a villain who controls time"`, "aria-label": "Ask an agent" });
            const askBtn = el("button", { class: "gs-btn", type: "button", text: "🤖 Ask an agent", onclick: () => sendToAgent(p, ask.value) });
            ask.addEventListener("keydown", e => { if (e.key === "Enter") sendToAgent(p, ask.value); });
            return el("div", { class: "gs" }, chips, el("div", { class: "gs-bar" }, search, add),
                el("div", { class: "gs-send" }, ask, askBtn), grid,
                p.entries.length > 1 ? loreChecker(p, p.entries.filter(e => !["dialogue", "scene"].includes(e.kind)), `all:${p.id}`, "🔍 Check the whole bible for contradictions") : null);
        }

        function sendToAgent(p, text, entry) {
            text = String(text || "").trim();
            if (!text || !deps.askAgent) return;
            deps.askAgent(`[Story Studio] For my game "${p.name}"${entry ? `, about the ${KINDS[entry.kind].label.toLowerCase()} "${entry.name}"` : ""}: ${text}\n(Read the story bible with studio_read first, and save what you make with studio_save.)`);
        }

        function card(e) {
            const kind = KINDS[e.kind] || KINDS.lore;
            return el("button", { type: "button", class: "gs-card", onclick: () => { ui.editing = e; render(); } },
                e.art && e.art.thumb ? el("img", { src: e.art.thumb, alt: "" }) : el("span", { class: "gs-icon", text: kind.icon }),
                el("div", {}, el("b", { text: e.name }), el("span", { class: "gs-sum", text: e.summary || kind.label })));
        }

        function entryForm(p, entry) {
            const isNew = !!entry.isNew;
            const msg = el("div", { class: "gs-msg" });
            const kindSelect = el("select", { "aria-label": "Kind", onchange: () => { draft.kind = kindSelect.value; ui.editing = Object.assign({}, entry, collect(), { kind: kindSelect.value }); render(); } },
                KIND_NAMES.map(k => el("option", { value: k, selected: k === entry.kind, text: `${KINDS[k].icon} ${KINDS[k].label}` })));
            const draft = { kind: entry.kind };
            const name = el("input", { type: "text", value: entry.name || "", placeholder: "Name", maxlength: "120" });
            const summary = el("textarea", { placeholder: "One or two sentences", maxlength: String(MAX_SUMMARY_CHARS) });
            summary.value = entry.summary || "";
            const kind = KINDS[entry.kind] || KINDS.lore;
            const known = kind.fields.map(([k]) => k);
            const extra = Object.keys(entry.fields || {}).filter(k => !known.includes(k));
            const inputs = {};
            const fieldNodes = [...kind.fields, ...extra.map(k => [k, fieldLabel(entry.kind, k)])].map(([k, label]) => {
                const box = el("textarea", { maxlength: String(MAX_FIELD_CHARS) });
                box.value = (entry.fields || {})[k] || "";
                inputs[k] = box;
                return el("label", {}, label, box);
            });
            const tags = el("input", { type: "text", value: (entry.tags || []).join(", "), placeholder: "Tags, separated by commas" });
            let lines = (entry.lines || []).map(l => Object.assign({}, l));
            const linesBox = el("div", { class: "gs-lines" });
            const drawLines = () => {
                linesBox.replaceChildren(...lines.map((l, i) => {
                    const who = el("input", { type: "text", value: l.speaker || "", placeholder: "Who", "aria-label": "Speaker" });
                    const said = el("input", { type: "text", value: l.text || "", placeholder: "What they say", "aria-label": "Line" });
                    who.addEventListener("input", () => { l.speaker = who.value; });
                    said.addEventListener("input", () => { l.text = said.value; });
                    return el("div", { class: "gs-line" }, who, said, el("button", { class: "gs-btn", type: "button", text: "✕", title: "Remove line", onclick: () => { lines.splice(i, 1); drawLines(); } }));
                }), el("button", { class: "gs-btn", type: "button", text: "＋ Line", onclick: () => { lines.push({ speaker: "", text: "" }); drawLines(); } }));
            };
            if (kind.lines) drawLines();
            function collect() {
                const fields = {};
                for (const [k, box] of Object.entries(inputs)) fields[k] = box.value;
                return { kind: kindSelect.value, name: name.value, summary: summary.value, fields, tags: tags.value.split(",").map(t => t.trim()).filter(Boolean), ...(KINDS[kindSelect.value].lines ? { lines } : {}) };
            }
            const save = el("button", { class: "gs-btn primary", type: "button", text: "Save", onclick: () => {
                const data = collect();
                if (!isNew) data.id = entry.id;
                else if (store.findEntry(p, data.name, data.kind)) return say(msg, `There's already a ${KINDS[data.kind].label.toLowerCase()} named "${data.name}".`, true);
                const saved = store.saveEntry(p.id, data);
                if (saved.error) return say(msg, saved.error, true);
                ui.editing = saved.entry;
                render();
            } });
            const back = el("button", { class: "gs-btn", type: "button", text: "← Back", onclick: () => { ui.editing = null; render(); } });
            const remove = !isNew ? el("button", { class: "gs-btn danger", type: "button", text: "🗑 Delete", onclick: () => {
                if (!confirmFn(`Delete "${entry.name}"?`)) return;
                store.removeEntry(p.id, entry.id);
                ui.editing = null;
                render();
            } }) : null;
            const art = el("div", { class: "gs-art gs-row" });
            if (!isNew && kind.art) {
                if (entry.art && entry.art.thumb) art.append(el("img", { src: entry.art.thumb, alt: `Concept art of ${entry.name}`, title: "Open full size", onclick: () => deps.openArt && deps.openArt(entry.art.id) }));
                art.append(el("button", { class: "gs-btn", type: "button", text: entry.art ? "🎨 New concept art" : "🎨 Make concept art", disabled: !deps.makeArt, onclick: async event => {
                    const btn = event.currentTarget;
                    btn.disabled = true;
                    say(msg, "Making a picture with the picture service set in Settings… this can take up to a minute.");
                    const f = entry.fields || {};
                    const prompt = `Concept art for a video game${p.pitch ? ` (${clip(p.pitch, 200)})` : ""}: ${KINDS[entry.kind].label.toLowerCase()} "${entry.name}". ${entry.summary || ""} ${f.appearance || f.description || ""}. Full body, clean background, detailed, game character design sheet style.`.replace(/\s+/g, " ");
                    const made = await deps.makeArt(prompt);
                    btn.disabled = false;
                    if (!made || made.error) return say(msg, (made && made.error) || "The picture couldn't be made.", true);
                    store.saveEntry(p.id, { id: entry.id, art: made });
                    ui.editing = store.findEntry(p, entry.id);
                    render();
                } }));
            }
            const faces = !isNew && entry.kind === "character" ? moodFaces(p, entry, msg) : null;
            const linkBox = !isNew && !["dialogue", "scene", "arc"].includes(entry.kind) ? linkEditor(p, entry, msg) : null;
            const growBox = !isNew && entry.kind === "character" ? growthAndSnapshots(p, entry, msg) : null;
            const sheet = !isNew && entry.kind === "character" ? sheetButtons(p, entry) : null;
            const voiceBox = !isNew && entry.kind === "character" ? voicePicker(entry.voice, entry.locked, voice => store.saveEntry(p.id, { id: entry.id, voice }),
                () => sampleLine(entry)) : null;
            const help = !isNew ? el("div", { class: "gs-send" },
                el("input", { type: "text", placeholder: `Ask an agent, like "flesh out ${entry.name}'s backstory"`, "aria-label": "Ask an agent about this entry", onkeydown: e => { if (e.key === "Enter") sendToAgent(p, e.target.value, entry); } }),
                el("button", { class: "gs-btn", type: "button", text: "🤖 Ask", onclick: e => sendToAgent(p, e.currentTarget.previousSibling.value, entry) })) : null;
            const talk = isNew ? null : entry.kind === "character" ? el("button", { class: "gs-btn", type: "button", text: `🗣️ Talk to ${entry.name}`, onclick: () => { ui.section = "talk"; ui.talkWith = entry.id; ui.talkLog = []; render(); } })
                : entry.kind === "scene" ? el("button", { class: "gs-btn", type: "button", text: "🎬 Open in Scene Builder", onclick: () => { ui.section = "scenes"; ui.sceneId = entry.id; ui.sceneSetup = false; ui.editing = null; render(); } }) : null;
            // 🔒 A locked entry can't be changed by anyone, agents included, until it's unlocked.
            const lock = isNew ? null : el("button", { class: "gs-btn", type: "button", text: entry.locked ? "🔓 Unlock" : "🔒 Lock",
                title: entry.locked ? "Allow changes again" : "Keep it exactly as it is: no edits by you or any agent until you unlock it",
                onclick: () => { store.saveEntry(p.id, { id: entry.id, locked: !entry.locked }); ui.editing = store.findEntry(p, entry.id); render(); } });
            const form = el("div", { class: "gs-form" },
                el("div", { class: "gs-row" }, back, el("b", { text: isNew ? `New ${kind.label.toLowerCase()}` : `${entry.locked ? "🔒 " : ""}${entry.name}` }), talk, lock),
                entry.locked ? el("div", { class: "gs-note", text: "Locked: nothing can change it, not even an agent, until you unlock it. Chats and scenes with it never change it either way." }) : null,
                art, faces, voiceBox, el("div", { class: "gs-row" }, el("label", {}, "Name", name), el("label", {}, "Kind", kindSelect)),
                el("label", {}, "Summary", summary), fieldNodes, kind.lines ? el("label", {}, "Lines", linesBox) : null,
                linkBox, growBox, el("label", {}, "Tags", tags), msg, sheet,
                !isNew ? loreChecker(p, [entry], entry.id) : null, entry.locked ? null : el("div", { class: "gs-row" }, save, remove), help);
            if (entry.locked) {
                form.querySelectorAll("input, textarea, select").forEach(node => { if (!node.closest(".gs-send") && !node.closest(".gs-section")) node.disabled = true; });
                form.querySelectorAll(".gs-art button, .gs-line button, .gs-lines > button, .gs-faces button").forEach(node => { if (!node.dataset.keep) node.disabled = true; });
            }
            return form;
        }

        function seedFor(entry) {
            let h = 7;
            for (const ch of entry.id) h = (h * 31 + ch.charCodeAt(0)) % 1000000007;
            return h;
        }

        function sampleLine(entry) {
            const style = (entry.fields || {}).speaking_style;
            return `I'm ${entry.name}.${entry.summary ? ` ${entry.summary}` : ""}${style ? "" : " This is how I sound."}`;
        }

        // 🎭 One portrait per mood. The same seed (and, with a paid picture service, the calm
        // face as a reference) keeps them looking like the same person.
        function moodFaces(p, entry, msg) {
            const faces = entry.portraits || {};
            const f = entry.fields || {};
            const box = el("div", { class: "gs-faces" });
            const make = async mood => {
                const label = MOODS.find(([m]) => m === mood)[1].toLowerCase();
                const prompt = `Portrait headshot of ${entry.name}, a character from the video game${p.pitch ? ` "${clip(p.pitch, 150)}"` : ""}. ${clip(f.appearance || entry.summary || "", 300)}. `
                    + `Facial expression: ${label}. Same character design every time, consistent face, hair and outfit, plain dark background, game portrait art.`;
                const reference = mood !== "neutral" && faces.neutral ? faces.neutral.id : "";
                return deps.makeArt(prompt.replace(/\s+/g, " "), { seed: seedFor(entry), referenceId: reference });
            };
            for (const [mood, label] of MOODS) {
                const face = faces[mood];
                box.append(el("div", { class: "gs-face" },
                    face ? el("img", { src: face.thumb, alt: `${entry.name}, ${label}`, title: "Open full size", onclick: () => deps.openArt && deps.openArt(face.id) }) : el("span", { class: "gs-icon", text: "🙂" }),
                    el("small", { text: label }),
                    el("button", { class: "gs-btn", type: "button", text: face ? "Redo" : "Make", disabled: !deps.makeArt, onclick: async event => {
                        const btn = event.currentTarget;
                        btn.disabled = true;
                        say(msg, `Drawing ${entry.name} looking ${label.toLowerCase()}… this can take up to a minute.`);
                        const made = await make(mood);
                        if (!made || made.error) { btn.disabled = false; return say(msg, (made && made.error) || "The picture couldn't be made.", true); }
                        const saved = store.saveEntry(p.id, { id: entry.id, portraits: { [mood]: made } });
                        if (saved.error) return say(msg, saved.error, true);
                        ui.editing = saved.entry;
                        render();
                    } }),
                    face ? el("button", { class: "gs-btn", type: "button", text: "✕", title: "Remove this face", onclick: () => { store.saveEntry(p.id, { id: entry.id, portraits: { [mood]: null } }); ui.editing = store.findEntry(p, entry.id); render(); } }) : null));
            }
            return el("details", { class: "gs-section", open: !!entry.portraits },
                el("summary", { text: `🎭 Mood faces${entry.portraits ? ` (${Object.keys(faces).length})` : ""}` }),
                el("div", { class: "gs-note", text: "Optional. Make the calm face first; the others are drawn to match it. They show next to the character's lines in chats and scenes, picked by each line's mood. Each one counts toward today's picture limit in Settings." }), box);
        }

        // 🔊 A voice: one of this device's voices (free), or an ElevenLabs voice when a key is set.
        function voicePicker(current, locked, onSave, sample) {
            const v = normalizeVoice(current) || { engine: "device", name: "", rate: 1, pitch: 1, elevenId: "" };
            const list = deps.voices ? deps.voices() : [];
            const engine = el("select", { "aria-label": "Voice service" }, el("option", { value: "device", text: "This device's voices (free)" }),
                deps.hasElevenLabs && deps.hasElevenLabs() ? el("option", { value: "elevenlabs", selected: v.engine === "elevenlabs", text: "ElevenLabs (your key, paid)" }) : null);
            const name = el("select", { "aria-label": "Voice" }, el("option", { value: "", text: "Default voice" }), list.map(x => el("option", { value: x.name, selected: x.name === v.name, text: `${x.name}${x.lang ? ` (${x.lang})` : ""}` })));
            const eleven = el("input", { type: "text", value: v.elevenId, placeholder: "ElevenLabs voice ID", "aria-label": "ElevenLabs voice ID" });
            const rate = el("input", { type: "range", min: "0.5", max: "2", step: "0.05", value: String(v.rate), "aria-label": "Speed" });
            const pitch = el("input", { type: "range", min: "0", max: "2", step: "0.05", value: String(v.pitch), "aria-label": "Pitch" });
            const read = () => ({ engine: engine.value, name: name.value, rate: Number(rate.value), pitch: Number(pitch.value), elevenId: eleven.value.trim() });
            const sync = () => { const ev = engine.value === "elevenlabs"; name.style.display = ev || !list.length ? "none" : ""; eleven.style.display = ev ? "" : "none"; };
            engine.addEventListener("change", sync);
            sync();
            const controls = [engine, name, eleven, rate, pitch];
            controls.forEach(c => c.addEventListener("change", () => onSave(read())));
            if (locked) controls.forEach(c => { c.disabled = true; });
            const test = el("button", { class: "gs-btn", type: "button", "data-keep": "1", text: "▶ Test voice", disabled: !deps.speak, onclick: () => deps.speak(sample(), read()).catch(err => alert(err.message)) });
            return el("details", { class: "gs-section", open: !!current },
                el("summary", { text: "🔊 Voice" }),
                el("div", { class: "gs-row" }, engine, name, eleven),
                el("div", { class: "gs-row" }, el("label", { class: "gs-inline" }, "Speed", rate), el("label", { class: "gs-inline" }, "Pitch", pitch), test),
                list.length || engine.value === "elevenlabs" ? null : el("div", { class: "gs-note", text: "On this device the voice is set by speed and pitch. Android uses its own text-to-speech voice." }));
        }

        // 🕸 The entry's relationships, edited in place. Saved at once; links show in the web.
        function linkEditor(p, entry, msg) {
            const others = p.entries.filter(e => e !== entry && !["dialogue", "scene", "arc"].includes(e.kind));
            const links = (entry.links || []).map(l => Object.assign({}, l));
            const saveLinks = list => {
                const saved = store.saveEntry(p.id, { id: entry.id, links: list });
                if (saved.error) return say(msg, saved.error, true);
                ui.editing = saved.entry;
                render();
            };
            const typeSelect = (value, onchange) => el("select", { "aria-label": "Relationship", onchange }, LINK_TYPES.map(([t, label]) => el("option", { value: t, selected: t === value, text: label })));
            const rows = links.map((l, i) => {
                const target = p.entries.find(e => e.id === l.to);
                return el("div", { class: "gs-row" },
                    el("b", { text: target ? target.name : l.name, style: "min-width: 100px;" }),
                    typeSelect(l.type, e => { links[i].type = e.target.value; saveLinks(links); }),
                    el("input", { type: "text", value: l.note || "", placeholder: "Note (optional)", "aria-label": "Note", onchange: e => { links[i].note = e.target.value; saveLinks(links); } }),
                    el("button", { class: "gs-btn", type: "button", text: "✕", title: "Remove", onclick: () => { links.splice(i, 1); saveLinks(links); } }));
            });
            const who = el("select", { "aria-label": "Related to" }, el("option", { value: "", text: "Choose…" }), others.map(e => el("option", { value: e.id, text: `${(KINDS[e.kind] || KINDS.lore).icon} ${e.name}` })));
            const type = typeSelect("ally");
            const add = el("button", { class: "gs-btn", type: "button", text: "＋ Add", onclick: () => { if (who.value) saveLinks([...links, { to: who.value, type: type.value }]); } });
            return el("details", { class: "gs-section", open: links.length > 0 },
                el("summary", { text: `🕸️ Relationships${links.length ? ` (${links.length})` : ""}` }),
                ...rows, others.length ? el("div", { class: "gs-row" }, entry.name, type, "of", who, add) : el("div", { class: "gs-note", text: "Add more entries to link them." }));
        }

        // 🕸 RELATIONSHIP WEB: every linked entry as a node, links colored by type.
        function webView(p) {
            const linked = new Set();
            p.entries.forEach(e => (e.links || []).forEach(l => { if (p.entries.some(x => x.id === l.to)) { linked.add(e.id); linked.add(l.to); } }));
            const nodes = p.entries.filter(e => linked.has(e.id) || (ui.webAll && (e.kind === "character" || e.kind === "faction")));
            const legend = el("div", { class: "gs-kinds" }, LINK_TYPES.map(([, label, color]) => el("span", { class: "gs-chip", style: `border-color: ${color}; color: ${color};`, text: label })),
                el("label", { class: "gs-chip", style: "display: inline-flex; gap: 6px; align-items: center;" }, el("input", { type: "checkbox", checked: !!ui.webAll, onchange: e => { ui.webAll = e.target.checked; render(); } }), "Show unlinked characters and factions"));
            if (!nodes.length) return el("div", { class: "gs" }, legend, el("div", { class: "gs-note", text: "No relationships yet. Open a character and add some under 🕸️ Relationships, or ask an agent: \"link my characters by how they know each other\"." }));
            // A taller, narrower drawing on a phone, so the names stay readable.
            const [W, H] = window.innerWidth < 600 ? [420, 600] : [800, 560];
            const pos = layoutWeb(nodes, p, W, H);
            const NS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(NS, "svg");
            svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
            svg.setAttribute("class", "gs-web");
            svg.setAttribute("role", "img");
            svg.setAttribute("aria-label", `Relationship web of ${p.name}`);
            const add = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; svg.append(n); return n; };
            const focus = ui.webFocus;
            p.entries.forEach(e => (e.links || []).forEach(l => {
                const a = pos.get(e.id), b = pos.get(l.to);
                if (!a || !b) return;
                const [, label, color] = LINK_TYPES.find(([t]) => t === l.type) || LINK_TYPES[LINK_TYPES.length - 1];
                const dim = focus && focus !== e.id && focus !== l.to;
                add("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color, "stroke-width": dim ? 1 : 2.5, opacity: dim ? 0.15 : 0.9 });
                if (!dim) add("text", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4, "text-anchor": "middle", class: "gs-web-label", fill: color }, label);
            }));
            for (const e of nodes) {
                const { x, y } = pos.get(e.id);
                const dim = focus && focus !== e.id && !(e.links || []).some(l => l.to === focus) && !(p.entries.find(o => o.id === focus)?.links || []).some(l => l.to === e.id);
                const g = document.createElementNS(NS, "g");
                g.setAttribute("class", "gs-web-node");
                g.setAttribute("opacity", dim ? "0.25" : "1");
                g.setAttribute("tabindex", "0");
                g.setAttribute("role", "button");
                g.setAttribute("aria-label", e.name);
                g.addEventListener("click", () => { ui.webFocus = ui.webFocus === e.id ? "" : e.id; render(); });
                svg.append(g);
                const circle = document.createElementNS(NS, "circle");
                Object.entries({ cx: x, cy: y, r: 26, fill: "var(--bg-card)", stroke: focus === e.id ? "var(--accent)" : "var(--border-color)", "stroke-width": 2 }).forEach(([k, v]) => circle.setAttribute(k, v));
                g.append(circle);
                const face = portraitFor(e, "");
                if (face) {
                    const clipId = `gsclip-${e.id}`;
                    const defs = document.createElementNS(NS, "clipPath");
                    defs.setAttribute("id", clipId);
                    const c = document.createElementNS(NS, "circle");
                    Object.entries({ cx: x, cy: y, r: 24 }).forEach(([k, v]) => c.setAttribute(k, v));
                    defs.append(c);
                    g.append(defs);
                    const img = document.createElementNS(NS, "image");
                    Object.entries({ href: face, x: x - 24, y: y - 24, width: 48, height: 48, "clip-path": `url(#${clipId})`, preserveAspectRatio: "xMidYMid slice" }).forEach(([k, v]) => img.setAttribute(k, v));
                    g.append(img);
                } else {
                    const icon = document.createElementNS(NS, "text");
                    Object.entries({ x, y: y + 7, "text-anchor": "middle", "font-size": 20 }).forEach(([k, v]) => icon.setAttribute(k, v));
                    icon.textContent = (KINDS[e.kind] || KINDS.lore).icon;
                    g.append(icon);
                }
                const name = document.createElementNS(NS, "text");
                Object.entries({ x, y: y + 42, "text-anchor": "middle", class: "gs-web-name" }).forEach(([k, v]) => name.setAttribute(k, v));
                name.textContent = clip(e.name, 22);
                g.append(name);
            }
            const picked = focus && p.entries.find(e => e.id === focus);
            const detail = picked ? el("div", { class: "gs-form" },
                el("div", { class: "gs-row" }, el("b", { text: picked.name }), el("button", { class: "gs-btn", type: "button", text: "Open", onclick: () => { ui.section = "bible"; ui.editing = picked; ui.webFocus = ""; render(); } })),
                ...relationsOf(p, picked).map(r => el("div", { class: "gs-note", text: r }))) : el("div", { class: "gs-note", text: "Tap a name to see only its relationships." });
            return el("div", { class: "gs" }, legend, el("div", { class: "gs-web-box" }, svg), detail);
        }

        function relationsOf(p, entry) {
            const out = (entry.links || []).map(l => `${entry.name} → ${linkLabel(l.type).toLowerCase()}: ${(p.entries.find(e => e.id === l.to) || l).name}${l.note ? ` (${l.note})` : ""}`);
            p.entries.forEach(e => (e.links || []).forEach(l => { if (l.to === entry.id) out.push(`${e.name} → ${linkLabel(l.type).toLowerCase()}: ${entry.name}${l.note ? ` (${l.note})` : ""}`); }));
            return out.length ? out : ["No relationships yet."];
        }

        // A small force layout: linked entries pull together, all of them push apart.
        function layoutWeb(nodes, p, W, H) {
            const pos = new Map(nodes.map((e, i) => [e.id, { x: W / 2 + Math.cos(i / nodes.length * 2 * Math.PI) * W * 0.35, y: H / 2 + Math.sin(i / nodes.length * 2 * Math.PI) * H * 0.35 }]));
            const edges = [];
            p.entries.forEach(e => (e.links || []).forEach(l => { if (pos.has(e.id) && pos.has(l.to)) edges.push([e.id, l.to]); }));
            for (let step = 0; step < 220; step++) {
                const force = new Map(nodes.map(e => [e.id, { x: 0, y: 0 }]));
                for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
                    const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id);
                    let dx = a.x - b.x, dy = a.y - b.y;
                    const d2 = Math.max(dx * dx + dy * dy, 100);
                    const f = 18000 / d2, d = Math.sqrt(d2);
                    dx = dx / d * f; dy = dy / d * f;
                    force.get(nodes[i].id).x += dx; force.get(nodes[i].id).y += dy;
                    force.get(nodes[j].id).x -= dx; force.get(nodes[j].id).y -= dy;
                }
                for (const [ia, ib] of edges) {
                    const a = pos.get(ia), b = pos.get(ib);
                    const dx = (b.x - a.x) * 0.02, dy = (b.y - a.y) * 0.02;
                    force.get(ia).x += dx; force.get(ia).y += dy;
                    force.get(ib).x -= dx; force.get(ib).y -= dy;
                }
                const cool = 1 - step / 240;
                for (const e of nodes) {
                    const q = pos.get(e.id), f = force.get(e.id);
                    q.x += Math.max(-20, Math.min(20, f.x + (W / 2 - q.x) * 0.01)) * cool;
                    q.y += Math.max(-20, Math.min(20, f.y + (H / 2 - q.y) * 0.01)) * cool;
                }
            }
            // Stretch the result to fill the box, keeping room for the names.
            const xs = [...pos.values()].map(q => q.x), ys = [...pos.values()].map(q => q.y);
            const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
            for (const q of pos.values()) {
                q.x = x1 - x0 < 1 ? W / 2 : 70 + (q.x - x0) / (x1 - x0) * (W - 140);
                q.y = y1 - y0 < 1 ? H / 2 : 45 + (q.y - y0) / (y1 - y0) * (H - 110);
            }
            return pos;
        }

        // ⏳ TIMELINE: the project's events in story order; ↑ ↓ move one.
        function timelineView(p) {
            const msg = el("div", { class: "gs-msg" });
            const events = timelineOrder(p.entries.filter(e => e.kind === "event"));
            const move = (i, by) => {
                const list = events.slice();
                const [moved] = list.splice(i, 1);
                list.splice(i + by, 0, moved);
                const locked = list.find((e, n) => e.locked && (e.order ?? -1) !== (n + 1) * 10);
                if (locked) return say(msg, `"${locked.name}" is locked, so the timeline can't move it.`, true);
                list.forEach((e, n) => { if (e.order !== (n + 1) * 10) store.saveEntry(p.id, { id: e.id, order: (n + 1) * 10 }); });
                render();
            };
            const title = el("input", { type: "text", placeholder: "What happened, like \"The Fall of the Spire\"", "aria-label": "New event" });
            const when = el("input", { type: "text", placeholder: "When (optional), like \"Year 312\" or \"Before the game\"", "aria-label": "When" });
            const add = el("button", { class: "gs-btn primary", type: "button", text: "＋ Add event", onclick: () => {
                if (!title.value.trim()) return;
                const saved = store.saveEntry(p.id, { kind: "event", name: title.value, fields: { when: when.value }, order: (events.length + 1) * 10 });
                if (saved.error) return say(msg, saved.error, true);
                render();
            } });
            return el("div", { class: "gs" },
                el("div", { class: "gs-note", text: "Your world's history in order. Agents read it too, so new stories fit what already happened." }),
                el("div", { class: "gs-row" }, title, when, add), msg,
                events.length ? el("ol", { class: "gs-timeline" }, events.map((e, i) => el("li", {},
                    el("div", { class: "gs-when", text: e.fields.when || "" }),
                    el("button", { type: "button", class: "gs-card", style: "flex: 1;", onclick: () => { ui.section = "bible"; ui.editing = e; render(); } },
                        el("div", {}, el("b", { text: `${e.locked ? "🔒 " : ""}${e.name}` }), el("span", { class: "gs-sum", text: e.summary || e.fields.what || "" }))),
                    el("div", { class: "gs-updown" },
                        el("button", { class: "gs-btn", type: "button", text: "↑", title: "Earlier", "aria-label": `Move ${e.name} earlier`, disabled: i === 0, onclick: () => move(i, -1) }),
                        el("button", { class: "gs-btn", type: "button", text: "↓", title: "Later", "aria-label": `Move ${e.name} later`, disabled: i === events.length - 1, onclick: () => move(i, 1) })))))
                    : el("div", { class: "gs-note", text: "No events yet." }));
        }

        // 📈 STORY ARCS BOARD: one column per arc, its beats in order, each marked idea,
        // written or in the game, and optionally tied to a scene.
        function arcsView(p) {
            const msg = el("div", { class: "gs-msg" });
            const arcs = p.entries.filter(e => e.kind === "arc");
            const scenes = p.entries.filter(e => e.kind === "scene");
            const saveBeats = (arc, beats) => {
                const saved = store.saveEntry(p.id, { id: arc.id, beats });
                if (saved.error) return say(msg, saved.error, true);
                render();
            };
            const name = el("input", { type: "text", placeholder: "New arc, like \"Mara learns to trust\" or \"The war for the Spire\"", "aria-label": "New arc" });
            const add = el("button", { class: "gs-btn primary", type: "button", text: "＋ New arc", onclick: () => {
                if (!name.value.trim()) return;
                const saved = store.saveEntry(p.id, { kind: "arc", name: name.value, beats: [] });
                say(msg, saved.error || "", !!saved.error);
                render();
            } });
            const column = arc => {
                const beats = (arc.beats || []).map(b => Object.assign({}, b));
                const done = beats.filter(b => b.status === "in_game").length;
                const beatInput = el("input", { type: "text", placeholder: "Add a beat", "aria-label": `Add a beat to ${arc.name}` });
                const addBeat = () => { if (beatInput.value.trim()) saveBeats(arc, [...beats, { text: beatInput.value.trim(), status: "idea" }]); };
                beatInput.addEventListener("keydown", e => { if (e.key === "Enter") addBeat(); });
                const cards = beats.map((b, i) => el("div", { class: `gs-beat s-${b.status}` },
                    el("div", { text: b.text }),
                    el("div", { class: "gs-row" },
                        el("button", { class: "gs-btn", type: "button", text: BEAT_STATUS.find(([k]) => k === b.status)[1], title: "Change where it stands", disabled: !!arc.locked, onclick: () => {
                            const n = BEAT_STATUS.findIndex(([k]) => k === b.status);
                            beats[i].status = BEAT_STATUS[(n + 1) % BEAT_STATUS.length][0];
                            saveBeats(arc, beats);
                        } }),
                        scenes.length ? el("select", { "aria-label": "Scene", disabled: !!arc.locked, onchange: e => { if (e.target.value) beats[i].scene = e.target.value; else delete beats[i].scene; saveBeats(arc, beats); } },
                            el("option", { value: "", text: "No scene" }), scenes.map(sc => el("option", { value: sc.id, selected: b.scene === sc.id, text: `🎬 ${sc.name}` }))) : null,
                        el("button", { class: "gs-btn", type: "button", text: "↑", "aria-label": "Earlier", disabled: i === 0 || !!arc.locked, onclick: () => { beats.splice(i - 1, 0, beats.splice(i, 1)[0]); saveBeats(arc, beats); } }),
                        el("button", { class: "gs-btn", type: "button", text: "↓", "aria-label": "Later", disabled: i === beats.length - 1 || !!arc.locked, onclick: () => { beats.splice(i + 1, 0, beats.splice(i, 1)[0]); saveBeats(arc, beats); } }),
                        el("button", { class: "gs-btn", type: "button", text: "✕", "aria-label": "Remove beat", disabled: !!arc.locked, onclick: () => { beats.splice(i, 1); saveBeats(arc, beats); } }))));
                return el("div", { class: "gs-arc" },
                    el("button", { type: "button", class: "gs-arc-head", onclick: () => { ui.section = "bible"; ui.editing = arc; render(); } },
                        el("b", { text: `${arc.locked ? "🔒 " : ""}${arc.name}` }), el("span", { class: "gs-sum", text: `${done} of ${beats.length} in the game${arc.fields.characters ? ` · ${arc.fields.characters}` : ""}` })),
                    ...cards,
                    arc.locked ? null : el("div", { class: "gs-send" }, beatInput, el("button", { class: "gs-btn", type: "button", text: "＋", "aria-label": "Add beat", onclick: addBeat })),
                    el("button", { class: "gs-btn", type: "button", text: "🤖 Ask an agent to plan the beats", onclick: () => sendToAgent(p, `Plan the beats of the story arc "${arc.name}" so it fits the story bible, and save them on the arc with studio_save.`, arc) }));
            };
            return el("div", { class: "gs" },
                el("div", { class: "gs-note", text: "Plan each arc beat by beat, and mark which beats are written and which are already in the game." }),
                el("div", { class: "gs-row" }, name, add), msg,
                arcs.length ? el("div", { class: "gs-board" }, arcs.map(column)) : el("div", { class: "gs-note", text: "No arcs yet." }));
        }

        // 🔍 One model call that compares entries with the rest of the bible. It only reports;
        // nothing is changed. Results stay until the next check of the same thing.
        function loreChecker(p, targets, key, label = "🔍 Check for contradictions") {
            const out = el("div", { class: "gs-issues" });
            const show = () => {
                const result = ui.loreResults[key];
                out.replaceChildren();
                if (!result) return;
                if (result.error) return out.append(el("div", { class: "gs-msg bad", text: result.error }));
                if (!result.issues.length) return out.append(el("div", { class: "gs-note", text: "✅ No contradictions found with the story bible." }));
                out.append(...result.issues.map(i => el("div", { class: "gs-issue" },
                    el("b", { text: `⚠️ ${i.problem}` }),
                    i.conflicts_with ? el("div", { class: "gs-note", text: `Conflicts with: ${i.conflicts_with}` }) : null,
                    i.suggestion ? el("div", { class: "gs-note", text: `Idea: ${i.suggestion}` }) : null)));
            };
            const btn = el("button", { class: "gs-btn", type: "button", "data-keep": "1", text: label, disabled: !deps.chat, onclick: async () => {
                btn.disabled = true;
                btn.textContent = "Checking…";
                try {
                    const issues = parseIssues(await deps.chat(loreCheckPrompt(p, targets)));
                    ui.loreResults[key] = issues ? { issues } : { error: "The check didn't come back in a form CoDev could read. Try again." };
                } catch (err) { ui.loreResults[key] = { error: `Couldn't check: ${err.message}` }; }
                btn.disabled = false;
                btn.textContent = label;
                show();
            } });
            show();
            return el("div", { class: "gs" }, el("div", { class: "gs-row" }, btn, el("span", { class: "gs-note", text: "Compares it with the rest of the story bible. It only reports; nothing is changed." })), out);
        }

        // 🌱 + 📸 for one character: growth suggestions on or off (off unless the user turns
        // it on), and snapshots to save and go back to.
        function growthAndSnapshots(p, entry, msg) {
            const snaps = entry.snapshots || [];
            const label = el("input", { type: "text", placeholder: "Snapshot name, like \"Before the war\"", "aria-label": "Snapshot name" });
            const take = el("button", { class: "gs-btn", type: "button", "data-keep": "1", text: "📸 Save snapshot", onclick: () => {
                const done = store.snapshot(p.id, entry.id, label.value || new Date().toLocaleString());
                if (done.error) return say(msg, done.error, true);
                ui.editing = done.entry;
                render();
            } });
            const growth = el("label", { class: "gs-chip", style: "display: inline-flex; gap: 6px; align-items: center;" },
                el("input", { type: "checkbox", checked: !!entry.growth, disabled: !!entry.locked, onchange: e => { store.saveEntry(p.id, { id: entry.id, growth: e.target.checked }); ui.editing = store.findEntry(p, entry.id); render(); } }),
                "🌱 Suggest growth after scenes and chats");
            return el("details", { class: "gs-section", open: snaps.length > 0 || !!entry.growth },
                el("summary", { text: `🌱 Growth and 📸 snapshots${snaps.length ? ` (${snaps.length})` : ""}` }),
                el("div", { class: "gs-note", text: `${entry.name} never changes on their own. With growth turned on, "🌱 Suggest growth" in a scene or chat proposes changes, and nothing changes until you approve one; a snapshot is saved first. Snapshots let you go back to any saved version.` }),
                growth,
                el("div", { class: "gs-send" }, label, take),
                ...snaps.map((snap, i) => el("div", { class: "gs-row" },
                    el("span", { text: `📸 ${snap.label}`, style: "flex: 1;" }), el("span", { class: "gs-note", text: new Date(snap.at).toLocaleDateString() }),
                    el("button", { class: "gs-btn", type: "button", text: "↩ Go back to this", disabled: !!entry.locked, onclick: () => {
                        if (!confirmFn(`Put ${entry.name} back to "${snap.label}"? The current version is saved as a snapshot first.`)) return;
                        const done = store.restoreSnapshot(p.id, entry.id, i);
                        if (done.error) return say(msg, done.error, true);
                        ui.editing = done.entry;
                        render();
                    } }),
                    el("button", { class: "gs-btn", type: "button", text: "✕", "data-keep": "1", "aria-label": "Delete snapshot", onclick: () => { store.dropSnapshot(p.id, entry.id, i); ui.editing = store.findEntry(p, entry.id); render(); } }))));
        }

        // 🌱 Asks for growth suggestions for the characters (growth on, not locked) after a scene or chat.
        function suggestGrowthButton(p, characters, sourceText, msg) {
            const growing = characters.filter(c => c && c.id && c.growth && !c.locked);
            if (!growing.length || !deps.chat) return null;
            const btn = el("button", { class: "gs-btn", type: "button", text: "🌱 Suggest growth", title: `Ideas for how ${growing.map(c => c.name).join(" and ")} could change after this. Nothing changes unless you approve it.`, onclick: async () => {
                const text = sourceText();
                if (!text.trim()) return say(msg, "Nothing has happened yet to grow from.", true);
                btn.disabled = true;
                say(msg, "Thinking about how they might have changed…");
                try {
                    const found = parseGrowth(await deps.chat(growthPrompt(p, growing, text)), growing);
                    if (!found) say(msg, "The answer didn't come back in a form CoDev could read. Try again.", true);
                    else if (!found.length) say(msg, "No growth suggested: nothing here changes them much.");
                    else { ui.growth = [...ui.growth.filter(g => !found.some(f => f.entryId === g.entryId && f.field === g.field)), ...found]; say(msg, ""); render(); }
                } catch (err) { say(msg, `Couldn't ask: ${err.message}`, true); }
                btn.disabled = false;
            } });
            return btn;
        }

        // The suggestions waiting for the user, with Approve and Skip.
        function growthPanel(p) {
            const mine = ui.growth.filter(g => p.entries.some(e => e.id === g.entryId));
            if (!mine.length) return null;
            const msg = el("div", { class: "gs-msg" });
            return el("div", { class: "gs-form gs-growth" },
                el("b", { text: "🌱 Suggested growth: nothing changes unless you approve it" }), msg,
                ...mine.map(g => {
                    const entry = p.entries.find(e => e.id === g.entryId);
                    const before = g.field === "summary" ? entry.summary : (entry.fields || {})[g.field];
                    return el("div", { class: "gs-issue" },
                        el("b", { text: `${g.name}: ${fieldLabel("character", g.field)}` }),
                        g.why ? el("div", { class: "gs-note", text: `Why: ${g.why}` }) : null,
                        before ? el("div", { class: "gs-note", text: `Now: ${before}` }) : null,
                        el("div", { text: `Would become: ${g.new_text}` }),
                        el("div", { class: "gs-row" },
                            el("button", { class: "gs-btn primary", type: "button", text: "✓ Approve", onclick: () => {
                                store.snapshot(p.id, entry.id, `Before growth: ${fieldLabel("character", g.field).toLowerCase()}`);
                                const saved = store.saveEntry(p.id, g.field === "summary" ? { id: entry.id, summary: g.new_text } : { id: entry.id, fields: { [g.field]: g.new_text } });
                                if (saved.error) return say(msg, saved.error, true);
                                ui.growth = ui.growth.filter(x => x !== g);
                                render();
                            } }),
                            el("button", { class: "gs-btn", type: "button", text: "Skip", onclick: () => { ui.growth = ui.growth.filter(x => x !== g); render(); } })));
                }));
        }

        // 🖨️ The character sheet: printed where printing works, else saved as a page to share.
        function sheetButtons(p, entry) {
            const name = `${slug(p.name)}_${slug(entry.name)}_sheet.html`;
            return el("div", { class: "gs-row" },
                deps.printHtml ? el("button", { class: "gs-btn", type: "button", "data-keep": "1", text: "🖨️ Print character sheet", onclick: () => deps.printHtml(characterSheetHtml(p, entry), name) }) : null,
                deps.saveFile ? el("button", { class: "gs-btn", type: "button", "data-keep": "1", text: "⬇ Save sheet to share", onclick: () => deps.saveFile(name, characterSheetHtml(p, entry), "text/html") }) : null);
        }

        function elevenLabsBox() {
            const key = el("input", { type: "password", value: deps.getElevenLabsKey ? deps.getElevenLabsKey() : "", placeholder: "ElevenLabs API key", "aria-label": "ElevenLabs API key", autocomplete: "off" });
            return el("details", { class: "gs-section" }, el("summary", { text: "🎙️ ElevenLabs voices (optional, paid)" }),
                el("div", { class: "gs-note", text: "Free voices from this device always work. With an ElevenLabs key (elevenlabs.io, Profile > API keys), each character can use an ElevenLabs voice by its voice ID. ElevenLabs charges per character spoken, so CoDev stops at 10,000 characters a day." }),
                el("div", { class: "gs-send" }, key, el("button", { class: "gs-btn", type: "button", text: "Save key", onclick: () => { deps.setElevenLabsKey(key.value.trim()); render(); } })));
        }

        function talkView(p) {
            const chars = p.entries.filter(e => e.kind === "character");
            if (!chars.length) return el("div", { class: "gs-note", text: "Add a character to the story bible first, then come back to talk to them." });
            if (!chars.some(c => c.id === ui.talkWith)) { ui.talkWith = chars[0].id; ui.talkLog = []; }
            const msg = el("div", { class: "gs-msg" });
            const character = store.findEntry(p, ui.talkWith);
            const choose = el("select", { "aria-label": "Character", onchange: e => { ui.talkWith = e.target.value; ui.talkLog = []; render(); } },
                chars.map(c => el("option", { value: c.id, selected: c.id === ui.talkWith, text: c.name })));
            return el("div", { class: "gs" }, el("div", { class: "gs-bar" }, "Talk to", choose),
                el("div", { class: "gs-note", text: `Chat with ${character.name} to hear how they sound in the game. Write "(ooc)" to ask them something out of character. To have characters talk to each other, use 🎬 Scene Builder.` }),
                chatBox(p, character, msg), msg);
        }

        // opts: face (a portrait), voice + say (adds a 🔊 button).
        function bubble(who, text, mine, opts = {}) {
            const speak = opts.voice !== undefined && deps.speak ? el("button", { class: "gs-speak", type: "button", text: "🔊", title: "Say it", "aria-label": `Say ${who}'s line`,
                onclick: () => deps.speak(text, opts.voice).catch(err => alert(err.message)) }) : null;
            const b = el("div", { class: `gs-bubble ${mine ? "me" : "them"}` }, el("small", {}, who, speak), text);
            return opts.face ? el("div", { class: "gs-said", style: mine ? "align-self: flex-end;" : "" }, el("img", { src: opts.face, alt: "" }), b) : b;
        }

        function chatBox(p, character, msg) {
            const log = el("div", { class: "gs-chat", "aria-live": "polite" });
            const draw = () => {
                log.replaceChildren(...ui.talkLog.map(m => {
                    if (m.role === "user") return bubble("You", m.content, true);
                    const said = splitMood(m.content);
                    return bubble(`${character.name}${said.mood ? ` (${said.mood})` : ""}`, said.text, false, { face: portraitFor(character, said.mood), voice: character.voice || null });
                }));
                if (!ui.talkLog.length) log.append(el("div", { class: "gs-note", text: `Say something to ${character.name}.` }));
                log.scrollTop = log.scrollHeight;
            };
            draw();
            const input = el("input", { type: "text", placeholder: `Say something to ${character.name}`, "aria-label": "Message" });
            const send = async () => {
                const text = input.value.trim();
                if (!text || ui.busy || !deps.chat) return;
                ui.busy = true;
                input.value = "";
                ui.talkLog.push({ role: "user", content: text });
                draw();
                log.append(el("div", { class: "gs-note", text: `${character.name} is answering…` }));
                try {
                    const reply = await deps.chat([{ role: "system", content: characterSystemPrompt(p, character) }, ...ui.talkLog.slice(-CHAT_HISTORY_TURNS)]);
                    ui.talkLog.push({ role: "assistant", content: String(reply || "").trim() || "…" });
                    if (ui.speakReplies && deps.speak) deps.speak(splitMood(reply).text, character.voice || null).catch(() => {});
                } catch (err) {
                    ui.talkLog.pop();
                    input.value = text;
                    say(msg, `Couldn't answer: ${err.message}`, true);
                }
                ui.busy = false;
                draw();
                keep.disabled = !ui.talkLog.length;
                keepNotes.disabled = !ui.talkLog.some(m => m.role === "assistant");
            };
            input.addEventListener("keydown", e => { if (e.key === "Enter") send(); });
            const keep = el("button", { class: "gs-btn", type: "button", text: "💾 Save as dialogue", disabled: !ui.talkLog.length, onclick: () => {
                const lines = ui.talkLog.map(m => {
                    if (m.role === "user") return { speaker: "Player", text: m.content };
                    const said = splitMood(m.content);
                    return { speaker: character.name, text: said.text, ...(said.mood ? { emotion: said.mood } : {}) };
                });
                const saved = store.saveEntry(p.id, { kind: "dialogue", name: uniqueName(p, `${character.name} talk`, "dialogue"), fields: { scene: `Conversation with ${character.name}` }, lines });
                say(msg, saved.error || `Saved as "${saved.entry.name}" in the story bible.`, !!saved.error);
            } });
            const clear = el("button", { class: "gs-btn", type: "button", text: "Clear", onclick: () => { ui.talkLog = []; render(); } });
            // 🎤 Interview: questions that dig into the character; the answers can be kept as notes.
            const fresh = INTERVIEW_QUESTIONS.filter(q => !ui.asked.has(`${character.id}:${q}`));
            const question = el("select", { "aria-label": "Interview question" }, (fresh.length ? fresh : INTERVIEW_QUESTIONS).map(q => el("option", { value: q, text: q })));
            const ask = q => { ui.asked.add(`${character.id}:${q}`); input.value = q; send(); };
            const keepNotes = el("button", { class: "gs-btn", type: "button", text: "📝 Keep the answers as notes", disabled: !ui.talkLog.some(m => m.role === "assistant"), onclick: () => {
                const qa = [];
                ui.talkLog.forEach((m, n) => { if (m.role === "user" && ui.talkLog[n + 1]) qa.push(`Q: ${m.content}\nA: ${splitMood(ui.talkLog[n + 1].content).text}`); });
                const saved = store.saveEntry(p.id, { kind: "lore", name: uniqueName(p, `Interview with ${character.name}`, "lore"), summary: `What ${character.name} said in an interview.`, fields: { details: qa.join("\n\n") }, links: [{ to: character.id, type: "other" }] });
                say(msg, saved.error || `Kept as the lore note "${saved.entry.name}". ${character.name}'s card is unchanged.`, !!saved.error);
            } });
            const interview = el("details", { class: "gs-section", open: !!ui.interviewOpen, ontoggle: e => { ui.interviewOpen = e.target.open; } },
                el("summary", { text: "🎤 Interview mode" }),
                el("div", { class: "gs-note", text: `Ask ${character.name} questions that dig into who they are. Nothing they say changes their card; keep the answers as notes if you like them.` }),
                el("div", { class: "gs-send" }, question, el("button", { class: "gs-btn", type: "button", text: "Ask", onclick: () => ask(question.value) }),
                    el("button", { class: "gs-btn", type: "button", text: "🎲", title: "Ask a random question", "aria-label": "Ask a random question", onclick: () => { const pool = fresh.length ? fresh : INTERVIEW_QUESTIONS; ask(pool[Math.floor(Math.random() * pool.length)]); } })),
                keepNotes);
            const auto = deps.speak ? el("label", { class: "gs-chip", style: "display: inline-flex; gap: 6px; align-items: center;" },
                el("input", { type: "checkbox", checked: !!ui.speakReplies, onchange: e => { ui.speakReplies = e.target.checked; if (!ui.speakReplies && deps.stopSpeaking) deps.stopSpeaking(); } }), "🔊 Speak replies") : null;
            return el("div", { class: "gs" }, log, el("div", { class: "gs-send" }, input, el("button", { class: "gs-btn primary", type: "button", text: "Send", onclick: send })), el("div", { class: "gs-row" }, keep, clear, auto,
                suggestGrowthButton(p, [character], () => ui.talkLog.map(m => m.role === "user" ? `Player: ${m.content}` : `${character.name}: ${splitMood(m.content).text}`).join("\n"), msg)), interview);
        }

        function uniqueName(p, base, kind) {
            let name = base;
            for (let n = 2; store.findEntry(p, name, kind); n++) name = `${base} ${n}`;
            return name;
        }

        // 🎬 SCENE BUILDER: set the place, the cast and the goal; agents play each character
        // a line (or a few) at a time while the user directs, steps in, rewinds or rerolls.
        // Every change is saved to the scene's entry, so it's in the bible and the exports.
        function scenesView(p) {
            const scene = ui.sceneId ? store.findEntry(p, ui.sceneId) : null;
            if (scene && scene.kind === "scene" && !ui.sceneSetup) return sceneBuilder(p, scene);
            if (ui.sceneSetup) return sceneSetup(p, scene && scene.kind === "scene" ? scene : null);
            const scenes = p.entries.filter(e => e.kind === "scene");
            return el("div", { class: "gs" },
                el("div", { class: "gs-note", text: "Act out a scene with your characters: pick where it happens, who is in it and what's at stake. Agents play each character in turn while you direct, step in, rewind or redo lines. The script is saved to the story bible and exports to your game as a cutscene." }),
                el("div", { class: "gs-bar" }, el("button", { class: "gs-btn primary", type: "button", text: "＋ New scene", onclick: () => { ui.sceneId = ""; ui.sceneSetup = true; render(); } })),
                el("div", { class: "gs-grid" }, scenes.length ? scenes.map(s => el("button", { type: "button", class: "gs-card", onclick: () => { ui.sceneId = s.id; ui.sceneSetup = false; render(); } },
                    el("span", { class: "gs-icon", text: s.fields.branch_of ? "🌿" : "🎬" }),
                    el("div", {}, el("b", { text: s.name }), el("span", { class: "gs-sum", text: s.fields.branch_of ? `What if, from "${s.fields.branch_of}" line ${s.fields.branch_at}` : `${(s.lines || []).length} lines · ${s.fields.location || "no place set"}` }))))
                    : el("div", { class: "gs-note", text: "No scenes yet." })));
        }

        function sceneSetup(p, scene) {
            const msg = el("div", { class: "gs-msg" });
            const chars = p.entries.filter(e => e.kind === "character");
            const places = p.entries.filter(e => e.kind === "location");
            const f = scene ? scene.fields : {};
            const title = el("input", { type: "text", value: scene ? scene.name : "", placeholder: "Scene title, like \"The betrayal on the bridge\"", maxlength: "120" });
            const listId = `gs-places-${Math.random().toString(36).slice(2, 7)}`;
            const where = el("input", { type: "text", value: f.location || "", placeholder: "Where it happens", list: listId });
            const datalist = el("datalist", { id: listId }, places.map(x => el("option", { value: x.name })));
            const inCast = new Set(String(f.characters || "").split(/\s*,\s*/).filter(Boolean).map(n => n.toLowerCase()));
            const boxes = chars.map(c => {
                const box = el("input", { type: "checkbox", value: c.name });
                box.checked = inCast.has(c.name.toLowerCase());
                return el("label", { class: "gs-chip", style: "display: inline-flex; flex-direction: row; gap: 6px; align-items: center;" }, box, c.name);
            });
            const extra = el("input", { type: "text", placeholder: "Others not in the bible yet, separated by commas (like: Guard, Shopkeeper)",
                value: [...inCast].filter(n => !chars.some(c => c.name.toLowerCase() === n)).map(n => String(f.characters).split(/\s*,\s*/).find(x => x.toLowerCase() === n)).join(", ") });
            const goal = el("textarea", { placeholder: "The goal or conflict: what each side wants and what's at stake", maxlength: String(MAX_FIELD_CHARS) });
            goal.value = f.goal || "";
            const go = el("button", { class: "gs-btn primary", type: "button", text: scene ? "Save" : "🎬 Start the scene", onclick: () => {
                const cast = [...boxes.map(b => b.querySelector("input")).filter(b => b.checked).map(b => b.value), ...extra.value.split(",").map(x => x.trim()).filter(Boolean)];
                if (!title.value.trim()) return say(msg, "Give the scene a title.", true);
                if (!cast.length) return say(msg, "Pick at least one character.", true);
                if (!scene && store.findEntry(p, title.value, "scene")) return say(msg, "There's already a scene with that title.", true);
                const saved = store.saveEntry(p.id, { ...(scene ? { id: scene.id } : { kind: "scene", lines: [] }), name: title.value, fields: { location: where.value, characters: cast.join(", "), goal: goal.value } });
                if (saved.error) return say(msg, saved.error, true);
                ui.sceneId = saved.entry.id;
                ui.sceneSetup = false;
                render();
            } });
            const back = el("button", { class: "gs-btn", type: "button", text: "← Back", onclick: () => { ui.sceneSetup = false; if (!scene) ui.sceneId = ""; render(); } });
            return el("div", { class: "gs-form" }, el("div", { class: "gs-row" }, back, el("b", { text: scene ? "Scene setup" : "New scene" })),
                el("label", {}, "Title", title), el("label", {}, "Where", where, datalist),
                el("div", { class: "gs-note", text: "Who is in it" }), chars.length ? el("div", { class: "gs-kinds" }, boxes) : el("div", { class: "gs-note", text: "No characters in the bible yet; type names below." }), extra,
                el("label", {}, "Goal or conflict", goal), msg, el("div", { class: "gs-row" }, go));
        }

        function sceneBuilder(p, scene) {
            const msg = el("div", { class: "gs-msg" });
            const cast = sceneCast(p, scene);
            const calls = () => ui.sceneCalls[scene.id] || 0;
            const lines = () => (store.findEntry(p, scene.id) || scene).lines || [];
            const setLines = list => { store.saveEntry(p.id, { id: scene.id, lines: list }); };
            const log = el("div", { class: "gs-chat", style: "max-height: 55vh;" });

            const draw = () => {
                const list = lines();
                log.replaceChildren(...list.map((l, i) => lineRow(l, i, list.length)));
                if (!list.length) log.append(el("div", { class: "gs-note", text: "Press ▶ Next line to start, or step in with the first line yourself." }));
                log.scrollTop = log.scrollHeight;
                meter.textContent = `${list.length} lines · agent turns this sitting: ${calls()} of ${MAX_SCENE_CALLS}`;
            };

            function lineRow(l, i) {
                const text = l.type === "direction" ? `(${l.text})` : l.text;
                const who = l.type === "direction" ? "Director" : l.type === "narration" ? "Narration" : `${l.speaker}${l.emotion ? ` (${l.emotion})` : ""}`;
                const speak = l.type !== "direction" && deps.speak ? el("button", { class: "gs-speak", type: "button", text: "🔊", title: "Say it", onclick: () => deps.speak(l.text, voiceOf(l)).catch(err => say(msg, err.message, true)) }) : null;
                const row = el("div", { class: `gs-bubble ${l.type ? "me" : "them"}`, style: "max-width: 100%; flex: 1; min-width: 0;", "data-line": String(i) }, el("small", {}, `${i + 1}. ${who}`, speak));
                const body = el("div", { text, title: "Tap to edit", style: "cursor: text;" });
                body.addEventListener("click", () => {
                    const edit = el("textarea", {});
                    edit.value = l.text;
                    const ok = el("button", { class: "gs-btn", type: "button", text: "Save", onclick: () => {
                        const list = lines().map(x => Object.assign({}, x));
                        if (edit.value.trim()) list[i].text = edit.value.trim(); else list.splice(i, 1);
                        setLines(list);
                        draw();
                    } });
                    body.replaceWith(el("div", {}, edit, ok));
                    edit.focus();
                });
                row.append(body);
                if (l.frame && l.frame.thumb) row.append(el("img", { src: l.frame.thumb, alt: "Storyboard frame", style: "width: 100%; max-width: 320px; border-radius: 8px; margin-top: 6px; cursor: zoom-in;", onclick: () => deps.openArt && deps.openArt(l.frame.id) }));
                const tools = el("div", { class: "gs-row", style: "margin-top: 4px;" },
                    el("button", { class: "gs-btn", type: "button", text: "⏪ Rewind to here", title: "Remove every line after this one", onclick: () => {
                        if (i === lines().length - 1) return;
                        setLines(lines().slice(0, i + 1));
                        draw();
                    } }),
                    el("button", { class: "gs-btn", type: "button", text: "🌿 What if…", title: "Try a different direction from this line, in a copy; this scene stays as it is", onclick: () => {
                        const what = el("input", { type: "text", placeholder: `What if… (like "${cast[1] ? cast[1].name : "she"} says no")`, "aria-label": "What if" });
                        const go = () => {
                            const name = uniqueName(p, `${scene.name}: what if`, "scene");
                            const branch = lines().slice(0, i + 1).map(x => Object.assign({}, x));
                            if (what.value.trim()) branch.push({ type: "direction", text: `What if: ${what.value.trim()}` });
                            const saved = store.saveEntry(p.id, { kind: "scene", name, fields: Object.assign({}, scene.fields, { branch_of: scene.name, branch_at: String(i + 1) }), lines: branch });
                            if (saved.error) return say(msg, saved.error, true);
                            ui.sceneId = saved.entry.id;
                            render();
                        };
                        what.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
                        row.append(el("div", { class: "gs-send", style: "margin-top: 6px;" }, what, el("button", { class: "gs-btn primary", type: "button", text: "🌿 Branch", onclick: go })));
                        what.focus();
                    } }),
                    !l.type && deps.makeArt ? el("button", { class: "gs-btn", type: "button", text: "🎨 Storyboard", title: `Concept art of this moment (up to ${MAX_SCENE_FRAMES} per scene)`, onclick: async event => {
                        if (lines().filter(x => x.frame).length >= MAX_SCENE_FRAMES && !l.frame) return say(msg, `Up to ${MAX_SCENE_FRAMES} storyboard pictures per scene, to keep it light.`, true);
                        event.currentTarget.disabled = true;
                        say(msg, "Drawing the storyboard frame… this can take up to a minute.");
                        const made = await deps.makeArt(framePrompt(p, scene, l));
                        if (!made || made.error) { draw(); return say(msg, (made && made.error) || "The picture couldn't be made.", true); }
                        const list = lines().map(x => Object.assign({}, x));
                        if (list[i]) list[i].frame = made;
                        setLines(list);
                        say(msg, "");
                        draw();
                    } }) : null);
                row.append(tools);
                const face = !l.type && portraitFor(castEntry(l.speaker), l.emotion);
                return face ? el("div", { class: "gs-said" }, el("img", { src: face, alt: "" }), row) : row;
            }

            const castEntry = name => cast.find(c => sameName(c.name, name) && c.id);
            const voiceOf = l => l.type === "narration" ? (p.narrator || null) : ((castEntry(l.speaker) || {}).voice || null);
            const highlight = i => log.querySelectorAll("[data-line]").forEach(n => n.classList.toggle("playing", n.dataset.line === String(i)));
            // ▶ The scene read aloud like an audio drama: each line in its character's voice,
            // narration in the narrator's voice (set in Project details); directions are skipped.
            const play = el("button", { class: "gs-btn", type: "button", text: "▶ Play scene", disabled: !deps.speak, onclick: async () => {
                if (ui.playing) { ui.playing = false; if (deps.stopSpeaking) deps.stopSpeaking(); return; }
                ui.playing = true;
                play.textContent = "⏹ Stop";
                const list = lines();
                for (let i = 0; i < list.length && ui.playing; i++) {
                    if (list[i].type === "direction") continue;
                    highlight(i);
                    const node = log.querySelector(`[data-line="${i}"]`);
                    if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
                    try { await deps.speak(list[i].text, voiceOf(list[i])); } catch (err) { say(msg, err.message, true); break; }
                }
                ui.playing = false;
                play.textContent = "▶ Play scene";
                highlight(-1);
            } });

            const speaker = el("select", { "aria-label": "Who speaks next" }, el("option", { value: "", text: "Whoever fits" }), cast.map(c => el("option", { value: c.name, text: c.name })));
            const direction = el("input", { type: "text", placeholder: "Director's note (optional), like \"she finally loses her temper\"", "aria-label": "Director's note" });
            const meter = el("span", { class: "gs-note" });

            async function turn({ count = 1, reroll = false } = {}) {
                if (ui.busy || !deps.chat) return;
                if (calls() >= MAX_SCENE_CALLS) {
                    if (!confirmFn(`Agents have written ${MAX_SCENE_CALLS} turns of this scene in this sitting. Each turn uses your AI provider. Keep going for another ${MAX_SCENE_CALLS}?`)) return;
                    ui.sceneCalls[scene.id] = 0;
                }
                let list = lines().slice();
                let avoid = "";
                let who = speaker.value;
                if (reroll) {
                    const last = list[list.length - 1];
                    if (!last || last.type) return say(msg, "There's no agent line at the end to redo.", true);
                    avoid = last.text;
                    who = last.speaker;
                    list = list.slice(0, -1);
                }
                if (list.length >= MAX_SCENE_LINES) return say(msg, `A scene holds up to ${MAX_SCENE_LINES} lines. Start a new scene for what comes next.`, true);
                count = Math.min(count, MAX_SCENE_LINES - list.length);
                ui.busy = true;
                buttons.forEach(b => { b.disabled = true; });
                say(msg, count > 1 ? `Writing the next ${count} lines…` : "Writing the next line…");
                const note = direction.value.trim();
                try {
                    const text = await deps.chat([{ role: "system", content: sceneDirectorPrompt(p, scene) },
                        { role: "user", content: sceneTurnMessage({ lines: list }, { speaker: who, count, direction: note, avoid }) }]);
                    ui.sceneCalls[scene.id] = calls() + 1;
                    const got = parseSceneLines(text, cast).slice(0, count);
                    if (!got.length) say(msg, "The answer had no lines in it. Try again.", true);
                    else {
                        // The note goes in the script, so the game (and later turns) know why it happened.
                        setLines([...list, ...(note ? [{ type: "direction", text: note }] : []), ...got]);
                        direction.value = "";
                        say(msg, "");
                    }
                } catch (err) { say(msg, `Couldn't write it: ${err.message}`, true); }
                ui.busy = false;
                buttons.forEach(b => { b.disabled = false; });
                draw();
            }

            const next = el("button", { class: "gs-btn primary", type: "button", text: "▶ Next line", onclick: () => turn() });
            const four = el("button", { class: "gs-btn", type: "button", text: "⏩ Next 4 lines", onclick: () => turn({ count: 4 }) });
            const reroll = el("button", { class: "gs-btn", type: "button", text: "🔁 Redo last line", onclick: () => turn({ reroll: true }) });
            const undo = el("button", { class: "gs-btn", type: "button", text: "↩ Undo", title: "Remove the last line", onclick: () => { setLines(lines().slice(0, -1)); draw(); } });
            const buttons = [next, four, reroll, undo];

            // Step in: the user writes a line as a character, a narration or a direction.
            const as = el("select", { "aria-label": "Step in as" }, cast.map(c => el("option", { value: c.name, text: c.name })),
                el("option", { value: "@narration", text: "Narration" }), el("option", { value: "@direction", text: "Stage direction" }));
            const mine = el("input", { type: "text", placeholder: "Step in: write a line yourself", "aria-label": "Your line" });
            const add = () => {
                const text = mine.value.trim();
                if (!text) return;
                if (lines().length >= MAX_SCENE_LINES) return say(msg, `A scene holds up to ${MAX_SCENE_LINES} lines.`, true);
                const line = as.value === "@narration" ? { type: "narration", text } : as.value === "@direction" ? { type: "direction", text } : { speaker: as.value, text };
                setLines([...lines(), line]);
                mine.value = "";
                draw();
            };
            mine.addEventListener("keydown", e => { if (e.key === "Enter") add(); });

            const f = scene.fields || {};
            const head = el("div", { class: "gs-row" },
                el("button", { class: "gs-btn", type: "button", text: "← Scenes", onclick: () => { ui.sceneId = ""; render(); } }),
                el("b", { text: scene.name }),
                el("button", { class: "gs-btn", type: "button", text: "⚙️ Setup", onclick: () => { ui.sceneSetup = true; render(); } }),
                el("button", { class: "gs-btn", type: "button", text: "🤖 Ask an agent", title: "Have an agent in the chat finish or polish this scene", onclick: () => sendToAgent(p, `Continue or polish the scene "${scene.name}" (read it with studio_read, then save the result with studio_save as the same scene).`) }));
            const info = el("div", { class: "gs-note", text: `Where: ${f.location || "not set"} · Who: ${f.characters || "not set"} · Goal: ${f.goal || "not set"}${f.branch_of ? ` · 🌿 What if, from "${f.branch_of}" line ${f.branch_at}` : ""}` });
            const checker = loreChecker(p, [store.findEntry(p, scene.id) || scene], scene.id);
            draw();
            if (scene.locked) {
                log.querySelectorAll("button:not(.gs-speak)").forEach(b => { b.disabled = true; });
                return el("div", { class: "gs" }, head, info, log, el("div", { class: "gs-row" }, play), el("div", { class: "gs-note", text: "🔒 This scene is locked. Unlock it in the story bible to change it." }));
            }
            return el("div", { class: "gs" }, head, info, log,
                el("div", { class: "gs-row" }, "Next:", speaker, direction),
                el("div", { class: "gs-row" }, next, four, reroll, undo, play,
                    suggestGrowthButton(p, cast.map(c => c.id && store.findEntry(p, c.id)), () => `Scene "${scene.name}" (${f.location || "somewhere"}). Goal: ${f.goal || "none"}.\n${lines().map(lineText).join("\n")}`, msg), meter),
                el("div", { class: "gs-send" }, as, mine, el("button", { class: "gs-btn", type: "button", text: "Add", onclick: add })),
                msg,
                el("div", { class: "gs-note", text: "Saved automatically to the story bible. Export it from 📦 Export to your game." }),
                checker);
        }

        function exportView(p) {
            const msg = el("div", { class: "gs-msg" });
            const folder = el("input", { type: "text", value: "game_data", "aria-label": "Folder in your project" });
            const formats = [
                ["all", "Everything"], ["gdscript", "game_data.gd (GDScript constants)"], ["json", "story_bible.json"], ["dialogue", "Dialogue files (one JSON each)"], ["scenes", "Scenes as cutscene JSON"], ["markdown", "story_bible.md (to read)"]
            ];
            const format = el("select", { "aria-label": "What to export" }, formats.map(([v, t]) => el("option", { value: v, text: t })));
            const toFolder = el("button", { class: "gs-btn primary", type: "button", text: "📁 Save into my project folder", disabled: !(deps.canWriteFolder && deps.canWriteFolder()), onclick: async () => {
                const files = exportFiles(p, format.value, folder.value);
                const results = [];
                for (const [path, content] of Object.entries(files)) results.push(await deps.writeFile(path, content));
                say(msg, results.join("\n"));
            } });
            const download = el("button", { class: "gs-btn", type: "button", text: "⬇ Download", onclick: async () => {
                const files = exportFiles(p, format.value, "");
                const names = Object.keys(files);
                if (!names.length) return say(msg, "Nothing to export for that choice yet.", true);
                for (const name of names) await deps.saveFile(`${slug(p.name)}_${name.replace(/\//g, "_")}`, files[name], name.endsWith(".json") ? "application/json" : "text/plain");
                say(msg, `Exported ${names.length} file${names.length === 1 ? "" : "s"}.`);
            } });
            const preview = el("pre", { class: "gs-note", style: "white-space: pre-wrap; max-height: 260px; overflow: auto; background: var(--bg-dark); padding: 8px; border-radius: 6px;" });
            const show = () => { const files = exportFiles(p, format.value === "all" ? "gdscript" : format.value, folder.value); const first = Object.entries(files)[0]; preview.textContent = first ? `${first[0]}\n\n${first[1].slice(0, 4000)}` : "Nothing to export for that choice yet."; };
            format.addEventListener("change", show);
            show();
            return el("div", { class: "gs-form" },
                el("div", { class: "gs-note", text: `Turns ${p.name}'s story bible into files your game can load. For Godot: put game_data.gd in your project and use GameData.CHARACTERS, GameData.dialogue_lines() and GameData.scene_beats(). Each dialogue or scene line has an id and the id of the line after it, so it plays as a cutscene or a dialogue tree. Agents can do this for you too: ask "export the story bible to my project".` }),
                el("div", { class: "gs-row" }, el("label", {}, "What", format), el("label", {}, "Folder in your project", folder)),
                el("div", { class: "gs-row" }, toFolder, download), msg,
                deps.canWriteFolder && !deps.canWriteFolder() ? el("div", { class: "gs-note", text: "Connect your game's folder (📁 Project Files) to save straight into it." }) : null,
                preview);
        }

        store.onChange(() => { if (container.offsetParent !== null && !container.contains(document.activeElement)) render(); });
        render();
        return { refresh: render, store };
    }

    return {
        STORE_KEY, KINDS, KIND_NAMES, SECTIONS, STUDIO_TASK,
        createStudioStore, buildStudioTools, studioPromptBlock, isStudioTask, exportFiles, toJson, toGdscript, toMarkdown,
        MOODS, moodFor, portraitFor, normalizeVoice, splitMood, LINK_TYPES, BEAT_STATUS, timelineOrder, INTERVIEW_QUESTIONS, loreCheckPrompt, parseIssues, growthPrompt, parseGrowth, characterSheetHtml,
        describeEntry, characterSystemPrompt, sceneDirectorPrompt, sceneTurnMessage, framePrompt, parseSceneLines, normalizeKind, slug, mount
    };
});
