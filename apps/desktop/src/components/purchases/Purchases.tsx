import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ShoppingCart, Plus, Trash2, Gem, Eye, Printer } from "lucide-react";
import * as api from "@/api";
import type { MetalOpt, PurchaseLineReq, PurchaseRow, PartyListRow, LineStoneReq, StoneTypeMaster, PurchaseDetail } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatINR, formatDate } from "@/lib/utils";
import { getCompany, loadCompany } from "@/lib/company";
import { StonePicker } from "@/components/sales/StonePicker";
import { TagSheet } from "@/components/inventory/TagSheet";
import { PurchaseBillPrint } from "@/components/purchases/PurchaseBillPrint";
import type { ItemTag } from "@/api";

type Mode = "fixed_cost" | "weight_rate" | "touch" | "stone" | "lot";
type DraftLine = {
  key: number;
  pricing_mode: Mode;
  sku: string;
  metal_type_id: number | null;
  purity_id: number | null;
  gross_weight: string;
  stone_weight: string;
  dia_ct: string;
  dia_rate: string;
  stone_rate: string;
  pieces: string;
  touch_percent: string;
  pure_rate: string;
  rate: string;
  making_per_gram: string;
  cost_value: string;
  huid: string;
  category_id: number | null;
  department_id: number | null;
  hsn: string;
  stones: LineStoneReq[];
};
let lineSeq = 1;
const emptyLine = (mode: Mode = "touch"): DraftLine => ({
  key: lineSeq++,
  pricing_mode: mode,
  sku: "",
  metal_type_id: null,
  purity_id: null,
  gross_weight: "",
  stone_weight: "",
  dia_ct: "",
  dia_rate: "",
  stone_rate: "",
  pieces: "",
  touch_percent: "",
  pure_rate: "",
  rate: "",
  making_per_gram: "",
  cost_value: "",
  huid: "",
  category_id: null,
  department_id: null,
  hsn: "",
  stones: [],
});

const num = (v: string) => Number(v) || 0;

