-- 0065_cash_tally.sql — non-locking mid-day cash spot-checks / tallies.
-- Records an interim drawer count against a day_session WITHOUT closing it, for
-- quick verification during the day. Many tallies allowed per day.
CREATE TABLE cash_tally (
    id          BIGSERIAL PRIMARY KEY,
    session_id  BIGINT NOT NULL REFERENCES day_session(id) ON DELETE CASCADE,
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_by  BIGINT,
    expected    NUMERIC(14,2) NOT NULL,
    counted     NUMERIC(14,2) NOT NULL,
    variance    NUMERIC(14,2) NOT NULL,
    denoms      JSONB,
    note        TEXT
);
CREATE INDEX cash_tally_session ON cash_tally (session_id);
