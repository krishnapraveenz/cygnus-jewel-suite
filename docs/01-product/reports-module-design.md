# Reports Module — Redesign & Specification

> Status: **Design (approved for build)** · Owner: Reports · Last updated: 2026-07-04
>
> Supersedes the flat 13-tab `components/reports/Reports.tsx`. The Reports module stays a
> single **sidebar** entry (`report.view` permission) but is **redesigned** into a
> per-section reporting hub. Terminology: **"Karigar ledger" is renamed "Smith ledger"**
> to match the app's Workshop / Smiths naming.

---

## 1. Goals

1. **Every business section has its own reports**, grouped and discoverable, instead of one
   undifferentiated tab strip.
2. **One home** — Reports remains a single sidebar tab (placement decision), redesigned as a
   two-pane hub: section navigator on the left, report canvas on the right.
3. **Reuse, don't fork** — all reports draw from the existing `/reports/*` endpoints and the
   append-only `ledger_event` truth source. Figures stay **net of returns** (only
   `final`+`returned` tax invoices, minus `credit_note` / `purchase_return`).
4. **Consistent output** — every report supports date-range (where applicable), CSV export,
   and A4 print through shared view components.
5. **No new pricing paths** — reuse the valuation engine; reports are read-only projections.

## 2. Placement & layout (redesign)

- Sidebar: single **Reports** entry (Masters group), icon `BarChart3`, gated by `report.view`.
- Redesigned screen = **two-pane hub**:
  - **Left rail** — section list (Sales, Schemes, Parties, Advance, Inventory, Purchases,
    Old Gold, Workshop, Staff, Banking, Accounts & Compliance). Selecting a section shows its
    report catalogue.
  - **Right canvas** — chosen report: title + description, filter bar (`DateField` range /
    `MonthField` / party / supplier selects as needed), CSV + Print actions, and the result
    table/cards.
- **Report picker**: within a section, reports are chips/sub-tabs across the top of the canvas.
- Filters persist per report while navigating within the hub; `print-area` wraps the canvas so
  A4 print only emits the active report.
- Optional-module awareness: Loose Stones / Schemes reports hidden when their module is off
  (respect `lib/modules.ts`, same gating as the sidebar).

## 3. Section report catalogue

Legend: **[have]** endpoint exists · **[new]** to be built.

### Sales
- Sales register (net of returns) — **[have]** `/reports/sales-register`
- Sales by purity — **[have]** `/reports/sales-by-purity`
- Gross profit (cost-tracked, transparent coverage %) — **[have]** `/reports/gross-profit`
- Payment-mode collections — **[have]** `/reports/payment-modes` (not yet surfaced)
- Sales returns / credit-note register — **[new]**
- Estimates & quotations register (open / converted / expired) — **[new]**
- On-approval (goods out) outstanding — **[new]**

### Schemes (Gold Schemes)
- Scheme dues (overdue installments) — **[have]** `/reports/scheme-dues`
- Active-scheme / enrollment register — **[new]**
- Installment collections register (date, mode, reference) — **[new]**
- Maturity & closure / redemption report — **[new]**

### Parties (Customers)
- Party outstanding (cash) — **[have]** `/reports/outstanding`
- Party ledger / statement (per party, range) — **[have]** `/reports/ledger`
- Metal-account balances (party fine grams, debtor-positive) — **[new]**
- Top customers by sales value — **[new]**

### Advance
- Advance dues (matured / overdue) — **[have]** `/reports/advance-dues`
- Advance register (booked / matured / closed / refunded + balances) — **[new]**
- Metal (gram) booking outstanding — **[new]**

### Inventory / Stock
- Stock valuation — **[have]** `/reports/stock-valuation`
- Stock revaluation (book cost vs current metal rate) — **[have]** `/reports/stock-revaluation`
- Stock ageing / dead & slow-moving — **[have]** `/reports/stock-ageing`
- Stock summary by metal & category — **[have]** `/reports/stock-overview`
- Barcode-wise stock register (SKU level) — **[new]**
- Untagged / open-lot balance — **[new]**
- Loose-stone inventory valuation — **[new]** (module-gated)
- Resale (used) stock & margin — **[new]**

### Purchases
- Purchase register (net of returns) — **[have]** `/reports/purchase-register`
- Purchase returns / debit-note register — **[new]**
- Supplier-wise purchase summary — **[new]**
- ITC (input tax credit) summary — **[new]** (or folded into GST)

### Old Gold
- Old-gold intake register (gross, fine, deduction, paid) — **[new]**
- Old-gold metal account — **[have]** `/reports/metal-account`
- Rate-cutting register (grams ↔ money conversions) — **[new]**

### Workshop / Smiths
- **Smith ledger** (metal issued−returned + making payable−paid, reconciled) —
  **[have]** `/reports/karigar` *(display label: "Smith ledger"; endpoint name unchanged)*
- Job-work register (issued / received / pending) — **[new]**
- Making-charges payable summary — **[new]**

### Staff / Payroll
- Attendance register & monthly summary — **[have]** (in Attendance; expose here)
- Leave register & balances — **[new]**
- Payroll register (per run) — **[have]** (standardize the Payroll CSV export)
- Salary advances / loans outstanding — **[new]**
- Statutory register — PF / ESI / PT / TDS — **[new]**

### Banking
- Cheque register — **[have]** (in Cheque screen)
- Cheque status report (pending / cleared / bounced, in / out) — **[new]**

