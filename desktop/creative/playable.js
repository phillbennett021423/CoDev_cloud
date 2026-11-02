// Layer 4: playable ads. One self-contained HTML file (pictures inlined, no network)
// that works as an MRAID 2.0 playable on the ad networks (it waits for mraid's
// "ready", and the button calls mraid.open) and as a plain web page anywhere else.
//
// Templates:
//   reveal   tap or scratch to reveal the new skin, then the end card
//   equip    swipe through skins and tap Equip to put one on the character
//   runner   a 15-second dodge game played with the skin, then the end card
//   spin     a turntable of the skin from frames (or a tilt card from one picture)
//
// buildPlayable(options) -> { html, bytes, warnings }
const vm = require('vm');

const TEMPLATES = ['reveal', 'equip', 'runner', 'spin'];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function color(c, fallback) { return /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : fallback; }

const GAME_JS = {
    reveal: `
const card = document.getElementById('stage');
const cv = document.createElement('canvas'); cv.className = 'cover'; card.appendChild(cv);
const cx = cv.getContext('2d'); let revealed = 0, done = false;
function size() { cv.width = card.clientWidth; cv.height = card.clientHeight; cx.fillStyle = C.accent; cx.fillRect(0, 0, cv.width, cv.height);
  cx.fillStyle = '#fff'; cx.font = 'bold ' + Math.round(cv.width / 14) + 'px system-ui'; cx.textAlign = 'center'; cx.fillText(C.hint || 'Scratch to reveal', cv.width / 2, cv.height / 2); }
size(); addEventListener('resize', size);
function scratch(e) { if (done) return; const r = cv.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e;
  cx.globalCompositeOperation = 'destination-out'; cx.beginPath(); cx.arc(p.clientX - r.left, p.clientY - r.top, cv.width / 9, 0, 7); cx.fill();
  if (++revealed > 26) { done = true; cv.style.transition = 'opacity .5s'; cv.style.opacity = 0; track('reveal'); setTimeout(endCard, 1400); } }
cv.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') scratch(e); });
cv.addEventListener('pointerdown', scratch);
setTimeout(() => { if (!done) { done = true; cv.style.transition = 'opacity .5s'; cv.style.opacity = 0; setTimeout(endCard, 1400); } }, 12000);`,
    equip: `
const stage = document.getElementById('stage'); let i = 0;
const img = document.createElement('img'); img.className = 'hero'; stage.appendChild(img);
const nav = document.createElement('div'); nav.className = 'nav';
nav.innerHTML = '<button id="prev">‹</button><button id="equip">EQUIP</button><button id="next">›</button>'; stage.appendChild(nav);
function show() { img.src = A.skins[i]; img.style.animation = 'none'; void img.offsetWidth; img.style.animation = 'pop .35s'; }
document.getElementById('prev').onclick = () => { i = (i + A.skins.length - 1) % A.skins.length; show(); };
document.getElementById('next').onclick = () => { i = (i + 1) % A.skins.length; show(); };
document.getElementById('equip').onclick = () => { track('equip'); stage.classList.add('equipped'); setTimeout(endCard, 1200); };
let sx = null; stage.addEventListener('pointerdown', e => sx = e.clientX);
stage.addEventListener('pointerup', e => { if (sx == null) return; const d = e.clientX - sx; sx = null; if (Math.abs(d) > 40) { i = (i + (d < 0 ? 1 : A.skins.length - 1)) % A.skins.length; show(); } });
show(); setTimeout(() => { if (!stage.classList.contains('equipped')) endCard(); }, 20000);`,
    runner: `
const stage = document.getElementById('stage'); const cv = document.createElement('canvas'); stage.appendChild(cv);
const cx = cv.getContext('2d'); const hero = new Image(); hero.src = A.skins[0]; const foe = new Image(); if (A.obstacle) foe.src = A.obstacle;
let W, H, x = 0.5, t0 = performance.now(), last = t0, rocks = [], over = false, score = 0, target = 0.5;
function size() { W = cv.width = stage.clientWidth; H = cv.height = stage.clientHeight; } size(); addEventListener('resize', size);
stage.addEventListener('pointermove', e => { const r = cv.getBoundingClientRect(); target = (e.clientX - r.left) / r.width; });
stage.addEventListener('pointerdown', e => { const r = cv.getBoundingClientRect(); target = (e.clientX - r.left) / r.width; });
function loop(now) { if (over) return; const dt = Math.min((now - last) / 1000, 0.05); last = now; const el = (now - t0) / 1000;
  x += (target - x) * Math.min(1, dt * 10);
  if (Math.random() < dt * (1.2 + el * 0.25)) rocks.push({ x: Math.random(), y: -0.1, v: 0.35 + Math.random() * 0.3 + el * 0.02 });
  cx.fillStyle = C.bg; cx.fillRect(0, 0, W, H);
  const s = Math.min(W, H) * 0.18; const hy = H - s * 1.2;
  for (const r of rocks) { r.y += r.v * dt; const rx = r.x * W, ry = r.y * H;
    if (A.obstacle && foe.complete) cx.drawImage(foe, rx - s * 0.3, ry - s * 0.3, s * 0.6, s * 0.6); else { cx.fillStyle = C.accent; cx.beginPath(); cx.arc(rx, ry, s * 0.25, 0, 7); cx.fill(); }
    if (Math.abs(rx - x * W) < s * 0.45 && Math.abs(ry - (hy + s / 2)) < s * 0.45) { over = true; track('hit'); return endCard(); } }
  rocks = rocks.filter(r => r.y < 1.2); score += dt * 10;
  if (hero.complete) cx.drawImage(hero, x * W - s / 2, hy, s, s);
  cx.fillStyle = '#fff'; cx.font = 'bold ' + Math.round(s / 4) + 'px system-ui'; cx.fillText(Math.floor(score), 16, s / 3);
  if (el > (C.seconds || 15)) { over = true; track('survived'); return endCard(); }
  requestAnimationFrame(loop); }
requestAnimationFrame(loop);`,
    spin: `
const stage = document.getElementById('stage'); const img = document.createElement('img'); img.className = 'hero'; stage.appendChild(img);
const frames = A.frames.length ? A.frames : A.skins; let f = 0, drag = null, auto = true; img.src = frames[0];
if (frames.length > 1) { setInterval(() => { if (auto) { f = (f + 1) % frames.length; img.src = frames[f]; } }, 90);
  stage.addEventListener('pointerdown', e => { drag = e.clientX; auto = false; });
  addEventListener('pointermove', e => { if (drag == null) return; const step = Math.round((e.clientX - drag) / 12); if (step) { f = (f + step + frames.length * 10) % frames.length; img.src = frames[f]; drag = e.clientX; } });
  addEventListener('pointerup', () => { drag = null; }); }
else { stage.addEventListener('pointermove', e => { const r = stage.getBoundingClientRect(); const dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5;
  img.style.transform = 'perspective(600px) rotateY(' + dx * 30 + 'deg) rotateX(' + -dy * 20 + 'deg)'; }); }
setTimeout(endCard, (C.seconds || 12) * 1000); stage.addEventListener('click', () => { track('tap'); });`
};

