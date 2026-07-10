import { useEffect, useState } from "react";
import { Building2, Moon, Sun, LogOut, Settings, ChevronDown, KeyRound, X } from "lucide-react";
import type { RateRow } from "@/api";
import * as api from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getTickerItems } from "@/lib/ticker";
import { getCompany, loadCompany } from "@/lib/company";
import { currentFY } from "@/lib/fy";

interface TopbarProps {
  title: string;
  role: string;
  rates: RateRow[];
  dark: boolean;
  toggleDark: () => void;
  onLogout: () => void;
  goSettings: () => void;
}

export function Topbar({ title, role, rates, dark, toggleDark, onLogout, goSettings }: TopbarProps) {
  const [tickerKeys, setTickerKeys] = useState<string[]>(getTickerItems());
  const [diamondRate, setDiamondRate] = useState<string | null>(null);
  const [company, setCompany] = useState(getCompany().name);

  useEffect(() => {
    const refresh = () => setCompany(getCompany().name);
    loadCompany().then((c) => setCompany(c.name)).catch(() => {});
    window.addEventListener("cygnus:company", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("cygnus:company", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    const refresh = () => setTickerKeys(getTickerItems());
    window.addEventListener("cygnus:ticker", refresh);
    return () => window.removeEventListener("cygnus:ticker", refresh);
  }, []);

  // Diamond rate: prefer the daily-board value edited on Daily Rates
  // (`rates.diamond_per_ct`); fall back to the highest active diamond grade.
  useEffect(() => {
    if (!tickerKeys.includes("diamond")) return;
    const load = async () => {
      try {
        const s = await api.getSettings();
        const v = s["rates.diamond_per_ct"];
        if (v && Number(v) > 0) {
          setDiamondRate(v);
          return;
        }
      } catch {
        /* fall through to grade lookup */
      }
      try {
        const types = await api.listStoneTypes();
        const dia = types.find((t) => t.category === "diamond" && t.active);
        const rate = dia?.qualities.filter((q) => q.active).map((q) => Number(q.rate_per_carat)).sort((a, b) => b - a)[0];
        setDiamondRate(rate ? String(rate) : null);
      } catch {
        /* ignore */
      }
    };
    load();
    window.addEventListener("cygnus:rates", load);
    return () => window.removeEventListener("cygnus:rates", load);
  }, [tickerKeys]);

  function chipFor(key: string) {
    if (key === "diamond") {
      return <RateChip key="diamond" label="Diamond" value={diamondRate ?? undefined} unit="/CT" tone="gold" />;
    }
    const [metal, purity] = key.split(":");
    const row = rates.find((r) => r.metal === metal && r.purity === purity);
    const label = metal === "gold" ? purity : `${metal[0].toUpperCase()}${metal.slice(1)} ${purity}`;
    return <RateChip key={key} label={label} value={row?.sell_rate} unit="/g" tone={metal === "gold" ? "gold" : "muted"} />;
  }

  return (
    <header className="flex items-center h-14 px-4 border-b border-border bg-background gap-3 shrink-0">
      <h1 className="text-base font-semibold">{title}</h1>

      <div className="flex-1" />

      {/* Live metal-rate ticker (configurable in Settings → General) */}
      <div className="flex items-center gap-1.5">{tickerKeys.map(chipFor)}</div>

      {/* Branch */}
      <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border bg-card text-sm text-muted-foreground">
        <Building2 className="w-3.5 h-3.5" />
        <span>{company?.trim() || "Main Showroom"}</span>
      </div>

      {/* Financial year */}
      <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border bg-card text-sm text-muted-foreground" title="Current financial year">
        <span className="text-[10px] uppercase tracking-wide">FY</span>
        <span className="font-medium text-foreground">{currentFY().label}</span>
      </div>

      {/* Theme toggle */}
      <button
        onClick={toggleDark}
        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground"
        title={dark ? "Light mode" : "Dark mode"}
      >
        {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>

      <ProfileMenu role={role} onLogout={onLogout} goSettings={goSettings} />
    </header>
  );
}

function RateChip({ label, value, tone, unit = "/g" }: { label: string; value?: string | null; tone: "gold" | "muted"; unit?: string }) {
  return (
    <div
      className={
        "flex flex-col leading-tight px-2.5 py-1 rounded-md border " +
        (tone === "gold"
          ? "border-gold/30 bg-gold-soft"
          : "border-border bg-muted")
      }
    >
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs font-semibold tabular-nums">{value ? `₹${value}${unit}` : "—"}</span>
    </div>
  );
}

function ProfileMenu({ role, onLogout, goSettings }: { role: string; onLogout: () => void; goSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const initial = (role || "U").charAt(0).toUpperCase();
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 h-8 pl-1 pr-1.5 rounded-full hover:bg-accent transition-colors"
        title="Profile"
      >
        <span className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-semibold">
          {initial}
        </span>
        <ChevronDown className="w-3 h-3 text-muted-foreground" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-50 w-52 rounded-lg border border-border bg-card shadow-lg py-1">
            <div className="px-3 py-2.5 border-b border-border">
              <div className="text-sm font-medium capitalize">{role || "User"}</div>
              <div className="text-xs text-muted-foreground">Signed in</div>
            </div>
            <button
              onClick={() => { goSettings(); setOpen(false); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors"
            >
              <Settings className="w-3.5 h-3.5 text-muted-foreground" /> Settings
            </button>
            <button
              onClick={() => { setShowPw(true); setOpen(false); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5 text-muted-foreground" /> Change password
            </button>
            <button
              onClick={() => { setOpen(false); onLogout(); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-destructive hover:bg-accent transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign out
            </button>
          </div>
        </>
      )}
      {showPw && <ChangePasswordModal onClose={() => setShowPw(false)} />}
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setError(null);
    if (newPw.length < 6) return setError("New password must be at least 6 characters.");
    if (newPw !== confirmPw) return setError("Passwords do not match.");
    setBusy(true);
    try {
      await api.changePassword(oldPw, newPw);
      setDone(true);
      setTimeout(onClose, 1200);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
      <div className="w-80 rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Change password</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="space-y-1">
            <Label>Current password</Label>
            <Input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1">
            <Label>New password</Label>
            <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Confirm new password</Label>
            <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          </div>
          {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
          {done && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">Password changed.</div>}
          <Button className="w-full" disabled={busy || done || !oldPw || !newPw} onClick={submit}>
            {busy ? "Updating…" : "Update password"}
          </Button>
        </div>
      </div>
    </div>
  );
}
