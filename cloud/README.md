# CoDev's online server

The server CoDev accounts sign in to. It holds the owner's API keys and forwards
AI requests for signed-in accounts, so nobody else needs keys of their own and
the keys never reach their devices. It runs on Cloudflare (a Worker and a D1
database), which is free at this size.

What it does:

- **Sign-in** with a 6-digit code sent to the person's email (sent by Resend).
- **Plans** (`src/plans.js`): a 20-message trial on Groq, the Pro plan (300
  messages a day), and the owner's account with no limits. Anthropic messages
  count as 10 because they cost far more. Non-owners use OpenRouter's free
  router and Claude Haiku, whatever the app asks for.
- **A daily total** for everyone but the owner (3,000 messages to start). Past it,
  shared AI pauses until midnight UTC, so a surprise bill can't happen.
- **Testers**, a hidden plan: the owner gets an email for every sign-up and can
  approve someone on the Owner page. To that person it looks exactly like the
  Pro plan; nothing they can see mentions testers. At most 10 to start.
- **The Owner page**, for the account in `OWNER_EMAIL` only: the API keys
  (stored encrypted), every account, approvals and the limits.

Not built yet: payments for the Pro plan, chats that follow the account to every
device, and running code on the server.

## Putting it online (once)

You need a free Cloudflare account and a free Resend account, then four
repository secrets, then one button.

1. **Cloudflare.** Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
   - Your **Account ID** is on the Workers & Pages page, on the right.
   - Make an **API token**: My Profile > API Tokens > Create Token > Create Custom Token, with
     these permissions: Account > Workers Scripts > Edit, Account > D1 > Edit,
     Account > Account Settings > Read, User > User Details > Read.
2. **Resend.** Sign up at [resend.com](https://resend.com) with the same email as the
   owner account, then API Keys > Create API key.
   Until you add a domain of your own in Resend (about $10 a year), it only sends to your
   own address. That's enough for you to sign in; other people need the domain, and then
   set `MAIL_FROM` (for example `CoDev <signin@yourdomain.com>`) as a Worker variable.
3. **GitHub secrets.** In this repository: Settings > Secrets and variables > Actions >
   New repository secret, once for each:

   | Name | Value |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | the token from step 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 1 |
   | `CODEV_OWNER_EMAIL` | your email; that account becomes the owner |
   | `RESEND_API_KEY` | the key from step 2 |

4. **Deploy.** Actions > Deploy CoDev server > Run workflow. When it finishes, its
   summary shows the server's address (`https://codev-cloud.<name>.workers.dev`).
   After this, changes to `cloud/` on main deploy on their own.
5. **In CoDev:** Settings > Sign in to CoDev > Server address: paste the address and
   save. Sign in with your email, open the **Owner page** and paste your Groq,
   OpenRouter and Anthropic keys.

The workflow makes the database and a secret that locks the stored keys
(`KEYS_SECRET`) the first time. Don't delete that secret in Cloudflare: the
stored keys can't be read without it, and you'd have to paste them again.

## Working on it

```
cd cloud
npm test          # the Worker against an in-memory database, no network
```

`../tests/cloud-account.test.js` drives the real page against it: sign-in, chat
with no key, and the Owner page.
