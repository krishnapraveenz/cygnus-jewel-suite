import { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import type { StoneTypeMaster, LineStoneReq } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatINR } from "@/lib/utils";

type Row = { stoneTypeId: number | "" | "generic"; qualityId: number | ""; carat: string; pieces: string; rate: string; amount: string; weightUnit: "ct" | "g" };
const emptyRow = (): Row => ({ stoneTypeId: "generic", qualityId: "", carat: "", pieces: "1", rate: "", amount: "", weightUnit: "ct" });
const sel = "h-8 rounded-md border border-input bg-background px-2 text-sm";

/** Build a line's stone value from the Materials catalogue and apply it. */
export function StonePicker({
  stoneTypes,
  onApply,
  onClose,
}: {
  stoneTypes: StoneTypeMaster[];
  onApply: (total: number, stones: LineStoneReq[]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([emptyRow()]);

  // Weight in carats (the entry may be in grams: 1 ct = 0.2 g) — used for the stored
  // stone weight, NOT for the amount (which uses the rate in the chosen unit).
  function caratValue(r: Row): number {
    const w = Number(r.carat) || 0;
    return r.weightUnit === "g" ? w / 0.2 : w;
  }
  // Auto-computed value. For typed rates the rate is per the chosen unit (₹/g or ₹/ct),
  // so amount = rate × weight-as-typed. Quality grades are always per carat.
  function computed(r: Row): number {
    const w = Number(r.carat) || 0;
    if (r.stoneTypeId === "generic") return (Number(r.rate) || 0) * w;
    const st = stoneTypes.find((s) => s.id === r.stoneTypeId);
    if (!st) return 0;
    if (st.pricing_mode === "per_carat_quality") {
      const q = st.qualities.find((x) => x.id === r.qualityId);
      return (q ? Number(q.rate_per_carat) : 0) * caratValue(r);
    }
    if (st.pricing_mode === "per_carat_flat") return (Number(r.rate) || 0) * w;
    return (Number(r.rate) || 0) * (Number(r.pieces) || 0); // per_piece
  }
  // Final value: a manually-entered amount overrides the computed one.
  function rowValue(r: Row): number {
    if (r.amount.trim() !== "") return Number(r.amount) || 0;
    return computed(r);
  }
  const total = rows.reduce((a, r) => a + rowValue(r), 0);

  function set(i: number, patch: Partial<Row>) {
    // Changing a pricing input clears any manual amount so the value recomputes.
    const touchesPricing = ["stoneTypeId", "qualityId", "carat", "pieces", "rate", "weightUnit"].some((k) => k in patch);
    const extra = touchesPricing && !("amount" in patch) ? { amount: "" } : {};
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch, ...extra } : r)));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="font-semibold text-sm">Stones — value from catalogue</div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Stone</th>
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Rate / grade</th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Qty (pcs)</th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Weight</th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Amount ₹</th>
                <th className="px-2 py-1.5 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const st = stoneTypes.find((s) => s.id === r.stoneTypeId);
                return (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-1 py-1">
                      <select
                        className={`${sel} w-36`}
                        value={r.stoneTypeId}
                        onChange={(e) => set(i, { stoneTypeId: e.target.value === "generic" ? "generic" : e.target.value ? Number(e.target.value) : "", qualityId: "" })}
                      >
                        <option value="generic">Stone</option>
                        {stoneTypes.filter((s) => s.active).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      {r.stoneTypeId === "generic" ? (
                        <Input className="h-8 w-28 text-right" placeholder={`₹/${r.weightUnit}`} value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} inputMode="decimal" />
                      ) : st?.pricing_mode === "per_carat_quality" ? (
                        <select className={`${sel} w-48`} value={r.qualityId} onChange={(e) => set(i, { qualityId: e.target.value ? Number(e.target.value) : "" })}>
                          <option value="">grade…</option>
                          {st.qualities.filter((q) => q.active).map((q) => (
                            <option key={q.id} value={q.id}>
                              {q.grade_label} · {formatINR(q.rate_per_carat)}/ct
                            </option>
                          ))}
                        </select>
                      ) : st ? (
                        <Input className="h-8 w-28 text-right" placeholder={st.unit === "piece" ? "₹/pc" : `₹/${r.weightUnit}`} value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} inputMode="decimal" />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-1 py-1 text-right">
                      <Input className="h-8 w-16 text-right" placeholder="pcs" value={r.pieces} onChange={(e) => set(i, { pieces: e.target.value })} inputMode="numeric" />
                    </td>
                    <td className="px-1 py-1 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Input className="h-8 w-16 text-right" placeholder={r.weightUnit === "g" ? "grams" : "carat"} value={r.carat} onChange={(e) => set(i, { carat: e.target.value })} inputMode="decimal" />
                        <select className={`${sel} px-1`} value={r.weightUnit} onChange={(e) => set(i, { weightUnit: e.target.value as "ct" | "g" })}>
                          <option value="ct">ct</option>
                          <option value="g">g</option>
                        </select>
                      </div>
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Input
                        className="h-8 w-28 text-right font-mono"
                        value={r.amount.trim() !== "" ? r.amount : computed(r) ? String(Math.round(computed(r) * 100) / 100) : ""}
                        placeholder="₹ amount"
                        onChange={(e) => setRows((rs) => rs.map((row, idx) => (idx === i ? { ...row, amount: e.target.value } : row)))}
                        inputMode="decimal"
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <button
                        className="rounded p-1 text-muted-foreground hover:text-destructive"
                        onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs))}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
              <Plus className="w-4 h-4 mr-1" /> Add stone
            </Button>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                Total stone value <span className="font-mono font-semibold text-foreground">{formatINR(total)}</span>
              </span>
              <Button onClick={() => {
                const stones: LineStoneReq[] = rows
                  .filter((r) => rowValue(r) > 0)
                  .map((r) => {
                    const ct = caratValue(r);
                    const pcs = Number(r.pieces) || undefined;
                    if (r.stoneTypeId === "generic") {
                      return {
                        description: "Stone",
                        carat: ct > 0 ? String(+ct.toFixed(3)) : undefined,
                        pieces: pcs,
                        rate: r.rate || undefined,
                        value: String(Math.round(rowValue(r) * 100) / 100),
                      };
                    }
                    const st = stoneTypes.find((s) => s.id === r.stoneTypeId)!;
                    const q = st.pricing_mode === "per_carat_quality" ? st.qualities.find((x) => x.id === r.qualityId) : undefined;
                    const rate = q ? q.rate_per_carat : r.rate || undefined;
                    return {
                      stone_type_id: st.id,
                      stone_quality_id: q?.id,
                      description: st.name + (q ? ` ${q.grade_label}` : ""),
                      carat: ct > 0 ? String(+ct.toFixed(3)) : undefined,
                      pieces: pcs,
                      rate: rate ? String(rate) : undefined,
                      value: String(Math.round(rowValue(r) * 100) / 100),
                    };
                  });
                onApply(Math.round(total * 100) / 100, stones);
              }}>Apply to line</Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Diamonds (quality-priced) use the saved per-carat grade rate; other stones take a rate you enter. You can also type the <span className="font-medium">Amount</span> directly to override the computed value. Adds to the line's stone value.
          </p>
        </div>
      </Card>
    </div>
  );
}
