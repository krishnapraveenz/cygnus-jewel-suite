import { useEffect, useMemo, useState } from "react";
import { Recycle } from "lucide-react";
import * as api from "@/api";
import type { MetalOpt, ResaleItemRow } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, formatINR } from "@/lib/utils";

const sel = "flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm";

export function Resale() {
  const [rows, setRows] = useState<ResaleItemRow[]>([]);
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [filter, setFilter] = useState<"in_stock" | "sold" | "all">("in_stock");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form
  const [desc, setDesc] = useState("");
  const [metalId, setMetalId] = useState<number | "">("");
  const [purityId, setPurityId] = useState<number | "">("");
  const [gross, setGross] = useState("");
  const [cost, setCost] = useState("");
  // Sell
  const [sellId, setSellId] = useState<number | null>(null);
  const [sellPrice, setSellPrice] = useState("");

  async function load() {
    try {
      const [rs, m] = await Promise.all([api.listResaleItems(), api.listMetals()]);
      setRows(rs);
      setMetals(m);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  const purities = useMemo(() => metals.find((m) => m.metal_type_id === metalId)?.purities ?? [], [metals, metalId]);
  const shown = useMemo(() => (filter === "all" ? rows : rows.filter((r) => r.status === filter)), [rows, filter]);

  async function add() {
    if (!desc.trim() || !cost) return setError("Description and purchase cost required");
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.createResaleItem({
        description: desc,
        metal_type_id: metalId === "" ? undefined : Number(metalId),
        purity_id: purityId === "" ? undefined : Number(purityId),
        gross_weight: gross || undefined,
        purchase_cost: cost,
      });
      setOk("Used piece added to resale stock");
      setDesc(""); setGross(""); setCost("");
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function sell(id: number) {
    if (!sellPrice || Number(sellPrice) <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.sellResaleItem(id, { sale_price: sellPrice });
      setOk(`Sold — margin ${formatINR(r.margin)}, GST on margin ${formatINR(r.gst)}, total ${formatINR(r.total)}`);
      setSellId(null);
      setSellPrice("");
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Resale (Used)</h2>
        <p className="text-sm text-muted-foreground">
          Second-hand pieces resold as-is. Under the GST margin scheme, tax applies only to the margin (sale − cost).
        </p>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <div className="md:col-span-2">
            <div className="text-xs text-muted-foreground mb-1">Description</div>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Used 22K bangle" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Metal</div>
            <select className={sel} value={metalId} onChange={(e) => { setMetalId(e.target.value ? Number(e.target.value) : ""); setPurityId(""); }}>
              <option value="">—</option>
              {metals.map((m) => <option key={m.metal_type_id} value={m.metal_type_id}>{m.metal}</option>)}
            </select>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Purity</div>
            <select className={sel} value={purityId} onChange={(e) => setPurityId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">—</option>
              {purities.map((p) => <option key={p.purity_id} value={p.purity_id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Purchase cost ₹</div>
            <Input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" />
          </div>
          <Button onClick={add} disabled={busy}>Add</Button>
        </div>
      </Card>

      <div className="inline-flex h-9 items-center gap-0.5 border-b border-border">
        {(["in_stock", "sold", "all"] as const).map((f) => (
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

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Description</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Metal</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cost</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Sale</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Margin</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">GST</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Action</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2">{r.description}</td>
                <td className="px-3 py-2 capitalize text-xs">{r.metal ? `${r.metal} ${r.purity ?? ""}` : "—"}{r.gross_weight ? ` · ${Number(r.gross_weight).toFixed(3)}g` : ""}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.purchase_cost)}</td>
                <td className="px-3 py-2 text-right font-mono">{r.sale_price ? formatINR(r.sale_price) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{r.margin ? formatINR(r.margin) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{r.gst ? formatINR(r.gst) : "—"}</td>
                <td className="px-3 py-2 text-center"><Badge variant={r.status === "in_stock" ? "success" : "secondary"}>{r.status.replace("_", " ")}</Badge></td>
                <td className="px-3 py-2 text-right">
                  {r.status === "in_stock" &&
                    (sellId === r.id ? (
                      <span className="inline-flex items-center gap-1">
                        <Input className="h-7 w-28 text-right" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} placeholder="sale ₹" inputMode="decimal" autoFocus />
                        <Button size="sm" disabled={busy} onClick={() => sell(r.id)}>Sell</Button>
                        <Button size="sm" variant="ghost" onClick={() => setSellId(null)}>✕</Button>
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => { setSellId(r.id); setSellPrice(""); }}>Sell (margin)</Button>
                    ))}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  <Recycle className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No resale pieces{filter !== "all" ? ` (${filter.replace("_", " ")})` : ""}.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
