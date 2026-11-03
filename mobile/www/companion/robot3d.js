/*
 * CoDev Bot: the little silver robot companion, drawn live with three.js.
 *
 *   const bot = createRobot(THREE, hostElement, { reducedMotion });
 *   bot.setState('tada');   // one of the VortexCompanion animation keys, or null to rest
 *   bot.dispose();
 *
 * Everything is built from primitives in code (no model file), so it loads instantly
 * and stays small. Each animation is a pose function of time; a change of state
 * blends from the pose on screen to the new one, so moves never snap. The face is a
 * glowing LED screen drawn on a canvas, and the props (magnifier, wrench, bottle...)
 * are small holograms that appear in its hands only for the animation that uses them.
 * The page passes THREE in, so this file has no imports and the preview can use any copy.
 */

const TAU = Math.PI * 2;
const CYAN = '#4fe8ff';
const RED = '#ff4d6a';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
// 0 -> 1 between a and b, then back to 0 between c and d.
const window4 = (t, a, b, c, d) => smooth((t - a) / (b - a)) * (1 - smooth((t - c) / (d - c)));
const sin = (t, hz, ph = 0) => Math.sin(TAU * hz * t + ph);
// A snappy "robot" step: holds at -1 or 1 and pops between them.
const tick = (t, hz, ph = 0) => Math.tanh(4 * Math.sin(TAU * hz * t + ph));
const hop = (t, hz) => Math.abs(Math.sin(Math.PI * hz * t));

// ---- Poses ----------------------------------------------------------------
// l = the robot's left (the viewer's right). Arms: out = raised sideways, fwd = raised
// forward, tw = twist along the arm, el = elbow bend, curl = fist (0 open .. 1 closed).
// Legs: lift = thigh forward, spread = sideways, knee = bend. y/px = body offset,
// ry = turn, rz = side lean, sx/sy/sz = spine, hx/hy/hz = head (nod, turn, tilt).
const KEYS = ['y', 'px', 'ry', 'rz', 'sx', 'sy', 'sz', 'hx', 'hy', 'hz',
  'lOut', 'lFwd', 'lTw', 'lEl', 'lCurl', 'rOut', 'rFwd', 'rTw', 'rEl', 'rCurl',
  'lLift', 'lSpread', 'lKnee', 'rLift', 'rSpread', 'rKnee', 'sit', 'hunch'];

function restPose(t) {
  return {
    y: 0.012 * sin(t, 0.3), px: 0, ry: 0, rz: 0,
    sx: 0.03 * sin(t, 0.3), sy: 0, sz: 0,
    hx: 0.04 * sin(t, 0.3, 1), hy: 0.18 * Math.sin(0.37 * t) * Math.sin(0.11 * t), hz: 0.05 * Math.sin(0.23 * t),
    lOut: 0.14 + 0.02 * sin(t, 0.3), lFwd: 0.05, lTw: 0, lEl: 0.3, lCurl: 0.35,
    rOut: 0.14 + 0.02 * sin(t, 0.3), rFwd: 0.05, rTw: 0, rEl: 0.3, rCurl: 0.35,
    lLift: 0, lSpread: 0.04, lKnee: 0, rLift: 0, rSpread: 0.04, rKnee: 0, sit: 0, hunch: 0
  };
}

