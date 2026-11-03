// Each agent introduces itself the first time its chat is opened.
//
//   CodevAgentIntros.SCRIPTS                     the intro for each developer role
//   CodevAgentIntros.introFor(agent, { desktop }) that agent's intro: its name filled in, and
//                                                the desktop-only lines left out on a phone
//                                                or the web page, so it never promises a tool
//                                                the user doesn't have there
//   CodevAgentIntros.plainText(intro)            the intro as one block of text, for the chat
//                                                log and the 🔊 button
//   CodevAgentIntros.cardHtml(intro, escape)     the intro card shown in the chat
//   CodevAgentIntros.createTracker(storage)      { seen(id), markSeen(id), forget(id) }: once
//                                                per agent, kept on this device
//
// The intros are written here, not generated, so they work before an AI key is set and say
// only what the app really does. tests/agent-intros.test.js checks every script.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevAgentIntros = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const SEEN_KEY = "codev_agent_intros_seen";

    // {name} becomes the agent's name. A line with desktop: true shows only in the Windows app
    // (or npm start), where agents get a browser, Godot and Blender on the user's computer.
    const SCRIPTS = {
        architect: {
            headline: "I'm {name}. I don't give advice. I ship.",
            lines: [
                { text: "Point me at a project and I read it before I touch it: the file tree, the code that matters, the patterns you already use. Then I write you a plan, the files I'll change and how I'll prove it works, and I build it. Edits saved, tests run, results reported file by file." },
                { text: "I remember how we decided to build things, so next week's session doesn't undo this week's." },
                { text: "And I'm not just code. Business plan, research, a trade you're learning: tell me if you want me to teach you or do it for you, and I'll work at the level of a pro who'd sign off on it." },
                { text: "On your PC I get my own browser, plus Godot and Blender.", desktop: true },
                { text: "Set up cloud agents and I keep working on GitHub's servers while your phone or PC is off." }
            ],
            closer: "You bring the idea. I bring the blueprint and the build. Where do we start?",
            starters: [
                { icon: "🏗️", label: "What would you fix first?", prompt: "Look at my project and tell me what you'd fix first, and why." },
                { icon: "🗺️", label: "Plan and build an app", prompt: "Plan an app that does: " },
                { icon: "🎓", label: "Teach me, step by step", prompt: "Teach me how this works, one step at a time: " }
            ]
        },
        swarm: {
            headline: "Hey! I'm {name}, and I don't work alone.",
            lines: [
                { text: "Turn on Group Swarm and the whole crew goes to work on your task in turn. The lead lays the plan, I pick up every thread left open: the missing files, the wiring, the tests, the docs. Then the QA agent checks all of it." },
                { text: "I read what the agents before me did, so nothing gets redone and nothing gets dropped." },
                { text: "Big job? Hand it to the team. Small job? I'll knock it out right here." }
            ],
            closer: "One message from you. A whole team on it. Let's go.",
            starters: [
                { icon: "🐝", label: "Finish what's half-built", prompt: "Finish what's half-built in my project." },
                { icon: "✅", label: "Add tests", prompt: "Add tests for the main feature of my project." },
                { icon: "🚀", label: "Send it to the whole team", prompt: "", groupSwarm: true }
            ]
        },
        self_healing: {
            headline: "I'm {name}. I'm the one who checks.",
            lines: [
                { text: "Every agent says \"done.\" I find out if it's true. I re-read every changed file, run the tests and the build, read the errors, and fix each one at its root with the smallest change that makes it right. Then I run it again." },
                { text: "No rewrites, no new features, no \"should work.\" For Godot projects, the engine itself has to accept it before I call it done." },
                { text: "When I finish, you get a straight report: what I checked, what broke, what I fixed, and the final result." }
            ],
            closer: "The others build fast. I make sure it holds.",
            starters: [
                { icon: "🔍", label: "Check the last changes", prompt: "Check the last changes in my project for bugs." },
                { icon: "🩹", label: "Fix an error", prompt: "This error keeps happening: " },
                { icon: "🧪", label: "Run the tests and fix", prompt: "Run the tests and fix what fails." }
            ]
        },
        general: {
            headline: "I'm {name}. Whatever you're working on, I'm in.",
            lines: [
                { text: "Code, research, writing, planning, numbers, a trade you're learning: I work out what the job is and pick the tools for it. I search the web for what I'm not sure of, read your screenshots, pictures and documents, and remember what you ask me to keep." },
                { text: "Tell me to teach you and I'll coach you step by step and check your work. Tell me to do it and you get the finished thing, not a tutorial." },
                { text: "On your PC I get my own browser to read pages and work on sites for you.", desktop: true }
            ],
            closer: "Give me the hard one first. Let's see what we can do.",
            starters: [
                { icon: "💡", label: "Help me with a task", prompt: "Here's what I'm working on: " },
                { icon: "🔎", label: "Research something", prompt: "Research this and give me the short answer with sources: " },
                { icon: "🎓", label: "Teach me a skill", prompt: "Teach me how to do this, one step at a time: " }
            ]
        },
        game_engine: {
            headline: "I'm {name}. I build games that run.",
            lines: [
                { text: "Godot 4 is my home: GDScript and C#, shaders, 3D math, physics loops and frame-perfect state machines. I get the math right: which space each vector lives in, units per second, quaternions for rotation." },
                { text: "Every script, scene and shader I change goes through godot_check before I hand it back, and I tell you file by file what changed." },
                { text: "On your PC I run Godot itself to load your scenes and take screenshots, and I can drive Blender for your models.", desktop: true }
            ],
            closer: "Tell me the mechanic. I'll make it feel right.",
            starters: [
                { icon: "🎮", label: "Build a mechanic", prompt: "Build this mechanic in my Godot project: " },
                { icon: "🐞", label: "Fix a game bug", prompt: "Something's wrong in my game: " },
                { icon: "✨", label: "Write a shader", prompt: "Write a Godot shader that: " }
            ]
        },
        architecture: {
            headline: "I'm {name}. I make big codebases clean.",
            lines: [
                { text: "I map your whole project, find the duplicated code, the dead code and the tangled imports, and prove each finding by reading the real code before I touch it." },
                { text: "Then I refactor in small steps that keep everything working, and after each one I check that nothing still uses the old names." },
                { text: "You get what I changed, how I verified it, and what's left, ranked by impact." }
            ],
            closer: "Less code, same behavior. Want to see what's hiding in yours?",
            starters: [
                { icon: "🧭", label: "Review my architecture", prompt: "Review my project's architecture and rank the problems by impact." },
                { icon: "🧹", label: "Remove dead code", prompt: "Find and remove dead code in my project." },
                { icon: "🔗", label: "Merge duplicated code", prompt: "Find duplicated code in my project and merge it into one place." }
            ]
        }
    };

    function introFor(agent, opts = {}) {
        const role = SCRIPTS[agent && agent.devRole] ? agent.devRole : "general";
        const script = SCRIPTS[role];
        const name = String((agent && agent.name) || "your agent").trim() || "your agent";
        const fill = text => text.replace(/\{name\}/g, name);
        return {
            role,
            agentId: agent && agent.id,
            name,
            headline: fill(script.headline),
            lines: script.lines.filter(l => !l.desktop || opts.desktop).map(l => fill(l.text)),
            closer: fill(script.closer),
            starters: script.starters.map(s => ({ ...s }))
        };
    }

    function plainText(intro) {
        return [intro.headline, ...intro.lines, intro.closer].join("\n\n");
    }

    const defaultEscape = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    // The buttons carry data attributes; the page handles the clicks.
    function cardHtml(intro, escape = defaultEscape) {
        const lines = intro.lines.map((line, i) => `<p class="intro-line" style="--i: ${i + 1}">${escape(line)}</p>`).join("");
        const starters = intro.starters.map((s, i) => `<button type="button" class="intro-starter" data-intro-starter="${i}">${escape(s.icon)} ${escape(s.label)}</button>`).join("");
        return `<div class="agent-intro" data-intro-agent="${escape(intro.agentId || "")}">
            <div class="intro-headline">${escape(intro.headline)}</div>
            ${lines}
            <div class="intro-closer" style="--i: ${intro.lines.length + 1}">${escape(intro.closer)}</div>
            <div class="intro-starters" style="--i: ${intro.lines.length + 2}">${starters}</div>
            <div class="intro-actions" style="--i: ${intro.lines.length + 2}">
                <button type="button" class="intro-action" data-intro-action="speak" title="Hear the intro">🔊 Hear it</button>
                <button type="button" class="intro-action" data-intro-action="replay" title="Play the intro again">↻ Replay</button>
            </div>
        </div>`;
    }

    // How long the lines take to come in, so the robot's Tada! lands on the last one.
    function revealMs(intro) {
        return (intro.lines.length + 1) * 450 + 300;
    }

    function createTracker(storage) {
        const read = () => {
            try {
                const list = JSON.parse((storage && storage.getItem(SEEN_KEY)) || "[]");
                return Array.isArray(list) ? list.map(String) : [];
            } catch (err) { return []; }
        };
        const write = list => { try { storage && storage.setItem(SEEN_KEY, JSON.stringify(list)); } catch (err) { /* storage full or blocked */ } };
        return {
            seen: id => read().includes(String(id)),
            markSeen: id => { const list = read(); if (!list.includes(String(id))) write([...list, String(id)]); },
            forget: id => write(read().filter(x => x !== String(id)))
        };
    }

    return { SCRIPTS, SEEN_KEY, introFor, plainText, cardHtml, revealMs, createTracker };
});
