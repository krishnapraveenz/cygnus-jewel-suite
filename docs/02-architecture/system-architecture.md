# System Architecture

How the pieces fit together. Companion to [tech-stack.md](tech-stack.md) and
[deployment-and-sync.md](deployment-and-sync.md).

---

## Layers

```
+---------------------------------------------------------------+
|  CLIENTS                                                      |
|  Desktop (Tauri)  — counter + back-office (retail + wholesale)|
|  [Deferred: Web B2B/e-commerce (Next.js), Mobile (RN)]        |
+------------------------------+--------------------------------+
                               | HTTPS / WebSocket
+------------------------------v--------------------------------+
|  BACKEND SERVICE (Rust + Axum)                               |
|  - REST API + WebSocket (real-time)                          |
|  - Uses core-engine crate (valuation/tax/conversions)        |
|  - AuthN/Z (OIDC), RBAC enforcement                          |
|  - Integrations: NIC e-invoice/e-Way bill (direct), payments, msg|
+----------+----------------------+----------------+-----------+
           |                      |                |
+----------v------+   +-----------v-----+   +------v---------+
| PostgreSQL      |   | Redis           |   | Object storage |
| - relational    |   | - rate cache    |   | - photos       |
| - EVENT LEDGER  |   | - sessions      |   | - certificates |
| - LISTEN/NOTIFY |   | - pub/sub       |   +----------------+
+-----------------+   +-----------------+
```

The **core-engine** Rust crate is compiled into BOTH the desktop app and the backend, so
pricing/weight/tax math is identical wherever it runs.

> The current build ships the **desktop client only**. The Web B2B portal, e-commerce
> storefront, and mobile sales-rep app are deferred to a future release; the backend API is
> designed so they attach later without re-architecture. See
> [tech-stack.md](tech-stack.md#deferred-to-a-future-release-not-current-development).

---

## Core design principles

### 1. Modular monolith, organized in three tiers
One backend, one database, one deployable — **not** microservices. Inside it, each module is
a **bounded context** (own screens, code, tables) sitting on a **shared core** (Stock
ledger, Valuation engine, Event ledger). This is the central choice for **stability and
consistency**: a sale can atomically reduce stock *and* post to the ledger in one
transaction — hard to guarantee across separate services.

Modules fall into three tiers (full list in
[../01-product/module-specification.md](../01-product/module-specification.md)):

- **Foundation (F1–F5):** users/roles, settings & master data, audit/event ledger, metal
  rates, admin — platform services used by everything.
- **Operations (O1–O9):** Sales, Purchase, Stock, Customers, Suppliers, Accounting,
  Staff & Payroll, Repairs, Reports — the day-to-day modules.
- **Engines (E1–E3):** Valuation, Tax & Compliance, Hardware — internal, no menu.

Sales / Purchase / Stock are separate modules but **three views over one Stock ledger**
(purchase increases stock, sale decreases it, stock is the running projection).

### 2. Computed prices, never stored prices
No item carries a "price" field as truth. Every price-bearing screen calls one function:

```
value(item, rate, rules, taxes) -> PriceBreakdown
```

On document finalize, the resulting breakdown (and the rate ID used) is **snapshotted**
onto immutable invoice lines so reprints/audits are exact. See
[valuation-engine-spec.md](valuation-engine-spec.md).

### 3. Append-only event ledger
State is derived from an immutable stream of events, not by overwriting rows.

- Every weight/stone/cash/ownership movement is an event: `(who, when, type, before, after)`.
- Current balances/states are **projections** of the event stream (kept in read tables for
  speed, rebuildable from events).
- Nothing is silently overwritten — this is what gives stability, a full audit trail, and
  loss prevention. It is also the seam manufacturing will extend (stage weight events).

### 4. Ownership state machine
Every item carries an ownership state. Transitions are events.

```
            In Stock
           /   |    \
  On-Approval  Sale-or-Return   Sold
   (Out, B2C)   (Out, B2B)
       |            |
   Returned     Returned / Invoiced(-> Sold)
```

This single mechanism powers retail take-home trials, wholesale sale-or-return, and the
distinction between owned and out-but-still-owned stock.

### 5. One core, two sales surfaces
The Sales module's Retail counter and Wholesale B2B surfaces are different front-ends over
the same Stock, Valuation, Tax, and Accounting core. They differ only in pricing rules, tax
flows, and the sale-vs-sale-or-return choice.

---

## Request flow (example: counter sale of a unique piece)

1. Desktop UI builds the bill; the **local Rust core** previews the price live.
2. On "Finalize", the desktop sends the sale to the backend over the LAN.
3. Backend opens a DB transaction:
   - `SELECT ... FOR UPDATE` locks the item row.
   - Verifies state is `In Stock` (else rejects: "already sold at another counter").
   - Recomputes the price with `core-engine`, writes invoice + ledger events, sets state
     `Sold`.
   - `COMMIT`.
4. Backend issues `NOTIFY` -> WebSocket pushes the change to all terminals; their screens
   update instantly.
5. If GST e-invoice is enabled, the backend calls the **NIC IRP API directly** and stores the IRN/QR.

The double-sale guard (step 3) is impossible with shared-file databases — it is the main
reason for a real DB server. Details in [deployment-and-sync.md](deployment-and-sync.md).

---

## Offline tolerance

- The desktop keeps a **local SQLite cache** of items, rates, and customers for fast reads
  and to keep working during brief LAN/internet blips.
- Writes use an **outbox**: queued locally and committed when the server is reachable, with
  the same locking/validation applied at commit time.
- For unique serialized pieces, the authoritative lock lives on the LAN server (which is
  local and rarely down). True offline is safest for non-serialized/scheme transactions.

## Integration points

| Integration | Direction | Notes |
|---|---|---|
| NIC e-invoice (IRP) + e-Way bill | out | **Direct** API; returns IRN/QR + e-Way bill no. |
| Payments (card/UPI) | out | Tender capture. |
| WhatsApp/SMS | out | Reminders, campaigns. |
| Metal rate feed | in | Optional live rates. |
| Tally / QuickBooks | out | Accounting export. |
| Scales / RFID / printers | in/out | Via the desktop Rust hardware layer. |
