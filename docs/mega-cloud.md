# MEGA cloud in CoDev (replaces Google Drive)

CoDev's agents can search and read the files in your MEGA cloud drive, and save
new files to it if you turn that on. CoDev asks you before every save, and the MEGA
tools never change, move or delete files that are already there. The one exception
is a notes vault kept in MEGA ([notes-and-tables.md](notes-and-tables.md)): an
edited note or table is saved as a new version after you approve it, and the old
version goes to MEGA's Rubbish Bin.

This replaced CoDev's Google Drive tools. YouTube, Maps and Gmail still use Google
(see [google-apps.md](google-apps.md)).

## What you need

- A MEGA account. The free plan is enough: sign up at <https://mega.io>.
- Optional: **MEGAsync**, MEGA's free desktop app (<https://mega.io/desktop>), if you
  want a folder on your computer that stays in step with MEGA, like Google Drive for
  desktop did.

There's no developer console, API key or OAuth client to set up. CoDev talks to MEGA
with [megajs](https://mega.js.org) (free, open source, MIT), MEGA's JavaScript SDK.
Files are decrypted on your own device, so MEGA never sees what's in them.

## Connect CoDev

1. In CoDev, open **Settings > MEGA cloud**.
2. Type your MEGA email and password. If your account uses two-factor sign-in, also
   type the 6-digit code from your authenticator app.
3. Tick **Let agents save new files to MEGA** if you want that. You can change this
   later without signing in again.
4. Press **Sign in to MEGA**. The panel shows "Signed in as ...", and agents get the
   MEGA tools.

The same steps work in the Windows app, in a browser on `start-codev.bat` /
`npm start`, and in the Android app. On the phone there's no computer or link code
needed: sign in right in the app.

## What CoDev can and can't do

| Tool | What it does | Access |
| --- | --- | --- |
| `mega_status` | Says whether CoDev is signed in to MEGA and whether saving is on. | Always offered. |
| `mega_search` | Finds files and folders by name (words in any order), or lists a folder, newest first. Filters by type: folder, image, video, audio, pdf, doc, sheet, slides or text. | Read only. |
| `mega_read_file` | Reads a text file (txt, md, csv, json, code and similar, up to 5 MB) by its id or path, like `/Notes/picks.md`, 12,000 characters at a time. A folder lists what's in it. | Read only. |
| `mega_save_file` | Saves a new text file, at the top of the drive or in a folder you name. | Only if you turn saving on. CoDev asks before each save. |

Things that work differently from Google Drive:

- **Search matches names, not the text inside files.** MEGA encrypts everything, so
  only your device can read a file's contents.
- **No Google Docs, Sheets or Slides.** For PDFs, Word or Excel files in MEGA, attach
  them to the chat with 📎, which reads them in full.
- **Images:** use the 📸 button or ask CoDev to read the folder by its path on your
  computer. MEGAsync keeps its synced folder at `C:\Users\<you>\MEGA` by default, so
  "read my screenshots in C:\Users\me\MEGA\Screenshots" works.
- Files in your Rubbish Bin are left out. Folders other people shared with you show
  up with `[shared]` in front of their name.
- Links in the answers open the folder in MEGA's web app (`mega.nz/fm/...`) for you,
  signed in. CoDev never makes public share links.

## Where the sign-in is kept

CoDev uses your password once, to sign in, and never saves it. What it keeps is
MEGA's session, the same as MEGA's own apps do when you stay signed in:

- Windows app: in CoDev's app data folder (`mega-session.json`), encrypted by Windows.
- `start-codev.bat` / `npm start`: `.codev/mega-session.json`, which git ignores.
- Phone: in the app's own storage.

To sign out, press **Sign out** in Settings. This also ends the session at MEGA. You
can also end it from MEGA's web app under **Settings > Security > Session history**.

## Moving from Google Drive

1. Install MEGAsync and sign in. Pick a local folder to sync (the default
   `C:\Users\<you>\MEGA` is fine).
2. Move what you kept in Google Drive into that folder (or upload it at mega.nz).
   For a screenshots folder, point your screenshot tool or phone's camera upload at
   the MEGA folder instead. The MEGA phone app has its own camera upload.
3. Sign in under **Settings > MEGA cloud** as above.
4. If you only used Google for Drive, press **Sign out** under **Settings > Google
   apps**. If you still use Gmail, sign in to Google again so it stops asking for
   Drive access. Either way, CoDev no longer asks Google for Drive access.

## Troubleshooting

- **"MEGA didn't accept that email and password":** check them at <https://mega.nz/login>.
- **"This MEGA account has two-factor sign-in":** type the current 6-digit code and
  sign in again. Codes change every 30 seconds.
- **"The MEGA sign-in expired or was ended":** you (or MEGA) ended the session, for
  example from Session history, or you changed your password. Sign in again.
- **"out of storage or transfer quota":** the free plan has a storage limit and a
  transfer limit that resets over time. Free some space, or wait and try again.
- **A file you just added doesn't show up:** CoDev fetches the file list again
  after a minute, so wait a moment and ask again.
