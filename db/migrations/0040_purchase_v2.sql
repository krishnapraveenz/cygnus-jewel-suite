-- 0040_purchase_v2.sql — Purchase Bill v2 (Stage 1).
-- Adds: unified-party supplier, local/B2B bill kinds, GST/ITC, per-line pricing modes
-- (fixed_cost | weight_rate | touch), fine-weight tracking, per-line stones, and a
-- purchase_payment table for settlement. Posts to the party ledger (debtor-positive:
-- a purchase credits the supplier, i.e. amount_delta is NEGATIVE = we owe them).

-- ---- purchase_bill: link to unified party + totals breakdown ----
ALTER TABLE purchase_bill ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS party_id      BIGINT REFERENCES party(id);
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS bill_kind     TEXT NOT NULL DEFAULT 'b2b'
                            CHECK (bill_kind IN ('local','b2b'));
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS rcm           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS rate_basis    TEXT NOT NULL DEFAULT 'fixed'
                            CHECK (rate_basis IN ('fixed','unfixed'));
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS inter_state   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS subtotal      NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS making_total  NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS stone_total   NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS tax_total     NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS round_off     NUMERIC(8,2)  NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS total_fine    NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS paid_total    NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'posted';

-- ---- purchase_bill_line: full valuation breakdown ----
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS pricing_mode    TEXT NOT NULL DEFAULT 'fixed_cost'
                            CHECK (pricing_mode IN ('fixed_cost','weight_rate','touch'));
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS metal_type_id   BIGINT REFERENCES metal_type(id);
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS purity_id       BIGINT REFERENCES purity(id);
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS gross_weight    NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS net_weight      NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS stone_weight    NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS touch_percent   NUMERIC(7,3);
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS pure_rate       NUMERIC(12,2);
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS rate            NUMERIC(12,2);
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS making_per_gram NUMERIC(12,2);
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS making_amount   NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS chargeable_fine NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS stone_value     NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS hsn             TEXT;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS taxable_value   NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS gst_rate        NUMERIC(5,2)  NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS tax_amount      NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS line_total      NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS stone_json      JSONB;

-- ---- settlement payments against a purchase bill ----
CREATE TABLE IF NOT EXISTS purchase_payment (
    id               BIGSERIAL PRIMARY KEY,
    purchase_bill_id BIGINT NOT NULL REFERENCES purchase_bill(id),
    mode             TEXT NOT NULL CHECK (mode IN ('cash','bank','cheque')),
    amount           NUMERIC(14,2) NOT NULL,
    reference        TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_payment_bill ON purchase_payment (purchase_bill_id);
