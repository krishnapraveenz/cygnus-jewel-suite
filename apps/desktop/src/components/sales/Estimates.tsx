import { useEffect, useMemo, useState } from "react";
import { FileText, Plus } from "lucide-react";
import * as api from "@/api";
import type { EstimateListRow } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatINR } from "@/lib/utils";

const statusBadge: Record<string, "default" | "secondary" | "success" | "warning"> = {
  open: "default",
  converted: "success",
  expired: "secondary",
};

/** Estimates list (read-only browse). Create/convert happen in the Sales form overlay. */
export function Estimates({ reloadKey, onNew }: { reloadKey?: number; onNew?: () => void }) {
  const [rows, setRows] = useState<EstimateListRow[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listEstimates().then(setRows).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [reloadKey]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) => (r.document_no ?? "").toLowerCase().includes(t) || (r.customer_name ?? "").toLowerCase().includes(t));
  }, [rows, q]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        {onNew && (
          <Button size="sm" onClick={onNew} title="New estimate">
            <Plus className="w-4 h-4 mr-1" /> New Estimate
          </Button>
        )}
        <Input className="w-64" placeholder="Search estimate no. / customer…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border text-xs">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Estimate no.</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Customer</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Grand total</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2 font-mono text-xs">{r.document_no || `#${r.id}`}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs">{formatDate(r.created_at)}</td>
                <td className="px-3 py-2">{r.customer_name || "Walk-in"}</td>
                <td className="px-3 py-2 capitalize text-xs">{r.type}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.grand_total)}</td>
                <td className="px-3 py-2 text-center">
                  <Badge variant={statusBadge[r.status] || "secondary"}>{r.status}</Badge>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">{q ? "No matching estimates." : "No estimates yet."}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
