import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Search, UserPlus, Plus, Trash2, CheckCircle2, Coins, Gem } from "lucide-react";
import * as api from "@/api";
import type { Item, Customer, MetalOpt, PriceBreakdown, SchemeRow, PartyListRow, StoneTypeMaster } from "@/api";
import { StonePicker } from "./StonePicker";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatINR } from "@/lib/utils";
import { confirm } from "@/lib/dialog";
import { getCompany, loadCompany } from "@/lib/company";
import { InvoicePreview, type PreviewDoc } from "./InvoicePreview";

type Mode = "invoice" | "estimate";

interface Line {
  key: string;
  mode: "tagged" | "loose";
  itemId?: number;
  description: string;
  hsn: string;
  metalTypeId?: number;
  purityId?: number;
  purityLabel?: string;
  rate?: string;
  grossWeight: string;
  stoneWeight: string;
  netWeight: string;
  makingMode: "percent" | "per_gram";
  makingValue: string;
  touchPercent?: string;
  pureRate?: string;
  wastagePct: string;
  stoneValue: string;
  diaCt?: string;
  diaRate?: string;
  stoneRate?: string;
  discount: string;
  huid: string;
  departmentId?: number;
  stones?: import("@/api").LineStoneReq[];
}

interface OldGold {
  key: string;
  kind: "gold" | "silver" | "platinum" | "diamond";
  metalTypeId?: number;
  purityId?: number;
  purityLabel?: string;
  grossWeight: string;
  deductionPct: string;
  rate: string;
  stones?: import("@/api").LineStoneReq[];
  stoneAction?: "return" | "buy";
  testedFineness?: string;
  stoneWeight?: string;
  touch?: string;        // silver: touch % (purity basis)
  buybackPct?: string;   // diamond buyback: "" = manual/full, else e.g. "70" | "80"
  diaCt?: string;        // diamond ornament: total diamond carat
  diaValue?: string;     // diamond ornament: assessed diamond value ₹ (manual, per ct)
}

let counter = 0;
const newKey = () => `K${++counter}`;

