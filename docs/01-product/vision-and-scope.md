# Vision & Scope

## Vision

Build the jewellery management platform that the industry has been missing: one that is
**correct by design** about weight, purity, and money, **stable** under real multi-counter
use, and **honest** about every gram and stone that moves — across retail and wholesale,
on Windows, Linux, and macOS.

Existing software fails because it bolts a "jewellery template" onto a generic retail or
ERP core. We do the opposite: the precious-metal valuation engine and an append-only
movement ledger are the *core*, and everything else is built around them.

**Primary market: India.** The defaults are built for Indian practice — per-gram-per-karat
manual rates, fine-gold and silver by purity, multi-unit stone pricing (carat/gram/piece/
ratti), GST + e-invoice, HUID/BIS hallmarking, and PF/ESI/PT/TDS payroll. Other geographies
are a later concern; the model leaves room for them.

## Who it serves

- **Retail jewellers** — showroom counter sales, old-gold exchange, savings schemes,
  HUID/GST compliance, customer relationships.
- **Wholesale jewellers / distributors** — selling to other retailers via direct B2B
  invoices and Sale-or-Return, with trade pricing, credit, and desktop B2B order entry.
- **Multi-branch businesses** — several showrooms that need synchronized stock, rates,
  and reporting.

## What makes it different

1. **Fixed-point decimal math everywhere.** No floating point for weight or money. This
   alone removes the rounding bugs that plague incumbents.
2. **Append-only event ledger.** Every weight/stone/cash movement is an immutable event.
   This gives stability (no silent overwrites), auditability, and loss prevention.
3. **Live valuation, never stored prices.** Every bill is computed at transaction time
   from the live rate and frozen onto the invoice.
4. **One core, two sales surfaces.** Retail and wholesale share stock, valuation, and
   ledger; they differ only in the sales front-end.
5. **Cross-platform + offline-tolerant.** One desktop codebase for all OSes, with a local
   cache and a LAN-first server so the shop keeps working during internet outages.

## In scope (current release)

Organized by the three tiers (full detail in
[module-specification.md](module-specification.md)).

**Foundation:** users & roles, settings & master data, audit/event ledger, metal rates,
admin & platform ops (backup, sync, integrations).

**Operations:**
- **Sales** (retail + wholesale): counter billing, making/wastage, old-gold exchange,
  On-Approval (take-home trial), B2B sales invoice, Sale or Return, trade pricing,
  B2B order entry (desktop).
- **Purchase** and **Suppliers**: POs, GRN, Sale-or-Return received-in, supplier ledger.
- **Stock**: serialized pieces + loose-stone/metal lots, ownership states, tagging,
  stock-take, transfers.
- **Customers**: profiles/KYC, gold savings schemes, loyalty, reminders.
- **Accounting & finance** (incl. a metal ledger), with GST/tax reporting.
- **Staff & Payroll** — attendance, leave, salary, with direct **LAN biometric
  integration** (eSSL, CP Plus, ZKTeco).
- **Repairs & custom orders** (intake/tracking).
- **Reports & analytics**.

**Engines (internal):** Valuation; Tax & Compliance (GST, e-invoice, e-Way bill, HUID);
Hardware (scale, barcode/QR/RFID, printers, biometric attendance devices).

## Deferred (future release)

- **Web surfaces & mobile** (no current build dependency):
  - **Web B2B portal** (Next.js) — retailer self-service ordering. B2B works fully from
    the desktop app meanwhile.
  - **E-commerce storefront** (Next.js) — consumer online sales; in-store retail is
    complete without it.
  - **Mobile sales-rep app** (React Native) — field order capture; a laptop running the
    desktop app covers this for now.
  - **Staff self-service** (web/mobile) — staff viewing payslips / applying leave from a
    phone. For now, leave and regularization are handled by a manager in the desktop app.

  Deferring these removes all public internet-facing surfaces from the current build,
  simplifying the architecture and shrinking the security surface. Seams kept open: a clean
  backend HTTP/WebSocket API and a shared React component library, so each can be added
  later without re-architecture.

- **Manufacturing**: style master & BOM, job cards, casting tracking, stage-by-stage
  weight-loss reconciliation, stone allocation to setters, karigar/piece-rate payroll,
  finished-goods costing at actual.

The data model reserves seams for these (event ledger already models stage weight
movements; scrap lots from old-gold exchange become raw-material inputs; the item card
has the fields a BOM will populate; supplier ledger can carry piece-rate accruals).

## Non-goals

- We do not replace a full general-ledger accounting suite; we integrate/export to
  Tally and QuickBooks.
- We do not provide financial, legal, or valuation *advice* — only the tools and records.

## Success criteria

- Zero rounding discrepancies in weight/money across thousands of transactions.
- No data corruption under concurrent multi-counter use.
- A complete audit trail for every gram and stone.
- A retail shop and a wholesale business can each run end-to-end on the platform.
