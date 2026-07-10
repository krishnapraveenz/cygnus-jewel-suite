-- 0068_department.sql — jewellery "Department" (type) dimension above metal.
-- User-managed groups (Gold Ornaments / Fine Gold / Diamond Ornaments / Silver /
-- Platinum …). Every item is Department + Metal + Purity; stock rolls up as
-- Department × Purity. The metal/purity still drive gold value, hallmark and
-- fine-weight math — the department is the grouping/label.
CREATE TABLE department (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    sort_order INT  NOT NULL DEFAULT 100,
    active     BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO department (name, sort_order) VALUES
    ('Gold Ornaments', 10),
    ('Fine Gold', 20),
    ('Diamond Ornaments', 30),
    ('Silver Ornaments', 40),
    ('Platinum Ornaments', 50)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE item              ADD COLUMN IF NOT EXISTS department_id BIGINT REFERENCES department(id);
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS department_id BIGINT REFERENCES department(id);
ALTER TABLE invoice_line       ADD COLUMN IF NOT EXISTS department_id BIGINT REFERENCES department(id);

-- Backfill existing items from metal + diamond presence + purity.
UPDATE item i SET department_id = d.id
FROM metal_type mt, purity p, department d
WHERE i.metal_type_id = mt.id AND i.purity_id = p.id AND i.department_id IS NULL
  AND d.name = CASE
    WHEN mt.name = 'silver' THEN 'Silver Ornaments'
    WHEN mt.name = 'platinum' THEN 'Platinum Ornaments'
    WHEN mt.name = 'gold' AND EXISTS (
        SELECT 1 FROM item_stone ist JOIN stone_type st ON st.id = ist.stone_type_id
        WHERE ist.item_id = i.id AND st.category = 'diamond') THEN 'Diamond Ornaments'
    WHEN mt.name = 'gold' AND p.label IN ('999.9', '995', '999') THEN 'Fine Gold'
    WHEN mt.name = 'gold' THEN 'Gold Ornaments'
    ELSE NULL END;
