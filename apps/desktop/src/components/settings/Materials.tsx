import { useEffect, useState } from "react";
import { Gem, Layers, Plus, Tag, Boxes } from "lucide-react";
import * as api from "@/api";
import type { MetalTypeMaster, StoneCategory, StonePricingMode, StoneTypeMaster } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, formatINR } from "@/lib/utils";

const sel = "flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm";
const CATEGORIES: StoneCategory[] = ["diamond", "precious", "semi_precious", "pearl", "synthetic"];
const PRICING: StonePricingMode[] = ["per_carat_quality", "per_carat_flat", "per_piece"];

export function Materials() {
  const [tab, setTab] = useState<"metals" | "stones" | "categories" | "departments">("metals");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="inline-flex h-9 items-center gap-0.5 border-b border-border">
        {(["metals", "stones", "categories", "departments"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-2 text-sm capitalize transition-colors",
              tab === t ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "metals" ? <Layers className="w-4 h-4" /> : t === "stones" ? <Gem className="w-4 h-4" /> : t === "categories" ? <Tag className="w-4 h-4" /> : <Boxes className="w-4 h-4" />}
            {t}
          </button>
        ))}
      </div>
      {err && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}
      {tab === "metals" ? <MetalsTab onErr={setErr} /> : tab === "stones" ? <StonesTab onErr={setErr} /> : tab === "categories" ? <CategoriesTab onErr={setErr} /> : <DepartmentsTab onErr={setErr} />}
    </div>
  );
}

