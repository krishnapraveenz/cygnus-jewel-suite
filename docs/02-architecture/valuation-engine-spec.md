# Valuation Engine Spec

The single source of truth for how every price is computed. Implemented once in the Rust
`core-engine` crate and reused by the desktop app and backend, so the counter and the
server always agree.

**Rule zero:** all arithmetic uses fixed-point decimal (`rust_decimal`). Floating point is
banned for weight, carat, purity, and money.

---

## Inputs

| Input | Source |
|---|---|
| Live metal rate (buy/sell) per metal + purity | MetalRate (effective-dated) |
| Item: gross/net/stone weight, purity | Item record |
| Making rule, wastage rule | PriceRule |
| Stone values | Stone / ItemStone |
| Tax config (HSN, GST rates, inter/intra-state) | Tax engine |
| Customer tier (wholesale) | B2BCustomer |

## Output: PriceBreakdown

```
PriceBreakdown {
  metal_value,
  making_charge,
  wastage_charge,
  stone_value,
  taxable_value,        // sum of the above (less exempt parts)
  cgst, sgst, igst,
  round_off,
  grand_total,
  rate_id_used,         // for reproducibility
  components_detail[]   // line-by-line for display + audit
}
```

On document finalize, the whole breakdown is **snapshotted** onto the invoice line.

---

## Rate model (India default)

Primary market is India, so the **default rate basis is "per gram, per karat/purity, set
manually"** — the way Indian jewellers actually quote.

- A rate is stored per **(metal, purity)** and entered **independently** — the engine
  **never derives one purity's rate from another**. (Example confirmed in the market on
  26 Jun 2026: a shop may set 22K = ₹13,240/g and 18K = ₹10,750/g, which is *not* exactly
  18/22 of the 22K rate.)
- **Gold** purities: 24K, 22K, 18K, 14K, … each its own per-gram rate.
- **Fine gold**: by **fineness grade** (999.9, 995, …), each its own per-gram rate.
- **Silver**: by purity (999, 925, …), each its own per-gram rate. (As of 26 Jun 2026 pure
  silver ≈ ₹240/g, so 925 ≈ ₹222/g — set the live figure daily.)
- For this default basis, **metal_value = per_gram_rate(metal, purity) × net_weight**
  (the rate already encodes the purity, so no separate fineness multiplication).

An alternative basis — rate quoted per gram of *pure* metal, then fineness-adjusted — is
also supported for shops/old-gold that work that way; the basis is stored on the rate (see
below).

### Stone pricing (multi-unit)
Each stone carries a **pricing unit** and a rate in that unit:

| Unit | Used for | Conversion |
|---|---|---|
| **per carat** | diamonds, most precious stones | 1 ct = 0.2 g (so 0.020 ct = 0.004 g) |
| **per gram** | some coloured / semi-precious stones | base unit |
| **per piece** | melee / fixed-price stones | n/a (count × price) |
| **per ratti** (optional) | traditional Indian | 1 ratti ≈ 0.911 ct ≈ 0.182 g |

`stone_value = rate_in_unit × quantity_in_unit` (carat, gram, ratti) or `price × pieces`.

---

## Conversions (exact)

- **Karat <-> fineness:** `fineness = karat / 24 * 1000` (store both; compute via decimal).
- **Units:** every unit has an exact `to_base_factor`. Base unit for metal = gram.
  - `1 tola = 11.6638 g` (configurable, stored exactly).
  - `1 carat = 0.2 g` (stones measured in carat).
  - `1 ratti ≈ 0.182 g (≈ 0.911 ct)` (optional traditional unit; value configurable).
- **India default (per-gram-per-karat):** `metal_value = per_gram_rate(metal, purity) × net_weight`.
- **Pure-metal basis (alternative):** `net_fine_weight = net_weight × (purity_fineness / 1000)`
  then `metal_value = pure_rate × net_fine_weight`. Used when the rate is quoted per gram of
  pure metal (and for old-gold valuation). The basis is stored on the rate.

