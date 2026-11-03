// Renders the agent avatars: the CoDev Bot robot as a head-and-shoulders portrait,
// one colour per avatar style and one picture per mood (idle, thinking, active,
// success), into mobile/www/companion/avatars/. The page shows these pictures in the
// agent rail, the agent list and the chat header, so dozens of agents cost nothing
// to draw. Run it again after changing robot3d.js:
//
//   node scripts/render-robot-avatars.js
//
// Needs Playwright's Chromium (npm run setup installs it).
const fs = require('fs');
const http = require('http');
const path = require('path');

const WWW = path.join(__dirname, '..', 'mobile', 'www');
const OUT = path.join(WWW, 'companion', 'avatars');
// Keep in step with ROBOT_COLORS in mobile/www/index.html.
const COLORS = { circle: '#4fe8ff', triangle: '#ffb347', square: '#ff7ae0', hexagon: '#7dff9a' };
// mood -> the LED face it shows (the body stays in its resting pose so the head is centred)
const MOODS = {
    idle: { eyes: 'neutral', mouth: 'smile' },
    thinking: { eyes: 'question', mouth: 'side' },
    active: { eyes: 'happy', mouth: 'grin' },
    success: { eyes: 'wink', mouth: 'grin' }
};
const SIZE = { width: 120, height: 132 }; // 3x the largest avatar (40x44)

function loadPlaywright() {
    for (const name of ['playwright', 'playwright-core']) {
        try { const mod = require(name); if (mod.chromium) return mod; } catch { /* next */ }
    }
    throw new Error('Playwright is not installed: run npm install');
}

const PAGE = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
#host{position:relative;width:${SIZE.width}px;height:${SIZE.height}px}canvas{position:absolute;inset:0;width:100%;height:100%}</style>
<div id="host"></div><script type="module">
import * as THREE from '/vendor/three/three.module.min.js';
import { createRobot } from '/companion/robot3d.js';
window.draw = (accent, face) => {
  const host = document.getElementById('host'); host.innerHTML = '';
  const bot = createRobot(THREE, host, { manual: true, framing: 'portrait', accent });
  bot.renderAt(null, 0, face);
};
window.ready = true;
</script>`;

async function main() {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        if (url === '/') { res.setHeader('content-type', 'text/html'); return res.end(PAGE); }
        const file = path.join(WWW, path.normalize(url));
        if (!file.startsWith(WWW)) { res.statusCode = 403; return res.end(); }
        fs.readFile(file, (err, body) => {
            if (err) { res.statusCode = 404; return res.end(); }
            res.setHeader('content-type', 'text/javascript');
            res.end(body);
        });
    }).listen(0);
    const port = server.address().port;
    const { chromium } = loadPlaywright();
    // Software WebGL is fine for still pictures.
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
        const page = await browser.newPage({ viewport: SIZE });
        page.on('pageerror', err => console.error(err.message));
        await page.goto(`http://localhost:${port}/`);
        await page.waitForFunction(() => window.ready);
        fs.mkdirSync(OUT, { recursive: true });
        for (const [shape, accent] of Object.entries(COLORS)) {
            for (const [mood, face] of Object.entries(MOODS)) {
                await page.evaluate(([a, f]) => window.draw(a, f), [accent, face]);
                const file = path.join(OUT, `robot-${shape}-${mood}.png`);
                await page.locator('#host').screenshot({ path: file, omitBackground: true });
                console.log(path.relative(process.cwd(), file));
            }
        }
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
