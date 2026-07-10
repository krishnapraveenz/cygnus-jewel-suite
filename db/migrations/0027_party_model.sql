-- 0027_party_model.sql — unified Party (Option C): one real-world entity, many roles,
-- extension tables for addresses & commercial terms, and full KYC + GST fields so invoices
-- are e-invoice / e-way-bill ready. Existing customer/supplier/smith rows are back-filled
-- into party and linked (old tables kept intact so existing code keeps working).

CREATE TABLE party (
    id                    BIGSERIAL PRIMARY KEY,
    branch_id             BIGINT REFERENCES branch(id),
    display_name          TEXT NOT NULL,                 -- common/working name
    legal_name            TEXT,                          -- registered legal name (GST docs)
    party_kind            TEXT NOT NULL DEFAULT 'individual'
                            CHECK (party_kind IN ('individual', 'business')),
    phone                 TEXT,
    email                 TEXT,
    -- Tax identity
    pan                   TEXT,
    gstin                 TEXT,                           -- 15-char; null for retail/unregistered
    gst_registration_type TEXT NOT NULL DEFAULT 'unregistered'
                            CHECK (gst_registration_type IN
                              ('regular', 'composition', 'unregistered', 'consumer', 'sez', 'overseas')),
    -- Primary address (e-invoice / e-way bill need pincode + 2-digit GST state code)
    address_line1         TEXT,
    address_line2         TEXT,
    city                  TEXT,
    pincode               TEXT,
    state_code            TEXT,                           -- GST 2-digit code, e.g. '27' = Maharashtra
    -- KYC / PMLA
    cdd_risk_tier         TEXT NOT NULL DEFAULT 'low'
                            CHECK (cdd_risk_tier IN ('low', 'medium', 'high')),
    kyc_verified_at       TIMESTAMPTZ,
    notes                 TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX party_phone_idx ON party (phone);
CREATE INDEX party_gstin_idx ON party (gstin);

-- A party can play several roles simultaneously (a wholesale buyer who also supplies scrap).
CREATE TABLE party_role (
    party_id BIGINT NOT NULL REFERENCES party(id),
    role     TEXT   NOT NULL
               CHECK (role IN ('customer', 'wholesale', 'supplier', 'smith', 'broker', 'consignee')),
    PRIMARY KEY (party_id, role)
);

-- Extra bill-to / ship-to addresses (e-way bill dispatch/ship locations).
CREATE TABLE party_address (
    id            BIGSERIAL PRIMARY KEY,
    party_id      BIGINT NOT NULL REFERENCES party(id),
    label         TEXT,                                   -- 'billing' | 'shipping' | custom
    address_line1 TEXT,
    address_line2 TEXT,
    city          TEXT,
    pincode       TEXT,
    state_code    TEXT,
    is_default    BOOLEAN NOT NULL DEFAULT false
);

-- Commercial terms (mainly wholesale/B2B).
CREATE TABLE party_terms (
    party_id               BIGINT PRIMARY KEY REFERENCES party(id),
    price_tier             TEXT NOT NULL DEFAULT 'retail',  -- 'retail' | 'wholesale' | 'vip'
    credit_limit           NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit_days            INT NOT NULL DEFAULT 0,
    default_making_percent NUMERIC(6,2),
    opening_cash_balance   NUMERIC(14,2) NOT NULL DEFAULT 0,
    opening_metal_balance  NUMERIC(12,3) NOT NULL DEFAULT 0  -- fine grams (debtor +)
);

-- Link columns on the legacy masters (kept so existing FKs/queries keep working).
ALTER TABLE customer ADD COLUMN IF NOT EXISTS party_id BIGINT REFERENCES party(id);
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS party_id BIGINT REFERENCES party(id);
ALTER TABLE smith    ADD COLUMN IF NOT EXISTS party_id BIGINT REFERENCES party(id);

-- ---- Back-fill existing entities into party + role + link ----

-- Customers → party (role 'customer'). PAN carried over.
INSERT INTO party (branch_id, display_name, party_kind, phone, pan, gst_registration_type)
SELECT c.branch_id, c.name, 'individual', c.phone, c.pan, 'consumer'
FROM customer c WHERE c.party_id IS NULL;
UPDATE customer c SET party_id = p.id
FROM party p
WHERE c.party_id IS NULL AND p.display_name = c.name
  AND p.phone IS NOT DISTINCT FROM c.phone AND p.pan IS NOT DISTINCT FROM c.pan;
INSERT INTO party_role (party_id, role)
SELECT party_id, 'customer' FROM customer WHERE party_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Suppliers → party (role 'supplier', business + regular GST since they have GSTIN).
INSERT INTO party (display_name, legal_name, party_kind, gstin, gst_registration_type)
SELECT s.name, s.name, 'business', s.gstin,
       CASE WHEN s.gstin IS NOT NULL THEN 'regular' ELSE 'unregistered' END
FROM supplier s WHERE s.party_id IS NULL;
UPDATE supplier s SET party_id = p.id
FROM party p
WHERE s.party_id IS NULL AND p.display_name = s.name AND p.party_kind = 'business'
  AND p.gstin IS NOT DISTINCT FROM s.gstin;
INSERT INTO party_role (party_id, role)
SELECT party_id, 'supplier' FROM supplier WHERE party_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Smiths → party (role 'smith'). GST status from gst_registered.
INSERT INTO party (branch_id, display_name, party_kind, phone, gstin, gst_registration_type)
SELECT sm.branch_id, sm.name, 'business', sm.phone, sm.gstin,
       CASE WHEN sm.gst_registered THEN 'regular' ELSE 'unregistered' END
FROM smith sm WHERE sm.party_id IS NULL;
UPDATE smith sm SET party_id = p.id
FROM party p
WHERE sm.party_id IS NULL AND p.display_name = sm.name AND p.party_kind = 'business'
  AND p.phone IS NOT DISTINCT FROM sm.phone;
INSERT INTO party_role (party_id, role)
SELECT party_id, 'smith' FROM smith WHERE party_id IS NOT NULL
ON CONFLICT DO NOTHING;
