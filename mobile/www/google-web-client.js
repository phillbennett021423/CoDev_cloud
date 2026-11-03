// The Google OAuth client ID ("Web application" type) built into the web page, so
// visitors can press Sign in with Google without setting up Google Cloud. The
// "Web version (GitHub Pages)" workflow fills it from the GOOGLE_WEB_CLIENT_ID
// repository variable. A client ID is public (it is in every sign-in address), so it
// is safe on the site; there is no client secret. Each visitor's sign-in stays in
// their own browser. See docs/google-apps.md.
window.CODEV_GOOGLE_WEB_CLIENT_ID = "";
