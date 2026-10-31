# `harmony doctor auth-hook`

> B-1035 (the access-token half) · B-1300 (the before-user-created half) · CLI-only operator
> diagnostic, deliberately not in the shared MCP+CLI `src/tools/` surface.

A read-only check of the Supabase Auth hooks a Harmony project depends on. It never writes to auth
configuration and never touches the database with a connection string — both reads go through the
Supabase Management API under the operator's own `SUPABASE_ACCESS_TOKEN` (the Supabase CLI's personal-access-token env var). The token value is never logged or printed.

```bash
SUPABASE_ACCESS_TOKEN=<token> harmony doctor auth-hook [--project-ref <ref>]
```

`--project-ref` defaults to the Supabase project the CLI session is already configured against
(active `harmony login` project's Supabase URL, else `HARMONY_SUPABASE_URL`, else the hardcoded prod
project) when omitted.

## What one run prints

Two halves, in order, in a single run:

1. **Custom access-token hook (B-978)** — printed first and unchanged. Read from
   `GET /v1/projects/<ref>/config/auth` (GoTrue registration is platform state, not DB state, so a
   DB-only read would be a false green).
2. **Before-user-created hook (B-1298, B-1300)** — the invitation-only sign-up hook.
   - *Registration* is read off the **same** auth-config body (`hook_before_user_created_enabled` /
     `hook_before_user_created_uri`).
   - *Function existence* is separate Postgres catalog state, probed through
     `POST /v1/projects/<ref>/database/query` running
     `SELECT to_regprocedure('public.before_user_created_hook(jsonb)')` (read-only) under the same
     token. The endpoint answers **201 Created** on success.

A before-user-created **mismatch** in either direction prints a loud, greppable `WARN` naming the
hook and the direction:

- `REGISTERED` but the backing function `MISSING` — fails every sign-up.
- function `EXISTS` but the hook `NOT REGISTERED` — sign-up is silently left open.

## Exit code

The exit code is the **access-token half's** contract alone; the before-user-created half adds no
exit outcome of its own (a mismatch is a WARN, never a code):

| Code | Meaning |
|---|---|
| `0` | access-token hook registered |
| `1` | access-token hook not registered |
| `2` | cannot determine the access-token hook (missing token, HTTP 401/403/404, network error, or an unparseable response) |
