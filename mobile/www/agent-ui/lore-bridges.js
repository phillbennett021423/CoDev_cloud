// Lore bridges: Story Studio's bible to and from the free tools writers already use.
//
//   CodevLoreBridges.toObsidianVault(project)      { "Characters/Relay.md": "...", ... } one note per entry,
//                                                   relationships as [[wikilinks]], so Obsidian's graph shows the web
//   CodevLoreBridges.parseVault(files)             [{ path, text }] from an Obsidian (or any Markdown) vault ->
//                                                   { name, pitch, engine, entries, skipped }
//   CodevLoreBridges.fromAzgaar(text, options)     Azgaar's Fantasy Map Generator "Export > JSON" ->
//                                                   { name, entries, stats }: states become factions with
//                                                   territory and diplomacy, burgs and provinces become places
//                                                   (with map positions), cultures and religions become lore,
//                                                   roads and sea routes become a routes lore entry
//   CodevLoreBridges.toStoryCraftr(project)        files for a StoryCraftr book folder (worldbuilding/*.md,
//                                                   outline/character_summary.md), which it reads as context
//   CodevLoreBridges.fromStoryCraftr(files)        what StoryCraftr wrote (worldbuilding, outline) back as lore
//   CodevLoreBridges.loreMatches(entries, text)    the entries a brief names (by name or alias), for art prompts
//   CodevLoreBridges.lookFor(entry)                the words that describe how an entry looks
//
// Entries come back in the shape Story Studio's store.mergeEntries takes: links point at
// other entries by name. Nothing here touches the network or the disk; the page and the
// desktop art tools hand it the files. Same file in the page and in Node, like story-studio.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("./story-studio.js"));
    else root.CodevLoreBridges = factory(root.CodevStoryStudio);
})(typeof self !== "undefined" ? self : this, function (Studio) {
    "use strict";

    const KINDS = Studio.KINDS;
    const KIND_NAMES = Studio.KIND_NAMES;
    const LINK_TYPES = Studio.LINK_TYPES;
    const MAX_FILES = 2000;
    const MAX_NOTE_CHARS = 60000;
    const MAX_FIELD_CHARS = 6000;
    const MAX_SUMMARY_CHARS = 400;
    const MAX_LINKS = 40;

    function clean(text, max) { return String(text == null ? "" : text).replace(/\r\n?/g, "\n").trim().slice(0, max); }
    function sameName(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }
    function slug(text) { return Studio.slug(text); }
    function baseName(p) { return String(p || "").replace(/\\/g, "/").split("/").pop().replace(/\.md$/i, ""); }

    function fieldLabel(kind, key) {
        const found = (KINDS[kind] ? KINDS[kind].fields : []).find(([k]) => k === key);
        return found ? found[1] : key.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());
    }

    // ---------- A small YAML front matter reader and writer ----------
    // Enough for Obsidian properties: scalars, [inline, lists] and "- item" lists.

    function yamlScalar(raw) {
        const v = String(raw).trim();
        if (!v) return "";
        if ((v.startsWith('"') && v.endsWith('"'))) { try { return JSON.parse(v); } catch (err) { return v.slice(1, -1); } }
        if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
        if (v.startsWith("[") && v.endsWith("]")) {
            // [[wikilinks]] inside a list stay whole.
            const inner = v.slice(1, -1);
            const items = [];
            let depth = 0, cur = "", quote = "";
            for (const ch of inner) {
                if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
                if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
                if (ch === "[") depth++;
                if (ch === "]") depth--;
                if (ch === "," && depth === 0) { items.push(cur); cur = ""; continue; }
                cur += ch;
            }
            if (cur.trim()) items.push(cur);
            return items.map(yamlScalar).filter(x => x !== "");
        }
        if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
        if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
        return v;
    }

    function readFrontMatter(text) {
        const m = String(text).match(/^﻿?---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/);
        if (!m) return { data: {}, body: String(text).replace(/^﻿/, "") };
        const data = {};
        let listKey = "";
        for (const line of m[1].split("\n")) {
            if (!line.trim() || /^\s*#/.test(line)) continue;
            const item = line.match(/^\s+-\s*(.*)$/) || (listKey && line.match(/^-\s*(.*)$/));
            if (item && listKey) {
                if (!Array.isArray(data[listKey])) data[listKey] = data[listKey] === "" ? [] : [data[listKey]];
                const v = yamlScalar(item[1]);
                if (v !== "") data[listKey].push(v);
                continue;
            }
            const kv = line.match(/^([A-Za-z0-9_][\w -]*?)\s*:\s*(.*)$/);
            if (!kv) continue;
            listKey = kv[1].trim().toLowerCase();
            data[listKey] = yamlScalar(kv[2]);
        }
        return { data, body: String(text).slice(m[0].length) };
    }

    function yamlValue(v) {
        if (Array.isArray(v)) return v.length ? "\n" + v.map(x => `  - ${JSON.stringify(String(x))}`).join("\n") : " []";
        if (typeof v === "number" || typeof v === "boolean") return ` ${v}`;
        return ` ${JSON.stringify(String(v))}`;
    }

    function writeFrontMatter(data) {
        const keys = Object.keys(data).filter(k => data[k] !== undefined && data[k] !== "" && !(Array.isArray(data[k]) && !data[k].length));
        return keys.length ? `---\n${keys.map(k => `${k}:${yamlValue(data[k])}`).join("\n")}\n---\n` : "";
    }

    // ---------- Obsidian: export ----------

    // Characters Obsidian (and Windows, macOS, Android) won't take in a file name.
    function noteName(name) {
        return String(name || "Untitled").replace(/[*"\\/<>:|?#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 100) || "Untitled";
    }

    function tagWord(t) { return String(t).trim().replace(/^#/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, ""); }

    // Each entry's note path and how other notes link to it ([[Name]], or [[Folder/Name|Name]]
    // when two notes share a name, like a character and a faction both called Null).
    function notePaths(p) {
        const paths = new Map();
        const used = new Set();
        const counts = {};
        for (const e of p.entries) {
            const file = noteName(e.name);
            counts[file.toLowerCase()] = (counts[file.toLowerCase()] || 0) + 1;
        }
        for (const e of p.entries) {
            const folder = (KINDS[e.kind] || KINDS.lore).plural;
            let file = noteName(e.name);
            for (let n = 2; used.has(`${folder}/${file}`.toLowerCase()); n++) file = `${noteName(e.name)} ${n}`;
            used.add(`${folder}/${file}`.toLowerCase());
            const unique = counts[noteName(e.name).toLowerCase()] === 1 && file === noteName(e.name);
            paths.set(e.id, { path: `${folder}/${file}.md`, link: unique ? `[[${file}]]` : `[[${folder}/${file}|${e.name}]]` });
        }
        return paths;
    }

    function lineMarkdown(l) {
        if (l.type === "direction") return `- *(${l.text})*`;
        if (l.type === "narration") return `- *${l.text}*`;
        const choices = l.choices && l.choices.length ? ` → ${l.choices.map(c => `[${c.text}${c.next ? ` ⇒ ${c.next}` : ""}]`).join(" ")}` : "";
        return `- **${l.speaker || "?"}**${l.emotion ? ` (${l.emotion})` : ""}: ${l.text}${choices}`;
    }

    function linkTypeLabel(type) { return (LINK_TYPES.find(([t]) => t === type) || LINK_TYPES[LINK_TYPES.length - 1])[1]; }

    function toObsidianVault(p, folder = "") {
        const base = String(folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        const at = name => base ? `${base}/${name}` : name;
        const paths = notePaths(p);
        const files = {};
        for (const e of p.entries) {
            const kind = KINDS[e.kind] || KINDS.lore;
            const fm = { codev_kind: e.kind, tags: [tagWord(e.kind), ...(e.tags || []).map(tagWord)].filter((t, i, a) => t && a.indexOf(t) === i) };
            // Obsidian tags can't hold spaces or dots, so the exact tags ride along too.
            if ((e.tags || []).some(t => tagWord(t) !== t)) fm.codev_tags = e.tags.slice();
            if (noteName(e.name) !== e.name) fm.name = e.name;
            if (e.order !== undefined) fm.order = e.order;
            if (e.locked) fm.locked = true;
            const out = [writeFrontMatter(fm)];
            if (e.summary) out.push(e.summary, "");
            const order = kind.fields.map(([k]) => k);
            const keys = Object.keys(e.fields || {}).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
            for (const k of keys) out.push(`## ${fieldLabel(e.kind, k)}`, "", e.fields[k], "");
            if (e.links && e.links.length) {
                out.push("## Relationships", "");
                for (const l of e.links) {
                    const target = paths.get(l.to);
                    out.push(`- ${linkTypeLabel(l.type)}: ${target ? target.link : `[[${noteName(l.name)}]]`}${l.note ? ` (${l.note})` : ""}`);
                }
                out.push("");
            }
            if (e.beats && e.beats.length) out.push("## Beats", "", ...e.beats.map(b => `- [${b.status || "idea"}] ${b.text}`), "");
            if (e.lines && e.lines.length) out.push("## Lines", "", ...e.lines.map(lineMarkdown), "");
            files[at(paths.get(e.id).path)] = out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
        }
        // The home note: the project, and every note grouped by kind.
        const home = [writeFrontMatter({ codev_project: true, engine: p.engine }), p.pitch || "", ""];
        for (const kind of KIND_NAMES) {
            const list = p.entries.filter(e => e.kind === kind);
            if (!list.length) continue;
            home.push(`## ${KINDS[kind].plural}`, "", ...list.map(e => `- ${paths.get(e.id).link}${e.summary ? `: ${e.summary.slice(0, 140)}` : ""}`), "");
        }
        home.push("---", "*Made by CoDev's Story Studio. Edit these notes in Obsidian, then import the vault back into Story Studio (🧭 World tools) to update the bible.*");
        files[at(`${noteName(p.name)}.md`)] = home.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
        return files;
    }

    // ---------- Obsidian: import ----------

    // Folder and tag words that say what kind of note it is.
    const KIND_WORDS = {
        character: ["character", "characters", "people", "person", "npc", "npcs", "cast", "heroes", "villains", "hero", "villain"],
        faction: ["faction", "factions", "organization", "organizations", "organisation", "organisations", "groups", "nations", "nation", "states", "guilds", "houses"],
        ability: ["ability", "abilities", "powers", "power", "magic", "spells", "skills"],
        location: ["location", "locations", "places", "place", "regions", "region", "cities", "city", "geography", "worlds", "planets", "provinces"],
        event: ["event", "events", "timeline", "history", "eras"],
        lore: ["lore", "worldbuilding", "cultures", "culture", "religions", "religion", "notes", "concepts", "technology"],
        quest: ["quest", "quests", "missions", "mission"],
        item: ["item", "items", "artifacts", "artefacts", "weapons", "weapon", "gear", "equipment", "relics"],
        dialogue: ["dialogue", "dialogues", "dialog", "conversations"],
        scene: ["scene", "scenes", "cutscenes", "chapters"],
        arc: ["arc", "arcs", "storylines", "plots", "plot"]
    };

    function kindFromWord(word) {
        const w = String(word || "").toLowerCase().trim();
        if (!w) return "";
        const direct = Studio.normalizeKind(w);
        if (direct) return direct;
        for (const [kind, list] of Object.entries(KIND_WORDS)) if (list.includes(w)) return kind;
        return "";
    }

    // "ally", "Allies", "brother", "Member of" -> a relationship type.
    const LINK_WORDS = [
        ["ally", /\b(all(y|ies)|friend(s|ly)?|partner in arms|comrades?|allied)\b/i],
        ["enemy", /\b(enem(y|ies)|nemesis|foes?|hostile|at war)\b/i],
        ["rival", /\b(rivals?|rivalry|competitors?|suspicion)\b/i],
        ["family", /\b(family|brother|sister|sibling|mother|father|parent|son|daughter|cousin|uncle|aunt|kin|twin)s?\b/i],
        ["love", /\b(love|lover|spouse|wife|husband|partner|romance|crush)s?\b/i],
        ["mentor", /\b(mentor|teacher|master|student|apprentice|protege|protégé|mentee)s?\b/i],
        ["member", /\b(member( of)?|members|belongs|faction|vassal|serves|works for|citizens?)\b/i]
    ];
    function linkTypeFrom(text) {
        const t = String(text || "");
        for (const [type, label] of LINK_TYPES) if (new RegExp(`^\\s*${label}\\b`, "i").test(t) || new RegExp(`^\\s*${type}\\b`, "i").test(t)) return type;
        for (const [type, re] of LINK_WORDS) if (re.test(t)) return type;
        return "other";
    }

    // [[Folder/Name#heading|shown]] -> "Folder/Name" (resolved to a note later)
    function wikiTargets(text) {
        const out = [];
        const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
        let m;
        while ((m = re.exec(String(text || "")))) out.push(m[1].trim().replace(/\.md$/i, ""));
        return out;
    }

    function stripWiki(text) {
        return String(text || "").replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, target, shown) => shown || baseName(target.replace(/#.*$/, "")));
    }

    function fieldKeyFor(kind, heading) {
        const h = String(heading || "").trim().toLowerCase().replace(/[:：]$/, "");
        const fields = (KINDS[kind] || KINDS.lore).fields;
        const exact = fields.find(([k, label]) => label.toLowerCase() === h || k === slug(h));
        if (exact) return exact[0];
        const synonyms = {
            appearance: /^(appearance|looks?|description|visuals?|physical)/, personality: /^(personality|traits?|temperament)/, backstory: /^(backstory|background|history|origin)/,
            powers: /^(powers?|abilities|skills|magic)/, speaking_style: /^(voice|speech|how (they|he|she) talks?|speaking)/, goals: /^(goals?|motivations?|fears?|wants)/,
            relationships: /^(relationships?|connections|allies and enemies)/, role: /^(role|occupation|class|title)/,
            purpose: /^(purpose|goals?|ideology|aims?)/, members: /^(members|leaders?|leadership)/, territory: /^(territor(y|ies)|lands?|borders?|domain)/,
            description: /^(description|overview|appearance)/, inhabitants: /^(inhabitants|population|people|who is there)/, details: /^(details|overview|description|notes)/,
            effect: /^(effect|what it does|stats)/, limits: /^(limits?|cost|weakness(es)?)/, owner: /^(owner|wielder|who has it)/, when: /^(when|date)/, what: /^(what happened|summary|events?)/
        };
        const hit = fields.find(([k]) => synonyms[k] && synonyms[k].test(h));
        return hit ? hit[0] : slug(h).slice(0, 40);
    }

    function parseLineMarkdown(raw) {
        const t = raw.replace(/^\s*[-*]\s+/, "").trim();
        let m = t.match(/^\*\((.*)\)\*$/);
        if (m) return { type: "direction", text: m[1] };
        m = t.match(/^\*\*([^*]+)\*\*\s*(?:\(([^)]*)\))?\s*:\s*(.*)$/) || t.match(/^([A-Z][\w .'-]{0,40}?)\s*(?:\(([^)]*)\))?:\s+(.*)$/);
        if (m) {
            const choices = [];
            const text = m[3].replace(/\s*→\s*((?:\[[^\]]*\]\s*)+)$/, (_, list) => {
                list.replace(/\[([^\]⇒]*)(?:⇒\s*([^\]]*))?\]/g, (__, c, next) => { choices.push({ text: c.trim(), ...(next ? { next: next.trim() } : {}) }); });
                return "";
            });
            return { speaker: m[1].trim(), text: stripWiki(text), ...(m[2] ? { emotion: m[2].trim() } : {}), ...(choices.length ? { choices } : {}) };
        }
        m = t.match(/^\*(.*)\*$/);
        if (m) return { type: "narration", text: m[1] };
        return { type: "narration", text: stripWiki(t) };
    }

    // Splits a note into its intro (before the first ## heading) and its sections.
    function sections(body) {
        const out = { intro: [], list: [] };
        let cur = null;
        for (const line of body.split("\n")) {
            const h = line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
            if (h) {
                if (h[1] === "#" && !cur && !out.intro.join("").trim()) { out.title = h[2]; continue; }
                cur = { heading: h[2], lines: [] };
                out.list.push(cur);
                continue;
            }
            (cur ? cur.lines : out.intro).push(line);
        }
        return out;
    }

    function noteToEntry(file, defaults = {}) {
        const { data, body } = readFrontMatter(file.text.slice(0, MAX_NOTE_CHARS));
        const parts = sections(body);
        const folders = String(file.path).replace(/\\/g, "/").split("/").slice(0, -1);
        const tags = [].concat(data.tags || [], data.tag || []).map(t => String(t).replace(/^#/, "")).filter(Boolean);
        const ownTags = Array.isArray(data.codev_tags) ? data.codev_tags.map(String) : null;
        const kind = kindFromWord(data.codev_kind) || kindFromWord(data.kind) || kindFromWord(data.type) || kindFromWord(data.category)
            || tags.map(kindFromWord).find(Boolean) || folders.slice().reverse().map(kindFromWord).find(Boolean) || defaults.kind || "lore";
        const name = clean(data.name || data.title || parts.title || baseName(file.path), 120);
        const entry = { kind, name, fields: {}, tags: (ownTags || tags.filter(t => ![kind, KINDS[kind].plural.toLowerCase()].includes(t.toLowerCase()))).slice(0, 20), links: [] };
        const intro = stripWiki(parts.intro.join("\n")).trim();
        const introLinks = wikiTargets(parts.intro.join("\n"));
        if (data.summary) entry.summary = clean(stripWiki(data.summary), MAX_SUMMARY_CHARS);
        if (intro) {
            if (!entry.summary && intro.length <= MAX_SUMMARY_CHARS && !intro.includes("\n\n")) entry.summary = intro;
            else entry.fields[{ lore: "details", character: "backstory" }[kind] || KINDS[kind].fields[0][0]] = clean(intro, MAX_FIELD_CHARS);
        }
        if (data.order !== undefined && Number.isFinite(Number(data.order))) entry.order = Number(data.order);
        if (data.locked === true) entry.locked = true;
        if (data.aliases) entry.fields.aliases = [].concat(data.aliases).map(String).join(", ");
        // Other properties: relationship-ish keys become links, the rest become fields.
        const skip = new Set(["codev_kind", "codev_tags", "kind", "type", "category", "name", "title", "tags", "tag", "summary", "order", "locked", "aliases", "cssclasses", "cssclass", "publish", "created", "updated", "modified", "date"]);
        for (const [k, v] of Object.entries(data)) {
            if (skip.has(k)) continue;
            const values = [].concat(v).map(String);
            const linked = values.flatMap(x => wikiTargets(x));
            const type = linkTypeFrom(k);
            if (linked.length && type !== "other") linked.forEach(to => entry.links.push({ to, type }));
            else if (linked.length) linked.forEach(to => entry.links.push({ to, type: "other", note: k.replace(/_/g, " ") }));
            else entry.fields[slug(k).slice(0, 40)] = clean(values.join(", "), MAX_FIELD_CHARS);
        }
        let hasRelationships = false;
        for (const sec of parts.list) {
            const text = sec.lines.join("\n").trim();
            const h = sec.heading.trim().toLowerCase();
            if (/^(relationships?|connections|links|allies and enemies)$/.test(h) && /\[\[/.test(text)) {
                hasRelationships = true;
                for (const line of text.split("\n")) {
                    const targets = wikiTargets(line);
                    if (!targets.length) continue;
                    const note = (line.match(/\]\]\s*\(([^)]+)\)\s*$/) || line.match(/\]\]\s*[-–—:]\s*(.+)$/) || [])[1];
                    const type = linkTypeFrom(line.replace(/^\s*[-*]\s*/, "").replace(/\[\[[^\]]*\]\]/g, " "));
                    targets.forEach(to => entry.links.push({ to, type, ...(note && linkTypeFrom(note) === "other" ? { note: clean(stripWiki(note), 200) } : {}) }));
                }
                continue;
            }
            if (/^(lines|script|dialogue)$/.test(h) && (kind === "dialogue" || kind === "scene")) {
                entry.lines = text.split("\n").filter(l => /^\s*[-*]\s+/.test(l)).map(parseLineMarkdown).slice(0, 200);
                continue;
            }
            if (/^beats$/.test(h) && kind === "arc") {
                entry.beats = text.split("\n").filter(l => /^\s*[-*]\s+/.test(l)).map(l => {
                    const m = l.replace(/^\s*[-*]\s+/, "").match(/^\[(idea|written|in_game)\]\s*(.*)$/);
                    return m ? { status: m[1], text: stripWiki(m[2]) } : { status: "idea", text: stripWiki(l.replace(/^\s*[-*]\s+(\[[ x]\]\s*)?/, "")) };
                }).filter(b => b.text);
                continue;
            }
            const key = fieldKeyFor(kind, sec.heading);
            const value = clean(stripWiki(text), MAX_FIELD_CHARS);
            if (value) entry.fields[key] = entry.fields[key] ? clean(`${entry.fields[key]}\n\n${value}`, MAX_FIELD_CHARS) : value;
        }
        // Without a Relationships section, other notes it links to still join the web.
        if (!hasRelationships) [...introLinks, ...parts.list.flatMap(s => wikiTargets(s.lines.join("\n")))].forEach(to => entry.links.push({ to, type: "other" }));
        return { entry, data };
    }

    // files: [{ path, text }]. Folders Obsidian keeps for itself, templates and the
    // trash are skipped, and so are files that aren't Markdown.
    function parseVault(files, defaults = {}) {
        const list = (files || []).filter(f => f && typeof f.text === "string" && /\.md$/i.test(f.path || "")
            && !String(f.path).replace(/\\/g, "/").split("/").some(seg => /^(\.|_)|^(templates?|\.trash|\.obsidian|attachments)$/i.test(seg)));
        const result = { name: "", pitch: "", engine: "", entries: [], skipped: Math.max(0, (files || []).length - list.length) };
        const byNote = new Map();
        const byPath = new Map();
        for (const file of list.slice(0, MAX_FILES)) {
            const { entry, data } = noteToEntry(file, defaults);
            if (data.codev_project === true) {
                result.name = clean(data.name || baseName(file.path), 80);
                result.engine = clean(data.engine, 40);
                result.pitch = clean(stripWiki(sections(readFrontMatter(file.text).body).intro.join("\n")), 1000);
                continue;
            }
            if (!entry.name) continue;
            result.entries.push(entry);
            const key = baseName(file.path).toLowerCase();
            byNote.set(key, byNote.has(key) ? null : entry);
            byPath.set(String(file.path).replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase(), entry);
        }
        if (list.length > MAX_FILES) result.skipped += list.length - MAX_FILES;
        // Links named by a note's file name point at that note's entry name. Links to notes
        // that aren't in the vault keep their name: the bible they go into may have them
        // (the store drops the rest).
        for (const e of result.entries) {
            const seen = new Set();
            e.links = e.links.map(l => {
                const raw = String(l.to).toLowerCase();
                const target = [...byPath.entries()].find(([p]) => p === raw || p.endsWith(`/${raw}`))?.[1] || byNote.get(baseName(raw));
                const to = target ? target.name : baseName(l.to);
                if (!to || target === e || (!target && sameName(to, e.name)) || seen.has(`${to.toLowerCase()}:${l.type}`)) return null;
                seen.add(`${to.toLowerCase()}:${l.type}`);
                return { ...l, to };
            }).filter(Boolean).slice(0, MAX_LINKS);
            if (!e.links.length) delete e.links;
        }
        return result;
    }

    // ---------- Azgaar's Fantasy Map Generator ----------

    const DIPLOMACY = { ally: ["ally"], friendly: ["ally", "friendly"], enemy: ["enemy"], rival: ["rival"], suspicion: ["rival", "suspicion"], vassal: ["member", "vassal"], suzerain: ["other", "suzerain"] };

    function listNames(list, max = 12) {
        const names = list.filter(Boolean);
        return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
    }

    // options: { maxBurgs (default 60), maxProvinces (default 60), includeRoutes (default true) }
    function fromAzgaar(text, options = {}) {
        if (/^\s*[\d.]+\|/.test(String(text).slice(0, 200))) return { error: "That's an Azgaar .map save file. In Azgaar's Fantasy Map Generator, open Menu > Export > Export to JSON > Full, and import that .json file instead." };
        let data;
        try { data = typeof text === "string" ? JSON.parse(text) : text; } catch (err) { return { error: "That isn't an Azgaar JSON export. In Azgaar's Fantasy Map Generator: Menu > Export > Export to JSON > Full." }; }
        const pack = data && (data.pack || data);
        if (!pack || !Array.isArray(pack.states)) return { error: "That JSON has no states, so it isn't a full Azgaar export. Use Export to JSON > Full (not Minimal, Grid cells or Pack cells)." };
        const info = data.info || {};
        const settings = data.settings || {};
        const name = clean(info.mapName || settings.mapName || "Azgaar map", 80);
        const popRate = Number(settings.populationRate) || 1000;
        const urban = Number(settings.urbanization) || 1;
        const width = Number(info.width || (data.mapCoordinates && data.mapCoordinates.width)) || 0;
        const height = Number(info.height || (data.mapCoordinates && data.mapCoordinates.height)) || 0;
        const live = list => (Array.isArray(list) ? list : []).filter(x => x && typeof x === "object" && x.i && !x.removed && x.name);
        const states = live(pack.states);
        const cultures = live(pack.cultures);
        const religions = live(pack.religions);
        const provincesAll = live(pack.provinces);
        const burgsAll = live(pack.burgs);
        const byId = (list, i) => list.find(x => x.i === i);
        const stateName = i => (byId(states, i) || {}).name || "";
        const cultureName = i => (byId(cultures, i) || {}).name || "";
        const burgName = i => (byId(burgsAll, i) || {}).name || "";
        const pos = o => (Number.isFinite(o.x) && Number.isFinite(o.y) ? `x ${Math.round(o.x)}, y ${Math.round(o.y)}${width && height ? ` on the ${width}×${height} map` : ""}` : "");
        const notes = new Map((Array.isArray(data.notes) ? data.notes : []).filter(n => n && n.id).map(n => [String(n.id), n]));
        const legend = id => { const n = notes.get(id); return n ? clean(String(n.legend || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 2000) : ""; };
        const population = b => Math.round((Number(b.population) || 0) * popRate * urban);
        const entries = [];
        const tag = ["azgaar"];

        // Burgs: every capital, then the largest, up to maxBurgs.
        const maxBurgs = Math.max(0, Math.min(Number(options.maxBurgs ?? 60), 300));
        const capitals = burgsAll.filter(b => Number(b.capital));
        const burgs = [...capitals, ...burgsAll.filter(b => !Number(b.capital)).sort((a, b) => (Number(b.population) || 0) - (Number(a.population) || 0)).slice(0, Math.max(0, maxBurgs - capitals.length))];
        const maxProvinces = Math.max(0, Math.min(Number(options.maxProvinces ?? 60), 300));
        const provinces = provincesAll.slice(0, maxProvinces);

        for (const s of states) {
            const capital = burgName(s.capital);
            const provs = provincesAll.filter(p => p.state === s.i).map(p => p.name);
            const cities = burgsAll.filter(b => b.state === s.i);
            const territory = [capital && `Capital: ${capital}.`, provs.length && `Provinces: ${listNames(provs)}.`, cities.length && `${cities.length} ${cities.length === 1 ? "city" : "cities and towns"} (largest: ${listNames(cities.sort((a, b) => (b.population || 0) - (a.population || 0)).map(b => b.name), 5)}).`,
                s.neighbors && s.neighbors.length && `Borders: ${listNames(s.neighbors.map(stateName))}.`, s.area && `Area: ${Math.round(s.area)} map units.`, s.pole && `Centre at x ${Math.round(s.pole[0])}, y ${Math.round(s.pole[1])}.`].filter(Boolean).join(" ");
            const history = [(s.campaigns || []).length && `Wars and campaigns: ${(s.campaigns || []).map(c => `${c.name}${c.start ? ` (${c.start}${c.end ? `–${c.end}` : ""})` : ""}`).join("; ")}.`, legend(`state${s.i}`)].filter(Boolean).join("\n\n");
            const links = [];
            (s.diplomacy || []).forEach((rel, j) => {
                const how = DIPLOMACY[String(rel || "").toLowerCase()];
                const other = j !== s.i && stateName(j);
                if (how && other) links.push({ to: other, type: how[0], ...(how[1] ? { note: how[1] } : {}) });
            });
            entries.push({ kind: "faction", name: s.name, summary: clean([s.fullName, s.formName || s.form, s.type && `${s.type} state`].filter(Boolean).join(", "), MAX_SUMMARY_CHARS),
                fields: { territory, ...(history ? { history } : {}), ...(cultureName(s.culture) ? { members: `Mostly ${cultureName(s.culture)} people.` } : {}), ...(s.color ? { map_color: s.color } : {}) },
                tags: [...tag, "state", s.form, s.type].filter(Boolean).map(String), links });
        }
        for (const p of provinces) {
            const owner = stateName(p.state);
            entries.push({ kind: "location", name: p.name === stateName(p.state) ? `${p.name} (province)` : p.name, summary: clean([p.fullName || p.name, p.formName, owner && `a province of ${owner}`].filter(Boolean).join(", "), MAX_SUMMARY_CHARS),
                fields: { description: [burgName(p.burg) && `Seat: ${burgName(p.burg)}.`, owner && `Part of ${owner}.`].filter(Boolean).join(" "), ...(legend(`province${p.i}`) ? { history: legend(`province${p.i}`) } : {}) },
                tags: [...tag, "province"], links: owner ? [{ to: owner, type: "member" }] : [] });
        }
        for (const b of burgs) {
            const owner = stateName(b.state);
            const features = ["port", "citadel", "walls", "plaza", "temple", "shanty"].filter(f => Number(b[f])).map(f => f === "port" ? "a port" : f === "shanty" ? "a shanty town" : f);
            const province = provincesAll.find(p => p.burg === b.i) || null;
            const name = burgsAll.some(x => x !== b && sameName(x.name, b.name)) ? `${b.name} (${owner || "free city"})` : b.name;
            entries.push({ kind: "location", name, summary: clean(`${b.capital ? "Capital" : b.type && b.type !== "Generic" ? `${b.type} city` : "City"}${owner ? ` of ${owner}` : ""}, about ${population(b).toLocaleString("en-US")} people.`, MAX_SUMMARY_CHARS),
                fields: { description: [features.length && `Has ${listNames(features)}.`, province && `Seat of ${province.name}.`].filter(Boolean).join(" ") || "A settlement on the map.",
                    inhabitants: [cultureName(b.culture) && `Mostly ${cultureName(b.culture)}.`, `Population about ${population(b).toLocaleString("en-US")}.`].filter(Boolean).join(" "),
                    ...(pos(b) ? { map_position: pos(b) } : {}), ...(legend(`burg${b.i}`) ? { history: legend(`burg${b.i}`) } : {}) },
                tags: [...tag, "city", ...(b.capital ? ["capital"] : []), ...(Number(b.port) ? ["port"] : [])], links: owner ? [{ to: owner, type: "member" }] : [] });
        }
        for (const c of cultures) {
            const where = states.filter(s => s.culture === c.i).map(s => s.name);
            entries.push({ kind: "lore", name: `${c.name} culture`, summary: clean(`${c.type || "A"} culture${where.length ? ` of ${listNames(where, 4)}` : ""}.`, MAX_SUMMARY_CHARS),
                fields: { details: [c.type && `Type: ${c.type}.`, where.length && `Dominant in ${listNames(where)}.`, c.expansionism && `Expansionism ${Number(c.expansionism).toFixed(1)}.`, legend(`culture${c.i}`)].filter(Boolean).join(" ") },
                tags: [...tag, "culture"], links: where.map(to => ({ to, type: "other", note: "culture" })) });
        }
        for (const r of religions) {
            entries.push({ kind: "lore", name: r.name, summary: clean(`${[r.type, String(r.form || "faith").toLowerCase()].filter(Boolean).join(" ")}${r.deity ? `, worshipping ${r.deity}` : ""}.`, MAX_SUMMARY_CHARS),
                fields: { details: [r.type && `Type: ${r.type}.`, r.form && `Form: ${r.form}.`, r.deity && `Deity: ${r.deity}.`, cultureName(r.culture) && `Began among the ${cultureName(r.culture)}.`, legend(`religion${r.i}`)].filter(Boolean).join(" ") },
                tags: [...tag, "religion"] });
        }
        // Routes: each road, trail or sea route that joins two or more of the cities.
        if (options.includeRoutes !== false && Array.isArray(pack.routes) && pack.routes.length) {
            const cellBurg = new Map(burgsAll.filter(b => Number.isFinite(b.cell)).map(b => [b.cell, b]));
            const lines = [];
            for (const r of pack.routes) {
                if (!r || !Array.isArray(r.points)) continue;
                const stops = [];
                for (const pt of r.points) { const b = cellBurg.get(Array.isArray(pt) ? pt[2] : pt); if (b && stops[stops.length - 1] !== b.name) stops.push(b.name); }
                if (stops.length >= 2) lines.push(`- ${r.name ? `${r.name} ` : ""}(${r.group || "route"}): ${stops.join(" → ")}`);
            }
            if (lines.length) entries.push({ kind: "lore", name: `Routes of ${name}`, summary: `${lines.length} roads, trails and sea routes between cities.`, fields: { details: clean(lines.join("\n"), MAX_FIELD_CHARS) }, tags: [...tag, "routes"] });
        }
        const era = settings.options || data.options || {};
        entries.push({ kind: "lore", name: `Map of ${name}`, summary: clean(`The world map from Azgaar's Fantasy Map Generator${era.year ? `, year ${era.year}${era.era ? ` of the ${era.era}` : ""}` : ""}.`, MAX_SUMMARY_CHARS),
            fields: { details: [`${states.length} states, ${provincesAll.length} provinces, ${burgsAll.length} cities, ${cultures.length} cultures, ${religions.length} religions.`, info.seed && `Seed ${info.seed}.`, width && `Map size ${width}×${height}.`,
                burgsAll.length > burgs.length && `Imported the ${burgs.length} largest cities and every capital; the full map has ${burgsAll.length}.`].filter(Boolean).join(" ") }, tags: [...tag, "map"] });
        // Links point at names as the entries were finally called.
        const names = new Set(entries.map(e => e.name.toLowerCase()));
        for (const e of entries) { e.links = (e.links || []).filter(l => names.has(String(l.to).toLowerCase())).slice(0, MAX_LINKS); if (!e.links.length) delete e.links; }
        return { name, entries, stats: { states: states.length, provinces: provinces.length, burgs: burgs.length, allBurgs: burgsAll.length, cultures: cultures.length, religions: religions.length } };
    }

    // ---------- StoryCraftr ----------
    // StoryCraftr (github.com/raestrada/storycraftr) reads every .md in a book folder as
    // context, and keeps its worldbuilding and outline in these files.

    const STORYCRAFTR_FILES = {
        "worldbuilding/geography.md": { title: "Geography", kinds: ["location"] },
        "worldbuilding/history.md": { title: "History", kinds: ["event"] },
        "worldbuilding/culture.md": { title: "Culture", kinds: ["faction"], lore: /cultur|religio|custom|tradition|people/i },
        "worldbuilding/magic_system.md": { title: "Magic system", kinds: ["ability"], lore: /magic|power|energy|continuum|ability/i },
        "worldbuilding/technology.md": { title: "Technology", kinds: ["item"], lore: /tech|machine|weapon|armou?r|device|science/i },
        "outline/character_summary.md": { title: "Character summary", kinds: ["character"] },
        "outline/plot_points.md": { title: "Plot points", kinds: ["arc", "quest"] }
    };

    function entrySection(e) {
        const kind = KINDS[e.kind] || KINDS.lore;
        const out = [`## ${e.name}`, ""];
        if (e.summary) out.push(e.summary, "");
        for (const [k, v] of Object.entries(e.fields || {})) out.push(`**${fieldLabel(e.kind, k)}:** ${v}`, "");
        if (e.links && e.links.length) out.push(`**Relationships:** ${e.links.map(l => `${linkTypeLabel(l.type)} of ${l.name}${l.note ? ` (${l.note})` : ""}`).join("; ")}`, "");
        if (e.beats && e.beats.length) out.push(...e.beats.map((b, i) => `${i + 1}. ${b.text}`), "");
        return out.join("\n");
    }

    function toStoryCraftr(p, folder = "") {
        const base = String(folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        const at = name => base ? `${base}/${name}` : name;
        const files = {};
        const used = new Set();
        const head = title => `# ${title}\n\n<!-- From CoDev's Story Studio (${p.name}). Canon: edit it in Story Studio and export again. -->\n\n`;
        for (const [file, spec] of Object.entries(STORYCRAFTR_FILES)) {
            const list = p.entries.filter(e => !used.has(e) && (spec.kinds.includes(e.kind) || (spec.lore && e.kind === "lore" && spec.lore.test(`${e.name} ${(e.tags || []).join(" ")}`))));
            const ordered = spec.kinds.includes("event") ? Studio.timelineOrder(list) : list;
            if (!ordered.length) continue;
            ordered.forEach(e => used.add(e));
            files[at(file)] = head(spec.title) + ordered.map(entrySection).join("\n").trim() + "\n";
        }
        const rest = p.entries.filter(e => !used.has(e) && e.kind === "lore");
        if (rest.length) files[at("worldbuilding/codev_lore.md")] = head("Lore") + rest.map(entrySection).join("\n").trim() + "\n";
        if (p.pitch) files[at("outline/general_outline.md")] = head("General outline") + p.pitch + "\n";
        return files;
    }

    // What StoryCraftr wrote, back into the bible as lore (one entry per file), so agents
    // and the lore check see it. Files CoDev made itself are skipped.
    function fromStoryCraftr(files) {
        const entries = [];
        for (const f of files || []) {
            const rel = String(f.path || "").replace(/\\/g, "/");
            const m = rel.match(/(?:^|\/)(worldbuilding|outline)\/([^/]+)\.md$/i);
            if (!m || typeof f.text !== "string") continue;
            const body = f.text.replace(/^#\s+.*\n/, "").trim();
            if (!body || /From CoDev's Story Studio/.test(f.text.slice(0, 400)) || body.length < 20) continue;
            const title = m[2].replace(/[_-]+/g, " ").replace(/^\w/, c => c.toUpperCase());
            entries.push({ kind: "lore", name: `StoryCraftr: ${title}`, summary: clean(body.split(/\n\s*\n/)[0].replace(/[#*_>]/g, ""), MAX_SUMMARY_CHARS),
                fields: { details: clean(body, MAX_FIELD_CHARS) }, tags: ["storycraftr", m[1].toLowerCase()] });
        }
        return { entries };
    }

    // ---------- Lore for art prompts ----------

    function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    function namesOf(e) {
        return [e.name, ...String((e.fields && e.fields.aliases) || "").split(/\s*,\s*/)].map(n => String(n || "").trim()).filter(n => n.length >= 3);
    }

    // The entries a brief names, most specific (longest name) first.
    function loreMatches(entries, text, kinds = ["character", "item", "location", "faction", "ability"]) {
        const t = String(text || "");
        const hits = [];
        for (const e of entries || []) {
            if (kinds && !kinds.includes(e.kind)) continue;
            const name = namesOf(e).find(n => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "iu").test(t));
            if (name) hits.push({ entry: e, name });
        }
        return hits.sort((a, b) => b.name.length - a.name.length).map(h => h.entry);
    }

    // How it looks, in a few words: appearance for characters, description for the rest.
    function lookFor(e, max = 320) {
        const f = e.fields || {};
        const look = f.appearance || f.visual || f.look || f.colors || f.colours || (e.kind !== "character" ? f.description : "") || "";
        const palette = f.palette || f.map_color || "";
        return clean([look, palette && `palette ${palette}`].filter(Boolean).join(", ").replace(/\s+/g, " "), max);
    }

    return {
        readFrontMatter, writeFrontMatter, toObsidianVault, parseVault, fromAzgaar, toStoryCraftr, fromStoryCraftr,
        loreMatches, lookFor, linkTypeFrom, kindFromWord, noteName, STORYCRAFTR_FILES
    };
});
