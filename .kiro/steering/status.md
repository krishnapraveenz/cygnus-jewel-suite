# Implementation status

Migrations applied through **0071**. App is far along; work is incremental.

## Accounting foundations (opening balances, locking, FY) — done
- **Per-party opening balances** (no new migration — uses existing `party_terms.opening_cash_balance`
  / `opening_metal_balance`, debtor-positive): editable in **Parties** create/edit (amount + Dr/Cr for
  cash, ± fine grams for metal). Included in each party's cash+metal outstanding (`list_parties` /
  `get_party`) and summed in `accounts_rebuild` into **Sundry Debtors (1100)** / **Creditors (2000)**,
  replacing the old lump `accounts.opening_debtors/creditors` (now fallback only). Accounts → Opening
  balances tab now shows only cash/bank/date + a note. Verified: opening JE balances Dr=Cr, party
  outstanding reflects opening.
- **More opening ledgers** (migration 0071 adds COA **1500 Fixed Assets** + **2500 Loans**): Accounts →
  Opening balances now also takes **Fixed assets, Input GST credit** (assets) and **Loans, Customer
  advances, Scheme deposits, Output GST** (liabilities), stored as `accounts.opening_*` and posted in
  `accounts_rebuild` with Capital as the balancing figure. Verified TB balances with these set.
- **Opening Balances workbench** (single linked screen, Accounts → Opening balances tab rewritten): one
  page with a live **Assets / Liabilities / Capital(plug)** header, inline ledger fields (cash, fixed
  assets, input GST, loans, customer advances, scheme deposits, output GST), inline **bank** openings
  (mirrors Bank Accounts), a searchable **party opening grid** (signed ₹ + fine g), and a read-only
  **per-department stock** total — all saved by one **Save all & Rebuild**. Endpoints `GET/POST
  /opening/parties`, `GET /opening/stock-summary`. Everything is one source of truth (party→`party_terms`,
  bank→`bank_account`, ledgers→`app_setting`, stock→`item`), so the entity screens stay in sync.
- **Opening-stock intake** (`POST /opening/stock`): from the workbench's **Add opening stock** → a modal
  of itemised rows (metal/purity/department/weights/HUID/cost/SKU) creates **barcoded in-stock items**
  (auto SKU via `gen_item_barcode`, dept auto-resolved) with **no purchase side-effects** (no supplier
  payable, ITC or Purchases expense) — go-live stock carried by Capital via the closing-stock snapshot.
  Prints tags after creation. Verified: creates items + barcodes, per-dept summary updates, TB balances.
- **Data locking** (`books.lock_date` in `app_setting`): `POST /books/lock` (gated `books.lock` =
  owner/manager). `assert_not_locked(&db, date)` guard rejects (409) any entry dated on/before the lock —
  wired into invoice, purchase + return, expense, receipt, bank-entry, advance, rate-cut, scheme
  collection, old-jewellery convert, melt. UI: **Settings → Financial Year & Locking** (begin date +
  lock date + Save + Clear). Sales-return/credit-note and
  bank-entry edit/delete are now guarded too. **Staff/payroll** (generate_payroll,
  set_payroll_status/mark-paid, create_staff_advance) also guarded. **Fix:** `accounts_rebuild` now posts a negative payable **Fix:** `accounts_rebuild` now posts a negative payable
  (old gold / credits exceed the bill) as a **Cr to Customer Advances (2100)** — we owe the customer the
  excess — so the Trial Balance balances even when an exchange is larger than the new purchase.
- **FY selection** (`lib/fy.ts`, Indian Apr–Mar): Reports has an **FY quick-select** that sets the
  range from/to; Topbar shows a **current-FY chip**. Docs stay current-dated (no back-dating UI), so
  numbering remains server-derived `current_fy()`.
- **Year-end close**: Settings → Financial Year & Locking has **Close & lock year** (pick FY → sets the
  lock date to 31 Mar). Carry-forward is **automatic** — the ledger is a continuous projection
  (`accounts_rebuild` regenerates from all docs), so next year opens from this year's closing with no
  opening re-entry.


