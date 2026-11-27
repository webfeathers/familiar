# Credentials — setup runbook

Every secret this system needs, where to get it, and the traps. **You enter all secret values
yourself** — into `.env` locally and into your host's environment variables in production.
Nothing here asks you to paste a secret into a chat.

Verify with `pnpm doctor` after each step; it checks presence *and* liveness and never prints a
secret value. On Railway, run it as `railway run --service Postgres pnpm doctor` so the database
URL is injected; bare `pnpm doctor` skips the database checks rather than failing them.

## The Google refresh-token trap — read this before creating anything

Google **revokes refresh tokens after 7 days** when the OAuth app's consent screen is
**User type: External** + **Publishing status: Testing**. The exemption is only for apps whose
scopes are a subset of name / email / profile — `calendar.readonly` is a *sensitive* scope, so it
does **not** qualify.

Publishing to "In Production" alone does **not** fix it: for sensitive scopes you must also pass
Google's verification review (privacy policy, homepage, demo video, weeks of latency).

This matters because the worker runs headless on a schedule. A 7-day token life means re-authing
every week, which destroys the whole point of a worker that runs when nobody is in a session.

**The clean fix: `User type: Internal`.** Internal apps are exempt from both the 7-day expiry and
the 100-test-user cap. Internal requires the app to live in a **Google Workspace** organisation.

**Do not click "Make external" on the Audience page** once it is Internal. That single button
reintroduces the 7-day refresh-token expiry and breaks headless ingestion within a week — quietly,
as stale data rather than a loud failure. If it is ever flipped, `pnpm doctor` reports
`invalid_grant` on the work token; that is the symptom.

**For a personal `@gmail.com` calendar**, which cannot be Internal, pick one:

| Option | Trade-off |
|---|---|
| **A. Share the personal calendar into the Workspace account** (Calendar → Settings → *Share with specific people* → the Workspace address) — then **one Internal credential reads both** | ✅ Recommended. No second OAuth app, no expiry, no verification. Read-only sharing is enough. |
| B. Complete Google verification for an External app | ❌ Heavy for a personal project. |
| C. Accept 7-day expiry and re-auth weekly | ❌ Defeats the design. |

> **Two different Google usages, two different requirements.** The *ingestion* credential needs a
> long-lived refresh token (above). The MCP server's *sign-in* delegation only reads an ID token to
> check `sub` — it never stores a refresh token, so the 7-day rule is irrelevant there. Don't
> conflate them.

---

## 1. Postgres — `DATABASE_URL`

Any Postgres 15+ with the `pgvector` extension works. On Railway:

```bash
railway login          # once
railway init           # name the project anything
railway add --database postgres
railway run --service Postgres pnpm db:migrate
railway run --service Postgres pnpm doctor
```

`railway run` injects the service variables, so **no database credential needs to live in `.env` at
all** — one less copy on disk.

> ⚠️ **Use `railway run --service Postgres` for migrations and DB tooling.** `railway run` injects
> the *linked* service's variables, and once your MCP service is the linked service that means
> `DATABASE_URL` (private, unresolvable off-platform) with **no `DATABASE_PUBLIC_URL` at all**.
> Symptoms are misleading: drizzle-kit exits 1 under a spinner with no message, and raw `pg` falls
> back to `localhost` and reports `ECONNREFUSED 127.0.0.1:5432` — neither of which points at the
> real cause. The Postgres service carries both URLs, so name it explicitly.

### ⚠️ Private vs public URL — the trap that costs an hour

Railway exposes **two** connection strings and they are not interchangeable:

| Variable | Host | Reachable from |
|---|---|---|
| `DATABASE_URL` | `postgres.railway.internal` | **only inside Railway** — free, fast, private |
| `DATABASE_PUBLIC_URL` | `*.proxy.rlwy.net` | anywhere — TCP proxy, billed egress |

Running migrations from a laptop against `DATABASE_URL` fails, and **drizzle-kit swallows the
error**: you get a spinner, then a bare `exit code 1` with no message. That is what this looks like.

