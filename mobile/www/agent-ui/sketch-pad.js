// ✏️ Sketch pad: draw a rough thumbnail and CoDev redraws it in the studio's style as
// you go (art_edit mode "sketch" on ComfyUI, on the computer running CoDev). With
// "Live" on, each pause in drawing sends the sketch; a turbo/schnell model keeps it
// near real time. The result is saved in the project's art/concepts/edits folder.
//
//   CodevSketchPad.open({ callTool(name, args) -> MCP result, log(text) })
(function () {
    const STYLE = `
.csp-back{position:fixed;inset:0;background:#0009;z-index:9000;display:flex;align-items:center;justify-content:center;padding:12px}
.csp{background:var(--bg-panel,#14161f);color:var(--text-main,#eee);border:1px solid #fff2;border-radius:14px;width:min(1100px,100%);max-height:100%;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.csp-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.csp-row input[type=text]{flex:1;min-width:180px}
.csp-panes{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media (max-width:700px){.csp-panes{grid-template-columns:1fr}}
.csp canvas,.csp .csp-out{width:100%;aspect-ratio:1;border-radius:10px;background:#fff;touch-action:none}
.csp .csp-out{background:#0004;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#aaa;font-size:.9rem;text-align:center}
.csp .csp-out img{width:100%;height:100%;object-fit:contain}.csp-status{font-size:.85rem;opacity:.8;min-height:1.2em}
.csp button{cursor:pointer}`;

    function el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'style') node.style.cssText = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        }
        children.flat().forEach(c => node.append(c));
        return node;
    }

    function open({ callTool, log = () => {} } = {}) {
        if (!document.getElementById('csp-style')) document.head.append(el('style', { id: 'csp-style' }, STYLE));
        const canvas = el('canvas', { width: '768', height: '768' });
        const out = el('div', { class: 'csp-out' }, 'Your drawing, redrawn in the studio style, shows here.');
        const status = el('div', { class: 'csp-status' });
        const prompt = el('input', { type: 'text', placeholder: 'What is it? e.g. "armoured mech knight skin, front view"' });
        const style = el('input', { type: 'text', placeholder: 'Style (blank = studio default)', style: 'max-width:220px' });
        const live = el('input', { type: 'checkbox' });
        live.checked = true;
        const size = el('input', { type: 'range', min: '2', max: '40', value: '6' });
        const cx = canvas.getContext('2d');
        cx.fillStyle = '#fff';
        cx.fillRect(0, 0, canvas.width, canvas.height);
        let erasing = false;
        let drawing = false;
        let last = null;
        let timer = null;
        let busy = false;
        let again = false;
        let history = [];

        const point = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
        canvas.addEventListener('pointerdown', e => {
            drawing = true; last = point(e); canvas.setPointerCapture(e.pointerId);
            history.push(cx.getImageData(0, 0, canvas.width, canvas.height));
            if (history.length > 20) history.shift();
        });
        canvas.addEventListener('pointermove', e => {
            if (!drawing) return;
            const p = point(e);
            cx.strokeStyle = erasing ? '#fff' : '#111';
            cx.lineWidth = Number(size.value) * (erasing ? 3 : 1) * (e.pressure && e.pointerType === 'pen' ? 0.5 + e.pressure : 1);
            cx.lineCap = cx.lineJoin = 'round';
            cx.beginPath(); cx.moveTo(...last); cx.lineTo(...p); cx.stroke();
            last = p;
        });
        const end = () => { if (!drawing) return; drawing = false; if (live.checked) schedule(); };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);

        function schedule() { clearTimeout(timer); timer = setTimeout(render, 700); }

        async function render() {
            if (!prompt.value.trim()) { status.textContent = 'Say what the sketch is first (the box above).'; return; }
            if (busy) { again = true; return; }
            busy = true;
            status.textContent = '🎨 Redrawing…';
            const started = Date.now();
            try {
                const args = { mode: 'sketch', prompt: prompt.value.trim(), image_data: canvas.toDataURL('image/png'), fast: live.checked, no_preview: true, return_data: true };
                // Live redraws reuse one file; a manual Redraw keeps its own copy.
                if (live.checked) args.image_name = 'sketch_live';
                if (style.value.trim()) args.style = style.value.trim();
                const result = await callTool('art_edit', args);
                const textOut = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
                if (result.isError) throw new Error(textOut);
                const url = result.structuredContent && result.structuredContent.dataUrl;
                if (url) { out.innerHTML = ''; out.append(el('img', { src: url, alt: 'redrawn sketch' })); }
                status.textContent = `Done in ${((Date.now() - started) / 1000).toFixed(1)} s · saved ${result.structuredContent ? result.structuredContent.file : ''}`;
                log(`[Sketch] ${textOut.split('\n')[0]}`);
            } catch (err) {
                status.textContent = `⚠️ ${err.message}`;
            } finally {
                busy = false;
                if (again) { again = false; render(); }
            }
        }

        const back = el('div', { class: 'csp-back', onclick: e => { if (e.target === back) close(); } });
        function close() { clearTimeout(timer); back.remove(); }
        const pen = el('button', { type: 'button', class: 'btn-secondary', onclick: () => { erasing = false; pen.disabled = true; rub.disabled = false; } }, '✏️ Pen');
        const rub = el('button', { type: 'button', class: 'btn-secondary', onclick: () => { erasing = true; rub.disabled = true; pen.disabled = false; } }, '🧽 Eraser');
        pen.disabled = true;
        back.append(el('div', { class: 'csp' },
            el('div', { class: 'csp-row' }, el('strong', {}, '✏️ Sketch to image'), el('span', { style: 'flex:1' }), el('button', { type: 'button', class: 'btn-secondary', onclick: close }, '✕')),
            el('div', { class: 'csp-row' }, prompt, style),
            el('div', { class: 'csp-row' }, pen, rub, el('label', {}, 'Size ', size),
                el('button', { type: 'button', class: 'btn-secondary', onclick: () => { const h = history.pop(); if (h) cx.putImageData(h, 0, 0); if (live.checked) schedule(); } }, '↶ Undo'),
                el('button', { type: 'button', class: 'btn-secondary', onclick: () => { history.push(cx.getImageData(0, 0, canvas.width, canvas.height)); cx.fillStyle = '#fff'; cx.fillRect(0, 0, canvas.width, canvas.height); } }, '🗑️ Clear'),
                el('label', { title: 'Redraw each time you pause, with a fast model' }, live, ' Live'),
                el('button', { type: 'button', onclick: render }, '🎨 Redraw')),
            el('div', { class: 'csp-panes' }, canvas, out),
            status,
            el('div', { style: 'font-size:.8rem;opacity:.7' }, 'Runs on ComfyUI on the computer running CoDev. A scribble or lineart ControlNet follows your lines closely; a turbo or schnell model makes Live near real time.')));
        document.body.append(back);
        prompt.focus();
        return { close, render };
    }

    window.CodevSketchPad = { open };
})();
