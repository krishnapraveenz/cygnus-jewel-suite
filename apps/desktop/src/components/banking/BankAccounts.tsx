import { useEffect, useState } from "react";
import { Plus, Landmark, CheckCircle2, Pencil, ArrowLeftRight, Trash2, Upload } from "lucide-react";
import * as api from "@/api";
import type { BankAccount, BankRecon } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateField } from "@/components/ui/date-field";
import { confirm, alertDialog } from "@/lib/dialog";
import { StatementImport } from "@/components/banking/StatementImport";
import { formatINR, formatDate } from "@/lib/utils";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function BankAccounts() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [recon, setRecon] = useState<BankRecon | null>(null);
  const [stmt, setStmt] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [entryForm, setEntryForm] = useState<{ id?: number; kind: string; amount: string; date: string; note: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAccounts() {
    try {
      const a = await api.listBankAccounts();
      setAccounts(a);
      if (selId === null && a.length) setSelId(a[0].id);
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function loadRecon(id: number) {
    try { setRecon(await api.bankReconcile(id)); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { loadAccounts(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (selId) { setEditing(false); setTransferring(false); loadRecon(selId); } /* eslint-disable-next-line */ }, [selId]);

  const sel = accounts.find((a) => a.id === selId) ?? null;

  async function toggleCleared(m: api.BankReconMovement) {
    if (!selId) return;
    await api.setBankRecon({ source_type: m.source_type, source_id: m.source_id, bank_account_id: selId, cleared: !m.cleared });
    loadRecon(selId);
  }
  async function reassign(m: api.BankReconMovement, toId: number) {
    await api.setBankRecon({ source_type: m.source_type, source_id: m.source_id, bank_account_id: toId, cleared: m.cleared });
    if (selId) loadRecon(selId);
  }

  async function del() {
    if (!sel) return;
    const ok = await confirm({ title: "Delete bank account", danger: true, confirmText: "Delete",
      message: `Delete "${sel.name}"? This can't be undone.` });
    if (!ok) return;
    try {
      await api.deleteBankAccount(sel.id);
      setSelId(null);
      await loadAccounts();
    } catch (e) {
      await alertDialog({ title: "Cannot delete", tone: "danger", message: String(e instanceof Error ? e.message : e) });
    }
  }

  async function delEntry(m: api.BankReconMovement) {
    const ok = await confirm({ title: "Delete entry", danger: true, confirmText: "Delete", message: `Delete this ${m.mode.replace(/_/g, " ")} entry of ${formatINR(m.amount)}?` });
    if (!ok) return;
    await api.deleteBankEntry(m.source_id);
    if (selId) loadRecon(selId);
  }
  function editEntry(m: api.BankReconMovement) {
    setEntryForm({ id: m.source_id, kind: m.mode, amount: String(Math.abs(Number(m.amount))), date: m.date.slice(0, 10), note: m.ref ?? "" });
  }

  const stmtNum = Number(stmt);
  const diff = recon && stmt !== "" ? stmtNum - Number(recon.cleared_balance) : null;

  return (
    <div className="flex gap-4 h-full">
      <aside className="w-64 shrink-0 border-r border-border pr-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bank accounts</div>
          <Button size="sm" variant="ghost" onClick={() => setAdding((a) => !a)}><Plus className="w-3.5 h-3.5" /></Button>
        </div>
        {adding && <AccountForm onDone={() => { setAdding(false); loadAccounts(); }} />}
        <div className="space-y-1">
          {accounts.map((a) => (
            <button key={a.id} onClick={() => setSelId(a.id)}
              className={`w-full text-left px-2 py-2 rounded-md text-sm ${selId === a.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}>
              <div className="flex items-center gap-1.5 font-medium"><Landmark className="w-3.5 h-3.5" /> {a.name}{a.is_primary ? <span className="text-[10px] text-muted-foreground">· primary</span> : ""}</div>
              <div className="text-[11px] text-muted-foreground">{[a.bank_name, a.account_no].filter(Boolean).join(" · ") || "—"}</div>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 min-w-0 space-y-4">
        {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}
        {recon && sel && (
          <>
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold">{recon.account.name}</h2>
                <p className="text-sm text-muted-foreground">Statement &amp; reconciliation · <span className="uppercase">{sel.account_type}</span> · {[sel.bank_name, sel.account_no, sel.ifsc].filter(Boolean).join(" · ") || "—"}</p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => { setEntryForm({ kind: "deposit", amount: "", date: iso(new Date()), note: "" }); setEditing(false); setTransferring(false); }}><Plus className="w-3.5 h-3.5 mr-1" /> Add entry</Button>
                <Button size="sm" variant="outline" onClick={() => setImporting(true)}><Upload className="w-3.5 h-3.5 mr-1" /> Import statement</Button>
                <Button size="sm" variant="outline" onClick={() => { setTransferring((t) => !t); setEditing(false); setEntryForm(null); }}><ArrowLeftRight className="w-3.5 h-3.5 mr-1" /> Transfer</Button>
                <Button size="sm" variant="outline" onClick={() => { setEditing((e) => !e); setTransferring(false); setEntryForm(null); }}><Pencil className="w-3.5 h-3.5 mr-1" /> Edit</Button>
                <Button size="sm" variant="destructive" onClick={del} disabled={sel.is_primary} title={sel.is_primary ? "Set another account as primary first" : "Delete account"}><Trash2 className="w-3.5 h-3.5 mr-1" /> Delete</Button>
              </div>
            </div>

            {editing && <AccountForm account={sel} onDone={() => { setEditing(false); loadAccounts(); if (selId) loadRecon(selId); }} />}
            {entryForm && <BankEntryForm accountId={sel.id} initial={entryForm} onDone={() => { setEntryForm(null); if (selId) loadRecon(selId); }} onCancel={() => setEntryForm(null)} />}
            {transferring && (
              <TransferForm from={sel} accounts={accounts.filter((a) => a.id !== sel.id)}
                onDone={() => { setTransferring(false); if (selId) loadRecon(selId); }} />
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card className="p-3"><div className="text-xs text-muted-foreground">Opening balance</div><div className="text-lg font-mono">{formatINR(recon.account.opening_balance)}</div></Card>
              <Card className="p-3"><div className="text-xs text-muted-foreground">Book balance</div><div className="text-lg font-mono font-semibold">{formatINR(recon.book_balance)}</div></Card>
              <Card className="p-3"><div className="text-xs text-muted-foreground">Cleared balance</div><div className="text-lg font-mono font-semibold text-emerald-600">{formatINR(recon.cleared_balance)}</div></Card>
              <Card className="p-3"><div className="text-xs text-muted-foreground">Uncleared (in transit)</div><div className="text-lg font-mono">{formatINR(recon.uncleared)}</div></Card>
            </div>
            <Card className="p-3 flex flex-wrap items-center gap-3">
              <Label className="text-sm">Bank statement balance</Label>
              <Input value={stmt} onChange={(e) => setStmt(e.target.value)} placeholder="closing balance" className="font-mono w-44" />
              {diff !== null && (
                <span className={`text-sm font-medium ${Math.abs(diff) < 0.5 ? "text-emerald-600" : "text-rose-600"}`}>
                  {Math.abs(diff) < 0.5 ? <><CheckCircle2 className="inline w-4 h-4 mr-1" />Reconciled</> : `Difference: ${formatINR(diff)}`}
                </span>
              )}
            </Card>

            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
                  <th className="text-center px-3 py-2 font-medium">Cleared</th>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-left px-3 py-2 font-medium">Type</th>
                  <th className="text-left px-3 py-2 font-medium">Ref</th>
                  <th className="text-right px-3 py-2 font-medium">In</th>
                  <th className="text-right px-3 py-2 font-medium">Out</th>
                  <th className="text-right px-3 py-2 font-medium">Balance</th>
                  <th className="text-left px-3 py-2 font-medium">Account</th>
                </tr></thead>
                <tbody>
                  {recon.rows.map((m) => {
                    const amt = Number(m.amount);
                    return (
                      <tr key={`${m.source_type}-${m.source_id}`} className="border-b border-border last:border-0">
                        <td className="px-3 py-1.5 text-center"><input type="checkbox" checked={m.cleared} onChange={() => toggleCleared(m)} /></td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(m.date)}</td>
                        <td className="px-3 py-1.5 capitalize">{m.source_type.replace(/_/g, " ")}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{m.ref || "—"}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-emerald-600">{amt > 0 ? formatINR(amt) : ""}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-rose-600">{amt < 0 ? formatINR(-amt) : ""}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{formatINR(m.balance)}</td>
                        <td className="px-3 py-1.5">
                          {m.source_type === "bank_entry" ? (
                            <span className="flex items-center gap-1">
                              <button className="text-muted-foreground hover:text-primary" title="Edit" onClick={() => editEntry(m)}><Pencil className="w-3.5 h-3.5" /></button>
                              <button className="text-destructive" title="Delete" onClick={() => delEntry(m)}><Trash2 className="w-3.5 h-3.5" /></button>
                            </span>
                          ) : m.source_type.startsWith("transfer") ? <span className="text-xs text-muted-foreground">transfer</span> : (
                            <select value={selId ?? ""} onChange={(e) => reassign(m, Number(e.target.value))} className="h-7 rounded-sm border border-input bg-background px-1 text-xs">
                              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-muted/30 font-medium">
                    <td /><td className="px-3 py-2 whitespace-nowrap" colSpan={5}>Opening balance</td>
                    <td className="px-3 py-2 text-right font-mono">{formatINR(recon.account.opening_balance)}</td><td />
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {importing && sel && (
        <StatementImport account={sel} onClose={() => { setImporting(false); if (selId) loadRecon(selId); }} onImported={() => { if (selId) loadRecon(selId); }} />
      )}
    </div>
  );
}

function AccountForm({ account, onDone }: { account?: BankAccount; onDone: () => void }) {
  const [name, setName] = useState(account?.name ?? "");
  const [bank, setBank] = useState(account?.bank_name ?? "");
  const [acno, setAcno] = useState(account?.account_no ?? "");
  const [ifsc, setIfsc] = useState(account?.ifsc ?? "");
  const [open, setOpen] = useState(account?.opening_balance ?? "0");
  const [primary, setPrimary] = useState(account?.is_primary ?? false);
  const [type, setType] = useState(account?.account_type ?? "current");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name) return;
    setBusy(true);
    try {
      const body = { name, bank_name: bank || undefined, account_no: acno || undefined, ifsc: ifsc || undefined, opening_balance: open || "0", is_primary: primary, account_type: type };
      if (account) await api.updateBankAccount(account.id, body);
      else await api.createBankAccount(body);
      onDone();
    } finally { setBusy(false); }
  }
  return (
    <Card className="p-3 space-y-2">
      <div className="text-sm font-medium">{account ? "Edit account" : "New account"}</div>
      <div className="grid grid-cols-2 gap-2">
        <div><Label className="text-xs">Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><Label className="text-xs">Bank</Label><Input value={bank} onChange={(e) => setBank(e.target.value)} /></div>
        <div><Label className="text-xs">Account no.</Label><Input value={acno} onChange={(e) => setAcno(e.target.value)} /></div>
        <div><Label className="text-xs">IFSC</Label><Input value={ifsc} onChange={(e) => setIfsc(e.target.value)} /></div>
        <div>
          <Label className="text-xs">Type</Label>
          <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="savings">Savings</option><option value="current">Current</option>
            <option value="od">Overdraft (OD)</option><option value="cc">Cash Credit (CC)</option>
          </select>
        </div>
        <div><Label className="text-xs">Opening balance</Label><Input value={open} onChange={(e) => setOpen(e.target.value)} className="font-mono" /></div>
        <label className="flex items-center gap-2 text-xs self-end pb-2"><input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> Primary</label>
      </div>
      <Button size="sm" onClick={save} disabled={busy}>{busy ? "Saving…" : account ? "Save changes" : "Add account"}</Button>
    </Card>
  );
}

function TransferForm({ from, accounts, onDone }: { from: BankAccount; accounts: BankAccount[]; onDone: () => void }) {
  const [toId, setToId] = useState<number | "">(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(iso(new Date()));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    if (!toId || !(Number(amount) > 0)) return;
    setBusy(true); setErr(null);
    try { await api.bankTransfer({ from_account_id: from.id, to_account_id: Number(toId), amount, transfer_date: date, note: note || undefined }); onDone(); }
    catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  return (
    <Card className="p-3 space-y-2">
      <div className="text-sm font-medium">Fund transfer from {from.name}</div>
      {err && <div className="text-xs text-destructive">{err}</div>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
        <div><Label className="text-xs">To account</Label>
          <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={toId} onChange={(e) => setToId(e.target.value ? Number(e.target.value) : "")}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div><Label className="text-xs">Amount</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
        <div><Label className="text-xs">Date</Label><DateField value={date} onChange={setDate} /></div>
        <div className="flex items-end"><Button size="sm" onClick={go} disabled={busy} className="w-full">Transfer</Button></div>
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
    </Card>
  );
}

const ENTRY_KINDS: { v: string; label: string }[] = [
  { v: "deposit", label: "Cash deposit (cash → bank)" },
  { v: "withdrawal", label: "Cash withdrawal (bank → cash)" },
  { v: "interest", label: "Interest received" },
  { v: "charges", label: "Bank charges" },
  { v: "other_credit", label: "Other credit (money in)" },
  { v: "other_debit", label: "Other debit (money out)" },
];

function BankEntryForm({ accountId, initial, onDone, onCancel }: {
  accountId: number;
  initial: { id?: number; kind: string; amount: string; date: string; note: string };
  onDone: () => void; onCancel: () => void;
}) {
  const [kind, setKind] = useState(initial.kind);
  const [amount, setAmount] = useState(initial.amount);
  const [date, setDate] = useState(initial.date);
  const [note, setNote] = useState(initial.note);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!(Number(amount) > 0)) return;
    setBusy(true);
    try {
      const body = { bank_account_id: accountId, entry_date: date, kind, amount, note: note || undefined };
      if (initial.id) await api.updateBankEntry(initial.id, body);
      else await api.createBankEntry(body);
      onDone();
    } finally { setBusy(false); }
  }
  return (
    <Card className="p-3 space-y-2">
      <div className="text-sm font-medium">{initial.id ? "Edit bank entry" : "Add bank entry"}</div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
        <div className="col-span-2">
          <Label className="text-xs">Type</Label>
          <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
            {ENTRY_KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
          </select>
        </div>
        <div><Label className="text-xs">Amount</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
        <div><Label className="text-xs">Date</Label><DateField value={date} onChange={setDate} /></div>
        <div className="flex items-end gap-2">
          <Button size="sm" onClick={save} disabled={busy}>{initial.id ? "Save" : "Add"}</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
    </Card>
  );
}