---

## Core formula (retail piece)

```
metal_value   = rate(metal, purity, basis) * weight_for_basis   # India default: per-gram-per-karat * net_weight
making_charge = evaluate(making_rule, net_weight, metal_value)
wastage_charge= evaluate(wastage_rule, net_weight, metal_value)
stone_value   = sum(stone_i.value)            # per-carat / per-gram / per-piece / per-ratti
discount      = evaluate(discount, ...)       # e.g. on making; applied BEFORE tax
taxable_value = metal_value + making_charge + wastage_charge + stone_value - discount
taxes         = tax_engine(taxable_value, hsn, place_of_supply)
grand_total   = round(taxable_value + taxes, money_rounding_rule)
```

**Discount is always applied before GST** (it reduces the taxable value); GST is then
computed on the discounted value. Never subtract a discount from a GST-inclusive total —
that over-collects tax and breaks GST-return reconciliation.

### Rate override at billing
Rule: **rate = master default, overridable per line, snapshotted and audited.**
- Each bill line **pre-fills** the metal rate (by metal + purity) and stone rate from the
  rate master (F4). Normal bills use the default unchanged.
- The cashier may **type a different rate directly on the line** — no need to open the rate
  editor. The bill recomputes instantly.
- The override applies **to this bill only**; it does **not** change the master rate.
- The line **snapshots the rate actually used** and records `was_override`, the
  `master_rate_id` it was based on, and who did it (audit / loss-prevention).
- **Optional guard:** if the typed rate deviates beyond a configured % from the master,
  require manager approval (RBAC). See ../02-architecture/security.md.

### Making / wastage rule evaluation
`charge_kind` determines the math:
- `per_gram`  -> `value_per_gram * net_weight`
- `percent`   -> `metal_value * percent / 100`
- `flat`      -> `flat_amount`
- `slab`      -> pick the slab matching weight/value, then apply its kind

Rules are scoped (global/category/item/customer-tier/customer/metal); most specific wins.

---

## Worked examples (India, illustrative)

Rates are illustrative (sanity-checked 26 Jun 2026); live rates are set manually.

**A. Gold ring, 22K, net 8.000 g, making ₹600/g, no stone, GST 3%**
```
metal_value   = 13,240 * 8.000            = 1,05,920.00
making_charge = 600 * 8.000               =     4,800.00
stone_value                               =         0.00
taxable_value                             = 1,10,720.00
GST 3% (1.5% CGST + 1.5% SGST)            =     3,321.60
grand_total (round to ₹)                  = 1,14,042.00
```

**B. 18K diamond pendant, net gold 3.500 g @ ₹10,750/g, making 12%, 1 diamond 0.30 ct @ ₹90,000/ct, GST 3%**
```
metal_value   = 10,750 * 3.500            =    37,625.00
making_charge = 37,625 * 12% (percent)    =     4,515.00
stone_value   = 90,000 * 0.30 (per carat) =    27,000.00
taxable_value                             =    69,140.00
GST 3%                                    =     2,074.20
grand_total                               =    71,214.00   (after round-off)
```

**C. Silver article, 925, net 60.000 g @ ₹222/g, making ₹15/g, GST 3%**
```
metal_value   = 222 * 60.000              =    13,320.00
making_charge = 15 * 60.000               =       900.00
taxable_value                             =    14,220.00
GST 3%                                    =       426.60
grand_total                               =    14,647.00   (after round-off)
```

**D. Old gold exchange (purchase-back) against bill A**
```
old gross 10.000 g, tested purity 916 (22K) -> net_fine = 10.000 * 916/1000 = 9.160 g
exchange_value = buy_rate * 9.160   (buy_rate per gram pure; e.g. 13,000)  = 1,19,080.00
new item (bill A): taxable 1,10,720 + GST 3% 3,321.60 = grand_total 1,14,042 (full-value GST)
amount_payable = 1,14,042 - 1,19,080 = -5,038  -> ₹5,038 paid OUT to customer
scrap lot created: 9.160 g fine gold.   GST is on the FULL new value; old gold only
adjusts the amount payable (see "Old gold exchange" section). No GST/RCM on the old gold.
```

