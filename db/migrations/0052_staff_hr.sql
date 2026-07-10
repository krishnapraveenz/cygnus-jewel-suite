-- 0052_staff_hr.sql — Staff / Attendance / Leave / Payroll + biometric devices.

CREATE TABLE staff (
    id                BIGSERIAL PRIMARY KEY,
    branch_id         BIGINT NOT NULL REFERENCES branch(id),
    code              TEXT NOT NULL,
    name              TEXT NOT NULL,
    phone             TEXT,
    designation       TEXT,
    department        TEXT,
    join_date         DATE,
    salary_type       TEXT NOT NULL DEFAULT 'monthly' CHECK (salary_type IN ('monthly','daily','hourly')),
    base_salary       NUMERIC(14,2) NOT NULL DEFAULT 0,
    allowances        NUMERIC(14,2) NOT NULL DEFAULT 0,   -- fixed monthly allowances
    biometric_user_id TEXT,                                -- enrollment id on the device
    pan               TEXT,
    aadhaar           TEXT,
    bank_account      TEXT,
    bank_ifsc         TEXT,
    weekly_off        INT NOT NULL DEFAULT 0,              -- 0=Sun .. 6=Sat
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_code_branch ON staff (branch_id, code);
CREATE INDEX staff_bio ON staff (biometric_user_id);

CREATE TABLE holiday (
    id        BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branch(id),
    day       DATE NOT NULL,
    name      TEXT NOT NULL,
    UNIQUE (branch_id, day)
);

CREATE TABLE attendance (
    id           BIGSERIAL PRIMARY KEY,
    staff_id     BIGINT NOT NULL REFERENCES staff(id),
    day          DATE NOT NULL,
    status       TEXT NOT NULL DEFAULT 'present'
                 CHECK (status IN ('present','absent','half_day','leave','holiday','week_off')),
    check_in     TIMESTAMPTZ,
    check_out    TIMESTAMPTZ,
    hours        NUMERIC(6,2) NOT NULL DEFAULT 0,
    late_minutes INT NOT NULL DEFAULT 0,
    source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','device','import','auto')),
    note         TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (staff_id, day)
);
CREATE INDEX attendance_day ON attendance (day);

CREATE TABLE attendance_punch (
    id                BIGSERIAL PRIMARY KEY,
    branch_id         BIGINT NOT NULL REFERENCES branch(id),
    staff_id          BIGINT REFERENCES staff(id),
    biometric_user_id TEXT,
    punch_at          TIMESTAMPTZ NOT NULL,
    direction         TEXT NOT NULL DEFAULT 'auto' CHECK (direction IN ('in','out','auto')),
    device_id         BIGINT,
    source            TEXT NOT NULL DEFAULT 'device',
    raw               TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (biometric_user_id, punch_at, device_id)   -- dedupe repeated pushes
);
CREATE INDEX punch_staff_day ON attendance_punch (staff_id, punch_at);

CREATE TABLE leave_type (
    id           BIGSERIAL PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    paid         BOOLEAN NOT NULL DEFAULT true,
    annual_quota NUMERIC(5,1) NOT NULL DEFAULT 0,
    active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE leave_request (
    id            BIGSERIAL PRIMARY KEY,
    staff_id      BIGINT NOT NULL REFERENCES staff(id),
    leave_type_id BIGINT NOT NULL REFERENCES leave_type(id),
    from_day      DATE NOT NULL,
    to_day        DATE NOT NULL,
    days          NUMERIC(5,1) NOT NULL,
    reason        TEXT,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','cancelled')),
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by    BIGINT,
    decided_at    TIMESTAMPTZ
);
CREATE INDEX leave_req_staff ON leave_request (staff_id, status);

CREATE TABLE payroll_run (
    id           BIGSERIAL PRIMARY KEY,
    branch_id    BIGINT NOT NULL REFERENCES branch(id),
    period       TEXT NOT NULL,                      -- 'YYYY-MM'
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','paid')),
    days_in_month INT NOT NULL DEFAULT 30,
    gross_total  NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_total    NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (branch_id, period)
);

CREATE TABLE payslip (
    id              BIGSERIAL PRIMARY KEY,
    payroll_run_id  BIGINT NOT NULL REFERENCES payroll_run(id) ON DELETE CASCADE,
    staff_id        BIGINT NOT NULL REFERENCES staff(id),
    period          TEXT NOT NULL,
    present_days    NUMERIC(5,1) NOT NULL DEFAULT 0,
    paid_leave_days NUMERIC(5,1) NOT NULL DEFAULT 0,
    lop_days        NUMERIC(5,1) NOT NULL DEFAULT 0,
    payable_days    NUMERIC(5,1) NOT NULL DEFAULT 0,
    base_earned     NUMERIC(14,2) NOT NULL DEFAULT 0,
    allowances      NUMERIC(14,2) NOT NULL DEFAULT 0,
    deductions      NUMERIC(14,2) NOT NULL DEFAULT 0,
    gross           NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_pay         NUMERIC(14,2) NOT NULL DEFAULT 0,
    note            TEXT,
    UNIQUE (payroll_run_id, staff_id)
);

CREATE TABLE biometric_device (
    id         BIGSERIAL PRIMARY KEY,
    branch_id  BIGINT NOT NULL REFERENCES branch(id),
    name       TEXT NOT NULL,
    brand      TEXT NOT NULL DEFAULT 'zkteco' CHECK (brand IN ('essl','cpplus','zkteco','other')),
    ip         TEXT,
    port       INT NOT NULL DEFAULT 4370,
    serial_no  TEXT,                                  -- device SN for iclock/ADMS push matching
    enabled    BOOLEAN NOT NULL DEFAULT true,
    last_sync  TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO leave_type (code, name, paid, annual_quota) VALUES
    ('CL','Casual Leave', true, 12),
    ('SL','Sick Leave', true, 12),
    ('EL','Earned Leave', true, 15),
    ('LWP','Leave Without Pay', false, 0)
ON CONFLICT (code) DO NOTHING;
