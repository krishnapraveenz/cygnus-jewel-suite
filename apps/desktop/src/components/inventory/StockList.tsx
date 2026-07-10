import { useEffect, useMemo, useState } from "react";
import { Search, Boxes, X, Layers, Gem, RefreshCcwDot, Printer } from "lucide-react";
import * as api from "@/api";
import type { Item, ItemDetail, StockOverview, ItemTag } from "@/api";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TagSheet } from "@/components/inventory/TagSheet";
import { cn, formatINR } from "@/lib/utils";

const statusMeta: Record<string, { label: string; variant: "success" | "secondary" | "default" | "warning" }> = {
  in_stock: { label: "In stock", variant: "success" },
  sold: { label: "Sold", variant: "secondary" },
  on_approval_out: { label: "On approval", variant: "default" },
  sale_or_return_out: { label: "Sale or return", variant: "warning" },
};

export function StockList() {
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [overview, setOverview] = useState<StockOverview | null>(null);
  const [tagRows, setTagRows] = useState<ItemTag[] | null>(null);
  const [report, setReport] = useState(false);
  const [metalF, setMetalF] = useState("all");
  const [catF, setCatF] = useState("all");
  const [tagF, setTagF] = useState("all");
  const [statusF, setStatusF] = useState("all");

  function openDetail(id: number) {
    api.getItem(id).then(setDetail).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }
  async function reprint(id: number) {
    try { setTagRows(await api.itemTags([id])); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  // Barcode scan: exact SKU match on Enter jumps straight to the item.
  function onScan() {
    const q = search.trim().toLowerCase();
    if (!q) return;
    const hit = items.find((i) => i.sku.toLowerCase() === q) ?? (filtered.length === 1 ? filtered[0] : undefined);
    if (hit) openDetail(hit.id);
  }

  useEffect(() => {
    api.listItems()
      .then(setItems)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
    api.stockOverview().then(setOverview).catch(() => {});
  }, []);

  const metalsList = useMemo(
    () => Array.from(new Set(items.map((i) => i.metal).filter(Boolean) as string[])).sort(),
    [items]
  );
  const catsList = useMemo(
    () => Array.from(new Set(items.map((i) => i.category).filter(Boolean) as string[])).sort(),
    [items]
  );
  const filtered = useMemo(
    () =>
      items.filter((i) => {
        if (search && !i.sku.toLowerCase().includes(search.toLowerCase())) return false;
        if (metalF !== "all" && (i.metal ?? "") !== metalF) return false;
        if (catF !== "all" && (i.category ?? "") !== catF) return false;
        if (tagF !== "all" && (i.tag_status ?? "tagged") !== tagF) return false;
        if (statusF !== "all" && i.ownership_state !== statusF) return false;
        return true;
      }),
    [items, search, metalF, catF, tagF, statusF]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Stock</h2>
          <p className="text-sm text-muted-foreground">
            {filtered.length === items.length
              ? `${items.length} item${items.length !== 1 ? "s" : ""}`
              : `${filtered.length} of ${items.length} items`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setReport(true)}>
          <Printer className="w-3.5 h-3.5 mr-1" /> Barcode report
        </Button>
      </div>

      {overview && <StockSummary o={overview} />}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-xs min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Scan or search SKU..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onScan(); }}
            className="pl-8"
            autoFocus
          />
        </div>
        <select className="h-9 rounded-md border border-input bg-background px-2 text-sm capitalize" value={metalF} onChange={(e) => setMetalF(e.target.value)}>
          <option value="all">All metals</option>
          {metalsList.map((m) => <option key={m} value={m} className="capitalize">{m}</option>)}
        </select>
        <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={catF} onChange={(e) => setCatF(e.target.value)}>
          <option value="all">All categories</option>
          {catsList.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={tagF} onChange={(e) => setTagF(e.target.value)}>
          <option value="all">All tags</option>
          <option value="tagged">Tagged</option>
          <option value="untagged">Untagged</option>
        </select>
        <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="all">Any status</option>
          <option value="in_stock">In stock</option>
          <option value="sold">Sold</option>
          <option value="on_approval_out">On approval</option>
          <option value="sale_or_return_out">Sale or return</option>
        </select>
        {(metalF !== "all" || catF !== "all" || tagF !== "all" || statusF !== "all" || search) && (
          <button className="text-xs text-muted-foreground hover:text-foreground underline" onClick={() => { setSearch(""); setMetalF("all"); setCatF("all"); setTagF("all"); setStatusF("all"); }}>
            Clear
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading stock...</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Boxes className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">No items found</p>
          <p className="text-xs mt-1">Add stock from Purchases to see it here.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">SKU</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Purity</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Category</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Gross (g)</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Net (g)</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Value</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i, idx) => {
                const meta = statusMeta[i.ownership_state] ?? { label: i.ownership_state, variant: "secondary" as const };
                return (
                  <tr
                    key={i.id}
                    onClick={() => openDetail(i.id)}
                    className={`border-b border-border last:border-0 hover:bg-accent transition-colors cursor-pointer ${idx % 2 === 1 ? "bg-muted/20" : ""}`}
                  >
                    <td className="px-3 py-2 font-medium font-mono text-xs">
                      {i.sku}
                      {i.tag_status === "untagged" && <span className="ml-1.5 rounded bg-amber-500/15 text-amber-600 px-1 text-[10px]">untagged</span>}
                    </td>
                    <td className="px-3 py-2 capitalize">{i.purity || i.metal || <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2">{i.category || <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2 text-right font-mono">{i.gross_weight}</td>
                    <td className="px-3 py-2 text-right font-mono">{i.net_weight}</td>
                    <td className="px-3 py-2 text-right font-mono">{i.cost_value ? formatINR(i.cost_value) : "—"}</td>
                    <td className="px-3 py-2 text-center">
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/40 font-medium">
                <td className="px-3 py-2" colSpan={3}>{filtered.length} item(s)</td>
                <td className="px-3 py-2 text-right font-mono">{filtered.reduce((a, i) => a + Number(i.gross_weight), 0).toFixed(3)}</td>
                <td className="px-3 py-2 text-right font-mono">{filtered.reduce((a, i) => a + Number(i.net_weight), 0).toFixed(3)}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(filtered.reduce((a, i) => a + Number(i.cost_value || 0), 0))}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {detail && <ItemDetailModal d={detail} onClose={() => setDetail(null)} onReprint={reprint} />}
      {tagRows && <TagSheet tags={tagRows} onClose={() => setTagRows(null)} />}
      {report && <StockReport items={filtered.length ? filtered : items.filter((i) => i.ownership_state === "in_stock")} onClose={() => setReport(false)} />}
    </div>
  );
}

function StockReport({ items, onClose }: { items: Item[]; onClose: () => void }) {
  const tot = items.reduce(
    (a, i) => ({ gross: a.gross + Number(i.gross_weight), net: a.net + Number(i.net_weight), val: a.val + Number(i.cost_value || 0) }),
    { gross: 0, net: 0, val: 0 },
  );
  return (
    <div className="print-root fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 py-8" onClick={onClose}>
      <div className="bg-card rounded-lg shadow-xl w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 no-print">
          <div className="text-sm font-medium">Barcode-wise stock report · {items.length} item(s)</div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="print-area bg-white text-black p-6 text-sm">
          <h2 className="text-lg font-semibold mb-3">Stock — barcode-wise</h2>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-black/40 text-left">
                <th className="py-1 pr-2">Barcode</th>
                <th className="py-1 pr-2">Metal / Purity</th>
                <th className="py-1 pr-2">Category</th>
                <th className="py-1 pr-2">HUID</th>
                <th className="py-1 pr-2 text-right">Gross (g)</th>
                <th className="py-1 pr-2 text-right">Net (g)</th>
                <th className="py-1 pr-2 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-b border-black/10">
                  <td className="py-1 pr-2 font-mono">{i.sku}</td>
                  <td className="py-1 pr-2 capitalize">{i.metal} {i.purity ?? ""}</td>
                  <td className="py-1 pr-2">{i.category ?? "—"}</td>
                  <td className="py-1 pr-2">{i.huid ?? "—"}</td>
                  <td className="py-1 pr-2 text-right font-mono">{Number(i.gross_weight).toFixed(3)}</td>
                  <td className="py-1 pr-2 text-right font-mono">{Number(i.net_weight).toFixed(3)}</td>
                  <td className="py-1 pr-2 text-right font-mono">{i.cost_value ? formatINR(i.cost_value) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-black/40 font-semibold">
                <td className="py-1 pr-2" colSpan={4}>Total · {items.length} item(s)</td>
                <td className="py-1 pr-2 text-right font-mono">{tot.gross.toFixed(3)}</td>
                <td className="py-1 pr-2 text-right font-mono">{tot.net.toFixed(3)}</td>
                <td className="py-1 pr-2 text-right font-mono">{formatINR(tot.val)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function ItemDetailModal({ d, onClose, onReprint }: { d: ItemDetail; onClose: () => void; onReprint: (id: number) => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="font-semibold font-mono text-sm">{d.sku}</div>
            <div className="text-xs text-muted-foreground capitalize">
              {d.metal}
              {d.purity ? ` · ${d.purity}` : ""}
              {d.category ? ` · ${d.category}` : ""} · {d.ownership_state.replace(/_/g, " ")}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 pt-3">
          <Button size="sm" variant="outline" onClick={() => onReprint(d.id)}>
            <Printer className="w-3.5 h-3.5 mr-1" /> Print tag
          </Button>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Gross</div>
              <div className="font-mono">{d.gross_weight} g</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Net</div>
              <div className="font-mono">{d.net_weight} g</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Cost</div>
              <div className="font-mono">{d.cost_value ? formatINR(d.cost_value) : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">HSN</div>
              <div className="font-mono">{d.hsn || "7113"}</div>
            </div>
          </div>
          {d.huid && <div className="text-xs">HUID <span className="font-mono">{d.huid}</span></div>}

          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Stone composition</div>
            {d.stones.length === 0 ? (
              <div className="text-sm text-muted-foreground">No stones recorded.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Stone</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Carat / pcs</th>
                    <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Cert</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {d.stones.map((s, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-2 py-1.5">{s.description || "Stone"}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{s.carat ? `${s.carat} ct` : s.pieces ? `${s.pieces} pc` : "—"}</td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{s.certificate_no ? `${s.lab ?? ""} ${s.certificate_no}` : "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{formatINR(s.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}


function StockSummary({ o }: { o: import("@/api").StockOverview }) {
  const [tab, setTab] = useState("All");
  const g = (v: string) => Number(v).toFixed(3);

  type Row = { label: string; pieces: number; gross: string; stone: string; net: string; carat?: string };
  const byDept = new Map<string, Row[]>();
  for (const m of o.metals) {
    if (!byDept.has(m.department)) byDept.set(m.department, []);
    byDept.get(m.department)!.push({ label: m.purity, pieces: m.pieces, gross: m.gross, stone: m.stone, net: m.net, carat: m.diamond_carat });
  }
  const deptNames = Array.from(byDept.keys());
  const oldOrn = o.old_metal.filter((x) => Number(x.gross) > 0 || Number(x.net) > 0);
  const tabs: string[] = ["All", ...deptNames];
  const active = tabs.includes(tab) ? tab : "All";

  return (
    <div className="space-y-3">
      <div className="inline-flex h-9 items-center gap-1 border-b border-border flex-wrap">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-2 text-sm transition-colors",
              active === t ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "All" ? "All stock" : t}
          </button>
        ))}
      </div>

      {active === "All" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {deptNames.map((d) => <DeptSection key={d} title={d} rows={byDept.get(d)!} g={g} />)}
          </div>
          {oldOrn.length > 0 && <OldScrapCard rows={oldOrn} g={g} />}
          <ToTagCard o={o} />
        </div>
      ) : (
        <DeptSection title={active} rows={byDept.get(active) ?? []} g={g} />
      )}
    </div>
  );
}

function DeptSection({ title, rows, g }: { title: string; rows: { label: string; pieces: number; gross: string; stone: string; net: string; carat?: string }[]; g: (v: string) => string }) {
  if (rows.length === 0) return null;
  const hasDia = rows.some((r) => Number(r.carat) > 0);
  const tot = rows.reduce((a, r) => ({ pc: a.pc + Number(r.pieces || 0), gr: a.gr + Number(r.gross || 0), ct: a.ct + Number(r.carat || 0), st: a.st + Number(r.stone || 0), net: a.net + Number(r.net || 0) }), { pc: 0, gr: 0, ct: 0, st: 0, net: 0 });
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
        <Gem className="w-4 h-4 text-primary" /> {title}
      </div>
      <table className="w-full text-sm table-fixed">
        <MetalCols />
        <thead>
          <tr className="bg-muted/40 border-b border-border text-[11px]">
            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Purity</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Pcs</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Gross g</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Diamond ct</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Stone g</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Net g</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 truncate">{r.label}</td>
              <td className="px-3 py-1.5 text-right font-mono">{r.pieces}</td>
              <td className="px-3 py-1.5 text-right font-mono">{g(r.gross)}</td>
              <td className="px-3 py-1.5 text-right font-mono font-semibold text-sky-600 dark:text-sky-400">{Number(r.carat) > 0 ? `${Number(r.carat).toFixed(2)}` : "—"}</td>
              <td className="px-3 py-1.5 text-right font-mono">{g(r.stone)}</td>
              <td className="px-3 py-1.5 text-right font-mono font-semibold">{g(r.net)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-border bg-muted/30 font-medium text-xs">
            <td className="px-3 py-1.5">Total</td>
            <td className="px-3 py-1.5 text-right font-mono">{tot.pc}</td>
            <td className="px-3 py-1.5 text-right font-mono">{tot.gr.toFixed(3)}</td>
            <td className="px-3 py-1.5 text-right font-mono">{hasDia ? tot.ct.toFixed(2) : "—"}</td>
            <td className="px-3 py-1.5 text-right font-mono">{tot.st.toFixed(3)}</td>
            <td className="px-3 py-1.5 text-right font-mono">{tot.net.toFixed(3)}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

function ToTagCard({ o }: { o: import("@/api").StockOverview }) {
  const lots = o.open_lots ?? [];
  const untagged = o.untagged_items;
  const hasUntagged = untagged && untagged.pieces > 0;
  if (lots.length === 0 && !hasUntagged) return null;
  const lotGross = lots.reduce((a, l) => a + Number(l.remaining_gross), 0);
  const lotPieces = lots.reduce((a, l) => a + Number(l.remaining_pieces), 0);
  return (
    <Card className="overflow-hidden border-amber-400/40">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
        <Layers className="w-4 h-4 text-amber-500" /> To be tagged
        <span className="ml-auto text-xs font-normal text-muted-foreground">go to Inventory → Tagging</span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-border">
        <div className="px-4 py-3">
          <div className="text-xs text-muted-foreground">Bulk lots (untagged balance)</div>
          <div className="text-lg font-semibold font-mono">{lotGross.toFixed(3)} g</div>
          <div className="text-xs text-muted-foreground">{lots.length} lot(s) · {lotPieces} piece(s) remaining</div>
        </div>
        <div className="px-4 py-3">
          <div className="text-xs text-muted-foreground">Pieces awaiting tag print</div>
          <div className="text-lg font-semibold font-mono">{hasUntagged ? untagged!.pieces : 0}</div>
          <div className="text-xs text-muted-foreground">{hasUntagged ? `${Number(untagged!.net).toFixed(3)} g net` : "none"}</div>
        </div>
      </div>
    </Card>
  );
}

function MetalCols() {
  return (
    <colgroup>
      <col />
      <col style={{ width: 64 }} />
      <col style={{ width: 104 }} />
      <col style={{ width: 96 }} />
      <col style={{ width: 88 }} />
      <col style={{ width: 108 }} />
    </colgroup>
  );
}

// Old / scrap ornaments bought back or taken in exchange, currently on hand.
function OldScrapCard({ rows, g }: { rows: import("@/api").StockOverview["old_metal"]; g: (v: string) => string }) {
  const tot = rows.reduce(
    (a, r) => ({ lots: a.lots + r.lots, gross: a.gross + Number(r.gross), stone: a.stone + Number(r.stone), net: a.net + Number(r.net), value: a.value + Number(r.value) }),
    { lots: 0, gross: 0, stone: 0, net: 0, value: 0 },
  );
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
        <RefreshCcwDot className="w-4 h-4 text-amber-600" /> Old / scrap ornaments (bought back)
      </div>
      <table className="w-full text-sm table-fixed">
        <MetalCols />
        <thead>
          <tr className="bg-muted/40 border-b border-border text-[11px]">
            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Old stock</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Lots</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Gross g</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Diamond ct</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Stone g</th>
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Net g</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 truncate">{r.label}</td>
              <td className="px-3 py-1.5 text-right font-mono">{r.lots}</td>
              <td className="px-3 py-1.5 text-right font-mono">{g(r.gross)}</td>
              <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">—</td>
              <td className="px-3 py-1.5 text-right font-mono">{g(r.stone)}</td>
              <td className="px-3 py-1.5 text-right font-mono font-semibold">{g(r.net)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-muted/30 font-semibold">
            <td className="px-3 py-1.5">Total</td>
            <td className="px-3 py-1.5 text-right font-mono">{tot.lots}</td>
            <td className="px-3 py-1.5 text-right font-mono">{tot.gross.toFixed(3)}</td>
            <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">—</td>
            <td className="px-3 py-1.5 text-right font-mono">{tot.stone.toFixed(3)}</td>
            <td className="px-3 py-1.5 text-right font-mono">{tot.net.toFixed(3)}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
}

