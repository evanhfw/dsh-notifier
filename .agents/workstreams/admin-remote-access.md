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

## Operator-side rollout (outside this repo)

- `~/docker/reverse-proxy/Caddyfile`: added a `notifier.ehw.my.id` block with a `tls { dns cloudflare ... }` directive (DNS-01 — HTTP-01 cannot work because the name resolves to a Tailscale address) and a `@tailscale remote_ip 100.64.0.0/10` matcher, with `respond 403` as the fallthrough.
- First attempt omitted the `tls` block; Caddy fell back to HTTP-01 and failed with `no valid A records found`. Caught in the container log and fixed before declaring success.
- Profile `cordis.patch.yml`: `admin.allowedHosts: [notifier.ehw.my.id]`, `admin.allowedOrigins: [https://notifier.ehw.my.id]`, `admin.publicUrl: https://notifier.ehw.my.id`.
- Caddy runs with `admin off`, so `caddy reload` is impossible; the change required `docker restart reverse-proxy` (brief drop for all proxied services).
- Verified: proxied console `200` with the English UI; `Host: notifier.ehw.my.id` direct `200`; `evil.example.com` / `dsh.ehw.my.id` / unlisted Origin all `403`; `127.0.0.1:8104` still `200`; non-Tailscale source (`127.0.0.1`) gets Caddy `403` with an empty body while a Tailscale source gets `200` — both defence layers independently confirmed.
- Remaining risk: the proxied console shares the same Bearer token model; anyone inside the tailnet can reach the unlock gate, so a leaked admin token remains the sole barrier to full credential write access.

### Correction: dsh runs under system scope, not user scope

Earlier in this session the reload/restart procedure was written against the **user** scope (`systemctl --user`, `~/.config/systemd/user/dsh.service`, `dbus-send --session` to `/run/user/1000/bus`). That scope no longer exists: `~/.config/systemd/user/dsh.service` is gone, the user-scope unit is unloaded (`NoSuchUnit`), and the live service is a **system** unit.

- Live unit: `/etc/systemd/system/dsh.service` (`User=evan`, `WantedBy=multi-user.target`), `MainPID=1305664`, started `16:23:36`.
- Consequence: user-scope `journalctl --user -u dsh.service` is a stale leftover and stops at the 16:23 handover. It is **not** the health signal for the running host, and reading it after the handover gives a misleading "stopped with no start" picture.
- Correct health checks: `systemctl is-active dsh.service` / `systemctl show dsh.service -p MainPID -p ActiveState`, and `journalctl -u dsh.service` (no `--user`).
- Correct restart: `sudo systemctl restart dsh.service`. The sandbox sets the no-new-privileges flag, so `sudo` cannot escalate from an agent shell — a restart must be run by the operator, or requested explicitly.
- `CanStop=yes` is reported for the invoking user, but escalation is still required in practice; do not assume an agent-side restart works just because `systemctl show` says so.
- Re-verified after the handover: plugin still resolves to the repo path, tip `fa6af24`; proxied console `200` with the English UI; unlisted Host `403`; non-Tailscale source `403`; **0** Telegram polling failures since the 16:23:36 start (the earlier 15:1x `fetch failed` burst belongs to the pre-handover user-scope run, not the current process).
