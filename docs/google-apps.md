# Google apps in CoDev (YouTube, Maps, Gmail)

CoDev's agents can search YouTube, find places and directions on Google Maps,
and read your Gmail. They can also send email, but only if you turn that on, and
CoDev asks you before every email.

Cloud files moved from Google Drive to MEGA: see [mega-cloud.md](mega-cloud.md).
Google Docs and Sheets are replaced by CoDev Notes (notes and CSV/JSON tables in CoDev): see
[notes-and-tables.md](notes-and-tables.md).

## What works with no setup

- **YouTube:** basic search through CoDev's web search, plus each video's title
  and channel. You don't get view counts, length, descriptions or comments.
- **Maps:** places and directions from OpenStreetMap, which is free and needs no
  key. Driving, walking and biking work. You don't get ratings, open-now, live
  traffic or transit.

Gmail always needs the sign-in below.

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
   - Maps (optional, needs billing): Places API (New)
     <https://console.cloud.google.com/apis/library/places.googleapis.com> and Routes API
     <https://console.cloud.google.com/apis/library/routes.googleapis.com>
3. **Make the API key (YouTube and Maps).** Open
   <https://console.cloud.google.com/apis/credentials>, press **Create credentials >
   API key**, and copy the key (it starts with `AIza`). Then edit the key, choose
   **Restrict key**, and tick YouTube Data API v3, Places API (New) and Routes API.
4. **Set up the sign-in screen (Gmail).** Open
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
   key, client ID and client secret. Tick "Let agents send email" if you want
   that. Then press **Sign in with Google**, pick your account, and allow access.
   The panel then shows "Signed in as ..." and agents get the Gmail tools.

   If you start CoDev with `start-codev.bat` or `npm start`, you can put the same
   values in `.env` instead (`GOOGLE_API_KEY`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`; see `.env.example`).

## On your phone

The Android app signs in on the phone itself, with the same OAuth client:

1. In **Settings > Google apps** in the phone app, paste the API key, the OAuth
   client ID and the client secret (the "Desktop app" client from above).
2. Press **Sign in with Google**. Google's sign-in opens in your phone's browser.
   Choose your account and allow access. The page then says "Done. Go back to
   CoDev." Switch back to the app: it shows "Signed in as ...".

Or link the phone to the sign-in on your computer:

1. Sign in on your computer as above.
2. In **Settings > Google apps** on the computer, press **Copy phone link code**.
3. Send the code to your phone (for example, in a note to yourself), then paste it
   into **Settings > Google apps** in the phone app and press **Link this phone**.
4. Paste the API key into the phone's Settings too.

The code works like your sign-in, so paste it only into CoDev, and delete the note
afterwards.

## On the web page (GitHub Pages)

On CoDev's web page, anyone who opens it can sign in with their own Google account
and the agents get the same Gmail and YouTube tools. Each visitor's sign-in is saved
only in their own browser, never on the website. "Let agents send email" works the
same way, and CoDev still asks before every email.

Google gives a web page a sign-in that lasts about an hour, with no way to renew it
quietly. When it ends, CoDev shows an OK card ("Sign in to Google again?") the next
time an agent needs Gmail, and opens Google's sign-in when you press it.

### For the site's owner: one-time setup

The phone and computer use a "Desktop app" client, which can't be used from a web
page, so the web page needs its own client in the same Google Cloud project:

1. Open <https://console.cloud.google.com/auth/clients>, press **Create client**, and
   choose **Web application**. Name it `CoDev web`.
2. Under **Authorized JavaScript origins**, add `https://phillbennett021423.github.io`.
3. Under **Authorized redirect URIs**, add
   `https://phillbennett021423.github.io/codev_cloud/google-callback.html`.
   (If you use your own domain or fork, Settings > Google apps on the web page shows
   the exact two values under "Using your own OAuth client?".)
4. Press Create and copy the **Client ID**. You don't need the client secret.
5. Build the client ID into the site: in GitHub, open the repository's **Settings >
   Secrets and variables > Actions > Variables**, add a variable named
   `GOOGLE_WEB_CLIENT_ID` with the client ID, then run the **Web version (GitHub
   Pages)** workflow (Actions tab > Run workflow). A client ID is public, so it is
   safe on the site.

Without step 5, visitors can still paste a client ID of their own in Settings >
Google apps.

### Google's limits for public visitors

Reading Gmail (`gmail.readonly`) is one of Google's **restricted** permissions, and
sending email (`gmail.send`) and YouTube (`youtube.readonly`) are **sensitive** ones.
Until Google verifies the app:

- Visitors see a "Google hasn't verified this app" screen and must press
  **Advanced > Go to CoDev** to carry on.
- At most **100 people** can ever sign in to an unverified app with these
  permissions. If the app is still in "Testing", only the test users you list under
  **Audience** can sign in at all.
- To lift these limits, Google's verification needs a privacy policy, a home page on
  a domain you own (a `github.io` address doesn't count, so you would need your own
  domain), and a short video of the sign-in. Because reading Gmail is restricted,
  Google also requires a yearly security assessment by an approved outside firm,
  which costs money each year.

For yourself, family and friends, the unverified app is enough. For the general
public, plan on verification, or keep Gmail for people who set up their own client.

## What CoDev can and can't do

| App | Tools | Access |
| --- | --- | --- |
| YouTube | `youtube_search`, `youtube_video` (details and top comments) | Read only |
| Maps | `maps_search_places`, `maps_directions` | Read only |
| Gmail | `gmail_search`, `gmail_read`, `gmail_send` | Reading, plus sending if you turn it on. CoDev asks before each email. |

The Google Drive tools (`drive_search`, `drive_read_file`, `drive_save_file`) were
replaced by the MEGA tools (`mega_search`, `mega_read_file`, `mega_save_file`); see
[mega-cloud.md](mega-cloud.md). CoDev no longer asks Google for Drive access. If you
signed in before this change, sign in again so the old Drive permission goes away.

## Where the sign-in is kept

- Windows app: in CoDev's app data folder, encrypted by Windows.
- `start-codev.bat` / `npm start`: `.codev/google-account.json`, which git ignores.
- Phone: in the app's own storage.
- Web page: in that browser's own storage, for about an hour at a time.

To sign out, press **Sign out** in Settings. This also removes CoDev's access from
your Google account. You can also remove it at <https://myaccount.google.com/permissions>.

## Troubleshooting

- **"... API has not been used in project ... or it is disabled":** turn on that
  API (step 2), wait a minute, and try again.
- **"The Google sign-in expired or was removed":** sign in again. If this happens
  every week, press Publish app (step 4).
- **YouTube "quota exceeded":** the free YouTube quota allows about 100 searches a
  day, and it resets at midnight Pacific time.
- **The Gmail send tool doesn't appear after you tick sending:** sign in again so
  Google can ask for the new permission.
