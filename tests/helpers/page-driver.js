// Drives the real CoDev page in headless Chromium for the agent tests. The model
// is replaced by a script of tool calls, so a test needs no API key and is
// repeatable; everything else (dispatch, sandbox tools, review screen) is the
// page's own code talking to the server under test.

function loadPlaywright() {
    for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
        try {
            const mod = require(name);
            if (mod.chromium) return mod;
        } catch { /* try the next one */ }
    }
    return null;
}

// Starts Chromium, or explains why it can't (so the caller can skip).
async function launchBrowser() {
    const playwright = loadPlaywright();
    if (!playwright) return { skip: 'Playwright is not installed: run npm install (npm run setup also gets Chromium)' };
    // CODEV_BROWSER_PATH first (as the browser service does), then Playwright's own
    // Chromium, then the Chrome or Edge already installed on this computer.
    const attempts = process.env.CODEV_BROWSER_PATH ? [{ executablePath: process.env.CODEV_BROWSER_PATH }] : [];
    attempts.push({}, { channel: 'chrome' }, { channel: 'msedge' });
    let firstError = null;
    for (const extra of attempts) {
        try {
            return { browser: await playwright.chromium.launch({ headless: true, ...extra }) };
        } catch (err) {
            firstError = firstError || err;
        }
    }
    return { skip: `Chromium could not start: ${firstError.message.split('\n')[0]}` };
}

// steps: the assistant messages the stand-in model returns, in order, as
// [{ name, arguments }] tool-call lists or a final text string. Once the script
// runs out it answers "Done." so later passes (like Self-Healing) end at once.
async function openPage(browser, baseUrl, { steps = [], selfHeal = false, mcpServers = {} } = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(mcpServers => {
        localStorage.setItem('codev_groq_key', 'gsk_test_key_for_agent_tests');
        localStorage.setItem('codev_backend', 'groq');
        localStorage.setItem('codev_auto_ground', '0');
        localStorage.setItem('codev_chime', '0');
        localStorage.setItem('codev_mcp_servers', JSON.stringify({ mcpServers }));
        localStorage.setItem('codev_sandbox_mode', '1');
    }, mcpServers);
    await page.goto(baseUrl, { waitUntil: 'load' });
    // initAgentInfra has run once the sandbox checkbox is enabled.
    await page.waitForFunction(() => {
        const box = document.getElementById('isSandboxCheckbox');
        return box && !box.disabled;
    }, null, { timeout: 15000 });
    await page.evaluate(({ steps, selfHeal }) => {
        document.getElementById('settingsModal').style.display = 'none';
        document.getElementById('isSelfHealCheckbox').checked = selfHeal;
        const queue = steps.slice();
        window.__modelCalls = [];
        let seq = 0;
        // Replaces the provider call for the whole page (it's a global function).
        window.groqChatMessage = async body => {
            window.__modelCalls.push({
                tools: (body.tools || []).map(t => t.function.name),
                system: body.messages[0]?.content || '',
                messages: body.messages.slice(1).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))
            });
            const step = queue.shift();
            if (step === undefined) return { role: 'assistant', content: 'Done.' };
            if (typeof step === 'string') return { role: 'assistant', content: step };
            return {
                role: 'assistant', content: '',
                tool_calls: step.map(call => ({ id: `call_${++seq}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } }))
            };
        };
    }, { steps, selfHeal });
    return { page, errors };
}

async function sendPrompt(page, text) {
    await page.fill('#userInput', text);
    await page.press('#userInput', 'Enter');
}

async function waitForReview(page, timeout = 60000) {
    await page.waitForSelector('#diffReviewOverlay', { timeout });
    return page.evaluate(() => [...document.querySelectorAll('#diffReviewOverlay .cdr-file')].map(row => ({
        path: row.dataset.path,
        blocked: row.dataset.blocked === 'true',
        checked: row.querySelector('input').checked,
        disabled: row.querySelector('input').disabled
    })));
}

// The chat's messages, newest last.
function chatMessages(page) {
    return page.evaluate(() => (chatSessions.find(s => s.id === activeChatId) || { messages: [] }).messages.map(m => ({ sender: m.sender, text: m.text })));
}

async function waitForChat(page, pattern, timeout = 30000) {
    const source = pattern.source;
    const flags = pattern.flags;
    await page.waitForFunction(({ source, flags }) => {
        const session = chatSessions.find(s => s.id === activeChatId);
        return session && session.messages.some(m => new RegExp(source, flags).test(`${m.sender}\n${m.text}`));
    }, { source, flags }, { timeout });
}

module.exports = { loadPlaywright, launchBrowser, openPage, sendPrompt, waitForReview, chatMessages, waitForChat };
