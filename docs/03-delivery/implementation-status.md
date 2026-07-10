# Implementation Status

Snapshot of what is actually built and verified. Design intent lives in `01-product` /
`02-architecture`; this file tracks reality.

Last updated: 2026-07-10.

---

## Summary

A fully-functional, secured **jewellery retail & wholesale desktop ERP** runs end-to-end
on PostgreSQL 18 — every major business module is built, verified, and in daily use during
development. The system deploys as a **single binary** serving both server and client roles
via runtime config.

**Key numbers:** 71 SQL migrations, ~14k-line backend, ~50 component screens, 48+ reports
across 11 sections, 4 RBAC roles, Indian FY / GST-aligned.

---

## Built modules (all verified end-to-end)

| Module | Status |
|---|---|
| **Sales** — invoices, estimates, Normal/Touch, old-jewellery exchange, negotiated totals, split tender, returns (credit notes), on-approval, sale-or-return | ✅ Done |
| **Purchases** — B2B + local, 4 pricing modes, GST/ITC, settlement, returns (debit notes), tagging + bulk lots | ✅ Done |
| **Inventory & Stock** — materials, departments (5 types), barcoded items, tag printing, scan-to-open, loose stones, resale, metal accounts | ✅ Done |
| **Old Jewellery exchange** — gold/silver(touch%)/platinum/diamond ornaments, inline diamond ct/value, buyback %, department-driven, convert-to-stock (refurbish), metal-guard on melt + smith | ✅ Done |
| **Parties** — unified customer/supplier/smith, dual cash + metal ledger, per-party opening balances, e-invoice JSON | ✅ Done |
| **Schemes & Advances** — value (11+1) & gram schemes, printable passbook; amount + metal (locked-rate) advances | ✅ Done |
| **Workshop** — smith job-work issue/return/settle, reconciled metal + making ledger | ✅ Done |
| **Staff, attendance, leave & payroll** — biometric (ADMS push + CSV + LAN agent), holiday calendar, statutory (PF/ESI/PT/TDS), PF ECR + ESI exports, payslips, advances/loans | ✅ Done |
| **Banking** — per-account management, statements + reconciliation, fund transfers, manual entries, CSV/XLS/XLSX statement import + auto-match | ✅ Done |
| **Day close** — cash (denomination + variance + spot-check) and stock (weight-aggregate + barcode tag-scan + full-weigh) | ✅ Done |
| **Accounting** — full double-entry projection (COA, journal, TB, P&L, Balance Sheet, ledgers, expenses, receipts), idempotent rebuild from source docs | ✅ Done |
| **Opening balances** — single linked workbench (cash/bank/FA/GST/loans/advances/scheme/parties/stock), opening-stock intake (barcoded, no purchase side-effects), audit schedule | ✅ Done |
| **Data locking** — single books.lock_date, enforced across all mutating handlers, Settings UI | ✅ Done |
| **FY selection** — Indian Apr–Mar, Topbar chip, Reports quick-select, year-end close | ✅ Done |
| **Reports** — 48 reports across 11 sections, net of returns, GSTR-1/3B exports, gross profit, stock revaluation, per-section hub | ✅ Done |
| **Users & roles** — owner/manager/accountant/cashier, full user admin | ✅ Done |
| **Settings** — company profile, doc numbering, modules, materials/depts, date/timezone, print, FY & locking | ✅ Done |
| **Deployment** — server/client one binary (BIND_ADDR), embedded PG 18 (--server + embedded-pg feature), graceful shutdown, connected-clients indicator | ✅ Done |
| **UI** — grouped accordion sidebar (flyout on collapse), live rate ticker, dark/light themes, maximized window, A4 print framework, login branding | ✅ Done |

## Not built (deferred)

- Web B2B portal / e-commerce / mobile.
- Multi-branch (scoping + cloud sync).
- Offline cache + WebSocket live sync.
- Installation wizard / role-picker installer.
- Biometric live-pull validation (agent + ADMS written but unverified on hardware).
- Form-16 / 24Q (TDS) returns.
- Melt refining-loss valuation.

## Database migrations

71 migrations (`0001_init` → `0071_opening_coa`), applied automatically on backend startup
via `sqlx::migrate!`. See `db/migrations/` for the full list.

## Tests

| Suite | Count |
|---|---|
| `core-engine` golden tests (valuation A–G + target-floor) | 8 |
| `backend` unit tests (RBAC, FY, prefix, PAN, hash, tokens) | ~11 |
| `backend` HTTP+DB integration (full retail flow, auth lockout, purchase→sale, scheme, approval) | 5 |
| Frontend type-check (`pnpm build` / `tsc --noEmit`) | ✅ passes |

CI: `.github/workflows/ci.yml` (fmt + clippy + test, Windows/Linux/macOS).

## Run locally

```bash
# Backend (auto-migrates + bootstraps owner)
export DATABASE_URL="postgresql://postgres@localhost:5433/cygnus?sslmode=disable"
cargo run -p backend    # http://127.0.0.1:8787

# Desktop app
cd apps/desktop && pnpm install && pnpm tauri dev

# Embedded-server mode (no separate DB install)
cargo build -p backend --features embedded-pg
./target/release/backend --server
```

Default login: `owner` / `admin123`.