**E. Gold bangle, 22K, gross 16.000 g incl. stone, stone 2.000 g @ ₹450/g, making 10%, making-discount ₹1,000, GST 3%**
```
gross_weight   = 16.000 g
stone_weight   =  2.000 g        # if stone is in carat: weight_g = carat * 0.2, then subtract
net_metal_wt   = 16.000 - 2.000  = 14.000 g
metal_value    = 14.000 * 13,085 = 1,83,190.00
making 10%     = 18,319.00
stone_value    = 2.000 * 450     =      900.00
discount (mk)  =                 -   1,000.00     # BEFORE tax
taxable_value  = 183190 + 18319 + 900 - 1000 = 2,01,409.00
GST 3%         =                     6,042.27
grand_total    =                  2,07,451.27 -> 2,07,451 (round)
```
Note: when the stone is entered in **carat**, the backend converts only the *weight*
(carat × 0.2) to subtract from gross; the stone is still *priced* in its own unit (per carat).

---

## Target-total adjustment (reverse round-off)

The jeweller can type a **target grand total** (a negotiated round figure); the engine
back-solves so the bill lands exactly on it, absorbing the difference into the **adjustable
component (making charge / piece rate)** and **recomputing GST** on the new base. Plain
round-off (to nearest ₹1/₹100/₹500) is the same feature with the target auto-set.

```
fixed          = metal_value + stone_value (+ fixed wastage)   # cannot change
target_taxable = target_grand_total / (1 + gst_rate)
new_making     = target_taxable - fixed
new_gst        = target_taxable * gst_rate
grand_total    = target_taxable + new_gst   == target_grand_total
```

**F. Target-total on example E — agree ₹2,05,000**
```
fixed          = 1,83,190 (gold) + 900 (stone) = 1,84,090.00
target_taxable = 2,05,000 / 1.03               = 1,99,029.13
new_making     = 1,99,029.13 - 1,84,090        =    14,939.13   (was 17,319 -> -2,379.87)
new_gst 3%     = 1,99,029.13 * 0.03            =     5,970.87   (was 6,042.27 -> -71.40)
grand_total    = 1,99,029.13 + 5,970.87        = 2,05,000.00 ✓
```
The ₹2,451.27 reduction splits automatically: ₹2,379.87 off making + ₹71.40 off GST.

**Guard rails:**
- `new_making >= 0` (and optionally >= a making/cost floor) — else **block** with the
  minimum achievable total. Never adjust metal or stone value to hit a target.
- GST is always recomputed on the new taxable value (never subtracted from a GST-inclusive
  total).
- RBAC-gated and audited (it is a discount); record target, resulting making, and user.
- Single-rate assumption (gold jewellery = composite supply @ 3%). If a bill mixes GST
  rates, distribute the adjustment across the taxable base per rate.

Examples A–F are the seed **golden test cases** (see open-decisions.md): each is an
`inputs -> exact breakdown` assertion the engine must reproduce on every machine.

---

## Old gold exchange (purchase-back)

```
1. gross_weight        := weighed on scale
2. tested_purity       := measured (manual/XRF later)
3. net_fine_weight     := gross_weight * (tested_purity / 1000)   [less stone/impurity allow.]
4. exchange_value      := buy_rate(metal) * net_fine_weight
5. create scrap Lot(weight = net_fine_weight, avg_cost from exchange_value)
6. SETTLEMENT (see GST rule below):
      new_item_taxable + GST(3% on full new value) = new_item_total
      amount_payable = new_item_total - exchange_value
```

### GST rule (India — verified)
- **Old gold received from an individual (unregistered consumer): no GST, and no reverse
  charge** for the jeweller. The individual's sale is not in furtherance of business, so
  Sec. 9(4) RCM does **not** apply (Revenue Dept clarification, 2017).
