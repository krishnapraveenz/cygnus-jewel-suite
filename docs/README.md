# Cygnus Jewel Suite — Documentation Index

This is the complete documentation set for the platform. Read in order if you are new.

## How to read this

1. **Understand the problem** → Product docs (what we build and why).
2. **Understand the solution shape** → Architecture docs (how we build it).
3. **Understand the plan** → Delivery docs (in what order, and how to start coding).

---

## 01 — Product

| Doc | What it covers |
|---|---|
| [vision-and-scope.md](01-product/vision-and-scope.md) | The product vision, who it serves, what is in/out of scope. |
| [pain-points-and-solutions.md](01-product/pain-points-and-solutions.md) | Researched industry pain points and how we solve each. |
| [module-specification.md](01-product/module-specification.md) | Every module + sub-item, with in-app and builder descriptions. |
| [glossary.md](01-product/glossary.md) | Plain-language definitions of all trade terms used in the app. |

## 02 — Architecture

| Doc | What it covers |
|---|---|
| [tech-stack.md](02-architecture/tech-stack.md) | The finalized technology choices and why. |
| [system-architecture.md](02-architecture/system-architecture.md) | How the pieces fit together (clients, services, data). |
| [deployment-and-sync.md](02-architecture/deployment-and-sync.md) | Multi-PC LAN setup, real-time sync, multi-branch + cloud. |
| [data-model-erd.md](02-architecture/data-model-erd.md) | Core entities, the event ledger, ownership state machine. |
| [valuation-engine-spec.md](02-architecture/valuation-engine-spec.md) | The exact pricing/weight/tax formulas. |
| [security.md](02-architecture/security.md) | AuthN/Z, audit, data protection, network exposure. |

## 03 — Delivery

| Doc | What it covers |
|---|---|
| [roadmap-and-phases.md](03-delivery/roadmap-and-phases.md) | Phased build order, milestones, what ships when. |
| [open-decisions.md](03-delivery/open-decisions.md) | Resolved decisions + still-open questions + artifacts still to produce. |
| [implementation-status.md](03-delivery/implementation-status.md) | What is actually built & verified vs. the design (kept current). |
| [development-setup.md](03-delivery/development-setup.md) | Repo layout, toolchain, how to run locally. |

---

## Scope at a glance

- **In scope now:** Retail + Wholesale on a cross-platform **desktop** app (B2B sales
  invoice + Sale or Return; B2B orders entered in the desktop app), plus
  **staff/attendance/leave/payroll** with direct **LAN biometric integration** (eSSL,
  CP Plus, ZKTeco).
- **Deferred (future release):**
  - **Web B2B portal + e-commerce** (Next.js) and **mobile sales-rep app** (React Native).
    Removing these keeps the current build LAN/desktop-only with no public internet surface.
  - **Manufacturing** (casting, BOM, karigar/piece-rate, stage weight loss).
- The data model + backend API reserve seams so all deferred items plug in without a
  rewrite.
