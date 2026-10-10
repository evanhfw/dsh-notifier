# Workstream: admin-remote-access

- Agent identity: `dsh-web-agent | deepseek-v4.1-flash | mybook-z6`
- Agent: `dsh-web-agent`
- Branch: `codex/admin-remote-access`
- Status: `done`
- Start/end: `2026-10-10 -> 2026-10-10`
- Scope: Wire the already-supported S-06 `allowedHosts`/`allowedOrigins` from config and add a browser-reachable `publicUrl` so a reverse-proxied Advanced Console is reachable and its launch link is host-correct.
- Plan:
  1. Confirm the gate really rejects proxied hosts (forged `Host` over native HTTP, not fetch — fetch rewrites forbidden headers).
  2. Add `admin.allowedHosts` / `admin.allowedOrigins` / `admin.publicUrl` parsing to `resolveConfig` with fail-closed normalization.
  3. Wire them into `createAdminServer` and pass a `publicUrl` accessor to the control surface.
  4. Prefer `publicUrl` for the standalone launch base, falling back to the loopback form.
  5. Focused tests (config normalization, launch URL, end-to-end gate through real `resolveConfig`), then full validation.
- Owned files: `src/config.mjs`, `src/index.mjs`, `src/control-surface/service.mjs`, `test/config.test.mjs`, `test/control-surface-service-v012.test.mjs`, `test/admin-origin.test.mjs`, `CHANGELOG.md`, `docs/memory/risks.md`
- Do not touch: `src/admin/server.mjs` (S-06 gate semantics stay as-is), `src/admin/ui/*` (i18n unrelated to this change)
- Validation: `npm test` (2017/2017), `node scripts/verify-host-compat.mjs`, `node scripts/gen-channel-matrix.mjs --check`, `node --check src/index.mjs`, `node scripts/verify-release.mjs`
- Adversarial review:
  - **Wildcard temptation**: rejected. Allow-list stays an explicit enumeration; unlisted Host/Origin still 403 (asserted by test).
  - **Case-sensitivity bug found and fixed during implementation**: dedup ran before lowercasing, so `A.example.com` and `a.example.com` both survived into the allow-list. Fixed by normalizing before the seen-set check; covered by a regression assertion.
  - **Self-referential initializer bug found and fixed**: an editing slip rewrote `raw.admin` to `rawAdmin` inside its own `const` initializer (`ReferenceError: Cannot access 'rawAdmin' before initialization`). Caught by a direct normalization probe before tests ran; `git diff` confirms the line is back to the original.
  - **Malformed `publicUrl`**: `javascript:`, `ftp:`, and unparseable strings all fall back to `''` rather than entering a launch link.
  - **Dead-link risk**: `adminPublicUrl` is consulted only after the `adminLocation?.port` readiness check, so a stopped admin server still returns `disabled`.
  - **Back-compat**: default (no config) behaviour is unchanged — empty lists and the loopback launch URL — asserted in both config and service tests.
- Handoff: Config-level reverse-proxy support landed on `codex/admin-remote-access`. The admin server still binds `127.0.0.1` only; reachability comes from the operator's proxy. End-to-end verification through a real HTTPS proxy (TLS termination, `X-Forwarded-*`, Cloudflare issuance) was **not** performed on this machine and is recorded in `docs/memory/risks.md`. Next step is the operator-side Caddy block plus the profile config, which are environment changes outside this repo. Commit id recorded on the branch tip.
