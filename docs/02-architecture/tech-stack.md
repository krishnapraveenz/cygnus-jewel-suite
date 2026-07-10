# Tech Stack

The finalized technology choices for Cygnus Jewel Suite, with the reasoning behind each.
Two rules drive every choice: **fixed-point decimal math** for all weight/money, and an
**append-only event ledger** as the source of truth.

---

## At a glance

| Layer | Technology | Why |
|---|---|---|
| Desktop app (counter + back-office) | **Tauri 2** (Rust core + web UI) | One codebase -> Windows/Linux/macOS; native, small, secure; far lighter than Electron. |
| Desktop UI | **React + TypeScript**, **Vite** | Mature, fast, huge ecosystem; typed for safety. |
| UI components/styling | **shadcn/ui + Tailwind CSS** | Accessible, consistent, quick to build. |
| Client state | **Zustand** | Simple local state. |
| Server state/cache | **TanStack Query** | Caching, background refetch, offline-friendly. |
| Shared core logic | **Rust crate** (`core-engine`) | One source of truth for valuation, conversions, tax — reused by desktop + backend. |
| Decimal math | **`rust_decimal`** | Fixed-point; never floating point for weight/money. |
| Backend API | **Rust + Axum** | Performance, safety, shares the core crate; great for the LAN server. |
| Primary database | **PostgreSQL 17+** | ACID, reliable under concurrency, rich features, LISTEN/NOTIFY for real-time. |
| Event ledger | **Postgres append-only tables** | Immutable movement log; backbone of audit + loss prevention. |
| Local cache (desktop) | **SQLite** (via the Tauri/Rust side) | Offline reads + outbox for resilience during network blips. |
| Cache / pub-sub | **Redis** | Rate cache, sessions, fan-out. |
| Real-time updates | **WebSocket + Postgres LISTEN/NOTIFY** | Instant cross-terminal updates (stock/rate changes). |
| Object storage | **S3-compatible** (MinIO on-prem / cloud S3) | Item photos, certificates. |
| Auth | **OIDC (Keycloak self-hosted)** | Standard, RBAC, self-hostable for on-prem shops. |
| Messaging | WhatsApp Business API / SMS gateway | Reminders, campaigns. |
| Biometric attendance | **ADMS push (HTTP) + ZKTeco Pull SDK (TCP 4370)** | LAN integration with eSSL / CP Plus / ZKTeco; vendor-abstraction adapter in the backend. |
| Tax integration | **Direct NIC APIs** | e-invoice (IRP/NIC → IRN + QR) and e-Way bill (NIC) — **direct connection, no GSP middleman**. |
| Accounting export | Tally / QuickBooks connectors | Hand off to the accountant's tools. |
| Containerization | **Docker** | Reproducible deploys. |
| Orchestration (cloud) | **Kubernetes** (cloud only) | Multi-branch cloud master; not needed on-prem. |
| On-prem deploy | **Single binary + Postgres** | Simple shop server; see deployment-and-sync.md. |
| CI/CD | **GitHub Actions** (or GitLab CI) | Build/test/sign installers for 3 OSes. |

---

## Why Tauri (not Electron)

- Native webview instead of a bundled Chromium -> installers measured in MB, low memory.
- Rust backend runs on the same machine, so the **valuation engine and DB/cache access
  live in Rust**, not JavaScript — exactly where we want money math.
- Strong security model (explicit command allow-list between UI and core).
- First-class Windows/Linux/macOS builds from one codebase.

## Why Rust for the core + backend

- The same **`core-engine` crate** is compiled into both the desktop app and the backend,
  so valuation/conversion/tax logic is provably identical everywhere. No "the bill differs
  between the counter and the server" bugs.
- `rust_decimal` gives exact fixed-point arithmetic — directly fixes the #1 incumbent bug.
- Memory safety + strong typing reduce the crashes/instability users complain about.

## Why PostgreSQL (not a file database)

- True ACID transactions and **row-level locking** prevent the double-sale of a unique
  piece across terminals.
- `LISTEN/NOTIFY` powers instant cross-terminal updates without polling.
- Robust under concurrent multi-counter writes — the opposite of shared-file databases
  (Access/SQLite-on-a-network-share) that corrupt and are the root of incumbent instability.

## Biometric attendance integration (eSSL / CP Plus / ZKTeco)

Devices sit on the **same LAN** as the shop server (see system-architecture + deployment).
A **vendor-abstraction adapter** in the backend normalizes differences:

- **Push-first (ADMS):** the device is pointed at an endpoint on the shop server and posts
  punch logs over HTTP in real time. Works even behind NAT/firewall, no port-forwarding.
  Supported by ZKTeco and eSSL (ZKTeco-compatible); many CP Plus models support push too.
- **Pull fallback (SDK):** the backend polls the device over **TCP port 4370** on a schedule
  using the ZKTeco-family protocol. Used for devices/sites where push isn't configured.
- CP Plus models that are not ADMS/ZKTeco-compatible are handled via their **vendor SDK**
  behind the same adapter interface (confirm per device model during onboarding).

Punches are ingested **idempotently** (a `dedup_key` reconciles push + pull overlap) and
stored as immutable events, exactly like stock movements. We store **punch logs + a
device-user-id -> staff mapping only — never raw biometric templates** (those stay on the
device). See ../02-architecture/data-model-erd.md and security.md.

## Repository shape (monorepo)

```
cygnus-jewel-suite/
  crates/
    core-engine/      # Rust: valuation, conversions, tax, ledger types (shared)
    backend/          # Rust + Axum: API, WebSocket, sync, integrations
  apps/
    desktop/          # Tauri 2 + React/TS (counter + back-office)
  packages/
    ui/               # Shared React component library (shadcn/ui based)
    api-client/       # Generated TS client for the backend API
  db/
    migrations/       # SQL migrations (sqlx/refinery)
  docs/               # This documentation set
```

> `apps/web-b2b` (Next.js) and `apps/mobile` (React Native) are **deferred** (see below)
> and are not part of the current repo scope. The backend already exposes an HTTP/WebSocket
> API and the UI is componentized in `packages/ui`, so they can be added later without
> re-architecture.

See [../03-delivery/development-setup.md](../03-delivery/development-setup.md) for the
toolchain and how to run it.

---

## Deferred to a future release (not current development)

The following are documented future work only. They are **out of the current build scope**;
nothing in Phases 0-4 depends on them.

| Deferred item | Technology (when built) | Why deferred now |
|---|---|---|
| Web B2B portal | Next.js (React/TS) | Retailers' self-service ordering; B2B works fully from the desktop app meanwhile. |
| E-commerce storefront | Next.js (React/TS) | Consumer online sales; in-store retail is complete without it. |
| Mobile sales-rep app | React Native | Field order capture; a laptop running the desktop app covers this for now. |

Deferring these removes all **public internet-facing surfaces** from the current build,
which simplifies the architecture and shrinks the security/attack surface considerably.
Seams kept open: a clean backend API + a shared React component library.

---

## Things deliberately NOT chosen (and why)

| Avoided | Reason |
|---|---|
| Floating-point money math | Source of rounding bugs; banned. |
| Electron | Heavy, memory-hungry, money math would live in JS. |
| Shared-file databases (Access/network SQLite) | Corruption under concurrent writes — the exact incumbent failure. |
| A single generic ERP (D365/SAP/Odoo) as the core | "Jewellery template" approach is why existing tools are buggy. |
| Cloud-only architecture | Shops need to bill during internet outages; LAN-first server required. |
