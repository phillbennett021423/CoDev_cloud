/*
 * CodevCompanion: connects CoDev's real work to the VortexCompanion avatar.
 *
 * The page calls these:
 *   CodevCompanion.inference(promiseFn)              around every model call
 *   CodevCompanion.tool(name, args, promiseFn)       around every agent tool call
 *   CodevCompanion.finished(usedTools)               when an agent's reply is done
 *   CodevCompanion.mount(element)                    once, to draw the floating avatar
 * Everything else (offline/online, sleep after a long quiet spell) runs on its own.
 * The classifiers are pure functions so tests can check them without a browser.
 */
(function (root) {
  'use strict';

  var API_PENDING_MS = 8000;        // a model call this slow shows "Waiting / Zoning Out"
  var SIP_EVERY_MS = 90000;         // at most one coffee sip per 90 seconds
  var SLEEP_AFTER_MS = 15 * 60000;  // no work and no input for 15 minutes: sleep mode
  var REPLY_DANCE_EVERY_MS = 120000; // a plain chat reply gets a little groove at most every 2 minutes
  var STORAGE_KEY = 'codev_companion';

  function C() { return root.VortexCompanion; }
  function send(name) {
    var c = C();
    if (!c) return;
    if (asleep && name !== 'session.timeout') { asleep = false; c.notify('session.resume'); }
    c.notify(name);
    armSleep();
  }

  // ---- What a tool call is --------------------------------------------------
  // Tool names may carry a server prefix ("codev-sandbox__run_command").
  function baseName(name) {
    var s = String(name || '');
    var i = s.lastIndexOf('__');
    return i >= 0 ? s.slice(i + 2) : s;
  }

  var KINDS = [
    // Odds and Outlier reads: weighing lines and variables.
    { kind: 'weigh', test: /^(outlier_|odds_)/ },
    // Pages loading in the agents' browser.
    { kind: 'network', test: /^browser_(navigate|login|load_session|wait_for)$/ },
    // Writing and fixing code.
    { kind: 'edit', test: /^(write_file|write_workspace_file|edit_file|edit_workspace_file|delete_file)$/ },
    // Running code.
    { kind: 'script', test: /^(run_command|run_local_command|blender_run|submit_changes|gamedev|godot_editor|godot_install_bridge)$/ },
    // Checks that pass or fail like a build.
    { kind: 'check', test: /^(godot_check|godot_validate|syntax)$/ },
    // Looking things up.
    { kind: 'search', test: /^(web_search|read_webpage|search_past_chats|search_workspace|search_files|find_symbol|code_map|mcp_list_resources)$|search/ },
    // Reading files, tables, logs and attachments.
    { kind: 'log', test: /^(read_file|read_workspace_file|read_lines|list_files|list_workspace_files|file_outline|read_attachment|query_table|read_screenshots|read_image|mcp_read_resource|browser_get_text|browser_screenshot|sandbox_diff|studio_read|gamedev_status)$|^(read|list|get)_/ },
    // Images, story studio and architecture work: drafting a design.
    { kind: 'design', test: /^(generate_image|architecture_review|studio_save|studio_export|studio_remove)$|image|design|scene|sketch|draw/ }
  ];

  var EVENTS = {
    weigh: ['weigh.start', 'weigh.end'],
    network: ['network.loading', 'network.done'],
    script: ['script.run', 'script.end'],
    edit: ['edit.start', 'edit.end'],
    check: ['script.run', 'script.end'],
    search: ['search.start', 'search.end'],
    log: ['log.stream', 'log.end'],
    design: ['design.start', 'design.end']
  };

  function classifyTool(name) {
    var n = baseName(name);
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].test.test(n)) return KINDS[i].kind;
    return null;
  }

  // run_command lines that are a build, compile, test or lint step.
  var BUILD_COMMAND = /(^|[\s;&|/\\])(npm (test|t|ci|run (build|test|lint|check|typecheck)[\w:.-]*)|npx (jest|vitest|mocha|tsc|eslint)|yarn (build|test|lint)|pnpm (build|test|lint)|tsc|node --(check|test)|pytest|python3? -m (pytest|unittest|py_compile)|py -m (pytest|unittest)|cargo (build|test|check)|go (build|test|vet)|dotnet (build|test)|make|cmake|gradlew(\.bat)? \w*|gradle \w*|mvn \w*|javac|gcc|g\+\+|clang|godot\b.*--(check-only|export))\b/i;

  // 'build.success', 'build.error' or null (not a build, or no clear result).
  function buildOutcome(toolName, args, resultText) {
    var n = baseName(toolName);
    var text = String(resultText == null ? '' : resultText);
    var kind = classifyTool(n);
    if (kind === 'check') {
      if (/^(Error|Tool failed)/.test(text) || /\b(SyntaxError|Parse error|parse error|compile error|[1-9]\d* errors?)\b/.test(text)) return 'build.error';
      return /^(Not run|The user declined|Unknown tool)/.test(text) ? null : 'build.success';
    }
    if (!/^(run_command|run_local_command)$/.test(n)) return null;
    var command = String((args && (args.command || args.name)) || '');
    if (!BUILD_COMMAND.test(command)) return null;
    var code = /Exit code:\s*(-?\d+)/.exec(text);
    if (/\(timed out\)/.test(text)) return 'build.error';
    if (code) return code[1] === '0' ? 'build.success' : 'build.error';
    return /^(Error|Tool failed)/.test(text) ? 'build.error' : null;
  }

  // 'changes.submitted', 'merge.done' or null: the milestones worth a party.
  var MERGE_TOOL = /(^|_)merge(_|$)|^merge/;
  var MERGE_COMMAND = /(^|[\s;&|])(git merge\b|gh pr merge\b)/;
  function milestone(toolName, args, resultText) {
    var n = baseName(toolName);
    var text = String(resultText == null ? '' : resultText);
    if (/^(Error|Tool failed|Not run|Unknown tool|The user declined)/.test(text)) return null;
    if (n === 'submit_changes') return 'changes.submitted';
    if (MERGE_TOOL.test(n)) return 'merge.done';
    if (/^(run_command|run_local_command)$/.test(n)) {
      var command = String((args && args.command) || '');
      var code = /Exit code:\s*(-?\d+)/.exec(text);
      if (MERGE_COMMAND.test(command) && code && code[1] === '0' && !/CONFLICT/.test(text)) return 'merge.done';
    }
    return null;
  }

  // ---- Wrappers the page calls ---------------------------------------------
  var inFlight = 0;
  var lastSip = -Infinity;

  function inference(fn) {
    inFlight++;
    send('inference.start');
    var pending = false;
    var slow = setTimeout(function () { pending = true; send('api.pending'); }, API_PENDING_MS);
    var finish = function () {
      clearTimeout(slow);
      inFlight--;
      if (pending) send('api.done');
      send('inference.end');
      // A model reply landed and nothing else is thinking: a quick sip, now and then.
      var now = Date.now();
      if (inFlight === 0 && now - lastSip > SIP_EVERY_MS) { lastSip = now; send('inference.sip'); }
    };
    var p;
    try { p = Promise.resolve(fn()); } catch (err) { p = Promise.reject(err); }
    return p.then(function (v) { finish(); return v; }, function (err) { finish(); throw err; });
  }

  function tool(name, args, fn) {
    var kind = classifyTool(name);
    var pair = kind ? EVENTS[kind] : null;
    if (pair) send(pair[0]);
    var done = function (result, failed) {
      if (pair) send(pair[1]);
      var outcome = failed ? null : buildOutcome(name, args, result);
      if (outcome) send(outcome);
      var party = failed ? null : milestone(name, args, result);
      if (party) send(party);
    };
    var p;
    try { p = Promise.resolve(fn()); } catch (err) { p = Promise.reject(err); }
    return p.then(function (v) { done(v, false); return v; }, function (err) { done(null, true); throw err; });
  }

  // An agent's reply is done: a task that used tools gets the Tada pose; a plain chat
  // reply gets a little groove now and then.
  var lastReplyDance = -Infinity;
  function finished(usedTools) {
    if (usedTools) { send('task.done'); return 'task.done'; }
    var now = Date.now();
    if (now - lastReplyDance < REPLY_DANCE_EVERY_MS) return null;
    lastReplyDance = now;
    send('reply.done');
    return 'reply.done';
  }

  // ---- Sleep and connectivity -----------------------------------------------
  var asleep = false;
  var sleepTimer = null;
  function armSleep() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(function () {
      if (inFlight > 0) { armSleep(); return; }
      asleep = true;
      if (C()) C().notify('session.timeout');
    }, SLEEP_AFTER_MS);
  }
  function wake() {
    if (asleep) { asleep = false; if (C()) C().notify('session.resume'); }
    armSleep();
  }

  // ---- Which avatar ---------------------------------------------------------
  // The CoDev robot is drawn live in 3D (robot3d.js, with the vendored three.js).
  // The others are one or more flat pictures moved together by the animations.
  // shape picks the stage size: bot for the robot, tall for one standing figure, duo for two.
  var AVATARS = [
    { id: 'codev-bot', name: 'CoDev Bot (3D, dances)', shape: 'bot', kind: '3d' },
    { id: 'duo', name: 'Bear hoodie duo', shape: 'duo', images: ['avatars/bear-wink.png', 'avatars/bear-smile.png'] },
    { id: 'bear-wink', name: 'Bear hoodie (wink)', shape: 'tall', images: ['avatars/bear-wink.png'] },
    { id: 'bear-smile', name: 'Bear hoodie (smile)', shape: 'tall', images: ['avatars/bear-smile.png'] },
    { id: 'robot', name: 'Robot', shape: 'square', images: ['avatar.svg'] }
  ];
  // A new key, so everyone meets the robot once; picking another avatar is remembered.
  var AVATAR_KEY = 'codev_companion_avatar_v2';

  function store(key, value) {
    try {
      if (value === undefined) return root.localStorage.getItem(key);
      root.localStorage.setItem(key, value);
    } catch (err) { /* private mode: not remembered */ }
    return null;
  }
  function findAvatar(id) {
    for (var i = 0; i < AVATARS.length; i++) if (AVATARS[i].id === id) return AVATARS[i];
    return AVATARS[0];
  }
  function avatar() { return findAvatar(store(AVATAR_KEY)).id; }

  // ---- The floating avatar -------------------------------------------------
  var dock = null;
  var base = 'companion/';
  function enabled() { return (store(STORAGE_KEY) || '1') === '1'; }
  function setEnabled(on) {
    store(STORAGE_KEY, on ? '1' : '0');
    if (dock) { dock.hidden = !on; place(); }
  }

  // ---- The 3D robot --------------------------------------------------------
  var robot = null;
  var robotToken = 0;
  function reducedMotion() {
    try { return Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (err) { return false; }
  }
  function webglOk() {
    try {
      var c = root.document.createElement('canvas');
      return Boolean(root.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (err) { return false; }
  }
  function dropRobot() {
    robotToken++;
    if (robot) { try { robot.dispose(); } catch (err) { /* already gone */ } robot = null; }
  }
  // Loads three.js and the robot only when the robot is picked, so the flat avatars cost nothing.
  function mountRobot(body, stage, onFail) {
    var token = ++robotToken;
    if (!webglOk()) { onFail(); return; }
    var url = function (p) { return new root.URL(base + p, root.document.baseURI).href; };
    Promise.all([import(url('../vendor/three/three.module.min.js')), import(url('robot3d.js'))]).then(function (mods) {
      if (token !== robotToken) return;
      robot = mods[1].createRobot(mods[0], body, { reducedMotion: reducedMotion() });
      robot.setState(C() ? C().current() : null);
    }).catch(function (err) {
      if (token !== robotToken) return;
      if (root.console) root.console.warn('CoDev Bot could not start; showing the flat robot instead', err);
      stage.removeAttribute('data-render');
      onFail();
    });
  }

  function drawAvatar(id) {
    if (!dock) return;
    var a = findAvatar(id);
    var body = dock.querySelector('#codevCompanionBody');
    var stage = dock.querySelector('#codevCompanionStage');
    dropRobot();
    body.innerHTML = '';
    dock.setAttribute('data-shape', a.shape);
    if (a.kind === '3d') {
      stage.setAttribute('data-render', '3d');
      mountRobot(body, stage, function () { drawImages(body, ['avatar.svg']); dock.setAttribute('data-shape', 'square'); place(); });
      place();
      return;
    }
    stage.removeAttribute('data-render');
    drawImages(body, a.images);
    place();
  }

  function drawImages(body, images) {
    images.forEach(function (src) {
      var img = root.document.createElement('img');
      img.className = 'companion-img';
      img.alt = '';
      img.draggable = false;
      // A missing picture falls back to the bundled placeholder rather than a broken image.
      img.addEventListener('error', function onError() { img.removeEventListener('error', onError); img.src = base + 'avatar.svg'; });
      img.src = base + src;
      body.appendChild(img);
    });
  }

  function setAvatar(id) {
    var a = findAvatar(id);
    store(AVATAR_KEY, a.id);
    drawAvatar(a.id);
    return a.id;
  }

  // The avatar stands next to the chat box: beside it when there's room (wide screens),
  // otherwise just above its right edge, so it never covers the text field or its buttons.
  // On the other tabs (Story Studio, Outlier, ...) the chat box is hidden and so is the
  // avatar, so it can't sit on top of their controls.
  var anchor = null;
  function place() {
    if (!dock) return;
    var rect = anchor && anchor.getBoundingClientRect();
    if (!anchor) return;
    var away = !rect || rect.height === 0;
    dock.classList.toggle('off-view', away);
    if (away) return;
    var w = dock.offsetWidth;
    var right = root.innerWidth - rect.right;
    var beside = right >= w + 24;
    // Above the chat box it overlaps the bottom of the conversation, so taps go through it
    // to the messages' buttons; beside the box it's in free space and a tap shrinks it.
    dock.classList.toggle('pass-through', !beside);
    if (beside) {
      dock.style.right = Math.round((right - w) / 2) + 'px';
      dock.style.bottom = Math.round(root.innerHeight - rect.bottom) + 'px';
    } else {
      dock.style.right = Math.round(Math.max(4, right + 4)) + 'px';
      dock.style.bottom = Math.round(root.innerHeight - rect.top + 6) + 'px';
    }
  }

  function mount(container, options) {
    options = options || {};
    var doc = root.document;
    if (!doc || !C() || dock) return dock;
    base = options.base || base;
    dock = doc.createElement('div');
    dock.className = 'codev-companion-dock';
    dock.id = 'codevCompanion';
    dock.hidden = !enabled();
    dock.innerHTML =
      '<div class="companion-stage" id="codevCompanionStage" role="img" aria-label="Companion: Resting">' +
        '<div class="companion-body" id="codevCompanionBody"></div>' +
        '<div class="companion-fx" id="codevCompanionFx"></div>' +
      '</div>' +
      '<div class="codev-companion-label" id="codevCompanionLabel" aria-live="polite">Resting</div>';
    (container || doc.body).appendChild(dock);
    anchor = options.anchor || null;
    var stage = dock.querySelector('#codevCompanionStage');
    drawAvatar(avatar());
    C().init({ stage: stage, body: dock.querySelector('#codevCompanionBody'), fx: dock.querySelector('#codevCompanionFx'), label: dock.querySelector('#codevCompanionLabel') });
    C().subscribe(function (anim) {
      stage.setAttribute('aria-label', 'Companion: ' + (anim ? anim.name : 'Resting'));
      if (robot) robot.setState(anim ? anim.key : null);
    });
    // Tap to tuck it into a small bubble and back.
    stage.addEventListener('click', function () { dock.classList.toggle('collapsed'); place(); });
    ['pointerdown', 'keydown'].forEach(function (type) { doc.addEventListener(type, wake, { capture: true, passive: true }); });
    root.addEventListener('offline', function () { send('network.loading'); });
    root.addEventListener('online', function () { send('network.done'); });
    root.addEventListener('resize', place);
    if (anchor && root.ResizeObserver) new root.ResizeObserver(place).observe(anchor);
    if (root.navigator && root.navigator.onLine === false) send('network.loading');
    else setTimeout(function () { send('hello'); }, 1200);
    armSleep();
    return dock;
  }

  root.CodevCompanion = {
    mount: mount,
    inference: inference,
    tool: tool,
    finished: finished,
    notify: send,
    enabled: enabled,
    setEnabled: setEnabled,
    avatar: avatar,
    setAvatar: setAvatar,
    avatars: AVATARS.map(function (a) { return { id: a.id, name: a.name }; }),
    classifyTool: classifyTool,
    buildOutcome: buildOutcome,
    milestone: milestone
  };
})(typeof window !== 'undefined' ? window : this);
