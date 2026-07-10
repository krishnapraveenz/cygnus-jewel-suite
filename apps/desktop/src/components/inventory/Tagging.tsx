import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Tag as TagIcon, Package } from "lucide-react";
import * as api from "@/api";
import type { StockLot, ItemTag, ItemCategory } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagSheet } from "@/components/inventory/TagSheet";

type PieceRow = { key: number; gross: string; net: string; stone: string; huid: string; category_id: number | null; department_id: number | null };
let seq = 1;
const emptyRow = (): PieceRow => ({ key: seq++, gross: "", net: "", stone: "", huid: "", category_id: null, department_id: null });
const num = (v: string) => Number(v) || 0;

export function Tagging() {
  const [lots, setLots] = useState<StockLot[]>([]);
  const [pending, setPending] = useState<ItemTag[]>([]);
  const [cats, setCats] = useState<ItemCategory[]>([]);
  const [depts, setDepts] = useState<import("@/api").Department[]>([]);
  const [sel, setSel] = useState<StockLot | null>(null);
  const [rows, setRows] = useState<PieceRow[]>([emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [tagRows, setTagRows] = useState<ItemTag[] | null>(null);

  async function load() {
    try {
      const [l, c, u] = await Promise.all([api.listStockLots(), api.listItemCategories(), api.listUntaggedItems()]);
      setLots(l);
      setCats(c);
      api.listDepartments().then((d) => setDepts(d.filter((x) => x.active))).catch(() => {});
      setPending(u);
      if (sel) setSel(l.find((x) => x.id === sel.id) ?? null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function printPending() {
    if (pending.length === 0) return;
    setTagRows(pending);
    try {
      await api.markItemsTagged(pending.map((p) => p.id));
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(lot: StockLot) {
    setSel(lot);
    setRows([emptyRow()]);
    setOk(null);
    setError(null);
  }

  const tagged = useMemo(() => {
    const g = rows.reduce((a, r) => a + num(r.gross), 0);
    return { pieces: rows.filter((r) => num(r.gross) > 0).length, gross: g };
  }, [rows]);

  async function submit() {
    if (!sel) return;
    const pieces = rows
      .filter((r) => num(r.gross) > 0)
      .map((r) => ({
        gross_weight: r.gross,
        net_weight: r.net || undefined,
        stone_weight: r.stone || undefined,
        huid: r.huid || undefined,
        category_id: r.category_id ?? undefined,
        department_id: r.department_id ?? undefined,
      }));
    if (pieces.length === 0) return setError("Add at least one piece (gross weight)");
    setBusy(true);
    setError(null);
    try {
      const res = await api.tagStockLot(sel.id, pieces);
      setOk(`Tagged ${res.tagged} piece(s) · lot ${res.status === "closed" ? "closed" : `${res.remaining_gross}g / ${res.remaining_pieces} pcs left`}`);
      if (res.item_ids.length) {
        try { setTagRows(await api.itemTags(res.item_ids)); } catch { /* ignore */ }
      }
      setRows([emptyRow()]);
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 space-y-3">
      <div>
        <h1 className="text-lg font-semibold">Tagging</h1>
        <p className="text-sm text-muted-foreground">Weigh pieces out of a bulk lot into barcoded stock items.</p>
      </div>

      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}
      {ok && <div className="rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-3 py-2 text-sm">{ok}</div>}

      {pending.length > 0 && (
        <div className="rounded-lg border border-amber-400/50 bg-amber-50/50 dark:bg-amber-500/5 px-3 py-2.5 flex items-center justify-between">
          <div className="text-sm">
            <span className="font-medium">{pending.length} item(s) awaiting tag print</span>
            <span className="text-muted-foreground"> — recorded on purchases marked "generate later".</span>
          </div>
          <Button size="sm" onClick={printPending}><TagIcon className="w-3.5 h-3.5 mr-1" /> Print pending tags</Button>
        </div>
      )}

      <div className="grid grid-cols-[320px_1fr] gap-4">
        {/* Open lots */}
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2 text-sm font-medium flex items-center gap-2">
            <Package className="w-4 h-4" /> Open lots ({lots.length})
          </div>
          <div className="divide-y divide-border max-h-[70vh] overflow-auto">
            {lots.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">No open lots. Create a bulk lot from a purchase.</div>}
            {lots.map((l) => (
              <button
                key={l.id}
                onClick={() => pick(l)}
                className={`w-full text-left px-3 py-2 hover:bg-accent ${sel?.id === l.id ? "bg-accent" : ""}`}
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium capitalize">{l.metal} {l.purity ?? ""}</span>
                  <span className="font-mono text-xs">{Number(l.remaining_gross).toFixed(3)} g</span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>lot #{l.id}</span>
                  <span>{l.remaining_pieces} / {l.pieces} pcs left</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Tag pieces */}
        <div className="rounded-lg border border-border">
          {!sel ? (
            <div className="px-3 py-16 text-center text-sm text-muted-foreground">Select a lot to tag its pieces.</div>
          ) : (
            <div className="p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="font-medium capitalize">{sel.metal} {sel.purity ?? ""}</span>{" "}
                  <span className="text-muted-foreground">· lot #{sel.id} · {Number(sel.remaining_gross).toFixed(3)} g / {sel.remaining_pieces} pcs remaining</span>
                </div>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="px-1 py-1 font-medium">Gross (g)</th>
                    <th className="px-1 py-1 font-medium">Net (g)</th>
                    <th className="px-1 py-1 font-medium">Stone (g)</th>
                    <th className="px-1 py-1 font-medium">HUID</th>
                    <th className="px-1 py-1 font-medium">Type</th>
                    <th className="px-1 py-1 font-medium">Category</th>
                    <th className="px-1 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-b border-border/60">
                      <td className="px-1 py-1"><Input className="h-7 w-20 text-right" value={r.gross} inputMode="decimal" onChange={(e) => setRows((xs) => xs.map((x) => x.key === r.key ? { ...x, gross: e.target.value } : x))} /></td>
                      <td className="px-1 py-1"><Input className="h-7 w-20 text-right" value={r.net} placeholder="=gross" inputMode="decimal" onChange={(e) => setRows((xs) => xs.map((x) => x.key === r.key ? { ...x, net: e.target.value } : x))} /></td>
                      <td className="px-1 py-1"><Input className="h-7 w-16 text-right" value={r.stone} placeholder="0" inputMode="decimal" onChange={(e) => setRows((xs) => xs.map((x) => x.key === r.key ? { ...x, stone: e.target.value } : x))} /></td>
                      <td className="px-1 py-1"><Input className="h-7 w-28" value={r.huid} onChange={(e) => setRows((xs) => xs.map((x) => x.key === r.key ? { ...x, huid: e.target.value } : x))} /></td>
                      <td className="px-1 py-1">
                        <select className="h-7 w-32 rounded-md border border-input bg-background px-1 text-sm" value={r.department_id ?? ""} onChange={(e) => setRows((xs) => xs.map((x) => x.key === r.key ? { ...x, department_id: e.target.value ? Number(e.target.value) : null } : x))}>
                          <option value="">(auto)</option>
                          {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1">
                        <select className="h-7 w-28 rounded-md border border-input bg-background px-1 text-sm" value={r.category_id ?? ""} onChange={(e) => setRows((xs) => xs.map((x) => x.key === r.key ? { ...x, category_id: e.target.value ? Number(e.target.value) : null } : x))}>
                          <option value="">—</option>
                          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1 text-right">
                        <button className="text-muted-foreground hover:text-destructive" onClick={() => setRows((xs) => xs.length > 1 ? xs.filter((x) => x.key !== r.key) : xs)}><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex items-center justify-between">
                <Button variant="outline" size="sm" onClick={() => setRows((xs) => [...xs, emptyRow()])}><Plus className="w-3.5 h-3.5 mr-1" /> Add piece</Button>
                <div className="text-xs text-muted-foreground">
                  {tagged.pieces} piece(s) · {tagged.gross.toFixed(3)} g
                  {tagged.gross > num(sel.remaining_gross) + 0.001 && <span className="text-destructive"> · exceeds lot balance</span>}
                </div>
              </div>

              <div className="flex justify-end">
                <Button disabled={busy} onClick={submit}><TagIcon className="w-4 h-4 mr-1" /> {busy ? "Tagging…" : "Tag & print"}</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {tagRows && <TagSheet tags={tagRows} onClose={() => setTagRows(null)} />}
    </div>
  );
}
