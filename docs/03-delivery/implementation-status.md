# Implementation Status

Snapshot of what is actually built and verified, versus the design docs. Update as work
proceeds. (Design intent lives in `01-product` / `02-architecture`; this file tracks
reality.)

Last updated: 2026-06-27 (auth, sales/purchases/returns, document numbering, old-gold,
cash/PAN compliance, customers).

---

## Summary

A working, secured **retail + purchase backend** runs end-to-end on PostgreSQL:

- Shared **`core-engine`** (Rust, fixed-point) — valuation, rounding, target-total, old-gold,
  with **8 golden tests passing** (+ 6 backend unit tests and 1 HTTP+DB integration test).
- **Axum backend** over PostgreSQL (sqlx), **auto-migrating** on startup.
- **Auth + RBAC** (session tokens, Argon2, action-level permissions) enforced on all endpoints.
- Full lifecycle: rates → stock → live price → **sell (double-sale guard)** → **returns
  (credit notes)** → **purchases (supplier stock-in)**, with configurable **document
  numbering** and an **append-only ledger** recording every movement.

Not yet built: web/mobile (deferred), RBAC middleware (403-before-parse), manufacturing.
Desktop counter UI is built (Phase-1 slice: login + live price + sell).

---

## Components

| Component | State |
|---|---|
| `crates/core-engine` | **Done + tested** (8 golden tests A–G incl. old-gold-with-sale, + target-floor guard). |
| `crates/backend` | **Working** — Axum + sqlx, auth/RBAC, sales/purchases/returns. |
| `db/migrations` 0001–0014 | **Applied automatically on startup** via `sqlx::migrate!`. |
| `apps/desktop` (Tauri 2 + React/TS) | **Counter UI built** — login + in-stock list + live price preview + sell; builds (frontend + webview shell). Run with `pnpm tauri dev`. |
| Web B2B / e-commerce / mobile | Deferred (see vision-and-scope.md). |

## Database migrations

| # | File | Adds |
|---|---|---|
| 0001 | init | branch, metal_type, purity, metal_rate (per-purity), item (ownership_state), ledger_event (append-only) |
| 0002 | invoices | invoice, invoice_line |
| 0003 | document_series | configurable numbering (prefix/suffix/pad/next_no); invoice.document_no |
| 0004 | credit_notes | credit_note, credit_note_line |
| 0005 | purchases | supplier, purchase_bill, purchase_bill_line |
| 0006 | old_gold | invoice.old_gold_value + amount_payable (no-GST value/cash) |
| 0007 | reference_seed | default branch, metal types, standard purities |
| 0008 | auth | app_user, session |
| 0009 | payment | invoice.payment_mode + cash_amount (Sec 269ST / PAN checks) |
| 0010 | approvals | approval_out (On-Approval / take-home trial tracking) |
| 0011 | sale_or_return | sale_or_return_out (B2B goods-out tracking) |
| 0012 | schemes | scheme + scheme_installment (gold savings "11+1", 11-cap) |
| 0013 | scheme_gram | gram-accumulation (rate-averaging) scheme fields |
| 0014 | scheme_redeem | invoice.scheme_credit + redeemed_scheme_id (redeem on sale) |

## API endpoints

Auth: `Authorization: Bearer <token>` from `/auth/login`. All endpoints require a valid
session except `/health` and `/auth/login`. Mutations also require the listed permission.

| Method | Path | Permission |
|---|---|---|
| GET | /health | (public) |
| POST | /auth/login | (public) |
| POST | /auth/logout | (session) |
| GET | /auth/me | (session) |
| POST | /auth/change-password | (session) |
| POST | /users | `user.manage` |
| GET / POST | /customers | read: session · write: `customer.manage` |
| GET / POST | /rates | read: session · write: `rate.edit` |
| GET / POST | /items | read: session · write: `stock.manage` |
| POST | /items/:id/sell | `sale.create` (+ cash/PAN, old-gold, scheme redemption) |
| POST | /items/:id/approval-out | `approval.manage` (take-home trial; no GST) |
| GET | /approvals | (session) — open take-home trials |
| POST | /approvals/:id/return | `approval.manage` |
| POST | /items/:id/sor-out | `sor.manage` (Sale-or-Return, B2B) |
| GET | /sale-or-returns | (session) — open consignments |
| POST | /sale-or-returns/:id/return | `sor.manage` |
| GET / POST | /schemes | `scheme.manage` (value 11+1 or gram) |
| POST | /schemes/:id/pay | `scheme.manage` (≤11, 11-month cap) |
| POST | /schemes/:id/close | `scheme.manage` (matured only) |
| POST | /invoices/:id/return | `sale.return` |
| GET / POST | /suppliers | read: session · write: `purchase.create` |
| GET / POST | /purchases | read: session · write: `purchase.create` |
| GET / POST | /document-series | read: session · write: `settings.manage` |
| POST | /price-preview | `price.preview` |
| GET | /reports/sales-summary | `report.view` (optional `from`/`to`) |
| GET | /reports/stock-summary | `report.view` |
| GET | /reports/gst-summary | `report.view` (optional `from`/`to`) |
| GET | /reports/ledger | `report.view` (optional `limit`) |

## Roles → permissions (current)

| Role | Permissions |
|---|---|
| owner | all |
| manager | all except `user.manage` |
| cashier | `sale.create`, `sale.return`, `price.preview`, `stock.read`, `customer.manage`, `approval.manage`, `scheme.manage` + read endpoints |

