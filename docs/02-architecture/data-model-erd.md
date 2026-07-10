# Data Model / ERD

Core entities for the retail + wholesale scope. This is a logical model — column lists are
indicative, not final DDL. Two ideas dominate: the **append-only event ledger** and the
**ownership state machine**. Manufacturing seams are noted but not built.

All weight and money columns are **fixed-point decimal** (`NUMERIC`), never float.

---

## Entity overview

```
Branch --< User
Branch --< Item >-- Category
Item   --< ItemStone >-- Stone
Item   --< LedgerEvent           (every movement of this item)
Lot    --< LedgerEvent           (loose stone/metal movements)
MetalRate (time-series)
Customer --< Invoice --< InvoiceLine >-- Item
Customer --< ApprovalOut (On-Approval / take-home trial)
B2BCustomer --< B2BOrder --< B2BOrderLine
B2BCustomer --< SaleOrReturnOut --< SaleOrReturnLine >-- Item
Supplier --< PurchaseOrder --< GRN
Scheme --< SchemeInstallment
Invoice --> RateSnapshot (frozen pricing)
PriceRule (making/wastage/trade pricing)

Branch --< Department --< Staff
Staff --< BiometricEnrollment >-- BiometricDevice
BiometricDevice --< PunchEvent >-- Staff
Staff --< AttendanceDay
Staff --< LeaveRequest >-- LeaveType
Staff --> SalaryStructure
PayrollRun --< Payslip >-- Staff
```

---

## Reference & org

### Branch
`id, company_id, name, type{showroom|warehouse}, address, lan_server_addr, created_at`

### User
`id, branch_id, name, login, role_id, status, created_at`
- Roles/permissions are action-level (see security.md). No shared logins.

### Category / MetalType / Purity (master data)
- `MetalType`: `id, name{gold|silver|platinum}, base_unit`
- `Purity`: `id, metal_type_id, karat, fineness` (e.g., 22K / 916)
- `Unit`: `id, name{gram|tola|carat|piece}, to_base_factor` (exact decimal)

---

## Stock core
*(formerly "Inventory" — we use "Stock" throughout. Module O3.)*

### Item (serialized finished piece)
```
id, branch_id, sku, category_id, metal_type_id, purity_id,
gross_weight, net_weight, stone_weight,
huid, certificate_no,
making_rule_id, wastage_rule_id,
cost_value, photos[],
ownership_state{in_stock|on_approval_out|sale_or_return_out|received_in|sold|written_off},
location, created_at
```
- `ownership_state` is the current projection; transitions are recorded as `LedgerEvent`s.
- Manufacturing seam: BOM/style fields attach here later.

### Stone & ItemStone
- `Stone`: `id, type, shape, carat, color, clarity, cut, certificate_no, cost,
  pricing_unit{carat|gram|piece|ratti}, rate_in_unit, quantity_in_unit`
  - `stone_value = rate_in_unit × quantity_in_unit` (carat/gram/ratti) or `rate × pieces`.
  - 1 ct = 0.2 g; 1 ratti ≈ 0.182 g (≈ 0.911 ct, configurable).
- `ItemStone`: link table `item_id, stone_id, position` (stones set into a piece).

### Lot (loose stones / bulk metal / scrap)
```
id, branch_id, kind{loose_stone|bulk_metal|scrap},
metal_type_id?, purity_id?, stone_attrs?,
quantity, weight_or_carat, avg_unit_cost,   -- weighted average
source{purchase|old_gold_exchange|...}, created_at
```
- **Parcel breaking**: splitting a lot writes events and recomputes `avg_unit_cost` for both
  resulting lots (weighted average preserved).
- Scrap lots are created by old-gold exchange (Sales, O1) and feed manufacturing later.

---

## The event ledger (backbone)

### LedgerEvent (append-only, immutable)
```
id, branch_id, occurred_at, user_id,
subject_type{item|lot|cash|metal|stone},
subject_id,
event_type{created|valued|sold|returned|transferred_out|transferred_in|
           approval_out|approval_returned|sor_out|sor_returned|sor_invoiced|
           exchange_in|writeoff|payment|...},
before_json, after_json,
weight_delta?, carat_delta?, amount_delta?,
ref_doc_type?, ref_doc_id?
```
- Never updated or deleted. Corrections are new compensating events.
- Current states/balances (item.ownership_state, ledgers) are **projections** of this table
  and can be rebuilt from it.

---

## Pricing & rates

### MetalRate (time-series, effective-dated)
`id, branch_id?, metal_type_id, purity_id, basis{per_gram_karat|per_gram_pure}, buy_rate, sell_rate, effective_from, created_by`
- **India default:** one row per **(metal, purity)** with `basis = per_gram_karat`; rates are
  entered **independently** per purity (the system never derives one purity from another).
- Fine gold (999.9, 995, …) and silver (999, 925, …) are just additional purities with
  their own rows.
- Documents reference the rate valid at their timestamp.

