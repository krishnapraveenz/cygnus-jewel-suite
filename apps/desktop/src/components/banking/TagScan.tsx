import { useEffect, useMemo, useRef, useState } from "react";
import { ScanLine, Save, Printer, CheckCircle2, AlertTriangle, XCircle, Scale } from "lucide-react";
import * as api from "@/api";
import type { ExpectedItem } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/utils";

const num = (v: unknown) => { const n = Number(v ?? 0); return isNaN(n) ? 0 : n; };
const g = (v: unknown) => num(v).toLocaleString("en-IN", { maximumFractionDigits: 3 });

export function TagScan({ date, readOnly }: { date: string; readOnly: boolean }) {
  const [items, setItems] = useState<ExpectedItem[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [present, setPresent] = useState<Set<number>>(new Set());
  const [weighed, setWeighed] = useState<Record<number, string>>({});
  const [extras, setExtras] = useState<string[]>([]);
  const [weighMode, setWeighMode] = useState(false);
  const [notes, setNotes] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "ok" | "dup" | "bad"; msg: string } | null>(null);
  const [scan, setScan] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const bySku = useMemo(() => {
    const m = new Map<string, ExpectedItem>();
    items.forEach((i) => m.set(i.sku.toUpperCase(), i));
    return m;
  }, [items]);
  const byId = useMemo(() => {
    const m = new Map<number, ExpectedItem>();
    items.forEach((i) => m.set(i.item_id, i));
    return m;
  }, [items]);

  async function load() {
    setError(null);
    try {
      const v = await api.getStockExpected(date);
      setItems(v.items);
      setSessionStatus(v.session_status);
      setPresent(new Set(v.present_ids));
      setWeighMode(v.weigh_mode);
      // load notes from the saved count if any
      const sc = await api.getStockCount(date);
      setNotes(sc.count?.notes ?? "");
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);
  useEffect(() => { if (!readOnly) scanRef.current?.focus(); }, [readOnly, items]);

  function handleScan(raw: string) {
    const code = raw.trim().toUpperCase();
    setScan("");
    if (!code) return;
    const item = bySku.get(code);
    if (item) {
      if (present.has(item.item_id)) { setFeedback({ kind: "dup", msg: `Already scanned: ${item.sku}` }); return; }
      setPresent((p) => new Set(p).add(item.item_id));
      setFeedback({ kind: "ok", msg: `${item.sku} · ${item.group_label} ${item.category_label} · ${g(item.gross)} g` });
    } else {
      setExtras((x) => (x.includes(code) ? x : [...x, code]));
      setFeedback({ kind: "bad", msg: `Not expected on floor: ${code}` });
    }
  }

  const missing = useMemo(() => items.filter((i) => !present.has(i.item_id)), [items, present]);

  async function save() {
    setBusy(true); setError(null);
    try {
      const presentArr = Array.from(present).map((id) => ({ item_id: id, weighed_gross: weighMode && weighed[id] ? String(num(weighed[id])) : undefined }));
      await api.tagSaveStockCount({ business_date: date, weigh_mode: weighMode, notes: notes || undefined, present: presentArr, extra_skus: extras });
      await load();
      setFeedback({ kind: "ok", msg: "Count saved." });
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  function printSheet() {
    const miss = missing.map((m) => `<tr><td>${m.sku}</td><td>${m.group_label}</td><td>${m.category_label}</td><td style="text-align:right">${g(m.gross)}</td><td style="text-align:right">${g(m.net)}</td></tr>`).join("");
    const ext = extras.map((e) => `<tr><td>${e}</td></tr>`).join("");
    const w = window.open("", "_blank", "width=800,height=900");
    if (!w) return;
    w.document.write(`<html><head><title>Tag Count ${date}</title>
      <style>body{font-family:system-ui,sans-serif;padding:24px;color:#111}h2{margin:0}table{width:100%;border-collapse:collapse;margin:8px 0}td,th{padding:4px 8px;border:1px solid #ddd;font-size:12px;text-align:left}.muted{color:#666;font-size:12px}</style></head><body>
      <h2>Tag-Scan Stock Count — ${formatDate(date)}</h2>
      <div class="muted">Expected ${items.length} · Present ${present.size} · Missing ${missing.length} · Extra ${extras.length}${weighMode ? " · full-weigh" : ""}</div>
      <h3>Missing (${missing.length})</h3><table><tr><th>SKU</th><th>Group</th><th>Category</th><th style="text-align:right">Gross</th><th style="text-align:right">Net</th></tr>${miss || '<tr><td colspan="5">None</td></tr>'}</table>
      ${ext ? `<h3>Extra / unknown scans (${extras.length})</h3><table><tr><th>Scanned code</th></tr>${ext}</table>` : ""}
      <p class="muted">Counted by ______________ &nbsp; Verified by ______________</p></body></html>`);
    w.document.close(); w.focus(); w.print();
  }

  if (sessionStatus == null)
    return <Card className="p-6 text-center text-sm text-muted-foreground">Open the day on the <b>Cash</b> tab first — the stock count attaches to that day.</Card>;

  return (
    <div className="space-y-4">
      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-emerald-500/10 text-emerald-600 px-2.5 py-1 text-sm flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> {present.size} present</span>
          <span className="rounded-full bg-amber-500/10 text-amber-600 px-2.5 py-1 text-sm flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {missing.length} missing</span>
          {extras.length > 0 && <span className="rounded-full bg-rose-500/10 text-rose-600 px-2.5 py-1 text-sm flex items-center gap-1"><XCircle className="w-3.5 h-3.5" /> {extras.length} extra</span>}
          <span className="text-xs text-muted-foreground">of {items.length} expected</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground"><input type="checkbox" checked={weighMode} disabled={readOnly} onChange={(e) => setWeighMode(e.target.checked)} /> <Scale className="w-3.5 h-3.5" /> Full-weigh</label>
          <Button size="sm" variant="outline" onClick={printSheet}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
          {!readOnly && <Button size="sm" onClick={save} disabled={busy}><Save className="w-3.5 h-3.5 mr-1" /> Save count</Button>}
        </div>
      </div>

      {readOnly && <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">This day is closed — reopen it (Cash tab) to edit the count.</div>}

      {!readOnly && (
        <Card className="p-4">
          <Label className="text-xs flex items-center gap-1"><ScanLine className="w-3.5 h-3.5" /> Scan a tag (or type the SKU and press Enter)</Label>
          <Input ref={scanRef} value={scan} autoFocus placeholder="e.g. G22-000123"
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleScan((e.target as HTMLInputElement).value); }} />
          {feedback && (
            <div className={"mt-2 text-sm flex items-center gap-1.5 " + (feedback.kind === "ok" ? "text-emerald-600" : feedback.kind === "dup" ? "text-amber-600" : "text-rose-600")}>
              {feedback.kind === "ok" ? <CheckCircle2 className="w-4 h-4" /> : feedback.kind === "dup" ? <AlertTriangle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              {feedback.msg}
            </div>
          )}
          <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${items.length ? (present.size / items.length) * 100 : 0}%` }} />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Missing */}
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-2 border-b border-border font-medium text-amber-700 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Missing — not scanned ({missing.length})</div>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0"><tr className="bg-muted/60 text-muted-foreground text-xs"><th className="text-left px-3 py-1.5">SKU</th><th className="text-left px-3 py-1.5">Group</th><th className="text-left px-3 py-1.5">Category</th><th className="text-right px-3 py-1.5">Gross</th></tr></thead>
              <tbody>
                {missing.map((m) => (
                  <tr key={m.item_id} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono">{m.sku}</td>
                    <td className="px-3 py-1.5">{m.group_label}</td>
                    <td className="px-3 py-1.5">{m.category_label}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{g(m.gross)}</td>
                  </tr>
                ))}
                {missing.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-emerald-600">All expected pieces scanned ✓</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Extra / present-weigh */}
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-2 border-b border-border font-medium flex items-center gap-2">
            {weighMode ? <><Scale className="w-4 h-4" /> Present — weigh each ({present.size})</> : <><XCircle className="w-4 h-4 text-rose-600" /> Extra / unknown scans ({extras.length})</>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {weighMode ? (
              <table className="w-full text-sm">
                <thead className="sticky top-0"><tr className="bg-muted/60 text-muted-foreground text-xs"><th className="text-left px-3 py-1.5">SKU</th><th className="text-right px-3 py-1.5">Tag gross</th><th className="text-right px-3 py-1.5">Weighed</th><th className="text-right px-3 py-1.5">Δ</th></tr></thead>
                <tbody>
                  {Array.from(present).map((id) => {
                    const it = byId.get(id); if (!it) return null;
                    const wv = weighed[id]; const d = wv ? num(wv) - num(it.gross) : null;
                    return (
                      <tr key={id} className="border-t border-border">
                        <td className="px-3 py-1 font-mono">{it.sku}</td>
                        <td className="px-3 py-1 text-right font-mono text-muted-foreground">{g(it.gross)}</td>
                        <td className="px-2 py-1 text-right">
                          <input inputMode="decimal" disabled={readOnly} value={wv ?? ""} placeholder={g(it.gross)}
                            className={"h-7 w-24 rounded-sm border bg-background px-2 text-right text-sm " + (d && Math.abs(d) > 0.001 ? "border-rose-400" : "border-input")}
                            onChange={(e) => setWeighed((w) => ({ ...w, [id]: e.target.value }))} />
                        </td>
                        <td className={"px-3 py-1 text-right font-mono " + (d && Math.abs(d) > 0.001 ? "text-rose-600" : "text-muted-foreground")}>{d == null ? "" : (d > 0 ? "+" : "") + g(d)}</td>
                      </tr>
                    );
                  })}
                  {present.size === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Scan pieces to weigh them.</td></tr>}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {extras.map((e) => (
                    <tr key={e} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono text-rose-600">{e}</td>
                      <td className="px-3 py-1.5 text-right"><button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setExtras((x) => x.filter((s) => s !== e))}>remove</button></td>
                    </tr>
                  ))}
                  {extras.length === 0 && <tr><td className="px-3 py-6 text-center text-muted-foreground">No unexpected scans.</td></tr>}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>

      <div>
        <Label className="text-xs">Notes</Label>
        <Input value={notes} disabled={readOnly} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 2 pieces sent for polishing" />
      </div>
    </div>
  );
}
