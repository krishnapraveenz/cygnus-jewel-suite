# Cygnus Jewel Suite

<p align="center">
  <img src="apps/desktop/public/logo.png" alt="Cygnus Jewel Suite" width="120" />
</p>
<h3 align="center">Cygnus Jewel Suite</h3>
<p align="center">Jewellery Sales & Management Platform</p>

---

A modern, cross-platform **jewellery retail & wholesale management platform** for gold,
silver, platinum, diamond and precious-stone businesses in the Indian market.

Built to fix the chronic problems of legacy jewellery software — rounding bugs in
weight/purity math, stale-rate pricing, broken old-gold exchange, lost "goods-out"
tracking, multi-PC data corruption, and weak GST compliance — with a **correct-by-design
valuation engine** and an **append-only audit ledger** at its core.

> **Status:** Actively developed and far along. A secured retail + wholesale desktop app
> runs end-to-end on PostgreSQL — sales, purchases, inventory, old gold, schemes, advances,
> staff & payroll, banking, day-close, double-entry accounting and GST reporting are all
> built. Web B2B portal, e-commerce, mobile, and multi-branch cloud sync are deferred to a
> future release; the data model leaves clean seams for them.

---

## Table of contents

- [Why Cygnus](#why-cygnus)
- [Design rules (non-negotiable)](#design-rules-non-negotiable)
- [Feature overview](#feature-overview)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Getting started (development)](#getting-started-development)
- [Deployment: server & client on a shop LAN](#deployment-server--client-on-a-shop-lan)
- [Testing](#testing)
- [Documentation](#documentation)
- [Platforms](#platforms)
- [License](#license)

---

## Why Cygnus

Incumbent jewellery software commonly suffers from:

- **Floating-point errors** in weight, purity and money calculations.
- **Stale metal rates** silently applied to bills.
- **Broken old-gold exchange** logic (mixing gross/net/stone weight).
- **Lost tracking** of items sent out on approval / sale-or-return.
- **Data corruption** from multiple PCs opening a shared database file.
- **Weak GST / statutory compliance.**

Cygnus addresses each of these directly with fixed-point math, a live-rate pipeline, a
purpose-built valuation engine, and a client/server model where every terminal talks to one
backend — never to a shared DB file.

## Design rules (non-negotiable)

1. **Fixed-point decimal math** for every weight and money value — never floating point.
2. **Append-only event ledger** — every gram, stone and rupee movement is recorded as an
   immutable event (who, when, before/after). This is the backbone of auditability and loss
   prevention.

## Feature overview

- **Sales** — multi-line invoices & estimates, Normal/Touch (wholesale) billing, old-gold
  exchange, negotiated totals, split tender, returns with settlement, on-approval / sale-or-
  return-out.
- **Purchases** — local & B2B bills with per-line modes (touch / weight-rate / fixed-cost /
  stone), 3% GST + input tax credit, supplier settlement, purchase returns (debit notes).
- **Inventory & Stock** — materials manager (metals, stones, categories, departments),
  two-stage purity, resale items, loose-stone inventory, metal accounts.
- **Barcode & tagging** — Code128 SKUs (metal/karat-prefixed), tag-sheet printing, bulk-lot
  intake and weigh-out, scan-to-open on the Stock screen.
- **Parties** — unified customer/supplier model with dual cash + metal ledgers and
  e-invoice JSON export.
- **Schemes & Advances** — savings schemes (value & gram types) with printable passbook;
  amount advances and locked-rate metal (gold) bookings.
- **Old gold & rate cutting** — scrap intake with fine-content tracking; unfixed metal and
  rate-cutting (grams ↔ money) for B2B.
- **Workshop** — smith / job-work issue & return with a reconciled metal + making ledger.
- **Staff, attendance, leave & payroll** — biometric device integration (eSSL / CP Plus /
  ZKTeco via ADMS push, CSV import, and a LAN sync agent), holiday calendar, statutory
  payroll (PF / ESI / PT / TDS) with PF ECR and ESI return exports, printable payslips.
- **Banking** — bank-account management, per-account statements & reconciliation, fund
  transfers, manual entries, and CSV/XLS/XLSX statement import with auto-matching.
- **Day close** — cash drawer (denomination counting + variance) and stock counting
  (weight-aggregate and barcode tag-scan) with permissioned reopen.
- **Accounting** — full double-entry projection (chart of accounts, journal, trial balance,
  P&L, balance sheet, ledgers) generated idempotently from source documents.
- **Reports** — a per-section hub with dozens of registers across Sales, Purchases,
  Inventory, Old Gold, Workshop, Staff, Banking and Accounts & Compliance, all net of
  returns, plus GSTR-1 / GSTR-3B exports.
- **Users & roles** — owner / manager / accountant / cashier RBAC.
- **Settings** — company profile, document numbering, optional-module toggles, date format &
  timezone, print & page setup.

## Tech stack

| Layer | Technology |
|---|---|
| Valuation engine | **Rust** (`core-engine`) — fixed-point decimal math, golden-tested |
| Backend API | **Rust** + **Axum** + **sqlx** over **PostgreSQL** |
| Desktop client | **Tauri 2** + **React** + **TypeScript** + **Vite**, Tailwind v4 |
| Database | **PostgreSQL 18** (embeddable for single-install servers) |
| Migrations | SQL files auto-applied on backend startup via `sqlx::migrate!` |

## Architecture

Cygnus follows a **"one brain, many screens"** model — never a shared database file.

```
        +-----------------------------------------------+
        |            SHOP SERVER (one machine)          |
        |   • PostgreSQL 18  (single source of truth)   |
        |   • Backend API (Axum, binds the LAN)         |
        |   Static LAN address, e.g. 192.168.1.10:8787  |
        +----------------^------------^-----------^------+
                         | LAN
        +----------------+--+ +-------+------+ +--+-----------+
        | Counter PC 1     | | Counter PC 2 | | Manager PC   |
        | Desktop app      | | Desktop app  | | Desktop app  |
        +------------------+ +--------------+ +--------------+
```

- The **backend + PostgreSQL** are the server; the **desktop app** is a thin client that
  talks to the backend over HTTP.
- The **same binary** serves both roles — the role is a runtime flag, not a separate build.

## Repository layout

```
Cargo.toml                      # Rust workspace
crates/
  core-engine/                  # shared valuation / conversion / tax engine (fixed-point, tested)
  backend/src/main.rs           # Axum + PostgreSQL API (routes + handlers)
apps/desktop/                   # Tauri 2 + React/TS client
  src/api.ts                    # typed backend client (all DTOs)
  src/components/               # feature screens (sales, purchases, inventory, accounts, …)
  src-tauri/                    # Tauri shell + bundler config
db/migrations/                  # 0001..0068 SQL migrations (auto-applied on startup)
docs/                           # product / architecture / delivery documentation
tools/                          # reseed scripts + on-LAN biometric sync agent
.github/workflows/ci.yml        # CI: fmt + clippy + test on Windows/Linux/macOS
```

## Getting started (development)

### Prerequisites

- **Rust** (stable, 1.80+)
- **Node.js** + **pnpm**
- **PostgreSQL** (a local instance is fine; see the dev-setup doc for a no-root option)
- Tauri 2 system prerequisites (WebView2 on Windows, `webkit2gtk` on Linux, Xcode CLT on macOS)

### 1. Run the backend

The backend auto-applies migrations and bootstraps an `owner` user on first run.

```bash
# point DATABASE_URL at your local PostgreSQL
export DATABASE_URL="postgresql://postgres@localhost:5432/cygnus?sslmode=disable"
cargo run -p backend
# listens on http://127.0.0.1:8787  ·  health: GET /health
```

### 2. Run the desktop app

```bash
cd apps/desktop
pnpm install
pnpm tauri dev        # launches the desktop window (Vite dev server on :1420)
# or: pnpm build      # type-check + production web build
```

Default login: `owner` / `admin123` (override the bootstrap password with the
`BOOTSTRAP_OWNER_PASSWORD` environment variable).

## Deployment: server & client on a shop LAN

The same backend binary runs as a **standalone**, a **shop server**, or is simply not run at
all on **client** PCs. Behaviour is controlled by two environment variables and one flag.

| Setting | Effect |
|---|---|
| `BIND_ADDR` | Listen address. Default `127.0.0.1:8787` (localhost only). Set to `0.0.0.0:8787` on a server so counter PCs can connect. |
| `--server` / `CYGNUS_MODE=server` | Run in **server** role. With the `embedded-pg` build, the backend boots and manages its own PostgreSQL 18 and opens the API to the LAN automatically. |
| `DATABASE_URL` | Connection string when using an external PostgreSQL. |

### Embedded-PostgreSQL server (single install)

Build with the optional `embedded-pg` feature so a server PC needs **no separate database
install** — the backend downloads/caches (or, with the crate's `bundled` feature, embeds) a
PostgreSQL 18 build and manages its lifecycle:

```bash
cargo build -p backend --features embedded-pg --release
./backend --server        # boots PostgreSQL 18, migrates, serves on 0.0.0.0:8787
```

Optional server-mode overrides: `CYGNUS_DATA_DIR` (data directory, default `~/.cygnus/pgdata`),
`EMBEDDED_PG_PORT` (default `5433`), `EMBEDDED_PG_PASSWORD`.

### Client PCs

Client PCs run only the desktop app and point it at the server address (entered once on the
login screen, e.g. `http://192.168.1.10:8787`). PostgreSQL is never exposed to clients — only
the backend is.

> **Security note:** LAN traffic is plain HTTP, intended for a trusted shop network behind a
> router/firewall. Do not expose the backend port to the public internet.

## Testing

```bash
cargo test -p core-engine     # valuation golden tests (fixed-point correctness)
cargo test --workspace        # engine + backend tests
cd apps/desktop && pnpm build # frontend type-check
```

CI (`.github/workflows/ci.yml`) runs `fmt`, `clippy` and tests across Windows, Linux and
macOS.

## Documentation

Full documentation lives under [`docs/`](docs/README.md):

| Area | Document |
|---|---|
| Vision & scope | [docs/01-product/vision-and-scope.md](docs/01-product/vision-and-scope.md) |
| Module specification | [docs/01-product/module-specification.md](docs/01-product/module-specification.md) |
| Tech stack | [docs/02-architecture/tech-stack.md](docs/02-architecture/tech-stack.md) |
| System architecture | [docs/02-architecture/system-architecture.md](docs/02-architecture/system-architecture.md) |
| Deployment & sync (LAN / multi-branch) | [docs/02-architecture/deployment-and-sync.md](docs/02-architecture/deployment-and-sync.md) |
| Data model / ERD | [docs/02-architecture/data-model-erd.md](docs/02-architecture/data-model-erd.md) |
| Valuation engine spec | [docs/02-architecture/valuation-engine-spec.md](docs/02-architecture/valuation-engine-spec.md) |
| Development setup | [docs/03-delivery/development-setup.md](docs/03-delivery/development-setup.md) |

## Platforms

Runs on **Windows, Linux and macOS** from a single desktop codebase. A web B2B portal,
e-commerce storefront and mobile sales app are **deferred to a future release**; the backend
is designed so they attach later without re-architecture.

## License

**Proprietary — all rights reserved.** This software is not open source; see
`Cargo.toml` (`license = "UNLICENSED"`). Contact the project owner for usage or licensing.