## Done (built + verified)
- **Sales**: multi-line invoice/estimate, old-gold exchange (gross→scrap, deduction only
  reduces paid, fine tracked, stone weight excluded from gold value), negotiated total,
  split tender, returns w/ settlement; **Normal/Touch billing toggle** (retail + B2B);
  On-Approval (Out) with DateField return-by.
- **Purchases v2**: local + B2B bills; per-line modes **touch / weight_rate / fixed_cost /
  stone**; 3% GST + ITC (stones 0.25%); settlement → supplier account; bill detail.
  Diamond-studded ornaments = metal line + StonePicker (→ Diamond stock); loose diamonds =
  `stone` mode → loose-stone inventory.
- **Stones**: shared StonePicker — default generic "Stone", catalogue stones, separate
  qty / weight(ct|g) / rate / amount columns, manual amount override; amount = rate×weight
  (same unit) or rate×pcs; graded diamonds use grade ₹/ct.
- **Parties (unified)**: customers are now Parties too — `create_customer` creates/links a
  party (role customer), backfill migration 0042; **Customers screen removed from sidebar**,
  Parties is the single customer home. Dual cash+metal ledger, e-invoice JSON export.
- **Schemes**: two types (Value 11+1, Gram rate-averaging). Enroll, **Collect dialog**
  (amount + mode Cash/UPI/Bank/Card/Cheque + reference), auto-maturity, close/redeem, and a
  **printable receipt / passbook** (`SchemeReceipt`, uses Company Profile header). Backend
  `GET /schemes/:id`; migration 0043 added installment `reference`.
- **Advance (redesigned)**: amount advances + **metal (gold) bookings** (book N grams, pay
  10/25/50/100% at locked rate), due dates, **continuous ADV-…-#### numbers** (migrations
  0045/0046, in Document Numbering), dashboard metrics (`GET /advances/metrics`), tabs
  **Book / Matured (due) / All**, per-advance **Close** (settle) and **Refund** (money back,
  status refunded). Migration 0044 for the schema.
- **Inventory / Stock**: Materials manager (metals+stones+categories), Loose Stones
  (sidebar screen only — removed from the Stock tabs; Stock is metal-focused), Resale
  (margin scheme), two-stage purity, **Stock** redesign (tabs: All metal · Gold · Diamond
  ornaments · Silver · Platinum, each with old/scrap; loose stones separated out), item
  categories, Metal Account report.
- **Settings**: General (date format + rate ticker), Print & Page (+ profile), Materials,
  **Modules** (toggle optional modules: Loose Stones, Gold Schemes — `lib/modules.ts`,
  gated in Sidebar), **Company profile** (`lib/company.ts` → invoice header + e-invoice
  seller block), **Document numbering** (per doc-type prefix/pad/series, GST 16-char guard).
- **Other**: Daily Rates (+history, DateField), Smith job-work, Cheque register, global
  date format, global dialog system, configurable topbar rate ticker, maximized window,
  A4 print framework.

- **Unfixed bills + Rate Cutting** (done): purchase `unfixed` posts fine grams to supplier
  metal account; B2B invoice `unfixed` posts grams to customer metal account; **Rate Cutting**
  (migration 0049, `rate_cut`, `RC-`) converts party metal↔money at a rate (partial cuts),
  B2B-only, screen at Old Gold → Rate Cutting.
- **Purchase Return** → debit note (DBN-, migrations 0047/0048) reversing stock + payable.
- **Barcode / tagging** (done, migration 0050):
  - **SKU = barcode**, Code128, metal+karat-prefixed (e.g. `G22-000123`), live-valued.
    Auto-generated on purchase when the SKU is left blank (via `tag` doc series → `gen_item_barcode`).
  - **Tag printing**: `GET /items/tags?ids=…` + `TagSheet` component (JsBarcode Code128 labels
    with shop name/purity/weights/HUID). Auto-opens after a purchase; reprint from Stock item
    detail ("Print tag").
  - **Two-track intake**: itemised piece lines (Scenario A) vs **bulk lots** (Scenario B) —
    purchase line `pricing_mode = "lot"` (+ pieces) creates a `stock_lot`; the **Tagging screen**
    (Inventory → Tagging) weighs each piece out of a lot into barcoded items (`POST /stock-lots/:id/tag`),
    decrementing remaining gross/pieces and auto-closing the lot. `GET /stock-lots` lists open lots.
  - **Scan on Stock**: search box doubles as a scan box (Enter on exact SKU opens the item).