// Each animation: pose(t, p) edits the rest pose, face(t) says how the screen looks,
// props lists the holograms it uses, and fx(t, P, bot) moves them.
const ANIMS = {
  // ---- Celebration & dancing ----
  groove: {
    pose(t, p) {
      const b = hop(t, 2.2);
      p.px = 0.16 * sin(t, 0.55);
      p.rz = -0.08 * sin(t, 0.55);
      p.lKnee = p.rKnee = 0.35 * b; p.lLift = p.rLift = 0.18 * b;
      p.y = 0.02 * b;
      p.lOut = 0.35 + 0.25 * tick(t, 1.1); p.rOut = 0.35 - 0.25 * tick(t, 1.1);
      p.lEl = p.rEl = 1.5; p.lFwd = p.rFwd = 0.3; p.lCurl = p.rCurl = 0.8;
      p.hz = 0.18 * sin(t, 0.55); p.hx = 0.08 * b;
      p.sy = 0.15 * sin(t, 0.55);
    },
    face: t => ({ eyes: (t % 1.6) < 0.8 ? 'happy' : 'joy', mouth: 'grin', lx: 0.3 * Math.sin(TAU * 0.55 * t) })
  },
  'victory-spin': {
    pose(t, p) {
      const up = window4(t, 0, 0.6, 2.6, 3.2);
      p.y = 0.32 * up + 0.04 * sin(t, 1.5) * up;
      p.ry = TAU * smooth((t - 0.5) / 1.8);
      p.lOut = p.rOut = 1.45 + 0.1 * sin(t, 2);
      p.lEl = p.rEl = 0.15; p.lCurl = p.rCurl = 0;
      p.lLift = 0.3 * up; p.lKnee = 0.9 * up; p.rLift = 0.1 * up; p.rKnee = 0.4 * up;
      p.hx = -0.2 * up;
    },
    props: ['jets'],
    face: () => ({ eyes: 'joy', mouth: 'grin' }),
    fx(t, P) { P.jets.scale.setScalar(0.6 + 0.4 * window4(t, 0, 0.5, 2.6, 3.1) * (0.85 + 0.15 * Math.sin(t * 40))); }
  },
  confetti: {
    pose(t, p) {
      const reach = smooth(t / 0.5), pop = smooth((t - 0.75) / 0.12);
      p.rOut = 0.4 + 2.1 * reach; p.rEl = 0.6 - 0.4 * pop; p.rFwd = 0.3;
      p.lOut = 0.3 + 0.9 * pop; p.lEl = 0.4;
      p.y = 0.12 * hop(Math.max(0, t - 0.8), 2.4) * (t > 0.8 ? 1 : 0);
      p.hx = -0.35 * reach; p.hy = -0.2 * reach;
      p.lKnee = p.rKnee = 0.2 * hop(t, 2.4);
    },
    props: ['popper'],
    face: t => ({ eyes: t < 0.75 ? 'neutral' : 'joy', mouth: t < 0.75 ? 'o' : 'grin', ly: -0.8, lx: -0.4 }),
    fx(t, P, bot) { if (t > 0.75 && !P.popper.userData.burst) { P.popper.userData.burst = 1; bot.burst(P.popper, 26); } }
  },
  'happy-bounce': {
    pose(t, p) {
      const b = hop(t, 1.7);
      p.y = 0.32 * b;
      p.lKnee = p.rKnee = 0.9 * (1 - b) * 0.4 + 0.7 * b; p.lLift = p.rLift = 0.35 * b;
      p.lOut = p.rOut = 2.0 + 0.3 * b; p.lEl = p.rEl = 0.4 - 0.3 * b; p.lCurl = p.rCurl = 0.1;
      p.hx = -0.2 * b;
    },
    face: () => ({ eyes: 'joy', mouth: 'grin' })
  },
  tada: {
    pose(t, p) {
      const k = smooth((t - 0.15) / 0.35);
      // A jump into the pose, like the photo: arms flung wide, one knee up.
      const j = window4(t, 0, 0.25, 0.45, 0.8);
      p.y = 0.35 * j;
      p.rLift = 0.9 * j; p.rKnee = 1.5 * j;
      // Then: left hand on hip, right arm pointing up at the checkmark.
      p.lOut = 0.65 * k + 1.6 * j; p.lEl = 1.9 * k; p.lTw = -0.9 * k; p.lFwd = -0.35 * k;
      p.rOut = 2.35 * k + 1.6 * j * (1 - k); p.rEl = 0.05; p.rCurl = 0.85 * k; p.rFwd = 0.2 * k;
      p.sx = -0.08 * k; p.hy = -0.25 * k; p.hx = -0.3 * k;
      p.lSpread = 0.12 * k; p.rSpread = 0.12 * k;
      p.rz = 0.05 * k;
    },
    props: ['check'],
    face: t => ({ eyes: t > 0.5 ? 'wink' : 'joy', mouth: 'grin', lx: -0.5, ly: -0.7 }),
    fx(t, P) {
      const s = smooth((t - 0.35) / 0.3);
      P.check.scale.setScalar(0.55 * s * (1 + 0.08 * Math.sin(t * 6)));
      P.check.position.y = 3.05 + 0.06 * Math.sin(t * 3);
    }
  },
  // ---- Curious & playful ----
  'tap-peek': {
    pose(t, p) {
      const lean = smooth(t / 0.6);
      const tap = t > 0.8 ? Math.max(0, Math.sin(TAU * 2.5 * t)) : 0;
      p.sx = 0.35 * lean; p.hx = 0.15 * lean; p.y = -0.03 * lean;
      p.lLift = p.rLift = 0.15 * lean; p.lKnee = p.rKnee = 0.3 * lean;
      p.rFwd = 1.0 * lean + 0.25 * tap; p.rEl = 0.5 - 0.3 * tap; p.rCurl = 0.7; p.rOut = 0.25;
      p.lFwd = 0.2; p.lOut = 0.3; p.lEl = 0.8;
      p.hz = 0.15 * Math.sin(0.8 * t);
    },
    face: t => ({ eyes: 'neutral', mouth: 'smile', lx: 0.3 * Math.sin(1.7 * t), ly: 0.4 })
  },
  'butterfly-chase': {
    pose(t, p, bot) {
      const b = bot.butterflyPos;
      const dir = clamp(b.x / 1.2, -1, 1);
      p.hy = 0.6 * dir; p.hx = -0.5 * clamp(b.y - 2.6, -0.6, 1);
      p.ry = 0.35 * dir;
      const reach = Math.max(0, Math.sin(TAU * 0.6 * t));
      if (dir > 0) { p.lOut = 1.4 + 0.8 * reach; p.lEl = 0.3; p.lCurl = 0; } else { p.rOut = 1.4 + 0.8 * reach; p.rEl = 0.3; p.rCurl = 0; }
      p.y = 0.15 * hop(t, 1.2) * reach;
      p.px = 0.12 * dir;
    },
    props: ['butterfly'],
    face: (t, bot) => ({ eyes: 'wide', mouth: 'o', lx: clamp(bot.butterflyPos.x, -1, 1), ly: -0.6 }),
    fx(t, P, bot) {
      const x = 1.15 * Math.sin(0.9 * t), y = 2.75 + 0.45 * Math.sin(1.7 * t), z = 0.6 + 0.2 * Math.cos(1.3 * t);
      P.butterfly.position.set(x, y, z);
      bot.butterflyPos.set(x, y, z);
      const flap = 0.2 + 0.9 * Math.abs(Math.sin(t * 18));
      P.butterfly.children[0].rotation.y = flap; P.butterfly.children[1].rotation.y = -flap;
      P.butterfly.scale.setScalar(t > 4.2 ? Math.max(0.001, 1 - (t - 4.2) * 4) : 1);
      if (t > 4.2 && !P.butterfly.userData.popped) { P.butterfly.userData.popped = 1; bot.burst(P.butterfly, 12); }
    }
  },
  'head-tilt': {
    pose(t, p) {
      const k = smooth(t / 0.5);
      p.hz = 0.55 * k + 0.05 * Math.sin(1.3 * t); p.hx = -0.05;
      p.rFwd = 0.9 * k; p.rEl = 2.1 * k; p.rOut = 0.15; p.rCurl = 0.7;
      p.lFwd = 0.45; p.lEl = 1.5; p.lOut = 0.1;
      p.rz = 0.04 * Math.sin(0.9 * t);
    },
    face: t => ({ eyes: 'question', mouth: 'side', lx: 0.25 * Math.sin(2.1 * t) })
  },
  magnify: {
    pose(t, p) {
      const k = smooth(t / 0.5);
      p.rFwd = 1.55 * k; p.rEl = 0.5 * k; p.rOut = 0.05; p.rCurl = 1;
      p.sx = 0.22 * k + 0.06 * Math.sin(0.9 * t); p.hx = 0.15 * k;
      p.hy = 0.35 * Math.sin(0.9 * t); p.sy = 0.2 * Math.sin(0.9 * t);
      p.lOut = 0.3; p.lEl = 1.2; p.lFwd = 0.4; p.lTw = -0.6;
    },
    props: ['magnifier'],
    face: t => ({ eyes: 'big', mouth: 'o', lx: 0.8 * Math.sin(0.9 * t), ly: 0.3 })
  },
  peekaboo: {
    pose(t, p) {
      const cover = smooth(t / 0.35);
      const peek = window4(t, 2.0, 2.4, 3.6, 4.0);
      p.hunch = cover;
      p.lFwd = p.rFwd = 1.8 * cover; p.lEl = p.rEl = 0.7 * cover;
      p.lOut = p.rOut = 0.55 * cover + 0.35 * peek; p.lCurl = p.rCurl = 0.15;
      p.lTw = p.rTw = 0;
      p.hx = 0.5 * cover - 0.25 * peek; p.sx = 0.18 * cover;
      p.lKnee = p.rKnee = 0.35 * cover; p.lLift = p.rLift = 0.2 * cover;
      p.px = 0.025 * Math.sin(t * 50) * (1 - peek);
    },
    props: ['alarm'],
    face: t => ({ eyes: window4(t, 2.0, 2.3, 3.7, 4.0) > 0.5 ? 'wide' : 'shut', mouth: 'wavy', color: RED }),
    fx(t, P) { P.alarm.material.opacity = 0.5 + 0.5 * Math.sin(t * 16); }
  },
  // ---- Work ----
  typing: {
    pose(t, p) {
      p.lFwd = 0.95 + 0.12 * sin(t, 7); p.rFwd = 0.95 + 0.12 * sin(t, 7, Math.PI);
      p.lEl = 1.0 + 0.1 * sin(t, 7, 1); p.rEl = 1.0 + 0.1 * sin(t, 7, 2);
      p.lOut = 0.35 + 0.05 * sin(t, 1.3); p.rOut = 0.35 - 0.05 * sin(t, 1.3);
      p.lCurl = p.rCurl = 0.25;
      p.hx = 0.32; p.sx = 0.12; p.hz = 0.04 * sin(t, 0.5);
      p.y = 0.008 * sin(t, 7);
    },
    props: ['keyboard'],
    face: t => ({ eyes: 'focus', mouth: 'flat', ly: 0.8, lx: 0.4 * Math.sin(3 * t) }),
    fx(t, P) { P.keyboard.material.opacity = 0.55 + 0.15 * Math.sin(t * 14); }
  },
  'heavy-lift': {
    pose(t, p) {
      const c = t % 3.4;
      const lift = smooth(c / 0.6), wobble = window4(c, 0.6, 0.9, 2.2, 2.4), toss = smooth((c - 2.3) / 0.35);
      p.lOut = p.rOut = 2.6 * lift * (1 - toss) + 0.3; p.lEl = p.rEl = 0.6; p.lCurl = p.rCurl = 0.1;
      p.lFwd = p.rFwd = 0.2 + 1.2 * toss;
      p.y = -0.08 * wobble; p.lKnee = p.rKnee = 0.5 * wobble; p.lLift = p.rLift = 0.25 * wobble;
      p.px = -0.12 * wobble * (0.5 + 0.5 * Math.sin(c * 9));
      p.rz = 0.1 * wobble * Math.sin(c * 6);
      p.sx = -0.15 * wobble + 0.25 * toss; p.hx = -0.3 * lift * (1 - toss);
    },
    props: ['file'],
    face: t => ((t % 3.4) < 2.3 ? { eyes: 'strain', mouth: 'teeth' } : { eyes: 'happy', mouth: 'smile' }),
    fx(t, P) {
      const c = t % 3.4;
      const toss = smooth((c - 2.3) / 0.6);
      P.file.position.set(-1.6 * toss, 3.1 - 0.7 * smooth((c - 0.6) / 0.3) * 0 + 0.3 * Math.sin(Math.PI * toss) - 1.4 * toss * toss, 0.5 + 0.9 * toss);
      P.file.rotation.z = 3 * toss; P.file.scale.setScalar(c < 0.2 ? c * 5 : 1 - 0.8 * toss);
    }
  },
  'bug-zap': {
    pose(t, p) {
      const k = smooth(t / 0.4);
      p.rFwd = 1.3 * k; p.rEl = 0.2; p.rOut = 0.5 + 0.35 * Math.sin(1.6 * t); p.rCurl = 1;
      p.lOut = 0.6; p.lEl = 1.8; p.lTw = -0.9; p.lFwd = -0.3;
      p.hy = 0.4 * Math.sin(1.6 * t); p.sy = 0.15 * Math.sin(1.6 * t);
      p.hx = 0.1;
    },
    props: ['laser', 'bug'],
    face: t => ({ eyes: 'focus', mouth: 'grin', lx: Math.sin(1.6 * t), ly: 0.5 }),
    fx(t, P, bot) {
      const bx = 0.95 * Math.sin(1.6 * t), bz = 0.55;
      P.bug.position.set(bx, 0.08, bz);
      P.bug.rotation.y = Math.cos(1.6 * t) > 0 ? -Math.PI / 2 : Math.PI / 2;
      const zap = (t % 1.2) > 0.9;
      P.laser.userData.beam.visible = zap;
      if (zap) bot.aimBeam(P.laser.userData.beam, P.bug);
      P.bug.scale.setScalar(zap ? 0.7 + 0.3 * Math.sin(t * 60) : 1);
    }
  },
  'drink-sip': {
    pose(t, p) {
      const up = window4(t, 0.2, 0.8, 1.9, 2.4);
      p.rFwd = 0.4 + 1.0 * up; p.rEl = 0.6 + 1.6 * up; p.rOut = 0.25; p.rCurl = 1;
      p.hx = -0.35 * window4(t, 0.7, 1.0, 1.7, 1.9);
      p.sx = -0.05 * up;
      p.y = 0.03 * window4(t, 2.0, 2.2, 2.4, 2.8); // the happy sigh
    },
    props: ['bottle'],
    face: t => (t > 1.9 ? { eyes: 'happy', mouth: 'smile' } : t > 0.8 ? { eyes: 'shut', mouth: 'o' } : { eyes: 'neutral', mouth: 'smile', ly: 0.5, lx: -0.5 })
  },
  wrench: {
    pose(t, p) {
      const k = smooth(t / 0.4);
      const turn = Math.sin(TAU * 1.8 * t);
      p.rFwd = 1.0 * k; p.rEl = 0.9; p.rOut = 0.4 + 0.25 * turn * k; p.rTw = -0.6 * turn * k; p.rCurl = 1;
      p.lFwd = 0.8 * k; p.lEl = 0.9; p.lOut = 0.45; p.lCurl = 0.8;
      p.sx = 0.15; p.hx = 0.25; p.rz = 0.05 * turn;
      p.lKnee = p.rKnee = 0.25; p.lLift = p.rLift = 0.12;
    },
    props: ['wrench', 'statusbar'],
    face: () => ({ eyes: 'strain', mouth: 'side', ly: 0.6 }),
    fx(t, P) { P.statusbar.material.opacity = 0.35 + 0.35 * Math.abs(Math.sin(t * 3)); }
  },
  // ---- Idle, sleep & funny ----
  'power-nap': {
    pose(t, p) {
      const k = smooth(t / 1.2);
      p.sit = k;
      p.lLift = p.rLift = 1.35 * k; p.lSpread = p.rSpread = 0.22 * k; p.lKnee = p.rKnee = 0.25 * k;
      p.sx = 0.04 * k + 0.02 * sin(t, 0.22); p.hx = 0.32 * k + 0.04 * sin(t, 0.22);
      p.hz = 0.2 * k;
      p.lFwd = p.rFwd = 0.45 * k; p.lEl = p.rEl = 0.5 * k; p.lOut = p.rOut = 0.22 * k;
    },
    face: (t) => ({ eyes: 'shut', mouth: 'o', dim: 0.45 + 0.1 * Math.sin(t) })
  },
  'yawn-stretch': {
    pose(t, p) {
      const up = window4(t, 0.1, 0.8, 2.0, 2.6);
      p.lOut = p.rOut = 0.15 + 2.75 * up; p.lEl = p.rEl = 0.1; p.lCurl = p.rCurl = 0.9 * up;
      p.sx = -0.18 * up; p.hx = -0.3 * up;
      p.y = 0.05 * up;
      p.rz = 0.08 * up * Math.sin(2.2 * t);
    },
    face: t => (t < 2.1 ? { eyes: 'shut', mouth: 'yawn' } : { eyes: 'happy', mouth: 'smile' })
  },
  'headphone-jam': {
    pose(t, p) {
      const b = hop(t, 2);
      p.hx = 0.22 * b - 0.05; p.y = 0.03 * b;
      p.lKnee = p.rKnee = 0.2 * b; p.lLift = p.rLift = 0.1 * b;
      p.rz = 0.06 * sin(t, 0.5);
      p.rFwd = 0.7; p.rOut = 1.0; p.rEl = 2.2; p.rTw = 0.4; p.rCurl = 0.5; // hand on the ear cup
      p.lFwd = 0.5 + 0.3 * sin(t, 1); p.lEl = 1.3; p.lOut = 0.3; p.lCurl = 0.8;
      p.hz = 0.1 * sin(t, 0.5);
    },
    props: ['headphones'],
    face: t => ({ eyes: 'happy', mouth: (t % 2) < 1 ? 'smile' : 'grin' }),
    fx(t, P) { P.headphones.userData.glow.material.opacity = 0.5 + 0.5 * hop(t, 2); }
  },
  'surprise-jump': {
    pose(t, p) {
      const j = window4(t, 0, 0.18, 0.45, 0.75);
      p.y = 0.55 * j;
      p.lOut = p.rOut = 0.2 + 2.2 * j; p.lEl = p.rEl = 0.3; p.lCurl = p.rCurl = 0;
      p.lKnee = p.rKnee = 0.6 * j; p.lLift = p.rLift = 0.2 * j;
      p.hx = -0.2 * j;
      const land = window4(t, 0.7, 0.8, 0.9, 1.2);
      p.lKnee += 0.4 * land; p.rKnee += 0.4 * land; p.lLift += 0.2 * land; p.rLift += 0.2 * land;
    },
    props: ['alert'],
    face: t => ({ eyes: t < 1.3 ? 'big' : 'happy', mouth: t < 1.3 ? 'o' : 'smile' }),
    fx(t, P) { P.alert.scale.setScalar(0.45 * window4(t, 0.05, 0.2, 1.3, 1.6)); }
  },
  'cheer-wave': {
    pose(t, p) {
      const k = smooth(t / 0.35);
      const w = Math.sin(TAU * 2 * t);
      p.lOut = (2.45 + 0.3 * w) * k; p.rOut = (2.45 - 0.3 * w) * k;
      p.lEl = p.rEl = 0.25; p.lCurl = p.rCurl = 0;
      p.y = 0.08 * hop(t, 2); p.lKnee = p.rKnee = 0.2 * hop(t, 2);
      p.hz = 0.15 * w; p.rz = 0.04 * w;
    },
    face: () => ({ eyes: 'joy', mouth: 'grin' })
  }
};