### PriceRule (making / wastage / trade pricing)
```
id, scope{global|category|item|customer_tier|customer|metal},
charge_kind{per_gram|percent|flat|slab},
value_or_slab_json, applies_to{making|wastage|trade_price},
effective_from
```

### RateSnapshot / frozen pricing
- On invoice finalize, the full `PriceBreakdown` (rate id, components, taxes) is stored on
  `InvoiceLine` so reprints/audits are exact and independent of later rate changes.

---

## Sales — retail

### Invoice / InvoiceLine
```
Invoice: id, branch_id, customer_id, type{retail|b2b}, datetime,
         series_code, invoice_no, fy,                -- numbering (Rule 46)
         subtotal, discount_total, tax_total, grand_total,
         target_total?, target_adjustment?,        -- reverse round-off (see below)
         tender_json, irn?, eway_bill_no?, status
InvoiceLine: id, invoice_id, item_id?, lot_id?, description,
         rate_used, was_override, master_rate_id,   -- rate override at billing
         rate_snapshot_json, making, wastage, stone_value, discount,
         taxable_value, cgst, sgst, igst, line_total
```
- **Invoice numbering (GST Rule 46):** number is **consecutive and unique within the
  financial year**, ≤16 chars. **Multiple series are allowed**, so each terminal/branch
  gets its own `series_code` with its own gapless counter — this makes offline + multi-
  counter billing compliant (reserved per-terminal ranges, no collisions/gaps).

### DocumentSeries (configurable numbering for ALL documents)
Applies to invoice, purchase_bill, credit_note, debit_note, approval_slip, quotation, …
```
DocumentSeries: doc_type, fy, series_code,
                prefix, suffix, pad_width, next_no, active
                PRIMARY KEY (doc_type, fy, series_code)
```
- The full number = `prefix + zero_pad(next_no, pad_width) + suffix`,
  e.g. `INV-2627-0001` (prefix `INV-2627-`, pad 4). Set per document type at FY start.
- Allocation locks the series row (`FOR UPDATE`), reads `next_no`, increments → gapless &
  unique. Enforces the **16-char** GST limit. The formatted value is stored on the document
  (`invoice.document_no`, etc.) for immutable printing.
- Each document table keeps both `series_code` + integer `invoice_no`/seq (for ordering/
  uniqueness) and the formatted `document_no`.
- **Rate override:** `rate_used` is the rate actually applied; if the cashier typed it
  inline, `was_override = true` and `master_rate_id` points to the default it replaced.
  Override is per-bill only — the master rate is unchanged.
- **Target-total adjustment:** when a target grand total is set, the engine back-solves the
  making charge and recomputes GST; `target_total` and the resulting `target_adjustment`
  (delta absorbed into making) are stored for audit. See valuation-engine-spec.md.
- **Discount before GST:** `discount` reduces `taxable_value` before tax is computed.

### ApprovalOut (On-Approval / take-home trial — B2C)
```
id, branch_id, customer_id, item_id, out_at, due_back_at,
status{out|returned|converted_to_sale}, approval_slip_no, converted_invoice_id?
```
- NOT an invoice. Produces an Approval Slip. Converts to an Invoice only if bought.

### OldGoldExchange
```
id, invoice_id?, customer_id, gross_weight, tested_purity, net_fine_weight,
buy_rate_id, exchange_value, scrap_lot_id, created_at
```
- **No GST / no RCM** on old gold from an individual. GST is charged on the **full** new
  item value; `exchange_value` reduces the **amount payable** (post-GST), not the taxable
  value. See valuation-engine-spec.md.

### CreditNote (returns / value reduction — GST Sec. 34)
```
id, branch_id, original_invoice_id, customer_id, series_code, credit_note_no, fy,
reason{return|rate_diff|cancellation|...}, lines[], taxable_value, tax_total, total,
gstr1_period, created_at, created_by
```
- A **return/cancellation issues a GST credit note** (not deletion of the invoice), reported
  in GSTR-1 (declare by 30 Nov following the FY).
- On return, the engine writes **reversal LedgerEvents**: stock/ownership state restored to
  `In Stock` (or scrap if damaged), money/metal ledgers reversed. The original invoice is
  immutable; the credit note is the offsetting document.

---

## Sales — wholesale

### B2BCustomer
`id, name, gstin, tier, credit_limit, credit_terms, balance`

### B2BOrder / B2BOrderLine
`order: id, b2b_customer_id, status, promised_ship_date`
`line: id, order_id, item_id?, lot_id?, qty, trade_price_snapshot`

### SaleOrReturnOut / SaleOrReturnLine (B2B "memo-out")
```
out: id, b2b_customer_id, out_at, due_back_at, status{out|partially_returned|settled}
line: id, out_id, item_id, status{out|returned|invoiced}, invoice_id?
```
- Title stays with us until a line is invoiced (becomes a real sale) or returned.

---

## Purchase & suppliers (O2 / O5)

