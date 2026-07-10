import { useEffect, useMemo, useState } from "react";
import { Boxes, Save, Printer, ScanLine, Grid3x3 } from "lucide-react";
import * as api from "@/api";
import type { StockCountView, StockCountLine } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TagScan } from "@/components/banking/TagScan";
import { formatDate, formatDateTime } from "@/lib/utils";

type PhysRow = { nos: string; gross: string; ct: string; stone: string; net: string };
const MEASURES = [
  { key: "nos", label: "Nos", bookKey: "book_nos", physKey: "phys_nos", int: true },
  { key: "gross", label: "Gross (g)", bookKey: "book_gross", physKey: "phys_gross", int: false },
  { key: "ct", label: "Dia CT", bookKey: "book_ct", physKey: "phys_ct", int: false },
  { key: "stone", label: "Stone (g)", bookKey: "book_stone", physKey: "phys_stone", int: false },
  { key: "net", label: "Net (g)", bookKey: "book_net", physKey: "phys_net", int: false },
] as const;

const num = (v: unknown) => { const n = Number(v ?? 0); return isNaN(n) ? 0 : n; };
const w = (v: unknown, int = false) => {
  const n = num(v);
  return int ? String(Math.round(n)) : n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
};

export function StockCount({ date }: { date: string }) {
  const [view, setView] = useState<StockCountView | null>(null);
  const [phys, setPhys] = useState<Record<string, PhysRow>>({});
  const [method, setMethod] = useState<"category" | "tag">("category");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const v = await api.getStockCount(date);
      setView(v);
      if (v.count?.method === "tag" || v.count?.method === "category") setMethod(v.count.method);
      const seed: Record<string, PhysRow> = {};
      v.lines.forEach((l) => {
        seed[l.bucket_key] = {
          nos: l.phys_nos != null ? String(l.phys_nos) : "",
          gross: l.phys_gross ?? "", ct: l.phys_ct ?? "", stone: l.phys_stone ?? "", net: l.phys_net ?? "",
        };
      });
      setPhys(seed);
      setNotes(v.count?.notes ?? "");
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const readOnly = view?.session_status === "closed";
  const groups = useMemo(() => {
    const m = new Map<string, StockCountLine[]>();
    (view?.lines ?? []).forEach((l) => { if (!m.has(l.group_label)) m.set(l.group_label, []); m.get(l.group_label)!.push(l); });
    return Array.from(m.entries());
  }, [view]);

  function setCell(key: string, field: keyof PhysRow, val: string) {
    setPhys((p) => ({ ...p, [key]: { ...(p[key] ?? { nos: "", gross: "", ct: "", stone: "", net: "" }), [field]: val } }));
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const lines = (view?.lines ?? []).map((l) => {
        const p = phys[l.bucket_key] ?? { nos: "", gross: "", ct: "", stone: "", net: "" };
        return {
          bucket_key: l.bucket_key,
          phys_nos: p.nos !== "" ? Math.round(num(p.nos)) : undefined,
          phys_gross: p.gross !== "" ? String(num(p.gross)) : undefined,
          phys_ct: p.ct !== "" ? String(num(p.ct)) : undefined,
          phys_stone: p.stone !== "" ? String(num(p.stone)) : undefined,
          phys_net: p.net !== "" ? String(num(p.net)) : undefined,
        };
      });
      await api.saveStockCount({ business_date: date, notes: notes || undefined, lines });
      await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  // variance for a measure on a line (physical − book), or null if not entered
  const variance = (l: StockCountLine, mk: typeof MEASURES[number]) => {
    const p = phys[l.bucket_key]?.[mk.key as keyof PhysRow];
    if (p === "" || p == null) return null;
    return num(p) - num((l as any)[mk.bookKey]);
  };

  function printSheet() {
    if (!view) return;
    let body = "";
    groups.forEach(([g, lines]) => {
      const rows = lines.map((l) => {
        const cells = MEASURES.map((mk) => {
          const p = phys[l.bucket_key]?.[mk.key as keyof PhysRow];
          const v = variance(l, mk);
          const dv = v == null ? "" : (v === 0 ? "0" : (v > 0 ? "+" : "") + w(v, mk.int));
          return `<td style="text-align:right">${w((l as any)[mk.bookKey], mk.int)}</td><td style="text-align:right">${p ?? ""}</td><td style="text-align:right;color:${v && Math.abs(v) > 0.0001 ? "#b91c1c" : "#666"}">${dv}</td>`;
        }).join("");
        return `<tr><td>${l.category_label}</td>${cells}</tr>`;
      }).join("");
      body += `<h3>${g}</h3><table><tr><th>Category</th>${MEASURES.map((m) => `<th colspan="3">${m.label}</th>`).join("")}</tr>
        <tr><th></th>${MEASURES.map(() => `<th>Book</th><th>Phys</th><th>Δ</th>`).join("")}</tr>${rows}</table>`;
    });
    const wnd = window.open("", "_blank", "width=1000,height=900");
    if (!wnd) return;
    wnd.document.write(`<html><head><title>Stock Count ${formatDate(date)}</title>
      <style>body{font-family:system-ui,sans-serif;padding:24px;color:#111}h2{margin:0}h3{margin:14px 0 4px}table{width:100%;border-collapse:collapse;margin-bottom:8px}td,th{padding:3px 6px;border:1px solid #ddd;font-size:11px}.muted{color:#666;font-size:12px}</style></head><body>
      <h2>Stock Day-Close — ${formatDate(date)}</h2>
      <div class="muted">${view.count?.counted_at ? "Counted " + formatDateTime(view.count.counted_at) : "Preview"}</div>
      ${body}
      <p class="muted">Counted by ______________ &nbsp; Verified by ______________</p></body></html>`);
    wnd.document.close(); wnd.focus(); wnd.print();
  }

  if (!view) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (view.session_status == null)
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        Open the day on the <b>Cash</b> tab first — the stock count attaches to that day.
      </Card>
    );

  return (
    <div className="space-y-4">
      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}

      <div className="inline-flex rounded-lg border border-border p-0.5 text-sm">
        <button onClick={() => setMethod("category")} className={"flex items-center gap-1.5 px-3 py-1 rounded-md " + (method === "category" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}><Grid3x3 className="w-3.5 h-3.5" /> Weight aggregate</button>
        <button onClick={() => setMethod("tag")} className={"flex items-center gap-1.5 px-3 py-1 rounded-md " + (method === "tag" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}><ScanLine className="w-3.5 h-3.5" /> Tag scan</button>
      </div>

      {method === "tag" ? <TagScan date={date} readOnly={readOnly} /> : (<>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Boxes className="w-4 h-4" />
          {view.count ? <span>Counted {view.count.counted_at ? formatDateTime(view.count.counted_at) : ""}</span> : <span>Not counted yet — book figures shown; enter the physical count.</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={printSheet}><Printer className="w-3.5 h-3.5 mr-1" /> Print sheet</Button>
          {!readOnly && <Button size="sm" onClick={save} disabled={busy}><Save className="w-3.5 h-3.5 mr-1" /> Save count</Button>}
        </div>
      </div>
      {readOnly && <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">This day is closed — reopen it (Cash tab) to edit the count.</div>}

      {groups.map(([g, lines]) => {
        const outNos = lines.reduce((s, l) => s + l.out_nos, 0);
        const outGross = lines.reduce((s, l) => s + num(l.out_gross), 0);
        return (
          <Card key={g} className="p-0 overflow-hidden">
            <div className="px-4 py-2 border-b border-border flex items-center justify-between">
              <span className="font-medium">{g}</span>
              {outNos > 0 && <span className="text-xs text-muted-foreground">On approval / SOR (off-floor): {outNos} pc · {w(outGross)} g</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 text-muted-foreground text-xs">
                    <th className="text-left px-3 py-1.5">Category</th>
                    {MEASURES.map((m) => <th key={m.key} className="text-right px-3 py-1.5">{m.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.bucket_key} className="border-t border-border">
                      <td className="px-3 py-1.5">{l.category_label}</td>
                      {MEASURES.map((mk) => {
                        const v = variance(l, mk);
                        const bad = v != null && Math.abs(v) > 0.0001;
                        return (
                          <td key={mk.key} className="px-2 py-1 text-right">
                            <input
                              inputMode="decimal" disabled={readOnly}
                              value={phys[l.bucket_key]?.[mk.key as keyof PhysRow] ?? ""}
                              placeholder={w((l as any)[mk.bookKey], mk.int)}
                              onChange={(e) => setCell(l.bucket_key, mk.key as keyof PhysRow, e.target.value)}
                              className={"h-7 w-24 rounded-sm border bg-background px-2 text-right text-sm disabled:opacity-60 " + (bad ? "border-rose-400" : "border-input")}
                            />
                            <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                              book {w((l as any)[mk.bookKey], mk.int)}
                              {v != null && v !== 0 && <span className="text-rose-600"> · Δ {v > 0 ? "+" : ""}{w(v, mk.int)}</span>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {/* subtotal */}
                  <tr className="border-t-2 border-border bg-muted/30 font-medium text-xs">
                    <td className="px-3 py-1.5">Subtotal</td>
                    {MEASURES.map((mk) => {
                      const bookSum = lines.reduce((s, l) => s + num((l as any)[mk.bookKey]), 0);
                      const physSum = lines.reduce((s, l) => { const p = phys[l.bucket_key]?.[mk.key as keyof PhysRow]; return s + (p ? num(p) : 0); }, 0);
                      return <td key={mk.key} className="px-3 py-1.5 text-right font-mono">{w(physSum, mk.int)} <span className="text-muted-foreground">/ {w(bookSum, mk.int)}</span></td>;
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}

      {groups.length === 0 && <Card className="p-6 text-center text-sm text-muted-foreground">No stock on floor to count.</Card>}

      <div>
        <Label className="text-xs">Notes</Label>
        <Input value={notes} disabled={readOnly} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 18K one ring sent for polishing" />
      </div>
      </>)}
    </div>
  );
}