First run bootstraps an `owner` user (password: `BOOTSTRAP_OWNER_PASSWORD`, default
`admin123` — change immediately).

## Verified behaviours

- Valuation examples A–F reproduce exactly (golden tests).
- Sell is **double-sale-guarded** (`SELECT … FOR UPDATE`); second sale → 409.
- Returns issue a **credit note**, restore stock, reverse the ledger; original invoice
  immutable; re-return → 409.
- Purchases receive stock, bump supplier balance, log `received` events.
- **Old gold = value/cash, no GST**; GST only on the full new item; `amount_payable`
  reduced accordingly.
- Document numbers configurable (`INV-2627-0001`); 16-char GST limit enforced.
- **Cash/PAN compliance** at billing: bill ≥ ₹2L requires customer PAN; cash ≥ ₹2L blocked
  (Sec 269ST); bill ≥ ₹5L must be fully non-cash. Enforced before a number is consumed.
- **Reports** (owner/manager, `report.view`): sales summary, stock-on-hand valuation, GST
  summary (CGST/SGST/IGST from line snapshots), and a ledger/audit query.
- **On-Approval (take-home trial)**: item out → `on_approval_out` (no sale, no GST); return →
  back in stock; selling an on-approval item converts it (approval marked `converted`).
- **Sale-or-Return (B2B)**: item out → `sale_or_return_out` (title retained, not a sale);
  return → back in stock; selling it marks the consignment `invoiced`.
- **Gold savings schemes** (`scheme.manage`): two types — **value** (11+1: ₹55k paid →
  ₹60k redeemable) and **gram** (each installment converts to grams at that day's rate;
  e.g. ₹10k @ ₹14,100 → 0.709 g; at maturity average_rate = total_paid ÷ total_grams).
  Both enforce the **11-installment / 11-month cap**, auto-mature, and close only when matured.
- **Scheme redemption on a sale**: `sell` accepts `redeem_scheme_id` — a matured scheme is
  closed atomically and applied as a tender (value → maturity value; gram → grams × today's
  rate), reducing `amount_payable`. Verified: ₹40,000 scheme credit on a ₹1,14,042 bill →
  ₹74,042 payable; re-redeeming a closed scheme → 409.
- FY derived from current IST date; branch from item/invoice/context.
- Auth: 401 without/expired token, 403 on missing permission, logout + password-change
  revoke sessions.
- **Login rate-limiting**: 5 failed attempts per username within 5 min → **429** (lockout);
  cleared on success. (In-memory, per backend instance.)

## Tests

| Suite | Count | Needs DB? |
|---|---|---|
| `core-engine` golden tests (examples A–G + target-floor guard) | 8 | no |
| `backend` unit tests (RBAC, FY, prefixes, PAN, password hash, tokens) | 6 | no |
| `backend` HTTP + DB integration (full flow, auth lockout, purchase→sale, scheme redeem, on-approval) | 5 | **yes** |

The integration tests drive the **real router against a real PostgreSQL** via
`tower::oneshot`. Scenarios: full retail flow (login → set rate → item → sell → 409 double-
sale → return/credit note → 269ST 400), **auth lockout** (6th bad login → 429),
**purchase → sale**, **scheme value pay/redeem** (+ over-cap 409), and **on-approval out/
return**. They **skip** automatically if `TEST_DATABASE_URL` is unset, so
`cargo test --workspace` passes without a database.

```bash
# unit + engine tests (no DB):
cargo test --workspace

# include the integration tests (dedicated throwaway DB):
createdb -h /tmp -p 5433 -U postgres cygnus_test
TEST_DATABASE_URL=postgresql://postgres@localhost:5433/cygnus_test?sslmode=disable \
  cargo test -p backend
```

CI runs unit/engine tests on Windows/Linux/macOS, plus a Linux **integration** job with a
PostgreSQL service (`.github/workflows/ci.yml`).

## Run it locally

```bash
# local Postgres (no root) — see development-setup.md
$HOME/cygnus-pg/bin/pg_ctl -D $HOME/cygnus-pg-data -l $HOME/cygnus-pg.log -o "-p 5433 -k /tmp" -w start
createdb -h /tmp -p 5433 -U postgres cygnus    # first time

cargo test -p core-engine                      # 8 golden tests (A–G)
DATABASE_URL=postgresql://postgres@localhost:5433/cygnus?sslmode=disable cargo run -p backend
# backend auto-applies migrations + bootstraps the owner, then listens on 127.0.0.1:8787
```

## Known gaps / deviations from the design

- **Auth is self-contained session tokens, not OIDC/Keycloak** (design target). Interface is
  swappable later.
- **Permission check runs inside handlers** (after JSON parse), so a malformed body returns
  422 before 403. To enforce 403-before-parse, move checks to middleware.
- **Series default `T1`** is a constant; per-terminal series wiring is not yet exposed.
- **Integration tests cover the main flows** (retail, auth lockout, purchase→sale, scheme
  redeem, on-approval); concurrency stress and Sale-or-Return paths could be added.
- **Login is not rate-limited** yet (brute-force protection) — add before public exposure.
- **Gold savings schemes and Sale-or-Return (B2B)** are implemented, including **scheme
  redemption applied as a tender on a sale**.
- **GST summary currently sums final invoices only** (does not yet net credit notes); refine
  for true GSTR output.
- `/items` create does not capture `cost_value` (purchases do) — minor.
- **No desktop/web/mobile UI yet.**
- Dev DB is PostgreSQL 18.4 via micromamba; the recommended target is 17+ (both fine).
