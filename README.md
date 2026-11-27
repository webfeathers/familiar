<p align="center">
  <img src="docs/assets/grimalkin-avatar.svg" alt="Grimalkin: a black cat in a witch's hat" width="180">
</p>

<h1 align="center">Grimalkin</h1>

Your assistant's familiar: a self-hosted memory and context layer for Claude (and other MCP clients). It keeps a durable
model of your life, made of the people, projects and facts your sessions teach it plus your
calendar and contacts kept fresh by a background worker, and serves it to any client through one
remote MCP endpoint. It works the same from Claude on your phone, your laptop or Claude Code.

Grimalkin runs no model. The client does the reasoning with Grimalkin's tools, and memory changes only
when a session writes to it. There are no API keys to buy and no per-call model cost.

It is single-tenant by design: one deployment, one owner, gated to one account (Google by default,
or GitHub or any OIDC provider).

The name is an old word for a witch's cat, the kind of familiar that knows its keeper.

## What it does

- **Remembers.** `remember`, `forget`, `restore`, `update_entity`, `merge_entities`, `move_facts`
  and `retire_link` keep a graph of entities (people, organisations, projects) with facts and
  links, each carrying confidence and provenance. Deletes are soft and reversible.
- **Recalls.** `get_context` returns what is known about an entity, ranked, optionally narrowed by
  topic. `search` covers stored facts and then raw source material. `what_do_you_know` lists what
  is stored.
- **Briefs.** `upcoming` and `brief` read your calendar and attach what Grimalkin knows about the
  people you are meeting.
- **Learns how you work.** `how_i_work` returns an operating policy you write plus preferences
  sessions have noted with `note_preference`. Preferences gain confidence each time they are seen
  again; ones noted once and never again are retired after 45 days.
- **Ingests.** A worker syncs Google Calendar and Google Contacts on a schedule and runs the daily
  retention sweep.

## How it fits together

```
Claude mobile ─┐
Claude Desktop ┼─→  mcp service  ─→  Postgres + pgvector  ←─  worker
Claude Code   ─┘    (MCP tools,      (episodes, entities,     (ingest + retention)
                     OAuth 2.1)       facts, links)              ↑
                                                         Calendar, Contacts
```

One build, two processes, selected by `PCL_ROLE`: `mcp` serves the tools and the OAuth server,
`worker` ingests. Auth is a small OAuth 2.1 authorization server that delegates sign-in to Google
(or GitHub, or an OIDC provider such as Okta, Entra ID, Authentik or Keycloak) and accepts exactly
one account (`ALLOWED_SUBJECT`). Clients get two scopes:
`context:read` and `context:write`.

## Requirements

- Node 22 or newer, and pnpm
- Postgres 15+ with the `pgvector` extension
- A Google Cloud project with an OAuth client (for sign-in and for calendar and contacts access)
- An HTTPS host for the MCP service, since remote MCP clients need a public `https://` URL
- Docker, only to run the full test suite locally

## Setup

New to this? [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) walks through the whole thing step by step:
Google Cloud, a local or Railway deployment, and connecting Claude. The summary below is the
short version.

### 1. Install

```bash
git clone https://github.com/webfeathers/grimalkin.git
cd grimalkin
pnpm install
cp .env.example .env
```

### 2. Database

Create a Postgres database with pgvector available and put its URL in `DATABASE_URL`. If your
migrations run from a laptop against a hosted database with separate private and public URLs, set
`DATABASE_PUBLIC_URL` too; migration tooling prefers it.

```bash
pnpm db:migrate
```

The first migration runs `CREATE EXTENSION IF NOT EXISTS vector;`. The worker also applies pending
migrations when it starts, so later schema changes need no manual step.

### 3. Google OAuth client

In Google Cloud Console, create an OAuth client of type **Web application**, enable the Google
Calendar API and the People API, and add these authorised redirect URIs:

