// Keys built into a private copy of CoDev. The "Private build" workflow fills in
// CODEV_SHARED_KEYS from GitHub secrets (scripts/write-shared-keys.js); in git and
// in the public downloads it stays empty. A built-in key is used only when Settings
// has no key of its own for that service, and Settings never shows it.
window.CODEV_SHARED_KEYS = {};
window.codevSharedKey = name => String(window.CODEV_SHARED_KEYS[name] || "").replace(/[\s\u200B-\u200D\uFEFF"'`]+/g, "");
// The key to show in Settings: blank when it is the built-in one.
window.codevOwnKey = (name, key) => key && key === window.codevSharedKey(name) ? "" : key;
