# Repository structure

```
Cargo.toml                      # Rust workspace
crates/
  core-engine/                  # shared valuation/conversion/tax engine (fixed-point, tested)
  backend/src/main.rs           # Axum + Postgres API — ONE large file (routes + handlers)
apps/desktop/
  src/api.ts                    # typed client for the backend (req<T>); all DTOs live here
  src/components/
    sales/InvoiceForm.tsx       # multi-line invoice/estimate (Normal/Touch toggle, old gold)
    sales/StonePicker.tsx       # shared stone entry (used by sales AND purchases)
    sales/InvoicePreview.tsx    # A4 print
    purchases/Purchases.tsx     # purchase bills (touch/weight/fixed/stone modes, settlement)
    inventory/StockList.tsx     # Stock: tabbed metal sections (loose stones separated out)
    inventory/LooseStones.tsx   # loose-stone inventory (optional module)
    parties/Parties.tsx         # unified Party CRUD + dual cash/metal ledger (customers live here)
    schemes/Schemes.tsx, schemes/SchemeReceipt.tsx  # savings schemes + printable receipt/passbook
    advances/Advances.tsx       # advances: amount + metal bookings, tabs, close/refund, ADV numbers
    accounts/Accounts.tsx       # double-entry accounting hub: P&L · Balance Sheet · Trial Balance ·
                                #   Journal · Expenses · Receipts · Chart of Accounts · Opening balances
    banking/BankAccounts.tsx    # bank account CRUD (type: savings/current/OD/CC), per-account
                                #   statement (latest-first + running balance), fund transfer,
                                #   reconciliation (clear/assign + statement diff), manual bank entries
    banking/StatementImport.tsx # CSV/XLS/XLSX statement upload (SheetJS) → column map → auto-match review
    banking/DayClose.tsx        # day open/close hub (Cash + Stock tabs): float, denomination grid,
                                #   expected-vs-counted variance, register; stock book-vs-physical grid
    banking/StockCount.tsx      # stock day-close: method toggle — weight-aggregate grid + tag-scan
    banking/TagScan.tsx         # barcode tag-scan count (present/missing/extra) + weekly full-weigh
    reports/Reports.tsx, reports/views.tsx  # per-section reports hub (48 reports, 11 sections, grouped picker)
    users/Users.tsx             # Users & Roles admin (list/create/role/enable-disable/reset/delete)
                                #   — rendered as the owner-only "Users & roles" tab inside Settings
    settings/Settings.tsx       # General (date fmt + timezone) · Print · Materials · Modules ·
                                #   Company profile (state dropdown) · Doc numbering · Users & roles (owner)
    layout/Sidebar.tsx          # grouped, collapsible accordion nav (Dashboard pinned top, Settings
                                #   bottom; group headers w/ icons; open state persisted; when collapsed,
                                #   one icon per group + hover flyout submenu); uses /logo.png on a dark badge
    layout/Topbar.tsx           # live metal-rate ticker (refreshes on `cygnus:rates` event) + profile menu
    layout/StatusBar.tsx        # footer: Server/Client badge (local base ⇒ Server) + "N clients connected"
    auth/LoginScreen.tsx        # login (uses /logo.png; server-address field → cygnus_base)
    smiths/, rates/, banking/ChequeRegister, inventory/...
    oldgold/OldGoldRegister.tsx # "Old Jewellery Register" — metal-agnostic exchange (gold/silver/
                                #   platinum/diamond), Type column + filter (schema stays old_gold_*)
  public/logo.png               # Cygnus swan brand logo (in-app sidebar/login/favicon); app/OS icons
                                #   live in src-tauri/icons/ (regenerate via `pnpm tauri icon <png>`)
  src/lib/                      # utils (cn, formatINR, formatDate, formatDateTime, timezone),
                                #   dialog (imperative confirm/alert), ticker, nav, modules,
                                #   company (seller profile), printProfile
db/migrations/                  # 0001..0070 SQL migrations (auto-applied on startup)
docs/                           # product/architecture/delivery docs
```

## Key backend handlers (in main.rs)
- `build_invoice` — core invoice builder (shared by invoices + estimate conversion);
  per-line valuation via `value_line`; touch path sets effective rate = touch%/100 × pure.