- **Users & Roles** (done; **Settings → Users & roles**, owner-only via `user.manage`):
  full user administration — `GET /users` (list), `POST /users` (create), `POST /users/:id`
  (change role / enable-disable), `POST /users/:id/reset-password`, `DELETE /users/:id`
  (permanent delete). Four **built-in roles** — owner / manager / **accountant** / cashier —
  mapped in `has_permission` (accountant = `report.view` + `stock.read`: books, banking,
  day-close, reports, GST + read-only stock; no sales/purchase/user powers). The screen shows
  an inline add-user form, a users table (role dropdown, Active/Disabled badge,
  Reset / Disable / **Delete** actions) and a **role capability reference** (4 cards). Guards:
  can't change or delete **your own** account, and can't demote/deactivate/delete the **last
  active owner**; disable/reset/delete revoke that user's sessions immediately. Nav item hidden
  for non-owners (client) and enforced server-side.
- **Staff / Attendance / Leave / Payroll** (done, migration 0052; permission `staff.manage`):
  - **Staff** master (code, salary type monthly/daily/hourly, base + allowances, biometric user id,
    weekly off, bank/PAN, active/inactive).
  - **Attendance**: month register grid (click a cell to cycle Present → ½ → Absent → Leave),
    per-staff monthly summary, manual + device/import sourced. Punches auto-reduce (min=in, max=out,
    hours computed).
  - **Leave**: seeded types (CL/SL/EL/LWP), apply → approve/reject; approval posts to attendance
    (paid→'leave', unpaid→'absent'); per-staff annual balances (quota−used).
  - **Payroll**: generate monthly run from attendance — prorated `base × payable_days ÷ days_in_month`
    (payable = present + ½·half + paid-leave + week-off + holiday; LOP = absent + unpaid), daily/hourly
    modes, editable allowances/deductions per payslip, Finalize → Mark paid, **printable payslip**.
  - **Biometric devices** (eSSL/CP Plus/ZKTeco): device registry, real TCP **test-connection**,
    **ADMS/iclock HTTP push** ingestion (public `/iclock/cdata`, LAN-only) + **CSV import**; live
    ZK TCP pull is a documented stub (needs on-LAN agent). Endpoints: `/staff`, `/attendance`,
    `/leave-*`, `/payroll-runs`, `/payslips/:id`, `/biometric-devices*`.
- **Staff/Payroll v2** (done, migration 0053) — gap closure:
  - **Holiday calendar** (`/holidays` CRUD) + **auto week-off/holiday fill** (`/attendance/fill`,
    from `staff.weekly_off` + holidays); payroll generate runs the fill first so monthly pay is
    correct. Attendance screen has a Holidays manager + "Fill offs" button + attendance-% column.
  - **Statutory payroll**: PF (base capped at ceiling × %), ESI (if gross ≤ ceiling × %), PT (flat),
    TDS (manual) as editable payslip lines; config in `app_setting payroll.*` (editable via Payroll
    "Statutory setup"). Payslip print + bulk print + CSV register export.
  - **Salary advances/loans** (`staff_advance`, `/staff-advances`): monthly recovery pulled into
    payroll; **mark-paid reduces outstanding FIFO** and **posts a `ledger_event` (salary_paid)**.
  - **Leave**: half-day (0.5), overlap 409, paid-type balance check 409, **cancel** (removes auto
    attendance). **Attendance shift rules**: `attendance.work_start/half_day_hours/late_grace_min`
    → punch reduce computes `late_minutes` + auto half-day.
  - **Biometric**: unmatched-punch list (`/biometric/unmatched`) + **map-to-staff relink**
    (`/biometric/relink`, sets `staff.biometric_user_id` + folds punches) with UI on Devices.
