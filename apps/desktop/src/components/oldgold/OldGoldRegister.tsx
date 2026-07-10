import { useEffect, useMemo, useState } from "react";
import { RefreshCcwDot, X } from "lucide-react";
import * as api from "@/api";
import type { OldGoldRow, Department, ItemTag } from "@/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagSheet } from "@/components/inventory/TagSheet";
import { cn, formatDate, formatINR } from "@/lib/utils";

const STATUS_FILTERS = ["all", "in_scrap", "melted", "issued", "refined", "converted", "sold", "returned"] as const;
const statusBadge: Record<string, "default" | "secondary" | "success" | "destructive" | "warning"> = {
  in_scrap: "success",
  melted: "warning",
  issued: "default",
  refined: "default",
  converted: "default",
  sold: "secondary",
  returned: "destructive",
};

export function OldGoldRegister() {
  const [rows, setRows] = useState<OldGoldRow[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [convertRow, setConvertRow] = useState<OldGoldRow | null>(null);
  const [tagRows, setTagRows] = useState<ItemTag[] | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const reload = () => api.listOldGold().then(setRows).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  useEffect(() => {
    reload();
    api.listDepartments().then((d) => setDepts(d.filter((x) => x.active))).catch(() => {});
  }, []);

  const types = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.department) s.add(r.department);
    return [...s].sort();
  }, [rows]);

  const shown = useMemo(
    () => rows.filter((r) => (filter === "all" || r.status === filter) && (typeFilter === "all" || r.department === typeFilter)),
    [rows, filter, typeFilter],
  );

  // Physical scrap still in stock (gross + fine) — what's actually on hand.
  const inStock = rows.filter((r) => r.status === "in_scrap");
  const grossOnHand = inStock.reduce((a, r) => a + Number(r.gross_weight), 0);
  const fineOnHand = inStock.reduce((a, r) => a + Number(r.fine_weight ?? 0), 0);
  const valueOnHand = inStock.reduce((a, r) => a + Number(r.value), 0);

  async function onConverted(itemId: number, sku: string) {
    setConvertRow(null);
    setOk(`Converted to stock item ${sku}.`);
    await reload();
    try { setTagRows(await api.itemTags([itemId])); } catch { /* ignore */ }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Old Jewellery Register</h2>
        <p className="text-sm text-muted-foreground">Customer old jewellery taken in exchange — gold, silver, platinum and diamond ornaments; stock, refurbish-to-stock, and lifecycle.</p>
      </div>

      {/* Scrap-on-hand summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Gross in scrap</div>
          <div className="text-lg font-semibold tabular-nums">{grossOnHand.toFixed(3)} g</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Fine (pure) in scrap</div>
          <div className="text-lg font-semibold tabular-nums">{fineOnHand.toFixed(3)} g</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Value paid (in scrap)</div>
          <div className="text-lg font-semibold tabular-nums">{formatINR(valueOnHand)}</div>
        </Card>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-border">
        <div className="inline-flex h-9 items-center gap-0.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "inline-flex items-center px-3 py-2 text-sm capitalize transition-colors",
                filter === f ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.replace("_", " ")}
            </button>
          ))}
        </div>
        {types.length > 0 && (
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="all">All types</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-700 dark:text-green-400">{ok}</div>}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Lot</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Metal / purity</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Gross</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Fine</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Rate</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Value paid</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Invoice / customer</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2 font-mono text-xs">#{r.id}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs">{formatDate(r.created_at)}</td>
                <td className="px-3 py-2 text-xs">{r.department ?? "—"}</td>
                <td className="px-3 py-2 capitalize">
                  {r.metal}
                  {r.purity ? ` · ${r.purity}` : ""}
                </td>
                <td className="px-3 py-2 text-right font-mono">{Number(r.gross_weight).toFixed(3)}</td>
                <td className="px-3 py-2 text-right font-mono">{r.fine_weight ? Number(r.fine_weight).toFixed(3) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.rate)}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.value)}</td>
                <td className="px-3 py-2 text-xs">
                  <span className="font-mono">{r.document_no || "—"}</span>
                  {r.customer_name ? <span className="text-muted-foreground"> · {r.customer_name}</span> : ""}
                </td>
                <td className="px-3 py-2 text-center">
                  <Badge variant={statusBadge[r.status] || "secondary"}>{r.status.replace("_", " ")}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {r.status === "in_scrap" && (
                    <Button variant="outline" size="sm" onClick={() => { setOk(null); setConvertRow(r); }}>Convert to stock</Button>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">
                  <RefreshCcwDot className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No old jewellery{filter !== "all" ? ` (${filter.replace("_", " ")})` : ""}.</div>
                  <div className="text-xs mt-1">Old jewellery taken on a sale appears here; bought diamonds also enter loose-stone stock.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {convertRow && (
        <ConvertDialog row={convertRow} depts={depts} onClose={() => setConvertRow(null)} onDone={onConverted} onError={setError} />
      )}
      {tagRows && <TagSheet tags={tagRows} onClose={() => setTagRows(null)} />}
    </div>
  );
}

/** Refurbish an in-scrap old-jewellery lot into a barcoded stock item. */
function ConvertDialog({
  row, depts, onClose, onDone, onError,
}: {
  row: OldGoldRow;
  depts: Department[];
  onClose: () => void;
  onDone: (itemId: number, sku: string) => void | Promise<void>;
  onError: (m: string) => void;
}) {
  const lotDeptId = depts.find((d) => d.name === row.department)?.id;
  const [departmentId, setDepartmentId] = useState<number | "">(lotDeptId ?? "");
  const [gross, setGross] = useState(String(row.gross_weight));
  const [net, setNet] = useState(String(row.net_weight ?? row.gross_weight));
  const [repair, setRepair] = useState("");
  const [making, setMaking] = useState("");
  const [sku, setSku] = useState("");
  const [busy, setBusy] = useState(false);

  const paid = Number(row.value) || 0;
  const cost = paid + (parseFloat(repair) || 0) + (parseFloat(making) || 0);

  async function submit() {
    setBusy(true);
    try {
      const r = await api.convertOldGold(row.id, {
        department_id: departmentId === "" ? undefined : Number(departmentId),
        gross_weight: gross || undefined,
        net_weight: net || undefined,
        repair_cost: repair || undefined,
        making: making || undefined,
        sku: sku.trim() || undefined,
      });
      await onDone(r.item_id, r.sku);
    } catch (e) {
      onError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const fld = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="font-semibold text-sm">Convert lot #{row.id} to stock</div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-muted-foreground">
            {row.metal}{row.purity ? ` · ${row.purity}` : ""} · paid {formatINR(paid)} · refurbish into a barcoded stock item.
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Department (type)</label>
            <select className={fld} value={departmentId} onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— keep lot's type —</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Gross (g)</label>
              <Input value={gross} onChange={(e) => setGross(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Net (g)</label>
              <Input value={net} onChange={(e) => setNet(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Repair cost ₹</label>
              <Input value={repair} onChange={(e) => setRepair(e.target.value)} placeholder="0" inputMode="decimal" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Making ₹</label>
              <Input value={making} onChange={(e) => setMaking(e.target.value)} placeholder="0" inputMode="decimal" />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">SKU / barcode</label>
            <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="(auto-generate barcode)" />
          </div>
          <div className="flex items-center justify-between pt-1">
            <div className="text-sm">Stock cost <span className="font-mono font-semibold">{formatINR(cost)}</span></div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={submit} disabled={busy}>Convert</Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
