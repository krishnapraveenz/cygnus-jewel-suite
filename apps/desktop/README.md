# apps/desktop — Cygnus Jewel Suite (Tauri 2 + React/TS)

The desktop counter client. Talks to the backend over the LAN (HTTP) and shows a live
price breakdown using the same valuation engine the server uses.

## What it does (Phase 1 slice)
- **Login** screen (server address + username/password → session token).
- **Counter**: lists in-stock items, select one, set making % / discount, see a **live price
  preview** (metal + making + GST + grand total), and **Sell** (creates the invoice).

## Prerequisites
- Node 22+ and pnpm; Rust stable; Linux webkit deps (`webkit2gtk-4.1`, `gtk+-3.0`,
  `libsoup-3.0`) — already present on this machine.
- A running backend (see repo root) with at least one rate set and some stock.

## Run (development)
```bash
# 1. start the backend (from repo root)
DATABASE_URL=postgresql://postgres@localhost:5433/cygnus?sslmode=disable cargo run -p backend

# 2. start the desktop app (opens a native window)
cd apps/desktop
pnpm install            # first time
pnpm tauri dev
```
Log in (default server `http://127.0.0.1:8787`, user `owner`, password from
`BOOTSTRAP_OWNER_PASSWORD` or `admin123`).

## Build a release bundle
```bash
pnpm tauri build        # produces installers in src-tauri/target/release/bundle
```

## Notes
- The backend enables permissive CORS so the webview can call it on the LAN.
- `apps/desktop/src-tauri` is a separate Cargo crate, **excluded** from the root workspace
  (so `cargo build --workspace` stays engine + backend only). Build it via Tauri commands.
- Frontend: `src/api.ts` (typed API client), `src/App.tsx` (login + counter).
