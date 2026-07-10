# Module Specification

Modules for the **retail + wholesale + staff/payroll** scope. Each item has:

- **In-app** — the helper text/tooltip shown to users in the software.
- **Builder** — the engineering note on how it works / why it exists.

Manufacturing and web/mobile surfaces are deferred (see
[vision-and-scope.md](vision-and-scope.md)).

---

## How the modules are organized (read this first)

The system is a **modular monolith**: one backend, one database, one deployable — *not*
microservices. Inside it, each module is a **bounded context** (its own screens, code, and
tables) but they all sit on a **shared core** (the Stock ledger, the Valuation engine, and
the append-only Event ledger). This is the key decision for **stability and consistency**:
a single sale can atomically reduce stock *and* post to the ledger in one database
transaction, which is hard to guarantee across separate services.

Modules fall into **three tiers**:

| Tier | Code | What it is | In the UI |
|---|---|---|---|
| **Foundation** | F1–F5 | Platform services used by everything (users, settings, rates, audit, admin). | Settings / Admin area |
| **Operations** | O1–O9 | The day-to-day feature areas staff work in. | Main menu |
| **Engines** | E1–E3 | Internal services called by modules; no menu of their own. | (invisible) |

```
FOUNDATION   F1 Users & Roles · F2 Settings & Master Data · F3 Audit & Event Ledger
             F4 Metal Rates · F5 Admin & Platform Ops
OPERATIONS   O1 Sales · O2 Purchase · O3 Stock · O4 Customers · O5 Suppliers
             O6 Accounting · O7 Staff & Payroll · O8 Repairs & Custom Orders · O9 Reports
ENGINES      E1 Valuation · E2 Tax & Compliance · E3 Hardware
```

Sales, Purchase, and Stock are **separate modules but not separate silos** — they are three
views over the same Stock ledger: a purchase *increases* stock, a sale *decreases* it, and
"Stock" is the running balance (a projection of those movement events).

A full old→new mapping is at the end of this document.

Two non-negotiables hold across every tier: **fixed-point decimal math** for weight/money,
and the **append-only event ledger** for every gram and stone.

---

# Tier 1 — Foundation

## F1 — Users & Roles
**In-app:** "Create staff logins and control who can do what."
**Builder:** RBAC down to the action; used by every other module.

| Sub-item | In-app | Builder |
|---|---|---|
| Users | "Add staff logins (no shared accounts)." | Per-user accounts; attributable in the ledger. |
| Roles & Permissions | "Control who can do what, down to each action." | Action-level RBAC (e.g., `rate.edit`, `discount.approve`, `payroll.run`). |
| Permissions & Approvals | "Require manager approval for sensitive actions." | Approval workflows tied to RBAC; logged. |

## F2 — Settings & Master Data
**In-app:** "Set up your business and the values used everywhere."
**Builder:** Define once, reference everywhere; feeds the engines.

| Sub-item | In-app | Builder |
|---|---|---|
| Business & Branch Setup | "Add your company, showrooms, and warehouses." | Multi-company / multi-branch; enables inter-branch transfers. |
| Master Data | "Define metals, purities, units, and tax codes." | Metals, karat/fineness, units (g/tola/carat/piece), HSN codes, locations. |
| Rounding & Valuation Rules | "Set how weights, purity, and money are rounded." | Configurable per metal; consumed by the Valuation engine (E1). |
| Document Numbering | "Set the prefix, suffix, and digits for invoice, purchase, credit-note, debit-note numbers — per financial year." | `DocumentSeries` per (doc_type, FY, series): e.g. `INV-2627-0001`. Gapless, ≤16 chars (GST Rule 46). Set at FY start. |

## F3 — Audit & Event Ledger
**In-app:** "See every change — who did what, when, value before and after."
**Builder:** Append-only log of all weight/stone/cash/ownership movements. The backbone of
stability, auditability, and loss prevention; every module writes to it.

| Sub-item | In-app | Builder |
|---|---|---|
| Activity Log | "Search a full history of actions." | Immutable events `(user, time, type, before, after)`. |
| Movement Ledger | "Trace every gram/stone/rupee movement." | Current balances are projections of this stream. |

## F4 — Metal Rates
**In-app:** "Manage daily gold, silver, and platinum rates by purity."
**Builder:** Time-series, effective-dated, so every document is reproducible.