- **Staff/Payroll v3** (done, migration 0054):
  - **On-LAN sync agent** (`tools/biometric-agent/`, Python + pyzk) → posts to key-guarded
    `POST /biometric/agent-ingest` (`app_setting biometric.agent_key`). The reliable automatic
    pull path. **Device scan** (`/biometric/scan`, parallel /24 probe) + **live status**
    (`/biometric-devices/status`) + redesigned card-based Devices page.
  - **Proper ADMS/iclock handshake** (`GET OPTION FROM:` block, `table` param, OK responses).
    Still needs validation against real firmware.
  - **Overtime**: hours beyond `attendance.full_hours` → OT pay at `ot_rate_multiplier` (config
    `payroll.ot_enabled`), shown on payslip. Verified 3h×₹125×2=₹750.
  - **Statutory depth**: PT slabs (`payroll.pt_slabs` JSON, else flat), **employer PF/ESI**
    contributions computed + shown (informational). Editable statutory setup on Payroll.
  - **Statutory return exports** (done, migration 0066): **PF ECR** (`/payroll-runs/:id/pf-ecr`, ECR 2.0
    `#~#` text — reconstructs EPF wages from payslip PF at the configured %, EPS 8.33% cap ₹1250, ER
    diff) and **ESI monthly CSV** (`/payroll-runs/:id/esi-return`); UAN + ESIC IP added to staff.
    Download buttons on the Payroll run. *Validate in the EPFO/ESIC portal before filing.* Form-16/24Q
    (TDS) still deferred.
- **Reports module** (done + **reconciled to raw SQL**): `report.view`. Sales register, purchase
  register, GST net (`/gst-net`), stock valuation, **stock ageing** (dead/slow-moving), **sales by
  purity**, party outstanding, **scheme dues**, **advance dues**, day book. **Correctness:** sales/
  purchase/GST are **net of returns** — only `final`+`returned` tax invoices, minus `credit_note`
  (sales) and `purchase_return` (ITC); dashboard figures net of returns too. Reports screen: tabs +
  DateField range + CSV + print. Dashboard redesigned (`/reports/dashboard`, KPIs + 6-mo trend +
  stock-by-metal + collections).
  - **Gross profit** (done, transparent): margin computed only on cost-tracked (item-linked,
    cost>0) sales; uncosted/loose lines reported separately with a coverage % — never a false
    100% margin. **Stock revaluation** (metal value at current `metal_rate` vs book cost),
    **Smith ledger** (formerly "Karigar ledger"; metal issued−returned + making payable−paid,
    reconciled 59.3g/₹10,342.50).
  - **Redesigned into a per-section hub** (done): the single **Reports** sidebar entry is now a
    two-pane hub (section rail + per-section report picker + canvas), each business section
    owning its own reports. Shared views live in `components/reports/views.tsx`
    (`ReportResultView`, `csvFor`); registry-driven screen in `components/reports/Reports.tsx`.
    **48 reports across 11 sections** — Sales, Schemes, Parties, Advance, Inventory, Purchases,
    Old Gold, Workshop, Staff, Banking, Accounts & Compliance. New registers added (all
    `{rows,totals}`, `report.view`, net-of-returns where relevant): sales returns, estimates/
    quotations, on-approval outstanding, scheme enrollment/collections/maturity, advance
    register, party metal balances, top customers, barcode-wise stock, loose-stone & resale
    valuation, supplier-wise + purchase returns, old-gold intake, rate-cutting register,
    job-work register, leave register, salary advances, cheque status, statutory register
    (PF/ESI/PT/TDS). Design doc: `docs/01-product/reports-module-design.md`.
  - **Accounts & Compliance Books** (done): **Day book** (null-safe fix), **Cash & bank book**
    (receipts vs payments by mode), **Daily collections** (day-wise Cash/UPI/Card/Bank/Cheque),
    **Cash book** (opening + receipts − payments = closing, running balance, cash vs bank),
    General ledger. Report column order fixed via serde_json `preserve_order`; date columns
    render in the global format + timezone.
  - **GSTR-1 / GSTR-3B exports** (done — schema-aligned): `/reports/gstr1?period=YYYY-MM`
    builds b2b/b2cl/b2cs/cdnr/hsn (b2cs net of B2C credit notes, b2cl ₹1L threshold);
    `/reports/gstr3b` builds 3.1(a) osup_det net of CN, 3.2 inter-state unregistered, §4 ITC
    from B2B purchases net of returns. GSTN-format JSON downloadable from a month-filtered
    **compliance** view (Accounts & Compliance), computed from the same net-of-returns source
    as GST net. **Caveat:** labelled *validate in the GSTN offline tool before filing* — schema
    versions change and the exact format has not been round-tripped through a real GSTN utility.

