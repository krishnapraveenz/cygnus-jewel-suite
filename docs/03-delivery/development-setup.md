# Development Setup

How to set up the toolchain and run Cygnus Jewel Suite locally. This describes the intended
setup for Phase 0/1; commands are indicative and will be finalized as the scaffold lands.

---

## Prerequisites

| Tool | Version (min) | Used for |
|---|---|---|
| **Rust** (rustup) | stable (latest) | core-engine, backend, Tauri core |
| **Node.js** | **22 LTS** ("Jod") | desktop UI tooling (Vite/React) |
| **pnpm** | 10+ | JS package manager (monorepo workspaces); supports Node 22 |
| **PostgreSQL** | 17+ | primary database |
| **Redis** | 7.4+ | cache / pub-sub |
| **Docker** + Compose | latest | local Postgres/Redis/MinIO |
| **Tauri prerequisites** | per-OS | webview + build deps (see Tauri docs) |

Per-OS Tauri system deps:
- **Linux:** `webkit2gtk`, `libayatana-appindicator`, build-essential.
- **macOS:** Xcode command-line tools.
- **Windows:** WebView2 runtime + MSVC build tools.

> **Pin the Node version.** Commit an `.nvmrc` containing `22` and set the root
> `package.json` `engines` field to `"node": ">=22 <23"` and `"pnpm": ">=10"` so everyone
> builds on the same Node 22 LTS line. Use `corepack enable` to pin the pnpm version.

---

## Repository layout

```
cygnus-jewel-suite/
  crates/
    core-engine/      # Rust: valuation, conversions, tax, ledger types (shared)
    backend/          # Rust + Axum: API, WebSocket, sync, integrations
  apps/
    desktop/          # Tauri 2 + React/TS
  packages/
    ui/               # Shared React components
    api-client/       # Generated TS API client
  db/
    migrations/       # SQL migrations
  docs/               # Documentation (this set)
```

> `apps/web-b2b` (Next.js) and `apps/mobile` (React Native) are **deferred** to a future
> release and are not part of the current repo. The backend API + `packages/ui` keep the
> seams open to add them later.

---

## Local PostgreSQL without root (no-Docker option)

Docker is **not** required. On a machine without root/Docker, you can run a self-contained
PostgreSQL from the home directory (this is also how the **portable server bundle** is
proven — see deployment-and-sync.md "Installation modes"):

```bash
# one-time: install Postgres into ~/cygnus-pg via micromamba (no root)
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj bin/micromamba
MAMBA_ROOT_PREFIX=$HOME/micromamba ./bin/micromamba create -y -p $HOME/cygnus-pg -c conda-forge postgresql

# one-time: init a data dir (trust auth, local dev only)
$HOME/cygnus-pg/bin/initdb -D $HOME/cygnus-pg-data -U postgres -A trust --locale=C --encoding=UTF8

# start / stop (port 5433 to avoid clashes)
$HOME/cygnus-pg/bin/pg_ctl -D $HOME/cygnus-pg-data -l $HOME/cygnus-pg.log -o "-p 5433 -k /tmp" -w start
$HOME/cygnus-pg/bin/pg_ctl -D $HOME/cygnus-pg-data stop

# create db + apply migrations
$HOME/cygnus-pg/bin/createdb -h /tmp -p 5433 -U postgres cygnus
$HOME/cygnus-pg/bin/psql -h /tmp -p 5433 -U postgres -d cygnus -f db/migrations/0001_init.sql
```

Dev connection string:
```
DATABASE_URL=postgresql://postgres@localhost:5433/cygnus
```

(Production shop servers get a bundled PostgreSQL via the installer — this no-root flow is
for development on machines where you can't or don't want to install system packages.)

---

## First-time setup

```bash
# 1. Clone
git clone <repo-url> cygnus-jewel-suite && cd cygnus-jewel-suite

# 2. Start infra (Postgres, Redis, MinIO) locally
docker compose up -d

# 3. Backend + DB
cp .env.example .env            # set DATABASE_URL, REDIS_URL, etc.
cargo run -p backend -- migrate # apply DB migrations
cargo run -p backend            # start API + WebSocket

# 4. JS deps
pnpm install

# 5. Desktop app (dev)
pnpm --filter desktop tauri dev
```

---

## Environment variables (indicative)

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` | Auth (Keycloak) |
| `OBJECT_STORE_*` | S3/MinIO credentials |
| `NIC_EINVOICE_*` / `NIC_EWAYBILL_*` | Direct NIC e-invoice (IRP) + e-Way bill API creds (sandbox first) |
| `SERVER_LAN_ADDR` | Address terminals use to reach the shop server |

Secrets must come from `.env` (gitignored) or a secrets manager — never committed.

---

## Running tests

```bash
cargo test -p core-engine     # valuation golden-file + property tests
cargo test -p backend         # API + double-sale guard integration tests
pnpm --filter desktop test    # UI unit tests
pnpm test:e2e                 # end-to-end POS flows (later phases)
```

The `core-engine` test suite is the most important: it guarantees the counter preview and
the server commit agree to the paisa. Add a golden-file case for every pricing edge case
you encounter.

---

## Coding standards

- **Money/weight only via `core-engine` + `rust_decimal`.** No float math, no ad-hoc
  pricing in UI or SQL.
- **All mutations go through the backend** and produce `LedgerEvent`s; never bypass the
  ledger.
- **Parameterized SQL only.** Validate inputs (weight/money/HUID) at the boundary.
- TypeScript strict mode; Rust `clippy` clean; format with `rustfmt` + Prettier.
- Conventional commits; PRs require green CI on all three OSes.

---

## Local multi-PC testing (LAN model)

To simulate the shop LAN setup on one dev machine:
- Run the backend + Postgres as the "server".
- Launch two desktop instances pointing at the same `SERVER_LAN_ADDR`.
- Try to sell the same item from both to verify the double-sale guard and the WebSocket
  live update. See ../02-architecture/deployment-and-sync.md.

---

## Next steps after setup

Follow [roadmap-and-phases.md](roadmap-and-phases.md) starting at Phase 0, then Phase 1
(the correctness core). Build the valuation engine and event ledger before any sales UI.
