-- 0054_payroll_ot_employer.sql — overtime pay + employer statutory contributions + PT slabs.

ALTER TABLE payslip ADD COLUMN IF NOT EXISTS ot_hours     NUMERIC(8,2)  NOT NULL DEFAULT 0;
ALTER TABLE payslip ADD COLUMN IF NOT EXISTS ot_pay       NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payslip ADD COLUMN IF NOT EXISTS employer_pf  NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payslip ADD COLUMN IF NOT EXISTS employer_esi NUMERIC(14,2) NOT NULL DEFAULT 0;

INSERT INTO app_setting (key, value) VALUES
    ('payroll.ot_enabled', 'false'),
    ('payroll.ot_rate_multiplier', '2'),          -- OT paid at N× the normal hourly rate
    ('attendance.full_hours', '8'),               -- standard hours/day; excess = OT
    ('payroll.employer_pf_percent', '13'),        -- 12% PF + 0.5% EDLI + 0.5% admin (approx)
    ('payroll.employer_esi_percent', '3.25'),
    ('payroll.pt_slabs', '[]')                     -- JSON [{"upto":7500,"amount":0},...]; empty → flat pt_amount
ON CONFLICT (key) DO NOTHING;
