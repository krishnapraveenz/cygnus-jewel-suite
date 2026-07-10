-- 0053_hr_v2.sql — statutory payroll lines, salary advances/loans, half-day leave, config.

-- Payslip statutory + loan deduction lines. `deductions` now means "other deductions".
ALTER TABLE payslip ADD COLUMN IF NOT EXISTS pf            NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payslip ADD COLUMN IF NOT EXISTS esi           NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payslip ADD COLUMN IF NOT EXISTS pt            NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payslip ADD COLUMN IF NOT EXISTS tds           NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payslip ADD COLUMN IF NOT EXISTS loan_recovery NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Salary advance / loan, recovered monthly through payroll.
CREATE TABLE staff_advance (
    id                 BIGSERIAL PRIMARY KEY,
    branch_id          BIGINT NOT NULL REFERENCES branch(id),
    staff_id           BIGINT NOT NULL REFERENCES staff(id),
    amount             NUMERIC(14,2) NOT NULL,
    recovery_per_month NUMERIC(14,2) NOT NULL DEFAULT 0,
    outstanding        NUMERIC(14,2) NOT NULL,
    note               TEXT,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX staff_advance_staff ON staff_advance (staff_id, status);

-- Half-day leave (single day, counts as 0.5).
ALTER TABLE leave_request ADD COLUMN IF NOT EXISTS half_day BOOLEAN NOT NULL DEFAULT false;

-- Default payroll statutory config (editable in Settings → Payroll).
INSERT INTO app_setting (key, value) VALUES
    ('payroll.pf_enabled', 'true'),
    ('payroll.pf_percent', '12'),
    ('payroll.pf_wage_ceiling', '15000'),
    ('payroll.esi_enabled', 'true'),
    ('payroll.esi_percent', '0.75'),
    ('payroll.esi_wage_ceiling', '21000'),
    ('payroll.pt_amount', '200')
ON CONFLICT (key) DO NOTHING;
