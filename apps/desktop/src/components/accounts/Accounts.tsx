import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Plus, BookOpen, X, Trash2 } from "lucide-react";
import * as api from "@/api";
import type { Account, PnL, BalanceSheet, JournalRow, ExpenseRow, RegisterReport, MetalOpt } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateField } from "@/components/ui/date-field";
import { TagSheet } from "@/components/inventory/TagSheet";
import { formatINR, formatDate } from "@/lib/utils";

type Tab = "pnl" | "balance" | "trial" | "journal" | "expenses" | "receipts" | "coa" | "opening";
const TABS: { id: Tab; label: string }[] = [
  { id: "pnl", label: "Profit & Loss" },
  { id: "balance", label: "Balance Sheet" },
  { id: "trial", label: "Trial Balance" },
  { id: "journal", label: "Journal" },
  { id: "expenses", label: "Expenses" },
  { id: "receipts", label: "Receipts" },
  { id: "coa", label: "Chart of Accounts" },
  { id: "opening", label: "Opening balances" },
];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fyStart = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04-01`; };

export function Accounts() {
  const [tab, setTab] = useState<Tab>("pnl");
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(iso(new Date()));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [pnl, setPnl] = useState<PnL | null>(null);
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [tb, setTb] = useState<RegisterReport | null>(null);
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [receipts, setReceipts] = useState<import("@/api").ReceiptRow[]>([]);
  const [coa, setCoa] = useState<Account[]>([]);

  async function load() {
    setError(null);
    try {
      if (tab === "pnl") setPnl(await api.profitLoss(from, to));
      else if (tab === "balance") setBs(await api.balanceSheet(from, to));
      else if (tab === "trial") setTb(await api.trialBalance(from, to));
      else if (tab === "journal") setJournal((await api.journalReport(from, to)).rows);
      else if (tab === "expenses") setExpenses(await api.listExpenses());
      else if (tab === "receipts") setReceipts(await api.listReceipts());
      else if (tab === "coa") setCoa(await api.listAccounts());
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tab, from, to]);

  // No auto-rebuild on open (performance at scale). User clicks "Rebuild" explicitly.

  async function rebuild() {
    setBusy(true); setMsg(null); setError(null);
    try {
      const r = await api.accountsRebuild();
      setMsg(`Rebuilt — ${r.entries} journal entries posted from documents.`);
      await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  const rangeTab = tab !== "expenses" && tab !== "coa" && tab !== "opening" && tab !== "receipts";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Accounts</h2>
          <p className="text-sm text-muted-foreground">Double-entry books derived from your documents.</p>
        </div>
        <div className="flex items-center gap-2">
          {rangeTab && <><DateField value={from} onChange={setFrom} /><span className="text-muted-foreground text-sm">to</span><DateField value={to} onChange={setTo} /></>}
          <Button size="sm" variant="outline" onClick={rebuild} disabled={busy}><RefreshCw className="w-3.5 h-3.5 mr-1" /> {busy ? "Rebuilding…" : "Rebuild"}</Button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border flex-wrap">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-2 text-sm ${tab === t.id ? "border-b-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}>{t.label}</button>
        ))}
      </div>

      {msg && <div className="rounded-md bg-success/10 text-success px-3 py-2 text-sm">{msg}</div>}
      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}

      {tab === "pnl" && pnl && <PnLView p={pnl} />}
      {tab === "balance" && bs && <BalanceView b={bs} />}
      {tab === "trial" && tb && <TrialView tb={tb} />}
      {tab === "journal" && <JournalView rows={journal} />}
      {tab === "expenses" && <ExpensesView rows={expenses} onAdded={rebuild} />}
      {tab === "receipts" && <ReceiptsView rows={receipts} onAdded={rebuild} />}
      {tab === "coa" && <CoaView rows={coa} onAdded={load} />}
      {tab === "opening" && <OpeningView onSaved={rebuild} />}
    </div>
  );
}

function Section({ title, rows, total, totalLabel }: { title: string; rows: { account: string; amount: string }[]; total: string; totalLabel: string }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="bg-muted/50 px-3 py-2 text-sm font-medium">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-3 py-1.5">{r.account}</td>
              <td className="px-3 py-1.5 text-right font-mono">{formatINR(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="border-t border-border bg-muted/40 font-medium">
          <td className="px-3 py-2">{totalLabel}</td><td className="px-3 py-2 text-right font-mono">{formatINR(total)}</td>
        </tr></tfoot>
      </table>
    </div>
  );
}

function PnLView({ p }: { p: PnL }) {
  const net = Number(p.net_profit);
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Income" rows={p.income} total={p.total_income} totalLabel="Total income" />
        <Section title="Expenses" rows={p.expenses} total={p.total_expense} totalLabel="Total expenses" />
      </div>
      <Card className={`p-4 ${net >= 0 ? "border-emerald-400/50" : "border-rose-400/50"}`}>
        <div className="flex justify-between items-center">
          <span className="font-medium">{net >= 0 ? "Net Profit" : "Net Loss"}</span>
          <span className={`text-lg font-mono font-semibold ${net >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{formatINR(Math.abs(net))}</span>
        </div>
      </Card>
    </div>
  );
}