| Sub-item | In-app | Builder |
|---|---|---|
| Daily Rate Entry | "Enter or update today's rate for each metal and purity." | Manual + optional live feed API. |
| Rate History | "View past rates for any date." | Effective-dated records. |
| Branch Rate Override | "Set different rates per branch if needed." | Branch-level overrides. |
| Rate Lock | "Lock the rate onto a quotation or bill." | Document references the rate ID valid at its timestamp. |
| Rate-Change Alerts | "Get notified when the rate moves during the day." | Intraday trigger to prevent stale-rate underselling. |

## F5 — Admin & Platform Ops
**In-app:** "Backups, sync, integrations, and account settings."
**Builder:** Operational layer keeping the system safe and connected.

| Sub-item | In-app | Builder |
|---|---|---|
| Backup & Restore | "Protect your data with automatic backups." | Scheduled + tested restores. |
| Sync & Offline | "Resolve conflicts when branches reconnect." | Outbox + conflict-resolution UI. |
| Integrations | "Manage GST, payment, and messaging connections." | Credentials in a secure store. |
| Subscription & Licensing | "Manage your plan and seats." | Licensing. |
| Multi-language / Currency | "Use the app in your language and currency." | i18n. |

---

# Tier 2 — Operations

## O1 — Sales (Retail + Wholesale)
**In-app:** "Sell at the counter or in bulk to other jewellers."
**Builder:** One module, two surfaces (Retail counter + Wholesale B2B) over the same Stock,
Valuation (E1), and Tax (E2) core. Bills recompute live; on finalize, rate + breakdown are
frozen into immutable invoice lines. Works offline.

**Retail counter**

| Sub-item | In-app | Builder |
|---|---|---|
| Counter Sale | "Add items and see the full price breakdown instantly." | rate x net wt x purity + making + wastage + stone + tax via E1/E2. |
| Making & Wastage | "Apply making and wastage as per-gram, %, flat, or slab." | Rule engine scoped by item/customer/metal. |
| Old Gold Exchange | "Take in old gold, value it live, deduct from the bill." | Purity test -> live valuation -> bill offset -> creates scrap lot in Stock (O3). |
| On Approval (Out) | "Send a piece home with a customer to decide, with a return-by date." | B2C ownership state; not a sale; produces an Approval Slip, not an invoice. |
| Quotations | "Give a price quote that can convert to a bill." | Rate-locked. |
| Tenders & Payments | "Cash, card, UPI, EMI, advance, or split payments." | Multi-tender; advances. |
| Returns & Exchange | "Handle returns and item swaps cleanly." | Reverses ledger + tax correctly. |
| Discounts & Overrides | "Apply approved discounts with manager sign-off." | RBAC-gated; logged. |
| HUID Check | "Confirm the hallmark before selling gold." | Validates HUID via E2; blocks non-compliant sale where required. |
| Group Purchase / Split Billing | "Split a purchase across several real buyers — each with their own name, items, contribution amount, and bill." | Multiple named customers, each gets a separate bill for the items/amount **they** actually buy/pay. Per-bill PAN + cash-limit rules apply to each (see security.md). Not a threshold-evasion tool: amounts/items are entered, never auto-fabricated. |
| Offline Billing | "Keep billing when the network is down." | Local cache + outbox; double-sale check at commit. |

**Wholesale / B2B**

| Sub-item | In-app | Builder |
|---|---|---|
| B2B Sales Invoice | "Sell outright to a retailer with a GST tax invoice." | Ownership transfers now; revenue recognized; trade pricing + e-Way bill. |
| Sale or Return (Out) | "Send goods to a retailer to sell — title stays with you." | B2B ownership state; not sold/COGS until invoiced. Recall dates + aging + reminders + partial returns. |
| Consignment | "Place longer-term goods with a partner who sells and remits." | Sell-and-remit settlement. |
| Trade / Tiered Pricing | "Set special prices per customer, tier, or volume." | Price-rule engine. |
| B2B Order Entry | "Take bulk orders with live stock and promised ship dates." | Desktop order entry (self-service portal deferred). |
| Credit Terms & Limits | "Set credit limits and payment terms per buyer." | Feeds AR (O6); blocks over-limit orders. |