- `create_purchase` / `get_purchase` / `list_purchases` — purchase bills v2 (incl. `stone` lines).
- `price_preview` — live line pricing (mirrors build_invoice; supports touch).
- `report_stock_overview` — metal summary (split gold/diamond/silver/platinum + diamond
  carat), by-category (with `has_diamond`), old/scrap metal + old/loose stones.
- `record_advance` / `close_advance` (close|refund) / `advance_metrics` — advances v2.
- `create_scheme` / `scheme_pay` / `get_scheme` / `scheme_close` — savings schemes.
- `create_customer` — also creates/links a Party (role customer).
- `allocate_doc_no` + `document_series` (GET/POST `/document-series`) — doc numbering.
- **Users & Roles**: `list_users` (GET `/users`), `create_user` (POST `/users`), `update_user`
  (POST `/users/:id` — role / active), `reset_user_password` (POST `/users/:id/reset-password`),
  `delete_user` (DELETE `/users/:id`). All gated by `user.manage`. Roles are code-defined in
  `has_permission`: **owner / manager / accountant / cashier** (accountant = `report.view` +
  `stock.read`). Guards: no self role/status change or self-delete; last active owner can't be
  demoted/deactivated/deleted; disable/reset/delete revoke that user's sessions.
- Party ledger derived from `ledger_event` where `subject_type='party'`.
- **Accounting (double-entry)**: `accounts_rebuild` — idempotent posting engine that projects
  every document (invoices, credit/debit notes, purchases + returns, payments, receipts,
  advances + refunds, scheme collections/closures, rate cuts, payroll, staff advances,
  expenses, bank entries, opening balances, closing stock) into a balanced `journal_entry`/
  `journal_line`. Statements: `accounts_trial_balance` / `accounts_pnl` / `accounts_balance_sheet` /
  `accounts_ledger` / `accounts_journal` over `chart_of_account`. Expenses + receipts + COA CRUD.
- **Banking**: `bank_accounts_*` (CRUD, type savings/current/od/cc), `bank_reconcile` (per-account
  statement, latest-first + running balance, incl. transfers + manual entries), `bank_recon_set`
  (assign/clear a movement), `bank_transfer_create`, `bank_entry_*` (manual deposits/charges/etc.).
  Bank movements = union of non-cash tenders/receipts/purchase-payments/expenses/salary/staff-advances.
- **Statement import**: `create_statement_import` (auto-match statement lines to book movements by
  amount + date window → mark cleared), `get_statement_import`, `stmt_line_match`/`unmatch`/
  `create_entry`. Reconciliation state in `bank_recon`; frontend parses CSV/XLS/XLSX via SheetJS.

## Conventions for finding things
- New DTO/endpoint client → add to `apps/desktop/src/api.ts`.
- New screen → component under `src/components/<area>/`, route in `App.tsx`, nav in
  `src/lib/nav.ts`.
- **Roles/permissions** are code-defined: extend `has_permission(role, perm)` in `main.rs`
  and gate handlers with `auth.require("perm")`. Client role is in `localStorage("cygnus_role")`.
- **Cross-component refresh** uses `window` custom events (dispatch + listen), not polling:
  `cygnus:rates` (rate save → Topbar ticker + App re-fetch), `cygnus:modules` (module toggles →
  Sidebar), `cygnus:ticker` (ticker item selection).
- **Branding**: in-app logo is `public/logo.png` (referenced as `/logo.png`). App/OS icons in
  `src-tauri/icons/` are regenerated from a source PNG with `pnpm tauri icon <png>` (icons are
  embedded at build time — restart `tauri dev` to see a new window/taskbar icon).
- Stones are entered ONLY through `StonePicker` (shared) — fix it once, both flows benefit.
- **Dates: NEVER use native `<input type="date">` or `type="month"`** (unreliable in the
  webview and ignores the app's date format). ALWAYS use the shared pickers:
  - Day dates → `DateField` (`src/components/ui/date-field.tsx`) — value/emits ISO
    `YYYY-MM-DD`, displays in the configured format.
  - Month/period → `MonthField` (`src/components/ui/month-field.tsx`) — value/emits `YYYY-MM`.
  Any date shown as text uses `formatDate` from `src/lib/utils`.
