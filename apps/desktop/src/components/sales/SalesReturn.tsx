import { useEffect, useMemo, useState } from "react";
import { RotateCcw, CheckCircle2, AlertTriangle, Coins, Wallet, PiggyBank } from "lucide-react";
import * as api from "@/api";
import type { InvoiceListRow, InvoiceDetail } from "@/api";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatINR } from "@/lib/utils";

const REASONS = ["Manufacturing defect", "Not satisfied", "Wrong item", "Size / resize", "Other"];

export function SalesReturn() {
  const [invoices, setInvoices] = useState<InvoiceListRow[]>([]);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [override, setOverride] = useState(false);
  const [reasonPreset, setReasonPreset] = useState(REASONS[0]);
  const [notes, setNotes] = useState("");
  const [settlementMode, setSettlementMode] = useState<"store_credit" | "refund">("store_credit");
  const [oldGoldAction, setOldGoldAction] = useState<"physical" | "cash">("physical");
  const [deduction, setDeduction] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.ReturnResult | null>(null);

  async function load() {
    try {
      setInvoices(await api.listInvoices());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  const returnable = useMemo(
    () =>
      invoices.filter(
        (i) =>
          (i.status === "final" || i.status === "partially_returned") &&
          ((i.document_no || "").toLowerCase().includes(search.toLowerCase()) ||
            (i.customer_name || "").toLowerCase().includes(search.toLowerCase()))
      ),
    [invoices, search]
  );

  const returned = useMemo(
    () => invoices.filter((i) => i.status === "returned" || i.status === "partially_returned"),
    [invoices]
  );

  async function pick(id: number) {
    setError(null);
    setResult(null);
    try {
      const d = await api.getInvoice(id);
      setDetail(d);
      setSelected(new Set(d.lines.filter((l) => !l.returned).map((l) => l.id)));
      setSettlementMode("store_credit");
      const lotsInScrap = d.old_gold_lots.length > 0 && d.old_gold_lots.every((g) => g.status === "in_scrap");
      setOldGoldAction(lotsInScrap ? "physical" : "cash");
      setOverride(false);
      setDeduction("0");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  const og = detail ? Number(detail.old_gold_value) : 0;
  const sc = detail ? Number(detail.scheme_credit) : 0;
  const adv = detail ? Number(detail.advance_applied) : 0;
  const hasDeductions = og > 0 || sc > 0 || adv > 0;
  const lotsInScrap = !!detail && detail.old_gold_lots.length > 0 && detail.old_gold_lots.every((g) => g.status === "in_scrap");
  const returnableLines = detail?.lines.filter((l) => !l.returned) ?? [];
  const daysSince = detail ? Math.floor((Date.now() - new Date(detail.created_at.slice(0, 10)).getTime()) / 86400000) : 0;

  function toggle(id: number) {
    if (hasDeductions) return; // full return enforced
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function submit() {
    if (!detail || selected.size === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const allReturnable = returnableLines.every((l) => selected.has(l.id)) && selected.size === returnableLines.length;
      const r = await api.returnInvoice(detail.id, {
        line_ids: allReturnable ? undefined : [...selected],
        reason: notes ? `${reasonPreset} — ${notes}` : reasonPreset,
        settlement_mode: settlementMode,
        old_gold_action: og > 0 ? oldGoldAction : undefined,
        deduction: Number(deduction) > 0 ? deduction : undefined,
        override_window: override,
      });
      setResult(r);
      setDetail(null);
      setSelected(new Set());
      setNotes("");
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[1.1fr_1.4fr] gap-4">
      {/* Pick invoice */}
      <Card className="overflow-hidden h-fit">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Pick invoice</h3>
          <Input placeholder="Search no. / customer..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-7 w-44" />
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">No.</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Customer</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Total</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {returnable.slice(0, 14).map((i) => (
              <tr key={i.id} onClick={() => pick(i.id)} className={`border-b border-border last:border-0 cursor-pointer ${detail?.id === i.id ? "bg-primary/10" : "hover:bg-accent"}`}>
                <td className="px-3 py-2 font-mono text-xs">{i.document_no}</td>
                <td className="px-3 py-2">{i.customer_name || "Walk-in"}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(i.grand_total)}</td>
                <td className="px-3 py-2 text-center"><Badge variant={i.status === "final" ? "success" : "warning"}>{i.status.replace(/_/g, " ")}</Badge></td>
              </tr>
            ))}
            {returnable.length === 0 && <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground text-xs">No returnable invoices.</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* Return form */}
      <Card className="p-4 space-y-3 h-fit">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><RotateCcw className="w-4 h-4" /> Process return</h3>
        {!detail ? (
          <p className="text-xs text-muted-foreground py-6 text-center">Select an invoice on the left.</p>
        ) : (
          <>
            <div className="rounded-md bg-muted/40 px-3 py-2 text-sm flex items-center justify-between">
              <div>
                <div className="font-mono font-medium">{detail.document_no}</div>
                <div className="text-muted-foreground text-xs">{detail.customer_name || "Walk-in"} · sold {formatDate(detail.created_at)} · {daysSince}d ago</div>
              </div>
              <Badge variant="secondary">{detail.payment_mode || "—"}</Badge>
            </div>

            {/* Deductions on this bill */}
            {hasDeductions && (
              <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-medium text-warning"><AlertTriangle className="w-3.5 h-3.5" /> This bill used credits — full return only.</div>
                {og > 0 && <div className="flex items-center gap-1.5"><Coins className="w-3 h-3" /> Old gold {formatINR(og)} {lotsInScrap ? "(in scrap — can return the piece)" : "(melted — cash-rate settle)"}</div>}
                {sc > 0 && <div className="flex items-center gap-1.5"><PiggyBank className="w-3 h-3" /> Scheme redemption {formatINR(sc)} → store credit</div>}
                {adv > 0 && <div className="flex items-center gap-1.5"><Wallet className="w-3 h-3" /> Advance applied {formatINR(adv)} → re-credited</div>}
              </div>
            )}

            {/* Lines */}
            <div className="rounded-md border border-border divide-y divide-border">
              {returnableLines.length === 0 && <div className="px-3 py-3 text-xs text-muted-foreground">All lines already returned.</div>}
              {returnableLines.map((l) => (
                <label key={l.id} className={`flex items-center gap-2 px-3 py-2 text-sm ${hasDeductions ? "opacity-90" : "cursor-pointer"}`}>
                  <input type="checkbox" checked={selected.has(l.id)} disabled={hasDeductions} onChange={() => toggle(l.id)} />
                  <span className="flex-1">{l.description}<span className="text-muted-foreground text-xs"> · {l.purity_label} · net {l.net_weight}g</span></span>
                  <span className="font-mono">{formatINR(l.line_total)}</span>
                </label>
              ))}
            </div>

            {/* Old gold action */}
            {og > 0 && (
              <div className="space-y-1">
                <Label>Old gold settlement</Label>
                <div className="flex gap-2">
                  <ModeChip active={oldGoldAction === "physical"} disabled={!lotsInScrap} onClick={() => setOldGoldAction("physical")}>Return piece</ModeChip>
                  <ModeChip active={oldGoldAction === "cash"} onClick={() => setOldGoldAction("cash")}>Cash-rate value</ModeChip>
                </div>
                {!lotsInScrap && <p className="text-[11px] text-muted-foreground">Old gold was melted/used — settling at the cash buy-back rate (premium not refunded).</p>}
              </div>
            )}

            {/* Settlement + reason */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Settle as</Label>
                <div className="flex gap-2">
                  <ModeChip active={settlementMode === "store_credit"} onClick={() => setSettlementMode("store_credit")}>Store credit</ModeChip>
                  <ModeChip active={settlementMode === "refund"} onClick={() => setSettlementMode("refund")}>Refund</ModeChip>
                </div>
                {settlementMode === "refund" && <p className="text-[11px] text-muted-foreground">≤ ₹20,000 cash, else bank transfer.</p>}
              </div>
              <div className="space-y-1">
                <Label>Reason</Label>
                <select value={reasonPreset} onChange={(e) => setReasonPreset(e.target.value)} className="flex h-8 w-full appearance-none rounded-sm border border-input bg-background px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                  {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Notes (optional)</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. clasp broken" />
              </div>
              <div className="space-y-1">
                <Label>Deduction ₹ (optional)</Label>
                <Input value={deduction} onChange={(e) => setDeduction(e.target.value)} className="font-mono" />
              </div>
            </div>

            {daysSince > 7 && (
              <label className="flex items-center gap-2 text-xs text-warning">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Beyond return window — manager override
              </label>
            )}

            <Button onClick={submit} disabled={busy || selected.size === 0}>{busy ? "Processing..." : "Process return"}</Button>
          </>
        )}

        {result && (
          <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success space-y-1">
            <div className="flex items-center gap-2 font-medium"><CheckCircle2 className="w-4 h-4" /> Credit note {result.document_no} — {result.invoice_status.replace(/_/g, " ")}</div>
            <div className="text-xs text-foreground space-y-0.5">
              <div>{result.settlement_mode === "store_credit" ? "Store credit" : `Refund (${result.refund_mode})`}: <b>{formatINR(result.monetary_settlement)}</b></div>
              {Number(result.advance_recredit) > 0 && <div>Advance re-credited: {formatINR(result.advance_recredit)}</div>}
              {Number(result.scheme_credit) > 0 && <div>Scheme → store credit: {formatINR(result.scheme_credit)}</div>}
              {result.old_gold_physical && <div>Old gold piece returned to customer</div>}
              {Number(result.old_gold_cash) > 0 && <div>Old gold cash-rate value: {formatINR(result.old_gold_cash)}</div>}
            </div>
          </div>
        )}
        {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      </Card>

      {/* Recent returns (returned invoices) */}
      {returned.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border text-sm font-medium">Recent returns / Credit notes</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border text-xs">
                <th className="text-left px-3 py-2">Invoice</th>
                <th className="text-left px-3 py-2">Customer</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-right px-3 py-2">Total</th>
                <th className="text-center px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {returned.map((r) => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-accent/50">
                  <td className="px-3 py-1.5 font-mono text-xs">{r.document_no}</td>
                  <td className="px-3 py-1.5 text-xs">{r.customer_name || "Walk-in"}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{formatDate(r.created_at)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatINR(r.grand_total)}</td>
                  <td className="px-3 py-1.5 text-center">
                    <Badge variant="destructive">{r.status.replace(/_/g, " ")}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function ModeChip({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        "px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 " +
        (active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")
      }
    >
      {children}
    </button>
  );
}