### Accounts & Compliance (cross-cutting)
- GST net summary — **[have]** `/reports/gst-net`
- Day book — **[have]** `/reports/day-book`
- General ledger — **[have]** `/reports/ledger`
- **GSTR-1 / GSTR-3B statutory filing exports (GSTN JSON/CSV)** — **[new, known gap]**.
  Figures are correct today; only the return-file format is unbuilt. Deliberately deferred to
  a dedicated, validated compliance pass.

> **Redesigned (done).** This section is now a grouped compliance hub with a landing
> dashboard. The hub report-picker supports **sub-group headers** (via an optional `group`
> field on each report). Groups:
> - **Overview** — *Compliance overview* (`/reports/compliance-overview?period=YYYY-MM`):
>   month KPIs (output CGST/SGST/IGST, ITC, **net GST payable**, taxable turnover, B2B/B2C
>   split, invoice & credit-note counts) + a **filing-readiness checklist** (seller GSTIN
>   set, lines missing HSN, net payable). The landing view for the section.
> - **GST Returns** — GST summary, GSTR-1, GSTR-3B, **HSN summary** (`/reports/hsn-summary`).
> - **Registers** — **Output tax register** (`/reports/output-tax-register`, invoice-wise
>   CGST/SGST/IGST) and **ITC register** (`/reports/itc-register`, purchase-wise, intra/inter).
> - **Books** — **Cash & bank book** (`/reports/cash-bank-book`, receipts vs payments by
>   tender mode + net), **Daily collections** (`/reports/daily-collections`, day-wise Cash/UPI/
>   Card/Bank/Cheque), **Cash book** (`/reports/cash-book`, opening + receipts − payments =
>   closing, running balance, cash vs bank), Day book (null-safe), General ledger / audit trail.
>
> **Note:** full **double-entry accounting** (Chart of Accounts, Trial Balance, P&L, Balance
> Sheet, Journal) is now a separate **Accounts** module (migrations 0055/0056) — a non-invasive
> projection of documents into a balanced journal, rebuilt on demand.

## 4. Shared frontend components

Extract the current inline views out of `Reports.tsx` into `components/reports/views.tsx`:

- `RegisterView` — generic columns + right-aligned money columns + totals footer.
- `GstView`, `ProfitView`, `AgeingView`, `DayBookView` — typed cards/tables.
- `ReportShell` — filter bar (range/month/select) + CSV + Print + `print-area` wrapper.
- `csvFromRows()` — shared CSV builder (currently duplicated in `exportCsv`).

Each section renders `ReportShell` + the appropriate view; new reports add a `RegisterReport`
projection where possible so they reuse `RegisterView` for free.

## 5. Backend

- New reports are read-only SQL projections over existing tables (`document`,
  `document_line`, `ledger_event`, `stock_item`, `stock_lot`, `scheme*`, `advance*`,
  `staff*`, `staff_advance`, `cheque`). No schema migration expected for the register-style
  reports; add one only if a report needs a derived/materialized helper.
- All under `/reports/*`, guarded by `report.view`. Reuse the raw-SQL + `Option<Decimal>`
  decode conventions already in `main.rs`. GST/sales/purchase stay net of returns.
- **`/reports/karigar` endpoint name is retained** (churn-free); only the UI label changes to
  "Smith ledger".

## 6. Build phases

- **Phase 0 — redesign shell + rename [DONE]**: two-pane hub, section rail, extracted shared
  views (`components/reports/views.tsx`), wired all **[have]** endpoints incl. the 4
  previously-unsurfaced ones (`payment-modes`, `metal-account`, `stock-overview`, `ledger`),
  renamed **Karigar → Smith ledger**. No new backend.
- **Phase 1 — high-value new reports [DONE]**: Sales returns, Advance register, Barcode-wise
  stock, Old-gold intake, Rate-cutting register, Job-work register, Leave register + Salary
  advances, Cheque status. 9 new `/reports/*` handlers (RegisterReport-shaped), client funcs,
  and two new hub sections (**Staff**, **Banking**). Verified via curl + `pnpm build`.
- **Phase 2 — remaining new reports [DONE]**: Estimates/quotations, On-approval outstanding,
  scheme enrollment/collections/maturity, party metal balances, top customers, supplier-wise
  purchases, purchase returns, loose-stone & resale valuation, statutory register (PF/ESI/PT/
  TDS). 12 new `/reports/*` handlers (RegisterReport-shaped), client funcs, wired across the
  Sales/Schemes/Parties/Purchases/Inventory/Staff sections. Verified via curl + `pnpm build`.
- **Phase 3 — compliance [DONE]**: GSTR-1 (`/reports/gstr1?period=YYYY-MM`) building
  b2b/b2cl/b2cs/cdnr/hsn (b2cs net of B2C credit notes, b2cl threshold ₹1L) and GSTR-3B
  (`/reports/gstr3b`) building 3.1(a) osup_det net of CN, 3.2 inter-state unregistered, and
  §4 ITC from B2B purchases net of returns. Both emit GSTN-format JSON downloadable from a
  month-filtered **compliance** view in Accounts & Compliance, labelled *validate against the
  GSTN offline tool before filing* (schema versions change). Figures come from the same
  net-of-returns source as the GST report.

## 7. Acceptance

- Reports opens to the section rail; each section lists only its own reports.
- Every report: correct figures (net of returns where relevant), CSV export, A4 print.
- "Smith ledger" appears everywhere the old "Karigar ledger" label did.
- `pnpm build` (tsc + vite) clean; `cargo build -p backend` clean; flows spot-checked via curl.
