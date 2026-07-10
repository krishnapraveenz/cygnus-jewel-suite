-- 0064_stock_scan.sql — tag-scan stock day-close (Phase 3) + weekly full-weigh.
-- Records which tagged pieces were physically scanned present; missing = expected
-- in-stock pieces not scanned; extra = a scanned tag not expected on the floor
-- (e.g. sold-but-present) or an unknown barcode. weigh_mode captures a weighed
-- gross per piece for the periodic full-weigh (per-piece weight variance).
ALTER TABLE stock_count ADD COLUMN IF NOT EXISTS weigh_mode BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE stock_count_scan (
    id            BIGSERIAL PRIMARY KEY,
    count_id      BIGINT NOT NULL REFERENCES stock_count(id) ON DELETE CASCADE,
    item_id       BIGINT,                 -- NULL for an unknown barcode
    raw_sku       TEXT,                   -- the scanned code when unresolved
    status        TEXT NOT NULL CHECK (status IN ('present','missing','extra')),
    weighed_gross NUMERIC(12,3),          -- full-weigh: actual weighed grams
    scanned_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_count_scan_count ON stock_count_scan (count_id);