### Supplier / PurchaseOrder / GRN
- `Supplier`: `id, name, gstin, balance, metal_balance`
- `PurchaseOrder`: `id, supplier_id, status, lines[]`
- `GRN`: `id, po_id, received_at, lines[]` -> creates Items/Lots + LedgerEvents.
- Inbound **Sale or Return (received-in)** tracked as an ownership state, kept separate
  from owned stock.

---

## Customers & schemes

### Customer
`id, branch_id, name, phone, kyc_doc_ref?, loyalty_points, created_at`

### Scheme / SchemeInstallment
```
Scheme: id, customer_id, plan_type, start_date, status, total_paid, accrued_metal_weight
SchemeInstallment: id, scheme_id, due_date, amount, paid_at?, rate_id_at_payment
```
- Redemption uses rate-averaging across installments.

---

## Accounting

### MetalLedger (separate from cash)
`id, branch_id, party_type{customer|supplier|b2b}, party_id, metal_type_id, weight_balance`
- Tracks grams owed/owing, distinct from money balances.

### CashLedger / AR / AP
- Standard money ledgers; COGS computed at actual from lot/item costs.

---

## Staff, attendance, leave & payroll (O7)

Biometric punches follow the same append-only pattern as stock movements: raw punches are
immutable events; attendance/leave/payroll are projections on top.

### Staff & Department
```
Department: id, branch_id, name
Staff: id, branch_id, department_id, code, name, role, doj, dol?,
       status{active|on_leave|exited},
       bank_account_ref?, documents[], salary_structure_id, created_at
```
- Biometric templates are NOT stored here (they remain on the device).

### BiometricDevice
```
id, branch_id, vendor{essl|cpplus|zkteco|zkteco_compatible},
serial_no, lan_ip, port,                       -- e.g. 4370 for pull
comm_mode{push_adms|pull_sdk}, last_seen_at, status
```

### BiometricEnrollment (device user-id -> staff)
`id, device_id, device_user_id, staff_id`
- Resolves a raw punch's device user-id to a staff member.

### PunchEvent (raw, append-only)
```
id, device_id, device_user_id, staff_id?, punched_at,
direction{in|out|unknown}, raw_payload_json, received_via{push|pull},
dedup_key, ingested_at
```
- Immutable; `dedup_key` prevents duplicates from push + pull overlap.
- Modeled as / mirrored into `LedgerEvent` for audit.

### Shift & Roster
```
ShiftDefinition: id, branch_id, name, start_time, end_time, break_minutes,
                 grace_minutes, overtime_after_minutes
RosterAssignment: id, staff_id, date_or_pattern, shift_id, weekly_off_days[]
HolidayCalendar: id, branch_id, date, name
```

### AttendanceDay (projection)
```
id, staff_id, date, shift_id,
first_in?, last_out?,
status{present|absent|half_day|weekly_off|holiday|leave},
late_minutes, overtime_minutes,
source{biometric|manual|regularized}, locked
```
- Derived from PunchEvents + shift; regularizations are approved adjustments (audited).

### Leave
```
LeaveType: id, branch_id, name{casual|sick|earned|...}, accrual_rule, paid{bool}
LeaveBalance: id, staff_id, leave_type_id, period, opening, accrued, used, balance
LeaveRequest: id, staff_id, leave_type_id, from_date, to_date, days,
              status{pending|approved|rejected}, approver_id, decided_at
```

### Salary structure & payroll
```
SalaryStructure: id, name, components[]   -- template assignable to staff
SalaryComponent: id, structure_id, name, kind{earning|deduction},
                 calc{fixed|percent_of_basic|per_day|formula}, value, taxable{bool}
PayrollRun: id, branch_id, period{month}, status{draft|locked|posted},
            run_at, locked_by
Payslip: id, payroll_run_id, staff_id,
         gross, total_deductions, net_pay,
         lop_days, overtime_amount, arrears, components_snapshot_json
StaffAdvance: id, staff_id, amount, issued_at, recovery_schedule, outstanding
StatutoryConfig: id, branch_id, kind{pf|esi|professional_tax|tds}, params_json
```
- `PayrollRun` lock freezes the period; a posted run generates entries in the accounting
  ledgers (salary expense, salary payable, statutory dues).
- StaffAdvance recovery is auto-applied as a deduction during a run.

---

## Notes for implementers

- Use `NUMERIC`/decimal for all weight, carat, purity, and money columns (payroll amounts
  too).
- Index `LedgerEvent (subject_type, subject_id, occurred_at)` for fast projection rebuilds.
- Enforce ownership-state transitions in the backend (state machine), validated inside the
  `FOR UPDATE` transaction (see deployment-and-sync.md double-sale guard).
- Keep read-model projection tables for current balances/states; treat them as caches of
  the ledger.
- **PunchEvent ingestion** must be idempotent (use `dedup_key`); accept both push (ADMS) and
  pull (SDK) without creating duplicates. AttendanceDay is rebuildable from PunchEvents.
- Treat attendance/payroll PII as access-controlled and audited (see security.md).