export function Purchases() {
  const [parties, setParties] = useState<PartyListRow[]>([]);
  const [bills, setBills] = useState<PurchaseRow[]>([]);
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [cats, setCats] = useState<import("@/api").ItemCategory[]>([]);
  const [depts, setDepts] = useState<import("@/api").Department[]>([]);
  const [defRates, setDefRates] = useState<{ dia: string; stone: string }>({ dia: "", stone: "" });
  const [stoneTypes, setStoneTypes] = useState<StoneTypeMaster[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Bill header
  const [billKind, setBillKind] = useState<"local" | "b2b">("b2b");
  const [rcm, setRcm] = useState(false);
  const [unfixed, setUnfixed] = useState(false);
  const [tagNow, setTagNow] = useState(true);
  const [partyId, setPartyId] = useState<number | null>(null);
  const [supInvNo, setSupInvNo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  // Settlement
  const [payMode, setPayMode] = useState<"cash" | "bank" | "cheque">("bank");
  const [payAmount, setPayAmount] = useState("");
  const [payRef, setPayRef] = useState("");

  // Stone editor + detail modal
  const [stoneEditorKey, setStoneEditorKey] = useState<number | null>(null);
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);
  const [tagRows, setTagRows] = useState<ItemTag[] | null>(null);
  const [printBill, setPrintBill] = useState<PurchaseDetail | null>(null);
  const [retSel, setRetSel] = useState<Set<number>>(new Set());

  function openDetail(id: number) {
    setRetSel(new Set());
    api.getPurchase(id).then(setDetail).catch((e) => setError(String(e)));
  }
  function toggleRet(id: number) {
    setRetSel((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  async function createReturn() {
    if (!detail || retSel.size === 0) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await api.createPurchaseReturn({ purchase_bill_id: detail.id, line_ids: [...retSel] });
      setOk(`Debit note ${r.document_no} · ${formatINR(r.total)} returned to supplier`);
      setDetail(await api.getPurchase(detail.id));
      setRetSel(new Set());
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    try {
      const [pt, b, m] = await Promise.all([api.listParties("supplier"), api.listPurchases(), api.listMetals()]);
      setParties(pt);
      setBills(b);
      setMetals(m);
      api.listItemCategories().then((c) => setCats(c.filter((x) => x.active))).catch(() => {});
      api.listDepartments().then((d) => setDepts(d.filter((x) => x.active))).catch(() => {});
      api.getSettings().then((s) => setDefRates({ dia: s["rates.diamond_per_ct"] ?? "", stone: s["rates.stone_per_g"] ?? "" })).catch(() => {});
      api.listStoneTypes().then(setStoneTypes).catch(() => {});
      if (partyId === null && pt.length) setPartyId(pt[0].id);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  const applyGst = billKind === "b2b" || rcm;

  // Auto-detect place of supply from the selected supplier's GST state vs the shop's own
  // state → decide CGST+SGST (intra) or IGST (inter). Seller state comes from Company profile.
  const [sellerState, setSellerState] = useState((getCompany().stateCode || "").trim());
  useEffect(() => {
    loadCompany().then((c) => setSellerState((c.stateCode || "").trim())).catch(() => {});
  }, []);
  const selParty = parties.find((p) => p.id === partyId) ?? null;
  const partyState = (() => {
    const g = (selParty?.gstin || "").trim();
    if (/^\d{2}/.test(g)) return g.slice(0, 2);
    return (selParty?.state_code || "").trim();
  })();
  const supplyKnown = applyGst && !!sellerState && !!partyState;
  const interState = supplyKnown && partyState !== sellerState;

  function setLine(key: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  // ---- per-line valuation (mirrors backend) ----
  function lineNet(l: DraftLine) {
    return Math.max(0, num(l.gross_weight) - num(l.stone_weight));
  }
  function lineFineness(l: DraftLine) {
    const p = metals.find((m) => m.metal_type_id === l.metal_type_id)?.purities.find((x) => x.purity_id === l.purity_id);
    return p?.fineness ?? 0;
  }
  function lineChargeableFine(l: DraftLine) {
    if (l.pricing_mode === "stone") return 0;
    const net = lineNet(l);
    if (l.pricing_mode === "touch") return +(net * num(l.touch_percent) / 100).toFixed(3);
    return +(net * lineFineness(l) / 1000).toFixed(3);
  }
  const diaTypeId = stoneTypes.find((t) => t.category === "diamond")?.id;
  /** Stones for a line: explicit popup stones, else built from the inline Dia CT/rate + Stone wt/rate. */
  function buildStones(l: DraftLine): LineStoneReq[] {
    if (l.stones.length) return l.stones;
    const out: LineStoneReq[] = [];
    const dct = num(l.dia_ct), drate = num(l.dia_rate);
    if (dct > 0 && drate > 0) out.push({ stone_type_id: diaTypeId, description: "Diamond", carat: String(dct), rate: l.dia_rate, value: String(Math.round(dct * drate * 100) / 100) });
    const swt = num(l.stone_weight), srate = num(l.stone_rate);
    if (swt > 0 && srate > 0) out.push({ description: "Stone", carat: String(swt * 5), rate: l.stone_rate, value: String(Math.round(swt * srate * 100) / 100) });
    return out;
  }
  function lineStoneValue(l: DraftLine) {
    if (l.stones.length) return l.stones.reduce((a, s) => a + num(s.value), 0);
    return num(l.dia_ct) * num(l.dia_rate) + num(l.stone_weight) * num(l.stone_rate);
  }
  function lineMaking(l: DraftLine) {
    if (l.pricing_mode === "fixed_cost" || l.pricing_mode === "stone") return 0;
    return Math.round(lineNet(l) * num(l.making_per_gram) * 100) / 100;
  }
  function lineMetal(l: DraftLine) {
    if (l.pricing_mode === "stone") return 0;
    if (unfixed) return 0; // metal unpriced on unfixed bills (owed in fine grams)
    if (l.pricing_mode === "touch") return Math.round(lineChargeableFine(l) * num(l.pure_rate) * 100) / 100;
    if (l.pricing_mode === "weight_rate") return Math.round(lineNet(l) * num(l.rate) * 100) / 100;
    return num(l.cost_value);
  }
  function lineTaxable(l: DraftLine) {
    return lineMetal(l) + lineMaking(l) + lineStoneValue(l);
  }
  function lineGstRate(l: DraftLine) {
    if (!applyGst) return 0;
    if (l.pricing_mode === "stone") return 0.25; // diamonds / precious stones
    return 3; // gold/silver default; backend uses the metal master rate
  }
  function lineTax(l: DraftLine) {
    return Math.round(lineTaxable(l) * lineGstRate(l) / 100 * 100) / 100;
  }

  const totals = useMemo(() => {
    const subtotal = lines.reduce((a, l) => a + lineTaxable(l), 0);
    const tax = lines.reduce((a, l) => a + lineTax(l), 0);
    const fine = lines.reduce((a, l) => a + lineChargeableFine(l), 0);
    const grand = Math.round(subtotal + tax);
    return { subtotal, tax, fine, grand };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, applyGst, metals]);

  async function postBill() {
    if (!partyId) return setError("Select a supplier");
    const valid = lines.filter((l) =>
      l.pricing_mode === "stone" ? l.stones.length > 0 : l.metal_type_id && l.purity_id
    );
    if (valid.length === 0) return setError("Add at least one complete line (metal line: metal+purity; stone line: add stones)");
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const payload: PurchaseLineReq[] = valid.map((l) => ({
        pricing_mode: l.pricing_mode,
        sku: l.sku || (l.pricing_mode === "stone" ? "Loose stones" : undefined),
        metal_type_id: l.pricing_mode === "stone" ? undefined : l.metal_type_id!,
        purity_id: l.pricing_mode === "stone" ? undefined : l.purity_id!,
        gross_weight: l.gross_weight || "0",
        stone_weight: l.stone_weight || undefined,
        pieces: l.pricing_mode === "lot" ? num(l.pieces) || undefined : undefined,
        touch_percent: l.pricing_mode === "touch" ? l.touch_percent || "0" : undefined,
        pure_rate: l.pricing_mode === "touch" ? l.pure_rate || "0" : undefined,
        rate: l.pricing_mode === "weight_rate" ? l.rate || "0" : undefined,
        making_per_gram: l.making_per_gram || undefined,
        cost_value: l.pricing_mode === "fixed_cost" || l.pricing_mode === "lot" ? l.cost_value || "0" : undefined,
        huid: l.huid || undefined,
        category_id: l.category_id ?? undefined,
        department_id: l.department_id ?? undefined,
        hsn: l.hsn || undefined,
        stones: buildStones(l).length ? buildStones(l) : undefined,
      }));
      const payments = num(payAmount) > 0 ? [{ mode: payMode, amount: payAmount, reference: payRef || undefined }] : [];
      const r = await api.createPurchase({
        party_id: partyId,
        bill_kind: billKind,
        rcm,
        unfixed,
        tag_now: tagNow,
        supplier_invoice_no: supInvNo || undefined,
        lines: payload,
        payments,
      });
      const deferred = !tagNow;
      setOk(`Posted ${r.document_no} · ${formatINR(r.total)} · fine ${Number(r.total_fine).toFixed(3)}g · balance ${formatINR(r.balance)}${deferred ? " · tags pending (Tagging screen)" : ""}`);
      setLines([emptyLine(lines[0]?.pricing_mode ?? "touch")]);
      setSupInvNo("");
      setPayAmount("");
      setPayRef("");
      if (tagNow && r.items_received?.length) {
        try { setTagRows(await api.itemTags(r.items_received)); } catch { /* ignore */ }
      }
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const partyName = (n: string | null) => n ?? "—";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Purchases</h2>
        <p className="text-sm text-muted-foreground">
          Supplier bills bring new stock into inventory and post the balance to the supplier account.
        </p>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      <Card className="p-4">
        {/* Header */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end mb-4">
          <div>
            <Label>Bill kind</Label>
            <div className="inline-flex rounded-md border border-border overflow-hidden h-8">
              {(["b2b", "local"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setBillKind(k)}
                  className={cn("px-3 text-sm", billKind === k ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground")}
                >
                  {k === "b2b" ? "B2B (GST)" : "Local"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>Supplier</Label>
            <select
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={partyId ?? ""}
              onChange={(e) => setPartyId(Number(e.target.value))}
            >
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                  {p.gstin ? ` · ${p.gstin}` : ""}
                </option>
              ))}
            </select>
            {applyGst && selParty && (
              <div className="mt-1 text-[11px] leading-tight">
                {supplyKnown ? (
                  <span className={cn(
                    "inline-block rounded-full border px-2 py-0.5",
                    interState ? "border-amber-400/50 bg-amber-500/10 text-amber-600" : "border-emerald-400/50 bg-emerald-500/10 text-emerald-600",
                  )}>
                    {interState ? `Inter-state → IGST (${partyState}→${sellerState})` : `Intra-state → CGST + SGST (${sellerState})`}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Set supplier state &amp; company GST state to auto-detect IGST vs CGST/SGST</span>
                )}
              </div>
            )}
          </div>
          <div>
            <Label>Supplier invoice no.</Label>
            <Input value={supInvNo} onChange={(e) => setSupInvNo(e.target.value)} placeholder="optional" />
          </div>
          {billKind === "local" && (
            <label className="flex items-center gap-2 text-sm h-8">
              <input type="checkbox" checked={rcm} onChange={(e) => setRcm(e.target.checked)} /> Reverse charge (RCM)
            </label>
          )}
          <label className="flex items-center gap-2 text-sm h-8">
            <input type="checkbox" checked={unfixed} onChange={(e) => setUnfixed(e.target.checked)} /> Unfixed (metal on account)
          </label>
          <label className="flex items-center gap-2 text-sm h-8" title="Assign & print barcode tags now, or record the stock and tag/print later on the Tagging screen">
            <span className="text-muted-foreground">Tags:</span>
            <select className="h-7 rounded-md border border-input bg-background px-1 text-sm" value={tagNow ? "now" : "later"} onChange={(e) => setTagNow(e.target.value === "now")}>
              <option value="now">Generate now</option>
              <option value="later">Generate later</option>
            </select>
          </label>
          <div className="text-xs text-muted-foreground self-center">
            {unfixed ? "Metal owed in fine grams — fix later via Rate Cutting" : applyGst ? "GST applies (input tax credit)" : "No GST (unregistered purchase)"}
          </div>
        </div>

        {/* Lines — card per line (responsive, no horizontal scroll) */}
        <div className="space-y-3">
          {lines.map((l, idx) => {
            const purities = metals.find((m) => m.metal_type_id === l.metal_type_id)?.purities ?? [];
            const isStone = l.pricing_mode === "stone";
            const stonesPopup = l.stones.length > 0;
            return (
              <div key={l.key} className="rounded-lg border border-border p-3 space-y-3">
                {/* header */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground w-6">#{idx + 1}</span>
                  <PField label="Type">
                    <select className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm" value={l.department_id ?? ""} onChange={(e) => setLine(l.key, { department_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">(auto)</option>
                      {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </PField>
                  <PField label="Mode">
                    <select className="h-8 w-36 rounded-md border border-input bg-background px-2 text-sm" value={l.pricing_mode} onChange={(e) => setLine(l.key, { pricing_mode: e.target.value as Mode })}>
                      <option value="touch">Touch</option>
                      <option value="weight_rate">Weight×Rate</option>
                      <option value="fixed_cost">Fixed cost</option>
                      <option value="stone">Stone (loose/diamond)</option>
                      <option value="lot">Lot (bulk)</option>
                    </select>
                  </PField>
                  <div className="ml-auto flex items-center gap-3">
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Taxable</div>
                      <div className="font-mono text-sm font-semibold">{formatINR(lineTaxable(l))}</div>
                    </div>
                    <button className="rounded p-1 text-muted-foreground hover:text-destructive" onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((x) => x.key !== l.key) : prev))}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {/* fields grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-3 gap-y-2">
                  <PField label={l.pricing_mode === "lot" ? "Pieces" : "SKU"}>
                    {l.pricing_mode === "lot"
                      ? <Input className="h-8 w-full" value={l.pieces} placeholder="# pieces" onChange={(e) => setLine(l.key, { pieces: e.target.value })} inputMode="numeric" />
                      : <Input className="h-8 w-full" value={l.sku} placeholder="(auto)" onChange={(e) => setLine(l.key, { sku: e.target.value })} />}
                  </PField>
                  <PField label="Metal">
                    <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-40" value={l.metal_type_id ?? ""} disabled={isStone} onChange={(e) => setLine(l.key, { metal_type_id: Number(e.target.value), purity_id: null })}>
                      <option value="">—</option>
                      {metals.map((m) => <option key={m.metal_type_id} value={m.metal_type_id}>{m.metal}</option>)}
                    </select>
                  </PField>
                  <PField label="Purity">
                    <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-40" value={l.purity_id ?? ""} disabled={isStone} onChange={(e) => setLine(l.key, { purity_id: Number(e.target.value) })}>
                      <option value="">—</option>
                      {purities.map((p) => <option key={p.purity_id} value={p.purity_id}>{p.label}</option>)}
                    </select>
                  </PField>
                  <PField label="Gross g">
                    <Input className="h-8 w-full text-right disabled:opacity-40" value={l.gross_weight} disabled={isStone} onChange={(e) => setLine(l.key, { gross_weight: e.target.value })} inputMode="decimal" />
                  </PField>
                  <PField label="Dia CT">
                    <Input className="h-8 w-full text-right disabled:opacity-40" value={l.dia_ct} placeholder="0" disabled={isStone || stonesPopup} onChange={(e) => setLine(l.key, { dia_ct: e.target.value, ...(!l.dia_rate && defRates.dia ? { dia_rate: defRates.dia } : {}) })} inputMode="decimal" />
                  </PField>
                  <PField label="Dia ₹/ct">
                    <Input className="h-8 w-full text-right disabled:opacity-40" value={l.dia_rate} placeholder="₹/ct" disabled={isStone || stonesPopup} onChange={(e) => setLine(l.key, { dia_rate: e.target.value })} inputMode="decimal" />
                  </PField>
                  <PField label="Stone wt g">
                    <Input className="h-8 w-full text-right disabled:opacity-40" value={l.stone_weight} disabled={isStone} onChange={(e) => setLine(l.key, { stone_weight: e.target.value, ...(!l.stone_rate && defRates.stone ? { stone_rate: defRates.stone } : {}) })} inputMode="decimal" />
                  </PField>
                  <PField label="Stone ₹/g">
                    <Input className="h-8 w-full text-right disabled:opacity-40" value={l.stone_rate} placeholder="₹/g" disabled={isStone || stonesPopup} onChange={(e) => setLine(l.key, { stone_rate: e.target.value })} inputMode="decimal" />
                  </PField>
                  <PField label="Net g">
                    <div className="h-8 flex items-center justify-end font-mono text-sm text-muted-foreground">{lineNet(l).toFixed(3)}</div>
                  </PField>
                  {l.pricing_mode === "touch" && (
                    <PField label="Touch %"><Input className="h-8 w-full text-right" value={l.touch_percent} placeholder="92.5" onChange={(e) => setLine(l.key, { touch_percent: e.target.value })} inputMode="decimal" /></PField>
                  )}
                  {l.pricing_mode === "touch" && (
                    <PField label="999 rate"><Input className="h-8 w-full text-right" value={l.pure_rate} placeholder="₹/g" onChange={(e) => setLine(l.key, { pure_rate: e.target.value })} inputMode="decimal" /></PField>
                  )}
                  {l.pricing_mode === "weight_rate" && (
                    <PField label="Rate ₹/g"><Input className="h-8 w-full text-right" value={l.rate} placeholder="₹/g" onChange={(e) => setLine(l.key, { rate: e.target.value })} inputMode="decimal" /></PField>
                  )}
                  {(l.pricing_mode === "fixed_cost" || l.pricing_mode === "lot") && (
                    <PField label="Cost ₹"><Input className="h-8 w-full text-right" value={l.cost_value} placeholder="cost ₹" onChange={(e) => setLine(l.key, { cost_value: e.target.value })} inputMode="decimal" /></PField>
                  )}
                  {!(l.pricing_mode === "fixed_cost" || isStone) && (
                    <PField label="Making/g"><Input className="h-8 w-full text-right" value={l.making_per_gram} placeholder="0" onChange={(e) => setLine(l.key, { making_per_gram: e.target.value })} inputMode="decimal" /></PField>
                  )}
                  <PField label="Fine g">
                    <div className="h-8 flex items-center justify-end font-mono text-sm">{lineChargeableFine(l).toFixed(3)}</div>
                  </PField>
                  <PField label="Category">
                    <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={l.category_id ?? ""} onChange={(e) => setLine(l.key, { category_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">—</option>
                      {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </PField>
                  <PField label="Stones (popup)">
                    <button className="h-8 w-full inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 text-sm hover:bg-accent" onClick={() => setStoneEditorKey(l.key)}>
                      <Gem className="w-3.5 h-3.5" />
                      {l.stones.length ? `${l.stones.length} · ${formatINR(lineStoneValue(l))}` : "Add"}
                    </button>
                  </PField>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between mt-3">
          <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, emptyLine(prev[prev.length - 1]?.pricing_mode ?? "touch")])}>
            <Plus className="w-4 h-4 mr-1" /> Add line
          </Button>
        </div>

        {/* Settlement + totals */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 pt-4 border-t border-border">
          <div>
            <div className="text-sm font-medium mb-2">Settlement (optional)</div>
            <div className="grid grid-cols-3 gap-2 items-end">
              <div>
                <Label>Mode</Label>
                <select
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={payMode}
                  onChange={(e) => setPayMode(e.target.value as "cash" | "bank" | "cheque")}
                >
                  <option value="bank">Bank</option>
                  <option value="cash">Cash</option>
                  <option value="cheque">Cheque</option>
                </select>
              </div>
              <div>
                <Label>Pay now ₹</Label>
                <Input value={payAmount} onChange={(e) => setPayAmount(e.target.value)} inputMode="decimal" placeholder="0 = on credit" />
              </div>
              <div>
                <Label>Reference</Label>
                <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="UTR / cheque no." />
              </div>
            </div>
          </div>
          <div className="space-y-1 text-sm md:text-right">
            <div className="flex justify-between md:justify-end md:gap-8">
              <span className="text-muted-foreground">Taxable</span>
              <span className="font-mono">{formatINR(totals.subtotal)}</span>
            </div>
            {!applyGst ? (
              <div className="flex justify-between md:justify-end md:gap-8">
                <span className="text-muted-foreground">GST (n/a)</span>
                <span className="font-mono">—</span>
              </div>
            ) : interState ? (
              <div className="flex justify-between md:justify-end md:gap-8">
                <span className="text-muted-foreground">IGST</span>
                <span className="font-mono">{formatINR(totals.tax)}</span>
              </div>
            ) : (
              <>
                <div className="flex justify-between md:justify-end md:gap-8">
                  <span className="text-muted-foreground">CGST</span>
                  <span className="font-mono">{formatINR(totals.tax / 2)}</span>
                </div>
                <div className="flex justify-between md:justify-end md:gap-8">
                  <span className="text-muted-foreground">SGST</span>
                  <span className="font-mono">{formatINR(totals.tax / 2)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between md:justify-end md:gap-8">
              <span className="text-muted-foreground">Chargeable fine</span>
              <span className="font-mono">{totals.fine.toFixed(3)} g</span>
            </div>
            <div className="flex justify-between md:justify-end md:gap-8 text-base font-semibold">
              <span>Grand total</span>
              <span className="font-mono">{formatINR(totals.grand)}</span>
            </div>
            <div className="flex justify-between md:justify-end md:gap-8 text-xs text-muted-foreground">
              <span>Balance to supplier account</span>
              <span className="font-mono">{formatINR(Math.max(0, totals.grand - num(payAmount)))}</span>
            </div>
            <Button onClick={postBill} disabled={busy} className="mt-2">
              Post bill
            </Button>
          </div>
        </div>
      </Card>

      {/* Bills list */}
      <Card className="overflow-hidden">
        <div className="bg-muted/50 border-b border-border px-3 py-2 text-sm font-medium">Purchase bills</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/30 border-b border-border text-xs">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Bill no.</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Supplier</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Kind</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Total</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Paid</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Balance</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2 font-mono text-xs">{b.document_no || `#${b.id}`}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(b.created_at)}</td>
                <td className="px-3 py-2">{partyName(b.party_name)}</td>
                <td className="px-3 py-2">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] uppercase", b.bill_kind === "b2b" ? "bg-sky-500/15 text-sky-600" : "bg-muted text-muted-foreground")}>{b.bill_kind}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(b.total)}</td>
                <td className="px-3 py-2 text-right font-mono text-muted-foreground">{formatINR(b.paid_total)}</td>
                <td className={cn("px-3 py-2 text-right font-mono", Number(b.balance) > 0 ? "text-destructive" : "text-success")}>{formatINR(b.balance)}</td>
                <td className="px-3 py-2 text-center">
                  <button className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => openDetail(b.id)}>
                    <Eye className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {bills.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  <ShoppingCart className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No purchase bills yet.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Stone editor */}
      {stoneEditorKey !== null && (
        <StonePicker
          stoneTypes={stoneTypes}
          onClose={() => setStoneEditorKey(null)}
          onApply={(_total, stones) => {
            const l = lines.find((x) => x.key === stoneEditorKey);
            const stoneG = stones.reduce((a, st) => a + (st.carat ? Number(st.carat) * 0.2 : 0), 0);
            setLine(stoneEditorKey, {
              stones,
              stone_weight: stoneG > 0 ? String(+stoneG.toFixed(3)) : l?.stone_weight ?? "",
            });
            setStoneEditorKey(null);
          }}
        />
      )}

      {tagRows && <TagSheet tags={tagRows} onClose={() => setTagRows(null)} />}
      {printBill && <PurchaseBillPrint bill={printBill} onClose={() => setPrintBill(null)} />}

      {/* Detail modal */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDetail(null)}>
          <Card className="max-w-3xl w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="font-semibold">{detail.document_no}</div>
                <div className="text-xs text-muted-foreground">
                  {detail.party_name} · {detail.bill_kind.toUpperCase()} · {formatDate(detail.created_at)}
                  {detail.supplier_invoice_no ? ` · Supplier inv ${detail.supplier_invoice_no}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setPrintBill(detail)}>
                  <Printer className="w-3.5 h-3.5 mr-1" /> Print
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
                  Close
                </Button>
              </div>
            </div>
            <div className="p-4 space-y-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border text-[11px]">
                    <th className="px-2 py-1.5 w-8"></th>
                    <th className="text-left px-2 py-1.5 text-muted-foreground">Item</th>
                    <th className="text-left px-2 py-1.5 text-muted-foreground">Mode</th>
                    <th className="text-right px-2 py-1.5 text-muted-foreground">Net</th>
                    <th className="text-right px-2 py-1.5 text-muted-foreground">Fine</th>
                    <th className="text-right px-2 py-1.5 text-muted-foreground">Making</th>
                    <th className="text-right px-2 py-1.5 text-muted-foreground">Stones</th>
                    <th className="text-right px-2 py-1.5 text-muted-foreground">GST%</th>
                    <th className="text-right px-2 py-1.5 text-muted-foreground">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l, i) => (
                    <tr key={i} className={cn("border-b border-border last:border-0", l.returned && "opacity-50")}>
                      <td className="px-2 py-1.5 text-center">
                        {l.returned ? (
                          <span className="text-[10px] text-destructive">ret</span>
                        ) : (
                          <input type="checkbox" checked={retSel.has(l.id)} onChange={() => toggleRet(l.id)} />
                        )}
                      </td>
                      <td className={cn("px-2 py-1.5", l.returned && "line-through")}>{l.description}</td>
                      <td className="px-2 py-1.5 text-xs">{l.pricing_mode}{l.touch_percent ? ` ${l.touch_percent}` : ""}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{Number(l.net_weight).toFixed(3)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{Number(l.chargeable_fine).toFixed(3)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{formatINR(l.making_amount)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{formatINR(l.stone_value)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{l.gst_rate}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold">{formatINR(l.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {retSel.size > 0 && (
                <div className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <span className="text-sm text-muted-foreground">{retSel.size} line(s) selected to return to supplier (debit note)</span>
                  <Button size="sm" variant="outline" disabled={busy} onClick={createReturn}>Create return (debit note)</Button>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <Stat label="Taxable" v={formatINR(detail.subtotal)} />
                <Stat label="GST" v={formatINR(detail.tax_total)} />
                <Stat label="Total fine" v={`${Number(detail.total_fine).toFixed(3)} g`} />
                <Stat label="Grand total" v={formatINR(detail.total)} />
                <Stat label="Paid" v={formatINR(detail.paid_total)} />
                <Stat label="Balance" v={formatINR(detail.balance)} />
              </div>
              {detail.payments.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Payments: {detail.payments.map((p) => `${p.mode} ${formatINR(p.amount)}${p.reference ? ` (${p.reference})` : ""}`).join(", ")}
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono font-semibold">{v}</div>
    </div>
  );
}

function PField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5 truncate">{label}</div>
      {children}
    </div>
  );
}
