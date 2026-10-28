# Google apps in CoDev (YouTube, Maps, Gmail, Drive)

CoDev's agents can search YouTube, find places and directions on Google Maps,
read your Gmail and read your Google Drive. They can also send email and save
new files to Drive, but only if you turn that on, and CoDev asks you before
every email and every save.

## What works with no setup

- **YouTube:** basic search through CoDev's web search, plus each video's title
  and channel. You don't get view counts, length, descriptions or comments.
- **Maps:** places and directions from OpenStreetMap, which is free and needs no
  key. Driving, walking and biking work. You don't get ratings, open-now, live
  traffic or transit.

Gmail and Drive always need the sign-in below.

## One-time Google Cloud setup (about 10 minutes)

Everything here is free. The only exception is the Maps part of the API key:
Google asks for a billing account (a card) before Maps works, then gives a free
monthly allowance of calls that personal use stays well under. Skip Maps if you
don't want that, and CoDev keeps using OpenStreetMap.

1. **Make a project.** Open <https://console.cloud.google.com/projectcreate>,
   name it `CoDev` and press Create. Make sure it is selected at the top of the
   page for the next steps.
2. **Turn on the APIs.** Open each link and press Enable:
   - YouTube Data API v3: <https://console.cloud.google.com/apis/library/youtube.googleapis.com>
   - Gmail API: <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
   - Google Drive API: <https://console.cloud.google.com/apis/library/drive.googleapis.com>
   - Maps (optional, needs billing): Places API (New)
     <https://console.cloud.google.com/apis/library/places.googleapis.com> and Routes API
     <https://console.cloud.google.com/apis/library/routes.googleapis.com>
3. **Make the API key (YouTube and Maps).** Open
   <https://console.cloud.google.com/apis/credentials>, press **Create credentials >
   API key**, and copy the key (it starts with `AIza`). Then edit the key, choose
   **Restrict key**, and tick YouTube Data API v3, Places API (New) and Routes API.
4. **Set up the sign-in screen (Gmail and Drive).** Open
   <https://console.cloud.google.com/auth/overview> and press Get started. Use
   `CoDev` as the app name and your own email for the contact addresses. Choose
   **External** as the audience.
   - Under **Audience**, add your Gmail address as a test user.
   - Also under Audience, press **Publish app**. Without this, Google ends the
     sign-in after 7 days and you would have to sign in again every week.
     Because the app is only for you, Google never reviews it. Instead, the
     sign-in page warns that the app isn't verified: press **Advanced > Go to
     CoDev** to carry on.
5. **Make the OAuth client.** Open <https://console.cloud.google.com/auth/clients>,
   press **Create client**, choose **Desktop app** as the type, name it `CoDev`, and
   copy the **Client ID** and **Client secret**.
6. **Connect CoDev.** In CoDev, open **Settings > Google apps** and paste the API
   key, client ID and client secret. Tick "Let agents send email and save new files
   to Drive" if you want that. Then press **Sign in with Google**, pick your
   account, and allow access. The panel then shows "Signed in as ..." and agents
   get the Gmail and Drive tools.

   If you start CoDev with `start-codev.bat` or `npm start`, you can put the same
   values in `.env` instead (`GOOGLE_API_KEY`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`; see `.env.example`).

## On your phone

The Android app can't run Google's sign-in itself. Instead:

1. Sign in on your computer as above.
2. In **Settings > Google apps** on the computer, press **Copy phone link code**.
3. Send the code to your phone (for example, in a note to yourself), then paste it
   into **Settings > Google apps** in the phone app and press **Link this phone**.
4. Paste the API key into the phone's Settings too.

The code works like your sign-in, so paste it only into CoDev, and delete the note
afterwards.

## What CoDev can and can't do

| App | Tools | Access |
| --- | --- | --- |
| YouTube | `youtube_search`, `youtube_video` (details and top comments) | Read only |
| Maps | `maps_search_places`, `maps_directions` | Read only |
| Gmail | `gmail_search`, `gmail_read`, `gmail_send` | Reading, plus sending if you turn it on. CoDev asks before each email. |
| Drive | `drive_search`, `drive_read_file`, `drive_save_file` | Reading, plus new files if you turn it on. CoDev asks before each save, and never changes or deletes existing files. |

For images in Drive, such as your screenshots, use the 📸 button or ask CoDev to
read the folder by its path. Google Drive for desktop shows that path as a drive
letter, like `G:\My Drive\Screenshots`.

## Where the sign-in is kept

- Windows app: in CoDev's app data folder, encrypted by Windows.
- `start-codev.bat` / `npm start`: `.codev/google-account.json`, which git ignores.
- Phone: in the app's own storage.

To sign out, press **Sign out** in Settings. This also removes CoDev's access from
your Google account. You can also remove it at <https://myaccount.google.com/permissions>.

## Troubleshooting

- **"... API has not been used in project ... or it is disabled":** turn on that
  API (step 2), wait a minute, and try again.
- **"The Google sign-in expired or was removed":** sign in again. If this happens
  every week, press Publish app (step 4).
- **YouTube "quota exceeded":** the free YouTube quota allows about 100 searches a
  day, and it resets at midnight Pacific time.
- **Gmail and Drive tools don't appear after you tick sending/saving:** sign in
  again so Google can ask for the new permissions.