function BalanceView({ b }: { b: BalanceSheet }) {
  return (
    <div className="space-y-3 max-w-4xl">
      {!b.balanced && <div className="rounded-md bg-amber-500/10 text-amber-600 px-3 py-2 text-sm">Not balanced — run Rebuild.</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Assets" rows={b.assets} total={b.total_assets} totalLabel="Total assets" />
        <div className="space-y-4">
          <Section title="Liabilities" rows={b.liabilities} total={b.total_liabilities} totalLabel="Total liabilities" />
          <Section title="Equity" rows={b.equity} total={b.total_equity} totalLabel="Total equity" />
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        Assets {formatINR(b.total_assets)} = Liabilities {formatINR(b.total_liabilities)} + Equity {formatINR(b.total_equity)} · {b.balanced ? "✓ balanced" : "⚠ not balanced"}
      </div>
    </div>
  );
}

function TrialView({ tb }: { tb: RegisterReport }) {
  return (
    <div className="rounded-lg border border-border overflow-x-auto max-w-3xl">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
          <th className="text-left px-3 py-2 font-medium">Code</th>
          <th className="text-left px-3 py-2 font-medium">Account</th>
          <th className="text-right px-3 py-2 font-medium">Debit</th>
          <th className="text-right px-3 py-2 font-medium">Credit</th>
        </tr></thead>
        <tbody>
          {tb.rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 font-mono text-xs">{r.code}</td>
              <td className="px-3 py-1.5">{r.account}</td>
              <td className="px-3 py-1.5 text-right font-mono">{Number(r.debit) ? formatINR(r.debit ?? "0") : "—"}</td>
              <td className="px-3 py-1.5 text-right font-mono">{Number(r.credit) ? formatINR(r.credit ?? "0") : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="border-t border-border bg-muted/40 font-medium">
          <td className="px-3 py-2" colSpan={2}>Total</td>
          <td className="px-3 py-2 text-right font-mono">{formatINR(tb.totals.debit)}</td>
          <td className="px-3 py-2 text-right font-mono">{formatINR(tb.totals.credit)}</td>
        </tr></tfoot>
      </table>
    </div>
  );
}

function JournalView({ rows }: { rows: JournalRow[] }) {
  if (rows.length === 0) return <Card className="p-10 text-center text-sm text-muted-foreground">No journal entries. Click Rebuild.</Card>;
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
          <th className="text-left px-3 py-2 font-medium">Date</th>
          <th className="text-left px-3 py-2 font-medium">Narration</th>
          <th className="text-left px-3 py-2 font-medium">Account</th>
          <th className="text-right px-3 py-2 font-medium">Debit</th>
          <th className="text-right px-3 py-2 font-medium">Credit</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-b border-border last:border-0 ${i > 0 && rows[i - 1].entry_id !== r.entry_id ? "border-t-2 border-t-muted" : ""}`}>
              <td className="px-3 py-1.5 whitespace-nowrap">{r.account_code === rows[i - 1]?.account_code && rows[i - 1]?.entry_id === r.entry_id ? "" : formatDate(r.date)}</td>
              <td className="px-3 py-1.5 text-muted-foreground text-xs">{rows[i - 1]?.entry_id === r.entry_id ? "" : r.narration}</td>
              <td className="px-3 py-1.5"><span className="font-mono text-xs text-muted-foreground">{r.account_code}</span> {r.account}</td>
              <td className="px-3 py-1.5 text-right font-mono">{Number(r.debit) ? formatINR(r.debit) : ""}</td>
              <td className="px-3 py-1.5 text-right font-mono">{Number(r.credit) ? formatINR(r.credit) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExpensesView({ rows, onAdded }: { rows: ExpenseRow[]; onAdded: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [date, setDate] = useState(iso(new Date()));
  const [accId, setAccId] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listAccounts().then((a) => setAccounts(a.filter((x) => x.type === "expense" && x.active))).catch(() => {}); }, []);
  const expAccounts = useMemo(() => accounts, [accounts]);
  async function add() {
    if (!accId || !(Number(amount) > 0)) return;
    setBusy(true);
    try { await api.createExpense({ expense_date: date, account_id: Number(accId), amount, mode, note: note || undefined }); setAmount(""); setNote(""); onAdded(); }
    finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="text-sm font-medium mb-2">Record expense</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
          <div><Label>Date</Label><DateField value={date} onChange={setDate} /></div>
          <div className="col-span-2">
            <Label>Account</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={accId} onChange={(e) => setAccId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Select…</option>
              {expAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>
          </div>
          <div><Label>Amount</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
          <div>
            <Label>Mode</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="cash">Cash</option><option value="bank">Bank</option>
            </select>
          </div>
          <div className="flex items-end"><Button onClick={add} disabled={busy} className="w-full"><Plus className="w-3.5 h-3.5 mr-1" /> Add</Button></div>
        </div>
        <div className="mt-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" /></div>
        <p className="text-xs text-muted-foreground mt-2">Saved expenses post to the journal on the next Rebuild.</p>
      </Card>
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
            <th className="text-left px-3 py-2 font-medium">Date</th><th className="text-left px-3 py-2 font-medium">Account</th>
            <th className="text-left px-3 py-2 font-medium">Mode</th><th className="text-left px-3 py-2 font-medium">Note</th>
            <th className="text-right px-3 py-2 font-medium">Amount</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No expenses yet.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5">{formatDate(r.date)}</td>
                <td className="px-3 py-1.5"><span className="font-mono text-xs text-muted-foreground">{r.account_code}</span> {r.account}</td>
                <td className="px-3 py-1.5 capitalize">{r.mode}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.note || "—"}</td>
                <td className="px-3 py-1.5 text-right font-mono">{formatINR(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CoaView({ rows, onAdded }: { rows: Account[]; onAdded: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("expense");
  const [busy, setBusy] = useState(false);
  async function add() {
    if (!code || !name) return;
    setBusy(true);
    try { await api.createAccount({ code, name, type }); setCode(""); setName(""); onAdded(); }
    finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="text-sm font-medium mb-2">Add account</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
          <div><Label>Code</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 5330" /></div>
          <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div>
            <Label>Type</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
              {["asset", "liability", "equity", "income", "expense"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="flex items-end"><Button onClick={add} disabled={busy}><Plus className="w-3.5 h-3.5 mr-1" /> Add</Button></div>
        </div>
      </Card>
      <div className="rounded-lg border border-border overflow-x-auto max-w-2xl">
        <table className="w-full text-sm">
          <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
            <th className="text-left px-3 py-2 font-medium">Code</th><th className="text-left px-3 py-2 font-medium">Account</th>
            <th className="text-left px-3 py-2 font-medium">Type</th>
          </tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5 font-mono text-xs">{a.code}</td>
                <td className="px-3 py-1.5">{a.name}{a.system ? <span className="ml-1 text-[10px] text-muted-foreground">(system)</span> : ""}</td>
                <td className="px-3 py-1.5 capitalize">{a.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const AccountsIcon = BookOpen;

function OpeningView({ onSaved, onAddStock }: { onSaved: () => void; onAddStock?: () => void }) {
  const [date, setDate] = useState("2026-04-01");
  const [cash, setCash] = useState("0");
  const [fa, setFa] = useState("0");
  const [igst, setIgst] = useState("0");
  const [loans, setLoans] = useState("0");
  const [cadv, setCadv] = useState("0");
  const [scheme, setScheme] = useState("0");
  const [ogst, setOgst] = useState("0");
  const [banks, setBanks] = useState<import("@/api").BankAccount[]>([]);
  const [parties, setParties] = useState<import("@/api").OpeningPartyRow[]>([]);
  const [stock, setStock] = useState<import("@/api").OpeningStockSummary | null>(null);
  const [pq, setPq] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [addStock, setAddStock] = useState(false);
  const [tagRows, setTagRows] = useState<import("@/api").ItemTag[] | null>(null);

  function load() {
    api.getSettings().then((s) => {
      setDate(s["accounts.opening_date"] || "2026-04-01");
      setCash(s["accounts.opening_cash"] || "0");
      setFa(s["accounts.opening_fixed_assets"] || "0");
      setIgst(s["accounts.opening_input_gst"] || "0");
      setLoans(s["accounts.opening_loans"] || "0");
      setCadv(s["accounts.opening_cust_advances"] || "0");
      setScheme(s["accounts.opening_scheme_deposits"] || "0");
      setOgst(s["accounts.opening_output_gst"] || "0");
    }).catch(() => {});
    api.listBankAccounts().then(setBanks).catch(() => {});
    api.openingParties().then(setParties).catch(() => {});
    api.openingStockSummary().then(setStock).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  const n = (v: string) => Number(v) || 0;
  const bankTotal = banks.reduce((a, b) => a + n(b.opening_balance), 0);
  const stockTotal = n(stock?.total ?? "0");
  const sundryDeb = parties.reduce((a, p) => a + Math.max(0, n(p.opening_cash_balance)), 0);
  const sundryCred = parties.reduce((a, p) => a + Math.max(0, -n(p.opening_cash_balance)), 0);
  const assets = n(cash) + bankTotal + n(fa) + n(igst) + stockTotal + sundryDeb;
  const liab = n(loans) + n(cadv) + n(scheme) + n(ogst) + sundryCred;
  const capital = assets - liab;

  const setBank = (id: number, v: string) => setBanks((bs) => bs.map((b) => b.id === id ? { ...b, opening_balance: v } : b));
  const setParty = (id: number, k: "opening_cash_balance" | "opening_metal_balance", v: string) =>
    setParties((ps) => ps.map((p) => p.id === id ? { ...p, [k]: v } : p));

  const shownParties = parties.filter((p) => !pq || p.display_name.toLowerCase().includes(pq.toLowerCase()));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await Promise.all([
        api.setSetting("accounts.opening_date", date),
        api.setSetting("accounts.opening_cash", cash || "0"),
        api.setSetting("accounts.opening_fixed_assets", fa || "0"),
        api.setSetting("accounts.opening_input_gst", igst || "0"),
        api.setSetting("accounts.opening_loans", loans || "0"),
        api.setSetting("accounts.opening_cust_advances", cadv || "0"),
        api.setSetting("accounts.opening_scheme_deposits", scheme || "0"),
        api.setSetting("accounts.opening_output_gst", ogst || "0"),
        ...banks.map((b) => api.updateBankAccount(b.id, { opening_balance: b.opening_balance || "0" })),
      ]);
      await api.setOpeningParties(parties.map((p) => ({
        party_id: p.id,
        opening_cash_balance: p.opening_cash_balance || "0",
        opening_metal_balance: p.opening_metal_balance || "0",
      })));
      onSaved();
      setMsg("Saved and rebuilt. Capital carries the balancing figure — check the Balance Sheet / Trial Balance.");
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const fld = "font-mono";
  return (
    <div className="space-y-4 max-w-4xl">
      {/* Live balance check */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Label>Opening date</Label>
            <div className="w-40"><DateField value={date} onChange={setDate} /></div>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <div>Assets <span className="font-mono font-semibold">{formatINR(assets)}</span></div>
            <div>Liabilities <span className="font-mono font-semibold">{formatINR(liab)}</span></div>
            <div className="text-primary">Capital (plug) <span className="font-mono font-semibold">{formatINR(capital)}</span></div>
            <span className="px-2 py-0.5 rounded bg-green-500/10 text-green-700 dark:text-green-400 text-xs font-medium">Balances ✓</span>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Everything here is one linked go-live snapshot; Capital is the auto-balancing figure. Bank openings mirror the Bank Accounts master; party openings mirror the Parties screen; stock is the sum of item costs.
        </p>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Ledger balances */}
        <Card className="p-4 space-y-3">
          <div className="text-sm font-medium">Ledger balances</div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Cash in hand</Label><Input value={cash} onChange={(e) => setCash(e.target.value)} className={fld} /></div>
            <div><Label>Fixed assets</Label><Input value={fa} onChange={(e) => setFa(e.target.value)} className={fld} /></div>
            <div><Label>Input GST credit</Label><Input value={igst} onChange={(e) => setIgst(e.target.value)} className={fld} /></div>
            <div><Label>Loans (taken)</Label><Input value={loans} onChange={(e) => setLoans(e.target.value)} className={fld} /></div>
            <div><Label>Customer advances</Label><Input value={cadv} onChange={(e) => setCadv(e.target.value)} className={fld} /></div>
            <div><Label>Scheme deposits</Label><Input value={scheme} onChange={(e) => setScheme(e.target.value)} className={fld} /></div>
            <div><Label>Output GST payable</Label><Input value={ogst} onChange={(e) => setOgst(e.target.value)} className={fld} /></div>
          </div>
        </Card>

        {/* Banks + stock */}
        <div className="space-y-4">
          <Card className="p-4 space-y-2">
            <div className="text-sm font-medium">Bank accounts</div>
            {banks.length === 0 ? <div className="text-xs text-muted-foreground">No bank accounts.</div> :
              banks.map((b) => (
                <div key={b.id} className="flex items-center gap-2">
                  <span className="text-sm flex-1 truncate">{b.name}</span>
                  <Input value={b.opening_balance} onChange={(e) => setBank(b.id, e.target.value)} className="font-mono h-8 w-36" />
                </div>
              ))}
          </Card>
          <Card className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Opening stock (from items)</div>
              <Button variant="outline" size="sm" onClick={() => { setAddStock(true); onAddStock?.(); }}>Add opening stock</Button>
            </div>
            {stock && stock.rows.length > 0 ? (
              <table className="w-full text-sm">
                <tbody>
                  {stock.rows.map((r) => (
                    <tr key={r.department}><td className="py-0.5">{r.department}</td><td className="py-0.5 text-right text-muted-foreground text-xs">{r.pieces} pcs</td><td className="py-0.5 text-right font-mono">{formatINR(r.cost)}</td></tr>
                  ))}
                  <tr className="border-t border-border font-semibold"><td className="py-1" colSpan={2}>Total stock</td><td className="py-1 text-right font-mono">{formatINR(stockTotal)}</td></tr>
                </tbody>
              </table>
            ) : <div className="text-xs text-muted-foreground">No stock yet. Use "Add opening stock" to bring in existing inventory (barcoded, by department).</div>}
          </Card>
        </div>
      </div>

      {/* Party openings */}
      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Party opening balances <span className="text-xs text-muted-foreground">(+ owes us / − we owe)</span></div>
          <Input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search party…" className="h-8 w-56" />
        </div>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-[11px] uppercase text-muted-foreground border-b border-border"><th className="text-left py-1">Party</th><th className="text-right py-1 w-40">Opening ₹ (+/−)</th><th className="text-right py-1 w-40">Metal fine g (+/−)</th></tr></thead>
            <tbody>
              {shownParties.map((p) => (
                <tr key={p.id} className="border-b border-border/50">
                  <td className="py-1">{p.display_name}</td>
                  <td className="py-1"><Input value={p.opening_cash_balance} onChange={(e) => setParty(p.id, "opening_cash_balance", e.target.value)} className="font-mono h-7 text-right" /></td>
                  <td className="py-1"><Input value={p.opening_metal_balance} onChange={(e) => setParty(p.id, "opening_metal_balance", e.target.value)} className="font-mono h-7 text-right" /></td>
                </tr>
              ))}
              {shownParties.length === 0 && <tr><td colSpan={3} className="py-4 text-center text-muted-foreground text-sm">No parties.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="text-xs text-muted-foreground">Sundry Debtors {formatINR(sundryDeb)} · Sundry Creditors {formatINR(sundryCred)}</div>
        {/* Audit schedule: per-party balances split by nature → ties to 1100 / 2000 */}
        <div className="grid grid-cols-2 gap-4 mt-3 text-xs">
          <div>
            <div className="font-medium text-muted-foreground mb-1">Sundry Debtors schedule (1100)</div>
            <table className="w-full">
              <tbody>
                {parties.filter((p) => Number(p.opening_cash_balance) > 0).map((p) => (
                  <tr key={p.id}><td className="py-0.5 truncate">{p.display_name}</td><td className="py-0.5 text-right font-mono">{formatINR(p.opening_cash_balance)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-border font-semibold"><td className="py-1">Total</td><td className="py-1 text-right font-mono">{formatINR(sundryDeb)}</td></tr></tfoot>
            </table>
          </div>
          <div>
            <div className="font-medium text-muted-foreground mb-1">Sundry Creditors schedule (2000)</div>
            <table className="w-full">
              <tbody>
                {parties.filter((p) => Number(p.opening_cash_balance) < 0).map((p) => (
                  <tr key={p.id}><td className="py-0.5 truncate">{p.display_name}</td><td className="py-0.5 text-right font-mono">{formatINR(Math.abs(Number(p.opening_cash_balance)))}</td></tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-border font-semibold"><td className="py-1">Total</td><td className="py-1 text-right font-mono">{formatINR(sundryCred)}</td></tr></tfoot>
            </table>
          </div>
        </div>
      </Card>

      {msg && <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">{msg}</div>}
      <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save all & Rebuild"}</Button>

      {addStock && (
        <OpeningStockModal
          onClose={() => setAddStock(false)}
          onDone={(itemIds) => {
            setAddStock(false);
            api.openingStockSummary().then(setStock).catch(() => {});
            if (itemIds.length) api.itemTags(itemIds).then(setTagRows).catch(() => {});
          }}
        />
      )}
      {tagRows && <TagSheet tags={tagRows} onClose={() => setTagRows(null)} />}
    </div>
  );
}

/** Opening-stock intake: create barcoded items by department (no purchase side-effects). */
function OpeningStockModal({ onClose, onDone }: { onClose: () => void; onDone: (itemIds: number[]) => void }) {
  type Row = { key: string; metalTypeId: number | ""; purityId: number | ""; departmentId: number | ""; gross: string; net: string; stone: string; huid: string; cost: string; sku: string };
  let seq = 0;
  const newRow = (): Row => ({ key: `r${++seq}`, metalTypeId: "", purityId: "", departmentId: "", gross: "", net: "", stone: "", huid: "", cost: "", sku: "" });
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [depts, setDepts] = useState<import("@/api").Department[]>([]);
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.listMetals().then(setMetals).catch(() => {});
    api.listDepartments().then((d) => setDepts(d.filter((x) => x.active))).catch(() => {});
  }, []);
  const set = (k: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => r.key === k ? { ...r, ...patch } : r));
  const purities = (metalTypeId: number | "") => metals.find((m) => m.metal_type_id === metalTypeId)?.purities ?? [];
  const total = rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
  const sel = "flex h-8 w-full rounded-md border border-input bg-background px-1 text-sm";
  const num = "h-8 w-full text-right font-mono";

  async function save() {
    const items = rows.filter((r) => r.metalTypeId && r.purityId && Number(r.gross) > 0).map((r) => ({
      metal_type_id: Number(r.metalTypeId),
      purity_id: Number(r.purityId),
      department_id: r.departmentId === "" ? undefined : Number(r.departmentId),
      gross_weight: r.gross,
      net_weight: r.net || r.gross,
      stone_weight: r.stone || undefined,
      huid: r.huid || undefined,
      cost_value: r.cost || "0",
      sku: r.sku.trim() || undefined,
    }));
    if (items.length === 0) { setErr("Add at least one item with metal, purity and gross weight."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api.createOpeningStock(items);
      onDone(res.item_ids);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-4xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="font-semibold text-sm">Add opening stock <span className="text-xs font-normal text-muted-foreground">— barcoded items, by department · no purchase/GST</span></div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {err && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border">
                <th className="text-left px-1 py-1">Metal</th><th className="text-left px-1 py-1">Purity</th><th className="text-left px-1 py-1">Department</th>
                <th className="text-right px-1 py-1">Gross g</th><th className="text-right px-1 py-1">Net g</th><th className="text-right px-1 py-1">Stone g</th>
                <th className="text-left px-1 py-1">HUID</th><th className="text-right px-1 py-1">Cost ₹</th><th className="text-left px-1 py-1">SKU</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border/50">
                  <td className="px-1 py-1">
                    <select className={`${sel} w-24`} value={r.metalTypeId} onChange={(e) => set(r.key, { metalTypeId: e.target.value ? Number(e.target.value) : "", purityId: "" })}>
                      <option value="">—</option>
                      {metals.map((m) => <option key={m.metal_type_id} value={m.metal_type_id}>{m.metal}</option>)}
                    </select>
                  </td>
                  <td className="px-1 py-1">
                    <select className={`${sel} w-24`} value={r.purityId} onChange={(e) => set(r.key, { purityId: e.target.value ? Number(e.target.value) : "" })}>
                      <option value="">—</option>
                      {purities(r.metalTypeId).map((p) => <option key={p.purity_id} value={p.purity_id}>{p.label}</option>)}
                    </select>
                  </td>
                  <td className="px-1 py-1">
                    <select className={`${sel} w-36`} value={r.departmentId} onChange={(e) => set(r.key, { departmentId: e.target.value ? Number(e.target.value) : "" })}>
                      <option value="">(auto)</option>
                      {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </td>
                  <td className="px-1 py-1"><Input className={num} value={r.gross} onChange={(e) => set(r.key, { gross: e.target.value })} /></td>
                  <td className="px-1 py-1"><Input className={num} value={r.net} placeholder="=gross" onChange={(e) => set(r.key, { net: e.target.value })} /></td>
                  <td className="px-1 py-1"><Input className={num} value={r.stone} placeholder="0" onChange={(e) => set(r.key, { stone: e.target.value })} /></td>
                  <td className="px-1 py-1"><Input className="h-8 w-24" value={r.huid} onChange={(e) => set(r.key, { huid: e.target.value })} /></td>
                  <td className="px-1 py-1"><Input className={num} value={r.cost} onChange={(e) => set(r.key, { cost: e.target.value })} /></td>
                  <td className="px-1 py-1"><Input className="h-8 w-28" value={r.sku} placeholder="(auto)" onChange={(e) => set(r.key, { sku: e.target.value })} /></td>
                  <td className="px-1 py-1"><button onClick={() => setRows((rs) => rs.length > 1 ? rs.filter((x) => x.key !== r.key) : rs)} className="text-destructive"><Trash2 className="w-4 h-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, newRow()])}><Plus className="w-4 h-4 mr-1" /> Add row</Button>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">Total cost <span className="font-mono font-semibold text-foreground">{formatINR(total)}</span></span>
              <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Create stock + barcodes"}</Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">Creates in-stock barcoded items (dept auto-resolved from metal if blank). No supplier payable, ITC or purchase expense — it's your own go-live stock; Capital carries it.</p>
        </div>
      </Card>
    </div>
  );
}

function ReceiptsView({ rows, onAdded }: { rows: import("@/api").ReceiptRow[]; onAdded: () => void }) {
  const [parties, setParties] = useState<import("@/api").PartyListRow[]>([]);
  const [date, setDate] = useState(iso(new Date()));
  const [partyId, setPartyId] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listParties().then(setParties).catch(() => {}); }, []);
  async function add() {
    if (!partyId || !(Number(amount) > 0)) return;
    setBusy(true);
    try { await api.createReceipt({ party_id: Number(partyId), receipt_date: date, amount, mode, note: note || undefined }); setAmount(""); setNote(""); onAdded(); }
    finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="text-sm font-medium mb-2">Receive payment (against outstanding)</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
          <div><Label>Date</Label><DateField value={date} onChange={setDate} /></div>
          <div className="col-span-2">
            <Label>Party</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={partyId} onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Select…</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{p.display_name}{Number(p.cash_balance) > 0 ? ` · owes ${formatINR(p.cash_balance)}` : ""}</option>)}
            </select>
          </div>
          <div><Label>Amount</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
          <div>
            <Label>Mode</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank</option><option value="cheque">Cheque</option>
            </select>
          </div>
          <div className="flex items-end"><Button onClick={add} disabled={busy} className="w-full"><Plus className="w-3.5 h-3.5 mr-1" /> Receive</Button></div>
        </div>
        <div className="mt-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" /></div>
        <p className="text-xs text-muted-foreground mt-2">Reduces the party's outstanding and posts Dr Cash/Bank, Cr Sundry Debtors.</p>
      </Card>
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
            <th className="text-left px-3 py-2 font-medium">Date</th><th className="text-left px-3 py-2 font-medium">Party</th>
            <th className="text-left px-3 py-2 font-medium">Mode</th><th className="text-left px-3 py-2 font-medium">Note</th>
            <th className="text-right px-3 py-2 font-medium">Amount</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No receipts yet.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5">{formatDate(r.date)}</td>
                <td className="px-3 py-1.5">{r.party}</td>
                <td className="px-3 py-1.5 capitalize">{r.mode}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.note || "—"}</td>
                <td className="px-3 py-1.5 text-right font-mono">{formatINR(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