function buildPlayable({ template = 'reveal', title = '', subtitle = '', cta = 'Play now', storeUrl = '', iosUrl = '', androidUrl = '',
    skins = [], frames = [], background = '', obstacle = '', logo = '', colors = {}, seconds = 0, hint = '', maxMb = 5 } = {}) {
    if (!TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}". Templates: ${TEMPLATES.join(', ')}.`);
    if (!skins.length && !frames.length) throw new Error('A playable needs at least one skin picture.');
    const warnings = [];
    const C = { bg: color(colors.background, '#0d0f1a'), accent: color(colors.accent, '#ff3d7f'), text: color(colors.text, '#ffffff'), seconds: Number(seconds) || 0, hint, storeUrl, iosUrl, androidUrl };
    const A = { skins, frames, obstacle, logo };
    const js = `const C = ${JSON.stringify(C)};
const A = ${JSON.stringify(A)};
function track(e) { try { if (window.parent !== window) window.parent.postMessage({ playable: e }, '*'); } catch (x) {} }
function storeLink() { const ua = navigator.userAgent; return (/iPhone|iPad|iPod/.test(ua) && C.iosUrl) || (/Android/.test(ua) && C.androidUrl) || C.storeUrl || C.androidUrl || C.iosUrl; }
function openStore() { track('cta'); const url = storeLink(); if (!url) return; if (window.mraid && mraid.open) mraid.open(url); else window.open(url, '_blank'); }
let ended = false;
function endCard() { if (ended) return; ended = true; track('end'); document.getElementById('end').classList.add('show'); }
document.querySelectorAll('.cta').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openStore(); }));
function start() {${GAME_JS[template]}
}
if (window.mraid && mraid.getState && mraid.getState() === 'loading') mraid.addEventListener('ready', start); else start();`;
    try { new vm.Script(js); } catch (err) { throw new Error(`The playable's script didn't compile: ${err.message}`); }
    const hero = esc(skins[0] || frames[0]);
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="ad.size" content="width=320,height=480">
<title>${esc(title || 'Playable')}</title>
<script src="mraid.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:${C.bg};color:${C.text};font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;touch-action:none;user-select:none}
#app{position:fixed;inset:0;display:flex;flex-direction:column}
header{padding:12px 16px;display:flex;align-items:center;gap:10px}header img{height:36px}header h1{font-size:clamp(16px,4.5vw,26px);line-height:1.1}header p{font-size:clamp(11px,3vw,14px);opacity:.8}
#stage{position:relative;flex:1;margin:0 12px;border-radius:18px;overflow:hidden;background:${background ? `url("${esc(background)}") center/cover` : `radial-gradient(circle at 50% 40%, ${C.accent}33, transparent 70%)`}}
#stage canvas{position:absolute;inset:0;width:100%;height:100%}.cover{z-index:2}
.hero{position:absolute;inset:6% 8%;width:84%;height:88%;object-fit:contain;filter:drop-shadow(0 10px 30px #0008)}
#stage>.hero:first-child{z-index:1}.equipped .hero{animation:glow 1s infinite alternate}
.nav{position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;gap:12px;z-index:3}
.nav button{border:0;border-radius:999px;padding:12px 18px;font-weight:800;font-size:18px;background:#fff2;color:${C.text}}.nav #equip{background:${C.accent};padding:12px 28px}
footer{padding:12px 16px 16px}.cta{display:block;width:100%;border:0;border-radius:14px;padding:14px;font-size:clamp(16px,4.5vw,22px);font-weight:900;color:#fff;background:${C.accent};box-shadow:0 6px 20px ${C.accent}66;animation:pulse 1.4s infinite}
#end{position:fixed;inset:0;background:${C.bg}f2;display:none;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;z-index:9;text-align:center}
#end.show{display:flex;animation:fade .4s}#end img{max-width:70%;max-height:45%;object-fit:contain}#end .cta{max-width:340px}
@keyframes pulse{50%{transform:scale(1.04)}}@keyframes pop{from{transform:scale(.85);opacity:.3}}@keyframes fade{from{opacity:0}}@keyframes glow{to{filter:drop-shadow(0 0 24px ${C.accent})}}
@media (orientation:landscape){#app{flex-direction:row;flex-wrap:wrap}header{width:100%}#stage{min-height:0}footer{position:absolute;right:16px;bottom:16px;width:min(40%,320px)}}
</style></head>
<body><div id="app">
<header>${logo ? `<img src="${esc(logo)}" alt="">` : ''}<div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div></header>
<div id="stage">${template === 'reveal' ? `<img class="hero" src="${hero}" alt="">` : ''}</div>
<footer><button class="cta">${esc(cta)}</button></footer>
</div>
<div id="end">${logo ? `<img src="${esc(logo)}" alt="" style="max-height:60px">` : ''}<img src="${hero}" alt=""><h1>${esc(title)}</h1><button class="cta">${esc(cta)}</button></div>
<script>${js}</script>
</body></html>
`;
    const bytes = Buffer.byteLength(html);
    if (bytes > maxMb * 1024 * 1024) warnings.push(`It's ${(bytes / 1048576).toFixed(2)} MB, over the ${maxMb} MB most ad networks allow. Use smaller or JPEG/WebP pictures (art_upscale isn't needed here; shrink them instead).`);
    if (!storeUrl && !iosUrl && !androidUrl) warnings.push('No store link yet: the button does nothing until store_url (or ios_url / android_url) is set.');
    return { html, bytes, warnings };
}

module.exports = { buildPlayable, TEMPLATES };
