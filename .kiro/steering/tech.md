# Tech stack & workflow

## Stack
- **Backend**: Rust (Axum + sqlx + PostgreSQL). Single large file
  `crates/backend/src/main.rs`. Shared valuation in `crates/core-engine` (`value_line`,
  `round_money`, golden tests).
- **Desktop**: Tauri 2 + React/TS + Vite, Tailwind v4 + shadcn-style primitives
  (cva + cn + tailwind-merge), `@/` path alias. App in `apps/desktop`.
  Notable deps: `xlsx` (SheetJS) for CSV/XLS/XLSX statement parsing; `jsbarcode` for tags.
- **DB**: migrations in `db/migrations` (auto-applied on backend startup).

## Local Postgres (no Docker/root)
- Micromamba Postgres in `~/cygnus-pg/bin`, port **5433**, DB `cygnus`.
- Backend connects as role `postgres` (trust). App login is `owner` / `newpass1`
  (rows in the app `app_user` table — NOT a PG role).

## Run the backend
```bash
cd "/media/honor/Data/Projects/Cygnus-Jewel-Suite"
cargo build -p backend
pkill -x backend 2>/dev/null; sleep 1
export PATH="$HOME/cygnus-pg/bin:$PATH"
export DATABASE_URL="postgresql://postgres@localhost:5433/cygnus?sslmode=disable"
setsid ./target/debug/backend > "$HOME/cygnus-backend.log" 2>&1 < /dev/null &
```
Backend listens on `http://127.0.0.1:8787`. Health: `GET /health`.

## Server / client mode (one binary, runtime flag)
- **Bind address**: `BIND_ADDR` (default `127.0.0.1:8787`; set `0.0.0.0:8787` on a shop server so
  counter PCs can connect). Clients run only the desktop app, pointed at `http://<server-ip>:8787`
  (login-screen "Server" field → `localStorage.cygnus_base`).
- **Embedded PostgreSQL** (optional): build with the `embedded-pg` feature and run with `--server`
  (or `CYGNUS_MODE=server`) → the backend boots/manages its own **PostgreSQL 18** (crate
  `postgresql_embedded`, **rustls** — not native-tls, which needs system OpenSSL). Overrides:
  `CYGNUS_DATA_DIR` (default `~/.cygnus/pgdata`), `EMBEDDED_PG_PORT` (5433), `EMBEDDED_PG_PASSWORD`.
  ```bash
  cargo build -p backend --features embedded-pg
  ./target/debug/backend --server        # boots PG18 + migrates + serves on 0.0.0.0:8787
  ```
  *Known gap:* no SIGTERM handler yet, so killing server-mode leaves the embedded PG orphaned.
- **Connected clients**: `/health` records caller IPs (desktop heartbeats every 15s) and returns
  `clients` (non-loopback machines active in last 60s) + `terminals`; footer shows Server/Client.

## Build / run the frontend
```bash
cd apps/desktop && pnpm build      # tsc + vite build — use to verify types
# dev server (vite :1420) hot-reloads; full app: setsid pnpm tauri dev
```

## Hard rules / gotchas
- **Migrations are embedded at compile time** via `sqlx::migrate!`. After adding a new
  migration file you MUST rebuild the backend (touch `main.rs` if cargo skips it) so it is
  embedded and applied on restart. Never edit an applied migration (checksum break) — always
  add a NEW migration.
- **sqlx has no chrono**: decode timestamps as `::text`. **Nullable NUMERIC** columns must
  decode as `Option<Decimal>` (e.g. ledger `amount_delta`/`weight_delta`).
- To apply backend changes: `cargo build -p backend`, then `pkill -x backend` + relaunch.
- **Never `pkill -f` a pattern that matches the running shell.** Kill the vite dev server by
  its port pid: `VPID=$(ss -ltnp|grep ':1420'|grep -oP 'pid=\K[0-9]+'); kill $VPID`.
- The file-read tool can serve STALE cached content — when in doubt verify with
  `sed -n`/`cat -n` via shell.
- **App/OS icons are embedded at app-build time** (like migrations): regenerate the whole set
  from a source PNG with `pnpm tauri icon <png>` (writes `src-tauri/icons/`), then restart
  `tauri dev` to see the new window/taskbar icon. The in-app logo (`public/logo.png`, used by
  sidebar/login/favicon) hot-reloads normally.
- After any change, run the relevant build (`cargo build -p backend` / `pnpm build`) and
  verify flows with `curl` before reporting done.
