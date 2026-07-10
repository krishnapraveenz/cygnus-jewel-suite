-- 0026_smith_jobwork.sql — Smith (goldsmith) job-work: melt scrap → fine, issue metal to a
-- smith, receive a finished ornament into stock, settle making (+wastage), full metal account.

CREATE TABLE smith (
    id             BIGSERIAL PRIMARY KEY,
    branch_id      BIGINT NOT NULL REFERENCES branch(id),
    name           TEXT   NOT NULL,
    phone          TEXT,
    gstin          TEXT,
    gst_registered BOOLEAN NOT NULL DEFAULT false,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A melting batch: scrap lots → recovered fine gold + melt loss.
CREATE TABLE melt_batch (
    id             BIGSERIAL PRIMARY KEY,
    branch_id      BIGINT NOT NULL REFERENCES branch(id),
    metal_type_id  BIGINT NOT NULL REFERENCES metal_type(id),
    gross_weight   NUMERIC(12,3) NOT NULL,   -- total scrap melted (gross)
    fine_recovered NUMERIC(12,3) NOT NULL,   -- pure metal recovered
    loss_weight    NUMERIC(12,3) NOT NULL,   -- melt loss
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE melt_batch_lot (
    melt_batch_id   BIGINT NOT NULL REFERENCES melt_batch(id),
    old_gold_lot_id BIGINT NOT NULL REFERENCES old_gold_lot(id)
);

-- A job: issue metal to a smith, then receive a finished ornament.
CREATE TABLE smith_job (
    id                      BIGSERIAL PRIMARY KEY,
    branch_id               BIGINT NOT NULL REFERENCES branch(id),
    smith_id                BIGINT NOT NULL REFERENCES smith(id),
    metal_type_id           BIGINT NOT NULL REFERENCES metal_type(id),
    source                  TEXT NOT NULL CHECK (source IN ('scrap', 'refined')),
    issued_fine_weight      NUMERIC(12,3) NOT NULL,
    issued_gross_weight     NUMERIC(12,3),
    wastage_percent_allowed NUMERIC(5,2) NOT NULL DEFAULT 0,
    making_per_gram         NUMERIC(14,2),
    making_per_piece        NUMERIC(14,2),
    status                  TEXT NOT NULL DEFAULT 'issued'
                              CHECK (status IN ('issued', 'received', 'settled', 'cancelled')),
    item_id                 BIGINT REFERENCES item(id),
    received_gross          NUMERIC(12,3),
    received_net            NUMERIC(12,3),
    received_fine           NUMERIC(12,3),
    pieces                  INT,
    wastage_weight          NUMERIC(12,3),
    making_charge           NUMERIC(14,2),
    making_gst              NUMERIC(14,2),
    rcm                     BOOLEAN NOT NULL DEFAULT false,
    issued_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_at             TIMESTAMPTZ,
    settled_at              TIMESTAMPTZ
);
CREATE TABLE smith_job_lot (
    smith_job_id    BIGINT NOT NULL REFERENCES smith_job(id),
    old_gold_lot_id BIGINT NOT NULL REFERENCES old_gold_lot(id)
);
CREATE INDEX smith_job_smith ON smith_job (smith_id, status);

-- Extend old-gold lot lifecycle for melting / issuing to a smith.
ALTER TABLE old_gold_lot DROP CONSTRAINT IF EXISTS old_gold_lot_status_check;
ALTER TABLE old_gold_lot ADD CONSTRAINT old_gold_lot_status_check
    CHECK (status IN ('in_scrap', 'refined', 'sold', 'returned', 'melted', 'issued', 'consumed'));
