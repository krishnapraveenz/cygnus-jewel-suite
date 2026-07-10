import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, X, Lock, BadgeCheck, FileText } from "lucide-react";
import * as api from "@/api";
import type { PayrollRun, PayrollRunDetail, Payslip } from "@/api";
import { Button } from "@/components/ui/button";
import { MonthField } from "@/components/ui/month-field";
import { Badge } from "@/components/ui/badge";
import { formatINR, formatDate } from "@/lib/utils";
import { alertDialog } from "@/lib/dialog";
import { getCompany } from "@/lib/company";

const thisMonth = () => new Date().toISOString().slice(0, 7);

export function Payroll() {
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [period, setPeriod] = useState(thisMonth());
  const [sel, setSel] = useState<PayrollRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slip, setSlip] = useState<Payslip | null>(null);
  const [bulk, setBulk] = useState(false);
  const [cfg, setCfg] = useState<Record<string, string> | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const [advances, setAdvances] = useState<api.StaffAdvance[]>([]);
  const [staffList, setStaffList] = useState<api.Staff[]>([]);
  const [advForm, setAdvForm] = useState({ staff_id: 0, amount: "", recovery_per_month: "", note: "" });

  async function loadAdvances() {
    try {
      const [a, st] = await Promise.all([api.listStaffAdvances(), api.listStaff()]);
      setAdvances(a);
      setStaffList(st.filter((s) => s.status === "active"));
    } catch { /* ignore */ }
  }
  async function addAdvance() {
    if (!advForm.staff_id || !advForm.amount) return setError("Staff and amount are required for an advance");
    setError(null);
    try {
      await api.createAdvance({ staff_id: advForm.staff_id, amount: advForm.amount, recovery_per_month: advForm.recovery_per_month || undefined, note: advForm.note || undefined });
      setAdvForm({ staff_id: 0, amount: "", recovery_per_month: "", note: "" });
      await loadAdvances();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  async function loadCfg() {
    try { setCfg(await api.getSettings()); setShowCfg(true); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function saveCfg(key: string, value: string) {
    try { await api.setSetting(key, value); setCfg((c) => ({ ...(c ?? {}), [key]: value })); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  async function load() {
    try { setRuns(await api.listPayrollRuns()); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); loadAdvances(); }, []);

  async function open(id: number) {
    try { setSel(await api.getPayrollRun(id)); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function generate() {
    setBusy(true); setError(null);
    try { const r = await api.generatePayroll(period); await load(); await open(r.id); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
  }
  async function status(s: "finalized" | "paid") {
    if (!sel) return;
    try { await api.setPayrollStatus(sel.id, s); await open(sel.id); await load(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function editSlip(ps: Payslip, field: "allowances" | "deductions" | "pf" | "esi" | "pt" | "tds", val: string) {
    try {
      await api.updatePayslip(ps.id, { [field]: val });
      if (sel) await open(sel.id);
      await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  const locked = sel?.status !== "draft";

  function exportCsv() {
    if (!sel) return;
    const head = ["Code", "Staff", "Payable", "LOP", "Base", "Allowances", "PF", "ESI", "PT", "TDS", "Loan", "OtherDed", "Net"];
    const lines = sel.payslips.map((p) => [p.staff_code, p.staff_name, p.payable_days, p.lop_days, p.base_earned, p.allowances, p.pf, p.esi, p.pt, p.tds, p.loan_recovery, p.deductions, p.net_pay].join(","));
    const csv = [head.join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `payroll-${sel.period}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
  function downloadText(filename: string, content: string, mime: string) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
  async function downloadPfEcr() {
    if (!sel) return;
    try {
      const f = await api.payrollPfEcr(sel.id);
      if (!f.members) { await alertDialog({ title: "PF ECR", message: "No PF members with a UAN in this run. Add UAN numbers on the Staff screen." }); return; }
      downloadText(f.filename, f.content, "text/plain");
      if (f.skipped_no_uan) await alertDialog({ title: "PF ECR", message: `${f.members} members exported. ${f.skipped_no_uan} skipped (no UAN). Validate the file in the EPFO portal before filing.` });
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function downloadEsi() {
    if (!sel) return;
    try {
      const f = await api.payrollEsiReturn(sel.id);
      if (!f.members) { await alertDialog({ title: "ESI return", message: "No ESI-eligible members in this run (wages above the ESI ceiling, or no IP number set)." }); return; }
      downloadText(f.filename, f.content, "text/csv");
      if (f.skipped_no_ip) await alertDialog({ title: "ESI return", message: `${f.members} members exported. ${f.skipped_no_ip} skipped (no IP number). Validate in the ESIC portal before filing.` });
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Payroll</h2>
          <p className="text-sm text-muted-foreground">Generate monthly payroll from attendance. Prorated by payable days.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={loadCfg}>Statutory setup</Button>
          <MonthField value={period} onChange={setPeriod} />
          <Button size="sm" disabled={busy} onClick={generate}>{busy ? "Generating…" : "Generate / Recompute"}</Button>
        </div>
      </div>
      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}

      {showCfg && cfg && (
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">Statutory setup (applied on next Generate)</div>
            <button className="text-muted-foreground hover:text-foreground text-sm" onClick={() => setShowCfg(false)}>Close</button>
          </div>
          <div className="grid grid-cols-4 gap-3 text-sm">
            {[
              ["payroll.pf_percent", "PF %"],
              ["payroll.pf_wage_ceiling", "PF wage ceiling"],
              ["payroll.esi_percent", "ESI %"],
              ["payroll.esi_wage_ceiling", "ESI wage ceiling"],
              ["payroll.pt_amount", "Professional Tax / mo"],
              ["payroll.ot_rate_multiplier", "OT rate ×"],
              ["attendance.full_hours", "Standard hrs/day"],
              ["payroll.employer_pf_percent", "Employer PF %"],
              ["payroll.employer_esi_percent", "Employer ESI %"],
            ].map(([k, label]) => (
              <div key={k}>
                <label className="text-xs text-muted-foreground">{label}</label>
                <input className="h-8 w-full rounded-md border border-input bg-background px-2 mt-1" defaultValue={cfg[k] ?? ""} onBlur={(e) => e.target.value !== (cfg[k] ?? "") && saveCfg(k, e.target.value)} />
              </div>
            ))}
            <label className="flex items-center gap-2 text-sm mt-5"><input type="checkbox" checked={(cfg["payroll.pf_enabled"] ?? "true") === "true"} onChange={(e) => saveCfg("payroll.pf_enabled", String(e.target.checked))} /> PF enabled</label>
            <label className="flex items-center gap-2 text-sm mt-5"><input type="checkbox" checked={(cfg["payroll.esi_enabled"] ?? "true") === "true"} onChange={(e) => saveCfg("payroll.esi_enabled", String(e.target.checked))} /> ESI enabled</label>
            <label className="flex items-center gap-2 text-sm mt-5"><input type="checkbox" checked={(cfg["payroll.ot_enabled"] ?? "false") === "true"} onChange={(e) => saveCfg("payroll.ot_enabled", String(e.target.checked))} /> Overtime pay</label>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[260px_1fr] gap-4">
        <div className="rounded-lg border border-border overflow-hidden h-fit">
          <div className="border-b border-border px-3 py-2 text-sm font-medium">Runs</div>
          {runs.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">No payroll runs yet.</div>}
          {runs.map((r) => (
            <button key={r.id} onClick={() => open(r.id)} className={`w-full text-left px-3 py-2 border-b border-border last:border-0 hover:bg-accent ${sel?.id === r.id ? "bg-accent" : ""}`}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{r.period}</span>
                <Badge variant={r.status === "paid" ? "success" : r.status === "finalized" ? "default" : "secondary"}>{r.status}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">Net {formatINR(r.net_total)}</div>
            </button>
          ))}
        </div>

        <div>
          {!sel ? (
            <div className="rounded-lg border border-border px-3 py-16 text-center text-sm text-muted-foreground">Select or generate a run.</div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm"><span className="font-medium">{sel.period}</span> · {sel.days_in_month} days · gross {formatINR(sel.gross_total)} · <span className="font-semibold">net {formatINR(sel.net_total)}</span></div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
                  <Button size="sm" variant="outline" onClick={downloadPfEcr}><FileText className="w-3.5 h-3.5 mr-1" /> PF ECR</Button>
                  <Button size="sm" variant="outline" onClick={downloadEsi}><FileText className="w-3.5 h-3.5 mr-1" /> ESI</Button>
                  <Button size="sm" variant="outline" onClick={() => setBulk(true)}><Printer className="w-3.5 h-3.5 mr-1" /> Print all</Button>
                  {sel.status === "draft" && <Button size="sm" variant="outline" onClick={() => status("finalized")}><Lock className="w-3.5 h-3.5 mr-1" /> Finalize</Button>}
                  {sel.status === "finalized" && <Button size="sm" onClick={() => status("paid")}><BadgeCheck className="w-3.5 h-3.5 mr-1" /> Mark paid</Button>}
                </div>
              </div>
              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
                    <th className="text-left px-3 py-2 font-medium">Staff</th>
                    <th className="text-right px-3 py-2 font-medium">Payable</th>
                    <th className="text-right px-3 py-2 font-medium">LOP</th>
                    <th className="text-right px-3 py-2 font-medium">Base</th>
                    <th className="text-right px-3 py-2 font-medium">OT</th>
                    <th className="text-right px-3 py-2 font-medium">Allow</th>
                    <th className="text-right px-3 py-2 font-medium">PF</th>
                    <th className="text-right px-3 py-2 font-medium">ESI</th>
                    <th className="text-right px-3 py-2 font-medium">PT</th>
                    <th className="text-right px-3 py-2 font-medium">TDS</th>
                    <th className="text-right px-3 py-2 font-medium">Loan</th>
                    <th className="text-right px-3 py-2 font-medium">Other</th>
                    <th className="text-right px-3 py-2 font-medium">Net</th>
                    <th className="px-3 py-2"></th>
                  </tr></thead>
                  <tbody>
                    {sel.payslips.map((ps) => (
                      <tr key={ps.id} className="border-b border-border last:border-0">
                        <td className="px-3 py-2">{ps.staff_name}<span className="text-xs text-muted-foreground"> · {ps.staff_code}</span></td>
                        <td className="px-3 py-2 text-right font-mono">{ps.payable_days}</td>
                        <td className="px-3 py-2 text-right font-mono">{ps.lop_days}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatINR(ps.base_earned)}</td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground" title={`${ps.ot_hours ?? "0"} h`}>{Number(ps.ot_pay ?? 0) > 0 ? formatINR(ps.ot_pay ?? "0") : "—"}</td>
                        <td className="px-2 py-2 text-right">
                          <input disabled={locked} className="h-7 w-16 text-right rounded border border-input bg-background px-1 disabled:opacity-60 disabled:border-transparent" defaultValue={ps.allowances} onBlur={(e) => e.target.value !== ps.allowances && editSlip(ps, "allowances", e.target.value)} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input disabled={locked} className="h-7 w-14 text-right rounded border border-input bg-background px-1 disabled:opacity-60 disabled:border-transparent" defaultValue={ps.pf} onBlur={(e) => e.target.value !== ps.pf && editSlip(ps, "pf", e.target.value)} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input disabled={locked} className="h-7 w-14 text-right rounded border border-input bg-background px-1 disabled:opacity-60 disabled:border-transparent" defaultValue={ps.esi} onBlur={(e) => e.target.value !== ps.esi && editSlip(ps, "esi", e.target.value)} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input disabled={locked} className="h-7 w-14 text-right rounded border border-input bg-background px-1 disabled:opacity-60 disabled:border-transparent" defaultValue={ps.pt} onBlur={(e) => e.target.value !== ps.pt && editSlip(ps, "pt", e.target.value)} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input disabled={locked} className="h-7 w-14 text-right rounded border border-input bg-background px-1 disabled:opacity-60 disabled:border-transparent" defaultValue={ps.tds} onBlur={(e) => e.target.value !== ps.tds && editSlip(ps, "tds", e.target.value)} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">{formatINR(ps.loan_recovery)}</td>
                        <td className="px-2 py-2 text-right">
                          <input disabled={locked} className="h-7 w-16 text-right rounded border border-input bg-background px-1 disabled:opacity-60 disabled:border-transparent" defaultValue={ps.deductions} onBlur={(e) => e.target.value !== ps.deductions && editSlip(ps, "deductions", e.target.value)} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">{formatINR(ps.net_pay)}</td>
                        <td className="px-3 py-2 text-right"><button className="text-muted-foreground hover:text-foreground" title="Payslip" onClick={() => setSlip(ps)}><Printer className="w-4 h-4" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="text-sm font-medium mb-2">Salary advances / loans</div>
        <div className="flex items-end gap-2 mb-3 flex-wrap">
          <div><label className="text-xs text-muted-foreground">Staff</label>
            <select className="h-9 rounded-md border border-input bg-background px-2 text-sm block" value={advForm.staff_id} onChange={(e) => setAdvForm({ ...advForm, staff_id: Number(e.target.value) })}>
              <option value={0}>—</option>
              {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div><label className="text-xs text-muted-foreground">Amount</label><input className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm block" inputMode="decimal" value={advForm.amount} onChange={(e) => setAdvForm({ ...advForm, amount: e.target.value })} /></div>
          <div><label className="text-xs text-muted-foreground">Recover / month</label><input className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm block" inputMode="decimal" value={advForm.recovery_per_month} onChange={(e) => setAdvForm({ ...advForm, recovery_per_month: e.target.value })} /></div>
          <input className="h-9 flex-1 min-w-[140px] rounded-md border border-input bg-background px-2 text-sm" placeholder="Note (optional)" value={advForm.note} onChange={(e) => setAdvForm({ ...advForm, note: e.target.value })} />
          <Button size="sm" onClick={addAdvance}>Add advance</Button>
        </div>
        {advances.length > 0 && (
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/40 border-b border-border text-muted-foreground text-xs">
              <th className="text-left px-3 py-1.5 font-medium">Staff</th>
              <th className="text-right px-3 py-1.5 font-medium">Amount</th>
              <th className="text-right px-3 py-1.5 font-medium">Recover/mo</th>
              <th className="text-right px-3 py-1.5 font-medium">Outstanding</th>
              <th className="text-center px-3 py-1.5 font-medium">Status</th>
            </tr></thead>
            <tbody>
              {advances.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">{a.staff_name}{a.note ? <span className="text-xs text-muted-foreground"> · {a.note}</span> : null}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatINR(a.amount)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatINR(a.recovery_per_month)}</td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold">{formatINR(a.outstanding)}</td>
                  <td className="px-3 py-1.5 text-center"><Badge variant={a.status === "active" ? "warning" : "success"}>{a.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {slip && sel && <PayslipPrint slip={slip} period={sel.period} onClose={() => setSlip(null)} />}
      {bulk && sel && <BulkPayslips run={sel} onClose={() => setBulk(false)} />}
    </div>
  );
}

function PayslipPrint({ slip, period, onClose }: { slip: Payslip; period: string; onClose: () => void }) {
  const co = getCompany();
  return createPortal(
    <div className="print-root fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-8" onClick={onClose}>
      <div className="bg-card rounded-lg shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 no-print">
          <div className="text-sm font-medium">Payslip · {slip.staff_name}</div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="print-area bg-white text-black p-6 text-sm">
          <div className="flex items-start justify-between border-b-2 border-black pb-2">
            <div>
              <div className="text-lg font-bold">{co.name || co.legalName || "Your Jewellery Store"}</div>
              <div className="text-xs text-gray-600">Payslip</div>
            </div>
            <div className="text-right text-xs">
              <div className="font-semibold">{period}</div>
            </div>
          </div>
          <div className="flex justify-between py-2 text-xs">
            <div><span className="text-gray-500">Employee</span><div className="font-medium text-sm">{slip.staff_name} ({slip.staff_code})</div></div>
            <div className="text-right"><span className="text-gray-500">Paid / Payable days</span><div>{slip.payable_days} · LOP {slip.lop_days}</div></div>
          </div>
          <table className="w-full text-xs border-collapse mt-2">
            <tbody>
              <tr className="border-b border-gray-200"><td className="py-1">Basic earned (prorated)</td><td className="py-1 text-right font-mono">{formatINR(slip.base_earned)}</td></tr>
              <tr className="border-b border-gray-200"><td className="py-1">Allowances</td><td className="py-1 text-right font-mono">{formatINR(slip.allowances)}</td></tr>
              {Number(slip.ot_pay ?? 0) > 0 && <tr className="border-b border-gray-200"><td className="py-1">Overtime ({slip.ot_hours} h)</td><td className="py-1 text-right font-mono">{formatINR(slip.ot_pay ?? "0")}</td></tr>}
              {Number(slip.pf) > 0 && <tr className="border-b border-gray-200"><td className="py-1">PF</td><td className="py-1 text-right font-mono">- {formatINR(slip.pf)}</td></tr>}
              {Number(slip.esi) > 0 && <tr className="border-b border-gray-200"><td className="py-1">ESI</td><td className="py-1 text-right font-mono">- {formatINR(slip.esi)}</td></tr>}
              {Number(slip.pt) > 0 && <tr className="border-b border-gray-200"><td className="py-1">Professional Tax</td><td className="py-1 text-right font-mono">- {formatINR(slip.pt)}</td></tr>}
              {Number(slip.tds) > 0 && <tr className="border-b border-gray-200"><td className="py-1">TDS</td><td className="py-1 text-right font-mono">- {formatINR(slip.tds)}</td></tr>}
              {Number(slip.loan_recovery) > 0 && <tr className="border-b border-gray-200"><td className="py-1">Loan / advance recovery</td><td className="py-1 text-right font-mono">- {formatINR(slip.loan_recovery)}</td></tr>}
              {Number(slip.deductions) > 0 && <tr className="border-b border-gray-200"><td className="py-1">Other deductions</td><td className="py-1 text-right font-mono">- {formatINR(slip.deductions)}</td></tr>}
              <tr className="border-t-2 border-black font-semibold"><td className="py-1.5">Net pay</td><td className="py-1.5 text-right font-mono">{formatINR(slip.net_pay)}</td></tr>
            </tbody>
          </table>
          {slip.note && <div className="text-xs text-gray-500 mt-2">Note: {slip.note}</div>}
          {(Number(slip.employer_pf ?? 0) > 0 || Number(slip.employer_esi ?? 0) > 0) && (
            <div className="text-[10px] text-gray-500 mt-2">Employer contributions (not deducted): PF {formatINR(slip.employer_pf ?? "0")} · ESI {formatINR(slip.employer_esi ?? "0")}</div>
          )}
          <div className="mt-10 flex justify-between text-[11px] text-gray-500">
            <div>Generated {formatDate(new Date().toISOString())}</div>
            <div className="text-right border-t border-gray-400 pt-1">Authorised signatory</div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function BulkPayslips({ run, onClose }: { run: PayrollRunDetail; onClose: () => void }) {
  const co = getCompany();
  return createPortal(
    <div className="print-root fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-8" onClick={onClose}>
      <div className="bg-card rounded-lg shadow-xl w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 no-print">
          <div className="text-sm font-medium">Payslips · {run.period} · {run.payslips.length} staff</div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="print-area bg-white text-black p-4">
          {run.payslips.map((p) => (
            <div key={p.id} className="border-b border-gray-300 pb-3 mb-3" style={{ pageBreakInside: "avoid" }}>
              <div className="flex items-center justify-between">
                <div className="font-semibold">{co.name || "Payslip"} — {p.staff_name} ({p.staff_code})</div>
                <div className="text-xs">{run.period}</div>
              </div>
              <div className="grid grid-cols-4 gap-2 text-[11px] mt-1">
                <span>Payable {p.payable_days} · LOP {p.lop_days}</span>
                <span>Base {formatINR(p.base_earned)}</span>
                <span>Allow {formatINR(p.allowances)}</span>
                <span>PF {formatINR(p.pf)} · ESI {formatINR(p.esi)}</span>
                <span>PT {formatINR(p.pt)} · TDS {formatINR(p.tds)}</span>
                <span>Loan {formatINR(p.loan_recovery)}</span>
                <span>Other {formatINR(p.deductions)}</span>
                <span className="font-semibold">Net {formatINR(p.net_pay)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
