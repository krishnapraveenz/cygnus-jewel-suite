import { useEffect, useMemo, useState } from "react";
import { FileText, Plus, Pencil, Trash2, ArrowRight } from "lucide-react";
import * as api from "@/api";
import type { EstimateListRow } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/lib/dialog";
import { formatDate, formatINR } from "@/lib/utils";

/** Estimates list — shows only open (active) estimates. Converted/expired disappear. */
export function Estimates({ reloadKey, onNew, onEdit }: { reloadKey?: number; onNew?: () => void; onEdit?: (id: number) => void }) {
  const [rows, setRows] = useState<EstimateListRow[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function load() {
    api.listEstimates().then(setRows).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }
  useEffect(() => { load(); }, [reloadKey]);

  // Show only open estimates (converted + expired disappear from the working list).
  const open = useMemo(() => rows.filter((r) => r.status === "open"), [rows]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return open;
    return open.filter((r) => (r.document_no ?? "").toLowerCase().includes(t) || (r.customer_name ?? "").toLowerCase().includes(t));
  }, [open, q]);

  async function del(id: number, docNo: string) {
    if (!(await confirm({ title: "Delete estimate", message: `Permanently delete ${docNo}? This cannot be undone.` }))) return;
    setError(null); setOk(null);
    try {
      await api.deleteEstimate(id);
      setOk(`${docNo} deleted.`);
      load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  async function convert(id: number, docNo: string) {
    if (!(await confirm({ title: "Convert to invoice", message: `Convert ${docNo} to a final invoice? The estimate will close.` }))) return;
    setError(null); setOk(null);
    try {
      const r = await api.convertEstimate(id, {});
      setOk(`Converted → ${r.document_no}`);
      load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{open.length} open estimate{open.length !== 1 ? "s" : ""}</span>
        <div className="flex items-center gap-2">
          {onNew && <Button size="sm" onClick={onNew}><Plus className="w-4 h-4 mr-1" /> New Estimate</Button>}
          <Input className="w-64" placeholder="Search estimate no. / customer…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-700 dark:text-green-400">{ok}</div>}
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border text-xs">
              <th className="text-left px-3 py-2">Estimate no.</th>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">Customer</th>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-right px-3 py-2">Grand total</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                <td className="px-3 py-2 font-mono text-xs">{r.document_no || `#${r.id}`}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs">{formatDate(r.created_at)}</td>
                <td className="px-3 py-2">{r.customer_name || "Walk-in"}</td>
                <td className="px-3 py-2 capitalize text-xs">{r.type}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.grand_total)}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {onEdit && (
                      <button onClick={() => onEdit(r.id)} className="text-xs text-primary hover:underline flex items-center gap-0.5" title="Edit">
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                    )}
                    <button onClick={() => convert(r.id, r.document_no || `#${r.id}`)} className="text-xs text-green-700 dark:text-green-400 hover:underline flex items-center gap-0.5" title="Convert to invoice">
                      <ArrowRight className="w-3.5 h-3.5" /> Invoice
                    </button>
                    <button onClick={() => del(r.id, r.document_no || `#${r.id}`)} className="text-xs text-destructive hover:underline flex items-center gap-0.5" title="Delete">
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">{q ? "No matching estimates." : "No open estimates."}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
