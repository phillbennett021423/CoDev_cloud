# CoDev Studio for Android

CoDev Studio (`www/index.html`) wrapped as an Android app with Capacitor 8.

## Updating the app
Edit `mobile/www/index.html` and push. GitHub Actions builds a debug APK on every push (`android-debug.yml` on branches, `release.yml` on `main`).

## Getting the APK
On GitHub open **Actions → Android debug APK → the latest run**, then download
`codev-studio-debug-apk` from the **Artifacts** section. Unzip it and install
`app-debug.apk` on the phone (allow "Install unknown apps" for your browser or file manager).

## Building locally (optional)
Needs Node 22+, JDK 21 and the Android SDK.

    cd mobile
    npm install
    npm run build:debug

The APK lands in `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

## Public download
Every push to `main`, including merged pull requests, runs `.github/workflows/release.yml`.
It builds the APK and publishes a GitHub Release with it attached. The newest one is always at:
https://github.com/phillbennett021423/CoDev_cloud/releases/latest/download/app-debug.apk
(The older `codev-studio.apk` name is attached too, so earlier links keep working.)

## Web grounding

Technical and code questions are checked against live DuckDuckGo results before the agents answer. It's free, with no API key. The Android app searches on the phone itself. In a desktop browser, run the small local helper in [`tools/ddgs-helper`](../tools/ddgs-helper/README.md).

Agents can also call local tools on their own while answering: DuckDuckGo search, listing and reading your loaded project files, and (desktop only, through the helper) commands you approve in `allowed_commands.json`. CoDev asks before every command runs. See [Local tools for agents](../tools/ddgs-helper/README.md#local-tools-for-agents).

## The agents' browser on the phone

Agents get their own browser in the Android app, like on the Windows app: the
`browser_*` tools, the 🖥️ live view, ✋ Take over / ↩ Hand back, sign-ins that stay,
and saved web logins. It is Android's WebView inside CoDev
(`android/app/src/main/java/com/codev/studio/CodevBrowserPlugin.java`), driven by
`www/agent-ui/phone-browser.js`. See "On the Android app" under "Agents' web browser"
in the main README.

## What still needs a computer

These run programs that a phone can't run, so they stay on the Windows app and
`start-codev.bat`:

- **Sandbox & Review Changes and running commands**: they need Docker or a shell on a computer.
- **MCP servers started by a command** (`npx`, `uvx`, ...): they are programs on the computer. MCP servers with a `url` work on the phone.
- **The project folder on your computer and folders read by path** (`G:\My Drive\...`): the phone can't see the computer's disks. Pick files with 📁 or 📸 instead.
- **The 📈 Outlier scan**: it is a Python pipeline with its own signed-in desktop browser. Agents on the phone can still open Outlier in their browser and read it.
