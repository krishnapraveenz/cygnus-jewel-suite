-- Double-entry accounting: Chart of Accounts, Journal, Expenses.
-- The journal is a projection of business documents (rebuilt idempotently by the
-- posting engine), so it stays consistent with the append-only source data.

CREATE TABLE IF NOT EXISTS chart_of_account (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
    system      BOOLEAN NOT NULL DEFAULT false,   -- seeded/posting-engine accounts
    active      BOOLEAN NOT NULL DEFAULT true,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_entry (
    id           BIGSERIAL PRIMARY KEY,
    branch_id    BIGINT,
    entry_date   DATE NOT NULL,
    narration    TEXT,
    source_type  TEXT,          -- invoice | credit_note | purchase_bill | purchase_payment | advance | scheme | payroll | staff_advance | expense | opening | closing_stock | manual
    source_id    BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_entry_date_idx ON journal_entry(entry_date);
CREATE INDEX IF NOT EXISTS journal_entry_source_idx ON journal_entry(source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_line (
    id          BIGSERIAL PRIMARY KEY,
    entry_id    BIGINT NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
    account_id  BIGINT NOT NULL REFERENCES chart_of_account(id),
    debit       NUMERIC NOT NULL DEFAULT 0,
    credit      NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS journal_line_entry_idx ON journal_line(entry_id);
CREATE INDEX IF NOT EXISTS journal_line_account_idx ON journal_line(account_id);

CREATE TABLE IF NOT EXISTS expense (
    id           BIGSERIAL PRIMARY KEY,
    branch_id    BIGINT,
    expense_date DATE NOT NULL,
    account_id   BIGINT NOT NULL REFERENCES chart_of_account(id),
    amount       NUMERIC NOT NULL,
    mode         TEXT NOT NULL DEFAULT 'cash',   -- cash | bank
    reference    TEXT,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expense_date_idx ON expense(expense_date);

-- Standard jewellery-retail chart of accounts.
INSERT INTO chart_of_account (code, name, type, system, sort_order) VALUES
  ('1000','Cash in Hand','asset',true,10),
  ('1010','Bank Accounts','asset',true,20),
  ('1100','Sundry Debtors','asset',true,30),
  ('1200','Closing Stock (Inventory)','asset',true,40),
  ('1210','Old Gold Stock','asset',true,50),
  ('1300','Staff Loans & Advances','asset',true,60),
  ('1400','Input GST (ITC)','asset',true,70),
  ('2000','Sundry Creditors','liability',true,110),
  ('2100','Customer Advances','liability',true,120),
  ('2200','Gold Scheme Deposits','liability',true,130),
  ('2300','Output GST Payable','liability',true,140),
  ('2400','Statutory Payables (PF/ESI/PT/TDS)','liability',true,150),
  ('3000','Capital Account','equity',true,210),
  ('4000','Sales','income',true,310),
  ('4100','Other Income','income',true,320),
  ('4200','Closing Stock (Trading)','income',true,330),
  ('5000','Purchases','expense',true,410),
  ('5100','Salaries & Wages','expense',true,420),
  ('5200','Karigar / Making Charges','expense',true,430),
  ('5300','Rent','expense',true,440),
  ('5310','Electricity','expense',true,450),
  ('5320','Bank Charges','expense',true,460),
  ('5900','Miscellaneous Expenses','expense',true,470),
  ('5990','Round-off','expense',true,480)
ON CONFLICT (code) DO NOTHING;