export function InvoiceForm({ mode, onPosted }: { mode: Mode; onPosted?: () => void }) {
  const isEstimate = mode === "estimate";

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [wholesaleParties, setWholesaleParties] = useState<PartyListRow[]>([]);
  const [partyId, setPartyId] = useState<number | "">("");
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [stoneTypes, setStoneTypes] = useState<StoneTypeMaster[]>([]);
  const [departments, setDepartments] = useState<import("@/api").Department[]>([]);
  const [defRates, setDefRates] = useState<{ dia: string; stone: string }>({ dia: "", stone: "" });
  const [stoneEditorKey, setStoneEditorKey] = useState<string | null>(null);
  const [ogStoneEditorKey, setOgStoneEditorKey] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);

  const [customerId, setCustomerId] = useState<number | "">("");
  const [b2b, setB2b] = useState(false);
  const [sellerState, setSellerState] = useState((getCompany().stateCode || "").trim());
  const [touchMode, setTouchMode] = useState(false);
  const [unfixed, setUnfixed] = useState(false);
  const [quickAdd, setQuickAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newPan, setNewPan] = useState("");

  const [itemQuery, setItemQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [previews, setPreviews] = useState<Record<string, PriceBreakdown>>({});
  const [oldGold, setOldGold] = useState<OldGold[]>([]);
  const [tenders, setTenders] = useState<{ mode: string; amount: string; reference: string }[]>([
    { mode: "cash", amount: "0", reference: "" },
  ]);
  const [target, setTarget] = useState("");
  const [schemes, setSchemes] = useState<SchemeRow[]>([]);
  const [redeemSchemeId, setRedeemSchemeId] = useState<number | "">("");
  const [advanceBalance, setAdvanceBalance] = useState(0);
  const [advanceApply, setAdvanceApply] = useState("0");

  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ doc: PreviewDoc; kind: "invoice" | "estimate" } | null>(null);

  // Auto-detect place of supply → CGST+SGST (intra) vs IGST (inter). Retail (B2C) place of
  // supply is the shop, so intra by default; a wholesale (B2B) party's GST state decides it.
  useEffect(() => {
    loadCompany().then((c) => setSellerState((c.stateCode || "").trim())).catch(() => {});
  }, []);
  const selWholesale = b2b && partyId !== "" ? (wholesaleParties.find((p) => p.id === Number(partyId)) ?? null) : null;
  const buyerState = (() => {
    const g = (selWholesale?.gstin || "").trim();
    if (/^\d{2}/.test(g)) return g.slice(0, 2);
    return (selWholesale?.state_code || "").trim();
  })();
  const interState = !!sellerState && !!buyerState && buyerState !== sellerState;

  const purityById = useMemo(() => {
    const m = new Map<number, { label: string; metalTypeId: number; sell_rate: string | null; buy_rate: string | null }>();
    for (const mt of metals)
      for (const p of mt.purities)
        m.set(p.purity_id, { label: p.label, metalTypeId: mt.metal_type_id, sell_rate: p.sell_rate, buy_rate: p.buy_rate });
    return m;
  }, [metals]);

  const purityOptions = metals.flatMap((mt) =>
    mt.purities.map((p) => ({ value: p.purity_id, label: `${mt.metal} ${p.label}` }))
  );

  // --- Old jewellery exchange helpers (metal-agnostic) ---
  const silverMetal = useMemo(() => metals.find((m) => m.metal.toLowerCase() === "silver"), [metals]);
  // Pure-silver ₹/g = buy rate of the finest silver purity (touch valuation basis).
  const silverPureRate = () => {
    const ps = silverMetal?.purities ?? [];
    if (!ps.length) return "0";
    const best = [...ps].sort((a, b) => (b.fineness || 0) - (a.fineness || 0))[0];
    return best?.buy_rate ?? "0";
  };
  // Purity options relevant to an exchange line's type (metal mount).
  const purityOptionsFor = (kind: OldGold["kind"]) => {
    const wanted = kind === "platinum" ? ["platinum"] : kind === "diamond" ? ["gold", "platinum"] : ["gold"];
    return metals
      .filter((m) => wanted.includes(m.metal.toLowerCase()))
      .flatMap((mt) => mt.purities.map((p) => ({ value: p.purity_id, label: `${mt.metal} · ${p.label}` })));
  };

  // HSN per metal, from the Materials settings (default_hsn); fallback 7113 (gold jewellery).
  const hsnByMetal = useMemo(() => {
    const m = new Map<number, string>();
    for (const mt of metals) if (mt.default_hsn) m.set(mt.metal_type_id, mt.default_hsn);
    return m;
  }, [metals]);
  const hsnForMetal = (metalTypeId?: number) => (metalTypeId ? hsnByMetal.get(metalTypeId) : undefined) ?? "7113";

  useEffect(() => {
    api.listCustomers().then(setCustomers).catch((e) => setError(`Load failed: ${msg(e)}`));
    api.listParties("wholesale").then(setWholesaleParties).catch(() => {});
    api.listStoneTypes().then(setStoneTypes).catch(() => {});
    api.listMetals().then(setMetals).catch((e) => setError(`Load failed: ${msg(e)}`));
    api.listDepartments().then((d) => setDepartments(d.filter((x) => x.active))).catch(() => {});
    api.getSettings().then((s) => setDefRates({ dia: s["rates.diamond_per_ct"] ?? "", stone: s["rates.stone_per_g"] ?? "" })).catch(() => {});
    api.listItems().then((l) => setItems(l.filter((i) => i.ownership_state === "in_stock"))).catch((e) => setError(`Load failed: ${msg(e)}`));
    if (mode === "invoice") api.listSchemes("matured").then(setSchemes).catch(() => {});
  }, []);

  // Refresh the selected customer's advance balance.
  useEffect(() => {
    if (isEstimate || customerId === "") {
      setAdvanceBalance(0);
      return;
    }
    api.listCustomerAdvances(Number(customerId)).then((d) => setAdvanceBalance(Number(d.balance) || 0)).catch(() => setAdvanceBalance(0));
    setRedeemSchemeId("");
  }, [customerId]);

  // Live per-line pricing.
  const sig = useMemo(
    () => JSON.stringify(lines.map((l) => [l.key, l.metalTypeId, l.purityId, l.netWeight, l.makingMode, l.makingValue, l.wastagePct, l.stoneValue, l.discount, l.touchPercent, l.pureRate])) + interState + touchMode + unfixed,
    [lines, interState, touchMode, unfixed]
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        lines.map(async (l) => {
          if (!l.metalTypeId || !l.purityId || !(parseFloat(l.netWeight) > 0)) return [l.key, null] as const;
          try {
            const bd = await api.pricePreview({
              metal_type_id: l.metalTypeId, purity_id: l.purityId, net_weight: l.netWeight,
              ...(touchMode
                ? { pricing_mode: "touch", touch_percent: l.touchPercent || "0", pure_rate: l.pureRate || "0" }
                : l.makingMode === "percent"
                  ? { making_percent: l.makingValue || "0" }
                  : { making_per_gram: l.makingValue || "0" }),
              wastage_percent: touchMode ? "0" : l.wastagePct || "0", stone_value: l.stoneValue || "0", discount: l.discount || "0", inter_state: interState, unfixed: unfixed || undefined,
            });
            return [l.key, bd] as const;
          } catch { return [l.key, null] as const; }
        })
      );
      if (cancelled) return;
      const map: Record<string, PriceBreakdown> = {};
      for (const [k, bd] of entries) if (bd) map[k] = bd;
      setPreviews(map);
    })();
    return () => { cancelled = true; };
  }, [sig]);

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => {
      if (l.key !== key) return l;
      const m = { ...l, ...patch };
      if (("grossWeight" in patch || "stoneWeight" in patch) && !("netWeight" in patch)) {
        const g = parseFloat(m.grossWeight) || 0;
        const s = parseFloat(m.stoneWeight) || 0;
        m.netWeight = String(Math.max(0, +(g - s).toFixed(3)));
      }
      if ("diaCt" in patch || "diaRate" in patch || "stoneRate" in patch || "stoneWeight" in patch) {
        if ("diaCt" in patch && !m.diaRate && defRates.dia) m.diaRate = defRates.dia;
        if ("stoneWeight" in patch && !m.stoneRate && defRates.stone) m.stoneRate = defRates.stone;
        const dv = (Number(m.diaCt || 0) || 0) * (Number(m.diaRate || 0) || 0) + (Number(m.stoneWeight || 0) || 0) * (Number(m.stoneRate || 0) || 0);
        if (dv > 0) m.stoneValue = String(Math.round(dv * 100) / 100);
      }
      if ("purityId" in patch && patch.purityId) {
        const info = purityById.get(patch.purityId);
        if (info) { m.metalTypeId = info.metalTypeId; m.purityLabel = info.label; m.rate = info.sell_rate ?? undefined; m.hsn = hsnForMetal(info.metalTypeId); }
      }
      return m;
    }));
  }

  function addTagged(it: Item) {
    const info = purityById.get(it.purity_id);
    const key = newKey();
    setLines((ls) => [...ls, {
      key, mode: "tagged", itemId: it.id, description: it.sku, hsn: hsnForMetal(it.metal_type_id),
      metalTypeId: it.metal_type_id, purityId: it.purity_id, purityLabel: info?.label, rate: info?.sell_rate ?? undefined,
      grossWeight: it.gross_weight, stoneWeight: String(Math.max(0, +(Number(it.gross_weight) - Number(it.net_weight)).toFixed(3))),
      netWeight: it.net_weight, makingMode: "percent", makingValue: "10", wastagePct: "0", stoneValue: "0", discount: "0", huid: "",
    }]);
    setItemQuery("");
    // Auto-flow the item's stored stone composition (and HUID) onto the line.
    api.getItem(it.id).then((d) => {
      const patch: Partial<Line> = {};
      if (d.huid) patch.huid = d.huid;
      if (d.stones && d.stones.length) {
        patch.stoneValue = String(d.stones.reduce((a, s) => a + Number(s.value), 0));
        patch.stones = d.stones.map((s) => ({
          description: s.description ?? undefined,
          carat: s.carat ?? undefined,
          pieces: s.pieces ?? undefined,
          rate: s.rate ?? undefined,
          value: s.value,
          certificate_no: s.certificate_no ?? undefined,
          lab: s.lab ?? undefined,
        }));
      }
      if (Object.keys(patch).length) updateLine(key, patch);
    }).catch(() => {});
  }
  function addLoose() {
    setLines((ls) => [...ls, {
      key: newKey(), mode: "loose", description: "", hsn: "7113", grossWeight: "0", stoneWeight: "0", netWeight: "0",
      makingMode: "percent", makingValue: "10", wastagePct: "0", stoneValue: "0", discount: "0", huid: "",
    }]);
  }
  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  // Old jewellery exchange
  function addOldGold() {
    setOldGold((og) => [...og, { key: newKey(), kind: "gold", grossWeight: "0", deductionPct: "0", rate: "0" }]);
  }
  function updateOldGold(key: string, patch: Partial<OldGold>) {
    setOldGold((og) => og.map((r) => {
      if (r.key !== key) return r;
      const m = { ...r, ...patch };
      if ("kind" in patch) {
        if (patch.kind === "silver") {
          m.metalTypeId = silverMetal?.metal_type_id;
          m.purityId = undefined; m.purityLabel = undefined;
          m.rate = silverPureRate();
          m.touch = m.touch ?? "";
          m.stoneWeight = undefined; m.buybackPct = undefined;
        } else {
          // gold / platinum / diamond → pick a metal purity; clear silver-only fields.
          m.touch = undefined;
          m.metalTypeId = undefined; m.purityId = undefined; m.purityLabel = undefined; m.rate = "0";
          if (patch.kind !== "diamond") { m.stoneWeight = undefined; m.buybackPct = undefined; }
        }
      }
      if ("purityId" in patch && patch.purityId) {
        const info = purityById.get(patch.purityId);
        if (info) { m.metalTypeId = info.metalTypeId; m.purityLabel = info.label; m.rate = info.buy_rate ?? "0"; }
      }
      return m;
    }));
  }
  const removeOldGold = (key: string) => setOldGold((og) => og.filter((r) => r.key !== key));
  // Diamond stone-type id (for mapping the inline diamond entry to a backend stone).
  const diamondTypeId = useMemo(() => stoneTypes.find((s) => s.category === "diamond")?.id, [stoneTypes]);
  // Stone weight excluded from the metal: diamond lines derive it from carat (1 ct = 0.2 g).
  function ogStoneWt(r: OldGold) {
    if (r.kind === "diamond") return (parseFloat(r.diaCt || "0") || 0) * 0.2;
    return parseFloat(r.stoneWeight || "0") || 0;
  }
  // Alloy net weight actually valued: (gross − stones) less deduction%.
  function ogBase(r: OldGold) {
    const g = parseFloat(r.grossWeight) || 0;
    const d = parseFloat(r.deductionPct) || 0;
    return Math.max(0, g - ogStoneWt(r)) * (100 - d) / 100;
  }
  // Weight shown as "valued": fine silver for touch lines, else alloy net.
  function ogNet(r: OldGold) {
    if (r.kind === "silver") return +(ogBase(r) * (parseFloat(r.touch || "0") || 0) / 100).toFixed(3);
    return +ogBase(r).toFixed(3);
  }
  // Raw (pre-buyback) diamond/stone value the customer's piece carries.
  function ogRawStone(r: OldGold) {
    if (r.kind === "diamond") return parseFloat(r.diaValue || "0") || 0;
    return r.stones?.reduce((a, s) => a + Number(s.value), 0) || 0;
  }
  function ogValue(r: OldGold) {
    const metal = r.kind === "silver"
      ? ogBase(r) * (parseFloat(r.touch || "0") || 0) / 100 * (parseFloat(r.rate) || 0)
      : ogBase(r) * (parseFloat(r.rate) || 0);
    const raw = r.stoneAction === "buy" ? ogRawStone(r) : 0;
    const factor = r.buybackPct && parseFloat(r.buybackPct) > 0 ? parseFloat(r.buybackPct) / 100 : 1;
    return +(metal + raw * factor).toFixed(2);
  }
  const oldGoldTotal = oldGold.reduce((a, r) => a + ogValue(r), 0);

  const totals = useMemo(() => {
    let metal = 0, making = 0, wastage = 0, stone = 0, taxable = 0, cgst = 0, sgst = 0, igst = 0, round = 0, grand = 0;
    for (const l of lines) {
      const b = previews[l.key];
      if (!b) continue;
      metal += +b.metal_value; making += +b.making; wastage += +b.wastage; stone += +b.stone_value;
      taxable += +b.taxable_value; cgst += +b.cgst; sgst += +b.sgst; igst += +b.igst; round += +b.round_off; grand += +b.grand_total;
    }
    return { metal, making, wastage, stone, taxable, cgst, sgst, igst, round, grand };
  }, [lines, previews]);

  // Reductions (applied after the taxed bill).
  const customerSchemes = schemes.filter((s) => customerId !== "" && s.customer_id === Number(customerId));
  const selectedScheme = schemes.find((s) => s.id === redeemSchemeId);
  const schemeCredit = !isEstimate && selectedScheme ? Number(selectedScheme.maturity_value || 0) : 0;
  const advReq = Number(advanceApply) || 0;
  const advanceAvail = !isEstimate ? Math.max(0, Math.min(advReq, advanceBalance)) : 0;

  // The manager negotiates the FINAL NET PAYABLE. Back-solve making so that
  // grand − old gold − scheme − advance = that figure  ⇒  required grand = target + deductions.
  const deductions = oldGoldTotal + schemeCredit + advanceAvail;
  const targetNum = Number(target);
  const targetGrand = targetNum + deductions;
  const targetValid = !isEstimate && target !== "" && targetNum >= 0 && targetGrand > 0 && targetGrand < totals.grand;

  const grandShown = targetValid ? targetGrand : totals.grand;
  const advanceApplied = targetValid
    ? advanceAvail
    : !isEstimate
      ? Math.max(0, Math.min(advReq, advanceBalance, Math.max(0, totals.grand - oldGoldTotal - schemeCredit)))
      : 0;
  const payable = Math.max(0, grandShown - (isEstimate ? 0 : oldGoldTotal + schemeCredit + advanceApplied));

  // Split tender helpers.
  const tenderSum = tenders.reduce((a, t) => a + (Number(t.amount) || 0), 0);
  const remaining = +(payable - tenderSum).toFixed(2);
  const tenderBalanced = isEstimate || payable <= 0 || Math.abs(remaining) < 0.005;
  function addTender() {
    setTenders((ts) => [...ts, { mode: "card", amount: remaining > 0 ? remaining.toFixed(2) : "0", reference: "" }]);
  }
  function updateTender(i: number, patch: Partial<{ mode: string; amount: string; reference: string }>) {
    setTenders((ts) => ts.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function removeTender(i: number) {
    setTenders((ts) => (ts.length > 1 ? ts.filter((_, idx) => idx !== i) : ts));
  }
  // Keep a single tender row synced to the payable (the common case).
  useEffect(() => {
    if (isEstimate) return;
    setTenders((ts) => (ts.length === 1 ? [{ ...ts[0], amount: payable > 0 ? payable.toFixed(2) : "0" }] : ts));
  }, [payable, isEstimate]);

  // Negotiated discount + effective making (for display).
  const negFixed = totals.metal + totals.wastage + totals.stone;
  const targetTaxable = targetValid ? targetGrand / 1.03 : 0;
  const negDiscount = targetValid ? Math.max(0, totals.taxable - targetTaxable) : 0;
  const negMakingPct = targetValid && totals.metal > 0 ? ((targetTaxable - negFixed) / totals.metal) * 100 : 0;
  const targetBelowFloor = !isEstimate && target !== "" && targetNum >= 0 && targetGrand / 1.03 < negFixed;

  const filteredItems = useMemo(
    () => items.filter((i) => i.sku.toLowerCase().includes(itemQuery.toLowerCase())).slice(0, 8),
    [items, itemQuery]
  );

  async function ensureCustomer(): Promise<number | undefined> {
    if (customerId !== "") return Number(customerId);
    if (quickAdd && newName.trim()) {
      const c = await api.createCustomer({ name: newName.trim(), phone: newPhone || undefined, pan: newPan || undefined });
      return c.id;
    }
    return undefined;
  }

  function buildLines() {
    const diaTypeId = stoneTypes.find((t) => t.category === "diamond")?.id;
    const nz = (v?: string) => Number(v || 0) || 0;
    return lines.map((l) => {
      // Stones: explicit popup stones, else built from inline Dia CT/rate + Stone wt/rate.
      let stones = l.stones && l.stones.length ? l.stones : undefined;
      if (!stones) {
        const arr: import("@/api").LineStoneReq[] = [];
        const dct = nz(l.diaCt), drate = nz(l.diaRate);
        if (dct > 0 && drate > 0) arr.push({ stone_type_id: diaTypeId, description: "Diamond", carat: String(dct), rate: l.diaRate, value: String(Math.round(dct * drate * 100) / 100) });
        const swt = nz(l.stoneWeight), srate = nz(l.stoneRate);
        if (swt > 0 && srate > 0) arr.push({ description: "Stone", carat: String(swt * 5), rate: l.stoneRate, value: String(Math.round(swt * srate * 100) / 100) });
        if (arr.length) stones = arr;
      }
      return {
      item_id: l.mode === "tagged" ? l.itemId : undefined,
      metal_type_id: l.mode === "loose" ? l.metalTypeId : undefined,
      purity_id: l.mode === "loose" ? l.purityId : undefined,
      description: l.description || undefined,
      hsn: l.hsn || undefined,
      huid: l.huid || undefined,
      gross_weight: l.grossWeight || undefined,
      net_weight: l.mode === "loose" ? l.netWeight : undefined,
      ...(touchMode
        ? { pricing_mode: "touch" as const, touch_percent: l.touchPercent || "0", pure_rate: l.pureRate || "0" }
        : l.makingMode === "percent"
          ? { making_percent: l.makingValue || "0" }
          : { making_per_gram: l.makingValue || "0" }),
      wastage_percent: touchMode ? "0" : l.wastagePct || "0",
      stone_value: l.stoneValue || "0",
      discount: l.discount || "0",
      department_id: l.departmentId,
      stones,
      };
    });
  }
  function buildOldGold() {
    return oldGold
      .filter((r) => r.metalTypeId && parseFloat(r.grossWeight) > 0)
      .map((r) => {
        const isSilver = r.kind === "silver";
        const touch = parseFloat(r.touch || "0") || 0;
        const pureRate = parseFloat(r.rate || "0") || 0;
        // Silver is valued on touch: send an effective ₹/g so backend value = net × rate.
        const effectiveRate = isSilver ? touch / 100 * pureRate : pureRate;
        // Diamond ornament: map the inline diamond ct + value to a single Diamond stone.
        const diaCt = parseFloat(r.diaCt || "0") || 0;
        const diaValue = parseFloat(r.diaValue || "0") || 0;
        const stones =
          r.kind === "diamond"
            ? (diaValue > 0 || diaCt > 0
                ? [{ stone_type_id: diamondTypeId, description: "Diamond", carat: r.diaCt || undefined, value: String(diaValue) }]
                : undefined)
            : (r.stones?.length ? r.stones : undefined);
        const stoneWeight =
          r.kind === "diamond"
            ? (diaCt > 0 ? String(+(diaCt * 0.2).toFixed(3)) : undefined)
            : (r.stoneWeight ? r.stoneWeight : undefined);
        const bought = r.stoneAction === "buy" && !!stones;
        return {
          metal_type_id: r.metalTypeId!,
          purity_id: r.purityId,
          kind: r.kind,
          gross_weight: r.grossWeight,
          deduction_percent: r.deductionPct || "0",
          rate: String(effectiveRate),
          stones,
          stone_action: stones ? r.stoneAction || "return" : undefined,
          tested_fineness: isSilver ? Math.round(touch * 10) : (r.testedFineness ? Number(r.testedFineness) : undefined),
          stone_weight: stoneWeight,
          buyback_percent: bought && r.buybackPct && parseFloat(r.buybackPct) > 0 ? r.buybackPct : undefined,
        };
      });
  }
  function resetBuilder() {
    setLines([]); setPreviews({}); setOldGold([]); setTarget("");
    setRedeemSchemeId(""); setAdvanceApply("0");
    setTenders([{ mode: "cash", amount: "0", reference: "" }]);
    setPartyId("");
  }

  async function post() {
    if (lines.length === 0) return;
    setError(null); setOk(null);
    const submit = async (allowBelowCost: boolean) => {
      const cid = b2b && partyId !== "" ? undefined : await ensureCustomer();
      return api.createInvoice({
        customer_id: cid, party_id: b2b && partyId !== "" ? Number(partyId) : undefined,
        invoice_type: b2b ? "b2b" : "retail", inter_state: interState, unfixed: b2b ? unfixed : undefined,
        tenders: payable > 0 ? tenders.map((t) => ({ mode: t.mode, amount: t.amount || "0", reference: t.reference || undefined })) : undefined,
        old_gold: buildOldGold(), lines: buildLines(),
        target_total: targetValid ? String(targetGrand) : undefined,
        redeem_scheme_id: redeemSchemeId === "" ? undefined : Number(redeemSchemeId),
        advance_applied: advReq > 0 ? advanceApply : undefined,
        allow_below_cost: allowBelowCost || undefined,
      });
    };
    try {
      let r;
      try {
        r = await submit(false);
      } catch (e) {
        const m = String(e instanceof Error ? e.message : e);
        if (m.includes("Below cost")) {
          const ok = await confirm({ title: "Sell below cost?", message: `${m}\n\nA manager/owner is authorising this sale below the purchase cost. Proceed?`, danger: true, confirmText: "Override & post" });
          if (!ok) return;
          r = await submit(true);
        } else { throw e; }
      }
      setOk(`Invoice ${r.document_no} posted — payable ${formatINR(r.amount_payable)}`);
      setPreview({ doc: await api.getInvoice(r.invoice_id), kind: "invoice" });
      resetBuilder();
      await api.listItems().then((l) => setItems(l.filter((i) => i.ownership_state === "in_stock")));
      onPosted?.();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  async function saveEstimate() {
    if (lines.length === 0) return;
    setError(null); setOk(null);
    try {
      const cid = await ensureCustomer();
      const r = await api.createEstimate({
        customer_id: cid, invoice_type: b2b ? "b2b" : "retail", inter_state: interState, lines: buildLines(),
      });
      setOk(`Estimate ${r.document_no} saved — valid today only.`);
      setPreview({ doc: await api.getEstimate(r.estimate_id), kind: "estimate" });
      resetBuilder();
      onPosted?.();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  const numCls = "h-7 w-full bg-transparent px-1 text-right text-sm font-mono focus:outline-none focus:bg-accent rounded-sm disabled:text-muted-foreground";

  return (
    <div className="space-y-4">
      {/* Customer */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Customer</h3>
          <div className="flex items-center gap-2">
            <ToggleChip active={!b2b} onClick={() => setB2b(false)}>Retail</ToggleChip>
            <ToggleChip active={b2b} onClick={() => setB2b(true)}>B2B / Wholesale</ToggleChip>
          </div>
        </div>
        <div className="grid grid-cols-[2fr_auto_auto] gap-3 items-end">
          {!quickAdd ? (
            <div className="space-y-1">
              <Label>{b2b ? "Select B2B party" : "Select customer"}</Label>
              {b2b ? (
                <select value={partyId} onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : "")}
                  className="flex h-8 w-full appearance-none rounded-sm border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="">Select wholesale party…</option>
                  {wholesaleParties.map((p) => <option key={p.id} value={p.id}>{p.display_name}{p.gstin ? ` · ${p.gstin}` : ""}</option>)}
                </select>
              ) : (
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : "")}
                  className="flex h-8 w-full appearance-none rounded-sm border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="">Walk-in customer</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
                </select>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 col-span-1">
              <Input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Input placeholder="Phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
              <Input placeholder={b2b ? "GSTIN/PAN" : "PAN"} value={newPan} onChange={(e) => setNewPan(e.target.value)} />
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => setQuickAdd((q) => !q)}><UserPlus className="w-3.5 h-3.5 mr-1" /> {quickAdd ? "Existing" : "New"}</Button>
          <div className="flex items-center h-8 text-[11px]">
            {sellerState ? (
              <span className={cn(
                "inline-block rounded-full border px-2 py-0.5",
                interState ? "border-amber-400/50 bg-amber-500/10 text-amber-600" : "border-emerald-400/50 bg-emerald-500/10 text-emerald-600",
              )}>
                {interState
                  ? `Inter-state → IGST (${buyerState}→${sellerState})`
                  : `Intra-state → CGST + SGST${b2b && !buyerState ? " · party state not set" : ""}`}
              </span>
            ) : (
              <span className="text-muted-foreground">Set company GST state in Settings</span>
            )}
          </div>
          {b2b && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground h-8" title="Metal unpriced — customer owes fine grams, fixed later via Rate Cutting">
              <input type="checkbox" checked={unfixed} onChange={(e) => setUnfixed(e.target.checked)} /> Unfixed (metal on account)
            </label>
          )}
          <div className="flex items-center gap-1 h-8">
            <span className="text-xs text-muted-foreground">Billing</span>
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              {([["normal", "Normal"], ["touch", "Touch"]] as const).map(([v, lbl]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setTouchMode(v === "touch")}
                  className={cn("px-2.5 h-7 text-xs", (touchMode ? "touch" : "normal") === v ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground")}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Items */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Items</h3>
          <div className="flex items-center gap-2">
            <div className="relative w-72">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Scan barcode / search SKU..."
                value={itemQuery}
                onChange={(e) => setItemQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filteredItems.length > 0) {
                    e.preventDefault();
                    addTagged(filteredItems[0]);
                    setItemQuery("");
                  }
                }}
                className="pl-8 h-8"
              />
              {itemQuery && filteredItems.length > 0 && (
                <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-lg max-h-56 overflow-y-auto">
                  {filteredItems.map((i) => (
                    <button key={i.id} onClick={() => addTagged(i)} className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-accent text-left">
                      <span className="font-mono text-xs">{i.sku}</span><span className="text-muted-foreground text-xs">net {i.net_weight} g</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={addLoose}><Plus className="w-3.5 h-3.5 mr-1" /> Add item</Button>
          </div>
        </div>

        {lines.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-xs">No lines yet — scan a tag or add an item manually.</div>
        ) : (
          <div className="space-y-3 p-3">
            {lines.map((l, idx) => {
              const b = previews[l.key];
              return (
                <div key={l.key} className="rounded-lg border border-border p-3 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground">#{idx + 1}</span>
                    <span className="text-[11px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{l.mode === "tagged" ? "tagged" : "manual"}</span>
                    <input className="flex-1 min-w-[160px] h-8 rounded-md border border-input bg-background px-2 text-sm" value={l.description} placeholder={l.mode === "loose" ? "Item / ornament" : "Description"} onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                    <div className="ml-auto flex items-center gap-3">
                      <div className="text-right"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Amount</div><div className="font-mono text-sm font-semibold">{b ? formatINR(b.grand_total) : "—"}</div></div>
                      <button onClick={() => removeLine(l.key)} className="text-destructive"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-3 gap-y-2">
                    <SField label="Type">
                      <select value={l.departmentId ?? ""} onChange={(e) => updateLine(l.key, { departmentId: e.target.value ? Number(e.target.value) : undefined })} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
                        <option value="">—</option>
                        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </SField>
                    <SField label="Metal · Purity">
                      {l.mode === "loose"
                        ? <select value={l.purityId ?? ""} onChange={(e) => updateLine(l.key, { purityId: e.target.value ? Number(e.target.value) : undefined })} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"><option value="">—</option>{purityOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                        : <div className="h-8 flex items-center text-sm px-1">{l.purityLabel ?? "—"}</div>}
                    </SField>
                    <SField label="HSN"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={l.hsn} onChange={(e) => updateLine(l.key, { hsn: e.target.value })} /></SField>
                    <SField label="Gross g"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right disabled:opacity-50" value={l.grossWeight} disabled={l.mode === "tagged"} onChange={(e) => updateLine(l.key, { grossWeight: e.target.value })} /></SField>
                    <SField label="Dia CT"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.diaCt ?? ""} placeholder="0" onChange={(e) => updateLine(l.key, { diaCt: e.target.value })} /></SField>
                    <SField label="Dia ₹/ct"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.diaRate ?? ""} placeholder="₹/ct" onChange={(e) => updateLine(l.key, { diaRate: e.target.value })} /></SField>
                    <SField label="Stone g"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right disabled:opacity-50" value={l.stoneWeight} disabled={l.mode === "tagged"} onChange={(e) => updateLine(l.key, { stoneWeight: e.target.value })} /></SField>
                    <SField label="Stone ₹/g"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.stoneRate ?? ""} placeholder="₹/g" onChange={(e) => updateLine(l.key, { stoneRate: e.target.value })} /></SField>
                    <SField label="Net g"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right disabled:opacity-50" value={l.netWeight} disabled={l.mode === "tagged"} onChange={(e) => updateLine(l.key, { netWeight: e.target.value })} /></SField>
                    <SField label={touchMode ? "Pure rate/g" : "Rate/g"}>
                      {touchMode
                        ? <input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.pureRate ?? ""} placeholder="999 rate" onChange={(e) => updateLine(l.key, { pureRate: e.target.value })} />
                        : <div className="h-8 flex items-center justify-end font-mono text-sm text-muted-foreground pr-1">{l.rate ? Number(l.rate).toLocaleString("en-IN") : "—"}</div>}
                    </SField>
                    <SField label={touchMode ? "Touch %" : "Making"}>
                      {touchMode
                        ? <input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.touchPercent ?? ""} placeholder="92.5" onChange={(e) => updateLine(l.key, { touchPercent: e.target.value })} />
                        : (<div className="flex items-center gap-1">
                            <select value={l.makingMode} onChange={(e) => updateLine(l.key, { makingMode: e.target.value as "percent" | "per_gram" })} className="h-8 rounded-md border border-input bg-background px-1 text-xs"><option value="percent">%</option><option value="per_gram">₹/g</option></select>
                            <input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.makingValue} onChange={(e) => updateLine(l.key, { makingValue: e.target.value })} />
                          </div>)}
                    </SField>
                    <SField label={touchMode ? "Fine g" : "Wastage %"}>
                      {touchMode
                        ? <div className="h-8 flex items-center justify-end font-mono text-sm text-muted-foreground pr-1">{((parseFloat(l.netWeight) || 0) * (parseFloat(l.touchPercent || "0") || 0) / 100).toFixed(3)}</div>
                        : <input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.wastagePct} onChange={(e) => updateLine(l.key, { wastagePct: e.target.value })} />}
                    </SField>
                    <SField label="Stone ₹">
                      <div className="flex items-center gap-1">
                        <input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.stoneValue} onChange={(e) => updateLine(l.key, { stoneValue: e.target.value })} />
                        <button type="button" title="Stones from catalogue" className="shrink-0 h-8 px-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:bg-accent" onClick={() => setStoneEditorKey(l.key)}><Gem className="w-3.5 h-3.5" /></button>
                      </div>
                    </SField>
                    <SField label="Discount ₹"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-right" value={l.discount} onChange={(e) => updateLine(l.key, { discount: e.target.value })} /></SField>
                    <SField label="HUID"><input className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={l.huid} onChange={(e) => updateLine(l.key, { huid: e.target.value })} /></SField>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Old gold exchange (invoice only) */}
      {!isEstimate && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold flex items-center gap-1.5"><Coins className="w-4 h-4 text-gold" /> Old Jewellery Exchange <span className="text-[11px] font-normal text-muted-foreground">(gross enters stock · deduction reduces only the amount paid · no GST · silver by touch% · diamonds returned or bought back)</span></h3>
            <Button variant="outline" size="sm" onClick={addOldGold}><Plus className="w-3.5 h-3.5 mr-1" /> Add old item</Button>
          </div>
          {oldGold.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-xs">No old jewellery taken in exchange.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Metal · Purity</th>
                  <th className="px-3 py-2 text-right">Gross g (→ stock)</th>
                  <th className="px-3 py-2 text-right">Stone wt g / Dia ct</th>
                  <th className="px-3 py-2 text-right">Deduction %</th>
                  <th className="px-3 py-2 text-right">Touch% / Tested‰ / Dia ₹</th>
                  <th className="px-3 py-2 text-right">Net g (valued)</th>
                  <th className="px-3 py-2 text-right">Rate/g</th>
                  <th className="px-3 py-2 text-right">Value</th>
                  <th className="px-1 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {oldGold.map((r) => (
                  <tr key={r.key} className="border-b border-border last:border-0">
                    <td className="px-2 py-1">
                      <select value={r.kind} onChange={(e) => updateOldGold(r.key, { kind: e.target.value as OldGold["kind"] })} className="h-7 bg-transparent text-sm focus:outline-none focus:bg-accent rounded-sm">
                        <option value="gold">Old Gold Ornament</option>
                        <option value="diamond">Old Diamond Ornament</option>
                        <option value="silver">Old Silver Ornament (touch)</option>
                        <option value="platinum">Old Platinum Ornament</option>
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      {r.kind === "silver" ? (
                        <span className="text-sm text-muted-foreground">Silver</span>
                      ) : (
                        <select value={r.purityId ?? ""} onChange={(e) => updateOldGold(r.key, { purityId: e.target.value ? Number(e.target.value) : undefined })} className="h-7 w-44 bg-transparent text-sm focus:outline-none focus:bg-accent rounded-sm">
                          <option value="">— select —</option>
                          {purityOptionsFor(r.kind).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="px-2 py-1"><input className={numCls} value={r.grossWeight} onChange={(e) => updateOldGold(r.key, { grossWeight: e.target.value })} /></td>
                    <td className="px-2 py-1">
                      {r.kind === "diamond" ? (
                        <input className={numCls} value={r.diaCt ?? ""} placeholder="dia ct" onChange={(e) => updateOldGold(r.key, { diaCt: e.target.value })} />
                      ) : (
                        <input className={numCls} value={r.stoneWeight ?? ""} placeholder="0" disabled={r.kind === "silver"} onChange={(e) => updateOldGold(r.key, { stoneWeight: e.target.value })} />
                      )}
                    </td>
                    <td className="px-2 py-1"><input className={numCls} value={r.deductionPct} onChange={(e) => updateOldGold(r.key, { deductionPct: e.target.value })} /></td>
                    <td className="px-2 py-1">
                      {r.kind === "silver" ? (
                        <input className={numCls} value={r.touch ?? ""} placeholder="touch %" onChange={(e) => updateOldGold(r.key, { touch: e.target.value })} />
                      ) : r.kind === "diamond" ? (
                        <input className={numCls} value={r.diaValue ?? ""} placeholder="dia ₹" onChange={(e) => updateOldGold(r.key, { diaValue: e.target.value })} />
                      ) : (
                        <input className={numCls} value={r.testedFineness ?? ""} placeholder="—" onChange={(e) => updateOldGold(r.key, { testedFineness: e.target.value })} />
                      )}
                    </td>
                    <td className="px-3 py-1 text-right font-mono text-muted-foreground">{ogNet(r).toFixed(3)}</td>
                    <td className="px-2 py-1"><input className={numCls} value={r.rate} onChange={(e) => updateOldGold(r.key, { rate: e.target.value })} /></td>
                    <td className="px-3 py-1 text-right font-mono font-semibold">{formatINR(ogValue(r))}</td>
                    <td className="px-1">
                      <div className="flex items-center gap-1 justify-end">
                        {(r.kind === "diamond"
                          ? ((parseFloat(r.diaValue || "0") || 0) > 0 || (parseFloat(r.diaCt || "0") || 0) > 0)
                          : (r.stones?.length ?? 0) > 0) && (
                          <>
                            <select
                              value={r.stoneAction || "return"}
                              onChange={(e) => updateOldGold(r.key, { stoneAction: e.target.value as "return" | "buy" })}
                              className="h-7 text-[11px] bg-transparent border border-input rounded-sm"
                            >
                              <option value="return">return {r.kind === "diamond" ? "diamond" : "stone"}</option>
                              <option value="buy">buy {r.kind === "diamond" ? "diamond" : "stone"}</option>
                            </select>
                            {r.stoneAction === "buy" && (
                              <select
                                title="Diamond buyback — % of assessed value paid"
                                value={r.buybackPct ?? ""}
                                onChange={(e) => updateOldGold(r.key, { buybackPct: e.target.value })}
                                className="h-7 text-[11px] bg-transparent border border-input rounded-sm"
                              >
                                <option value="">manual</option>
                                <option value="70">70%</option>
                                <option value="80">80%</option>
                              </select>
                            )}
                          </>
                        )}
                        {(r.kind === "gold" || r.kind === "platinum") && (
                          <button title="Recovered stones" onClick={() => setOgStoneEditorKey(r.key)} className="text-muted-foreground hover:text-primary">
                            <Gem className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => removeOldGold(r.key)} className="text-destructive">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                <tr className="bg-muted/30">
                  <td className="px-3 py-2 text-xs text-muted-foreground" colSpan={8}>Total old jewellery (deducted from payable, no GST)</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">− {formatINR(oldGoldTotal)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* Scheme redemption + customer advance (invoice only) */}
      {!isEstimate && (
        <Card className="p-4 grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>Scheme redemption</Label>
            <select
              value={redeemSchemeId}
              onChange={(e) => setRedeemSchemeId(e.target.value ? Number(e.target.value) : "")}
              disabled={customerId === ""}
              className="flex h-8 w-full appearance-none rounded-sm border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <option value="">{customerId === "" ? "Select a customer first" : "No scheme"}</option>
              {customerSchemes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.scheme_no || `Scheme #${s.id}`} — matured{s.maturity_value ? ` ₹${s.maturity_value}` : ""}
                </option>
              ))}
            </select>
            {selectedScheme && <p className="text-[11px] text-muted-foreground">Credit: {formatINR(schemeCredit)}{selectedScheme.maturity_value ? "" : " (gram scheme — valued at today's rate on post)"}</p>}
          </div>
          <div className="space-y-1">
            <Label>Customer advance {customerId !== "" && <span className="text-muted-foreground">(available {formatINR(advanceBalance)})</span>}</Label>
            <Input value={advanceApply} onChange={(e) => setAdvanceApply(e.target.value)} disabled={customerId === "" || advanceBalance <= 0} className="font-mono" />
            {customerId !== "" && advanceBalance <= 0 && <p className="text-[11px] text-muted-foreground">No advance on this customer.</p>}
          </div>
        </Card>
      )}

      {/* Totals + actions */}
      <div className="grid grid-cols-[1fr_1fr] gap-4">
        {!isEstimate && (
          <Card className="p-4 h-fit space-y-2">
            <div className="flex items-center justify-between">
              <Label>Payment split</Label>
              <Button variant="outline" size="sm" onClick={addTender} disabled={remaining <= 0}><Plus className="w-3.5 h-3.5 mr-1" /> Add</Button>
            </div>
            {tenders.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={t.mode}
                  onChange={(e) => updateTender(i, { mode: e.target.value })}
                  className="h-8 w-32 appearance-none rounded-sm border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="upi">UPI</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="cheque">Cheque</option>
                  <option value="credit">Credit (due)</option>
                </select>
                <Input value={t.amount} onChange={(e) => updateTender(i, { amount: e.target.value })} className="font-mono w-28 text-right" />
                {(t.mode === "cheque" || t.mode === "bank_transfer") && (
                  <Input value={t.reference} onChange={(e) => updateTender(i, { reference: e.target.value })} placeholder={t.mode === "cheque" ? "Cheque no." : "UTR / ref"} className="flex-1" />
                )}
                {tenders.length > 1 && <button onClick={() => removeTender(i)} className="text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>}
              </div>
            ))}
            <div className="flex items-center justify-between text-xs pt-1 border-t border-border">
              <span className="text-muted-foreground">Net payable</span>
              <span className="font-mono">{formatINR(payable)}</span>
            </div>
            {payable > 0 && (
              <div className={"text-xs font-medium " + (tenderBalanced ? "text-success" : "text-destructive")}>
                {Math.abs(remaining) < 0.005 ? "✓ Balanced" : remaining > 0 ? `To allocate: ${formatINR(remaining)}` : `Over by ${formatINR(-remaining)}`}
              </div>
            )}
          </Card>
        )}

        <Card className="p-4 h-fit">
          {!isEstimate && (
            <div className="mb-3 space-y-1">
              <Label>Negotiated net payable (₹) — final amount to collect</Label>
              <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={`payable now ${Math.round(Math.max(0, totals.grand - deductions))}`} className="font-mono" />
              {targetBelowFloor && <p className="text-[11px] text-destructive">Below the metal + stone + wastage floor — discount can't go that low.</p>}
            </div>
          )}
          <div className="rounded-md border border-border divide-y divide-border text-sm">
            <Row label="Metal value" value={formatINR(totals.metal)} />
            <Row label="Making" value={formatINR(totals.making)} />
            {totals.wastage > 0 && <Row label="Wastage" value={formatINR(totals.wastage)} />}
            {totals.stone > 0 && <Row label="Stone / charges" value={formatINR(totals.stone)} />}
            <Row label="Taxable" value={formatINR(totals.taxable)} strong />
            {interState ? <Row label="IGST 3%" value={formatINR(totals.igst)} /> : (<><Row label="CGST 1.5%" value={formatINR(totals.cgst)} /><Row label="SGST 1.5%" value={formatINR(totals.sgst)} /></>)}
            {totals.round !== 0 && <Row label="Round off" value={formatINR(totals.round)} />}
            <Row label={targetValid ? "List total" : "Grand total"} value={formatINR(totals.grand)} strong />
            {targetValid && (
              <>
                <Row label="Negotiated discount" value={`− ${formatINR(negDiscount)}`} />
                <Row label="Eff. making (after discount)" value={`${negMakingPct.toFixed(2)}%`} />
                <Row label="Discounted bill total" value={formatINR(grandShown)} strong />
              </>
            )}
            {!isEstimate && oldGoldTotal > 0 && <Row label="Less: old jewellery" value={`− ${formatINR(oldGoldTotal)}`} />}
            {!isEstimate && schemeCredit > 0 && <Row label="Less: scheme redemption" value={`− ${formatINR(schemeCredit)}`} />}
            {!isEstimate && advanceApplied > 0 && <Row label="Less: advance applied" value={`− ${formatINR(advanceApplied)}`} />}
            <div className="flex items-center justify-between px-3 py-2.5 bg-muted/40">
              <span className="font-semibold">{isEstimate ? "Estimated total" : "Net payable"}</span>
              <span className="font-bold font-mono text-base">{formatINR(payable)}</span>
            </div>
          </div>

          {ok && <div className="mt-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success"><CheckCircle2 className="w-4 h-4" /> {ok}</div>}
          {error && <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

          {isEstimate ? (
            <div className="mt-3 space-y-2">
              <Button className="w-full" size="lg" disabled={lines.length === 0} onClick={saveEstimate}>Save estimate</Button>
              <p className="text-[11px] text-muted-foreground"><Badge variant="warning">Valid today only</Badge> GST shown is indicative. Convert from the list below.</p>
            </div>
          ) : (
            <Button className="w-full mt-3" size="lg" disabled={lines.length === 0 || !tenderBalanced} onClick={post}>{tenderBalanced ? "Post invoice" : `Allocate ${formatINR(Math.abs(remaining))} in payments`}</Button>
          )}
        </Card>
      </div>

      {preview && <InvoicePreview doc={preview.doc} kind={preview.kind} onClose={() => setPreview(null)} />}
      {stoneEditorKey && (
        <StonePicker
          stoneTypes={stoneTypes}
          onApply={(total, stones) => {
            updateLine(stoneEditorKey, { stoneValue: String(total), stones });
            setStoneEditorKey(null);
          }}
          onClose={() => setStoneEditorKey(null)}
        />
      )}
      {ogStoneEditorKey && (
        <StonePicker
          stoneTypes={stoneTypes}
          onApply={(_total, stones) => {
            const stoneG = stones.reduce((a, st) => a + (st.carat ? Number(st.carat) * 0.2 : 0), 0);
            updateOldGold(ogStoneEditorKey, {
              stones,
              stoneWeight: stoneG > 0 ? String(+stoneG.toFixed(3)) : undefined,
              stoneAction: oldGold.find((o) => o.key === ogStoneEditorKey)?.stoneAction || "return",
            });
            setOgStoneEditorKey(null);
          }}
          onClose={() => setOgStoneEditorKey(null)}
        />
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className={strong ? "text-foreground font-medium" : "text-muted-foreground"}>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
function ToggleChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={"px-2.5 py-1 rounded-full text-xs font-medium transition-colors " + (active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}>{children}</button>;
}

function msg(e: unknown) {
  return String(e instanceof Error ? e.message : e);
}

function SField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5 truncate">{label}</div>
      {children}
    </div>
  );
}
