import { useEffect, useMemo, useRef, useState } from "react";
import { ScanBarcode, Search, Printer, Download, Settings2, ChevronDown, ChevronUp } from "lucide-react";
import * as api from "@/api";
import type { Item, ItemTag, ItemDetail } from "@/api";
import { currentFY } from "@/lib/fy";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TagSheet } from "@/components/inventory/TagSheet";
import { cn, formatINR } from "@/lib/utils";

type SortKey = "sku" | "gross_weight" | "net_weight" | "cost_value";
type SortDir = "asc" | "desc";

export function Barcoding() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Scan / search
  const [query, setQuery] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);

  // Filters
  const [catF, setCatF] = useState("all");
  const [metalF, setMetalF] = useState("all");
  const [statusF, setStatusF] = useState("in_stock");
  const [minWt, setMinWt] = useState("");
  const [maxWt, setMaxWt] = useState("");

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("sku");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Selection + detail
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [tagRows, setTagRows] = useState<ItemTag[] | null>(null);

  // Barcode settings
  const [showSettings, setShowSettings] = useState(false);
  const [startNo, setStartNo] = useState("");
  const [nextPreview, setNextPreview] = useState("");
  const [settingsOk, setSettingsOk] = useState<string | null>(null);

  useEffect(() => {
    api.listItems().then(setItems).catch((e) => setError(String(e instanceof Error ? e.message : e))).finally(() => setLoading(false));
    loadSettings();
    scanRef.current?.focus();
  }, []);

  async function loadSettings() {
    try {
      const rows = await api.listDocSeries();
      const tag = rows.find((r) => r.doc_type === "tag");
      if (tag) {
        setStartNo(String(tag.next_no));
        setNextPreview(`${tag.prefix}${String(tag.next_no).padStart(tag.pad_width, "0")}${tag.suffix}`);
      }
    } catch { /* ignore */ }
  }

  async function saveStartNo() {
    if (!startNo.trim() || Number(startNo) < 1) return;
    try {
      const r = await api.upsertDocSeries({ doc_type: "tag", fy: currentFY().label, series_code: "T1", prefix: "", start_no: Number(startNo) });
      setNextPreview(r.next_number_preview);
      setSettingsOk(`Barcode sequence will start from ${startNo}. Next: ${r.next_number_preview}`);
      setTimeout(() => setSettingsOk(null), 5000);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  // Filter + sort
  const metals = useMemo(() => [...new Set(items.map((i) => i.metal).filter(Boolean) as string[])].sort(), [items]);
  const cats = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean) as string[])].sort(), [items]);

  const filtered = useMemo(() => {
    const min = Number(minWt) || 0;
    const max = Number(maxWt) || Infinity;
    return items.filter((i) => {
      if (query && !i.sku.toLowerCase().includes(query.toLowerCase())) return false;
      if (catF !== "all" && (i.category ?? "") !== catF) return false;
      if (metalF !== "all" && (i.metal ?? "") !== metalF) return false;
      if (statusF !== "all" && i.ownership_state !== statusF) return false;
      const g = Number(i.gross_weight);
      if (g < min || g > max) return false;
      return true;
    });
  }, [items, query, catF, metalF, statusF, minWt, maxWt]);

  const sorted = useMemo(() => {
    const cmp = (a: Item, b: Item) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "gross_weight": av = Number(a.gross_weight); bv = Number(b.gross_weight); break;
        case "net_weight": av = Number(a.net_weight); bv = Number(b.net_weight); break;
        case "cost_value": av = Number(a.cost_value ?? 0); bv = Number(b.cost_value ?? 0); break;
        default: av = a.sku; bv = b.sku;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    };
    return [...filtered].sort(cmp);
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }
  const SortIcon = ({ k }: { k: SortKey }) => sortKey === k ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />) : null;

  function toggleSelect(id: number) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function selectAll() {
    if (selected.size === sorted.length) setSelected(new Set());
    else setSelected(new Set(sorted.map((i) => i.id)));
  }

  async function printSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    try { setTagRows(await api.itemTags(ids)); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  function onScan() {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const hit = items.find((i) => i.sku.toLowerCase() === q);
    if (hit) api.getItem(hit.id).then(setDetail).catch(() => {});
  }

  function exportCSV() {
    const hdr = ["SKU", "Category", "Metal", "Purity", "Gross", "Net", "Cost", "Status", "HUID"].join(",");
    const rows = sorted.map((i) => [i.sku, i.category ?? "", i.metal ?? "", i.purity ?? "", i.gross_weight, i.net_weight, i.cost_value ?? "0", i.ownership_state, i.huid ?? ""].join(","));
    const csv = [hdr, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "barcoded-stock.csv"; a.click();
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2"><ScanBarcode className="w-5 h-5" /> Barcoding</h2>
          <p className="text-sm text-muted-foreground">Scan, search, sort and manage barcoded stock. Bulk print tags.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowSettings((s) => !s)}>
            <Settings2 className="w-3.5 h-3.5 mr-1" /> Barcode settings
          </Button>
        </div>
      </div>

      {/* Barcode settings panel */}
      {showSettings && (
        <Card className="p-4 space-y-2">
          <div className="text-sm font-medium">Barcode starting number</div>
          <p className="text-xs text-muted-foreground">Set which number the next barcode starts from. Format: metal prefix + karat + sequence (e.g. G22-000033).</p>
          <div className="flex items-center gap-3">
            <Input className="w-32 font-mono" value={startNo} onChange={(e) => setStartNo(e.target.value)} placeholder="e.g. 100" />
            <Button size="sm" onClick={saveStartNo}>Save starting number</Button>
            {nextPreview && <span className="text-xs text-muted-foreground">Next barcode preview: <span className="font-mono font-medium text-foreground">{nextPreview}</span></span>}
          </div>
          {settingsOk && <div className="text-xs text-green-700 dark:text-green-400">{settingsOk}</div>}
        </Card>
      )}

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

      {/* Scan box */}
      <Card className="p-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              ref={scanRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onScan()}
              placeholder="Scan barcode / search SKU…"
              className="pl-9"
            />
          </div>
          <Button variant="outline" size="sm" onClick={printSelected} disabled={selected.size === 0}>
            <Printer className="w-3.5 h-3.5 mr-1" /> Print tags ({selected.size})
          </Button>
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="w-3.5 h-3.5 mr-1" /> CSV
          </Button>
        </div>
      </Card>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={catF} onChange={(e) => setCatF(e.target.value)}>
          <option value="all">All categories</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={metalF} onChange={(e) => setMetalF(e.target.value)}>
          <option value="all">All metals</option>
          {metals.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="all">All status</option>
          <option value="in_stock">In stock</option>
          <option value="sold">Sold</option>
          <option value="on_approval_out">On approval</option>
          <option value="sale_or_return_out">Sale or return</option>
        </select>
        <Input className="h-8 w-24" value={minWt} onChange={(e) => setMinWt(e.target.value)} placeholder="Min wt g" />
        <Input className="h-8 w-24" value={maxWt} onChange={(e) => setMaxWt(e.target.value)} placeholder="Max wt g" />
        <span className="text-xs text-muted-foreground">{sorted.length} item{sorted.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Stock table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border text-xs">
                <th className="px-2 py-2 w-8"><input type="checkbox" checked={selected.size === sorted.length && sorted.length > 0} onChange={selectAll} /></th>
                <th className="px-3 py-2 text-left cursor-pointer select-none" onClick={() => toggleSort("sku")}>SKU <SortIcon k="sku" /></th>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-left">Metal · Purity</th>
                <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => toggleSort("gross_weight")}>Gross g <SortIcon k="gross_weight" /></th>
                <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => toggleSort("net_weight")}>Net g <SortIcon k="net_weight" /></th>
                <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => toggleSort("cost_value")}>Cost <SortIcon k="cost_value" /></th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-left">HUID</th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 200).map((i) => (
                <tr
                  key={i.id}
                  className={cn("border-b border-border/50 hover:bg-accent/50 cursor-pointer", selected.has(i.id) && "bg-primary/5")}
                  onClick={() => api.getItem(i.id).then(setDetail).catch(() => {})}
                >
                  <td className="px-2 py-1.5 text-center" onClick={(e) => { e.stopPropagation(); toggleSelect(i.id); }}>
                    <input type="checkbox" checked={selected.has(i.id)} readOnly />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs font-medium">{i.sku}</td>
                  <td className="px-3 py-1.5 text-xs">{i.category ?? "—"}</td>
                  <td className="px-3 py-1.5 text-xs capitalize">{i.metal}{i.purity ? ` · ${i.purity}` : ""}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(i.gross_weight).toFixed(3)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(i.net_weight).toFixed(3)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{i.cost_value ? formatINR(i.cost_value) : "—"}</td>
                  <td className="px-3 py-1.5 text-center">
                    <Badge variant={i.ownership_state === "in_stock" ? "success" : i.ownership_state === "sold" ? "secondary" : "default"}>
                      {i.ownership_state.replace(/_/g, " ")}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-xs font-mono">{i.huid ?? ""}</td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">No items match your filters.</td></tr>
              )}
              {sorted.length > 200 && (
                <tr><td colSpan={9} className="px-3 py-2 text-center text-xs text-muted-foreground">Showing first 200 of {sorted.length} items. Use filters to narrow down.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Item detail panel */}
      {detail && (
        <Card className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium font-mono">{detail.sku}</div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={async () => { try { setTagRows(await api.itemTags([detail.id])); } catch {} }}>
                <Printer className="w-3.5 h-3.5 mr-1" /> Print tag
              </Button>
              <button onClick={() => setDetail(null)} className="text-muted-foreground hover:text-foreground text-xs">Close</button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div><span className="text-muted-foreground">Category:</span> {detail.category ?? "—"}</div>
            <div><span className="text-muted-foreground">Metal:</span> {detail.metal} · {detail.purity}</div>
            <div><span className="text-muted-foreground">Status:</span> <Badge variant={detail.ownership_state === "in_stock" ? "success" : "secondary"}>{detail.ownership_state.replace(/_/g, " ")}</Badge></div>
            <div><span className="text-muted-foreground">HUID:</span> {detail.huid ?? "—"}</div>
            <div><span className="text-muted-foreground">Gross:</span> <span className="font-mono">{Number(detail.gross_weight).toFixed(3)} g</span></div>
            <div><span className="text-muted-foreground">Net:</span> <span className="font-mono">{Number(detail.net_weight).toFixed(3)} g</span></div>
            <div><span className="text-muted-foreground">Cost:</span> <span className="font-mono">{detail.cost_value ? formatINR(detail.cost_value) : "—"}</span></div>
            <div><span className="text-muted-foreground">HSN:</span> {detail.hsn ?? "—"}</div>
          </div>
        </Card>
      )}

      {tagRows && <TagSheet tags={tagRows} onClose={() => setTagRows(null)} />}
    </div>
  );
}
