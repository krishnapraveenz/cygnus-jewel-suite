-- 0063_stock_count.sql — stock day-close (Phase 2). Attaches to a day_session.
-- Method 'category': book aggregates per Metal → Purity/Karat → Category bucket
-- (Nos / Gross / Diamond CT / Stone / Net), captured as a snapshot alongside the
-- physically counted figures so the variance is historical and auditable.
CREATE TABLE stock_count (
    id          BIGSERIAL PRIMARY KEY,
    session_id  BIGINT NOT NULL UNIQUE REFERENCES day_session(id) ON DELETE CASCADE,
    method      TEXT NOT NULL DEFAULT 'category',
    status      TEXT NOT NULL DEFAULT 'counted' CHECK (status IN ('open','counted')),
    notes       TEXT,
    counted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    counted_by  BIGINT
);

CREATE TABLE stock_count_line (
    id             BIGSERIAL PRIMARY KEY,
    count_id       BIGINT NOT NULL REFERENCES stock_count(id) ON DELETE CASCADE,
    bucket_kind    TEXT NOT NULL DEFAULT 'metal',
    bucket_key     TEXT NOT NULL,        -- stable key: kind|metal|purity|category
    group_label    TEXT NOT NULL,        -- e.g. "Gold 22K"
    category_label TEXT NOT NULL,        -- e.g. "Necklace" / "Uncategorised"
    metal_type_id  BIGINT,
    purity_id      BIGINT,
    category_id    BIGINT,
    -- book snapshot (on-floor, ownership_state='in_stock')
    book_nos       INT NOT NULL DEFAULT 0,
    book_gross     NUMERIC(14,3) NOT NULL DEFAULT 0,
    book_ct        NUMERIC(14,3) NOT NULL DEFAULT 0,
    book_stone     NUMERIC(14,3) NOT NULL DEFAULT 0,
    book_net       NUMERIC(14,3) NOT NULL DEFAULT 0,
    -- owned but off-floor (approval / sale-or-return out) — reconciling column
    out_nos        INT NOT NULL DEFAULT 0,
    out_gross      NUMERIC(14,3) NOT NULL DEFAULT 0,
    -- physically counted (NULL until entered)
    phys_nos       INT,
    phys_gross     NUMERIC(14,3),
    phys_ct        NUMERIC(14,3),
    phys_stone     NUMERIC(14,3),
    phys_net       NUMERIC(14,3)
);
CREATE INDEX stock_count_line_count ON stock_count_line (count_id);
