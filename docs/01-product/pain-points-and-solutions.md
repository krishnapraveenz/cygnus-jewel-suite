# Pain Points & Solutions

Researched from current industry sources (2026) and mapped to our design decisions.
Scope here is **retail + wholesale**; manufacturing pain points are noted but deferred.

## Why generic software fails

Generic POS/ERP systems assume a product is a static SKU with a fixed price. In jewellery
almost every assumption is wrong:

- **Price is computed, not stored** — live metal rate x weight x purity + making + wastage
  + stone value + tax, recomputed continuously.
- **Three units at once** — pieces, weight (g/tola/carat), and purity (karat/fineness)
  must link in a single line item; generic systems have "unit-of-measure rigidity".
- **High-value, serialized, often unique items** with metal, karat, gross/net weight,
  multiple stones, and certificate numbers (GIA/IGI/BIS-HUID) on one record.

Bolting a template onto a generic core produces exactly the reported symptoms: rounding
bugs, broken old-gold exchange, GST miscalculation, multi-PC corruption, and crashes
under constant recalculation.

---

## A. Core / cross-cutting

| # | Pain point | Our solution |
|---|---|---|
| 1 | Weight/purity rounding bugs (karat<->fineness, tola/gram/carat, gross/net) | Single fixed-point **valuation engine**; all conversions through one tested library; configurable rounding per metal. |
| 2 | Stale stored prices cause underselling | **Rate service** with effective-dated rates; bills compute at transaction time; rate locked on the invoice. |
| 3 | Rigid making/wastage models | **Rule engine** — per-gram / % / flat / slab / hybrid, scoped by item, scheme, customer tier, metal. |
| 4 | Data corruption on multi-PC, no audit trail | **ACID PostgreSQL** + **append-only event ledger** for every movement. |

## B. Retail

| # | Pain point | Our solution |
|---|---|---|
| 5 | Old-gold exchange buggy/manual | First-class **purchase-back workflow**: purity test -> live valuation -> bill offset -> scrap lot created in stock. |
| 6 | Savings schemes poorly handled | Dedicated **scheme ledger** with installments, maturity, rate-averaged redemption. |
| 7 | HUID/BIS compliance | HUID stored per piece, format-validated, printed; sale blocked where required. (6-digit HUID mandatory in India since 1 Apr 2023.) |
| 8 | GST complexity | **Tax engine**: HSN, CGST/SGST/IGST split, e-invoice/e-Way bill via **direct NIC APIs**. Old gold is a **no-GST value/cash** adjustment (GST only on the full new item). |
| 9 | "Pieces sent to show a customer" get lost | **On-Approval (take-home trial)** ownership state with return-by dates and reminders. |
| 10 | Repairs/custom orders in spreadsheets | Repair & custom-order intake with status tracking. |

## C. Wholesale

| # | Pain point | Our solution |
|---|---|---|
| 11 | Memo vs. consignment confusion; owned vs. lent stock mixed | **Ownership state machine**; clear labels **"Sale or Return"** (B2B) vs **"On Approval"** (B2C); owned vs. out-stock separated for accounting/insurance. |
| 12 | Manual tiered/contract pricing breaks ship dates | **Price-rule engine** by customer/tier/volume/metal. |
| 13 | SKU drift across channels (wholesale / online / marketplaces) | Single stock source of truth; any future channel reads from it. *(Online channels deferred — see E.)* |
| 14 | Loose-stone parcel breaking loses cost/carat accuracy | **Lot model** with weighted-average cost recalculated on each split. |
| 15 | B2B ordering needs live stock + credit control | Desktop **B2B order entry** with real-time stock, credit limits, promised ship dates. *(Self-service web portal deferred — see E.)* |

## D. Hardware & platform

| # | Pain point | Our solution |
|---|---|---|
| 16 | Manual weight entry errors | **Scale integration** (serial/Bluetooth: Ohaus/Mettler) read directly. |
| 17 | Slow stock-takes/lookups | **Barcode/QR/RFID** tagging and scanning. |
| 18 | Single-OS, no offline | **Tauri/Rust** desktop (Win/Linux/macOS) + **local cache + LAN-first server** so billing survives internet outages. |
| 19 | Multi-PC in one shop corrupts shared files | **Central LAN server** (PostgreSQL + API); terminals are clients, never touch the DB file directly; row-locks prevent double-sale. See deployment-and-sync.md. |
| 20 | Manual attendance registers; buddy-punching; payroll disputes | **Direct LAN biometric integration** (eSSL/CP Plus/ZKTeco): punches captured automatically as immutable events, fed into attendance and payroll. |
| 21 | Salary errors from manual attendance-to-pay calculation | **Payroll computed from processed attendance** + salary structure; advances auto-recovered; posts to accounting; payslips/registers generated. |

## E. Deferred (documented, not built yet)

**Web & mobile surfaces** (removing these keeps the current build LAN/desktop-only with no
public internet surface):
- Web B2B self-service portal (retailers order online).
- E-commerce storefront + online/marketplace channel sync.
- Mobile sales-rep app (field order capture).

**Manufacturing:**
- Invisible metal leakage across stages; stage-by-stage weigh-in/weigh-out.
- Stone allocation to setters (issued -> set/returned/broken).
- Non-linear (looping) production routing.
- Karigar/piece-rate payroll.
- Finished-goods costing at actual vs. theoretical.

These are intentionally out of the current build; see vision-and-scope.md for the seams
we leave in place.
