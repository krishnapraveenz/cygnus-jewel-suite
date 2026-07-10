-- 0012_schemes.sql — gold savings schemes ("11+1"). Customer pays up to 11 monthly
-- installments; the shop adds a bonus (≈1 installment). Collection is capped at 11 months
-- (Companies Act deposit rules). On the 11th installment the scheme auto-matures; the
-- customer then closes/redeems it toward jewellery.

CREATE TABLE scheme (
    id                    BIGSERIAL PRIMARY KEY,
    branch_id             BIGINT NOT NULL REFERENCES branch(id),
    customer_id           BIGINT REFERENCES customer(id),
    scheme_no             TEXT,
    monthly_amount        NUMERIC(14,2) NOT NULL CHECK (monthly_amount > 0),
    -- Hard cap of 11 — the regulatory limit for jeweller gold schemes.
    installments_required INT NOT NULL DEFAULT 11 CHECK (installments_required BETWEEN 1 AND 11),
    bonus_installments    INT NOT NULL DEFAULT 1  CHECK (bonus_installments >= 0),
    start_date            DATE NOT NULL DEFAULT CURRENT_DATE,
    status                TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'matured', 'closed', 'cancelled')),
    total_paid            NUMERIC(14,2) NOT NULL DEFAULT 0,
    maturity_value        NUMERIC(14,2),
    matured_at            TIMESTAMPTZ,
    closed_at             TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheme_installment (
    id           BIGSERIAL PRIMARY KEY,
    scheme_id    BIGINT NOT NULL REFERENCES scheme(id),
    seq          INT NOT NULL,                 -- 1..11
    amount       NUMERIC(14,2) NOT NULL,
    payment_mode TEXT,
    paid_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (scheme_id, seq)
);
