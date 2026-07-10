import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import * as api from "@/api";
import type { Staff, LeaveType, LeaveRequestRow, LeaveBalance } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

export function Leave() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [reqs, setReqs] = useState<LeaveRequestRow[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState({ staff_id: 0, leave_type_id: 0, from_day: "", to_day: "", reason: "", half_day: false });
  const [balStaff, setBalStaff] = useState(0);

  async function load() {
    try {
      const [st, lt, rq] = await Promise.all([api.listStaff(), api.listLeaveTypes(), api.listLeaveRequests(filter || undefined)]);
      setStaff(st.filter((s) => s.status === "active"));
      setTypes(lt);
      setReqs(rq);
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  useEffect(() => {
    if (balStaff) api.leaveBalances(balStaff, String(new Date().getFullYear())).then(setBalances).catch(() => {});
    else setBalances([]);
  }, [balStaff]);

  async function apply() {
    if (!form.staff_id || !form.leave_type_id || !form.from_day || !form.to_day) return setError("Staff, type and dates are required");
    if (form.to_day < form.from_day) return setError("'To' date cannot be before 'From' date");
    if (form.half_day && form.from_day !== form.to_day) return setError("Half-day leave must be a single day");
    setError(null);
    try {
      await api.applyLeave(form);
      setForm({ staff_id: 0, leave_type_id: 0, from_day: "", to_day: "", reason: "", half_day: false });
      await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  async function cancel(id: number) {
    try { await api.cancelLeave(id); await load(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  async function decide(id: number, status: "approved" | "rejected") {
    try { await api.decideLeave(id, status); await load(); if (balStaff) api.leaveBalances(balStaff, String(new Date().getFullYear())).then(setBalances); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Leave</h2>
        <p className="text-sm text-muted-foreground">Apply, approve and track leave. Approved leave posts to attendance automatically.</p>
      </div>
      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}

      <div className="grid grid-cols-[1fr_300px] gap-4">
        <div className="space-y-4">
          {/* Apply */}
          <Card className="p-3">
            <div className="text-sm font-medium mb-2">Apply for leave</div>
            <div className="grid grid-cols-5 gap-2 items-end">
              <div><label className="text-xs text-muted-foreground">Staff</label>
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={form.staff_id} onChange={(e) => setForm({ ...form, staff_id: Number(e.target.value) })}>
                  <option value={0}>—</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div><label className="text-xs text-muted-foreground">Type</label>
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={form.leave_type_id} onChange={(e) => setForm({ ...form, leave_type_id: Number(e.target.value) })}>
                  <option value={0}>—</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}
                </select>
              </div>
              <div><label className="text-xs text-muted-foreground">From</label><DateField value={form.from_day} onChange={(v) => setForm({ ...form, from_day: v })} className="w-full" /></div>
              <div><label className="text-xs text-muted-foreground">To</label><DateField value={form.to_day} onChange={(v) => setForm({ ...form, to_day: v })} className="w-full" /></div>
              <Button size="sm" onClick={apply}>Apply</Button>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <Input className="flex-1" placeholder="Reason (optional)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              <label className="flex items-center gap-1.5 text-sm whitespace-nowrap"><input type="checkbox" checked={form.half_day} onChange={(e) => setForm({ ...form, half_day: e.target.checked, to_day: e.target.checked ? form.from_day : form.to_day })} /> Half day</label>
            </div>
          </Card>

          {/* Requests */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Requests</span>
            <select className="h-8 rounded-md border border-input bg-background px-2 text-sm ml-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
                <th className="text-left px-3 py-2 font-medium">Staff</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-left px-3 py-2 font-medium">From</th>
                <th className="text-left px-3 py-2 font-medium">To</th>
                <th className="text-right px-3 py-2 font-medium">Days</th>
                <th className="text-center px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2"></th>
              </tr></thead>
              <tbody>
                {reqs.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No leave requests.</td></tr>}
                {reqs.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">{r.staff_name}</td>
                    <td className="px-3 py-2">{r.leave_type}{!r.paid && <span className="text-xs text-muted-foreground"> (unpaid)</span>}</td>
                    <td className="px-3 py-2">{formatDate(r.from_day)}</td>
                    <td className="px-3 py-2">{formatDate(r.to_day)}</td>
                    <td className="px-3 py-2 text-right">{r.days}</td>
                    <td className="px-3 py-2 text-center"><Badge variant={r.status === "approved" ? "success" : r.status === "rejected" ? "secondary" : "warning"}>{r.status}</Badge></td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {r.status === "pending" && (
                        <>
                          <button className="text-emerald-600 hover:bg-accent rounded p-1" title="Approve" onClick={() => decide(r.id, "approved")}><Check className="w-4 h-4" /></button>
                          <button className="text-red-600 hover:bg-accent rounded p-1" title="Reject" onClick={() => decide(r.id, "rejected")}><X className="w-4 h-4" /></button>
                        </>
                      )}
                      {(r.status === "pending" || r.status === "approved") && (
                        <button className="text-muted-foreground hover:bg-accent rounded p-1 text-xs" title="Cancel" onClick={() => cancel(r.id)}>Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Balances */}
        <Card className="p-3 h-fit">
          <div className="text-sm font-medium mb-2">Balances ({new Date().getFullYear()})</div>
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm mb-3" value={balStaff} onChange={(e) => setBalStaff(Number(e.target.value))}>
            <option value={0}>Select staff…</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {balances.map((b) => (
            <div key={b.leave_type_id} className="flex items-center justify-between py-1.5 border-b border-border/60 text-sm">
              <span>{b.code} <span className="text-xs text-muted-foreground">{b.name}</span></span>
              <span className="font-mono">{b.balance}<span className="text-muted-foreground">/{b.quota}</span></span>
            </div>
          ))}
          {balStaff > 0 && balances.length === 0 && <div className="text-xs text-muted-foreground">No leave types.</div>}
        </Card>
      </div>
    </div>
  );
}
