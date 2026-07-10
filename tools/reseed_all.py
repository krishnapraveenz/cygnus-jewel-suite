#!/usr/bin/env python3
"""Full clean reseed: customers, B2B parties, purchases, sales, advances, schemes.
Creates records in chronological order so document numbers and dates stay aligned,
then back-dates created_at / paid_at and aligns ledger event timestamps."""
import json, random, subprocess, os, urllib.request, urllib.error
from datetime import datetime, timedelta

BASE = "http://127.0.0.1:8787"
PG = os.path.expanduser("~/cygnus-pg/bin")
DBURL = "postgresql://postgres@localhost:5433/cygnus?sslmode=disable"
random.seed(2026)

def psql(sql):
    env = dict(os.environ, PATH=PG + ":" + os.environ["PATH"])
    p = subprocess.run(["psql", DBURL, "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True, env=env)
    if p.returncode != 0:
        raise RuntimeError("PSQL FAIL:\n" + p.stderr + "\n" + sql[:500])
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

def dt(base, days, hour=11):
    return (datetime(2026, 4, 1, hour, 0) + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S+05:30")

tok = call("POST", "/auth/login", {"username": "owner", "password": "newpass1"})[1]["token"]
sets = []  # (table, id, datetime) for back-dating

# ---------- 1. Customers (10 retail; 4 with PAN for large bills) ----------
CUST = [
    ("Arun Nair", "9846010001", "ABCPN1111A"), ("Priya Menon", "9846010002", None),
    ("Rahul Pillai", "9846010003", "ABCPP2222B"), ("Sneha Raj", "9846010004", None),
    ("Vijay Kumar", "9846010005", "ABCPK3333C"), ("Anita George", "9846010006", None),
    ("Deepak Shetty", "9846010007", "ABCPS4444D"), ("Lakshmi Iyer", "9846010008", None),
    ("Manoj Varma", "9846010009", None), ("Fathima Basheer", "9846010010", None),
]
cust_ids = []
for name, phone, pan in CUST:
    body = {"name": name, "phone": phone}
    if pan: body["pan"] = pan
    st, r = call("POST", "/customers", body, tok)
    cust_ids.append(r["id"])
pan_custs = [cust_ids[i] for i in (0, 2, 4, 6)]
small_custs = [cust_ids[i] for i in (1, 3, 5, 7, 8, 9)]

# ---------- 2. B2B parties (suppliers + wholesale, mixed states) ----------
def party(name, state, gstin, roles):
    body = {"display_name": name, "party_kind": "business", "state_code": state, "roles": roles}
    if gstin: body["gstin"] = gstin; body["gst_registration_type"] = "regular"
    return call("POST", "/parties", body, tok)[1]["id"]

kerala_sup  = party("Kerala Gold Mart", "32", "32AAECK1234M1Z5", ["supplier", "wholesale"])   # intra
mumbai_sup  = party("Mumbai Bullion Traders", "27", "27AABCM5678N1Z3", ["supplier"])           # inter
surat_sup   = party("Surat Diamond House", "24", "24AAECS9012P1Z7", ["supplier", "wholesale"]) # inter
local_sup   = party("Local Goldsmith", "32", None, ["supplier"])                                # unregistered
kochi_whl   = party("Kochi Gold Wholesale", "32", "32AAFCK3456Q1Z2", ["wholesale"])            # intra b2b buyer
chennai_whl = party("Chennai Jewels Ltd", "33", "33AAGCC7890R1Z9", ["wholesale"])              # inter b2b buyer

PUR = [1, 2, 3, 5]  # gold purities w/ daily rates
def pline(nmin, nmax, rate=None):
    return {"pricing_mode": "weight_rate", "metal_type_id": 1, "purity_id": random.choice(PUR),
            "gross_weight": f"{random.uniform(nmin, nmax):.3f}", "rate": rate or str(random.randint(6000, 14000)),
            "making_per_gram": random.choice(["0", "80", "150", "300"])}

# ---------- 3. Purchases (12), chronological ----------
# (offset_days, party_id, bill_kind)
purchase_plan = [
    (4, mumbai_sup, "b2b"), (9, kerala_sup, "b2b"), (14, local_sup, "local"),
    (23, surat_sup, "b2b"), (31, kerala_sup, "b2b"), (38, mumbai_sup, "b2b"),
    (47, local_sup, "local"), (55, surat_sup, "b2b"), (63, kerala_sup, "b2b"),
    (72, mumbai_sup, "b2b"), (81, surat_sup, "b2b"), (90, kerala_sup, "b2b"),
]
for off, pid, kind in purchase_plan:
    lines = [pline(20, 120) for _ in range(random.randint(1, 2))]
    st, r = call("POST", "/purchases", {"party_id": pid, "bill_kind": kind, "tag_now": True, "lines": lines}, tok)
    if st == 200:
        sets.append(("purchase_bill", r["purchase_bill_id"], dt(0, off)))
    else:
        print("PUR FAIL", st, str(r)[:120])

# ---------- 4. Sales (15), chronological ----------
def sline(nmin, nmax):
    return {"metal_type_id": 1, "purity_id": random.choice(PUR), "net_weight": f"{random.uniform(nmin, nmax):.3f}",
            "making_per_gram": random.choice(["350", "500", "700"]), "wastage_percent": random.choice(["0", "5", "8"])}
NONCASH = ["card", "upi", "bank_transfer", "cheque"]
# kind: small|large|b2b_intra|b2b_inter|credit
sales_plan = [
    (7, "small"), (12, "large"), (18, "b2b_inter"), (25, "small"), (30, "credit"),
    (36, "large"), (42, "small"), (48, "b2b_intra"), (54, "small"), (60, "large"),
    (66, "credit"), (73, "small"), (79, "b2b_inter"), (86, "large"), (92, "small"),
]
for off, kind in sales_plan:
    if kind == "large":
        body = {"customer_id": random.choice(pan_custs), "invoice_type": "retail", "inter_state": False,
                "payment_mode": random.choice(NONCASH), "lines": [sline(10, 30) for _ in range(random.randint(1, 2))]}
    elif kind == "small":
        body = {"customer_id": random.choice(small_custs), "invoice_type": "retail", "inter_state": False,
                "lines": [sline(1, 5) for _ in range(random.randint(1, 2))]}
    elif kind == "credit":
        body = {"customer_id": random.choice(small_custs), "invoice_type": "retail", "inter_state": False,
                "payment_mode": "credit", "lines": [sline(1, 4)]}
    elif kind == "b2b_intra":
        body = {"party_id": kochi_whl, "invoice_type": "b2b", "inter_state": False, "lines": [sline(2, 6)]}
    else:  # b2b_inter
        body = {"party_id": chennai_whl, "invoice_type": "b2b", "inter_state": True, "lines": [sline(2, 6)]}
    st, r = call("POST", "/invoices", body, tok)
    if st == 200:
        sets.append(("invoice", r["invoice_id"], dt(0, off)))
    else:
        print("SALE FAIL", kind, st, str(r)[:120])

# ---------- 5. Advances (amount + metal bookings) ----------
adv_plan = [
    (33, cust_ids[0], {"advance_type": "amount", "amount": "50000", "payment_mode": "upi", "note": "Order advance"}),
    (40, cust_ids[1], {"advance_type": "amount", "amount": "25000", "payment_mode": "cash"}),
    (58, cust_ids[3], {"advance_type": "metal", "metal_type_id": 1, "purity_id": 2, "booked_weight": "20",
                        "rate_locked": "13200", "percent": "25", "payment_mode": "bank_transfer", "note": "Gold booking 20g"}),
    (70, cust_ids[4], {"advance_type": "amount", "amount": "100000", "payment_mode": "cheque"}),
    (84, cust_ids[6], {"advance_type": "metal", "metal_type_id": 1, "purity_id": 1, "booked_weight": "10",
                        "rate_locked": "14300", "percent": "50", "payment_mode": "card"}),
]
for off, cid, body in adv_plan:
    st, r = call("POST", f"/customers/{cid}/advances", body, tok)
    if st == 200:
        sets.append(("customer_advance", r["id"], dt(0, off)))
    else:
        print("ADV FAIL", st, str(r)[:120])

# ---------- 6. Schemes (enroll + collect installments) ----------
scheme_plan = [
    (10, cust_ids[0], {"monthly_amount": "5000", "installments_required": 11, "scheme_type": "value"}, 5),
    (12, cust_ids[2], {"monthly_amount": "10000", "installments_required": 11, "scheme_type": "value"}, 3),
    (15, cust_ids[5], {"monthly_amount": "8000", "scheme_type": "gram", "metal_type_id": 1, "purity_id": 2}, 4),
    (20, cust_ids[7], {"monthly_amount": "3000", "installments_required": 11, "scheme_type": "value"}, 6),
]
scheme_dates = []  # (scheme_id, enroll_off, n_paid)
for off, cid, body, npay in scheme_plan:
    body["customer_id"] = cid
    st, r = call("POST", "/schemes", body, tok)
    if st != 200:
        print("SCHEME FAIL", st, str(r)[:120]); continue
    sid = r["scheme_id"]
    sets.append(("scheme", sid, dt(0, off)))
    for k in range(npay):
        call("POST", f"/schemes/{sid}/pay", {"amount": body["monthly_amount"],
             "payment_mode": random.choice(["cash", "upi", "bank_transfer"])}, tok)
    scheme_dates.append((sid, off, npay, body["monthly_amount"]))

# ---------- 7. Back-date everything + align ledger, tenders, payments ----------
stmts = ["BEGIN;"]
for table, rid, when in sets:
    col = "created_at"
    stmts.append(f"UPDATE {table} SET {col}='{when}' WHERE id={rid};")
# scheme installments: monthly from enrollment
for sid, off, npay, amt in scheme_dates:
    for k in range(npay):
        d = dt(0, off + 30 * k)
        stmts.append(f"UPDATE scheme_installment SET paid_at='{d}' WHERE scheme_id={sid} AND seq={k+1};")
    stmts.append(f"UPDATE scheme SET start_date=(SELECT min(paid_at)::date FROM scheme_installment WHERE scheme_id={sid}) WHERE id={sid};")
# paid sales -> tender rows (exact grand); credit sales stay unpaid
stmts.append("""INSERT INTO invoice_tender (invoice_id, mode, amount, created_at)
  SELECT id, COALESCE(payment_mode,'cash'), grand_total, created_at FROM invoice
  WHERE COALESCE(payment_mode,'cash') <> 'credit' AND grand_total > 0;""")
# partial supplier payments on ~55% of bills (+ ledger)
stmts.append("""WITH pay AS (
    SELECT pb.id, pb.branch_id, pb.party_id, pb.created_at,
           round((pb.total*(0.4+random()*0.6))::numeric,0) amt,
           (array['cash','bank','cheque'])[floor(random()*3)+1] mode
    FROM purchase_bill pb WHERE random()<0.55 AND pb.total>0 AND pb.party_id IS NOT NULL),
  ins AS (INSERT INTO purchase_payment (purchase_bill_id, mode, amount, created_at)
          SELECT id, mode, amt, created_at FROM pay RETURNING 1)
  INSERT INTO ledger_event (branch_id, occurred_at, subject_type, subject_id, event_type, amount_delta, ref_doc_type, ref_doc_id)
  SELECT branch_id, created_at, 'party', party_id, 'payment', amt, 'purchase_bill', id FROM pay;""")
# align ledger + tender timestamps to their documents
stmts.append("UPDATE invoice_tender t SET created_at=i.created_at FROM invoice i WHERE t.invoice_id=i.id;")
stmts.append("UPDATE ledger_event le SET occurred_at=pb.created_at FROM purchase_bill pb WHERE le.ref_doc_type='purchase_bill' AND le.ref_doc_id=pb.id;")
stmts.append("UPDATE ledger_event le SET occurred_at=i.created_at FROM invoice i WHERE le.ref_doc_type='invoice' AND le.ref_doc_id=i.id;")
stmts.append("UPDATE ledger_event le SET occurred_at=ca.created_at FROM customer_advance ca WHERE le.ref_doc_type='advance' AND le.ref_doc_id=ca.id;")
stmts.append("COMMIT;")
psql("\n".join(stmts))
print("reseed complete:", len([s for s in sets if s[0]=='invoice']), "sales,",
      len([s for s in sets if s[0]=='purchase_bill']), "purchases,",
      len([s for s in sets if s[0]=='customer_advance']), "advances,",
      len(scheme_dates), "schemes")