```
https://<your-host>/oauth/google/callback    # sign-in to the MCP service
http://localhost:4711/callback               # pnpm mint:google, run once on your machine
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then mint the worker's refresh token and find
your Google `sub`:

```bash
pnpm mint:google work
```

It prints a refresh token for `GOOGLE_REFRESH_TOKEN_WORK` and your `sub` for `ALLOWED_SUBJECT`.
Use the `sub` (a stable number), not your email address.

> **The 7-day trap.** Google revokes refresh tokens after 7 days for apps whose consent screen is
> *External* and *Testing*, because calendar access is a sensitive scope. If your account is on
> Google Workspace, set the consent screen's user type to **Internal** and the token does not
> expire. To include a personal Gmail calendar, share it (read-only) with your Workspace account
> and one token reads both. On a plain Gmail account you will need to re-run `pnpm mint:google`
> weekly or take the app through Google's verification. See `docs/CREDENTIALS.md`.

### 4. Configure

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PUBLIC_URL` | Exact public origin of the MCP service, e.g. `https://grimalkin.example.com`, no trailing slash |
| `AUTH_SECRET` | Signs issued tokens and the OAuth state cookie. At least 32 random characters; generate with `openssl rand -base64 32` |
| `ALLOWED_SUBJECT` | The one identity allowed to sign in: your Google `sub`, or your ID at the provider set by `AUTH_PROVIDER` |
| `AUTH_PROVIDER` | Optional: `github` or `oidc` to sign in without Google. See `docs/SELF-HOSTING.md`, step 1b |
| `PCL_SELF` | Your name, used for the owner entity that preferences attach to. Defaults to `Owner`; set it before first use, since renaming later points preferences at a different entity |
| `PCL_SELF_EMAILS` | Your own addresses or domains, comma-separated (`me@example.com, example.com`), left out of meeting briefs |
| `PCL_TIMEZONE` | Your time zone as an IANA name (`America/Los_Angeles`), so calendar times in `brief` and `upcoming` read in it. Defaults to the server's, usually UTC |
| `PCL_OPERATING_POLICY` | Optional operating policy for `how_i_work`, one rule per line. Unset, a short neutral policy applies |
| `PCL_OPERATING_POLICY_VERSION` | Optional label for that policy; bump it when the rules change |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The OAuth client from step 3 |
| `GOOGLE_REFRESH_TOKEN_WORK` | The worker's refresh token from step 3 |
| `PCL_ROLE` | `mcp` (default) or `worker` |
| `PORT` | Listen port for the MCP service, default `8080` |

Check everything with:

```bash
pnpm doctor
```

It confirms each credential is present and live, and never prints a secret.

### 5. Run

```bash
pnpm build
PCL_ROLE=mcp    pnpm start    # the MCP service
PCL_ROLE=worker pnpm start    # the worker
```

Deploy both from the same build on any host that runs Node and gives the MCP service a public
HTTPS URL (Railway, Fly.io, Render, a VPS behind a reverse proxy). `GET /healthz` needs no auth and
reports whether migrations are current and the running commit. The commit comes from Railway's
`RAILWAY_GIT_COMMIT_SHA`; on other hosts it reads `unknown`.

### 6. Connect a client

Add a custom connector pointing at:

```
https://<your-host>/mcp
```

In Claude, that is Settings, Connectors, Add custom connector. You sign in with Google and approve
the scopes. Claude's hosted callback, Claude Code's loopback callback and ChatGPT's connector
callback are accepted; any other redirect is refused.

To have Claude use it automatically, add something like this to your Claude preferences:

> At the start of any substantive session, call `how_i_work` from the grimalkin connector to load my
> working preferences. When something is learned about how I like to work, record it with
> `note_preference`.

## Development

```bash
pnpm dev:mcp        # MCP service with reload
pnpm dev:worker     # worker with reload
pnpm typecheck
pnpm test           # full suite; starts a loopback pgvector container (needs Docker)
pnpm test:unit      # the no-database subset
pnpm db:generate    # regenerate migrations after editing src/store/schema.ts
```

The database tests refuse any database that is not on loopback with `test` in its name, so they
cannot reach a real deployment. Set `TEST_DATABASE_URL` to use your own test database instead of
the container.

`drizzle-kit generate` does not emit extension statements. If migrations are ever regenerated
from scratch, keep the hand-added `CREATE EXTENSION IF NOT EXISTS vector;` at the top of the first
one.

## Security model

- One owner. Sign-in is delegated to Google (or GitHub, or your OIDC provider) and only
  `ALLOWED_SUBJECT` gets through.
- Google is used to identify you; the MCP service stores no Google token. Only the worker holds a
  refresh token, and only with read-only calendar and contacts scopes.
- Redirect URIs are an exact allow-list, so the server is not an open redirector.
- Read and write are separate scopes, and tokens keep the scopes they were granted.
- Approving a client only counts from the browser that was shown the consent screen, and the
  screen cannot be framed by another site.
- Removing a connector revokes its refresh token. `pnpm auth:signout` signs every client out.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

Your memory lives in your own database. Back it up the way you would any database you care about.

## What it stores about other people

Grimalkin is about you, but most of what it holds is about the people around you, and they never
agreed to it. Know what you are collecting before you turn the worker on:

- **Contacts.** Every Google contact, with names, email addresses, phone numbers, organisations and
  job titles, the relations you set (such as "spouse" or "child"), and your notes on them.
- **Calendar.** Events from every calendar your Google account can see, from 90 days back to a year
  ahead: titles, descriptions, locations, and each attendee's name and email address.
- **What sessions remember.** Facts your Claude sessions store with `remember`, which are often about
  other people.

All of it stays in your database. Contacts and events you delete in Google are not removed from
Grimalkin. Nothing is sent anywhere else, except that whatever a tool returns goes to the MCP client
you connected, and from there to that client's model provider. Keep the deployment private, and
think twice before sharing an export or a database backup.

## Status

Grimalkin is a personal project shared as is. It runs daily for its author, but there is no support
commitment and the schema may change.

Issues are welcome, and I read them. Pull requests are reviewed when I have time, which may be a
while; for anything larger than a small fix, open an issue first so we can agree on it. Security
problems go through [SECURITY.md](SECURITY.md), not a public issue.

## License

MIT. See [LICENSE](LICENSE).
