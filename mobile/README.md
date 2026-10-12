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