// ---- Drawing helpers ----------------------------------------------------------
function roundedBox(THREE, w, h, d, r, seg = 6) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const pos = g.attributes.position, nor = g.attributes.normal;
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  const v = new THREE.Vector3(), inner = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    inner.set(clamp(v.x, -hx, hx), clamp(v.y, -hy, hy), clamp(v.z, -hz, hz));
    v.sub(inner).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
    v.multiplyScalar(r).add(inner);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

// The LED face: eyes and a mouth in glowing cyan on the black visor.
function drawFace(ctx, f, blink) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const col = f.color || CYAN;
  ctx.save();
  ctx.globalAlpha = f.dim == null ? 1 : f.dim;
  ctx.fillStyle = col; ctx.strokeStyle = col;
  ctx.shadowColor = col; ctx.shadowBlur = 18;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const lx = clamp(f.lx || 0, -1, 1) * 11, ly = clamp(f.ly || 0, -1, 1) * 7;
  // Drawn at 1.35x around the screen's middle, so the eyes are big like the photo.
  ctx.translate(W / 2, H / 2); ctx.scale(1.38, 1.38); ctx.translate(-128, -100);
  const eyeY = 88 + ly, mouthY = 140 + ly * 0.5;
  const eyes = [[94 + lx, eyeY], [162 + lx, eyeY]];
  const open = blink ? 0.12 : 1;
  const drawEye = (kind, x, y, side) => {
    ctx.lineWidth = 9;
    switch (kind) {
      case 'happy': // the smiling crescent from the photo
        ctx.beginPath(); ctx.ellipse(x, y + 4, 22, 24 * open, 0, Math.PI, 0); ctx.closePath(); ctx.fill();
        break;
      case 'joy':
        ctx.beginPath(); ctx.moveTo(x - 18, y + 8); ctx.quadraticCurveTo(x, y - 22, x + 18, y + 8); ctx.stroke();
        break;
      case 'focus':
        rr(ctx, x - 18, y - 8 * open, 36, 16 * open + 0.5, 8); ctx.fill();
        break;
      case 'strain':
        ctx.beginPath(); ctx.moveTo(x - 16 * side, y - 12); ctx.lineTo(x + 14 * side, y); ctx.lineTo(x - 16 * side, y + 12); ctx.stroke();
        break;
      case 'shut':
        ctx.beginPath(); ctx.moveTo(x - 18, y); ctx.quadraticCurveTo(x, y + 12, x + 18, y); ctx.stroke();
        break;
      case 'wide': case 'big':
        ctx.beginPath(); ctx.ellipse(x, y, kind === 'big' ? 25 : 21, (kind === 'big' ? 28 : 24) * open, 0, 0, TAU); ctx.fill();
        ctx.save(); ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath(); ctx.arc(x + 7, y - 8 * open, 7 * open, 0, TAU); ctx.fill(); ctx.restore();
        break;
      case 'question':
        ctx.save(); ctx.font = 'bold 64px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('?', x, y + 2); ctx.restore();
        break;
      case 'x':
        ctx.beginPath(); ctx.moveTo(x - 15, y - 15); ctx.lineTo(x + 15, y + 15); ctx.moveTo(x + 15, y - 15); ctx.lineTo(x - 15, y + 15); ctx.stroke();
        break;
      default: // neutral: soft rounded LED blocks
        rr(ctx, x - 19, y - 23 * open, 38, 46 * open + 0.5, 16); ctx.fill();
    }
  };
  if (f.eyes === 'wink') { drawEye('neutral', eyes[0][0], eyes[0][1], 1); drawEye('joy', eyes[1][0], eyes[1][1], -1); } else {
    drawEye(f.eyes, eyes[0][0], eyes[0][1], 1); drawEye(f.eyes, eyes[1][0], eyes[1][1], -1);
  }
  const mx = 128 + lx * 0.6;
  ctx.lineWidth = 8;
  switch (f.mouth) {
    case 'grin': // the open "D" smile
      ctx.beginPath(); ctx.moveTo(mx - 24, mouthY - 8); ctx.lineTo(mx + 24, mouthY - 8); ctx.quadraticCurveTo(mx + 22, mouthY + 22, mx, mouthY + 22); ctx.quadraticCurveTo(mx - 22, mouthY + 22, mx - 24, mouthY - 8); ctx.fill();
      break;
    case 'o':
      ctx.beginPath(); ctx.ellipse(mx, mouthY + 2, 9, 11, 0, 0, TAU); ctx.stroke();
      break;
    case 'yawn':
      ctx.beginPath(); ctx.ellipse(mx, mouthY + 4, 16, 20, 0, 0, TAU); ctx.fill();
      break;
    case 'flat':
      ctx.beginPath(); ctx.moveTo(mx - 14, mouthY); ctx.lineTo(mx + 14, mouthY); ctx.stroke();
      break;
    case 'side':
      ctx.beginPath(); ctx.moveTo(mx - 14, mouthY + 4); ctx.quadraticCurveTo(mx + 4, mouthY + 6, mx + 16, mouthY - 6); ctx.stroke();
      break;
    case 'wavy':
      ctx.beginPath(); ctx.moveTo(mx - 24, mouthY);
      for (let i = 1; i <= 6; i++) ctx.lineTo(mx - 24 + i * 8, mouthY + (i % 2 ? -6 : 6));
      ctx.stroke();
      break;
    case 'teeth':
      rr(ctx, mx - 22, mouthY - 9, 44, 18, 6); ctx.stroke();
      ctx.beginPath(); for (let i = -1; i <= 1; i++) { ctx.moveTo(mx + i * 11, mouthY - 9); ctx.lineTo(mx + i * 11, mouthY + 9); } ctx.moveTo(mx - 22, mouthY); ctx.lineTo(mx + 22, mouthY); ctx.lineWidth = 3; ctx.stroke();
      break;
    default: // smile
      ctx.beginPath(); ctx.moveTo(mx - 20, mouthY - 4); ctx.quadraticCurveTo(mx, mouthY + 18, mx + 20, mouthY - 4); ctx.stroke();
  }
  ctx.restore();
  // LED pixel grid, like the photo's dotted screen.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (let x = 0; x < W; x += 6) ctx.fillRect(x, 0, 1.5, H);
  for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 1.5);
  ctx.restore();
}

