/*
 * VortexCompanion: state machine for the workspace companion avatar.
 * Plays one of 20 animations at a time. Higher priority wins; ties go to the
 * most recent request. Idle loops only run when nothing else is active.
 * Animations are CSS transforms on the single avatar image plus overlay props.
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

  var ANIMATIONS = [
    { id: 1, key: 'coding-frenzy', name: 'The Coding Frenzy', cat: 'active', prio: 50, cls: 'a-frenzy', fx: 'sparks', ms: null },
    { id: 2, key: 'blueprint-draft', name: 'The Blueprint Draft', cat: 'active', prio: 50, cls: 'a-blueprint', fx: 'stylus', ms: null },
    { id: 3, key: 'deep-search', name: 'Deep Database Search', cat: 'active', prio: 50, cls: 'a-search', fx: 'magnifier', ms: null },
    { id: 4, key: 'data-analyzer', name: 'Data Stream Analyzer', cat: 'active', prio: 50, cls: 'a-analyze', fx: 'matrix', ms: null },
    { id: 5, key: 'gears', name: 'Gears Turning', cat: 'processing', prio: 40, cls: 'a-gears', fx: 'gear', ms: null },
    { id: 6, key: 'weighing', name: 'Weighing the Variables', cat: 'processing', prio: 40, cls: 'a-weigh', fx: 'scale', ms: null },
    { id: 7, key: 'quick-sip', name: 'The Quick Sip', cat: 'processing', prio: 40, cls: 'a-sip', fx: 'mug', ms: 1800 },
    { id: 8, key: 'waiting', name: 'Waiting / Zoning Out', cat: 'processing', prio: 40, cls: 'a-wait', fx: 'dots', ms: null },
    { id: 9, key: 'build-success', name: 'Build Success Celebration', cat: 'system', prio: 70, cls: 'a-success', fx: 'confetti', ms: 2500 },
    { id: 10, key: 'compile-error', name: 'Compilation Error Panic', cat: 'system', prio: 100, cls: 'a-error', fx: 'warning', ms: 6000 },
    { id: 11, key: 'network-spin', name: 'Network Loading Spin', cat: 'system', prio: 80, cls: 'a-network', fx: 'ring', ms: null },
    { id: 12, key: 'timeout-sleep', name: 'Timeout / Sleep Mode', cat: 'system', prio: 85, cls: 'a-timeout', fx: 'zzz', ms: null },
    { id: 13, key: 'stretch', name: 'The Stretch Routine', cat: 'idle', prio: 10, cls: 'a-stretch', fx: 'lines', ms: 2200 },
    { id: 14, key: 'foot-tap', name: 'Impatient Foot-Tap', cat: 'idle', prio: 10, cls: 'a-foottap', fx: 'watch', ms: 4000 },
    { id: 15, key: 'sneaky-glance', name: 'The Sneaky Glance', cat: 'idle', prio: 10, cls: 'a-glance', fx: 'eyes', ms: 3000 },
    { id: 16, key: 'object-toss', name: 'Fidget Spinner / Object Toss', cat: 'idle', prio: 10, cls: 'a-toss', fx: 'orb', ms: 4000 },
    { id: 17, key: 'double-take', name: 'The Double-Take', cat: 'idle', prio: 10, cls: 'a-doubletake', fx: 'question', ms: 1600 },
    { id: 18, key: 'casual-shrug', name: 'The Casual Shrug', cat: 'idle', prio: 10, cls: 'a-shrug', fx: 'shrug', ms: 1500 },
    { id: 19, key: 'headphone-vibe', name: 'Headphone Vibe', cat: 'idle', prio: 10, cls: 'a-vibe', fx: 'notes', ms: 5000 },
    { id: 20, key: 'superhero-flex', name: 'The Superhero Flex', cat: 'idle', prio: 10, cls: 'a-flex', fx: 'flex', ms: 2000 }
  ];

  // Event name -> what to play (anim id + source) or what to clear (source).
  // `also` clears another source at the same time: a passing build ends the
  // error panic, and waking up ends sleep.
  var EVENT_MAP = {
    'design.start': { anim: 2, source: 'design' },
    'design.end': { clear: 'design' },
    'search.start': { anim: 3, source: 'search' },
    'search.end': { clear: 'search' },
    'script.run': { anim: 1, source: 'script' },
    'script.end': { clear: 'script' },
    'log.stream': { anim: 4, source: 'log' },
    'log.end': { clear: 'log' },
    'inference.start': { anim: 5, source: 'inference' },
    'inference.end': { clear: 'inference' },
    'weigh.start': { anim: 6, source: 'weigh' },
    'weigh.end': { clear: 'weigh' },
    'inference.sip': { anim: 7, source: 'sip' },
    'api.pending': { anim: 8, source: 'api' },
    'api.done': { clear: 'api' },
    'network.loading': { anim: 11, source: 'network' },
    'network.done': { clear: 'network' },
    'build.success': { anim: 9, source: 'build', also: 'error' },
    'build.error': { anim: 10, source: 'error' },
    'build.clear': { clear: 'error' },
    'session.timeout': { anim: 12, source: 'timeout' },
    'session.resume': { clear: 'timeout' }
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
        if (anim.key === 'compile-error') els.stage.classList.add('stage-alert');
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
    var pool = ANIMATIONS.filter(function (a) { return a.cat === 'idle'; });
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
      return { id: a.id, key: a.key, name: a.name, category: a.cat };
    }),
    events: Object.keys(EVENT_MAP)
  };
})(typeof window !== 'undefined' ? window : this);
