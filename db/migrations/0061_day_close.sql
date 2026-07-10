-- 0061_day_close.sql — daily cash day-open / day-close control (Phase 1).
-- One session per branch per business date. Opening float carries forward from the
-- previous day's counted closing. Expected cash is derived from the day's cash
-- movements; counted cash comes from a physical denomination count; the difference
-- is the variance (shortage/excess). Stock day-close (Phase 2) will attach to this
-- same session via a separate stock_count table.
CREATE TABLE day_session (
    id             BIGSERIAL PRIMARY KEY,
    branch_id      BIGINT NOT NULL REFERENCES branch(id),
    business_date  DATE NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','closed','reopened')),
    opening_cash   NUMERIC(14,2) NOT NULL DEFAULT 0,
    expected_cash  NUMERIC(14,2),
    counted_cash   NUMERIC(14,2),
    cash_variance  NUMERIC(14,2),
    opening_denoms JSONB,   -- [{ "denom": 500, "qty": 10 }, ...]
    closing_denoms JSONB,
    notes          TEXT,
    opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_by      BIGINT,
    closed_at      TIMESTAMPTZ,
    closed_by      BIGINT,
    UNIQUE (branch_id, business_date)
);
CREATE INDEX day_session_date ON day_session (branch_id, business_date DESC);
