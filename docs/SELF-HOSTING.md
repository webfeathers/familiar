# Self-hosting Grimalkin

This guide takes you from a fresh clone to Grimalkin answering in Claude. Plan on about an hour,
most of it in Google Cloud Console. You end up with three pieces:

- **Postgres with pgvector**, which holds your memory.
- **The MCP service** (`PCL_ROLE=mcp`), which serves the tools and runs the OAuth sign-in. It needs a
  public HTTPS URL.
- **The worker** (`PCL_ROLE=worker`), which syncs Google Calendar and Contacts on a schedule and
  applies database migrations when it starts. It has no public port.

Both processes run the same build. Only `PCL_ROLE` differs.

If you only want to try it from Claude Code on your own machine, skip to
[Run it locally](#option-a-run-it-locally). To use it from the Claude apps (web, desktop, mobile),
deploy it somewhere with HTTPS; [Railway](#option-b-deploy-on-railway) is the path described here.

## What you need

- Node 22 or newer, and pnpm (`corepack enable` gives you the pinned version)
- A Google account. A Google Workspace account is strongly recommended; see
  [the 7-day trap](#the-7-day-trap) for why.
- Docker, for a local database (and for the test suite)
- For the hosted option, a Railway account (or any host that runs Node and terminates HTTPS)

```bash
git clone https://github.com/webfeathers/grimalkin.git
cd grimalkin
pnpm install
cp .env.example .env
```

## 1. Google Cloud: one OAuth client

Grimalkin uses Google twice, with one OAuth client:

- **Sign-in.** When a client connects, you sign in with Google and Grimalkin checks that your Google
  account is the one allowed in. It keeps no Google token from this. (You can sign in with GitHub
  or your own identity provider instead; see [step 1b](#1b-optional-sign-in-with-github-or-an-oidc-provider).
  The worker still uses Google for the calendar either way.)
- **Ingestion.** The worker holds one long-lived refresh token with read-only access to your
  calendar and contacts.

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (any name).
2. **APIs & Services → Library**: enable the **Google Calendar API** and the **People API**.
3. **OAuth consent screen** (shown as *Google Auth Platform* in newer consoles):
   - User type **Internal** if you are on Workspace. Otherwise **External**, and add your own
     address as a test user.
   - Scopes: `openid`, `email`, `profile`, `.../auth/calendar.readonly`,
     `.../auth/contacts.readonly`.
4. **Credentials → Create credentials → OAuth client ID → Web application.** Add these authorised
   redirect URIs:

   ```
   http://localhost:4711/callback                 # pnpm mint:google, run once on your machine
   https://<your-host>/oauth/google/callback      # sign-in, for a hosted deployment
   http://localhost:8080/oauth/google/callback    # sign-in, if you run it locally
   ```

   You can add the hosted one later, once you know your URL. It must match `PUBLIC_URL` exactly.

5. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Then mint the worker's token and find your Google account ID:

```bash
pnpm mint:google work
```

It prints a URL. Open it, consent, and the terminal prints two lines to paste into `.env`:

```
GOOGLE_REFRESH_TOKEN_WORK=...
ALLOWED_SUBJECT=...
```

`ALLOWED_SUBJECT` is your Google `sub`, a stable number. It is the whole access-control list: only
that account can sign in. (If the script says no refresh token was returned, remove the app at
<https://myaccount.google.com/permissions> and run it again.)

### The 7-day trap

Google revokes refresh tokens after 7 days when the consent screen is **External** and in
**Testing**, because calendar access is a sensitive scope. The worker would then stop syncing
quietly, and `pnpm doctor` would report `invalid_grant`.

- **Workspace:** use **Internal** and the token does not expire. To include a personal Gmail
  calendar, share it read-only with your Workspace address. The worker reads every calendar the
  account can see, so one token covers both.
- **Gmail only:** External/Testing works, but you will re-run `pnpm mint:google work` weekly and
  update the token, or take the app through Google's verification.

More detail is in [CREDENTIALS.md](CREDENTIALS.md).

## 1b. Optional: sign in with GitHub or an OIDC provider

By default you sign in with Google, and you can skip this step. To sign in another way, set
`AUTH_PROVIDER` and that provider's client. There is still exactly one owner: `ALLOWED_SUBJECT`
becomes your identifier at the provider you chose, and nobody else gets through.

Pick one provider per deployment. Switching later means setting `ALLOWED_SUBJECT` to your
identifier at the new provider. Every token names the identifier it was issued to, so when that
changes, connected clients stop working at once and ask you to sign in again.

**Finding your identifier.** For any provider, the easy way is to configure everything, leave
`ALLOWED_SUBJECT` as a placeholder, and try to connect once. The refusal page names the subject
you signed in as; put that in `ALLOWED_SUBJECT` and restart. It only ever shows you your own
identifier, never the owner's.

### GitHub

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App.
2. Homepage URL: your `PUBLIC_URL`. Authorization callback URL:
   `https://<your-host>/oauth/github/callback` (or `http://localhost:8080/oauth/github/callback`
   locally). GitHub allows one callback per app, so use one app per deployment.
3. Generate a client secret, then set:

   ```
   AUTH_PROVIDER=github
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   ALLOWED_SUBJECT=<your numeric GitHub user id>
   ```

`ALLOWED_SUBJECT` is your numeric user ID, not your username: usernames can be changed and then
claimed by someone else. Find it with `gh api user --jq .id`, or at
`https://api.github.com/users/<your-username>`. Grimalkin asks GitHub for no scopes; it reads
only your public profile to learn the ID, and keeps no GitHub token.

### OIDC (Okta, Microsoft Entra ID, Authentik, Keycloak, and others)

Any provider that publishes an OpenID Connect discovery document works. Create a **web**
application (a confidential client, with a secret) using the authorization-code flow, with the
redirect URI `https://<your-host>/oauth/oidc/callback`. Then set:

```
AUTH_PROVIDER=oidc
OIDC_ISSUER=...            # exactly as the provider writes it; see below
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_NAME=Okta             # optional: the name shown in messages
ALLOWED_SUBJECT=<your sub>
```

`OIDC_ISSUER` must equal the `issuer` value in `<issuer>/.well-known/openid-configuration`,
character for character, including any trailing slash. Grimalkin refuses a discovery document
that names a different issuer, and checks every ID token's signature, issuer, audience and
nonce, and uses PKCE. `pnpm doctor` fetches the document and tells you if the issuer does not
match.

| Provider | `OIDC_ISSUER` | Notes |
|---|---|---|
| Okta | `https://<org>.okta.com/oauth2/default` (or your custom authorization server) | Use the org server `https://<org>.okta.com` only if you have no custom one |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Use your tenant ID, not `common` or `organizations`. Entra's `sub` is different for every app, so find yours from the refusal page |
| Authentik | `https://<host>/application/o/<app-slug>/` | Keep the trailing slash |
| Keycloak | `https://<host>/realms/<realm>` | |

Optional settings:

- `OIDC_SCOPES`: scopes to request, default `openid`. Grimalkin needs only `sub`, so you rarely
  need more.
- `OIDC_TOKEN_AUTH_METHOD`: how the secret is sent to the token endpoint, `client_secret_basic`
  (default) or `client_secret_post`. Match what the app is configured for; Okta apps set to
  "client secret post" need the second.

`ALLOWED_SUBJECT` is the `sub` claim: for Okta, the user ID (`00u…`); for Keycloak, the user's ID
in the admin console; for Authentik, it depends on the provider's *Subject mode* (hashed user ID
by default). When in doubt, use the refusal page.

## 2. Configuration

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `PUBLIC_URL` | yes (mcp) | Exact origin of the MCP service, e.g. `https://grimalkin.example.com`. No trailing slash, no path. It becomes the OAuth issuer, so a mismatch breaks discovery |
| `AUTH_SECRET` | yes (mcp) | Signs access tokens and the sign-in state cookie. At least 32 characters: `openssl rand -base64 32` |
| `ALLOWED_SUBJECT` | yes (mcp) | Your identifier at the sign-in provider: your Google `sub` from `pnpm mint:google` by default, or see step 1b |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | The OAuth client from step 1 (used by the worker even if you sign in another way) |
| `AUTH_PROVIDER` | | `google` (default), `github` or `oidc`. See step 1b |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | with `github` | The GitHub OAuth App from step 1b |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | with `oidc` | The OIDC application from step 1b |
| `OIDC_NAME`, `OIDC_SCOPES`, `OIDC_TOKEN_AUTH_METHOD` | | Optional OIDC settings; see step 1b |
| `GOOGLE_REFRESH_TOKEN_WORK` | yes (worker) | The refresh token from step 1. Without it the service still runs, but nothing syncs |
| `PCL_ROLE` | | `mcp` (default) or `worker` |
| `PCL_SELF` | recommended | Your name, for the entity your preferences attach to. Defaults to `Owner`. Set it before first use: changing it later points preferences at a different entity |
| `PCL_SELF_EMAILS` | recommended | Your addresses or domains, comma-separated, so meeting briefs leave you out |
| `PCL_TIMEZONE` | recommended | Your time zone as an IANA name, such as `America/Los_Angeles`, so calendar times read in it. Defaults to the server's, usually UTC |
| `PCL_OPERATING_POLICY` | | Your own rules for `how_i_work`, one per line. Unset, a short neutral policy applies |
| `PCL_OPERATING_POLICY_VERSION` | | A label for that policy; change it when the rules change |
| `PORT` | | Listen port for the MCP service, default `8080`. Most hosts set it for you |
| `NODE_ENV` | | `production` on a host |
| `DATABASE_PUBLIC_URL` | | Only for running migrations or `pnpm doctor` from your laptop against a hosted database that has separate private and public URLs |

There is no model API key. Grimalkin never calls a model.

## Option A: run it locally

This is enough for Claude Code and other MCP clients on the same machine. The Claude apps cannot
reach `localhost`, so they need Option B (or an HTTPS tunnel, used the same way as a host).

Start Postgres with pgvector:

```bash
docker run -d --name grimalkin-pg \
  -e POSTGRES_PASSWORD=grimalkin -e POSTGRES_DB=grimalkin \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17
```

In `.env`:

```
DATABASE_URL=postgres://postgres:grimalkin@localhost:5432/grimalkin
PUBLIC_URL=http://localhost:8080
AUTH_SECRET=<openssl rand -base64 32>
```

plus the Google values from step 1. Then:

```bash
pnpm db:migrate
pnpm doctor          # checks every credential and the database; prints no secrets
pnpm build
PCL_ROLE=mcp    node --env-file=.env dist/main.js     # terminal 1
PCL_ROLE=worker node --env-file=.env dist/main.js     # terminal 2
```

`curl localhost:8080/healthz` should return `"ok":true` and `"migrations":"current"`. The worker
logs its schedules (calendar every 15 minutes, contacts daily) and runs each sync once at start,
pulling the last 90 days of calendar on the first run.

## Option B: deploy on Railway

1. **Create a project** and add a **PostgreSQL** database. Grimalkin's first migration runs
   `CREATE EXTENSION IF NOT EXISTS vector`. If that fails with *extension "vector" is not
   available*, set `EXTENSIONS=vector` on the Postgres service and redeploy it.
2. **Add the MCP service** from your fork or clone of the repo. Railway detects pnpm and runs
   `pnpm build` and `pnpm start`. Set its variables:
   - `PCL_ROLE=mcp`, `NODE_ENV=production`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}` (a reference to the database's private URL)
   - `AUTH_SECRET`, `ALLOWED_SUBJECT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the `PCL_SELF*`
     values
   - if you sign in with GitHub or OIDC, `AUTH_PROVIDER` and that provider's variables
3. **Give it a domain**: Settings → Networking → Generate Domain (or add your own). Set
   `PUBLIC_URL` to that exact `https://` origin, add `https://<that-host>/oauth/google/callback` to
   your Google OAuth client (or `/oauth/github/callback` or `/oauth/oidc/callback` to the app you
   made in step 1b), and redeploy. A health check path of `/healthz` is a good idea.
4. **Add the worker** as a second service from the same repo, with no domain. Variables:
   - `PCL_ROLE=worker`, `NODE_ENV=production`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN_WORK`
   - the same `PCL_SELF*` values as the MCP service

   The worker applies migrations on every start, so you do not need to run them by hand.
5. **Check it**: `https://<your-host>/healthz` should show `"ok":true`, your commit, and
   `"migrations":"current"`. To run `pnpm doctor` against the deployment from your laptop:

   ```bash
   railway run --service Postgres pnpm doctor
   ```

   Name the Postgres service so you get its public URL; the private one does not resolve off
   Railway.

Any other host works the same way: two processes from one build, a public HTTPS URL for the MCP
service, and the variables above. `/healthz` reports the commit only on Railway; elsewhere it reads
`unknown`.

## 3. Connect a client

The endpoint is `https://<your-host>/mcp` (or `http://localhost:8080/mcp` locally).

**Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector, and paste the
URL. Claude opens Grimalkin's consent page; approve it, sign in with the account you set as
`ALLOWED_SUBJECT`, and the tools appear. Connectors added on the web follow you to the apps.

**Claude Code:**

```bash
claude mcp add --transport http grimalkin https://<your-host>/mcp
```

Then run `/mcp` inside Claude Code and choose to authenticate.

**Other MCP clients.** Grimalkin's OAuth server identifies clients by
[Client ID Metadata Documents](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
and does not offer dynamic client registration. It sends codes only to Claude's hosted callback,
ChatGPT's connector callback, and loopback `http://localhost/callback` or
`http://127.0.0.1/callback` on any port. A client that needs dynamic registration, or uses another
redirect, is refused. Widening that list means editing `isAllowedRedirect` in
`src/mcp/config.ts`.

Clients get two scopes: `context:read` and `context:write`. A read-only connection can recall but
not remember.

### Make Claude use it

Add something like this to your Claude preferences (Settings → Profile):

> At the start of any substantive session, call `how_i_work` from the grimalkin connector to load my
> working preferences. When something is learned about how I like to work, record it with
> `note_preference`.

Then start teaching it: tell Claude to `remember` the people and projects you work with, and ask
for a `brief` before your next meeting.

## When something is wrong

| Symptom | Likely cause |
|---|---|
| The connector adds but never asks you to sign in | `PUBLIC_URL` does not match the URL you pasted (scheme, host, trailing slash) |
| Google says `redirect_uri_mismatch` | `https://<your-host>/oauth/google/callback` is missing from the OAuth client, or differs from `PUBLIC_URL` |
| After Google sign-in: *This account is not authorised for this server* | You signed in with a different Google account than the one `ALLOWED_SUBJECT` names. The page shows the subject you signed in as |
| GitHub says *The redirect_uri is not associated with this application* | The OAuth App's callback URL is not `https://<your-host>/oauth/github/callback` |
| *Could not reach …* after approving, with OIDC | Discovery failed. Run `pnpm doctor`: usually `OIDC_ISSUER` differs from the document's `issuer` (a trailing slash, or Entra's `common`) |
| *… returned an ID token that did not verify* | The ID token's issuer or audience does not match `OIDC_ISSUER` / `OIDC_CLIENT_ID` |
| OIDC token exchange failed | The secret is wrong, or the app expects the other `OIDC_TOKEN_AUTH_METHOD` |
| `pnpm doctor` shows `invalid_grant`, and calendar data goes stale | The refresh token was revoked; see [the 7-day trap](#the-7-day-trap) |
| `pnpm db:migrate` exits 1 with no message | It is trying a private database hostname from your laptop; use the public URL (`railway run --service Postgres …`) |
| `extension "vector" is not available` | The Postgres image lacks pgvector; use `pgvector/pgvector` locally or `EXTENSIONS=vector` on Railway |

## Keep it safe

- `.env` is gitignored. Keep secrets in your host's variables, not in files you commit.
- Your memory lives only in your database. Back it up like any database you care about.
- Access tokens last an hour. Refresh tokens last 30 days and are replaced on every use.
- `AUTH_SECRET` must be at least 32 characters, and random. The service refuses to start on a
  shorter one. Use `openssl rand -base64 32`, not something you typed.
- Removing the connector in a client revokes its refresh token. To sign every client out at once
  (a lost device, a token you think leaked), run `pnpm auth:signout`, then set a new `AUTH_SECRET`
  and restart the MCP service. Do both: the script ends the sessions, and the new secret cuts off
  access tokens that were already issued.
- Found a security problem? See [SECURITY.md](../SECURITY.md).
