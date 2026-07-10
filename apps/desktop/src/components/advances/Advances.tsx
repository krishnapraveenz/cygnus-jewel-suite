import { useEffect, useMemo, useState } from "react";
import { Wallet, Coins, Scale, CalendarClock, Users } from "lucide-react";
import * as api from "@/api";
import type { AdvanceRow, AdvanceMetrics, Customer, MetalOpt } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DateField } from "@/components/ui/date-field";
import { confirm } from "@/lib/dialog";
import { cn, formatDate, formatINR } from "@/lib/utils";

const MODES = ["cash", "upi", "bank_transfer", "card", "cheque"];
const PERCENTS = [10, 25, 50, 100];
const num = (v: string) => Number(v) || 0;

export function Advances() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [all, setAll] = useState<AdvanceRow[]>([]);
  const [metrics, setMetrics] = useState<AdvanceMetrics | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ balance: string; advances: AdvanceRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"book" | "matured" | "all">("book");

  // Add-advance form
  const [advType, setAdvType] = useState<"amount" | "metal">("amount");
  const [amount, setAmount] = useState("");
  const [metalId, setMetalId] = useState<number | null>(null);
  const [purityId, setPurityId] = useState<number | null>(null);
  const [weight, setWeight] = useState("");
  const [rate, setRate] = useState("");
  const [percent, setPercent] = useState(100);
  const [mode, setMode] = useState("cash");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");

  async function loadAll() {
    try {
      const [cs, adv, m, met] = await Promise.all([api.listCustomers(), api.listAdvances(), api.advanceMetrics(), api.listMetals()]);
      setCustomers(cs);
      setAll(adv);
      setMetrics(m);
      setMetals(met);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    loadAll();
  }, []);

  const purities = metals.find((m) => m.metal_type_id === metalId)?.purities ?? [];
  // Default the rate from the chosen purity's sell rate.
  useEffect(() => {
    const p = purities.find((x) => x.purity_id === purityId);
    if (p?.sell_rate) setRate(p.sell_rate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purityId]);

  const metalAmount = useMemo(() => Math.round(num(weight) * num(rate) * percent / 100 * 100) / 100, [weight, rate, percent]);

  const balances = useMemo(() => {
    const map = new Map<number, { name: string; balance: number }>();
    for (const a of all) {
      const cur = map.get(a.customer_id) ?? { name: a.customer_name || `#${a.customer_id}`, balance: 0 };
      cur.balance += Number(a.balance);
      map.set(a.customer_id, cur);
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v })).filter((x) => x.balance > 0.005).sort((a, b) => b.balance - a.balance);
  }, [all]);

  const matured = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return all.filter((a) => a.status === "active" && a.due_date && a.due_date <= today);
  }, [all]);

  async function openCustomer(id: number) {
    setSelected(id);
    setDetail(null);
    setError(null);
    try {
      setDetail(await api.listCustomerAdvances(id));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function add() {
    if (!selected) return setError("Select a customer");
    if (advType === "amount" && num(amount) <= 0) return setError("Enter an amount");
    if (advType === "metal" && (!metalId || !purityId || num(weight) <= 0)) return setError("Choose metal, purity and weight");
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const body: api.AdvanceCreateReq =
        advType === "metal"
          ? { advance_type: "metal", metal_type_id: metalId!, purity_id: purityId!, booked_weight: weight, rate_locked: rate || undefined, percent: String(percent), payment_mode: mode, due_date: dueDate || undefined, note: note || undefined }
          : { advance_type: "amount", amount, payment_mode: mode, due_date: dueDate || undefined, note: note || undefined };
      const r = await api.recordAdvance(selected, body);
      setOk(`Advance booked · ${formatINR(r.amount)}${advType === "metal" ? ` for ${weight}g @ ${percent}%` : ""}`);
      setAmount(""); setWeight(""); setNote(""); setDueDate("");
      await Promise.all([loadAll(), openCustomer(selected)]);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function closeAdv(a: AdvanceRow) {
    const yes = await confirm({
      title: "Close this advance?",
      message: `Settle advance of ${formatINR(a.balance)}${a.advance_type === "metal" ? ` (${a.booked_weight}g booking)` : ""}. This marks it closed.`,
      confirmText: "Close advance",
    });
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      await api.closeAdvance(a.id);
      setOk(`Advance ${a.advance_no || `#${a.id}`} closed`);
      await Promise.all([loadAll(), selected ? openCustomer(selected) : Promise.resolve()]);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function refundAdv(a: AdvanceRow) {
    const yes = await confirm({
      title: "Refund this advance?",
      message: `Return ${formatINR(a.balance)} to ${a.customer_name || "the customer"}. Refund mode: cash for ≤ ₹20,000, otherwise bank transfer. This closes the advance as refunded.`,
      confirmText: "Refund",
      tone: "danger",
    });
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.closeAdvance(a.id, { refund: true });
      setOk(`Refunded ${formatINR(r.amount)}${r.refund_mode ? ` via ${r.refund_mode.replace("_", " ")}` : ""}`);
      await Promise.all([loadAll(), selected ? openCustomer(selected) : Promise.resolve()]);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Advance</h2>
        <p className="text-sm text-muted-foreground">Customer advances &amp; gold bookings — book by amount or by weight (10/25/50/100%), apply at billing, or close.</p>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      {/* Dashboard */}
      {metrics && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Metric icon={Wallet} label="Active advances" value={String(metrics.active_count)} />
          <Metric icon={Coins} label="Total balance" value={formatINR(metrics.total_balance)} accent="text-success" />
          <Metric icon={Scale} label="Booked gold" value={`${Number(metrics.booked_weight).toFixed(3)} g`} />
          <Metric icon={Users} label="Customers" value={String(metrics.customers_with_balance)} />
          <Metric icon={CalendarClock} label="Due this week" value={String(metrics.due_week_count)} accent={metrics.due_week_count ? "text-amber-600" : undefined} />
        </div>
      )}

      {metrics && metrics.due_week.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 bg-amber-500/10 border-b border-border px-3 py-2 text-sm font-medium">
            <CalendarClock className="w-4 h-4 text-amber-600" /> Due within 7 days
          </div>
          <table className="w-full text-sm">
            <tbody>
              {metrics.due_week.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">{a.customer_name || `#${a.customer_id}`}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{a.advance_type === "metal" ? `${a.booked_weight}g ${a.metal ?? ""}` : "Amount"}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatINR(a.balance)}</td>
                  <td className="px-3 py-1.5 text-right"><Badge variant="warning">{a.due_date ? formatDate(a.due_date) : "—"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Tabs */}
      <div className="inline-flex h-9 items-center gap-1 border-b border-border">
        {([["book", "Book / customer"], ["matured", `Matured${matured.length ? ` (${matured.length})` : ""}`], ["all", "All advances"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-2 text-sm transition-colors",
              view === v ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "book" && (
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        {/* Customers with balance */}
        <Card className="overflow-hidden h-fit">
          <div className="bg-muted/50 border-b border-border px-3 py-2 text-sm font-medium">Customers with balance</div>
          <div className="max-h-[520px] overflow-auto">
            {balances.map((b) => (
              <button key={b.id} onClick={() => openCustomer(b.id)}
                className={cn("flex w-full items-center justify-between px-3 py-2 text-sm border-b border-border last:border-0 hover:bg-accent", selected === b.id && "bg-accent")}>
                <span>{b.name}</span>
                <span className="font-mono text-success">{formatINR(b.balance)}</span>
              </button>
            ))}
            {balances.length === 0 && (
              <div className="px-3 py-10 text-center text-muted-foreground"><Wallet className="w-8 h-8 mx-auto mb-2 opacity-40" /><div className="text-sm">No customers with a balance.</div></div>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          {/* Add advance */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Add advance</div>
              <div className="inline-flex rounded-md border border-border overflow-hidden h-8">
                {(["amount", "metal"] as const).map((t) => (
                  <button key={t} onClick={() => setAdvType(t)} className={cn("px-3 text-sm", advType === t ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground")}>
                    {t === "amount" ? "Amount" : "Gold booking"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Customer</Label>
              <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={selected ?? ""} onChange={(e) => openCustomer(Number(e.target.value))}>
                <option value="">Select a customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
              </select>
            </div>

            {advType === "amount" ? (
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Amount ₹</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></div>
                <div><Label>Due date</Label><DateField value={dueDate} onChange={setDueDate} placeholder="optional" /></div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <Label>Metal</Label>
                    <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={metalId ?? ""} onChange={(e) => { setMetalId(Number(e.target.value)); setPurityId(null); }}>
                      <option value="">—</option>
                      {metals.map((m) => <option key={m.metal_type_id} value={m.metal_type_id}>{m.metal}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label>Purity</Label>
                    <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={purityId ?? ""} onChange={(e) => setPurityId(Number(e.target.value))}>
                      <option value="">—</option>
                      {purities.map((p) => <option key={p.purity_id} value={p.purity_id}>{p.label}</option>)}
                    </select>
                  </div>
                  <div><Label>Weight (g)</Label><Input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" placeholder="100" /></div>
                  <div><Label>Rate ₹/g</Label><Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></div>
                </div>
                <div>
                  <Label>Pay now</Label>
                  <div className="flex items-center gap-2 mt-1">
                    {PERCENTS.map((p) => (
                      <button key={p} onClick={() => setPercent(p)} className={cn("rounded-md border px-3 py-1.5 text-sm transition-colors", percent === p ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-accent/60")}>
                        {p}%
                      </button>
                    ))}
                    <div className="ml-auto text-sm">
                      <span className="text-muted-foreground">Pay now: </span>
                      <span className="font-mono font-semibold">{formatINR(metalAmount)}</span>
                      <span className="text-xs text-muted-foreground"> · {(num(weight) * percent / 100).toFixed(3)}g</span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Due date</Label><DateField value={dueDate} onChange={setDueDate} placeholder="optional" /></div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Mode</Label>
                <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value)}>
                  {MODES.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}
                </select>
              </div>
              <div><Label>Note</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" /></div>
            </div>
            <Button onClick={add} disabled={busy}>Book advance</Button>
          </Card>

          {/* Selected customer ledger */}
          {detail && (
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between bg-muted/50 border-b border-border px-3 py-2 text-sm font-medium">
                <span>{customers.find((c) => c.id === selected)?.name ?? "Customer"} — advances</span>
                <span className="font-mono text-success">Bal {formatINR(detail.balance)}</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-xs">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Advance no.</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Amount</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Balance</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Due</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {detail.advances.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 font-mono text-xs">{a.advance_no || `#${a.id}`}</td>
                      <td className="px-3 py-2 text-muted-foreground text-xs">{formatDate(a.created_at)}</td>
                      <td className="px-3 py-2 text-xs">
                        {a.advance_type === "metal"
                          ? <span>{a.booked_weight}g {a.metal ?? ""} {a.purity ?? ""} <span className="text-muted-foreground">@{a.percent}% · {a.rate_locked ? formatINR(a.rate_locked) : ""}/g</span></span>
                          : <span className="text-muted-foreground">Amount</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{formatINR(a.amount)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatINR(a.balance)}</td>
                      <td className="px-3 py-2 text-xs">{a.due_date ? formatDate(a.due_date) : "—"}</td>
                      <td className="px-3 py-2 text-center"><Badge variant={a.status === "active" ? "success" : "secondary"}>{a.status}</Badge></td>
                      <td className="px-3 py-2 text-right">
                        {a.status === "active" && Number(a.balance) > 0 && (
                          <div className="inline-flex gap-1">
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => closeAdv(a)}>Close</Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => refundAdv(a)}>Refund</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {detail.advances.length === 0 && (
                    <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground text-sm">No advances yet.</td></tr>
                  )}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>
      )}

      {view === "matured" && (
        <div className="space-y-2">
          {matured.length === 0 && (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              <CalendarClock className="w-8 h-8 mx-auto mb-2 opacity-40" /> No matured advances to follow up.
            </Card>
          )}
          {matured.map((a) => (
            <Card key={a.id} className="p-3 flex items-center justify-between">
              <div className="min-w-0">
                <div className="font-medium">
                  {a.customer_name || `#${a.customer_id}`}
                  {a.customer_phone && <span className="ml-2 text-xs text-muted-foreground">{a.customer_phone}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-mono">{a.advance_no || `#${a.id}`}</span> · {a.advance_type === "metal" ? `${a.booked_weight}g ${a.metal ?? ""} @ ${a.percent}%` : "Amount advance"} · matured {a.due_date ? formatDate(a.due_date) : "—"}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="font-mono font-semibold text-success">{formatINR(a.balance)}</div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => closeAdv(a)}>Close</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => refundAdv(a)}>Refund</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {view === "all" && (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border text-xs">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Advance no.</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Customer</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Phone</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Amount</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Booking wt</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Due</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {all.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0 hover:bg-accent">
                  <td className="px-3 py-2 font-mono text-xs">{a.advance_no || `#${a.id}`}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(a.created_at)}</td>
                  <td className="px-3 py-2">{a.customer_name || `#${a.customer_id}`}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{a.customer_phone || "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(a.amount)}</td>
                  <td className="px-3 py-2 text-right font-mono">{a.advance_type === "metal" ? `${Number(a.booked_weight).toFixed(3)} g` : "—"}</td>
                  <td className="px-3 py-2 text-xs">{a.advance_type === "metal" ? `${a.metal ?? ""} ${a.purity ?? ""} @${a.percent}%` : "Amount"}</td>
                  <td className="px-3 py-2 text-xs">{a.due_date ? formatDate(a.due_date) : "—"}</td>
                  <td className="px-3 py-2 text-center"><Badge variant={a.status === "active" ? "success" : "secondary"}>{a.status}</Badge></td>
                  <td className="px-3 py-2 text-right">
                    {a.status === "active" && Number(a.balance) > 0 && (
                      <div className="inline-flex gap-1">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => closeAdv(a)}>Close</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => refundAdv(a)}>Refund</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {all.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-muted-foreground text-sm">No advances yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Metric({ icon: Icon, label, value, accent }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; accent?: string }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", accent)}>{value}</div>
    </Card>
  );
}