- **Accounting — full double-entry** (done, migrations 0055/0056; sidebar **Accounts**, `report.view`):
  non-invasive **projection** model — `POST /accounts/rebuild` idempotently regenerates a balanced
  `journal_entry`/`journal_line` from source documents (no existing handler touched). Seeded 24-account
  jewellery **Chart of Accounts**; posts invoices (tender/debtor/old-gold/scheme/advance/GST/round-off),
  credit notes, purchases + Input GST, purchase payments, **purchase returns**, customer advances +
  **refunds**, **customer receipts** (Dr cash/bank, Cr debtors), scheme collections + **cash closures**,
  **rate cutting** (we_owe→Purchases/Creditors, they_owe→Debtors/Sales), payroll (paid, with PF/ESI/PT/TDS
  + loan recovery), staff advances, **manual expenses**, **manual bank entries**, **opening balances**
  (capital = balancing figure), and a periodic **closing-stock** adjustment. Statements: **Trial Balance,
  P&L, Balance Sheet, Journal, account Ledger** — all reconcile (TB Dr=Cr; BS assets = liab + equity).
  Accounts UI tabs: P&L · Balance Sheet · Trial Balance · Journal · Expenses · Receipts · Chart of
  Accounts · Opening balances, with auto-Rebuild on open. **Periodic-inventory** model (Purchases =
  total−tax; Closing Stock credit) — no full COGS-per-line. **Key data fact:** purchase `subtotal` IS
  the taxable value (tax=3% of subtotal, total=subtotal+tax); `making_total`/`stone_total` are
  breakdowns *within* subtotal — never add them (fixed a double-count in 4 GST reports too).
  - **Per-bank-account ledgers** (done, migration 0067): each `bank_account` has its own COA asset
    ledger (`1010.<id>`); `accounts_rebuild` routes every bank movement to the right bank via the
    `bank_recon` assignment (default primary), posts inter-bank transfers, and takes each bank's
    opening balance from the Bank Accounts master. TB/BS/Ledger show each bank separately.
  - Deferred: old-gold melt/refining-loss valuation.

