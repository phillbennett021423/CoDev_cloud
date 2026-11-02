// Agents and Azgaar's Fantasy Map Generator (free, MIT): map_read answers questions
// about a map's full JSON export (states, cities, provinces, cultures, religions,
// markers, and travel by road or sea between two cities), and map_generate makes a
// new map from a seed on the computer (desktop/azgaar-map.js) and saves its export in
// the project folder. To bring a map into a game's story bible, agents use
// studio_import with source "azgaar" (lore-bridges.js).
//
// The same file runs in the page and in Node (tests).
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevAzgaarMaps = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const MAP_TOOL_NAMES = ["map_read", "map_generate"];
    const GENERATOR_URL = "https://azgaar.github.io/Fantasy-Map-Generator/";
    // A request that's about maps or worlds gets the map tools; others don't pay for them.
    const MAP_TASK = /\b(azgaar|fantasy map|maps?|world ?build\w*|kingdoms?|realms?|continents?|provinces?|burgs?|cities|city|towns?|empires?|states?|cultures?|religions?|trade routes?|roads?)\b/i;

    const live = list => (Array.isArray(list) ? list : []).filter(x => x && typeof x === "object" && !x.removed);
    const round = n => Math.round(Number(n) || 0);
    const fmt = n => round(n).toLocaleString("en-US");
    const clean = s => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const lower = s => String(s || "").toLowerCase();

    function clampInt(value, min, max, fallback) {
        const n = Math.floor(Number(value));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    // The map from its full JSON export, with the numbers people read: population as
    // the generator shows it, and distances in the map's own unit.
    function loadMap(text) {
        if (/^\s*[\d.]+\|/.test(String(text).slice(0, 200))) return { error: "That's an Azgaar .map save file. In the generator, open Menu > Export > Export to JSON > Full, and use that .json file." };
        let data;
        try { data = typeof text === "string" ? JSON.parse(text) : text; } catch (err) { return { error: "That isn't an Azgaar JSON export (Menu > Export > Export to JSON > Full)." }; }
        const pack = data && (data.pack || data);
        if (!pack || !Array.isArray(pack.states)) return { error: "That JSON has no states, so it isn't a full Azgaar export. Use Export to JSON > Full." };
        const s = data.settings || {};
        const rate = Number(s.populationRate) || 1000;
        const urban = Number(s.urbanization) || 1;
        return {
            data, pack,
            name: clean((data.info && data.info.mapName) || s.mapName || "Azgaar map"),
            seed: data.info && data.info.seed,
            year: s.options && s.options.year, era: s.options && s.options.era,
            unit: s.distanceUnit || "mi", scale: Number(s.distanceScale) || 1,
            people: { burg: p => round(Number(p) * rate * urban), rural: p => round(Number(p) * rate), urban: p => round(Number(p) * rate * urban) },
            states: live(pack.states), burgs: live(pack.burgs).filter(b => b.i), provinces: live(pack.provinces).filter(p => p.i),
            cultures: live(pack.cultures), religions: live(pack.religions), markers: live(pack.markers), routes: Array.isArray(pack.routes) ? pack.routes.filter(r => r && !r.removed) : [],
            notes: Array.isArray(data.notes) ? data.notes : []
        };
    }

    const byId = (list, id) => list.find(x => x.i === id);
    function findNamed(list, name) {
        const want = lower(name).trim();
        if (!want) return null;
        return list.find(x => lower(x.name) === want) || list.find(x => lower(x.fullName) === want)
            || list.find(x => lower(x.name).startsWith(want)) || list.find(x => lower(x.name).includes(want) || lower(x.fullName).includes(want)) || null;
    }
    const statePeople = (m, st) => (m.people.rural(st.rural) + m.people.urban(st.urban));
    const stateName = (m, id) => { const st = byId(m.states, id); return st ? (st.i ? st.name : "no state") : "?"; };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    function overview(m) {
        const states = m.states.filter(s => s.i).sort((a, b) => statePeople(m, b) - statePeople(m, a));
        const lines = [`Map: ${m.name}${m.seed ? ` (seed ${m.seed})` : ""}${m.year ? `, year ${m.year}${m.era ? ` of the ${m.era}` : ""}` : ""}.`,
            `${states.length} states, ${m.provinces.length} provinces, ${m.burgs.length} cities and towns, ${m.cultures.filter(c => c.i).length} cultures, ${m.religions.filter(r => r.i).length} religions, ${m.routes.length} routes, ${m.markers.length} markers.`, "", "States (largest first):"];
        for (const st of states.slice(0, 30)) {
            const cap = byId(m.burgs, st.capital);
            lines.push(`- ${st.fullName || st.name} (${st.form || "state"}): capital ${cap ? cap.name : "none"}, ${fmt(statePeople(m, st))} people, ${m.burgs.filter(b => b.state === st.i).length} towns, ${(st.provinces || []).length} provinces`);
        }
        if (states.length > 30) lines.push(`… and ${states.length - 30} more.`);
        lines.push("", "Ask map_read for one state, city, province, culture or religion by name, list cities, or a route between two cities.");
        return lines.join("\n");
    }

    function stateInfo(m, name) {
        const st = findNamed(m.states.filter(s => s.i), name);
        if (!st) return `No state named "${name}". States: ${m.states.filter(s => s.i).map(s => s.name).join(", ")}.`;
        const cap = byId(m.burgs, st.capital);
        const relations = {};
        (st.diplomacy || []).forEach((rel, id) => { if (id && id !== st.i && rel && rel !== "x" && byId(m.states, id)) (relations[rel] = relations[rel] || []).push(byId(m.states, id).name); });
        const towns = m.burgs.filter(b => b.state === st.i).sort((a, b) => b.population - a.population);
        const provs = (st.provinces || []).map(id => byId(m.provinces, id)).filter(Boolean);
        return [`${st.fullName || st.name} (${st.form || "state"}${st.type ? `, ${st.type}` : ""})`,
            `Capital: ${cap ? cap.name : "none"} · People: ${fmt(statePeople(m, st))} (${fmt(m.people.urban(st.urban))} in towns) · Towns: ${towns.length}`,
            `Culture: ${(byId(m.cultures, st.culture) || {}).name || "?"}`,
            `Borders: ${(st.neighbors || []).map(id => stateName(m, id)).filter(n => n && n !== "no state").join(", ") || "none"}`,
            ...Object.entries(relations).map(([rel, names]) => `${rel}: ${names.join(", ")}`),
            st.campaigns && st.campaigns.length ? `Wars: ${st.campaigns.map(c => `${c.name} (${c.start}${c.end ? `-${c.end}` : ""})`).join("; ")}` : "",
            `Provinces: ${provs.map(p => p.name).join(", ") || "none"}`,
            `Largest towns: ${towns.slice(0, 12).map(b => `${b.name} (${fmt(m.people.burg(b.population))})`).join(", ")}`,
            noteFor(m, `state${st.i}`)].filter(Boolean).join("\n");
    }

    function burgInfo(m, name) {
        const b = findNamed(m.burgs, name);
        if (!b) return `No city or town named "${name}". Try map_read action cities to list them.`;
        const prov = m.provinces.find(p => p.burg === b.i) || m.provinces.find(p => (p.burgs || []).includes(b.i));
        const roads = m.routes.filter(r => (r.points || []).some(p => p[2] === b.cell));
        const near = m.burgs.filter(x => x !== b).map(x => [x, dist(x, b)]).sort((x, y) => x[1] - y[1]).slice(0, 5);
        const features = ["capital", "port", "citadel", "walls", "plaza", "temple", "shanty"].filter(k => b[k]).map(k => (k === "port" ? "port" : k === "capital" ? "capital" : k === "plaza" ? "market square" : k === "shanty" ? "shanty town" : k));
        return [`${b.name}${b.capital ? ` (capital of ${stateName(m, b.state)})` : ""}`,
            `State: ${stateName(m, b.state)}${prov ? ` · Province: ${prov.name}` : ""} · Culture: ${(byId(m.cultures, b.culture) || {}).name || "?"}`,
            `People: ${fmt(m.people.burg(b.population))}${b.group ? ` · Size: ${b.group}` : ""}${b.type ? ` · Type: ${b.type}` : ""}`,
            features.length ? `Has: ${features.join(", ")}` : "",
            `Map position: x ${round(b.x)}, y ${round(b.y)}`,
            roads.length ? `On ${roads.length} route${roads.length === 1 ? "" : "s"}: ${[...new Set(roads.map(r => r.name || r.group))].join(", ")}` : "No roads or sea routes.",
            `Nearest: ${near.map(([x, d]) => `${x.name} (${fmt(d * m.scale)} ${m.unit})`).join(", ")}`,
            noteFor(m, `burg${b.i}`)].filter(Boolean).join("\n");
    }

    function noteFor(m, id) {
        const note = m.notes.find(n => n && n.id === id);
        return note && clean(note.legend) ? `Note: ${clean(note.legend).slice(0, 600)}` : "";
    }

    function cities(m, { state, max, query }) {
        let list = m.burgs;
        if (state) {
            const st = findNamed(m.states.filter(s => s.i), state);
            if (!st) return `No state named "${state}".`;
            list = list.filter(b => b.state === st.i);
        }
        if (query) list = list.filter(b => lower(b.name).includes(lower(query)));
        list = list.slice().sort((a, b) => b.population - a.population);
        const limit = clampInt(max, 1, 100, 25);
        return `${list.length} cities and towns${state ? ` in ${state}` : ""}${query ? ` matching "${query}"` : ""}, largest first:\n`
            + list.slice(0, limit).map(b => `- ${b.name}${b.capital ? " (capital)" : ""}${b.port ? " (port)" : ""}: ${fmt(m.people.burg(b.population))}, ${stateName(m, b.state)}`).join("\n")
            + (list.length > limit ? `\n… ${list.length - limit} more.` : "");
    }

    function groupInfo(m, kind, name) {
        const list = (kind === "culture" ? m.cultures : kind === "religion" ? m.religions : m.provinces).filter(x => x.i);
        if (!name) return `${list.length} ${kind === "province" ? "provinces" : `${kind}s`}: ${list.map(x => x.name).join(", ")}.`;
        const x = findNamed(list, name);
        if (!x) return `No ${kind} named "${name}".`;
        if (kind === "province") {
            const cap = byId(m.burgs, x.burg);
            const towns = m.burgs.filter(b => (x.burgs || []).includes(b.i));
            return [`${x.fullName || x.name} (province of ${stateName(m, x.state)})`, `Capital: ${cap ? cap.name : "none"}`, towns.length ? `Towns: ${towns.map(b => b.name).join(", ")}` : "", noteFor(m, `province${x.i}`)].filter(Boolean).join("\n");
        }
        const field = kind === "culture" ? "culture" : null;
        const states = field ? m.states.filter(s => s.i && s.culture === x.i).map(s => s.name) : [];
        return [`${x.name} (${kind}${x.type ? `, ${x.type}` : ""}${x.form ? `, ${x.form}` : ""})`,
            x.deity ? `Deity: ${x.deity}` : "",
            kind === "religion" && x.culture ? `First held by the ${(byId(m.cultures, x.culture) || {}).name || "?"} culture` : "",
            x.origins && x.origins.filter(Boolean).length ? `Comes from: ${x.origins.filter(Boolean).map(id => (byId(kind === "culture" ? m.cultures : m.religions, id) || {}).name).filter(Boolean).join(", ")}` : "",
            states.length ? `States of this culture: ${states.join(", ")}` : "",
            x.rural || x.urban ? `People: ${fmt(m.people.rural(x.rural) + m.people.urban(x.urban))}` : ""].filter(Boolean).join("\n");
    }

    // Travel between two cities over the map's roads, trails and sea routes: the
    // shortest way through the route network (Dijkstra over the routes' points),
    // and the straight-line distance.
    function route(m, from, to) {
        const a = findNamed(m.burgs, from), b = findNamed(m.burgs, to);
        if (!a || !b) return `No city or town named "${!a ? from : to}".`;
        const straight = dist(a, b) * m.scale;
        const edges = new Map(), pos = new Map(), groupOf = new Map();
        const link = (u, v, w, g) => { if (!edges.has(u)) edges.set(u, []); edges.get(u).push([v, w, g]); };
        for (const r of m.routes) {
            const pts = (r.points || []).filter(p => Array.isArray(p) && p.length >= 3);
            for (let i = 0; i < pts.length; i++) {
                pos.set(pts[i][2], pts[i]);
                if (!i) continue;
                const w = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
                link(pts[i - 1][2], pts[i][2], w, r.group || "route");
                link(pts[i][2], pts[i - 1][2], w, r.group || "route");
                groupOf.set(`${pts[i - 1][2]}-${pts[i][2]}`, r.group); groupOf.set(`${pts[i][2]}-${pts[i - 1][2]}`, r.group);
            }
        }
        const head = `${a.name} → ${b.name}: ${fmt(straight)} ${m.unit} in a straight line.`;
        if (!edges.has(a.cell) || !edges.has(b.cell)) return `${head}\n${!edges.has(a.cell) ? a.name : b.name} isn't on any road or sea route, so there's no route to follow.`;
        const best = new Map([[a.cell, 0]]), prev = new Map(), done = new Set();
        const queue = [[0, a.cell]];
        while (queue.length) {
            queue.sort((x, y) => x[0] - y[0]);
            const [d, u] = queue.shift();
            if (done.has(u)) continue;
            done.add(u);
            if (u === b.cell) break;
            for (const [v, w] of edges.get(u) || []) {
                const nd = d + w;
                if (nd < (best.has(v) ? best.get(v) : Infinity)) { best.set(v, nd); prev.set(v, u); queue.push([nd, v]); }
            }
        }
        if (!best.has(b.cell)) return `${head}\nThe routes don't connect them (different islands, or no road between).`;
        const path = [b.cell];
        while (path[0] !== a.cell) path.unshift(prev.get(path[0]));
        const kinds = {};
        for (let i = 1; i < path.length; i++) {
            const g = groupOf.get(`${path[i - 1]}-${path[i]}`) || "route";
            const p = pos.get(path[i]), q = pos.get(path[i - 1]);
            kinds[g] = (kinds[g] || 0) + Math.hypot(p[0] - q[0], p[1] - q[1]) * m.scale;
        }
        const cellBurg = new Map(m.burgs.map(x => [x.cell, x]));
        const via = path.slice(1, -1).map(c => cellBurg.get(c)).filter(Boolean).map(x => x.name);
        return [head, `By the routes: ${fmt(best.get(b.cell) * m.scale)} ${m.unit} (${Object.entries(kinds).map(([g, d]) => `${fmt(d)} ${m.unit} by ${g}`).join(", ")}).`,
            via.length ? `Through: ${via.join(", ")}` : "No towns in between."].join("\n");
    }

    function markers(m, query) {
        let list = m.markers;
        if (query) list = list.filter(x => lower(x.name).includes(lower(query)) || lower(x.type).includes(lower(query)));
        if (!list.length) return `No markers${query ? ` matching "${query}"` : ""}.`;
        return list.slice(0, 40).map(x => `- ${x.name || x.type}${x.type && x.name ? ` (${x.type})` : ""} at x ${round(x.x)}, y ${round(x.y)}${noteFor(m, `marker${x.i}`) ? `: ${noteFor(m, `marker${x.i}`).slice(6, 200)}` : ""}`).join("\n");
    }

    function queryMap(m, args) {
        switch (String(args.action || "overview")) {
            case "overview": return overview(m);
            case "state": return stateInfo(m, args.name);
            case "city": return burgInfo(m, args.name);
            case "cities": return cities(m, { state: args.state, max: args.max, query: args.name });
            case "province": return groupInfo(m, "province", args.name);
            case "culture": return groupInfo(m, "culture", args.name);
            case "religion": return groupInfo(m, "religion", args.name);
            case "route": return route(m, args.from, args.to);
            case "markers": return markers(m, args.name);
            default: return "Unknown action. Use overview, state, city, cities, province, culture, religion, route or markers.";
        }
    }

    // ---- The tools -----------------------------------------------------------

    // readFile(path) -> text|null: a file in the project folder. listJson() -> paths of
    // .json files there (to find maps). generate(req) -> { json, seed, name, link } | { error },
    // or null where maps can't be made here. saveFile(path, text) -> message.
    // confirm(message) -> bool.
    function createAzgaarTools({ readFile, listJson = async () => [], generate = null, saveFile = null, confirm = async () => false }) {
        const cache = new Map();

        async function open(path) {
            path = String(path || "").trim();
            if (!path) {
                const found = [];
                for (const p of await listJson()) {
                    if (/azgaar|map/i.test(p)) found.push(p);
                }
                if (found.length === 1) path = found[0];
                else return { error: found.length ? `Which map? Maps in the project folder: ${found.join(", ")}.` : "Give the map's .json file path in the project folder (Azgaar: Menu > Export > Export to JSON > Full), or make one with map_generate." };
            }
            if (cache.has(path)) return cache.get(path);
            const text = await readFile(path);
            if (text === null || text === undefined) return { error: `There's no ${path} in the project folder.` };
            const m = loadMap(text);
            if (!m.error) { m.path = path; cache.set(path, m); }
            return m;
        }

        async function mapRead(args) {
            const m = await open(args.map);
            if (m.error) return m.error;
            return `[${m.path}] ${queryMap(m, args)}`;
        }

        async function mapGenerate({ seed, width, height, path }) {
            if (!generate) return `Maps can only be made by CoDev on a computer (the Windows app, or start-codev.bat / npm start). Here, make one at ${GENERATOR_URL}, export it with Menu > Export > Export to JSON > Full, and put the file in the project folder.`;
            if (!(await confirm(`An agent wants to make a new fantasy map with Azgaar's Fantasy Map Generator${seed ? ` from the seed "${seed}"` : ""} and save it in your project folder. This opens the generator's website in a hidden browser for up to 3 minutes. Make it?`))) return "The user said no.";
            const made = await generate({ seed, width, height });
            if (!made || made.error) return `The map wasn't made: ${(made && made.error) || "no answer"}`;
            const safe = String(made.name || "map").replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "map";
            const target = String(path || `maps/${safe}-${made.seed}.json`).replace(/\\/g, "/");
            const saved = saveFile ? await saveFile(target, made.json) : "not saved";
            cache.delete(target);
            const m = loadMap(made.json);
            if (!m.error) { m.path = target; cache.set(target, m); }
            return [`Made the map "${made.name}" from seed ${made.seed} (the same seed always makes the same map). ${saved}`,
                `Open it in the generator: ${made.link}`, "", m.error ? m.error : overview(m), "",
                `To bring it into a game's story bible, use studio_import with source "azgaar" and path "${target}".`].join("\n");
        }

        const TOOLS = {
            map_read: {
                description: "Answer questions about a fantasy map from Azgaar's Fantasy Map Generator (its full JSON export in the project folder): overview; one state (capital, people, borders, allies, enemies, wars, provinces), city, province, culture or religion by name; cities (largest first, by state); markers; and route, the distance and towns between two cities over the map's roads and sea routes. Use it when the user asks about their world map or where things are in it; don't guess places the map doesn't have. For their story's characters and lore use the story tools instead.",
                inputSchema: { type: "object", properties: {
                    map: { type: "string", description: "The map's .json path in the project folder, like maps/continuum.json. Leave it out if there's only one." },
                    action: { type: "string", enum: ["overview", "state", "city", "cities", "province", "culture", "religion", "route", "markers"], description: "Default overview." },
                    name: { type: "string", description: "The state, city, province, culture or religion to look up (cities and markers: a filter)." },
                    state: { type: "string", description: "cities: only this state's." },
                    from: { type: "string", description: "route: the starting city." }, to: { type: "string", description: "route: the destination city." },
                    max: { type: "integer", description: "cities: how many (default 25)." }
                } }, run: mapRead
            },
            map_generate: {
                description: "Make a new fantasy world map with Azgaar's Fantasy Map Generator (states, provinces, cities, cultures, religions, rivers, roads) from a seed, save its full JSON export in the project folder, and describe it. The same seed always makes the same map; a word works as a seed. Asks the user first. Use it only when the user asks for a new map; to answer questions about a map they already have, use map_read instead.",
                inputSchema: { type: "object", properties: {
                    seed: { type: "string", description: "Optional: a number or word. Leave out for a random map." },
                    width: { type: "integer", description: "Optional: map width in pixels (default 1920)." },
                    height: { type: "integer", description: "Optional: map height in pixels (default 1080)." },
                    path: { type: "string", description: "Optional: where to save it in the project folder (default maps/<name>-<seed>.json)." }
                } }, run: mapGenerate
            }
        };

        function buildTools() {
            return MAP_TOOL_NAMES.map(name => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema, run: (args, ctx) => TOOLS[name].run(args || {}, ctx) }));
        }

        function describe(name, args) {
            args = args || {};
            if (name === "map_read") return `🗺️ Reading the map${args.action && args.action !== "overview" ? `: ${args.action}${args.name ? ` ${args.name}` : args.from ? ` ${args.from} → ${args.to}` : ""}` : ""}`;
            if (name === "map_generate") return `🗺️ Making a fantasy map${args.seed ? ` (seed ${args.seed})` : ""} (asks you first)`;
            return null;
        }

        return { buildTools, describe, TOOLS, forget: () => cache.clear() };
    }

    const isMapTask = text => MAP_TASK.test(String(text || ""));

    return { MAP_TOOL_NAMES, GENERATOR_URL, loadMap, queryMap, createAzgaarTools, isMapTask };
});
