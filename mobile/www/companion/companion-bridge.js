/*
 * CodevCompanion: connects CoDev's real work to the robot's moves (VortexCompanion).
 *
 * The page calls these:
 *   CodevCompanion.inference(promiseFn)              around every model call
 *   CodevCompanion.tool(name, args, promiseFn)       around every agent tool call
 *   CodevCompanion.finished(usedTools)               when an agent's reply is done
 *   CodevCompanion.start()                           once, at page load
 *   CodevCompanion.attach(element, { accent })       to put the live robot in the chat header
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

  // ---- The live robot -------------------------------------------------------
  // The selected agent's avatar in the chat header becomes the live 3D CoDev Bot,
  // which acts out every move. Every other agent avatar is a still picture of the
  // same robot (drawn by the page). three.js and robot3d.js load only once the
  // robot is first shown.
  var base = 'companion/';
  var stage = null;
  var robot = null;
  var robotToken = 0;
  var loading = null;
  var started = false;

  function store(key, value) {
    try {
      if (value === undefined) return root.localStorage.getItem(key);
      root.localStorage.setItem(key, value);
    } catch (err) { /* private mode: not remembered */ }
    return null;
  }
  function enabled() { return (store(STORAGE_KEY) || '1') === '1'; }

  function reducedMotion() {
    try { return Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (err) { return false; }
  }
  // WebGL on a real graphics chip. A software renderer (no GPU, or a GPU-less VM)
  // would spend a CPU core drawing the robot, so those keep the still pictures.
  var SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i;
  function webglOk() {
    try {
      var c = root.document.createElement('canvas');
      var gl = root.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'));
      if (!gl) return false;
      var info = gl.getExtension('WEBGL_debug_renderer_info');
      var name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return !SOFTWARE_GL.test(name);
    } catch (err) { return false; }
  }

  function makeStage() {
    var doc = root.document;
    stage = doc.createElement('div');
    stage.className = 'companion-stage live-robot';
    stage.setAttribute('data-render', '3d');
    stage.setAttribute('aria-hidden', 'true');
    stage.innerHTML = '<div class="companion-body"></div><div class="companion-fx"></div>';
    C().init({ stage: stage, body: stage.firstChild, fx: stage.lastChild });
    C().subscribe(function (anim) { if (robot) robot.setState(anim ? anim.key : null); });
  }

  function loadRobot(accent) {
    if (loading) return loading;
    var token = robotToken;
    var url = function (p) { return new root.URL(base + p, root.document.baseURI).href; };
    loading = Promise.all([import(url('../vendor/three/three.module.min.js')), import(url('robot3d.js'))]).then(function (mods) {
      if (token !== robotToken) return null;
      robot = mods[1].createRobot(mods[0], stage.firstChild, { reducedMotion: reducedMotion(), accent: accent });
      robot.setState(C().current());
      return robot;
    }).catch(function (err) {
      if (root.console) root.console.warn('CoDev Bot could not start; keeping the still pictures', err);
      return null;
    });
    return loading;
  }

  var host = null;
  var hostAccent = null;
  var glOk = null; // checked once
  // Puts the live robot in host (the chat header's avatar slot) in the given colour.
  // The page re-renders that slot when the agent changes, so it calls this each time;
  // the same robot moves over and changes colour. Returns false when the robot
  // can't run here (turned off, no WebGL, or software WebGL), so the picture stays.
  function attach(el, options) {
    host = el || null;
    hostAccent = (options && options.accent) || hostAccent;
    if (!host || !enabled() || !C() || !root.document) return false;
    if (glOk === null) glOk = webglOk();
    if (!glOk) return false;
    if (!stage) makeStage();
    host.appendChild(stage);
    host.classList.add('has-live-robot');
    if (robot) robot.setAccent(hostAccent);
    else loadRobot(hostAccent).then(function (r) {
      if (r) r.setAccent(hostAccent);
      else if (host) host.classList.remove('has-live-robot');
    });
    return true;
  }

  function setEnabled(on) {
    store(STORAGE_KEY, on ? '1' : '0');
    if (on) { attach(host); return; }
    if (robot) { try { robot.dispose(); } catch (err) { /* already gone */ } }
    robot = null; loading = null; robotToken++;
    if (stage && stage.parentNode) stage.parentNode.classList.remove('has-live-robot');
    if (stage) stage.remove();
  }

  // Once, at page load: wake on input, react to going offline, say hello.
  function start(options) {
    if (started || !root.document) return;
    started = true;
    base = (options && options.base) || base;
    var doc = root.document;
    ['pointerdown', 'keydown'].forEach(function (type) { doc.addEventListener(type, wake, { capture: true, passive: true }); });
    root.addEventListener('offline', function () { send('network.loading'); });
    root.addEventListener('online', function () { send('network.done'); });
    if (root.navigator && root.navigator.onLine === false) send('network.loading');
    else setTimeout(function () { send('hello'); }, 1200);
    armSleep();
  }

  root.CodevCompanion = {
    start: start,
    attach: attach,
    inference: inference,
    tool: tool,
    finished: finished,
    notify: send,
    enabled: enabled,
    setEnabled: setEnabled,
    classifyTool: classifyTool,
    buildOutcome: buildOutcome,
    milestone: milestone
  };
})(typeof window !== 'undefined' ? window : this);