function CategoriesTab({ onErr }: { onErr: (e: string | null) => void }) {
  const [cats, setCats] = useState<import("@/api").ItemCategory[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setCats(await api.listItemCategories());
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    onErr(null);
    try {
      await api.createItemCategory({ name });
      setName("");
      await load();
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-4">
        <div className="flex items-end gap-3">
          <div className="flex-1 max-w-xs">
            <div className="text-xs text-muted-foreground mb-1">New product / ornament category</div>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Necklace, Ring, Bangle, Chain" />
          </div>
          <Button onClick={add} disabled={busy}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">Manage your product types / ornament categories. These group items on purchase and stock screens — e.g. Necklace, Ring, Bangle, Earring, Chain, Pendant, Bracelet, Toe Ring.</p>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Category (product type)</th>
              <th className="text-center px-4 py-2 font-medium text-muted-foreground">Active</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => (
              <CategoryRow key={c.id} cat={c} onReload={load} onErr={onErr} />
            ))}
            {cats.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-muted-foreground text-sm">No categories. Add some above.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function CategoryRow({ cat: c, onReload, onErr }: { cat: import("@/api").ItemCategory; onReload: () => Promise<void>; onErr: (e: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(c.name);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [vars, setVars] = useState<import("@/api").CategoryVariation[]>([]);
  const [newVar, setNewVar] = useState("");

  async function loadVars() {
    try { setVars(await api.listVariations(c.id)); } catch { /* ignore */ }
  }
  function toggle() {
    if (!expanded) loadVars();
    setExpanded((e) => !e);
  }

  async function saveName() {
    if (!editName.trim() || editName.trim() === c.name) { setEditing(false); return; }
    setBusy(true); onErr(null);
    try {
      await api.updateItemCategory(c.id, { name: editName.trim() });
      setEditing(false);
      await onReload();
    } catch (e) { onErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  async function del() {
    if (!window.confirm(`Delete "${c.name}"? This only works if no items use it.`)) return;
    setBusy(true); onErr(null);
    try {
      await api.deleteItemCategory(c.id);
      await onReload();
    } catch (e) { onErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  async function addVar() {
    if (!newVar.trim()) return;
    try {
      await api.createVariation(c.id, { name: newVar.trim() });
      setNewVar("");
      await loadVars();
    } catch (e) { onErr(String(e instanceof Error ? e.message : e)); }
  }

  async function delVar(v: import("@/api").CategoryVariation) {
    if (!window.confirm(`Delete variation "${v.name}"?`)) return;
    try { await api.deleteVariation(v.id); await loadVars(); }
    catch (e) { onErr(String(e instanceof Error ? e.message : e)); }
  }

  return (
    <>
      <tr className="border-b border-border last:border-0">
        <td className="px-4 py-1.5">
          {editing ? (
            <div className="flex items-center gap-2">
              <Input className="h-7 w-48" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveName()} autoFocus />
              <Button variant="outline" size="sm" onClick={saveName} disabled={busy}>Save</Button>
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setEditName(c.name); }}>Cancel</Button>
            </div>
          ) : (
            <span className="cursor-pointer hover:text-primary font-medium" onClick={() => setEditing(true)} title="Click to rename">{c.name}</span>
          )}
        </td>
        <td className="px-4 py-1.5 text-center">
          <input type="checkbox" checked={c.active} onChange={(e) => api.updateItemCategory(c.id, { active: e.target.checked }).then(onReload)} />
        </td>
        <td className="px-4 py-1.5 text-right">
          <div className="flex items-center justify-end gap-1">
            <button onClick={toggle} className="text-xs text-primary hover:underline px-1">{expanded ? "Hide" : "Variations"}</button>
            <button onClick={() => setEditing(true)} className="text-xs text-muted-foreground hover:text-primary px-1">Edit</button>
            <button onClick={del} className="text-xs text-destructive hover:text-destructive/80 px-1" disabled={busy}>Delete</button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border">
          <td colSpan={3} className="px-6 py-2 bg-muted/20">
            <div className="text-xs text-muted-foreground mb-1">Variations of <b>{c.name}</b></div>
            <div className="flex flex-wrap gap-2 mb-2">
              {vars.map((v) => (
                <span key={v.id} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${v.active ? "border-border" : "border-border/50 text-muted-foreground line-through"}`}>
                  {v.name}
                  <button onClick={() => api.updateVariation(v.id, { active: !v.active }).then(loadVars)} className="text-muted-foreground hover:text-primary" title={v.active ? "Deactivate" : "Activate"}>{v.active ? "○" : "●"}</button>
                  <button onClick={() => delVar(v)} className="text-destructive hover:text-destructive/80" title="Delete">×</button>
                </span>
              ))}
              {vars.length === 0 && <span className="text-xs text-muted-foreground">No variations yet.</span>}
            </div>
            <div className="flex items-center gap-2">
              <Input className="h-7 w-48" value={newVar} onChange={(e) => setNewVar(e.target.value)} placeholder="Add variation (e.g. Choker)" onKeyDown={(e) => e.key === "Enter" && addVar()} />
              <Button variant="outline" size="sm" onClick={addVar}><Plus className="w-3 h-3 mr-1" />Add</Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DepartmentsTab({ onErr }: { onErr: (e: string | null) => void }) {
  const [depts, setDepts] = useState<import("@/api").Department[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setDepts(await api.listDepartments()); }
    catch (e) { onErr(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true); onErr(null);
    try {
      const nextSort = (depts.reduce((m, d) => Math.max(m, d.sort_order), 0) || 0) + 10;
      await api.createDepartment({ name: name.trim(), sort_order: nextSort });
      setName("");
      await load();
    } catch (e) { onErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-4">
        <div className="flex items-end gap-3">
          <div className="flex-1 max-w-xs">
            <div className="text-xs text-muted-foreground mb-1">New department (jewellery type)</div>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diamond Ornaments" />
          </div>
          <Button onClick={add} disabled={busy}><Plus className="w-4 h-4 mr-1" /> Add</Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">Departments group your stock above metal — e.g. Gold Ornaments, Fine Gold, Diamond Ornaments, Silver, Platinum. Each item picks a department + its metal &amp; purity.</p>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Department</th>
              <th className="text-center px-4 py-2 font-medium text-muted-foreground w-24">Order</th>
              <th className="text-center px-4 py-2 font-medium text-muted-foreground w-20">Active</th>
            </tr>
          </thead>
          <tbody>
            {depts.map((d) => (
              <tr key={d.id} className="border-b border-border last:border-0">
                <td className="px-4 py-1.5">
                  <input className="bg-transparent focus:outline-none w-full" defaultValue={d.name}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== d.name) api.updateDepartment(d.id, { name: v }).then(load); }} />
                </td>
                <td className="px-4 py-1.5 text-center">
                  <input type="number" className="w-16 text-center bg-transparent focus:outline-none" defaultValue={d.sort_order}
                    onBlur={(e) => { const v = Number(e.target.value); if (v !== d.sort_order) api.updateDepartment(d.id, { sort_order: v }).then(load); }} />
                </td>
                <td className="px-4 py-1.5 text-center">
                  <input type="checkbox" checked={d.active} onChange={(e) => api.updateDepartment(d.id, { active: e.target.checked }).then(load)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function MetalsTab({ onErr }: { onErr: (e: string | null) => void }) {
  const [metals, setMetals] = useState<MetalTypeMaster[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // add-purity inline state per metal
  const [pur, setPur] = useState<Record<number, { label: string; fineness: string; karat: string }>>({});

  async function load() {
    try {
      setMetals(await api.listMetalTypes());
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function addMetal() {
    if (!name.trim()) return;
    setBusy(true);
    onErr(null);
    try {
      await api.createMetalType({ name });
      setName("");
      await load();
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  async function patchMetal(id: number, body: Parameters<typeof api.updateMetalType>[1]) {
    try {
      await api.updateMetalType(id, body);
      await load();
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    }
  }
  async function addPurity(mid: number) {
    const p = pur[mid];
    if (!p?.label || !p?.fineness) return;
    try {
      await api.createPurity({ metal_type_id: mid, label: p.label, fineness: Number(p.fineness), karat: p.karat || undefined });
      setPur((s) => ({ ...s, [mid]: { label: "", fineness: "", karat: "" } }));
      await load();
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-end gap-3">
          <div className="flex-1 max-w-xs">
            <div className="text-xs text-muted-foreground mb-1">New metal (e.g. palladium)</div>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="metal name" />
          </div>
          <Button onClick={addMetal} disabled={busy}>
            <Plus className="w-4 h-4 mr-1" /> Add metal
          </Button>
        </div>
      </Card>

      {metals.map((m) => (
        <Card key={m.id} className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
            <div className="text-sm font-semibold capitalize">{m.name}</div>
            {!m.active && <Badge variant="secondary">inactive</Badge>}
            <div className="ml-auto flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                HSN
                <Input
                  className="h-7 w-20"
                  defaultValue={m.default_hsn ?? ""}
                  onBlur={(e) => e.target.value !== (m.default_hsn ?? "") && patchMetal(m.id, { default_hsn: e.target.value })}
                />
              </label>
              <label className="flex items-center gap-1">
                GST %
                <Input
                  className="h-7 w-16 text-right"
                  defaultValue={m.gst_rate ?? ""}
                  onBlur={(e) => e.target.value !== (m.gst_rate ?? "") && patchMetal(m.id, { gst_rate: e.target.value })}
                />
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={m.hallmark_applicable}
                  onChange={(e) => patchMetal(m.id, { hallmark_applicable: e.target.checked })}
                />
                Hallmark
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={m.active} onChange={(e) => patchMetal(m.id, { active: e.target.checked })} />
                Active
              </label>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left px-4 py-1.5 font-medium text-muted-foreground">Purity</th>
                <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Karat</th>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Fineness /1000</th>
                <th className="text-center px-4 py-1.5 font-medium text-muted-foreground">Active</th>
              </tr>
            </thead>
            <tbody>
              {m.purities.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-1.5">{p.label}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{p.karat ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{p.fineness}</td>
                  <td className="px-4 py-1.5 text-center">
                    <input type="checkbox" checked={p.active} onChange={(e) => api.updatePurity(p.id, { active: e.target.checked }).then(load)} />
                  </td>
                </tr>
              ))}
              <tr className="bg-muted/20">
                <td className="px-2 py-1.5">
                  <Input className="h-7" placeholder="label e.g. 20K" value={pur[m.id]?.label ?? ""} onChange={(e) => setPur((s) => ({ ...s, [m.id]: { ...(s[m.id] ?? { label: "", fineness: "", karat: "" }), label: e.target.value } }))} />
                </td>
                <td className="px-2 py-1.5">
                  <Input className="h-7 w-16" placeholder="karat" value={pur[m.id]?.karat ?? ""} onChange={(e) => setPur((s) => ({ ...s, [m.id]: { ...(s[m.id] ?? { label: "", fineness: "", karat: "" }), karat: e.target.value } }))} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Input className="h-7 w-20 text-right" placeholder="fineness" value={pur[m.id]?.fineness ?? ""} onChange={(e) => setPur((s) => ({ ...s, [m.id]: { ...(s[m.id] ?? { label: "", fineness: "", karat: "" }), fineness: e.target.value } }))} />
                </td>
                <td className="px-2 py-1.5 text-center">
                  <Button size="sm" variant="outline" onClick={() => addPurity(m.id)}>
                    Add
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function StonesTab({ onErr }: { onErr: (e: string | null) => void }) {
  const [stones, setStones] = useState<StoneTypeMaster[]>([]);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: "", category: "precious" as StoneCategory, unit: "carat", pricing_mode: "per_carat_flat" as StonePricingMode });
  const [q, setQ] = useState<Record<number, { grade: string; color: string; clarity: string; band: string; rate: string }>>({});

  async function load() {
    try {
      setStones(await api.listStoneTypes());
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function addStone() {
    if (!f.name.trim()) return;
    setBusy(true);
    onErr(null);
    try {
      await api.createStoneType({ name: f.name, category: f.category, unit: f.unit as "carat" | "piece", pricing_mode: f.pricing_mode });
      setF({ ...f, name: "" });
      await load();
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  async function patchStone(id: number, body: Parameters<typeof api.updateStoneType>[1]) {
    try {
      await api.updateStoneType(id, body);
      await load();
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    }
  }
  async function addQuality(sid: number) {
    const x = q[sid];
    if (!x?.grade || !x?.rate) return;
    try {
      await api.createStoneQuality({ stone_type_id: sid, grade_label: x.grade, color: x.color || undefined, clarity: x.clarity || undefined, size_band: x.band || undefined, rate_per_carat: x.rate });
      setQ((s) => ({ ...s, [sid]: { grade: "", color: "", clarity: "", band: "", rate: "" } }));
      await load();
    } catch (e) {
      onErr(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Stone name</div>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Tanzanite" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Category</div>
            <select className={sel} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as StoneCategory })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
            </select>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Unit</div>
            <select className={sel} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
              <option value="carat">carat</option>
              <option value="piece">piece</option>
            </select>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Pricing</div>
            <select className={sel} value={f.pricing_mode} onChange={(e) => setF({ ...f, pricing_mode: e.target.value as StonePricingMode })}>
              {PRICING.map((p) => <option key={p} value={p}>{p.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          <Button onClick={addStone} disabled={busy}>
            <Plus className="w-4 h-4 mr-1" /> Add stone
          </Button>
        </div>
      </Card>

      {stones.map((st) => (
        <Card key={st.id} className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
            <div className="text-sm font-semibold">{st.name}</div>
            <Badge variant="secondary" className="capitalize">{st.category.replace("_", " ")}</Badge>
            <span className="text-xs text-muted-foreground">{st.unit} · {st.pricing_mode.replace(/_/g, " ")}</span>
            {st.certifiable && <Badge variant="default">certifiable</Badge>}
            <div className="ml-auto flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                HSN
                <Input className="h-7 w-20" defaultValue={st.default_hsn ?? ""} onBlur={(e) => e.target.value !== (st.default_hsn ?? "") && patchStone(st.id, { default_hsn: e.target.value })} />
              </label>
              <label className="flex items-center gap-1">
                GST %
                <Input className="h-7 w-16 text-right" defaultValue={st.gst_rate ?? ""} onBlur={(e) => e.target.value !== (st.gst_rate ?? "") && patchStone(st.id, { gst_rate: e.target.value })} />
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={st.certifiable} onChange={(e) => patchStone(st.id, { certifiable: e.target.checked })} /> Cert
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={st.active} onChange={(e) => patchStone(st.id, { active: e.target.checked })} /> Active
              </label>
            </div>
          </div>

          {st.pricing_mode === "per_carat_quality" && (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left px-4 py-1.5 font-medium text-muted-foreground">Grade</th>
                  <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Colour</th>
                  <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Clarity</th>
                  <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Size band</th>
                  <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Rate / carat</th>
                  <th className="px-4 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {st.qualities.map((qq) => (
                  <tr key={qq.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-1.5">{qq.grade_label}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{qq.color ?? "—"}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{qq.clarity ?? "—"}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{qq.size_band ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatINR(qq.rate_per_carat)}</td>
                    <td className="px-4 py-1.5 text-center">
                      <input type="checkbox" checked={qq.active} onChange={(e) => api.updateStoneQuality(qq.id, { active: e.target.checked }).then(load)} />
                    </td>
                  </tr>
                ))}
                <tr className="bg-muted/20">
                  <td className="px-2 py-1.5"><Input className="h-7" placeholder="grade" value={q[st.id]?.grade ?? ""} onChange={(e) => setQ((s) => ({ ...s, [st.id]: { ...(s[st.id] ?? { grade: "", color: "", clarity: "", band: "", rate: "" }), grade: e.target.value } }))} /></td>
                  <td className="px-2 py-1.5"><Input className="h-7 w-16" placeholder="G" value={q[st.id]?.color ?? ""} onChange={(e) => setQ((s) => ({ ...s, [st.id]: { ...(s[st.id] ?? { grade: "", color: "", clarity: "", band: "", rate: "" }), color: e.target.value } }))} /></td>
                  <td className="px-2 py-1.5"><Input className="h-7 w-16" placeholder="VS1" value={q[st.id]?.clarity ?? ""} onChange={(e) => setQ((s) => ({ ...s, [st.id]: { ...(s[st.id] ?? { grade: "", color: "", clarity: "", band: "", rate: "" }), clarity: e.target.value } }))} /></td>
                  <td className="px-2 py-1.5"><Input className="h-7 w-24" placeholder="0.3-0.5ct" value={q[st.id]?.band ?? ""} onChange={(e) => setQ((s) => ({ ...s, [st.id]: { ...(s[st.id] ?? { grade: "", color: "", clarity: "", band: "", rate: "" }), band: e.target.value } }))} /></td>
                  <td className="px-2 py-1.5 text-right"><Input className="h-7 w-28 text-right" placeholder="₹/ct" value={q[st.id]?.rate ?? ""} onChange={(e) => setQ((s) => ({ ...s, [st.id]: { ...(s[st.id] ?? { grade: "", color: "", clarity: "", band: "", rate: "" }), rate: e.target.value } }))} /></td>
                  <td className="px-2 py-1.5 text-center"><Button size="sm" variant="outline" onClick={() => addQuality(st.id)}>Add</Button></td>
                </tr>
              </tbody>
            </table>
          )}
          {st.pricing_mode !== "per_carat_quality" && (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Priced {st.pricing_mode.replace(/_/g, " ")} — value entered per line at billing (no quality grades).
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
