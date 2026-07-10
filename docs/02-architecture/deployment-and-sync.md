# Deployment & Sync

How the software is installed and kept in sync across multiple PCs in one shop, and across
multiple branches. This is where many incumbents fail (shared-file DB corruption); our
model avoids that by design.

---

## Core principle: one brain, many screens

- **Do NOT** put a database file on a shared network folder for each app to open directly.
  Shared-file databases corrupt under concurrent writes — the root of the instability
  users report.
- **DO** run a real database **server** on one machine, and have every terminal talk to a
  **backend service** over the LAN — never to the database file directly.

---

## Installation modes & packaging

The installer picks a **role**; PostgreSQL is **not** installed on every PC.

| Mode | What it installs | Database | Use |
|---|---|---|---|
| **Standalone** (single PC) | Desktop app only | **Embedded SQLite** (or an optional local PostgreSQL) | Smallest shops, one computer, no LAN |
| **Server** (shop server) | Backend service **+ bundled PostgreSQL** (auto-configured) | PostgreSQL (the shared source of truth) | One machine per shop |
| **Client** (counter PC) | Desktop app only | Embedded SQLite **cache** (talks to the server) | Every additional counter |

### Two database layers
- **SQLite** is **embedded inside the desktop app** on every PC — a local cache + offline
  outbox. **No install, ships with the app.** It is *not* the shared store.
- **PostgreSQL** lives on the **server machine only** — the single source of truth for all
  counters. Installed **once**, on the server.

### The shopkeeper never hand-installs PostgreSQL
- The **Server installer bundles PostgreSQL**, registers it as a service, creates the
  database, and applies migrations on first run — one click, no DB knowledge needed.
- The **Client installer** is just the desktop app + a first-run "Server address?" wizard.
- Packaging targets: Windows (bundled PostgreSQL/EDB installer + WebView2), Linux
  (`postgresql` package or portable build), macOS (Postgres.app/portable + Xcode CLT).

### Single-PC shops
One computer is both server and counter — a single install does everything. The smallest
shops can even run **standalone on the embedded SQLite alone** (no PostgreSQL); we switch
them to the server+PostgreSQL model when they add a second counter.

---

## Single shop, multiple PCs (LAN)

```
        +-----------------------------------------------+
        |              SHOP SERVER (one machine)        |
        |   - PostgreSQL  (single source of truth)      |
        |   - Backend service (Axum API + WebSocket)    |
        |   - Redis, automatic backups                  |
        |   Static LAN address, e.g. 192.168.1.10       |
        +----------------^------------^-----------^------+
                         | LAN (wired preferred for server)
        +----------------+--+ +-------+------+ +--+-----------+
        | Counter PC 1     | | Counter PC 2 | | Manager PC   |
        | Desktop app      | | Desktop app  | | Desktop app  |
        | + local cache    | | + local cache| | + local cache|
        +------------------+ +--------------+ +--------------+

        Biometric attendance devices (eSSL / CP Plus / ZKTeco) on the same LAN:
        [Device] --push (ADMS/HTTP)--> Shop Server   (preferred, real-time)
        [Device] <--pull (TCP 4370)--  Shop Server   (scheduled fallback)
```

### Biometric attendance on the LAN
- Devices are configured to **push** punches to an endpoint on the shop server (ADMS over
  HTTP) — real-time, works without port-forwarding.
- Where push isn't available, the server **pulls** logs over TCP **port 4370** on a
  schedule (ZKTeco-family SDK); CP Plus non-compatible models use their vendor SDK behind
  the same adapter.
- If the LAN/server is briefly down, devices **buffer punches locally** and the server
  reconciles on reconnect; ingestion is **idempotent** (dedup key), so push+pull overlap
  never doubles a punch.
- Give each device a **static LAN IP** (or DHCP reservation), same as the server.

