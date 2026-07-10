import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Upload, CheckCircle2, Link2, Unlink, PlusCircle } from "lucide-react";
import * as XLSX from "xlsx";
import * as api from "@/api";
import type { BankAccount, StmtImportDetail } from "@/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatINR, formatDate } from "@/lib/utils";

type Step = "upload" | "map" | "review";
const num = (s: unknown) => { const n = Number(String(s ?? "").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };

function toISO(s: unknown, fmt: string): string | undefined {
  const raw = String(s ?? "").trim();
  if (!raw) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const p = raw.split(/[/\-.\s]+/).filter(Boolean);
  if (p.length < 3) return undefined;
  let d: string, mo: string, y: string;
  if (fmt === "MM/DD/YYYY") { mo = p[0]; d = p[1]; y = p[2]; }
  else if (fmt === "YYYY/MM/DD") { y = p[0]; mo = p[1]; d = p[2]; }
  else { d = p[0]; mo = p[1]; y = p[2]; }
  if (y.length === 2) y = "20" + y;
  if (!/^\d+$/.test(d) || !/^\d+$/.test(mo) || !/^\d{4}$/.test(y)) return undefined;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const guess = (headers: string[], keys: string[]) =>
  headers.findIndex((h) => keys.some((k) => h.toLowerCase().includes(k)));

export function StatementImport({ account, onClose, onImported }: { account: BankAccount; onClose: () => void; onImported: () => void }) {
  const [step, setStep] = useState<Step>("upload");
  const [rows, setRows] = useState<string[][]>([]);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [headerRow, setHeaderRow] = useState(true);
  const [dateFmt, setDateFmt] = useState("DD/MM/YYYY");
  const [amountMode, setAmountMode] = useState<"drcr" | "single">("drcr");
  const [col, setCol] = useState({ date: -1, desc: -1, ref: -1, debit: -1, credit: -1, amount: -1, balance: -1 });
  const [detail, setDetail] = useState<StmtImportDetail | null>(null);

  const headers = useMemo(() => {
    if (!rows.length) return [];
    return headerRow ? rows[0].map((h, i) => `${i + 1}. ${h || "(blank)"}`) : rows[0].map((_, i) => `Column ${i + 1}`);
  }, [rows, headerRow]);

  function onFile(f: File) {
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "" });
        const nonEmpty = data.filter((r) => r.some((c) => String(c).trim() !== ""));
        if (!nonEmpty.length) { setError("No rows found in the file."); return; }
        setRows(nonEmpty);
        setFilename(f.name);
        // auto-guess columns from header
        const hs = nonEmpty[0].map((h) => String(h));
        setCol({
          date: guess(hs, ["date", "txn date", "value date"]),
          desc: guess(hs, ["desc", "narration", "particular", "detail", "remarks"]),
          ref: guess(hs, ["ref", "chq", "cheque", "utr"]),
          debit: guess(hs, ["debit", "withdrawal", "dr"]),
          credit: guess(hs, ["credit", "deposit", "cr"]),
          amount: guess(hs, ["amount"]),
          balance: guess(hs, ["balance"]),
        });
        setStep("map");
      } catch (err) { setError("Could not read file: " + String(err)); }
    };
    reader.readAsArrayBuffer(f);
  }

  const dataRows = headerRow ? rows.slice(1) : rows;
  const parsed = useMemo(() => dataRows.map((r) => {
    const date = col.date >= 0 ? toISO(r[col.date], dateFmt) : undefined;
    let debit = "0", credit = "0";
    if (amountMode === "drcr") {
      debit = col.debit >= 0 ? String(num(r[col.debit])) : "0";
      credit = col.credit >= 0 ? String(num(r[col.credit])) : "0";
    } else {
      const a = col.amount >= 0 ? num(r[col.amount]) : 0;
      if (a >= 0) credit = String(a); else debit = String(-a);
    }
    return {
      date, description: col.desc >= 0 ? String(r[col.desc] ?? "") : undefined,
      ref_no: col.ref >= 0 ? String(r[col.ref] ?? "") : undefined,
      debit, credit, balance: col.balance >= 0 ? String(num(r[col.balance])) : undefined,
    };
  }).filter((l) => l.date && (num(l.debit) !== 0 || num(l.credit) !== 0)), [dataRows, col, dateFmt, amountMode]);

  async function doImport() {
    setBusy(true); setError(null);
    try {
      const r = await api.createStatementImport({ bank_account_id: account.id, filename, format: "csv/xlsx", lines: parsed });
      setDetail(await api.getStatementImport(r.import_id));
      setStep("review");
      onImported();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function refresh() { if (detail) setDetail(await api.getStatementImport(detail.import.id)); onImported(); }

  const Sel = ({ k, optional }: { k: keyof typeof col; optional?: boolean }) => (
    <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={col[k]}
      onChange={(e) => setCol({ ...col, [k]: Number(e.target.value) })}>
      {optional && <option value={-1}>— none —</option>}
      {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
    </select>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-8" onClick={onClose}>
      <div className="bg-card rounded-lg shadow-xl w-full max-w-4xl mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Import statement — {account.name}</h3>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4">
          {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}

          {step === "upload" && (
            <div className="text-center py-10">
              <label className="inline-flex flex-col items-center gap-2 cursor-pointer">
                <div className="rounded-full bg-primary/10 p-4"><Upload className="w-6 h-6 text-primary" /></div>
                <span className="text-sm font-medium">Choose a bank statement file</span>
                <span className="text-xs text-muted-foreground">CSV, XLS or XLSX — downloaded from your bank</span>
                <input type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
                <span className="mt-2 inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm">Browse…</span>
              </label>
            </div>
          )}

          {step === "map" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} /> First row is a header</label>
                <div className="flex items-center gap-2"><Label className="text-xs">Date format</Label>
                  <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={dateFmt} onChange={(e) => setDateFmt(e.target.value)}>
                    <option>DD/MM/YYYY</option><option>MM/DD/YYYY</option><option>YYYY/MM/DD</option>
                  </select>
                </div>
                <div className="flex items-center gap-2"><Label className="text-xs">Amounts</Label>
                  <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={amountMode} onChange={(e) => setAmountMode(e.target.value as "drcr" | "single")}>
                    <option value="drcr">Debit &amp; Credit columns</option><option value="single">Single amount column</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><Label className="text-xs">Date</Label><Sel k="date" /></div>
                <div><Label className="text-xs">Description</Label><Sel k="desc" optional /></div>
                <div><Label className="text-xs">Reference</Label><Sel k="ref" optional /></div>
                {amountMode === "drcr" ? (<>
                  <div><Label className="text-xs">Debit (out)</Label><Sel k="debit" optional /></div>
                  <div><Label className="text-xs">Credit (in)</Label><Sel k="credit" optional /></div>
                </>) : (
                  <div><Label className="text-xs">Amount (+in / −out)</Label><Sel k="amount" /></div>
                )}
                <div><Label className="text-xs">Balance</Label><Sel k="balance" optional /></div>
              </div>
              <div className="rounded-lg border border-border overflow-x-auto">
                <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">{parsed.length} transactions detected · preview</div>
                <table className="w-full text-sm">
                  <thead><tr className="bg-muted/50 text-muted-foreground"><th className="text-left px-3 py-1.5">Date</th><th className="text-left px-3 py-1.5">Description</th><th className="text-right px-3 py-1.5">Debit</th><th className="text-right px-3 py-1.5">Credit</th></tr></thead>
                  <tbody>
                    {parsed.slice(0, 8).map((l, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1.5">{l.date ?? <span className="text-destructive">?</span>}</td>
                        <td className="px-3 py-1.5 truncate max-w-[240px]">{l.description}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{num(l.debit) ? formatINR(l.debit!) : ""}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{num(l.credit) ? formatINR(l.credit!) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setStep("upload")}>Back</Button>
                <Button size="sm" onClick={doImport} disabled={busy || parsed.length === 0 || col.date < 0}>{busy ? "Importing…" : `Import & match ${parsed.length}`}</Button>
              </div>
            </div>
          )}

          {step === "review" && detail && (
            <div className="space-y-3">
              <div className="flex items-center gap-4 text-sm">
                <span className="rounded-full bg-emerald-500/10 text-emerald-600 px-2 py-0.5">{detail.summary.matched} matched</span>
                <span className="rounded-full bg-amber-500/10 text-amber-600 px-2 py-0.5">{detail.summary.unmatched} to review</span>
                <span className="text-muted-foreground">of {detail.summary.total} lines</span>
              </div>
              <div className="rounded-lg border border-border overflow-x-auto max-h-[55vh] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0"><tr className="bg-muted/70 text-muted-foreground">
                    <th className="text-left px-3 py-2">Date</th><th className="text-left px-3 py-2">Description</th>
                    <th className="text-right px-3 py-2">Debit</th><th className="text-right px-3 py-2">Credit</th>
                    <th className="text-left px-3 py-2">Status / action</th>
                  </tr></thead>
                  <tbody>
                    {detail.lines.map((l) => (
                      <tr key={l.id} className="border-t border-border">
                        <td className="px-3 py-1.5 whitespace-nowrap">{l.date ? formatDate(l.date) : "—"}</td>
                        <td className="px-3 py-1.5 truncate max-w-[220px]">{l.description}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-rose-600">{num(l.debit) ? formatINR(l.debit) : ""}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-emerald-600">{num(l.credit) ? formatINR(l.credit) : ""}</td>
                        <td className="px-3 py-1.5">
                          {l.match_status === "matched" ? (
                            <span className="flex items-center gap-2">
                              <span className="text-emerald-600 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> {l.matched_source_type?.replace(/_/g, " ")}</span>
                              <button className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-0.5" onClick={async () => { await api.unmatchStmtLine(l.id); refresh(); }}><Unlink className="w-3 h-3" /> unmatch</button>
                            </span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <select className="h-7 rounded-sm border border-input bg-background px-1 text-xs max-w-[220px]" defaultValue=""
                                onChange={async (e) => { if (!e.target.value) return; const [st, sid] = e.target.value.split(":"); await api.matchStmtLine(l.id, { source_type: st, source_id: Number(sid) }); refresh(); }}>
                                <option value="">Match to…</option>
                                {detail.movements.filter((m) => !m.matched && Math.abs(Number(m.amount) - Number(l.amount)) < 0.5).map((m) => (
                                  <option key={`${m.source_type}:${m.source_id}`} value={`${m.source_type}:${m.source_id}`}>{formatDate(m.date)} · {m.source_type.replace(/_/g, " ")} · {formatINR(m.amount)}</option>
                                ))}
                                {detail.movements.filter((m) => !m.matched && Math.abs(Number(m.amount) - Number(l.amount)) >= 0.5).map((m) => (
                                  <option key={`o${m.source_type}:${m.source_id}`} value={`${m.source_type}:${m.source_id}`}>{formatDate(m.date)} · {m.source_type.replace(/_/g, " ")} · {formatINR(m.amount)} (≠)</option>
                                ))}
                              </select>
                              <button className="text-xs text-primary flex items-center gap-0.5 whitespace-nowrap" title="Create a bank entry from this line" onClick={async () => { await api.createEntryFromStmtLine(l.id); refresh(); }}><PlusCircle className="w-3.5 h-3.5" /> create entry</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground flex items-center gap-1"><Link2 className="w-3.5 h-3.5" /> Matched lines mark the bank movement as cleared for reconciliation.</span>
                <Button size="sm" onClick={onClose}>Done</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
