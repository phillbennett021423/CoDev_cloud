// Copies the Outlier pipeline into desktop/bundle/ (same folder layout as the
// repo, so its relative paths still work) for the Windows app and its installer:
// agents/outlier, the Python analytics it runs, and the address checks it shares
// with the browser. Run by npm start and npm run dist; bundle/ isn't in git.
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const bundle = path.join(__dirname, 'bundle');
const skip = src => /(^|[\\/])(__pycache__|test_[^\\/]*\.py)$/.test(src);

fs.rmSync(bundle, { recursive: true, force: true });
fs.cpSync(path.join(repo, 'agents', 'outlier'), path.join(bundle, 'agents', 'outlier'), { recursive: true });
fs.cpSync(path.join(repo, 'tools', 'outlier-analytics'), path.join(bundle, 'tools', 'outlier-analytics'), { recursive: true, filter: src => !skip(src) });
fs.mkdirSync(path.join(bundle, 'desktop', 'browser'), { recursive: true });
fs.copyFileSync(path.join(repo, 'desktop', 'browser', 'page-check.js'), path.join(bundle, 'desktop', 'browser', 'page-check.js'));
