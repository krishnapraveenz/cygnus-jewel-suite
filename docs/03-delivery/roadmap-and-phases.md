# Roadmap & Phases

Phased, module-by-module build plan. Each phase is **independently shippable** — it leaves
the product usable, not half-broken. Scope is retail + wholesale; manufacturing is a later
release with seams already reserved (see ../01-product/vision-and-scope.md).

Modules referenced here are defined in
[../01-product/module-specification.md](../01-product/module-specification.md).

---

## Phase 0 — Project setup (1 sprint)
Foundations before features.

- Monorepo scaffold (see tech-stack.md repo shape).
- CI/CD: build/test/sign installers for Windows/Linux/macOS.
- Database migration tooling; base Postgres schema.
- Auth (OIDC/Keycloak) skeleton, RBAC framework.
- `core-engine` crate skeleton with the decimal types and test harness.

**Exit:** a "hello" desktop app talks to the backend; CI is green on all 3 OSes.

---

## Phase 1 — Foundation & core (the correctness core)
*F1–F4, E1 Valuation, O3 Stock, E3 (scale/barcode subset).*

This is where incumbents are buggiest, so we make it provably correct first.

- **F1 Users & Roles / F2 Settings & Master Data / F3 Audit & Event Ledger:** branches,
  users/roles/RBAC, master data, **audit/event ledger**.
- **F4 Metal Rates:** entry, history, effective-dating, rate lock.
- **O3 Stock:** item card, ownership states, loose-stone lots, parcel breaking,
  tagging, stock-take, transfers.
- **E1 Valuation engine:** conversions, making/wastage rules, rounding, golden-file tests.
- **E3 Hardware (subset):** weighing scale + barcode/QR + label printer.

**Exit / demo:** tag stock, see a live, correct price breakdown for any piece, run a
multi-PC LAN setup with no double-counting. This alone beats most incumbents.

---

## Phase 2 — Retail sales (a shop can go live)
*O1 (retail surface), E2 Tax, O4 Customers.*

- **O1 Sales (retail):** counter sale, making/wastage, **old-gold exchange**, **On-Approval
  (take-home trial)**, quotations, tenders, returns, HUID check, offline billing.
- **E2 Tax & Compliance:** GST split, e-invoice (IRN), e-Way bill, HUID validation.
- **O4 Customers:** customer/KYC, **gold savings schemes**, on-approval tracking,
  loyalty, reminders.

**Exit / demo:** a retail showroom runs end-to-end — sell, exchange old gold, take-home
trial, run a savings scheme, file-ready GST.

---

## Phase 3 — Wholesale & back-office
*O1 (wholesale surface), O2 Purchase, O5 Suppliers, O6 Accounting, O7 Staff & Payroll.*

- **O1 Sales (wholesale):** **B2B Sales Invoice** (outright), **Sale or Return** (out),
  consignment, trade/tiered pricing, B2B order entry (desktop), credit limits.
  *(B2B web portal + salesperson mobile app are deferred — see "Deferred" below.)*
- **O2 Purchase / O5 Suppliers:** purchase orders, GRN, **Sale or Return (received-in)**,
  supplier ledger, vendor returns.
- **O6 Accounting:** **metal ledger** (grams owed/owing), AR/AP, cash/bank, cost & margin,
  GST/tax reports, Tally/QuickBooks export.
- **O7 Staff & Payroll:** staff directory, **LAN biometric attendance**
  (eSSL/CP Plus/ZKTeco via E3 Hardware — push-first/pull-fallback), shifts/roster, leave,
  salary structure, **payroll run -> Accounting (O6)**, advances, statutory (PF/ESI/PT/TDS).
  *(Staff self-service portal/app is deferred with the other web/mobile surfaces.)*

**Exit / demo:** a wholesaler sells to retailers (invoice + sale-or-return), tracks credit
and metal balances, reconciles the buy side, and runs monthly payroll from biometric
attendance.

---

## Phase 4 — Operations & insight
*O8 Repairs, O9 Reports, F5 Admin.*

- **O8 Repairs & Custom Orders:** intake, status, certification tracking.
- **O9 Reports & Analytics:** sales, stock/aging, approval & SOR aging, scheme
  liability, margin, payroll/attendance, GST dashboards.
- **F5 Admin & Platform Ops:** backup/restore, sync & conflict-resolution UI, integrations
  management, subscription/licensing, i18n.

**Exit / demo:** repairs/custom orders tracked; owner dashboards; multi-branch cloud sync
with conflict handling.

---

## Deferred to a future release (not current development)

These are documented future work; **no current phase depends on them**. Deferring them
removes all public internet-facing surfaces from the build.

- **Web B2B portal** (Next.js) — retailer self-service ordering. Meanwhile B2B orders are
  entered in the desktop app.
- **E-commerce storefront** (Next.js) — consumer online sales + marketplace sync.
- **Mobile sales-rep app** (React Native) — field order capture; a laptop with the desktop
  app covers this for now.

Seams kept open: clean backend HTTP/WebSocket API + shared React component library, so each
can be added later without re-architecture.

---

## Cross-cutting tracks (run alongside all phases)

- **Testing:** golden-file + property tests for the engine; integration tests for the
  double-sale guard; E2E for POS flows.
- **Security:** RBAC, TLS, secrets management, audit completeness (see security.md).
- **Performance:** real-time WebSocket fan-out, projection rebuild speed.
- **Docs:** keep this set current as decisions change.

---

## Milestones / sequencing summary

| Phase | Modules | Outcome |
|---|---|---|
| 0 | — | Repo, CI, auth, engine skeleton |
| 1 | F1–F4, E1, O3, E3* | Accurate stock + valuation on LAN |
| 2 | O1 (retail), E2, O4 | Retail shop live |
| 3 | O1 (wholesale), O2, O5, O6, O7 | Wholesale + accounting + staff/payroll (biometric) |
| 4 | O8, O9, F5 | Repairs/custom, ops + insight, multi-branch |
| Later | Web B2B portal, E-commerce, Mobile rep app, Staff self-service | Online + field surfaces |
| Later | Manufacturing | BOM, casting, karigar, stage loss |

Two non-negotiables hold across every phase: **fixed-point decimal math** and the
**append-only event ledger**.
