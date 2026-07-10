import { useEffect, useMemo, useState } from "react";
import { Gem } from "lucide-react";
import * as api from "@/api";
import type { LooseStoneRow, StoneTypeMaster } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, formatINR } from "@/lib/utils";

const FILTERS = ["in_stock", "used", "sold", "all"] as const;
const sel = "flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm";
const statusBadge: Record<string, "success" | "secondary" | "default"> = {
  in_stock: "success",
  used: "default",
  sold: "secondary",
};

export function LooseStones() {
  const [rows, setRows] = useState<LooseStoneRow[]>([]);
  const [stoneTypes, setStoneTypes] = useState<StoneTypeMaster[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("in_stock");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form
  const [typeId, setTypeId] = useState<number | "">("");
  const [desc, setDesc] = useState("");
  const [carat, setCarat] = useState("");
  const [pieces, setPieces] = useState("1");
  const [cost, setCost] = useState("");
  const [cert, setCert] = useState("");

  async function load() {
    try {
      const [ls, st] = await Promise.all([api.listLooseStones(), api.listStoneTypes()]);
      setRows(ls);
      setStoneTypes(st);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  const shown = useMemo(() => (filter === "all" ? rows : rows.filter((r) => r.status === filter)), [rows, filter]);
  const onHandValue = rows.filter((r) => r.status === "in_stock").reduce((a, r) => a + Number(r.cost_value), 0);

  async function add() {
    if (!cost || Number(cost) <= 0) return setError("Enter a cost value");
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.createLooseStone({
        stone_type_id: typeId === "" ? undefined : Number(typeId),
        description: desc || undefined,
        carat: carat || undefined,
        pieces: Number(pieces) || undefined,
        cost_value: cost,
        certificate_no: cert || undefined,
      });
      setOk("Loose stone added");
      setDesc(""); setCarat(""); setCost(""); setCert("");
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: number, status: "in_stock" | "used" | "sold") {
    try {
      await api.updateLooseStone(id, status);
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Loose Stones</h2>
          <p className="text-sm text-muted-foreground">Reusable stones — bought back from old jewellery or added manually. Set into new ornaments or sell.</p>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">In-stock value</div>
          <div className="font-semibold tabular-nums">{formatINR(onHandValue)}</div>
        </div>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Stone type</div>
            <select className={sel} value={typeId} onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">(generic)</option>
              {stoneTypes.filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Description</div>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Round VS1/G" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Carat</div>
            <Input value={carat} onChange={(e) => setCarat(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Pieces</div>
            <Input value={pieces} onChange={(e) => setPieces(e.target.value)} inputMode="numeric" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Cost ₹</div>
            <Input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" />
          </div>
          <Button onClick={add} disabled={busy}>Add stone</Button>
        </div>
        <div className="mt-2">
          <Input className="w-64" value={cert} onChange={(e) => setCert(e.target.value)} placeholder="Certificate no. (optional)" />
        </div>
      </Card>

      <div className="inline-flex h-9 items-center gap-0.5 border-b border-border">
        {FILTERS.map((f) => (
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
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Stone</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Carat / pcs</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cost</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Cert</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Source</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Action</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2">
                  {r.description}
                  {r.grade ? <span className="ml-1 text-xs text-muted-foreground">{r.grade}</span> : null}
                </td>
                <td className="px-3 py-2 text-right font-mono">{r.carat ? `${Number(r.carat).toFixed(3)} ct` : r.pieces ? `${r.pieces} pc` : "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.cost_value)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.certificate_no ? `${r.lab ?? ""} ${r.certificate_no}` : "—"}</td>
                <td className="px-3 py-2 text-xs capitalize">{r.source.replace("_", " ")}</td>
                <td className="px-3 py-2 text-center"><Badge variant={statusBadge[r.status]}>{r.status.replace("_", " ")}</Badge></td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {r.status === "in_stock" && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, "used")}>Mark used</Button>
                      <Button size="sm" variant="ghost" className="ml-1" onClick={() => setStatus(r.id, "sold")}>Sold</Button>
                    </>
                  )}
                  {r.status !== "in_stock" && (
                    <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, "in_stock")}>Restore</Button>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                  <Gem className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No loose stones{filter !== "all" ? ` (${filter.replace("_", " ")})` : ""}.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