## O2 — Purchase
**In-app:** "Buy metal, stones, and finished goods, and receive them into stock."
**Builder:** Inbound side of Stock; increases the Stock ledger.

| Sub-item | In-app | Builder |
|---|---|---|
| Purchase Orders | "Raise and track orders to suppliers." | Metal, findings, loose stones, finished pieces. |
| Goods Receipt (GRN) | "Receive stock against an order." | Creates Stock items/lots + ledger events. |
| Sale or Return (Received In) | "Track goods a supplier gave you to sell without buying upfront." | Inbound ownership state; separated from owned stock. |
| Vendor Returns | "Return unsold or defective goods." | Reverses receipt + ledger. |

## O3 — Stock
*(formerly "Inventory" — we use "Stock" throughout.)*
**In-app:** "Track every piece and parcel by weight, purity, stones, and location."
**Builder:** The single source of truth. Serialized item cards for finished pieces; lot/
parcel model for loose stock. The ownership state here powers On-Approval (retail) and
Sale-or-Return (wholesale).

| Sub-item | In-app | Builder |
|---|---|---|
| Item Card | "All details of a piece: metal, weight, purity, stones, HUID, photos, price basis." | Gross/net weight, karat, stones, HUID, cert no., cost, location, ownership state. |
| Ownership Status | "Know if a piece is in stock, sold, on approval, or out on sale-or-return." | State machine: In Stock / On-Approval-Out / Sale-or-Return-Out / Received-In / Sold. |
| Loose Stones & Metal (Lots) | "Track parcels of loose stones and bulk metal." | Lot model with weighted-average cost. |
| Parcel Breaking | "Take stones out of a parcel and keep cost and carat accurate." | Recalculates avg cost + carat on each split. |
| Tagging (Barcode/QR/RFID) | "Tag and print labels for fast lookup and stock-takes." | Uses the Hardware engine (E3). |
| Stock-Take / Audit | "Count physical stock quickly and find discrepancies." | RFID-assisted reconciliation against the ledger. |
| Inter-Branch Transfer | "Move stock between showrooms with full tracking." | In-transit state; logged as ledger events. |
| Stock Aging | "See which items have been sitting too long." | Aging buckets feed Reports (O9). |

## O4 — Customers
**In-app:** "Manage customers, loyalty, reminders, and gold savings schemes."
**Builder:** KYC for high-value sales; scheme liability feeds Accounting (O6) and Reports.

| Sub-item | In-app | Builder |
|---|---|---|
| Customer Profile & KYC | "Store customer details, ID, and purchase history." | KYC capture for high-value transactions. |
| Gold Savings Schemes | "Run monthly savings plans customers redeem in jewellery." | Installment ledger, maturity, rate-averaged redemption. |
| On-Approval Tracking | "See which customers have pieces out on approval and when due." | Reads the Stock On-Approval state; reminders. |
| Loyalty & Points | "Reward repeat customers." | Points engine. |
| Reminders & Campaigns | "Send WhatsApp/SMS for dues, anniversaries, and offers." | Messaging integration. |

## O5 — Suppliers
**In-app:** "Manage supplier accounts, balances, and history."
**Builder:** Party + ledger for the buy side; used by Purchase (O2) and Accounting (O6).

| Sub-item | In-app | Builder |
|---|---|---|
| Supplier Profile | "Store supplier details and GSTIN." | Party record. |
| Supplier Ledger | "See balances and history for each supplier." | AP + metal-owed tracking. |

## O6 — Accounting & Finance
**In-app:** "Track cash, credit, and metal balances, taxes, and export to your accountant."
**Builder:** A **metal ledger separate from the cash ledger** — you owe/are-owed grams, not
just money. Surfaces GST output from the Tax engine (E2). Shared by retail and wholesale.

| Sub-item | In-app | Builder |
|---|---|---|
| Metal Ledger | "Track gold/silver owed and owing in grams." | Separate from cash; reconciles with Stock events. |
| Receivables / Payables | "See who owes you and whom you owe." | AR/AP with credit terms. |
| Cash & Bank | "Record cash, bank, and UPI movements." | Daybook + bank reconciliation. |
| Cost & Margin | "See true cost and profit per item." | COGS at actual; margin per piece/order. |
| GST & Tax Reports | "View tax collected and filing-ready data." | Reads E2; GSTR-ready exports. |
| Accounting Export | "Send data to Tally or QuickBooks." | Export connectors. |

