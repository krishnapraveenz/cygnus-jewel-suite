#!/usr/bin/env python3
"""Reseed staff + payroll demo for Apr-Jun 2026: staff, attendance, payroll runs, advances, leave."""
import json, os, subprocess, urllib.request, urllib.error

BASE = "http://127.0.0.1:8787"
PG = os.path.expanduser("~/cygnus-pg/bin")
DBURL = "postgresql://postgres@localhost:5433/cygnus?sslmode=disable"

def psql(sql):
    env = dict(os.environ, PATH=PG + ":" + os.environ["PATH"])
    p = subprocess.run(["psql", DBURL, "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True, env=env)
    if p.returncode != 0:
        raise RuntimeError("PSQL FAIL:\n" + p.stderr)
    return p.stdout

def call(method, path, body=None, tok=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("content-type", "application/json")
    if tok: r.add_header("authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r) as x:
            return x.status, json.loads(x.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

tok = call("POST", "/auth/login", {"username": "owner", "password": "newpass1"})[1]["token"]

# 1. Wipe staff transactional data (keep leave_types, holidays, the 2 existing staff)
psql("""BEGIN;
DELETE FROM payslip; DELETE FROM payroll_run; DELETE FROM staff_advance;
DELETE FROM attendance; DELETE FROM leave_request;
DELETE FROM ledger_event WHERE subject_type='payroll';
COMMIT;""")

# 2. Add 3 more staff (varied salary types)
new_staff = [
    {"code": "E03", "name": "Anjali Nair", "designation": "Sales Executive", "salary_type": "monthly",
     "base_salary": "22000", "allowances": "1500", "weekly_off": 0, "join_date": "2025-11-01"},
    {"code": "E04", "name": "Ravi Menon", "designation": "Karigar (daily)", "salary_type": "daily",
     "base_salary": "900", "weekly_off": 0, "join_date": "2026-01-10"},
    {"code": "E05", "name": "Meena Iyer", "designation": "Accountant", "salary_type": "monthly",
     "base_salary": "35000", "allowances": "3000", "weekly_off": 0, "join_date": "2025-09-15"},
]
for s in new_staff:
    st, r = call("POST", "/staff", s, tok)
    if st != 200: print("STAFF FAIL", st, str(r)[:120])

# 3. Attendance for all active staff, Apr 1 - Jun 30 2026 (Sundays off, some absent/half/leave)
psql("""
WITH days AS (
  SELECT s.id staff_id, d::date dy,
    CASE WHEN extract(dow from d)=0 THEN 'week_off'
         WHEN random()<0.05 THEN 'absent'
         WHEN random()<0.08 THEN 'half_day'
         WHEN random()<0.11 THEN 'leave'
         ELSE 'present' END status
  FROM staff s CROSS JOIN generate_series('2026-04-01'::timestamp,'2026-06-30'::timestamp,'1 day') d
  WHERE s.status='active'
)
INSERT INTO attendance (staff_id, day, status, check_in, check_out, hours, source)
SELECT staff_id, dy, status,
  CASE WHEN status IN ('present','half_day') THEN dy + time '10:00' END,
  CASE WHEN status='present' THEN dy + time '19:00' WHEN status='half_day' THEN dy + time '14:30' END,
  CASE WHEN status='present' THEN 9 WHEN status='half_day' THEN 4.5 ELSE 0 END,
  'manual'
FROM days ON CONFLICT (staff_id, day) DO NOTHING;
""")

# 4. Staff advances/loans (before payroll so recovery reflects); backdated to April
adv = [
    {"staff_id": 1, "amount": "20000", "recovery_per_month": "5000", "note": "Festival advance"},
    {"staff_id": 3, "amount": "15000", "recovery_per_month": "3000", "note": "Personal loan"},
]
for a in adv:
    call("POST", "/staff-advances", a, tok)
psql("UPDATE staff_advance SET created_at='2026-04-06 10:00:00+05:30';")

# 5. Generate payroll for Apr, May, Jun; finalize + mark paid for Apr & May
for period in ["2026-04", "2026-05", "2026-06"]:
    st, r = call("POST", "/payroll-runs", {"period": period}, tok)
    if st != 200:
        print("PAYROLL FAIL", period, st, str(r)[:120]); continue
    rid = r["id"]
    if period in ("2026-04", "2026-05"):
        call("POST", f"/payroll-runs/{rid}/status", {"status": "finalized"}, tok)
        call("POST", f"/payroll-runs/{rid}/status", {"status": "paid"}, tok)

# 6. A couple of leave requests (approved), past dates
lt = call("GET", "/leave-types", tok=tok)[1]
if lt:
    casual = next((x["id"] for x in lt if x["code"] in ("CL", "EL")), lt[0]["id"])
    for sid, frm, to in [(2, "2026-05-12", "2026-05-13"), (3, "2026-06-09", "2026-06-09")]:
        st, r = call("POST", "/leave-requests", {"staff_id": sid, "leave_type_id": casual,
                     "from_day": frm, "to_day": to, "reason": "Personal"}, tok)
        if st == 200:
            call("POST", f"/leave-requests/{r['id']}/decide", {"status": "approved"}, tok)

print("staff/payroll reseed done")
