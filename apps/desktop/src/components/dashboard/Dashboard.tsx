import { useEffect, useState } from "react";
import { Receipt, IndianRupee, Landmark, Boxes, ShoppingCart, TrendingUp, ArrowDownRight, ArrowUpRight, Coins, RefreshCcwDot } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as api from "@/api";
import type { DashboardMetrics } from "@/api";
import { Card } from "@/components/ui/card";
import { formatINR } from "@/lib/utils";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleString("en-US", { month: "short" });

export function Dashboard() {
  const [d, setD] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dashboardMetrics().then(setD).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, []);

  const trendMax = d ? Math.max(1, ...d.trend.map((t) => Number(t.sales))) : 1;
  const gstNet = d ? Number(d.month.gst_net) : 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Business at a glance</p>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

      {/* Today */}
      <div>
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Today</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi icon={IndianRupee} tone="emerald" label="Sales today" value={d ? formatINR(d.today.sales) : "—"} sub={d ? `${d.today.bills} bill${d.today.bills !== 1 ? "s" : ""}` : ""} />
          <Kpi icon={RefreshCcwDot} tone="amber" label="Old jewellery in" value={d ? formatINR(d.today.old_gold) : "—"} sub="exchange value" />
          <Kpi icon={Receipt} tone="sky" label="Bills this month" value={d ? String(d.month.bills) : "—"} sub="count" />
          <Kpi icon={TrendingUp} tone="violet" label="Sales this month" value={d ? formatINR(d.month.sales) : "—"} sub="incl. GST" />
        </div>
      </div>

      {/* Money position */}
      <div>
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">This month & position</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi icon={ShoppingCart} tone="slate" label="Purchases" value={d ? formatINR(d.month.purchases) : "—"} sub="this month" />
          <Kpi icon={Landmark} tone={gstNet >= 0 ? "rose" : "emerald"} label={gstNet >= 0 ? "GST payable" : "ITC credit"} value={d ? formatINR(Math.abs(gstNet)) : "—"} sub={d ? `out ${formatINR(d.month.gst_output)} · in ${formatINR(d.month.gst_input)}` : ""} />
          <Kpi icon={ArrowUpRight} tone="emerald" label="Receivable" value={d ? formatINR(d.outstanding.receivable) : "—"} sub="parties owe us" />
          <Kpi icon={ArrowDownRight} tone="rose" label="Payable" value={d ? formatINR(d.outstanding.payable) : "—"} sub="we owe" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Sales trend */}
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Sales — last 6 months</h3>
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="flex items-end justify-between gap-2 h-40">
            {d?.trend.map((t) => {
              const h = Math.round((Number(t.sales) / trendMax) * 100);
              return (
                <div key={t.month} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                  <div className="text-[10px] text-muted-foreground font-mono">{Number(t.sales) > 0 ? `${(Number(t.sales) / 100000).toFixed(1)}L` : ""}</div>
                  <div className="w-full rounded-t bg-primary/70 hover:bg-primary transition-colors" style={{ height: `${Math.max(h, 2)}%` }} title={formatINR(t.sales)} />
                  <div className="text-[11px] text-muted-foreground">{monthLabel(t.month)}</div>
                </div>
              );
            })}
            {!d && <div className="text-sm text-muted-foreground m-auto">Loading…</div>}
          </div>
        </Card>

        {/* Stock */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Stock on hand</h3>
            <Boxes className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="text-2xl font-semibold">{d ? formatINR(d.stock.value) : "—"}</div>
          <div className="text-xs text-muted-foreground mb-3">{d ? `${d.stock.pieces} pieces · ${Number(d.stock.net_weight).toFixed(3)} g net` : ""}</div>
          <div className="space-y-1.5">
            {d?.by_metal.map((m) => (
              <div key={m.metal} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5"><Coins className="w-3.5 h-3.5 text-amber-500" /> {cap(m.metal)}</span>
                <span className="font-mono text-xs">{Number(m.net_weight).toFixed(1)}g · {formatINR(m.value)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Collections by mode */}
      {d && d.collections.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold">Collections by mode — this month</h3>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {d.collections.map((c) => (
                <tr key={c.mode} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 capitalize">{c.mode.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2 text-right font-mono">{formatINR(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

const TONES: Record<string, string> = {
  emerald: "bg-emerald-500/10 text-emerald-600",
  amber: "bg-amber-500/10 text-amber-600",
  sky: "bg-sky-500/10 text-sky-600",
  violet: "bg-violet-500/10 text-violet-600",
  slate: "bg-slate-500/10 text-slate-500",
  rose: "bg-rose-500/10 text-rose-600",
};

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: LucideIcon; label: string; value: string; sub?: string; tone: string }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2">
        <span className={`inline-flex w-8 h-8 items-center justify-center rounded-lg ${TONES[tone]}`}><Icon className="w-4 h-4" /></span>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
      <div className="mt-2 text-xl font-semibold leading-tight truncate" title={value}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground truncate">{sub}</div>}
    </Card>
  );
}
