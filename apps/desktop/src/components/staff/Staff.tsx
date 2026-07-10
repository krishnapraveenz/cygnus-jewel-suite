import { useEffect, useState } from "react";
import { Plus, X, Pencil } from "lucide-react";
import * as api from "@/api";
import type { Staff as StaffT, StaffReq } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatINR } from "@/lib/utils";

const empty: StaffReq = { code: "", name: "", salary_type: "monthly", base_salary: "", allowances: "", weekly_off: 0, status: "active" };

export function Staff() {
  const [list, setList] = useState<StaffT[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: number; body: StaffReq } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setList(await api.listStaff()); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); }, []);

  async function openEdit(id: number) {
    const s = await api.getStaff(id);
    setEditing({ id, body: { ...s, base_salary: s.base_salary, allowances: s.allowances, join_date: s.join_date ?? undefined, phone: s.phone ?? undefined, designation: s.designation ?? undefined, department: s.department ?? undefined, biometric_user_id: s.biometric_user_id ?? undefined, pan: s.pan ?? undefined, aadhaar: s.aadhaar ?? undefined, bank_account: s.bank_account ?? undefined, bank_ifsc: s.bank_ifsc ?? undefined, uan: s.uan ?? undefined, esi_ip: s.esi_ip ?? undefined } });
  }

  async function save() {
    if (!editing) return;
    if (!editing.body.code.trim() || !editing.body.name.trim()) return setError("Code and name are required");
    setBusy(true); setError(null);
    try {
      if (editing.id) await api.updateStaff(editing.id, editing.body);
      else await api.createStaff(editing.body);
      setEditing(null);
      await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
  }

  const active = list.filter((s) => s.status === "active");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Staff</h2>
          <p className="text-sm text-muted-foreground">{active.length} active · {list.length} total</p>
        </div>
        <Button size="sm" onClick={() => setEditing({ body: { ...empty } })}><Plus className="w-4 h-4 mr-1" /> Add staff</Button>
      </div>

      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium">Code</th>
              <th className="text-left px-3 py-2 font-medium">Name</th>
              <th className="text-left px-3 py-2 font-medium">Designation</th>
              <th className="text-left px-3 py-2 font-medium">Bio ID</th>
              <th className="text-left px-3 py-2 font-medium">Salary</th>
              <th className="text-center px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No staff yet. Add your first employee.</td></tr>}
            {list.map((s) => (
              <tr key={s.id} className="border-b border-border last:border-0 hover:bg-accent cursor-pointer" onClick={() => openEdit(s.id)}>
                <td className="px-3 py-2 font-mono text-xs">{s.code}</td>
                <td className="px-3 py-2 font-medium">{s.name}{s.phone ? <span className="text-muted-foreground font-normal"> · {s.phone}</span> : null}</td>
                <td className="px-3 py-2">{s.designation || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-2 font-mono text-xs">{s.biometric_user_id || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-2">{formatINR(s.base_salary)} <span className="text-xs text-muted-foreground">/{s.salary_type === "monthly" ? "mo" : s.salary_type === "daily" ? "day" : "hr"}</span></td>
                <td className="px-3 py-2 text-center"><Badge variant={s.status === "active" ? "success" : "secondary"}>{s.status}</Badge></td>
                <td className="px-3 py-2 text-right"><Pencil className="w-3.5 h-3.5 text-muted-foreground inline" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="font-semibold">{editing.id ? "Edit staff" : "Add staff"}</div>
              <button onClick={() => setEditing(null)} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3">
              <Field label="Code *"><Input value={editing.body.code} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, code: e.target.value } })} /></Field>
              <Field label="Name *"><Input value={editing.body.name} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, name: e.target.value } })} /></Field>
              <Field label="Phone"><Input value={editing.body.phone ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, phone: e.target.value } })} /></Field>
              <Field label="Designation"><Input value={editing.body.designation ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, designation: e.target.value } })} /></Field>
              <Field label="Department"><Input value={editing.body.department ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, department: e.target.value } })} /></Field>
              <Field label="Join date"><DateField value={editing.body.join_date ?? ""} onChange={(v) => setEditing({ ...editing, body: { ...editing.body, join_date: v } })} className="w-full" /></Field>
              <Field label="Salary type">
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={editing.body.salary_type} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, salary_type: e.target.value } })}>
                  <option value="monthly">Monthly</option>
                  <option value="daily">Daily</option>
                  <option value="hourly">Hourly</option>
                </select>
              </Field>
              <Field label={`Base salary (per ${editing.body.salary_type === "monthly" ? "month" : editing.body.salary_type === "daily" ? "day" : "hour"})`}><Input value={editing.body.base_salary ?? ""} inputMode="decimal" onChange={(e) => setEditing({ ...editing, body: { ...editing.body, base_salary: e.target.value } })} /></Field>
              <Field label="Fixed allowances (monthly)"><Input value={editing.body.allowances ?? ""} inputMode="decimal" onChange={(e) => setEditing({ ...editing, body: { ...editing.body, allowances: e.target.value } })} /></Field>
              <Field label="Biometric user ID"><Input value={editing.body.biometric_user_id ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, biometric_user_id: e.target.value } })} /></Field>
              <Field label="Weekly off">
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={editing.body.weekly_off ?? 0} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, weekly_off: Number(e.target.value) } })}>
                  {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </Field>
              <Field label="PAN"><Input value={editing.body.pan ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, pan: e.target.value.toUpperCase() } })} /></Field>
              <Field label="Bank account"><Input value={editing.body.bank_account ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, bank_account: e.target.value } })} /></Field>
              <Field label="IFSC"><Input value={editing.body.bank_ifsc ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, bank_ifsc: e.target.value.toUpperCase() } })} /></Field>
              <Field label="UAN (PF)"><Input value={editing.body.uan ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, uan: e.target.value } })} placeholder="12-digit UAN" /></Field>
              <Field label="ESIC IP number"><Input value={editing.body.esi_ip ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, esi_ip: e.target.value } })} placeholder="10-digit IP" /></Field>
              {editing.id && (
                <Field label="Status">
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={editing.body.status} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, status: e.target.value } })}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </Field>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
              <Button size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
