# Open Decisions & Gaps

Living checklist of decisions and the artifacts we still need. Update as items are resolved.
Nothing here blocks Phase 0 (scaffold); they are needed before the relevant later phase.

---

## Resolved decisions

| # | Decision | Resolution |
|---|---|---|
| D1 | Primary market | **India first.** GST, HUID/BIS, PF/ESI/PT/TDS are first-class. Other geographies are later. |
| D2 | Gold rate basis | **Per gram, per karat, set manually** — a separate rate per (metal, purity). Rates are entered independently per purity; the system does **not** derive one purity from another. (Confirmed against market: 26 Jun 2026 national avg 24K ₹14,275/g, 22K ₹13,085/g, 18K ₹10,706/g.) |
| D3 | Fine gold | Priced by **fineness grade** (999.9, 995, …), per gram, manual rate each. |
| D4 | Silver | Priced **per purity** (999, 925, …), per gram, manual rate. (Note: silver ~₹240/g pure as of 26 Jun 2026, so 925 ≈ ₹222/g — set the live number daily.) |
| D5 | Stones | **Multi-unit pricing:** per **carat** (diamonds/most stones; 1 ct = 0.2 g), per **gram** (some coloured/semi-precious), per **piece** (melee/fixed). Optional **ratti** (~0.911 ct ≈ 0.182 g). |
| D6 | Deferred scope | Web B2B portal, e-commerce, mobile, staff self-service, manufacturing — see vision-and-scope.md. |
| D7 | Rounding & precision | Weights/carat/ratti **3 dp**; pieces & purity **0 dp**; rate **2 dp**; money components & tax **2 dp**; grand total **nearest ₹1** with explicit `round_off`; **half-up** default. Target-total residual absorbed into making so printed total == target exactly. (valuation-engine-spec.md) |
| D8 | Old-gold-exchange GST | **No GST/RCM** on old gold bought from an individual (Sec 9(4) not applicable). GST **3% on the FULL new item value**; old gold **reduces amount payable (post-GST), not taxable value**. Margin scheme (Rule 32(5)) only if reselling as-is — separate config. (verified; valuation-engine-spec.md) |
| D9 | Invoice numbering | GST Rule 46: consecutive & unique within FY, ≤16 chars, **multiple series allowed** → per-terminal/branch `series_code` with reserved gapless ranges (offline + multi-counter safe). (data-model-erd.md) |
| D10 | Returns / cancellation | Issue a **GST credit note** (Sec 34), reported in GSTR-1 by **30 Nov** of next FY; original invoice immutable; **reversal LedgerEvents** restore stock/ownership and money/metal ledgers. (data-model-erd.md) |
| D11 | e-invoice / e-Way bill | **Direct connection to NIC** — e-invoice via the IRP API (returns IRN + QR) and e-Way bill via the NIC API. **No GSP middleman.** Implemented behind an `E2` interface; sandbox first. *Caveat: NIC direct API access has enrolment/eligibility requirements (historically turnover-linked) — confirm the shop qualifies for direct access; otherwise the same interface can fall back to a GSP later.* |

See [../02-architecture/valuation-engine-spec.md](../02-architecture/valuation-engine-spec.md)
for the formulas and worked examples.

---

## Decisions still to confirm

| # | Decision | Default if unanswered |
|---|---|---|
| Q2 | Invoice / tag / SKU numbering scheme | Branch-prefixed sequential; confirm with the business. |
| Q3 | Single shop vs multi-branch on day one | Build single-shop LAN first; cloud sync when a 2nd branch is real. |
| Q4 | Test hardware availability (scale, ZKTeco/eSSL device) | Build against simulators until devices are on hand. |
| Q5 | Tola support needed at launch? | Support grams + carat first; tola configurable (1 tola = 11.6638 g). |

---

## Artifacts still to produce (by phase)

### Before / during Phase 1 (foundation & core)
- [ ] **Physical schema + migrations** — turn the logical ERD into real SQL (with the
      per-(metal,purity) rate table and the Stone `pricing_unit` field).
- [ ] **API contract (OpenAPI)** between desktop and backend.
- [ ] **Golden test cases with real numbers** — a sheet of `inputs -> exact bill` agreed
      with a real jeweller. *Highest-priority correctness artifact.* Seed it from the
      worked examples in the valuation spec.
- [ ] **Seed data** — metals, purities (24K/22K/18K/14K, fine 999.9/995, silver 999/925),
      HSN codes, GST rates, units (gram/carat/piece/ratti/tola).

### Before retail go-live (Phase 2)
- *Design rules now settled (see D7 rounding, D8 old-gold GST, D9 invoice numbering,
  D10 returns/credit notes) — these still need implementation in this phase.*
- [ ] **Invoice print format** — GST-compliant + BIS/HUID fields, jeweller layout.
- [ ] **Tag/label format** — barcode/QR + HUID + weight/purity.
- [ ] **Direct NIC e-invoice + e-Way bill integration** (D11) — IRP API for IRN/QR + NIC
      e-Way bill; sandbox first; confirm direct-access eligibility.
- [ ] **Returns / credit-note flow** — implement Sec-34 credit notes + reversal ledger
      events (rule decided in D10).

### Before wholesale/back-office (Phase 3)
- [ ] **Statutory configs** — PF/ESI/PT/TDS parameters and report formats.
- [ ] **Biometric device onboarding notes** — per-model push (ADMS) vs pull (SDK);
      confirm CP Plus model compatibility.

### Cross-cutting (start early)
- [ ] **Repository license** chosen.
- [ ] **Data-retention & privacy policy** — customer KYC + biometric/payroll PII
      (what is stored, for how long, who can access). See security.md.
- [ ] **Data migration plan** — importing from any existing software the shop uses.
- [ ] **Backup/restore runbook** — tested restore before go-live (see deployment-and-sync.md).

---

## Notes
- Prices shown anywhere in the docs are **illustrative** and were sanity-checked on
  26 Jun 2026; live rates are always entered manually (or via feed) at the shop.