`src/store/url.ts` encodes the rule — `runtimeDatabaseUrl()` for deployed services (private),
`toolingDatabaseUrl()` for migrations and doctor (prefers public). Don't bypass it. In production,
don't set `DATABASE_PUBLIC_URL` on the app services, so tooling collapses to the private URL there.

**pgvector:** the first migration runs `CREATE EXTENSION IF NOT EXISTS vector;`. Railway's Postgres
image ships it precompiled. If a fresh database errors with *"extension \"vector\" is not
available"*, install pgvector (on Railway, set `EXTENSIONS=vector` on the Postgres service and
redeploy) and re-run. `pnpm doctor` verifies the extension independently.

## 2. Google OAuth client — `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

console.cloud.google.com → new project → **APIs & Services**.

1. Enable the **Google Calendar API** and the **People API**.
2. **OAuth consent screen** → set **User type: Internal** if you have Workspace (see the trap
   above). Add scopes: `openid`, `email`, `profile`, `.../auth/calendar.readonly`,
   `.../auth/contacts.readonly`.
3. **Credentials → Create OAuth client ID → Web application**. Authorised redirect URIs:
   - `http://localhost:4711/callback` — for the token-minting script below
   - `https://<your-host>/oauth/google/callback` — for the MCP server's sign-in delegation

One client serves both uses.

## 3. Calendar refresh token — `GOOGLE_REFRESH_TOKEN_WORK`

**Prerequisite (if you have a personal calendar):** share it into the Workspace account first —
Google Calendar → the personal calendar's ⋮ → *Settings and sharing* → **Share with specific
people** → add `you@example.com` with *See all event details*. One credential then reads both.

With client id/secret in `.env`:
```bash
pnpm mint:google work
```
Opens a browser, you consent, the script prints the refresh token **to your terminal**. Paste it
into `.env` yourself. Requests `access_type=offline` + `prompt=consent`, which is what makes Google
return a refresh token at all.

`pnpm mint:google personal` (→ `GOOGLE_REFRESH_TOKEN_PERSONAL`) exists as an escape hatch, but on
the recommended path it is not needed — and a second External app would reintroduce the 7-day
expiry.

> Google returns a refresh token **only on first consent** for a given app+account. If it prints
> "no refresh_token returned", revoke at <https://myaccount.google.com/permissions> and re-run.

## 4. Your Google subject — `ALLOWED_SUBJECT`

The single-identity gate: `/authorize` issues a code only when the signed-in Google `sub` matches.
(With `AUTH_PROVIDER=github` or `oidc` it is your identifier there instead; see SELF-HOSTING.md,
step 1b.)
`pnpm mint:google work` prints your `sub` alongside the token. It is a stable numeric string, not
your email — email is mutable, `sub` is not.

## 5. MCP server secrets — `AUTH_SECRET`, `PUBLIC_URL`

```bash
openssl rand -base64 32   # → AUTH_SECRET (signs tokens and the OAuth state cookie)
```
`BETTER_AUTH_SECRET` is accepted as a legacy alias.

`PUBLIC_URL` is the public HTTPS origin of the MCP service. It must match the `issuer` in the AS
metadata **exactly** — a mismatch silently breaks discovery, and a hardcoded IP breaks it outright.

---

## Verify

```bash
pnpm doctor
```

Checks presence and liveness: Postgres reachable + `vector` installed + migrations applied,
each Google refresh token still exchangeable, and `PUBLIC_URL` well-formed. Values are masked in
all output.

No model API key appears anywhere in this runbook, on purpose. Nothing in Familiar calls a model,
so it runs without paid API credits.

## Hygiene

- `.env` is gitignored. Keep it that way; never commit it.
- Production secrets live in your host's environment variables, not in a file.
- Rotate anything that has ever been pasted into a chat, issue, or log — including with an
  assistant.
- The MCP service and the worker hold **different** credentials. The worker holds the ingestion
  tokens; the MCP service never needs them.