// The glowing "CD" monogram on its chest.
function drawLogo(ctx) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 15; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const pink = ctx.createLinearGradient(20, 20, 110, 110);
  pink.addColorStop(0, '#ff5fd2'); pink.addColorStop(1, '#a35bff');
  const blue = ctx.createLinearGradient(90, 20, 180, 110);
  blue.addColorStop(0, '#7d6bff'); blue.addColorStop(1, '#3ee8ff');
  for (const pass of [0, 1]) {
    ctx.shadowBlur = pass ? 4 : 22;
    ctx.shadowColor = '#ff5fd2'; ctx.strokeStyle = pink;
    ctx.beginPath(); ctx.arc(72, 64, 40, 0.28 * Math.PI, 1.72 * Math.PI, false); ctx.stroke();
    ctx.shadowColor = '#3ee8ff'; ctx.strokeStyle = blue;
    ctx.beginPath(); ctx.moveTo(98, 24); ctx.lineTo(118, 24); ctx.arc(118, 64, 40, -Math.PI / 2, Math.PI / 2); ctx.lineTo(98, 104); ctx.closePath(); ctx.stroke();
  }
}

function spriteTexture(THREE, w, h, draw) {
  const c = canvas(w, h);
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- The robot ------------------------------------------------------------------
export function createRobot(THREE, host, options = {}) {
  const reduced = Boolean(options.reducedMotion);
  const disposables = [];
  const keep = x => { disposables.push(x); return x; };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const canvasEl = renderer.domElement;
  canvasEl.className = 'companion-canvas';
  host.appendChild(canvasEl);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 50);

  // A small studio for the chrome to reflect: bright ceiling panel, a soft box and a cyan screen.
  {
    const pm = new THREE.PMREMGenerator(renderer);
    const env = new THREE.Scene();
    const room = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true }));
    const pos = room.geometry.attributes.position, colors = [];
    for (let i = 0; i < pos.count; i++) { const k = clamp((pos.getY(i) + 10) / 20, 0, 1); colors.push(0.12 + 0.6 * k, 0.13 + 0.62 * k, 0.16 + 0.7 * k); }
    room.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    env.add(room);
    const panel = (color, w, h, x, y, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    panel(new THREE.Color(6, 6, 6.2), 8, 3, 0, 8, 2);
    panel(new THREE.Color(3, 3, 3.2), 4, 5, -7, 2, 5);
    panel(new THREE.Color(0.6, 2.4, 3.2), 4, 3, 7, 1, -4);
    panel(new THREE.Color(1.1, 0.45, 1.3), 3, 2, 6, -1, 6);
    const rt = pm.fromScene(env, 0.04);
    scene.environment = keep(rt.texture);
    env.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    pm.dispose();
  }
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x30343c, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-2, 5, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0x6fe6ff, 1.4); rim.position.set(3, 2, -3); scene.add(rim);

  // Materials
  const silver = keep(new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.92, roughness: 0.26, envMapIntensity: 1.25 }));
  const gunmetal = keep(new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.8, roughness: 0.38 }));
  const rubber = keep(new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.3, roughness: 0.55 }));
  const visorMat = keep(new THREE.MeshPhysicalMaterial({ color: 0x050608, metalness: 0.1, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.6 }));
  const glow = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 2.2, 2.6), toneMapped: false }));
  const glowSoft = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 1.6, 1.8), toneMapped: false }));
  const holo = (color, opacity = 0.5) => keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  const geo = g => keep(g);
  const mesh = (g, m, parent, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); parent.add(o); return o; };

  const robot = new THREE.Group(); scene.add(robot);
  const hips = new THREE.Group(); robot.add(hips);
  mesh(geo(roundedBox(THREE, 0.56, 0.24, 0.42, 0.1)), silver, hips);

  // Torso: segmented black abdomen with cyan strips, a chrome chest shell and the logo.
  const spine = new THREE.Group(); spine.position.y = 0.1; hips.add(spine);
  const ab = geo(new THREE.CylinderGeometry(0.235, 0.21, 0.075, 28));
  for (let i = 0; i < 3; i++) mesh(ab, rubber, spine, 0, 0.06 + i * 0.085, 0).scale.set(1 - i * 0.02 + 0.06 * i, 1, 0.82);
  const strip = geo(roundedBox(THREE, 0.03, 0.2, 0.03, 0.012, 2));
  mesh(strip, glow, spine, 0.15, 0.16, 0.16).rotation.z = -0.1;
  mesh(strip, glow, spine, -0.15, 0.16, 0.16).rotation.z = 0.1;
  const chest = mesh(geo(roundedBox(THREE, 0.82, 0.48, 0.54, 0.2, 8)), silver, spine, 0, 0.5, 0);
  chest.scale.set(1, 1, 1);
  const logoCanvas = canvas(200, 128); drawLogo(logoCanvas.getContext('2d'));
  const logoTex = keep(new THREE.CanvasTexture(logoCanvas)); logoTex.colorSpace = THREE.SRGBColorSpace;
  const logoMat = keep(new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, toneMapped: false, depthWrite: false }));
  const logo = mesh(geo(new THREE.PlaneGeometry(0.34, 0.22)), logoMat, spine, 0, 0.54, 0.272);
  logo.renderOrder = 2;
  // Shoulder seams like the photo's chest plates.
  mesh(geo(new THREE.TorusGeometry(0.12, 0.012, 6, 20)), gunmetal, spine, 0.4, 0.62, 0).rotation.y = Math.PI / 2;
  mesh(geo(new THREE.TorusGeometry(0.12, 0.012, 6, 20)), gunmetal, spine, -0.4, 0.62, 0).rotation.y = Math.PI / 2;

  // Head
  const neck = new THREE.Group(); neck.position.y = 0.76; spine.add(neck);
  mesh(geo(new THREE.CylinderGeometry(0.11, 0.13, 0.16, 16)), rubber, neck, 0, 0.06, 0);
  const head = new THREE.Group(); head.position.y = 0.12; neck.add(head);
  mesh(geo(roundedBox(THREE, 1.28, 1.08, 1.06, 0.4, 10)), silver, head, 0, 0.52, 0);
  mesh(geo(roundedBox(THREE, 1.08, 0.84, 0.3, 0.2, 8)), visorMat, head, 0, 0.53, 0.42);
  const faceCanvas = canvas(256, 200);
  const faceCtx = faceCanvas.getContext('2d');
  const faceTex = keep(new THREE.CanvasTexture(faceCanvas)); faceTex.colorSpace = THREE.SRGBColorSpace;
  const faceMat = keep(new THREE.MeshBasicMaterial({ map: faceTex, transparent: true, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }));
  const face = mesh(geo(new THREE.PlaneGeometry(0.92, 0.72)), faceMat, head, 0, 0.53, 0.576);
  face.renderOrder = 3;
  // Ear pods with glowing rings, and the little antenna fins.
  for (const s of [1, -1]) {
    const ear = new THREE.Group(); ear.position.set(0.66 * s, 0.5, -0.02); head.add(ear);
    mesh(geo(new THREE.CylinderGeometry(0.22, 0.22, 0.16, 28)), silver, ear).rotation.z = Math.PI / 2;
    mesh(geo(new THREE.CylinderGeometry(0.15, 0.15, 0.06, 24)), gunmetal, ear, 0.09 * s, 0, 0).rotation.z = Math.PI / 2;
    mesh(geo(new THREE.TorusGeometry(0.15, 0.014, 6, 28)), glowSoft, ear, 0.11 * s, 0, 0).rotation.y = Math.PI / 2;
    const fin = mesh(geo(roundedBox(THREE, 0.06, 0.44, 0.16, 0.03, 3)), silver, ear, 0.02 * s, 0.32, -0.04);
    fin.rotation.z = -0.38 * s; fin.rotation.x = -0.15;
  }

  // Arms
  const arm = s => {
    const shoulder = new THREE.Group(); shoulder.position.set(0.47 * s, 0.6, 0); shoulder.rotation.order = 'ZXY'; spine.add(shoulder);
    mesh(geo(new THREE.SphereGeometry(0.115, 18, 12)), gunmetal, shoulder);
    mesh(geo(new THREE.CapsuleGeometry(0.085, 0.2, 6, 14)), silver, shoulder, 0, -0.19, 0);
    const elbow = new THREE.Group(); elbow.position.y = -0.37; shoulder.add(elbow);
    mesh(geo(new THREE.SphereGeometry(0.075, 14, 10)), rubber, elbow);
    mesh(geo(new THREE.CapsuleGeometry(0.08, 0.18, 6, 14)), silver, elbow, 0, -0.16, 0);
    mesh(geo(new THREE.TorusGeometry(0.083, 0.014, 6, 22)), glowSoft, elbow, 0, -0.27, 0).rotation.x = Math.PI / 2;
    const hand = new THREE.Group(); hand.position.y = -0.33; elbow.add(hand);
    mesh(geo(roundedBox(THREE, 0.07, 0.13, 0.14, 0.03, 3)), gunmetal, hand, 0, -0.06, 0);
    const fingers = [];
    const fg = geo(new THREE.CapsuleGeometry(0.019, 0.06, 4, 8));
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Group(); f.position.set(0, -0.12, -0.05 + i * 0.033); hand.add(f);
      mesh(fg, rubber, f, 0, -0.04, 0);
      f.userData.spread = (i - 1.5) * 0.12;
      fingers.push(f);
    }
    const thumb = new THREE.Group(); thumb.position.set(-0.03 * s, -0.06, 0.07); hand.add(thumb);
    mesh(fg, rubber, thumb, 0, -0.04, 0); thumb.rotation.x = -0.7;
    const grip = new THREE.Group(); grip.position.set(-0.02 * s, -0.11, 0); hand.add(grip);
    return { shoulder, elbow, hand, fingers, thumb, grip, s };
  };
  const L = arm(1), R = arm(-1);

  // Legs
  const leg = s => {
    const hip = new THREE.Group(); hip.position.set(0.16 * s, -0.1, 0); hips.add(hip);
    mesh(geo(new THREE.SphereGeometry(0.1, 14, 10)), rubber, hip);
    mesh(geo(new THREE.CapsuleGeometry(0.105, 0.17, 6, 14)), silver, hip, 0, -0.16, 0);
    const knee = new THREE.Group(); knee.position.y = -0.33; hip.add(knee);
    mesh(geo(new THREE.SphereGeometry(0.09, 14, 10)), gunmetal, knee);
    mesh(geo(new THREE.SphereGeometry(0.06, 12, 8)), silver, knee, 0, 0, 0.07);
    mesh(geo(new THREE.CapsuleGeometry(0.1, 0.18, 6, 14)), silver, knee, 0, -0.18, 0);
    const ankle = new THREE.Group(); ankle.position.y = -0.36; knee.add(ankle);
    mesh(geo(roundedBox(THREE, 0.22, 0.13, 0.32, 0.06, 4)), silver, ankle, 0, -0.07, 0.04);
    mesh(geo(roundedBox(THREE, 0.2, 0.04, 0.3, 0.02, 2)), rubber, ankle, 0, -0.13, 0.04);
    return { hip, knee, ankle };
  };
  const LL = leg(1), RL = leg(-1);
  const THIGH = 0.33, SHIN = 0.36, ANKLE_H = 0.15;
  const STAND = THIGH + SHIN + ANKLE_H + 0.1; // hips height when standing straight

  // Soft contact shadow.
  const shadowTex = keep(spriteTexture(THREE, 64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }));
  const shadow = mesh(geo(new THREE.PlaneGeometry(1.4, 0.7)), keep(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })), scene, 0, 0.002, 0.05);
  shadow.rotation.x = -Math.PI / 2;

  // ---- Props ----------------------------------------------------------------------
  const P = {};
  const cyanHolo = new THREE.Color(0.35, 1.6, 2.0);
  {
    // Holographic keyboard in front of its tummy.
    const keysTex = keep(spriteTexture(THREE, 256, 96, (c, w, h) => {
      c.strokeStyle = '#7ff4ff'; c.lineWidth = 3; c.fillStyle = 'rgba(80,220,255,0.25)';
      c.fillRect(2, 2, w - 4, h - 4); c.strokeRect(2, 2, w - 4, h - 4);
      for (let r = 0; r < 3; r++) for (let k = 0; k < 10; k++) c.strokeRect(10 + k * 24 + (r % 2) * 6, 10 + r * 26, 18, 18);
    }));
    const kb = new THREE.Mesh(geo(new THREE.PlaneGeometry(0.85, 0.32)), keep(new THREE.MeshBasicMaterial({ map: keysTex, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })));
    kb.rotation.x = -1.2; kb.position.set(0, 1.27, 0.68);
    robot.add(kb); P.keyboard = kb;
  }
  {
    // An oversized holographic magnifier held up to one eye; it follows the head as it scans.
    const g = new THREE.Group();
    mesh(geo(new THREE.TorusGeometry(0.3, 0.035, 10, 40)), silver, g);
    mesh(geo(new THREE.CircleGeometry(0.29, 40)), holo(cyanHolo, 0.22), g);
    const handle = mesh(geo(new THREE.CylinderGeometry(0.035, 0.04, 0.5, 10)), gunmetal, g, 0.1, -0.53, -0.05);
    handle.rotation.z = 0.2;
    g.position.set(-0.24, 0.48, 0.92); g.rotation.z = -0.15;
    head.add(g); P.magnifier = g;
  }
  {
    const g = new THREE.Group();
    mesh(geo(roundedBox(THREE, 0.05, 0.05, 0.36, 0.02, 2)), silver, g, 0, 0, 0.12);
    const head = mesh(geo(new THREE.TorusGeometry(0.07, 0.03, 8, 16, Math.PI * 1.5)), silver, g, 0, 0, 0.33);
    head.rotation.set(Math.PI / 2, 0, Math.PI * 0.75);
    R.grip.add(g); P.wrench = g;
    const bar = new THREE.Mesh(geo(roundedBox(THREE, 0.9, 0.09, 0.02, 0.04, 2)), holo(new THREE.Color(0.4, 2.2, 0.9), 0.5));
    bar.position.set(0, 1.55, 0.95); robot.add(bar); P.statusbar = bar;
  }
  {
    const g = new THREE.Group();
    mesh(geo(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 10)), gunmetal, g, 0, 0, 0.06).rotation.x = Math.PI / 2;
    mesh(geo(new THREE.SphereGeometry(0.02, 8, 6)), keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.3, 0.6), toneMapped: false })), g, 0, 0, 0.18);
    R.grip.add(g); P.laser = g;
    const beam = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.008, 0.008, 1, 6)), keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.2, 0.5), toneMapped: false })));
    beam.visible = false; scene.add(beam); g.userData.beam = beam; g.userData.tip = g.children[1];
    const bugTex = keep(spriteTexture(THREE, 64, 64, (c) => {
      c.fillStyle = '#ff4d6a'; c.shadowColor = '#ff4d6a'; c.shadowBlur = 8;
      c.beginPath(); c.ellipse(32, 36, 14, 18, 0, 0, TAU); c.fill();
      c.fillStyle = '#20232a'; c.beginPath(); c.arc(32, 16, 8, 0, TAU); c.fill();
      c.strokeStyle = '#ff4d6a'; c.lineWidth = 3;
      for (const y of [28, 38, 48]) { c.beginPath(); c.moveTo(18, y); c.lineTo(6, y - 4); c.moveTo(46, y); c.lineTo(58, y - 4); c.stroke(); }
    }));
    const bug = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: bugTex, transparent: true })));
    bug.scale.setScalar(0.22); scene.add(bug); P.bug = bug;
  }
  {
    // The little CodeDev bottle from the photo.
    const g = new THREE.Group();
    const glass = keep(new THREE.MeshPhysicalMaterial({ color: 0x9fdcff, metalness: 0, roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.85 }));
    mesh(geo(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 18)), glass, g);
    mesh(geo(new THREE.CylinderGeometry(0.065, 0.065, 0.16, 18)), keep(new THREE.MeshStandardMaterial({ color: 0x1f8fff, emissive: 0x0b4fd0, emissiveIntensity: 0.6, roughness: 0.3 })), g, 0, -0.025, 0);
    mesh(geo(new THREE.CylinderGeometry(0.04, 0.05, 0.06, 14)), rubber, g, 0, 0.14, 0);
    const label = mesh(geo(new THREE.PlaneGeometry(0.1, 0.07)), logoMat, g, 0, 0, 0.073);
    label.renderOrder = 2;
    g.rotation.x = 1.1; g.position.set(0, 0.04, 0.05);
    const holder = new THREE.Group(); holder.add(g); holder.scale.setScalar(1.7); R.grip.add(holder); P.bottle = holder;
  }
  {
    // A floating data file to haul about.
    const fileTex = keep(spriteTexture(THREE, 128, 128, (c) => {
      c.fillStyle = 'rgba(70,170,255,0.35)'; c.strokeStyle = '#8fd8ff'; c.lineWidth = 6; c.shadowColor = '#4fc3ff'; c.shadowBlur = 12;
      c.beginPath(); c.moveTo(24, 10); c.lineTo(80, 10); c.lineTo(104, 34); c.lineTo(104, 118); c.lineTo(24, 118); c.closePath(); c.fill(); c.stroke();
      c.font = 'bold 26px monospace'; c.fillStyle = '#d6f4ff'; c.fillText('{ }', 38, 80);
    }));
    const s = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: fileTex, transparent: true, depthWrite: false })));
    s.scale.set(0.75, 0.75, 1);
    const g = new THREE.Group(); g.add(s); robot.add(g); P.file = g;
  }
  {
    const g = new THREE.Group();
    mesh(geo(new THREE.ConeGeometry(0.07, 0.24, 14, 1, true)), keep(new THREE.MeshStandardMaterial({ color: 0xff5fd2, metalness: 0.4, roughness: 0.3, side: THREE.DoubleSide })), g, 0, 0.12, 0).rotation.x = Math.PI;
    g.rotation.x = -0.4; g.position.set(0, 0, 0.04);
    const holder = new THREE.Group(); holder.add(g); holder.rotation.x = Math.PI; R.grip.add(holder);
    g.userData = {}; holder.userData.burst = 0; P.popper = holder;
  }
  {
    const tex = keep(spriteTexture(THREE, 128, 128, (c) => {
      c.strokeStyle = '#7ff4ff'; c.fillStyle = 'rgba(70,200,255,0.18)'; c.lineWidth = 7; c.shadowColor = '#4fe8ff'; c.shadowBlur = 14;
      rr(c, 14, 12, 100, 84, 18); c.fill(); c.stroke();
      c.beginPath(); c.moveTo(48, 96); c.lineTo(60, 118); c.lineTo(72, 96); c.stroke();
      c.lineWidth = 11; c.lineCap = 'round'; c.beginPath(); c.moveTo(38, 56); c.lineTo(56, 74); c.lineTo(92, 36); c.stroke();
    }));
    const s = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })));
    s.position.set(-1.0, 3.05, 0.2); robot.add(s); P.check = s;
  }
  {
    const tex = keep(spriteTexture(THREE, 128, 128, (c) => {
      c.fillStyle = '#ffd166'; c.shadowColor = '#ffb703'; c.shadowBlur = 14;
      c.beginPath(); c.arc(64, 64, 44, 0, TAU); c.fill();
      c.fillStyle = '#20232a'; c.font = 'bold 72px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.shadowBlur = 0; c.fillText('!', 64, 68);
    }));
    const s = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })));
    s.position.set(0.75, 3.1, 0.2); robot.add(s); P.alert = s;
  }
  {
    // A pixel butterfly made of two glowing wings.
    const tex = keep(spriteTexture(THREE, 64, 64, (c) => {
      c.fillStyle = '#ff7ae0'; c.shadowColor = '#ff7ae0'; c.shadowBlur = 10;
      for (const [x, y] of [[8, 10], [16, 10], [8, 18], [16, 18], [24, 18], [8, 26], [16, 26], [16, 34], [8, 42], [16, 42], [24, 34]]) c.fillRect(x, y, 7, 7);
    }));
    const wingMat = keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    const g = new THREE.Group();
    const wg = geo(new THREE.PlaneGeometry(0.26, 0.26)); wg.translate(0.13, 0, 0);
    const w1 = new THREE.Group(); mesh(wg, wingMat, w1); g.add(w1);
    const w2 = new THREE.Group(); mesh(wg, wingMat, w2).scale.x = -1; g.add(w2);
    robot.add(g); g.userData.popped = 0; P.butterfly = g;
  }
  {
    const g = new THREE.Group();
    mesh(geo(new THREE.TorusGeometry(0.7, 0.045, 8, 32, Math.PI)), gunmetal, g, 0, 0, 0);
    const glowRing = mesh(geo(new THREE.TorusGeometry(0.7, 0.02, 6, 32, Math.PI)), holo(new THREE.Color(2.2, 0.6, 2.4), 0.8), g, 0, 0.02, 0.03);
    for (const s of [1, -1]) mesh(geo(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 24)), holo(new THREE.Color(2.0, 0.5, 2.4), 0.6), g, 0.74 * s, 0, 0).rotation.z = Math.PI / 2;
    g.position.set(0, 0.52, -0.02); head.add(g);
    g.userData.glow = glowRing; P.headphones = g;
  }
  {
    // Hover jets under its feet for the victory spin.
    const g = new THREE.Group();
    const jetMat = holo(new THREE.Color(0.5, 2.0, 2.6), 0.75);
    for (const leg of [LL, RL]) {
      const cone = mesh(geo(new THREE.ConeGeometry(0.09, 0.4, 14, 1, true)), jetMat, leg.ankle, 0, -0.35, 0.04);
      cone.rotation.x = Math.PI; g.userData[leg === LL ? 'l' : 'r'] = cone;
    }
    P.jets = { scale: { setScalar: v => { g.userData.l.scale.setScalar(v); g.userData.r.scale.setScalar(v); } }, set visible(v) { g.userData.l.visible = g.userData.r.visible = v; } };
  }
  {
    const alarm = new THREE.Mesh(geo(new THREE.RingGeometry(1.25, 1.45, 48)), holo(new THREE.Color(2.6, 0.3, 0.5), 0.8));
    alarm.position.set(0, 1.6, -0.6); robot.add(alarm); P.alarm = alarm;
  }
  const allProps = Object.keys(P);
  const showProps = list => { for (const k of allProps) P[k].visible = list.includes(k); };
  showProps([]);

  // Binary-digit sparkles (the 0s and 1s floating around the photo).
  const digitMats = ['#ff7ae0', '#5dffa8', '#4fe8ff', '#ffd166'].flatMap(col => ['0', '1'].map(ch => keep(new THREE.SpriteMaterial({
    map: keep(spriteTexture(THREE, 32, 32, c => { c.font = 'bold 26px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = col; c.shadowColor = col; c.shadowBlur = 6; c.fillText(ch, 16, 17); })),
    transparent: true, depthWrite: false, toneMapped: false
  }))));
  const sparks = [];
  for (let i = 0; i < 36; i++) {
    const s = new THREE.Sprite(digitMats[i % digitMats.length]);
    s.visible = false; s.scale.setScalar(0.12); scene.add(s);
    sparks.push({ s, v: new THREE.Vector3(), life: 0 });
  }
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  function burst(obj, n) {
    obj.getWorldPosition(tmp);
    let made = 0;
    for (const p of sparks) {
      if (p.life > 0) continue;
      p.s.position.copy(tmp); p.life = 1 + Math.random() * 0.6; p.s.visible = true;
      p.v.set((Math.random() - 0.5) * 2.4, 1 + Math.random() * 1.6, (Math.random() - 0.3) * 1.2);
      if (++made >= n) break;
    }
  }
  function drift(dt, from) {
    // A gentle trickle of digits off the hands while it celebrates.
    if (from && Math.random() < dt * 14) {
      const hand = Math.random() < 0.5 ? L.hand : R.hand;
      for (const p of sparks) {
        if (p.life > 0) continue;
        hand.getWorldPosition(p.s.position);
        p.life = 1.1; p.s.visible = true;
        p.v.set((Math.random() - 0.5) * 0.5, -0.2 - Math.random() * 0.5, (Math.random() - 0.5) * 0.4);
        break;
      }
    }
    for (const p of sparks) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.v.y -= dt * 1.4;
      p.s.position.addScaledVector(p.v, dt);
      p.s.material.opacity = 1;
      p.s.scale.setScalar(0.13 * clamp(p.life * 2, 0, 1));
      if (p.life <= 0) p.s.visible = false;
    }
  }
  function aimBeam(beam, target) {
    beam.parent.updateMatrixWorld();
    P.laser.userData.tip.getWorldPosition(tmp);
    target.getWorldPosition(tmp2);
    beam.position.copy(tmp).add(tmp2).multiplyScalar(0.5);
    beam.scale.y = tmp.distanceTo(tmp2);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmp2.sub(tmp).normalize());
  }
  const bot = { burst, aimBeam, butterflyPos: new THREE.Vector3(1, 2.8, 0.6) };

  // ---- State, blending and the frame loop -------------------------------------------
  let state = null, anim = null, started = 0, now = 0;
  let from = null; // the pose on screen when the state changed
  let shown = restPose(0);
  let faceKey = '', nextBlink = 2, blinkUntil = 0;
  const CELEBRATE = new Set(['groove', 'victory-spin', 'confetti', 'happy-bounce', 'tada', 'cheer-wave']);

  function setState(next) {
    next = next && ANIMS[next] ? next : null;
    if (next === state) return;
    state = next; anim = next ? ANIMS[next] : null;
    from = Object.assign({}, shown);
    from.ry = Math.atan2(Math.sin(from.ry), Math.cos(from.ry));
    started = now;
    showProps(anim && anim.props ? anim.props : []);
    if (P.popper) P.popper.userData.burst = 0;
    if (P.butterfly) { P.butterfly.userData.popped = 0; P.butterfly.scale.setScalar(1); }
    if (next === 'tada' || next === 'victory-spin' || next === 'happy-bounce') setTimeout(() => burst(head, 18), 350);
  }

  function pose(t) {
    const p = restPose(now);
    if (anim) anim.pose(t, p, bot);
    if (reduced) { p.y *= 0.3; p.px *= 0.3; p.ry = 0; }
    const w = from ? smooth((now - started) / 0.35) : 1;
    if (w < 1) {
      for (const k of KEYS) {
        if (k === 'ry') { const d = Math.atan2(Math.sin(p.ry - from.ry), Math.cos(p.ry - from.ry)); p.ry = from.ry + d * w; } else p[k] = from[k] + (p[k] - from[k]) * w;
      }
    }
    return p;
  }

  function legDrop(lift, knee, spread) {
    return (THIGH * Math.cos(lift) + SHIN * Math.cos(knee - lift)) * Math.cos(spread);
  }

  function apply(p) {
    const standY = Math.max(legDrop(p.lLift, p.lKnee, p.lSpread), legDrop(p.rLift, p.rKnee, p.rSpread)) + ANKLE_H + 0.1;
    const sitY = 0.2;
    const groundY = standY + (sitY - standY) * clamp(p.sit, 0, 1);
    robot.position.set(p.px, 0, 0);
    hips.position.y = groundY + Math.max(-0.2, p.y);
    robot.rotation.set(0, p.ry, p.rz);
    spine.rotation.set(p.sx, p.sy, p.sz);
    head.rotation.set(p.hx, p.hy, p.hz);
    for (const [A, side, sign] of [[L, 'l', 1], [R, 'r', -1]]) {
      A.shoulder.position.set((0.47 - 0.06 * p.hunch) * sign, 0.6 + 0.1 * p.hunch, 0.24 * p.hunch);
      A.shoulder.rotation.set(-p[side + 'Fwd'], p[side + 'Tw'] * sign, p[side + 'Out'] * sign);
      A.elbow.rotation.set(-p[side + 'El'], 0, 0);
      const c = clamp(p[side + 'Curl'], 0, 1);
      for (const f of A.fingers) { f.rotation.z = c * 1.5 * -sign; f.rotation.x = f.userData.spread * (1 - c); }
      A.thumb.rotation.z = c * 0.9 * -sign;
    }
    for (const [G, side, sign] of [[LL, 'l', 1], [RL, 'r', -1]]) {
      G.hip.rotation.set(-p[side + 'Lift'], 0, p[side + 'Spread'] * sign);
      G.knee.rotation.set(p[side + 'Knee'], 0, 0);
      G.ankle.rotation.set(-(p[side + 'Lift'] - p[side + 'Knee']) * (1 - 0.5 * p.sit), 0, -p[side + 'Spread'] * sign);
    }
    const lift = hips.position.y - STAND;
    shadow.position.x = p.px;
    shadow.scale.setScalar(clamp(1 - lift * 0.8, 0.45, 1.2));
    shadow.material.opacity = clamp(1 - lift, 0.3, 1);
  }

  function drawFaceIfChanged(t) {
    const f = anim && anim.face ? anim.face(t, bot) : { eyes: 'neutral', mouth: 'smile', lx: shown.hy * 1.2 };
    if (now > nextBlink) { blinkUntil = now + 0.12; nextBlink = now + 2.5 + Math.random() * 3; }
    const blink = now < blinkUntil && /^(neutral|happy|focus|wide|big)$/.test(f.eyes || 'neutral');
    const keyStr = [f.eyes, f.mouth, Math.round((f.lx || 0) * 8), Math.round((f.ly || 0) * 8), blink, f.color, f.dim && f.dim.toFixed(1)].join('|');
    if (keyStr === faceKey) return;
    faceKey = keyStr;
    drawFace(faceCtx, f, blink);
    faceTex.needsUpdate = true;
  }

  let width = 0, height = 0;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h || (w === width && h === height)) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Frame the whole figure with room for jumps and raised arms; wide stages show it larger.
    const needH = 3.85, needW = 2.9;
    const fovV = THREE.MathUtils.degToRad(camera.fov);
    const distH = needH / 2 / Math.tan(fovV / 2);
    const distW = needW / 2 / (Math.tan(fovV / 2) * camera.aspect);
    const d = Math.max(distH, distW);
    const yaw = options.yaw || 0;
    camera.position.set(Math.sin(yaw) * d, 1.8 + d * 0.08, Math.cos(yaw) * d);
    camera.lookAt(0, 1.68, 0);
    camera.updateProjectionMatrix();
  }

  let raf = 0, last = 0, alive = true;
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(host);
  function frame(ms) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (typeof document !== 'undefined' && document.hidden) { last = ms; return; }
    if (!host.clientWidth) { last = ms; return; }
    const dt = Math.min(0.1, last ? (ms - last) / 1000 : 0.016);
    last = ms;
    now += dt;
    resize();
    const t = now - started;
    shown = pose(t);
    apply(shown);
    if (anim && anim.fx) anim.fx(t, P, bot);
    drift(dt, !reduced && CELEBRATE.has(state));
    drawFaceIfChanged(t);
    const pulse = CELEBRATE.has(state) ? 0.8 + 0.4 * Math.abs(Math.sin(now * 5)) : 1;
    logoMat.color.setScalar(pulse);
    renderer.render(scene, camera);
  }
  if (!options.manual) raf = requestAnimationFrame(frame);

  function dispose() {
    alive = false;
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    scene.traverse(o => { if (o.material && !disposables.includes(o.material)) o.material.dispose(); });
    for (const d of disposables) if (d && d.dispose) d.dispose();
    renderer.dispose();
    canvasEl.remove();
  }

  // For the preview page and tests: render one exact moment of an animation.
  function renderAt(key, t) {
    setState(key); started = 0; now = t; from = null;
    resize();
    shown = pose(t); apply(shown);
    if (anim && anim.fx) anim.fx(t, P, bot);
    drawFaceIfChanged(t);
    renderer.render(scene, camera);
  }

  return { setState, dispose, renderAt, get state() { return state; }, canvas: canvasEl };
}

export const ROBOT_ANIMATIONS = Object.keys(ANIMS);
