import { useEffect, useMemo, useState } from "react";
import { PiggyBank, Receipt } from "lucide-react";
import * as api from "@/api";
import type { Customer, MetalOpt, SchemeRow, SchemeDetail } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn, formatINR } from "@/lib/utils";
import { confirm } from "@/lib/dialog";
import { SchemeReceipt } from "@/components/schemes/SchemeReceipt";

const PAY_MODES: [string, string][] = [
  ["cash", "Cash"], ["upi", "UPI"], ["bank", "Bank transfer"], ["card", "Card"], ["cheque", "Cheque"],
];

const FILTERS = ["all", "active", "matured", "closed"] as const;
const statusBadge: Record<string, "default" | "secondary" | "success" | "warning"> = {
  active: "default",
  matured: "success",
  closed: "secondary",
};

export function Schemes() {
  const [rows, setRows] = useState<SchemeRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "new" | null>(null);

  // New scheme form
  const [custId, setCustId] = useState<number | null>(null);
  const [monthly, setMonthly] = useState("");
  const [installments, setInstallments] = useState("11");
  const [schemeType, setSchemeType] = useState<"value" | "gram">("value");
  const [metalId, setMetalId] = useState<number | null>(null);
  const [purityId, setPurityId] = useState<number | null>(null);

  async function load() {
    try {
      const [sc, cs, m] = await Promise.all([
        api.listSchemes(filter === "all" ? undefined : filter),
        api.listCustomers(),
        api.listMetals(),
      ]);
      setRows(sc);
      setCustomers(cs);
      setMetals(m);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, [filter]);

  const custName = useMemo(() => {
    const m = new Map(customers.map((c) => [c.id, c.name]));
    return (id: number | null) => (id ? m.get(id) ?? `#${id}` : "—");
  }, [customers]);
  const purities = metals.find((m) => m.metal_type_id === metalId)?.purities ?? [];

  async function create() {
    if (!monthly || Number(monthly) <= 0) return setError("Enter a monthly amount");
    if (schemeType === "gram" && (!metalId || !purityId)) return setError("Gram schemes need metal and purity");
    setBusy("new");
    setError(null);
    setOk(null);
    try {
      const r = await api.createScheme({
        customer_id: custId ?? undefined,
        monthly_amount: monthly,
        installments_required: Number(installments) || 11,
        scheme_type: schemeType,
        metal_type_id: schemeType === "gram" ? metalId! : undefined,
        purity_id: schemeType === "gram" ? purityId! : undefined,
      });
      setOk(`Opened ${r.scheme_no}`);
      setMonthly("");
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  // Collect dialog + receipt
  const [collect, setCollect] = useState<SchemeRow | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMode, setPayMode] = useState("cash");
  const [payRef, setPayRef] = useState("");
  const [receipt, setReceipt] = useState<{ detail: SchemeDetail; seq?: number } | null>(null);

  function openCollect(r: SchemeRow) {
    setCollect(r);
    setPayAmount(r.monthly_amount);
    setPayMode("cash");
    setPayRef("");
    setError(null);
    setOk(null);
  }

  async function confirmPay() {
    if (!collect) return;
    const id = collect.id;
    setBusy(id);
    setError(null);
    setOk(null);
    try {
      const r = await api.schemePay(id, { amount: payAmount || undefined, payment_mode: payMode, reference: payRef || undefined });
      const detail = await api.getScheme(id);
      setReceipt({ detail, seq: r.installment });
      setOk(`Installment ${r.installment} collected${r.status === "matured" ? " — scheme matured" : ""}`);
      setCollect(null);
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  async function openReceipt(id: number) {
    try {
      setReceipt({ detail: await api.getScheme(id) });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function close(r: SchemeRow) {
    const early = r.status === "active";
    const yes = await confirm({
      title: early ? "Close scheme early?" : "Close / redeem scheme?",
      message: early
        ? `Pre-mature closure of ${r.scheme_no || `#${r.id}`}. The bonus is not applicable — redeem only the amount paid so far (${formatINR(r.total_paid)}).`
        : `Redeem matured scheme ${r.scheme_no || `#${r.id}`} toward a purchase.`,
      confirmText: early ? "Close early" : "Close / Redeem",
      tone: early ? "danger" : "info",
    });
    if (!yes) return;
    setBusy(r.id);
    setError(null);
    setOk(null);
    try {
      const res = await api.schemeClose(r.id);
      setOk(res.redeemable_value ? `Closed — redeemable ${formatINR(res.redeemable_value)}` : `Closed — ${res.redeemable_grams}g redeemable`);
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Savings Schemes</h2>
        <p className="text-sm text-muted-foreground">Monthly gold-savings plans (value 11+1 or gram rate-averaging), collection and redemption.</p>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      {/* New scheme */}
      <Card className="p-4">
        <div className="text-sm font-medium mb-3">Open a new scheme</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <div>
            <Label>Customer</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={custId ?? ""} onChange={(e) => setCustId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Walk-in</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Type</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={schemeType} onChange={(e) => setSchemeType(e.target.value as "value" | "gram")}>
              <option value="value">Value (11+1)</option>
              <option value="gram">Gram (rate avg)</option>
            </select>
          </div>
          <div>
            <Label>Monthly ₹</Label>
            <Input value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <Label>Installments</Label>
            <Input value={installments} onChange={(e) => setInstallments(e.target.value)} inputMode="numeric" />
          </div>
          {schemeType === "gram" && (
            <>
              <div>
                <Label>Metal</Label>
                <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={metalId ?? ""} onChange={(e) => { setMetalId(Number(e.target.value)); setPurityId(null); }}>
                  <option value="">—</option>
                  {metals.map((m) => (
                    <option key={m.metal_type_id} value={m.metal_type_id}>
                      {m.metal}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Purity</Label>
                <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={purityId ?? ""} onChange={(e) => setPurityId(Number(e.target.value))}>
                  <option value="">—</option>
                  {purities.map((p) => (
                    <option key={p.purity_id} value={p.purity_id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <Button onClick={create} disabled={busy === "new"}>
            Open scheme
          </Button>
        </div>
      </Card>

      <div className="inline-flex h-9 items-center gap-0.5 border-b border-border">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "inline-flex items-center px-3 py-2 text-sm capitalize transition-colors",
              filter === f ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Scheme no.</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Customer</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Monthly</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Installments</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Paid</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Maturity</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2 font-mono text-xs">{r.scheme_no || `#${r.id}`}</td>
                <td className="px-3 py-2">{custName(r.customer_id)}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.monthly_amount)}</td>
                <td className="px-3 py-2 text-right font-mono">{r.installments_required}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.total_paid)}</td>
                <td className="px-3 py-2 text-right font-mono">{r.maturity_value ? formatINR(r.maturity_value) : "—"}</td>
                <td className="px-3 py-2 text-center">
                  <Badge variant={statusBadge[r.status] || "secondary"}>{r.status}</Badge>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {r.status === "active" && (
                    <>
                      <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => openCollect(r)}>
                        Collect
                      </Button>
                      <Button size="sm" variant="ghost" className="ml-1 text-muted-foreground" disabled={busy === r.id} onClick={() => close(r)}>
                        Close early
                      </Button>
                    </>
                  )}
                  {r.status === "matured" && (
                    <Button size="sm" variant="ghost" className="text-success" disabled={busy === r.id} onClick={() => close(r)}>
                      Close / Redeem
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="ml-1" title="Receipt / passbook" onClick={() => openReceipt(r.id)}>
                    <Receipt className="w-3.5 h-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  <PiggyBank className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No schemes{filter !== "all" ? ` (${filter})` : ""}.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {/* Collect installment dialog */}
      {collect && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCollect(null)}>
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-border px-4 py-2.5 text-sm font-medium">
              Collect installment · {collect.scheme_no || `#${collect.id}`}
            </div>
            <div className="p-4 space-y-3">
              <div>
                <Label>Amount ₹</Label>
                <Input value={payAmount} onChange={(e) => setPayAmount(e.target.value)} inputMode="decimal" />
              </div>
              <div>
                <Label>Payment mode</Label>
                <div className="grid grid-cols-3 gap-1.5 mt-1">
                  {PAY_MODES.map(([v, l]) => (
                    <button
                      key={v}
                      onClick={() => setPayMode(v)}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-xs transition-colors",
                        payMode === v ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-accent/60",
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {payMode !== "cash" && (
                <div>
                  <Label>Reference</Label>
                  <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="UPI ref / UTR / cheque no." />
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => setCollect(null)}>Cancel</Button>
                <Button onClick={confirmPay} disabled={busy === collect.id}>Collect &amp; print</Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {receipt && <SchemeReceipt detail={receipt.detail} seq={receipt.seq} onClose={() => setReceipt(null)} />}
    </div>
  );
}