## O7 — Staff & Payroll
**In-app:** "Manage staff, attendance, leave, and salary — with biometric machines on your
network."
**Builder:** Biometric punches arrive from the Hardware engine (E3) and are stored as
immutable events; attendance/leave/payroll are projections. Payroll posts to Accounting
(O6). Sensitive — gated by RBAC (F1) and audited (F3).

| Sub-item | In-app | Builder |
|---|---|---|
| Staff Directory & Profiles | "Add staff with role, department, branch, joining date, documents, bank details." | Staff entity; per-branch scoping; status. |
| Biometric Enrollment Mapping | "Link each staff member to their ID on the attendance machine." | Maps device user-id -> staff; templates stay on the device. |
| Attendance Capture | "Automatically pull punches from eSSL/CP Plus/ZKTeco machines." | Punch events via E3 (push-first/pull-fallback); deduped; append-only. |
| Shift & Roster Management | "Define shifts, weekly-offs, holidays, and assign them." | Shift definitions + roster assignments. |
| Attendance Processing | "Turn punches into present/absent/half-day/late/overtime." | Maps punches to shift; regularization with approval. |
| Leave Management | "Set leave types, balances, and apply/approve leave." | Accrual, balances, request workflow, calendar. |
| Salary Structure | "Define each staff member's salary components." | Earnings/deductions; attendance-linked vs fixed. |
| Payroll Run | "Generate monthly salary from attendance and structure." | Period run -> payslips; overtime, LOP, arrears; lock + audit. |
| Staff Advances & Loans | "Give advances/loans and auto-deduct from salary." | Advance ledger; scheduled recovery. |
| Statutory & Compliance | "Handle PF, ESI, Professional Tax, and TDS." | India statutory configs + reports (optional per shop). |
| Payslips & Registers | "Issue payslips and view the salary register / muster." | Payslip docs; pay register; attendance muster. |
| Payroll -> Accounting | "Post salary expense and payables to the books." | Generates ledger entries in O6. |

> Staff self-service (payslips/leave on a phone) is **deferred** with the other web/mobile
> surfaces. The system stores **punch logs + a device-user-id -> staff mapping only — never
> raw biometric templates**. See [../02-architecture/security.md](../02-architecture/security.md).

## O8 — Repairs & Custom Orders
**In-app:** "Take in repairs and custom orders and track them to delivery."
**Builder:** Order lifecycle now; links to manufacturing later without rework.

| Sub-item | In-app | Builder |
|---|---|---|
| Repair Intake | "Log a repair with estimate and promised date." | Status workflow -> delivery. |
| Custom Order | "Capture a bespoke order and its specifications." | Spec + BOM stub (manufacturing hook). |
| Status Tracking | "Update customers on progress." | Notifications via O4. |
| Certification Tracking | "Store GIA/IGI/BIS certificate details per piece." | Cert numbers on the item card. |

## O9 — Reports & Analytics
**In-app:** "Dashboards for sales, stock, dues, payroll, and profit."
**Builder:** Reads the event ledger; role-based dashboards.

| Sub-item | In-app | Builder |
|---|---|---|
| Sales Dashboard | "Track sales by branch, staff, and period." | Live KPIs. |
| Stock & Aging | "Spot dead stock and fast movers." | Aging buckets. |
| Approval & Sale-or-Return Aging | "See goods out and overdue for return." | Reads ownership states. |
| Scheme Liability | "Know your outstanding savings-scheme obligations." | From scheme ledger. |
| Margin & Profit | "Understand profit per item and category." | Actual-cost based. |
| Payroll & Attendance | "Review attendance and salary summaries." | From O7. |
| GST Dashboard | "Track tax collected and filing readiness." | From E2. |

---

# Tier 3 — Engines (internal — no menu)

## E1 — Valuation Engine
**Builder:** The single source of truth for pricing. Conversions (karat/fineness, units),
making/wastage rule evaluation, rounding, and the `PriceBreakdown`. Implemented once in
Rust and reused by desktop and backend. Detailed in
[../02-architecture/valuation-engine-spec.md](../02-architecture/valuation-engine-spec.md).
*(No UI; invoked by O1, O2, O3.)*