- **Banking — accounts + reconciliation** (done, migrations 0057/0058/0059/0060; sidebar **Bank Accounts**):
  bank-account **CRUD** (name/bank/A-c/IFSC/opening balance/primary/**type** savings·current·OD·CC) with
  delete-confirm + guards (can't delete primary or accounts with transfers). Per-account **statement**
  (latest-first, running balance, opening-balance row), **fund transfers** between accounts (contra),
  **manual bank entries** (deposit/withdrawal/interest/charges/other, add/edit/delete → post to journal),
  and **reconciliation** (tick cleared, reassign a movement to another account, enter statement balance →
  reconciled/difference). Movements = union of non-cash tenders/receipts/purchase-payments/expenses/
  salary/staff-advances + transfers + manual entries; state in `bank_recon` (survives rebuilds).
  - **Statement import** (CSV/XLS/XLSX via SheetJS `xlsx`): upload → column-map (header toggle, date
    format, debit/credit or single-amount) → **auto-match** to book movements by amount + date window →
    review screen (manual match dropdown, one-click **create-entry** for unmatched charges/interest,
    unmatch). Matching marks the movement cleared. Deliberately **no PDF** (chose reliable structured
    import per research). All parsing is local (no cloud).

- **Day Close — cash + stock (Phases 1–3)** (done, migrations 0061/0062/0063/0064; sidebar **Banking →
  Day Close**, Cash/Stock tabs): showroom-level **day open → close** per business date.
  - **Cash:** open logs an opening float (direct or via denomination count, carried forward from the
    previous day's counted closing). Close shows the **expected** drawer cash (`opening + cash-in −
    cash-out`, from a cash-only movement union: cash sales/receipts/scheme/advances in, purchase-
    payments/expenses out), an **INR denomination counting grid** (₹2000…₹1) → **counted** cash, and
    the live **variance** (Short/Excess/Balanced). Cash variance posts to **Cash Short / Over**
    (COA 5995) on accounts rebuild (shortage Dr 5995/Cr Cash; excess reversed). **Mid-day spot-check**
    (`cash_tally`, migration 0065): record interim drawer counts (expected/counted/variance/note)
    **without closing** the day; today's tallies list under the Cash tab.
  - **Stock — two methods (toggle):**
    - **Weight aggregate:** book-vs-physical count per **Metal → Purity/Karat → Category** bucket, five
      measures **Nos · Gross · Diamond CT · Stone · Net** (Diamond CT = carat of diamond stones via
      `item_stone`+`stone_type.category='diamond'`; always shown, Navratna-aware). Physical entry per
      bucket → per-cell variance + subtotals.
    - **Tag scan (+ full-weigh):** scan each barcoded piece (`item.sku`); **missing** = expected
      `in_stock` pieces not scanned (shown with SKU/group/category/weight), **extra/unknown** = a
      scanned tag not expected on-floor (sold-but-present or foreign barcode), **duplicate** flagged.
      Optional **full-weigh** captures a weighed gross per piece → per-piece weight variance that rolls
      up into the bucket grid. Scans stored in `stock_count_scan` (present/missing/extra).
    - Book is a snapshot of `item` (on-floor `in_stock`); **approval / sale-or-return-out** pieces shown
      as a reconciling off-floor column. Stored in `stock_count`/`stock_count_line` (1:1 with the day).
  - Soft-lock with **permissioned reopen** (editing cash or stock on a closed day → 409 until
    reopened); recent-days **register**; printable cash / count / tag-exception sheets; a **day-close
    variance report** (Reports → Banking: date-range cash short/over + stock variance + missing pcs +
    spot-checks). *Deferred:* per-counter tills.
- **Global display** (done): configurable **timezone** (Settings → General, default `Asia/Kolkata`) —
  `formatDate`/`formatDateTime` convert stored UTC timestamps to the chosen zone; date-only values not
  shifted. Reports auto-format date columns and show entry time (HH:MM:SS) where present.
- **App shell / navigation** (done): the sidebar is **grouped into collapsible accordion sections**
  by function (Sales · Customers · Purchases · Inventory · Old Gold · Workshop · Banking & Cash ·
  Staff & Payroll · Accounts & Reports), with **Dashboard pinned top** and **Settings pinned bottom**;
  group headers carry icons, open/closed state persists to `localStorage`, and the active page's group
  auto-expands. Icon-collapsed rail still shows every item. Optional modules + owner-only items are
  filtered out of the nav.
- **Live rate ticker** (done): the Topbar metal/diamond ticker updates immediately when rates are saved —
  Daily Rates dispatches a `cygnus:rates` event; `App` re-fetches `listRates()` (also on window focus)
  and the diamond chip reads the `rates.diamond_per_ct` setting you actually edit (falls back to the
  highest active diamond grade).
- **Branding** (done): Cygnus swan logo — in-app **sidebar + login + favicon** use `public/logo.png`;
  the full **OS/app icon set** (Windows `.ico`, macOS `.icns`, Linux PNGs, Store/Square logos, iOS/
  Android) was regenerated via `pnpm tauri icon`. The shop's own invoice logo (Company Profile) is
  separate and untouched.
- **Departments (jewellery type)** (done, migration 0068): a user-managed grouping **above metal** —
  Gold Ornaments / Fine Gold / Diamond Ornaments / Silver / Platinum (editable in Settings → Materials →
  Departments). Every item = **Department + Metal + Purity + weights + diamonds/stones**; metal/purity
  still drive gold value, hallmark and fine-weight — the department is the read/label grouping.
  `department_id` on `item`/`purchase_bill_line`/`invoice_line` (backfilled). Purchase & sale lines have
  a **Type dropdown** (auto-defaults from metal + diamond presence via `resolve_department`, overridable).
  **Stock summary/tabs, the stock day-close grid, and the stock overview** all group by
  **Department × Purity** (Gold Ornaments 22K, Fine Gold 999.9, Diamond Ornaments 18K), showing
  Nos · Gross · Diamond CT · Stone · Net.
- **GST inter/intra correctness** (done): sales & purchase forms **auto-detect** intra (CGST+SGST) vs
  inter-state (IGST) from the party's GST state vs the seller state, and lock the tax heads; purchase
  `inter_state` is computed server-side at creation; GSTR-3B/ITC/compliance derive the split from the
  real GSTIN state codes (not a stale flag). **HSN** flows from the metal master's `default_hsn` (7113)
  into invoice/purchase lines, stock detail, and prints.
- **Demo data**: `tools/reseed_all.py` + `tools/reseed_staff.py` reseed a coherent Apr–Jul 2026 dataset
  (10 customers, B2B parties, purchases, sales, advances, schemes, staff/payroll) with sequential,
  chronological document numbers.

- **Deployment — server / client, one binary** (done): the same backend serves both roles via a
  runtime flag, not a separate build. `BIND_ADDR` (default `127.0.0.1:8787`, set `0.0.0.0:8787`
  on a server) controls LAN exposure. **`--server` / `CYGNUS_MODE=server`** + the optional
  **`embedded-pg`** cargo feature boots and manages its **own PostgreSQL 18** (crate
  `postgresql_embedded`, rustls; persistent data dir `~/.cygnus/pgdata`, `EMBEDDED_PG_PORT` 5433,
  `EMBEDDED_PG_PASSWORD`, `CYGNUS_DATA_DIR`) and auto-opens the LAN — so a server PC needs no
  separate DB install. Clients run only the desktop app, pointed at the server URL (login screen
  field, `cygnus_base`). CORS permissive. **Verified** embedded boot + migrate + login end-to-end.
  **Graceful shutdown** added (SIGTERM/SIGINT → axum graceful stop → `pg.stop()` before exit;
  embedded PG is no longer orphaned on signals).
  *Not yet done:* offline cache / WebSocket live sync, packaged role-picker installer.
- **Connected-clients + role indicator** (done): backend tracks caller IPs via the `/health`
  heartbeat (desktop pings every 15s) → `/health` now returns `clients` (distinct non-loopback
  machines active in the last 60s) + `terminals`. Footer StatusBar shows a **Server / Client** badge
  (derived from whether `cygnus_base` is local) and, on a server, **"N clients connected"**.
- **UI polish** (done): sidebar **collapse now shows one icon per group with a hover flyout**
  submenu (not every item flat); bigger nav icons/text + logo. Logo sits on a **dark rounded badge**
  so its light/white artwork stays visible in light mode.
- **Old Jewellery exchange (reframed from "Old Gold")** (done, migration 0069): the exchange is now
  **metal-agnostic** — gold, silver, platinum and **diamond ornaments**. Sale-form exchange rows
  have a **Type** dropdown: Gold/Platinum ornament (purity → net×buy-rate), **Silver (touch %)**
  (value = gross×touch%×pure-silver rate; sent as an effective ₹/g + tested_fineness=touch×10),
  and **Diamond ornament** (metal on net + StonePicker diamonds with **buyback %**: presets 70/80 or
  manual). The exchange **Type** dropdown ("Old Gold/Diamond/Silver/Platinum Ornament") drives
  `old_gold_lot.department_id` directly (kind→department; falls back to `resolve_department`) +
  `old_gold_stone.buyback_percent`; bought diamonds enter loose-stock at the
  discounted price. Register renamed **Old Jewellery Register** (+ Type column/filter); nav group
  **Old Jewellery**, "Old Metal Account"; report/preview/totals relabelled. Schema stays
  `old_gold_lot`/`old_gold_stone` (internal). **Verified**: diamond exchange at 70% → value 204400,
  dept Diamond Ornaments, loose stock cost 70000. *Data to enter:* platinum 950 + silver 999
  buy-rates in Daily Rates.
  - **Downstream wired for multi-metal** (done): **Metal Account** report groups per metal
    (gold/silver/platinum rows). **Melt** and **smith scrap-issue** both enforce a **single-metal
    batch** — `create_melt` and `issue_smith_job` (source=scrap) 409 if any lot's metal differs from
    the batch/issue metal (and validate lot status); the Melt Scrap UI filters scrap to the selected
    metal (+ Type column, clears picks on metal change). Smith issue-to-smith form is fine-weight+metal
    based. Dashboard/reports labels relabelled to "Old jewellery". Old-gold accounting posting is
    value-based (metal-agnostic). *Deferred:* melt refining-loss valuation (costing the loss).
  - **Diamond entry, report + refurbish-to-stock** (done, migration 0070): the Diamond-ornament exchange row
    now takes **inline Diamond ct + Diamond value ₹** (manual, per assessed ct) with buyback %/return-buy;
    stone weight auto = ct×0.2 (metal valued on net only). The **Old jewellery intake report** gained
    **Type (department) · Dia ct · Diamond bought value** columns + totals. **Convert to stock (refurbish)**:
    `POST /old-gold/:id/convert` turns an in-scrap lot into a **barcoded stock item** — cost = value paid +
    repair + making, department carried over (overridable), SKU auto via `gen_item_barcode`; lot → `converted`
    (migration 0070 adds status `converted` + `converted_item_id`/`repair_cost`), ledger `old_gold_converted`.
    Register has a **Convert to stock** action + dialog (prefilled weights, repair/making, dept) that prints
    the new tag. **Verified**: platinum lot ₹15000 + repair 500 + making 300 → item SKU `P950-000030`, cost
    ₹15800, dept Platinum Ornaments; re-convert 409.

## Deferred (need product decisions / hardware)
- **Multi-branch**: everything runs on `s.default_branch`; no branch switcher/scoping UI.
- **Employee self-service** portal / granular per-staff RBAC (only owner/manager today).
- **Biometric live pull validation**: agent + ADMS are written but unverified against a physical
  device; **Form-16 / 24Q (TDS)** returns and true invoice-level ageing not built (PF ECR + ESI
  monthly exports are done).
- **Accounting edges**: old-gold melt/refining-loss valuation and scheme-bonus nuances beyond the
  basic postings. Bank statement **PDF** import deliberately skipped (CSV/XLS/XLSX only, per research).

## Planned / open
- Barcode-wise stock report + untagged-lot balance surfaced on the Stock overview (done).
- Purchase bill **A4 print** (done — `PurchaseBillPrint`, company header, lines/totals/
  payments, from the purchase detail modal).

## Optional modules (Settings → Modules)
Toggle via `lib/modules.ts` (localStorage + server `modules.<id>` mirror; Sidebar filters
by `PAGE_MODULE`). Current: `loose_stones`, `schemes` (both default on). Add more by
extending DEFAULTS + OPTIONAL_MODULES + PAGE_MODULE.

## Doc-number prefixes
INV invoice · PUR purchase_bill · CRN credit_note · DBN debit_note · EST estimate ·
QTN quotation · APP approval_slip · SOR sale_or_return · SCH scheme · **ADV advance** ·
RC rate_cut · **TAG item barcode series**.