### How sync works in real time
1. All writes go to the server, wrapped in DB transactions.
2. Server uses **PostgreSQL LISTEN/NOTIFY** -> pushes change events over **WebSocket** to
   every connected terminal.
3. Each terminal updates its screen instantly (stock counts, rates, statuses) — no manual
   refresh.

### Preventing double-sale of a unique piece
Two staff might try to bill the same piece at once. The server prevents it inside one
transaction:

```sql
BEGIN;
  SELECT status FROM items WHERE id = $1 FOR UPDATE;  -- locks the row
  -- if already 'Sold' -> reject: "Item already sold at another counter"
  UPDATE items SET status = 'Sold' WHERE id = $1;
  -- write invoice + ledger events
COMMIT;
```

The second terminal gets a clean rejection instead of a duplicate invoice.

### Network blips
- **Reads** keep working from each terminal's **local SQLite cache**.
- **Writes** queue in a local **outbox** and commit when the server returns, with the
  lock/validation applied at commit.
- Each terminal shows a **server-health indicator**: green = connected, amber = using
  cache, red = server down.

### Choosing the server machine
| Shop size | Recommended server |
|---|---|
| Small (2-3 PCs) | Strongest existing PC doubles as server + a counter. Back it up well. |
| Medium / serious | **Dedicated mini-PC (e.g., NUC) or NAS** as server only — not a billing counter. If a counter dies, billing continues elsewhere. |
| Multi-branch | Each shop runs its own local server, all syncing to a cloud master (below). |

A dedicated server box is cheap insurance: if your "server" is also Counter 1 and it
crashes mid-day, the whole shop stops.

### Setup essentials
- **Static LAN IP / DHCP reservation** for the server so terminals always find it.
- **First-run wizard** on each terminal: "Server address?" (entered once).
- Optional **mDNS/Bonjour auto-discovery** so staff don't type IPs.
- **Wired LAN** for the server; Wi-Fi acceptable for terminals.
- **Automatic backups**: hourly local + daily off-box (external drive / cloud).

### Recommended server spec (medium shop)
- 4+ cores, 16 GB RAM, SSD (NVMe), wired Gigabit LAN, UPS (power backup).
- OS: Linux (lower overhead) or Windows — backend runs on both.

---

## Multiple branches (+ cloud)

```
  Branch A Server --+
  Branch B Server --+--> Cloud Sync Server (master) --> Owner dashboards & reporting
  Branch C Server --+                                   (consolidated stock, rates)
```

- Each branch keeps its **own local server** so it is fast and survives internet outages.
- Each branch **syncs up to a cloud master** for consolidated stock, rates, and reporting.
- Branch-to-branch transfers and live rates flow through the cloud.

> The deferred web surfaces (B2B portal, e-commerce) would also be hosted off the cloud
> master when built — they are not part of the current deployment.

### Sync model (branch <-> cloud)
- **Event-based sync** built on the append-only ledger: each side ships new events.
- **Outbox + idempotent apply**: events carry IDs; re-applying is safe.
- **Conflict policy:**
  - Serialized pieces have a single "home" branch that owns mutations -> few conflicts.
  - Reference data (rates, price rules) flows cloud -> branches (cloud authoritative).
  - Genuine conflicts surface in a **conflict-resolution UI** (Admin, F5) for a human.
- Within a single shop you do NOT need this complexity — the LAN server is enough.

---

## Deployment options summary

| Scenario | Topology |
|---|---|
| One PC | App + Postgres on the same machine. |
| One shop, many PCs | Central LAN server + client terminals. |
| Many branches | Local server per branch + cloud master. |
| With e-commerce / B2B portal | *Deferred* — would run on the cloud master when built. |

## Backup & disaster recovery
- Automated Postgres backups (hourly local, daily off-box), tested restores.
- Server on a UPS; SSD with monitoring.
- If the server fails: restore latest backup onto a spare/promoted machine; terminals
  re-point via the first-run wizard. (Document the runbook before go-live.)
