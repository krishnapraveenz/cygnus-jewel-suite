import { useEffect, useMemo, useState } from "react";
import { IndianRupee, Wand2, Save, Gem } from "lucide-react";
import * as api from "@/api";
import type { MetalOpt, RateRow } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { cn, formatDate, formatINR } from "@/lib/utils";

type RowState = { sell: string; buy: string; cash: string };

const todayISO = () => new Date().toISOString().slice(0, 10);
const metalAccent: Record<string, string> = {
  gold: "text-amber-600",
  silver: "text-slate-500",
  platinum: "text-cyan-600",
};

export function DailyRates() {
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [history, setHistory] = useState<RateRow[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [diaRate, setDiaRate] = useState("");
  const [stoneRate, setStoneRate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [m, h, s] = await Promise.all([api.listMetals(), api.listRates(), api.getSettings()]);
      setMetals(m);
      setHistory(h);
      setDiaRate(s["rates.diamond_per_ct"] ?? "");
      setStoneRate(s["rates.stone_per_g"] ?? "");
      const init: Record<number, RowState> = {};
      for (const mt of m)
        for (const p of mt.purities)
          init[p.purity_id] = { sell: p.sell_rate ?? "", buy: p.buy_rate ?? "", cash: p.cash_rate ?? "" };
      setRows(init);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  function setCell(pid: number, key: keyof RowState, val: string) {
    setRows((r) => ({ ...r, [pid]: { ...r[pid], [key]: val } }));
    setOk(null);
  }

  // Derive a metal's other purities from its purest (highest-fineness) row by fineness ratio.
  function autoFill(mt: MetalOpt) {
    const base = [...mt.purities].sort((a, b) => b.fineness - a.fineness)[0];
    if (!base) return;
    const b = rows[base.purity_id];
    if (!b) return;
    const scale = (v: string, f: number) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 ? String(Math.round((n * f) / base.fineness)) : "";
    };
    setRows((r) => {
      const next = { ...r };
      for (const p of mt.purities) {
        next[p.purity_id] = {
          sell: scale(b.sell, p.fineness),
          buy: scale(b.buy, p.fineness),
          cash: scale(b.cash, p.fineness),
        };
      }
      return next;
    });
    setOk(null);
  }

  async function saveBoard() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      let saved = 0;
      for (const mt of metals) {
        for (const p of mt.purities) {
          const r = rows[p.purity_id];
          if (!r) continue;
          const sell = parseFloat(r.sell);
          const buy = parseFloat(r.buy || r.sell);
          if (!(sell > 0)) continue; // only post rows with a sell rate
          await api.createRate({
            metal_type_id: mt.metal_type_id,
            purity_id: p.purity_id,
            sell_rate: r.sell,
            buy_rate: String(buy > 0 ? buy : sell),
            cash_rate: r.cash || undefined,
            // For today, let the server stamp now() so this board is the latest;
            // only send an explicit date when back-dating.
            effective_date: date === todayISO() ? undefined : date,
          });
          saved++;
        }
      }
      await api.setSetting("rates.diamond_per_ct", diaRate.trim());
      await api.setSetting("rates.stone_per_g", stoneRate.trim());
      setOk(`Saved ${saved} rate${saved === 1 ? "" : "s"} for ${date}.`);
      // Notify the topbar ticker (and anything else) that rates changed.
      window.dispatchEvent(new Event("cygnus:rates"));
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const goldBase = useMemo(() => {
    const g = metals.find((m) => m.metal === "gold");
    return g ? [...g.purities].sort((a, b) => b.fineness - a.fineness)[0]?.label : undefined;
  }, [metals]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">Daily Rates</h2>
          <p className="text-sm text-muted-foreground">
            Set today's rate board per gram — Sell (billing), Buy (old-gold exchange), Cash (buy-back).
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Rate date</div>
            <DateField value={date} onChange={setDate} className="w-44" />
          </div>
          <Button onClick={saveBoard} disabled={busy}>
            <Save className="w-4 h-4 mr-1" /> {busy ? "Saving…" : "Save board"}
          </Button>
        </div>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      {metals.map((mt) => (
        <Card key={mt.metal_type_id} className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div className={cn("text-sm font-semibold capitalize", metalAccent[mt.metal])}>{mt.metal}</div>
            {mt.metal === "gold" && mt.purities.length > 1 && (
              <Button size="sm" variant="outline" onClick={() => autoFill(mt)}>
                <Wand2 className="w-3.5 h-3.5 mr-1" /> Auto-fill from {goldBase}
              </Button>
            )}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground w-40">Purity</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Sell ₹/g</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Buy / exchange ₹/g</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cash / buy-back ₹/g</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground w-32">Current</th>
              </tr>
            </thead>
            <tbody>
              {mt.purities.map((p) => {
                const r = rows[p.purity_id] ?? { sell: "", buy: "", cash: "" };
                return (
                  <tr key={p.purity_id} className="border-b border-border last:border-0">
                    <td className="px-4 py-1.5">
                      <span className="font-medium">{p.label}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{p.fineness}/1000</span>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={r.sell} onChange={(e) => setCell(p.purity_id, "sell", e.target.value)} />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={r.buy} onChange={(e) => setCell(p.purity_id, "buy", e.target.value)} placeholder="= sell" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={r.cash} onChange={(e) => setCell(p.purity_id, "cash", e.target.value)} placeholder="optional" />
                    </td>
                    <td className="px-4 py-1.5 text-right text-xs text-muted-foreground tabular-nums">
                      {p.sell_rate ? formatINR(p.sell_rate) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}

      {metals.length === 0 && (
        <Card className="p-10 text-center text-muted-foreground">
          <IndianRupee className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <div className="text-sm">No metals configured.</div>
        </Card>
      )}

      {/* Diamond & stone default rates — pre-fill the inline Dia ₹/ct & Stone ₹/g on sale/purchase lines */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
          <Gem className="w-4 h-4 text-sky-500" /> Diamonds &amp; Stones
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 max-w-xl">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Diamond rate ₹/ct</div>
            <Input className="h-9 text-right tabular-nums" inputMode="decimal" value={diaRate} placeholder="e.g. 185000" onChange={(e) => { setDiaRate(e.target.value); setOk(null); }} />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Stone rate ₹/g</div>
            <Input className="h-9 text-right tabular-nums" inputMode="decimal" value={stoneRate} placeholder="e.g. 200" onChange={(e) => { setStoneRate(e.target.value); setOk(null); }} />
          </div>
        </div>
        <div className="px-4 pb-3 text-xs text-muted-foreground">
          These pre-fill the <b>Dia ₹/ct</b> and <b>Stone ₹/g</b> on new sale &amp; purchase lines. You can still override per line, and graded diamonds use their grade rate from the Stones catalogue. Saved with <b>Save board</b>.
        </div>
      </Card>

      <Card className="overflow-hidden">
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="flex w-full items-center justify-between border-b border-border px-4 py-2.5 text-sm font-medium hover:bg-accent/40"
        >
          <span>Rate history</span>
          <span className="text-xs text-muted-foreground">{showHistory ? "Hide" : `Show (${history.length})`}</span>
        </button>
        {showHistory && (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Metal</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Purity</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Sell ₹/g</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Buy ₹/g</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Cash ₹/g</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r, i) => (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-accent/40">
                    <td className="px-4 py-1.5 text-muted-foreground">{formatDate(r.effective_from)}</td>
                    <td className="px-3 py-1.5 capitalize">{r.metal}</td>
                    <td className="px-3 py-1.5">{r.purity}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatINR(r.sell_rate)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatINR(r.buy_rate)}</td>
                    <td className="px-4 py-1.5 text-right font-mono">{r.cash_rate ? formatINR(r.cash_rate) : "—"}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">
                      No rate history yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Tip: enter the 24K Sell rate and click <b>Auto-fill</b> — 22K, 18K and 14K are computed by fineness
        (e.g. 22K = 24K × 916/999). Buy defaults to the Sell rate if left blank.
      </p>
    </div>
  );
}
