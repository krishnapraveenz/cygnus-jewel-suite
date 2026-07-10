import { useEffect, useState } from "react";
import { Contact, X, Pencil, Trash2 } from "lucide-react";
import * as api from "@/api";
import type { MetalOpt, PartyDetail, PartyLedgerRow, PartyListRow, PartyRole, NewPartyReq } from "@/api";
import { GST_STATE_CODES } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatINR } from "@/lib/utils";
import { confirm, alertDialog } from "@/lib/dialog";

const ROLE_TABS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "customer", label: "Customers" },
  { id: "wholesale", label: "Wholesale" },
  { id: "supplier", label: "Suppliers" },
  { id: "smith", label: "Smiths" },
];
const ALL_ROLES: PartyRole[] = ["customer", "wholesale", "supplier", "smith", "broker", "consignee"];

const sel = "flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm";

export function Parties() {
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PartyListRow[]>([]);
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [openEdit, setOpenEdit] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  async function load() {
    try {
      const [p, m] = await Promise.all([
        api.listParties(tab === "all" ? undefined : tab, q || undefined, showArchived),
        api.listMetals(),
      ]);
      setRows(p);
      setMetals(m);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, showArchived]);

  async function restore(p: PartyListRow) {
    try {
      await api.restoreParty(p.id);
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function delParty(p: PartyListRow) {
    const ok = await confirm({
      title: "Delete party?",
      message: `Delete "${p.display_name}"?\n\nIf this party has invoices or ledger history it will be archived (hidden) to preserve records; otherwise it is permanently removed.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.deleteParty(p.id);
      setError(null);
      await load();
      if (r.archived)
        await alertDialog({
          title: "Archived",
          message: `"${p.display_name}" has invoice/ledger history, so it was archived (hidden) rather than permanently deleted. You can view it via "Show archived".`,
        });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Parties</h2>
          <p className="text-sm text-muted-foreground">
            One record per entity, many roles — customers, wholesale dealers, suppliers, smiths. Cash &amp; metal (gram khata) in one place.
          </p>
        </div>
        <div className="flex gap-2">
          <Input className="w-56" placeholder="Search name / phone / GSTIN…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
          <Button variant={showArchived ? "default" : "outline"} onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Viewing archived" : "Show archived"}
          </Button>
          <Button onClick={() => setCreating(true)}>New party</Button>
        </div>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

      <div className="inline-flex h-9 items-center gap-0.5 border-b border-border">
        {ROLE_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "inline-flex items-center px-3 py-2 text-sm transition-colors",
              tab === t.id ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Roles</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Phone</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">GSTIN / PAN</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cash</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Metal (g)</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent cursor-pointer" onClick={() => setSelId(r.id)}>
                <td className="px-3 py-2">
                  {r.display_name}
                  <span className="ml-2 text-xs text-muted-foreground">{r.party_kind === "business" ? "B2B" : "Retail"}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {r.roles.map((ro) => (
                      <Badge key={ro} variant="secondary" className="text-[10px]">
                        {ro}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{r.phone || "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.gstin || r.pan || "—"}</td>
                <td className={cn("px-3 py-2 text-right font-mono", Number(r.cash_balance) < 0 && "text-destructive")}>
                  {Number(r.cash_balance) !== 0 ? formatINR(Math.abs(Number(r.cash_balance))) : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono">{Number(r.metal_balance) !== 0 ? Number(r.metal_balance).toFixed(3) : "—"}</td>
                <td className="px-3 py-2 text-right">
                  {showArchived ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        restore(r);
                      }}
                    >
                      Restore
                    </Button>
                  ) : (
                    <div className="inline-flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelId(r.id);
                          setOpenEdit(true);
                        }}
                      >
                        <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          delParty(r);
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                  <Contact className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No parties{tab !== "all" ? ` (${tab})` : ""}.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {creating && (
        <CreatePartyModal
          metals={metals}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await load();
            setSelId(id);
          }}
        />
      )}
      {selId && (
        <PartyDetailModal
          id={selId}
          metals={metals}
          startInEdit={openEdit}
          onClose={() => {
            setSelId(null);
            setOpenEdit(false);
          }}
          onChanged={load}
        />
      )}
    </div>
  );
}

function CreatePartyModal({ metals: _m, onClose, onCreated }: { metals: MetalOpt[]; onClose: () => void; onCreated: (id: number) => void }) {
  const [kind, setKind] = useState<"individual" | "business">("individual");
  const [f, setF] = useState({
    display_name: "",
    legal_name: "",
    phone: "",
    pan: "",
    gstin: "",
    state_code: "",
    address_line1: "",
    city: "",
    pincode: "",
    opening_cash: "",
    opening_metal: "",
  });
  const [cashSign, setCashSign] = useState<"dr" | "cr">("dr");
  const [metalSign, setMetalSign] = useState<"dr" | "cr">("dr");
  const [roles, setRoles] = useState<PartyRole[]>(["customer"]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set(k: keyof typeof f, v: string) {
    setF((p) => ({ ...p, [k]: v }));
  }
  function switchKind(k: "individual" | "business") {
    setKind(k);
    setRoles(k === "business" ? ["wholesale"] : ["customer"]);
  }
  function toggleRole(r: PartyRole) {
    setRoles((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  }

  async function save() {
    if (!f.display_name.trim()) return setErr("Name is required");
    if (kind === "business" && !f.gstin && !f.pan) return setErr("B2B party needs GSTIN or PAN");
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createParty({
        display_name: f.display_name,
        legal_name: kind === "business" ? f.legal_name || f.display_name : undefined,
        party_kind: kind,
        phone: f.phone || undefined,
        pan: f.pan || undefined,
        gstin: kind === "business" ? f.gstin || undefined : undefined,
        gst_registration_type: kind === "business" ? (f.gstin ? "regular" : "unregistered") : "consumer",
        state_code: kind === "business" ? f.state_code || undefined : undefined,
        address_line1: f.address_line1 || undefined,
        city: f.city || undefined,
        pincode: f.pincode || undefined,
        opening_cash_balance: f.opening_cash ? String((cashSign === "cr" ? -1 : 1) * Number(f.opening_cash)) : undefined,
        opening_metal_balance: f.opening_metal ? String((metalSign === "cr" ? -1 : 1) * Number(f.opening_metal)) : undefined,
        roles,
      });
      onCreated(r.id);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="font-semibold">New party</div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          {/* Retail / B2B toggle */}
          <div className="inline-flex rounded-md border border-border p-0.5">
            {(["individual", "business"] as const).map((k) => (
              <button
                key={k}
                onClick={() => switchKind(k)}
                className={cn("px-3 py-1 text-sm rounded", kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
              >
                {k === "individual" ? "Retail (individual)" : "B2B (business)"}
              </button>
            ))}
          </div>

          {err && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>{kind === "business" ? "Trade / display name" : "Name"}</Label>
              <Input value={f.display_name} onChange={(e) => set("display_name", e.target.value)} />
            </div>
            {kind === "business" && (
              <div className="col-span-2">
                <Label>Legal name (for GST)</Label>
                <Input value={f.legal_name} onChange={(e) => set("legal_name", e.target.value)} />
              </div>
            )}
            <div>
              <Label>Phone</Label>
              <Input value={f.phone} onChange={(e) => set("phone", e.target.value)} />
            </div>
            <div>
              <Label>PAN</Label>
              <Input value={f.pan} onChange={(e) => set("pan", e.target.value.toUpperCase())} placeholder={kind === "individual" ? "for bills ≥ ₹2L" : ""} />
            </div>
            {kind === "business" && (
              <>
                <div>
                  <Label>GSTIN</Label>
                  <Input value={f.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} />
                </div>
                <div>
                  <Label>State (place of supply)</Label>
                  <select className={sel} value={f.state_code} onChange={(e) => set("state_code", e.target.value)}>
                    <option value="">Select…</option>
                    {GST_STATE_CODES.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code} · {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <div className="col-span-2">
              <Label>Address</Label>
              <Input value={f.address_line1} onChange={(e) => set("address_line1", e.target.value)} />
            </div>
            <div>
              <Label>City</Label>
              <Input value={f.city} onChange={(e) => set("city", e.target.value)} />
            </div>
            <div>
              <Label>Pincode</Label>
              <Input value={f.pincode} onChange={(e) => set("pincode", e.target.value)} />
            </div>
          </div>

          <div>
            <Label>Roles</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {ALL_ROLES.map((r) => (
                <button
                  key={r}
                  onClick={() => toggleRole(r)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs capitalize",
                    roles.includes(r) ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Opening balance (as at go-live)</Label>
            <div className="grid grid-cols-2 gap-3 mt-1">
              <div className="flex gap-2">
                <Input value={f.opening_cash} onChange={(e) => set("opening_cash", e.target.value)} placeholder="Amount ₹" inputMode="decimal" />
                <select className={sel} value={cashSign} onChange={(e) => setCashSign(e.target.value as "dr" | "cr")}>
                  <option value="dr">Dr · owes us</option>
                  <option value="cr">Cr · we owe</option>
                </select>
              </div>
              <div className="flex gap-2">
                <Input value={f.opening_metal} onChange={(e) => set("opening_metal", e.target.value)} placeholder="Metal (fine g)" inputMode="decimal" />
                <select className={sel} value={metalSign} onChange={(e) => setMetalSign(e.target.value as "dr" | "cr")}>
                  <option value="dr">Dr · owes us</option>
                  <option value="cr">Cr · we owe</option>
                </select>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Feeds the party ledger and Sundry Debtors / Creditors after an accounts rebuild.</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Create party"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Bal({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </Card>
  );
}

function PartyDetailModal({ id, metals, onClose, onChanged, startInEdit }: { id: number; metals: MetalOpt[]; onClose: () => void; onChanged: () => void; startInEdit?: boolean }) {
  const [d, setD] = useState<PartyDetail | null>(null);
  const [ledger, setLedger] = useState<PartyLedgerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Entry forms
  const [cashAmt, setCashAmt] = useState("");
  const [cashType, setCashType] = useState<"debit" | "credit">("debit");
  const [metalWt, setMetalWt] = useState("");
  const [metalType, setMetalType] = useState<number | null>(null);
  const [metalDir, setMetalDir] = useState<"debit" | "credit">("debit");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<import("@/api").NewPartyReq>>({});

  function startEdit(p: PartyDetail) {
    setForm({
      display_name: p.display_name,
      legal_name: p.legal_name ?? undefined,
      party_kind: p.party_kind,
      phone: p.phone ?? undefined,
      email: p.email ?? undefined,
      pan: p.pan ?? undefined,
      gstin: p.gstin ?? undefined,
      address_line1: p.address_line1 ?? undefined,
      city: p.city ?? undefined,
      pincode: p.pincode ?? undefined,
      state_code: p.state_code ?? undefined,
      opening_cash_balance: p.terms?.opening_cash_balance ?? undefined,
      opening_metal_balance: p.terms?.opening_metal_balance ?? undefined,
    });
    setEditing(true);
    setErr(null);
  }
  async function saveEdit() {
    setBusy(true);
    setErr(null);
    try {
      await api.updateParty(id, form);
      setEditing(false);
      await load();
      onChanged();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    try {
      const detail = await api.getParty(id);
      setD(detail);
      if (startInEdit) startEdit(detail);
      if (metalType === null && metals.length) setMetalType(metals[0].metal_type_id);
      // Ledger is supplementary — never let it block the detail/edit view.
      try {
        setLedger(await api.partyLedger(id));
      } catch {
        setLedger([]);
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function postCash() {
    if (!cashAmt || Number(cashAmt) <= 0) return;
    setBusy(true);
    try {
      await api.partyCashEntry(id, { amount: cashAmt, entry_type: cashType });
      setCashAmt("");
      await load();
      onChanged();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  async function postMetal() {
    if (!metalWt || Number(metalWt) <= 0) return;
    setBusy(true);
    try {
      await api.partyMetalEntry(id, { weight: metalWt, metal_type_id: metalType ?? undefined, entry_type: metalDir });
      setMetalWt("");
      await load();
      onChanged();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const cash = d ? Number(d.balances.party_cash) : 0;
  const metal = d ? Number(d.balances.party_metal) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-4xl max-h-[92vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        {!d ? (
          <div className="p-8 text-center">
            {err ? (
              <div className="space-y-3">
                <div className="text-sm text-destructive">{err}</div>
                <button onClick={onClose} className="text-sm text-primary">Close</button>
              </div>
            ) : (
              <div className="text-muted-foreground">Loading…</div>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border px-4 py-3 sticky top-0 bg-card">
              <div>
                <div className="font-semibold">
                  {d.display_name} <span className="text-xs text-muted-foreground">{d.party_kind === "business" ? "B2B" : "Retail"}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {d.gstin ? `GSTIN ${d.gstin}` : d.pan ? `PAN ${d.pan}` : "no tax id"}
                  {d.state_code ? ` · state ${d.state_code}` : ""} · {d.roles.join(", ")}
                </div>
              </div>
              <button onClick={onClose} className="rounded-md p-1 hover:bg-accent">
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}

            <div className="p-4 space-y-4">
              {editing ? (
                <EditPartyForm
                  d={d}
                  form={form}
                  setForm={setForm}
                  busy={busy}
                  onSave={saveEdit}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <div className="flex justify-end -mt-1">
                  <Button size="sm" variant="outline" onClick={() => startEdit(d)}>
                    <Pencil className="w-3.5 h-3.5 mr-1" /> Edit details
                  </Button>
                </div>
              )}
              {/* Balances */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Bal
                  label="Cash (party ledger)"
                  value={cash === 0 ? "—" : formatINR(Math.abs(cash))}
                  hint={cash > 0 ? "owes us" : cash < 0 ? "we owe" : ""}
                />
                <Bal
                  label="Metal (party ledger)"
                  value={metal === 0 ? "—" : `${Math.abs(metal).toFixed(3)} g`}
                  hint={metal > 0 ? "owes us" : metal < 0 ? "we owe" : ""}
                />
                <Bal label="Advance credit" value={formatINR(d.balances.advance_credit)} hint="we hold" />
                <Bal label="Supplier payable" value={formatINR(d.balances.supplier_payable)} hint="we owe" />
                <Bal label="Smith metal held" value={`${Number(d.balances.smith_metal).toFixed(3)} g`} />
                <Bal label="Smith payable" value={formatINR(d.balances.smith_payable)} />
              </div>

              {/* Gram khata entry */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="p-3 space-y-2">
                  <div className="text-sm font-medium">Cash entry</div>
                  <div className="flex gap-2">
                    <select className={sel} value={cashType} onChange={(e) => setCashType(e.target.value as "debit" | "credit")}>
                      <option value="debit">Debit (owes us +)</option>
                      <option value="credit">Credit (we owe / paid −)</option>
                    </select>
                    <Input value={cashAmt} onChange={(e) => setCashAmt(e.target.value)} inputMode="decimal" placeholder="₹" />
                    <Button onClick={postCash} disabled={busy}>
                      Post
                    </Button>
                  </div>
                </Card>
                <Card className="p-3 space-y-2">
                  <div className="text-sm font-medium">Metal entry (gram khata)</div>
                  <div className="flex gap-2">
                    <select className={sel} value={metalDir} onChange={(e) => setMetalDir(e.target.value as "debit" | "credit")}>
                      <option value="debit">Debit (owes us +)</option>
                      <option value="credit">Credit (we owe −)</option>
                    </select>
                    <select className={sel} value={metalType ?? ""} onChange={(e) => setMetalType(Number(e.target.value))}>
                      {metals.map((m) => (
                        <option key={m.metal_type_id} value={m.metal_type_id}>
                          {m.metal}
                        </option>
                      ))}
                    </select>
                    <Input value={metalWt} onChange={(e) => setMetalWt(e.target.value)} inputMode="decimal" placeholder="g" />
                    <Button onClick={postMetal} disabled={busy}>
                      Post
                    </Button>
                  </div>
                </Card>
              </div>

              {/* Ledger statement */}
              <Card className="overflow-hidden">
                <div className="bg-muted/50 border-b border-border px-3 py-2 text-sm font-medium">Party ledger</div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/30 border-b border-border">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Event</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cash Δ</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Metal Δ (g)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((l) => (
                      <tr key={l.id} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 text-muted-foreground text-xs">{formatDate(l.at)}</td>
                        <td className="px-3 py-2 text-xs">{l.event_type.replace(/_/g, " ")}</td>
                        <td className={cn("px-3 py-2 text-right font-mono", Number(l.amount_delta) < 0 && "text-destructive")}>
                          {Number(l.amount_delta) !== 0 ? formatINR(l.amount_delta) : "—"}
                        </td>
                        <td className={cn("px-3 py-2 text-right font-mono", Number(l.weight_delta) < 0 && "text-destructive")}>
                          {Number(l.weight_delta) !== 0 ? Number(l.weight_delta).toFixed(3) : "—"}
                        </td>
                      </tr>
                    ))}
                    {ledger.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground text-sm">
                          No ledger entries yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}


function EditPartyForm({
  d,
  form,
  setForm,
  busy,
  onSave,
  onCancel,
}: {
  d: PartyDetail;
  form: Partial<NewPartyReq>;
  setForm: (f: Partial<NewPartyReq>) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const business = (form.party_kind ?? d.party_kind) === "business";
  const set = (k: keyof NewPartyReq, v: string) => setForm({ ...form, [k]: v });
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Edit details</div>
        <div className="inline-flex rounded-md border border-border p-0.5">
          {(["individual", "business"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setForm({ ...form, party_kind: k })}
              className={cn("px-2.5 py-1 text-xs rounded", business === (k === "business") ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
            >
              {k === "individual" ? "Retail" : "B2B"}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label>{business ? "Trade / display name" : "Name"}</Label>
          <Input value={form.display_name ?? ""} onChange={(e) => set("display_name", e.target.value)} />
        </div>
        {business && (
          <div className="col-span-2">
            <Label>Legal name</Label>
            <Input value={form.legal_name ?? ""} onChange={(e) => set("legal_name", e.target.value)} />
          </div>
        )}
        <div>
          <Label>Phone</Label>
          <Input value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
        </div>
        <div>
          <Label>Email</Label>
          <Input value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
        </div>
        <div>
          <Label>PAN</Label>
          <Input value={form.pan ?? ""} onChange={(e) => set("pan", e.target.value.toUpperCase())} />
        </div>
        {business && (
          <>
            <div>
              <Label>GSTIN</Label>
              <Input value={form.gstin ?? ""} onChange={(e) => set("gstin", e.target.value.toUpperCase())} />
            </div>
            <div>
              <Label>State (place of supply)</Label>
              <select className={sel} value={form.state_code ?? ""} onChange={(e) => set("state_code", e.target.value)}>
                <option value="">Select…</option>
                {GST_STATE_CODES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div className="col-span-2">
          <Label>Address</Label>
          <Input value={form.address_line1 ?? ""} onChange={(e) => set("address_line1", e.target.value)} />
        </div>
        <div>
          <Label>City</Label>
          <Input value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} />
        </div>
        <div>
          <Label>Pincode</Label>
          <Input value={form.pincode ?? ""} onChange={(e) => set("pincode", e.target.value)} />
        </div>
        <div>
          <Label>Opening ₹ (+ owes us / − we owe)</Label>
          <Input value={form.opening_cash_balance ?? ""} onChange={(e) => set("opening_cash_balance", e.target.value)} inputMode="decimal" className="font-mono" />
        </div>
        <div>
          <Label>Opening metal fine g (+/−)</Label>
          <Input value={form.opening_metal_balance ?? ""} onChange={(e) => set("opening_metal_balance", e.target.value)} inputMode="decimal" className="font-mono" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Card>
  );
}
