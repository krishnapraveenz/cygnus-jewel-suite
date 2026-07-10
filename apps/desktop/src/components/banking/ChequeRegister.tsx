import { useEffect, useState } from "react";
import { Banknote } from "lucide-react";
import * as api from "@/api";
import type { ChequeRow } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatINR } from "@/lib/utils";

const FILTERS = ["all", "received", "deposited", "cleared", "bounced"] as const;
const badgeVariant: Record<string, "default" | "secondary" | "success" | "destructive" | "warning"> = {
  received: "warning",
  deposited: "default",
  cleared: "success",
  bounced: "destructive",
};

export function ChequeRegister() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [rows, setRows] = useState<ChequeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  async function load() {
    try {
      setRows(await api.listCheques(filter === "all" ? undefined : filter));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, [filter]);

  async function move(id: number, status: string) {
    setBusy(id);
    setError(null);
    try {
      await api.updateCheque(id, { status });
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  const pending = rows.filter((r) => r.status === "received" || r.status === "deposited");
  const pendingTotal = pending.reduce((a, r) => a + Number(r.amount), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Cheque Register</h2>
          <p className="text-sm text-muted-foreground">Track cheques from receipt to clearing</p>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Uncleared</div>
          <div className="font-semibold tabular-nums">{formatINR(pendingTotal)}</div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="inline-flex h-9 items-center gap-0.5 border-b border-border">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "inline-flex items-center px-3 py-2 text-sm capitalize transition-colors",
              filter === f ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Cheque no.</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Customer</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Invoice</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Amount</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Received</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2 font-mono text-xs">{r.cheque_no || `#${r.id}`}</td>
                <td className="px-3 py-2">{r.customer_name || "Walk-in"}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.document_no || "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.amount)}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs">{formatDate(r.received_at)}</td>
                <td className="px-3 py-2 text-center"><Badge variant={badgeVariant[r.status] || "secondary"}>{r.status}</Badge></td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {r.status === "received" && (
                    <Button variant="outline" size="sm" disabled={busy === r.id} onClick={() => move(r.id, "deposited")}>Deposit</Button>
                  )}
                  {(r.status === "received" || r.status === "deposited") && (
                    <>
                      <Button variant="ghost" size="sm" className="ml-1 text-success" disabled={busy === r.id} onClick={() => move(r.id, "cleared")}>Clear</Button>
                      <Button variant="ghost" size="sm" className="ml-1 text-destructive" disabled={busy === r.id} onClick={() => move(r.id, "bounced")}>Bounce</Button>
                    </>
                  )}
                  {(r.status === "cleared" || r.status === "bounced") && <span className="text-xs text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                  <Banknote className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No cheques{filter !== "all" ? ` (${filter})` : ""}.</div>
                  <div className="text-xs mt-1">Cheques entered as a payment on an invoice appear here.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
