# Security

Because this platform handles high-value stock, customer KYC, and money movement,
security is a first-class concern — not a later add-on. The current build is a LAN/desktop
system with no public internet-facing surface (aside from the optional multi-branch cloud
sync). The deferred web/mobile surfaces (B2B portal, e-commerce) will be built with
authentication and access control from day one when added.

---

## Authentication

- **OIDC via Keycloak** (self-hostable for on-prem shops, or cloud).
- Per-user accounts; **no shared logins**. Staff actions are attributable in the ledger.
- Strong password policy; optional 2FA for admin/owner roles.
- Session tokens (short-lived access + refresh); sessions tracked in Redis and revocable.

## Authorization (RBAC)

- Role-based access control **down to the action**, e.g.:
  - `rate.edit`, `discount.approve`, `price.override`, `stock.writeoff`,
    `rate.override.bill` (inline rate change beyond the configured deviation),
    `bill.target_total` (reverse round-off / target-total adjustment),
    `item.transfer`, `report.financial.view`, `user.manage`.
  - HR/payroll (sensitive): `staff.manage`, `attendance.view`, `attendance.regularize`,
    `leave.approve`, `payroll.run`, `payslip.view`, `biometric.device.manage` — restricted
    to HR/owner roles.
- Sensitive actions require **manager approval workflows** (Users & Roles, F1) and are logged.
- Branch scoping: users see/act only within their branch unless granted cross-branch.

## Audit & non-repudiation

- The **append-only event ledger** records every weight/stone/cash/ownership movement with
  `(user, timestamp, type, before, after)`.
- Events are immutable; corrections are new compensating events, never edits.
- This is both an operational control (loss prevention) and a compliance record.

## Data protection

- **In transit:** TLS for all client<->server and branch<->cloud traffic; WebSocket over
  TLS (wss).
- **At rest:** disk/volume encryption on servers; encrypted backups.
- **Secrets:** integration credentials (NIC e-invoice/e-Way bill, payments, messaging) stored in a secrets
  manager / OS secure store — never in source or plain config. Referenced by key name.
- **PII / KYC:** customer ID documents access-controlled and audited; principle of least
  privilege; retention policy configurable.
- **Biometric attendance & payroll data:** the system stores **punch logs and a
  device-user-id -> staff mapping only — never raw biometric templates** (those remain on
  the device). Attendance, leave, and payroll records are treated as sensitive staff PII:
  access-controlled (HR/owner roles), audited via the ledger, and covered by the retention
  policy. The ADMS push endpoint that receives device punches must authenticate the device
  (per-device key/serial allow-list) and is exposed on the **LAN only**, not the internet.

## Network exposure

The current build is a **LAN/desktop system with no public internet-facing surface** — a
deliberately small attack surface. The web/mobile surfaces below are **deferred**; their
controls are documented here for when they are built.

| Surface | Exposure | Status | Controls |
|---|---|---|---|
| Desktop <-> LAN server | LAN only | **Active** | TLS, OIDC, RBAC. |
| Cloud master API (multi-branch sync) | Public internet | Active when multi-branch enabled | mTLS or signed tokens for branch sync; RBAC; rate-limiting. |
| Admin/owner dashboards | Restricted | Active | 2FA, IP allow-listing optional. |
| B2B portal / e-commerce | Public internet | **Deferred** | When built: auth, rate-limiting, WAF, input validation, bot protection. |

> Security note (for the deferred web surfaces): the B2B portal and e-commerce will handle
> credit limits and KYC. Auth, RBAC, and rate-limiting are required on these from their
> first deployable version — do not ship an unauthenticated network surface. They are not
> part of the current build, so the current system has no such public surface to secure
> beyond the optional multi-branch cloud sync.

## Application security practices

- **Parameterized queries** everywhere (no string-built SQL).
- **Input validation** at the API boundary; reject malformed weight/money/HUID formats.
- **Money/weight only via `rust_decimal`** through the core engine — no ad-hoc math.
- Dependency pinning + vulnerability scanning in CI.
- Principle of least privilege for service accounts and DB roles.

## Backup & recovery (security angle)

- Encrypted, tested backups (see deployment-and-sync.md).
- Documented restore runbook; periodic restore drills before go-live.

## Compliance-adjacent

- HUID validation/printing supports BIS hallmarking obligations.
- GST e-invoice/e-Way bill via **direct NIC APIs** keeps statutory records intact.
- We provide tools and records, not financial/legal advice.

## Cash-handling & PAN/KYC compliance (India)

The system **enforces** statutory cash and identity rules — it does not help circumvent
them. These are protective controls for the jeweller (penalties for breach are severe).

- **PAN capture:** when a transaction crosses the PAN threshold (e.g., ≥ ₹2,00,000), the
  bill **requires** the customer's PAN and KYC details before it can be finalized.
- **Cash-limit enforcement (Sec. 269ST):** receiving **₹2,00,000 or more in cash** from a
  person — in aggregate for a transaction or a single event — is prohibited (penalty under
  Sec. 271DA = 100% of the amount). The system:
  - **Blocks/warns** when cash tender on a bill reaches the limit; routes the balance to
    card / UPI / bank transfer / cheque.
  - **Aggregates same-customer, same-day bills** to flag attempts to breach the limit
    across multiple bills (prevention, not evasion).
- **High-value non-cash rule:** above the configured high-value threshold (e.g., ₹5,00,000),
  restrict tenders to card / UPI / bank transfer / cheque.
- **Audit:** payment mode, PAN presence, and any limit warnings are recorded on the bill.

> The platform deliberately does **not** provide transaction-splitting or any mechanism
> designed to keep individual bills under reporting/cash thresholds. Such structuring of a
> single sale violates Sec. 269ST and PAN/KYC rules; building it would expose the jeweller
> to 100%-of-amount penalties. The compliant path is to capture PAN and accept the balance
> by non-cash tender.
