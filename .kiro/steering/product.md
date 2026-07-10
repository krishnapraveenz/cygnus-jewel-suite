# Product — Cygnus Jewel Suite

A cross-platform **jewellery sales & management ERP** for the Indian market (retail +
wholesale), for gold/silver/platinum/diamond/precious-stone businesses. It is a Tauri 2
desktop app, **not a POS** — the UI is a dense, professional jewellery ERP.

## Two non-negotiable design rules
1. **Fixed-point decimal math** for every weight and money value — never floating point.
2. **Append-only event ledger** (`ledger_event`) is the source of truth — every gram,
   stone, and rupee movement is an immutable event.

## Domain rules (must hold)
- **Weights**: track gross / stone / net. `net = gross − stone weight`. **Fine (pure)
  content** = net × purity fineness ÷ 1000.
- **Old jewellery intake** (metal-agnostic: gold / silver / platinum / diamond ornaments): the
  physical **gross** enters stock; a deduction% only reduces the amount **paid**, not the recorded
  weight. Track fine content. **Gold/Platinum**: value net (gross − stone wt) × buy-rate. **Silver**:
  by **touch %** (value = gross × touch% × pure-silver rate). **Diamond ornaments**: value metal on
  net only (never on stone weight); itemise each diamond and either return it or **buy it back** at a
  flat % of assessed value (e.g. 70/80) or a manual value — bought stones enter loose-stone stock at
  that price. No GST on the old item — it only reduces amount payable; the new item is taxed on full
  value. (Schema stays `old_gold_lot`/`old_gold_stone`; `department_id` groups by type.)
- **Touch billing (wholesale)**: a quoted **touch %** bundles purity + wastage + making.
  `chargeable fine = net × touch% ÷ 100`; `amount = chargeable fine × pure(999) rate`.
  Touch may exceed 100 for high-labour pieces. Available on sales (Normal/Touch toggle)
  and purchases.
- **Rate cutting / unfixed metal**: unfixed purchases owe **fine grams** (metal account);
  rate cutting later converts grams → money at a chosen bullion rate. (Stage 2, planned.)
- **GST**: gold/silver 3%, diamonds/stones 0.25%; CGST+SGST intra-state, IGST inter-state
  (decided by party state vs seller state). B2B purchases claim input tax credit (item
  cost stored ex-GST); local/unregistered purchases are GST-free unless RCM is toggled.
- **Ledgers** (call them in English, never "khata"): **supplier/party account** = money
  (`amount_delta`); **metal account** = fine grams (`weight_delta`). The party ledger is
  **debtor-positive**: `+` = party owes us, `−` = we owe the party. A purchase posts
  `−grand_total`; a payment posts `+amount`.

## Working style
- For big/complex modules, present research + design BEFORE building, then build on
  approval. Keep the dense-ERP UX; reuse the existing valuation engine rather than forking
  new pricing paths.