- **GST is charged at 3% on the FULL value of the new jewellery** sold. The old-gold
  exchange value does **not** reduce the taxable value — it is **part-payment that reduces
  the amount payable**, applied **after** GST.
- So on the bill: compute the new item's taxable value + GST normally; then show
  **"Less: old gold exchange"** as a deduction from the amount payable (not from taxable
  value). If exchange value exceeds the new purchase, the balance is paid out to the
  customer.
- *(Margin scheme under Rule 32(5) — GST on margin only — applies only if the jeweller
  resells the old piece **as-is** without changing its nature; it does not apply to the
  normal melt-and-remake exchange. Treat as a separate, configurable case.)*

Centralizing steps 3–4 and the settlement in the engine removes the classic incumbent bugs
(wrong net weight, and the common error of netting old gold out of the **taxable** value).

---

## Tax engine

```
place_of_supply == seller_state ? (CGST + SGST) : IGST
each component may have its own HSN / rate (metal vs making vs stones can differ)
e-invoice (IRN) + e-Way bill generated via **direct NIC APIs** (IRP for e-invoice, NIC e-Way bill) after finalize (Tax & Compliance engine, E2)
```

---

## Wholesale pricing

- Same engine; `metal_value`/`making` may be overridden by a **trade PriceRule** scoped to
  the customer/tier/volume.
- **B2B Sales Invoice** uses the full breakdown + GST + e-Way bill.
- **Sale or Return** computes an *indicative* value for the delivery note but recognizes no
  revenue until a line is invoiced.

---

## Rounding & precision policy

All arithmetic uses fixed-point decimal (`rust_decimal`); no floats. Precision is fixed (not
left to chance) so every machine produces identical results.

### Precision by field
| Field | Decimals | Notes |
|---|---|---|
| Metal weight (grams) | **3** | gross / net / stone-in-grams (mg precision). |
| Stone weight (carat) | **3** | e.g., 0.020 ct. |
| Ratti (if used) | **3** | |
| Pieces | **0** | integer count. |
| Purity / fineness | **0** | parts per 1000 (916, 750, 999). |
| Rate (₹/g, ₹/ct, ₹/piece) | **2** | |
| Money — every component & tax (metal, making, wastage, stone, discount, taxable, CGST/SGST/IGST, line total) | **2** | rounded to 2 dp at each component. |
| Invoice grand total | **0** (nearest ₹1) | with an explicit `round_off` line; configurable (some shops keep 2 dp). |

### Rounding mode
- **Money: half-up** (round half away from zero) — the common Indian billing convention.
- Mode is configurable per document, but the **default is half-up** and must be applied
  consistently by the single engine.

### Order of operations (deterministic)
1. Compute each money component, **round to 2 dp**.
2. `taxable_value = sum(components) − discount` (already 2 dp).
3. `gst = round(taxable_value × rate, 2 dp)` (split into CGST/SGST or IGST, each 2 dp).
4. `pre_round_total = taxable_value + gst`.
5. `grand_total = round(pre_round_total, nearest ₹1)`; `round_off = grand_total −
   pre_round_total` (shown explicitly, can be ±).

### Target-total residual
When a target grand total is set (reverse round-off):
- Compute `new_making` to 2 dp; recompute GST; the unavoidable ≤ ₹0.01 rounding residual is
  **absorbed into `new_making`** (or the `round_off` line) so the **printed grand total
  equals the target exactly**. The procedure is fixed so all terminals agree to the paisa.

---

## Determinism & testing

- Given the same inputs + rate id, the engine MUST produce the same output on any machine.
- Golden-file tests: the worked examples A–F plus edge cases (tiny weights, high rates,
  multi-stone, old-gold exchange, slab boundaries, target-total residual).
- Property tests: components sum to taxable_value; GST recomputed on discounted base;
  target-total output equals the target exactly; new_making never negative.

This determinism is what lets the desktop preview and the server commit agree to the paisa.
