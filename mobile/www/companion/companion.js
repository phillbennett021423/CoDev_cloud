/*
 * VortexCompanion: state machine for the workspace companion avatar.
 * Plays one of 20 animations at a time. Higher priority wins; ties go to the
 * most recent request. Idle loops only run when nothing else is active.
 * The 3D robot (robot3d.js) acts each one out; flat avatars get CSS transforms
 * on the picture plus overlay props.
 *
 * Start/end events are counted per source, so two agents searching at once keep
 * the search animation until both have sent search.end.
 */
(function (root) {
  'use strict';

  var IDLE_AFTER_MS = 120000; // quiet time before idle loops start
  var IDLE_MIN_MS = 25000;
  var IDLE_MAX_MS = 45000;
  // A looping source whose end event never arrives (a crash, a lost promise)
  // is dropped after this long, so the avatar can't get stuck on one state.
  var MAX_HOLD_MS = 10 * 60 * 1000;

  // The baby robot's 20 actions, in four groups. cls = the whole-figure move for flat
  // avatars; fx = overlay props shown for every avatar; prop = an emoji stand-in for
  // the hologram the 3D robot draws itself (flat avatars only).
  var ANIMATIONS = [
    // Celebration and dancing
    { id: 1, key: 'groove', name: 'The Little Groove Dance', cat: 'celebrate', prio: 60, cls: 'a-vibe', fx: 'notes', ms: 4000, idle: true },
    { id: 2, key: 'victory-spin', name: 'Victory Spin & Hover', cat: 'celebrate', prio: 75, cls: 'a-spin', fx: 'sparks', ms: 3400 },
    { id: 3, key: 'confetti', name: 'Confetti Celebration', cat: 'celebrate', prio: 72, cls: 'a-success', fx: 'confetti', prop: 'popper', ms: 3200 },
    { id: 4, key: 'happy-bounce', name: 'Happy Bounce', cat: 'celebrate', prio: 70, cls: 'a-success', fx: 'sparks', ms: 2600 },
    { id: 5, key: 'tada', name: 'The "Tada!" Pose', cat: 'celebrate', prio: 74, cls: 'a-flex', fx: 'sparks', prop: 'check', ms: 3200 },
    // Curious and playful
    { id: 6, key: 'tap-peek', name: 'Screen Tap & Peek', cat: 'curious', prio: 50, cls: 'a-search', prop: 'eyes', ms: null },
    { id: 7, key: 'butterfly-chase', name: 'Hologram Butterfly Chase', cat: 'curious', prio: 10, cls: 'a-toss', prop: 'butterfly', ms: 4600, idle: true },
    { id: 8, key: 'head-tilt', name: 'Head Tilt Curiosity', cat: 'curious', prio: 40, cls: 'a-gears', prop: 'question', ms: null },
    { id: 9, key: 'magnify', name: 'Magnifying Glass Inspection', cat: 'curious', prio: 50, cls: 'a-search', prop: 'magnifier', ms: null },
    { id: 10, key: 'peekaboo', name: 'Peek-a-Boo Shield', cat: 'curious', prio: 100, cls: 'a-error', fx: 'warning', ms: 5000 },
    // Work and task-running
    { id: 11, key: 'typing', name: 'Furious Tiny Typing', cat: 'work', prio: 50, cls: 'a-frenzy', fx: 'matrix', prop: 'keyboard', ms: null },
    { id: 12, key: 'heavy-lift', name: 'Heavy Lifting Struggle', cat: 'work', prio: 50, cls: 'a-weigh', prop: 'file', ms: null },
    { id: 13, key: 'bug-zap', name: 'Laser Bug Zap', cat: 'work', prio: 50, cls: 'a-blueprint', prop: 'bug', ms: null },
    { id: 14, key: 'drink-sip', name: 'Data Drink Sip', cat: 'work', prio: 40, cls: 'a-sip', prop: 'bottle', ms: 2800 },
    { id: 15, key: 'wrench', name: 'Wrench Tightening', cat: 'work', prio: 80, cls: 'a-frenzy', prop: 'wrench', ms: null },
    // Idle, sleep and funny
    { id: 16, key: 'power-nap', name: 'Power Nap Zzz', cat: 'idle', prio: 85, cls: 'a-timeout', fx: 'zzz', ms: null },
    { id: 17, key: 'yawn-stretch', name: 'Yawn & Stretch', cat: 'idle', prio: 30, cls: 'a-stretch', fx: 'lines', ms: 2800, idle: true },
    { id: 18, key: 'headphone-jam', name: 'Headphone Jam', cat: 'idle', prio: 10, cls: 'a-vibe', fx: 'notes', prop: 'headphones', ms: 5000, idle: true },
    { id: 19, key: 'surprise-jump', name: 'Surprise Jump', cat: 'idle', prio: 90, cls: 'a-doubletake', prop: 'alert', ms: 1800 },
    { id: 20, key: 'cheer-wave', name: 'Cheering Wave', cat: 'idle', prio: 30, cls: 'a-shrug', fx: 'sparks', ms: 2800, idle: true }
  ];

  // Event name -> what to play (anim id + source) or what to clear (source).
  // `also` clears another source at the same time: a passing build or a finished task
  // ends the error panic, and waking up ends the nap.
  var EVENT_MAP = {
    // Work in progress (held until the matching end event)
    'script.run': { anim: 11, source: 'script' },        // running commands: tiny typing
    'script.end': { clear: 'script' },
    'edit.start': { anim: 13, source: 'edit' },          // editing code: zapping bugs
    'edit.end': { clear: 'edit' },
    'search.start': { anim: 9, source: 'search' },       // web and code search: magnifier
    'search.end': { clear: 'search' },
    'log.stream': { anim: 6, source: 'log' },            // reading files and logs: taps the glass to look
    'log.end': { clear: 'log' },
    'design.start': { anim: 12, source: 'design' },      // images and big designs: hauling a data file
    'design.end': { clear: 'design' },
    'weigh.start': { anim: 12, source: 'weigh' },        // big Odds/Outlier reads: same heavy lifting
    'weigh.end': { clear: 'weigh' },
    'inference.start': { anim: 8, source: 'inference' }, // the model thinking: head tilt with ? eyes
    'inference.end': { clear: 'inference' },
    'inference.sip': { anim: 14, source: 'sip' },        // a reply landed mid-task: a sip from the CodeDev bottle
    'api.pending': { anim: 15, source: 'api' },          // a slow API: tightening the connection
    'api.done': { clear: 'api' },
    'network.loading': { anim: 15, source: 'network' },  // offline or a page loading
    'network.done': { clear: 'network' },
    // Results
    'build.success': { anim: 4, source: 'build', also: 'error' },      // tests pass / compile OK: happy bounce
    'build.error': { anim: 10, source: 'error' },                      // failure: peek-a-boo
    'build.clear': { clear: 'error' },
    'task.done': { anim: 5, source: 'task', also: 'error' },           // an agent finished its task: Tada!
    'changes.submitted': { anim: 3, source: 'task', also: 'error' },   // changes handed in for review: confetti
    'merge.done': { anim: 2, source: 'task', also: 'error' },          // a merge landed: victory spin
    'reply.done': { anim: 1, source: 'reply' },                        // a chat reply arrived: little groove
    'alert.ping': { anim: 19, source: 'alert' },                       // an approval or alert popped up
    'hello': { anim: 20, source: 'hello' },                            // the app opened: cheering wave
    // Sleep
    'session.timeout': { anim: 16, source: 'timeout' },
    'session.resume': { anim: 17, source: 'wake', also: 'timeout' }
  };

  var sources = new Map(); // source name -> { anim, timer, count }; insertion order = recency
  var listeners = [];
  var idleTimer = null;
  var idleLoop = null;
  var renderedKey = null;
  var els = null;

  function byId(id) {
    for (var i = 0; i < ANIMATIONS.length; i++) {
      if (ANIMATIONS[i].id === id) return ANIMATIONS[i];
    }
    throw new Error('Unknown animation id: ' + id);
  }

  function current() {
    var best = null;
    // >= so that, on equal priority, the later (more recent) entry wins.
    sources.forEach(function (entry) {
      if (!best || entry.anim.prio >= best.anim.prio) best = entry;
    });
    return best ? best.anim : null;
  }

  function busy() {
    var any = false;
    sources.forEach(function (entry, source) {
      if (source !== 'idle') any = true;
    });
    return any;
  }

  function render() {
    var anim = current();
    var key = anim ? anim.key : null;
    if (key === renderedKey) return;
    renderedKey = key;
    if (els) {
      els.body.className = 'companion-body';
      els.stage.classList.remove('stage-alert');
      els.stage.setAttribute('data-state', key || 'resting');
      els.fx.innerHTML = '';
      void els.body.offsetWidth; // restart CSS animation
      if (anim) {
        els.body.classList.add(anim.cls);
        if (FX[anim.fx]) FX[anim.fx](els.fx);
        // The 3D robot holds its own props; flat pictures get an emoji stand-in.
        if (anim.prop && FX[anim.prop] && els.stage.getAttribute('data-render') !== '3d') FX[anim.prop](els.fx);
        if (anim.key === 'peekaboo') els.stage.classList.add('stage-alert');
      }
      if (els.label) els.label.textContent = anim ? anim.name : 'Resting';
    }
    listeners.forEach(function (fn) {
      try { fn(anim ? { id: anim.id, key: anim.key, name: anim.name, category: anim.cat } : null); } catch (err) {
        if (root.console) root.console.error('VortexCompanion listener failed', err);
      }
    });
  }

  // ms: undefined = the animation's own length (looping ones are held up to
  // MAX_HOLD_MS); null = hold until cleared; a number = that long.
  function setSource(source, anim, ms, counted) {
    var prev = sources.get(source);
    if (prev && prev.timer) clearTimeout(prev.timer);
    var count = counted ? ((prev && prev.anim === anim ? prev.count : 0) + 1) : 1;
    sources.delete(source); // re-insert so this request counts as most recent
    var entry = { anim: anim, timer: null, count: count };
    sources.set(source, entry);
    if (ms === undefined) ms = anim.ms || MAX_HOLD_MS;
    if (ms) {
      entry.timer = setTimeout(function () { clearSource(source, true); }, ms);
    }
    render();
  }

  function clearSource(source, all) {
    var entry = sources.get(source);
    if (!entry) return;
    if (!all && entry.count > 1) {
      entry.count -= 1;
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    sources.delete(source);
    render();
  }

  function clearAll() {
    sources.forEach(function (entry) { if (entry.timer) clearTimeout(entry.timer); });
    sources.clear();
  }

  function startIdle() {
    idleTimer = null;
    idleLoop = null;
    if (busy()) {
      idleTimer = setTimeout(startIdle, IDLE_MIN_MS);
      return;
    }
    var pool = ANIMATIONS.filter(function (a) { return a.idle; });
    var pick = pool[Math.floor(Math.random() * pool.length)];
    setSource('idle', pick);
    var wait = IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS);
    idleLoop = setTimeout(startIdle, wait);
  }

  function armIdle() {
    clearTimeout(idleTimer);
    clearTimeout(idleLoop);
    idleLoop = null;
    idleTimer = setTimeout(startIdle, IDLE_AFTER_MS);
  }

  function touch() {
    clearSource('idle', true);
    armIdle();
  }

  function notify(name) {
    var rule = EVENT_MAP[name];
    if (!rule) {
      if (root.console) root.console.warn('VortexCompanion: unknown event ' + name);
      return false;
    }
    touch();
    if (rule.also) clearSource(rule.also, true);
    if (rule.clear) {
      clearSource(rule.clear);
    } else {
      var anim = byId(rule.anim);
      // One-shot events (sip, build result, error) restart; start events count.
      setSource(rule.source, anim, undefined, !anim.ms);
    }
    return true;
  }

  // Preview/manual control: clears everything and plays one animation.
  // ms = undefined uses the animation's own length; null loops until stop().
  // Idle loops come back 2 minutes after it.
  function play(id, ms) {
    var anim = byId(id);
    clearAll();
    setSource('manual', anim, ms === undefined ? (anim.ms || null) : ms);
    armIdle();
  }

  function stop() {
    clearAll();
    render();
    armIdle();
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function init(options) {
    els = {
      stage: options.stage,
      body: options.body,
      fx: options.fx,
      label: options.label || null
    };
    renderedKey = '__unset__';
    render();
    armIdle();
  }

  // ---- Overlay props -------------------------------------------------------

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function make(container, cls, text, style) {
    var el = document.createElement('span');
    el.className = 'fx-el ' + cls;
    el.textContent = text || '';
    if (style) {
      Object.keys(style).forEach(function (k) { el.style.setProperty(k, style[k]); });
    }
    container.appendChild(el);
    return el;
  }

  var FX = {
    sparks: function (c) {
      for (var i = 0; i < 8; i++) {
        make(c, 'fx-spark', '✦', { left: rnd(15, 85) + '%', top: rnd(15, 85) + '%', 'animation-delay': rnd(0, 0.8) + 's' });
      }
    },
    stylus: function (c) {
      for (var i = 0; i < 3; i++) {
        make(c, 'fx-stylus', '', { left: '14%', top: (30 + i * 14) + '%', 'animation-delay': (i * 0.4) + 's' });
      }
    },
    magnifier: function (c) {
      make(c, 'fx-mag', '🔍', { right: '-6%', top: '36%' });
    },
    matrix: function (c) {
      var chars = ['0 1 1', '1 0 0 1', '01 10', '1 1 0 1', '0 0 1', '10 01 1'];
      for (var col = 0; col < 8; col++) {
        var text = '';
        for (var r = 0; r < 10; r++) text += chars[(col + r) % chars.length] + '\n';
        make(c, 'fx-rain', text, { left: (8 + col * 11) + '%', 'animation-delay': rnd(0, 2) + 's' });
      }
    },
    gear: function (c) {
      make(c, 'fx-gear', '⚙️', { left: '40%', top: '-8%' });
    },
    scale: function (c) {
      make(c, 'fx-scale', '⚖️', { left: '38%', top: '-6%' });
    },
    mug: function (c) {
      make(c, 'fx-mug', '☕', { right: '-4%', top: '44%' });
    },
    dots: function (c) {
      make(c, 'fx-dots', '…', { left: '58%', top: '-2%' });
    },
    confetti: function (c) {
      var colors = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff'];
      for (var i = 0; i < 14; i++) {
        make(c, 'fx-confetti', '■', { left: rnd(5, 95) + '%', color: colors[i % colors.length], 'animation-delay': rnd(0, 0.6) + 's' });
      }
    },
    warning: function (c) {
      make(c, 'fx-warn', '⚠️', { left: '44%', top: '-8%' });
      make(c, 'fx-warn', '🚨', { left: '-6%', top: '10%' });
      make(c, 'fx-warn', '🚨', { right: '-6%', top: '10%' });
    },
    ring: function (c) {
      make(c, 'fx-ring', '', { left: '6%', top: '6%' });
    },
    zzz: function (c) {
      for (var i = 0; i < 3; i++) {
        make(c, 'fx-z', 'Z', { left: (62 + i * 9) + '%', top: '2%', 'animation-delay': (i * 0.7) + 's' });
      }
    },
    lines: function (c) {
      for (var i = 0; i < 3; i++) {
        make(c, 'fx-steam', '~', { left: (34 + i * 12) + '%', top: '-4%', 'animation-delay': (i * 0.2) + 's' });
      }
    },
    watch: function (c) {
      make(c, 'fx-watch', '⌚', { right: '-4%', bottom: '12%' });
    },
    eyes: function (c) {
      make(c, 'fx-eyes', '👀', { left: '40%', top: '-8%' });
    },
    orb: function (c) {
      make(c, 'fx-orb', '', { left: '44%', top: '40%' });
    },
    question: function (c) {
      make(c, 'fx-q', '?', { left: '58%', top: '-6%' });
    },
    shrug: function (c) {
      make(c, 'fx-shrug', '🤷', { left: '40%', top: '-6%' });
    },
    notes: function (c) {
      for (var i = 0; i < 3; i++) {
        make(c, 'fx-note', '♪', { left: (20 + i * 22) + '%', top: '10%', 'animation-delay': (i * 0.6) + 's' });
      }
    },
    flex: function (c) {
      make(c, 'fx-flex', '💪', { left: '40%', top: '-10%' });
    },
    popper: function (c) {
      make(c, 'fx-flex', '🎉', { left: '8%', top: '-6%' });
    },
    check: function (c) {
      make(c, 'fx-check', '✅', { left: '6%', top: '-10%' });
    },
    butterfly: function (c) {
      make(c, 'fx-butterfly', '🦋', { left: '70%', top: '0%' });
    },
    keyboard: function (c) {
      make(c, 'fx-mug', '⌨️', { left: '34%', top: '58%' });
    },
    file: function (c) {
      make(c, 'fx-orb-file', '📁', { left: '38%', top: '-8%' });
    },
    bug: function (c) {
      make(c, 'fx-bug', '🐞', { left: '10%', bottom: '2%' });
    },
    bottle: function (c) {
      make(c, 'fx-mug', '🧃', { right: '-4%', top: '44%' });
    },
    wrench: function (c) {
      make(c, 'fx-gear', '🔧', { left: '40%', top: '-8%' });
    },
    headphones: function (c) {
      make(c, 'fx-flex', '🎧', { left: '38%', top: '-8%' });
    },
    alert: function (c) {
      make(c, 'fx-q', '❗', { left: '60%', top: '-8%' });
    }
  };

  root.VortexCompanion = {
    init: init,
    notify: notify,
    play: play,
    stop: stop,
    current: function () { var a = current(); return a ? a.key : null; },
    subscribe: subscribe,
    animations: ANIMATIONS.map(function (a) {
      return { id: a.id, key: a.key, name: a.name, category: a.cat, idle: Boolean(a.idle) };
    }),
    events: Object.keys(EVENT_MAP)
  };
})(typeof window !== 'undefined' ? window : this);
