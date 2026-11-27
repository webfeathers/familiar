# Security

Grimalkin holds personal data: the people you know, your calendar, and whatever your sessions have
remembered. If you find a way to read or change someone's data without being the owner of that
deployment, please tell me privately first.

## Reporting a vulnerability

Use GitHub's private reporting: the **Report a vulnerability** button under the repository's
[Security tab](https://github.com/webfeathers/grimalkin/security/advisories/new). Please do not open
a public issue or pull request for a security problem.

Include what you found, how to reproduce it, and which commit you tested. A proof of concept
against your own deployment is ideal. Please do not test against anyone else's.

## What to expect

Grimalkin is a personal project maintained by one person in spare time. There is no bounty and no
guaranteed response time. I will acknowledge a report as soon as I see it, usually within a week,
fix confirmed problems on `main`, and credit you in the advisory unless you would rather I didn't.

Only the latest commit on `main` is supported. There are no maintained release branches.

## Scope

In scope: the OAuth authorization server, token handling, the MCP endpoint, and anything that
lets someone other than the configured owner read or write a deployment's data.

Out of scope: problems that need the owner's own credentials or database access, weaknesses in a
particular host's configuration, and denial of service by sheer request volume. Grimalkin has no
general request rate limiting of its own; put it behind your host's if you need it.

## If you run Grimalkin

- Keep `AUTH_SECRET` long and random (`openssl rand -base64 32`). The service refuses to start on
  one shorter than 32 characters.
- To sign every client out, run `pnpm auth:signout`, then set a new `AUTH_SECRET` and restart the
  MCP service.
- Watch this repository's releases or advisories so you hear about fixes, and pull `main` when
  one lands.