## E2 — Tax & Compliance Engine
**Builder:** GST split (CGST/SGST/IGST), e-invoice (IRN), e-Way bill via **direct NIC APIs**, HUID
validation. (Old gold carries **no GST** — it is a value/cash adjustment handled in O1, not
taxed here.) Invoked by O1; output surfaced in O6/O9.

| Capability | Builder |
|---|---|
| GST Calculation | Interstate vs intrastate split; per-component HSN. |
| e-Invoice (IRN) | **Direct** NIC IRP API (no GSP). |
| e-Way Bill | Direct NIC e-Way bill API; for goods movement (wholesale-heavy). |
| HUID Validation | 6-digit format check; blocks non-compliant gold sale. |
| Old gold (NO GST) | Old gold is a **value/cash adjustment** to the amount payable — **no GST and no RCM** on it. GST applies only to the **full new item value**. Handled in O1 settlement, not taxed here. |

## E3 — Hardware Layer
**Builder:** Abstraction over physical devices on the LAN; called by O1/O3 (scales, tags)
and O7 (biometric).

| Device | Builder |
|---|---|
| Weighing Scale | Serial/Bluetooth (Ohaus/Mettler). |
| Barcode / QR / RFID | Reader integration. |
| Label & Invoice Printer | Thermal/jewellery-tag + invoice printers. |
| Biometric Attendance Devices | eSSL / CP Plus / ZKTeco on the LAN; vendor-abstraction adapter, **push-first** (ADMS HTTP) + **pull (TCP 4370) fallback**. Feeds O7. See [../02-architecture/deployment-and-sync.md](../02-architecture/deployment-and-sync.md). |

---

# Deferred (future release — not current development)

- **Web B2B portal** (Next.js) — retailer self-service ordering.
- **E-commerce storefront** (Next.js) — consumer online sales + marketplace sync.
- **Mobile sales-rep app** (React Native) — field order capture.
- **Staff self-service** (web/mobile) — payslips/leave on a phone.
- **Manufacturing** — BOM, casting, stage weight-loss, stone allocation, karigar/piece-rate.

Seams kept open: clean backend API, shared UI library, and the event ledger (which already
models stage movements).

---

# Old → new module mapping

For traceability from the earlier numbered list.

| Old module | New |
|---|---|
| M1 Core Platform & Settings | Split into **F1** Users & Roles, **F2** Settings & Master Data, **F3** Audit & Event Ledger |
| M2 Metal Rate Management | **F4** Metal Rates |
| M3 Inventory Management | **O3** Stock |
| M4 Retail POS & Billing | **O1** Sales (Retail surface) |
| M5 Tax & Compliance | **E2** Tax & Compliance Engine |
| M6 Customers, CRM & Schemes | **O4** Customers |
| M7 Procurement & Suppliers | **O2** Purchase + **O5** Suppliers |
| M8 Wholesale / B2B | **O1** Sales (Wholesale surface) |
| M9 Accounting & Finance | **O6** Accounting & Finance |
| M10 Repairs & Custom Orders | **O8** Repairs & Custom Orders |
| M11 E-commerce & Omnichannel | Deferred |
| M12 Reporting & Analytics | **O9** Reports & Analytics |
| M13 Hardware Integration | **E3** Hardware Layer |
| M14 Platform Administration | **F5** Admin & Platform Ops |
| M15 Staff, Attendance, Leave & Payroll | **O7** Staff & Payroll |

---

# Build order (summary)

Detailed in [../03-delivery/roadmap-and-phases.md](../03-delivery/roadmap-and-phases.md).

1. **Phase 1 — Foundation & core:** F1–F4, E1 Valuation, O3 Stock, E3 (scale/barcode subset).
2. **Phase 2 — Retail sales:** O1 (retail), E2 Tax, O4 Customers.
3. **Phase 3 — Wholesale & back-office:** O1 (wholesale), O2 Purchase, O5 Suppliers,
   O6 Accounting, O7 Staff & Payroll (biometric via E3).
4. **Phase 4 — Ops & insight:** O8 Repairs, O9 Reports, F5 Admin.
5. **Later:** deferred web/mobile + manufacturing.
