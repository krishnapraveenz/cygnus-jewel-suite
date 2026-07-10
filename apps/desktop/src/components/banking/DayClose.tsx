import { useEffect, useState } from "react";
import { Sunset, Lock, Unlock, Printer, ArrowDownCircle, ArrowUpCircle, Wallet, Boxes, ClipboardCheck } from "lucide-react";
import * as api from "@/api";
import type { DayCloseView, DaySessionRow, Denom } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateField } from "@/components/ui/date-field";
import { confirm } from "@/lib/dialog";
import { StockCount } from "@/components/banking/StockCount";
import { formatINR, formatDate, formatDateTime } from "@/lib/utils";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const INR_DENOMS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const dec = (s: string | null | undefined) => Number(s ?? 0);

/** Denomination counting grid → emits the counted total and the denom breakdown. */
function DenomGrid({ value, onChange, disabled }: { value: Record<number, number>; onChange: (v: Record<number, number>) => void; disabled?: boolean }) {
  const total = INR_DENOMS.reduce((s, d) => s + d * (value[d] || 0), 0);
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/60 text-muted-foreground text-xs">
          <th className="text-right px-3 py-1.5">Denomination</th><th className="text-center px-3 py-1.5">Qty</th><th className="text-right px-3 py-1.5">Amount</th>
        </tr></thead>
        <tbody>
          {INR_DENOMS.map((d) => (
            <tr key={d} className="border-t border-border">
              <td className="px-3 py-1 text-right font-mono">₹{d}</td>
              <td className="px-2 py-1 text-center">
                <input type="number" min={0} disabled={disabled} value={value[d] || ""} placeholder="0"
                  className="h-7 w-20 rounded-sm border border-input bg-background px-2 text-right text-sm disabled:opacity-60"
                  onChange={(e) => onChange({ ...value, [d]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
              </td>
              <td className="px-3 py-1 text-right font-mono text-muted-foreground">{d * (value[d] || 0) ? formatINR(d * (value[d] || 0)) : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="border-t-2 border-border bg-muted/40 font-semibold">
          <td className="px-3 py-1.5 text-right" colSpan={2}>Total counted</td>
          <td className="px-3 py-1.5 text-right font-mono">{formatINR(total)}</td>
        </tr></tfoot>
      </table>
    </div>
  );
}

const toDenoms = (m: Record<number, number>): Denom[] => INR_DENOMS.filter((d) => m[d] > 0).map((d) => ({ denom: d, qty: m[d] }));
const fromDenoms = (arr: Denom[] | null | undefined): Record<number, number> => {
  const m: Record<number, number> = {};
  (arr || []).forEach((d) => { m[d.denom] = d.qty; });
  return m;
};
const denomTotal = (m: Record<number, number>) => INR_DENOMS.reduce((s, d) => s + d * (m[d] || 0), 0);

export function DayClose() {
  const [date, setDate] = useState(iso(new Date()));
  const [tab, setTab] = useState<"cash" | "stock">("cash");
  const [view, setView] = useState<DayCloseView | null>(null);
  const [register, setRegister] = useState<DaySessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // form state
  const [openDenoms, setOpenDenoms] = useState<Record<number, number>>({});
  const [openFloat, setOpenFloat] = useState("");
  const [closeDenoms, setCloseDenoms] = useState<Record<number, number>>({});
  const [notes, setNotes] = useState("");
  const [spotDenoms, setSpotDenoms] = useState<Record<number, number>>({});
  const [spotNote, setSpotNote] = useState("");

  async function load() {
    setError(null);
    try {
      const v = await api.getDayClose(date);
      setView(v);
      setRegister(await api.listDaySessions());
      // seed forms
      setOpenFloat(v.session ? v.session.opening_cash : (v.proposed_opening ?? ""));
      setOpenDenoms(fromDenoms(v.session?.opening_denoms));
      setCloseDenoms(fromDenoms(v.session?.closing_denoms));
      setNotes(v.session?.notes ?? "");
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const session = view?.session ?? null;
  const status = session?.status ?? "none";
  const expected = dec(view?.expected_cash);
  const countedClose = denomTotal(closeDenoms);
  const liveVariance = countedClose - expected;

  async function doOpen() {
    setBusy(true); setError(null);
    try {
      const denoms = toDenoms(openDenoms);
      const opening = denoms.length ? String(denomTotal(openDenoms)) : (openFloat || "0");
      await api.openDay({ business_date: date, opening_cash: opening, opening_denoms: denoms.length ? denoms : undefined });
      await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function doClose() {
    if (!(await confirm({ title: "Close day", message: `Close ${formatDate(date)} with counted cash ${formatINR(countedClose)}? Variance ${formatINR(liveVariance)}.` }))) return;
    setBusy(true); setError(null);
    try {
      await api.closeDay({ business_date: date, counted_cash: String(countedClose), closing_denoms: toDenoms(closeDenoms), notes: notes || undefined });
      await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function doReopen() {
    if (!(await confirm({ title: "Reopen day", message: `Reopen ${formatDate(date)}? You'll be able to re-count and re-close it.` }))) return;
    setBusy(true);
    try { await api.reopenDay(date); await load(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function doTally() {
    const counted = denomTotal(spotDenoms);
    setBusy(true); setError(null);
    try {
      await api.recordCashTally({ business_date: date, counted: String(counted), denoms: toDenoms(spotDenoms), note: spotNote || undefined });
      setSpotDenoms({}); setSpotNote("");
      await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  const VarianceBadge = ({ v }: { v: number }) => {
    if (Math.abs(v) < 0.005) return <span className="rounded-full bg-emerald-500/10 text-emerald-600 px-2 py-0.5 text-sm">Balanced</span>;
    return v < 0
      ? <span className="rounded-full bg-rose-500/10 text-rose-600 px-2 py-0.5 text-sm">Short {formatINR(-v)}</span>
      : <span className="rounded-full bg-amber-500/10 text-amber-600 px-2 py-0.5 text-sm">Excess {formatINR(v)}</span>;
  };

  function printSheet() {
    if (!view) return;
    const denoms = status === "closed" || status === "reopened" ? closeDenoms : openDenoms;
    const rows = INR_DENOMS.filter((d) => denoms[d] > 0).map((d) => `<tr><td style="text-align:right">₹${d}</td><td style="text-align:center">${denoms[d]}</td><td style="text-align:right">${formatINR(d * denoms[d])}</td></tr>`).join("");
    const src = view.by_source.map((s) => `<tr><td>${s.source}</td><td style="text-align:right">${formatINR(s.amount)}</td></tr>`).join("");
    const w = window.open("", "_blank", "width=720,height=900");
    if (!w) return;
    w.document.write(`<html><head><title>Day Close ${formatDate(date)}</title>
      <style>body{font-family:system-ui,sans-serif;padding:24px;color:#111}h2{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{padding:4px 8px;border-bottom:1px solid #ddd;font-size:13px}.tot{font-weight:700}.muted{color:#666;font-size:12px}</style></head><body>
      <h2>Day Close — ${formatDate(date)}</h2>
      <div class="muted">Status: ${status.toUpperCase()} ${session?.closed_at ? "· closed " + formatDateTime(session.closed_at) : ""}</div>
      <h3>Cash</h3>
      <table><tr><td>Opening float</td><td style="text-align:right">${formatINR(view.opening_cash)}</td></tr>
        <tr><td>Cash in</td><td style="text-align:right">${formatINR(view.cash_in)}</td></tr>
        <tr><td>Cash out</td><td style="text-align:right">${formatINR(view.cash_out)}</td></tr>
        <tr class="tot"><td>Expected in drawer</td><td style="text-align:right">${formatINR(view.expected_cash)}</td></tr>
        ${session?.counted_cash ? `<tr class="tot"><td>Counted</td><td style="text-align:right">${formatINR(session.counted_cash)}</td></tr><tr class="tot"><td>Variance</td><td style="text-align:right">${formatINR(session.cash_variance ?? "0")}</td></tr>` : ""}
      </table>
      ${src ? `<h3>Cash by source</h3><table>${src}</table>` : ""}
      ${rows ? `<h3>Denomination count</h3><table><tr><th style="text-align:right">Denom</th><th>Qty</th><th style="text-align:right">Amount</th></tr>${rows}</table>` : ""}
      <p class="muted">Counted by ______________________ &nbsp;&nbsp; Verified by ______________________</p>
      </body></html>`);
    w.document.close(); w.focus(); w.print();
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Sunset className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Day Close</h2>
          <div className="w-40 ml-2"><DateField value={date} onChange={setDate} /></div>
          {status === "closed" && <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs flex items-center gap-1"><Lock className="w-3 h-3" /> Closed</span>}
          {status === "reopened" && <span className="rounded-full bg-amber-500/10 text-amber-600 px-2 py-0.5 text-xs flex items-center gap-1"><Unlock className="w-3 h-3" /> Reopened</span>}
          {status === "open" && <span className="rounded-full bg-emerald-500/10 text-emerald-600 px-2 py-0.5 text-xs">Open</span>}
        </div>
        <div className="flex items-center gap-2">
          {tab === "cash" && session && <Button size="sm" variant="outline" onClick={printSheet}><Printer className="w-3.5 h-3.5 mr-1" /> Print sheet</Button>}
          {status === "closed" && <Button size="sm" variant="outline" onClick={doReopen} disabled={busy}><Unlock className="w-3.5 h-3.5 mr-1" /> Reopen</Button>}
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        <button onClick={() => setTab("cash")} className={"flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px " + (tab === "cash" ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}><Wallet className="w-4 h-4" /> Cash</button>
        <button onClick={() => setTab("stock")} className={"flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px " + (tab === "stock" ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}><Boxes className="w-4 h-4" /> Stock</button>
      </div>

      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}

      {tab === "stock" ? <StockCount date={date} /> : !view ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
          {/* Left: cash flows + expected */}
          <div className="space-y-4">
            <Card className="p-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">Opening float</div>
                  <div className="text-lg font-semibold font-mono">{formatINR(view.opening_cash)}</div>
                </div>
                <div className="rounded-lg bg-emerald-500/5 p-3">
                  <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><ArrowDownCircle className="w-3 h-3 text-emerald-600" /> Cash in</div>
                  <div className="text-lg font-semibold font-mono text-emerald-600">{formatINR(view.cash_in)}</div>
                </div>
                <div className="rounded-lg bg-rose-500/5 p-3">
                  <div className="text-xs text-muted-foreground flex items-center justify-center gap-1"><ArrowUpCircle className="w-3 h-3 text-rose-600" /> Cash out</div>
                  <div className="text-lg font-semibold font-mono text-rose-600">{formatINR(view.cash_out)}</div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between rounded-lg border border-border px-4 py-2">
                <span className="text-sm text-muted-foreground">Expected in drawer</span>
                <span className="text-xl font-bold font-mono">{formatINR(view.expected_cash)}</span>
              </div>
              {view.by_source.length > 0 && (
                <div className="mt-3">
                  <div className="text-xs text-muted-foreground mb-1">Cash movements by source</div>
                  <div className="rounded-lg border border-border divide-y divide-border">
                    {view.by_source.map((s) => (
                      <div key={s.source} className="flex justify-between px-3 py-1.5 text-sm">
                        <span>{s.source}</span>
                        <span className={"font-mono " + (dec(s.amount) < 0 ? "text-rose-600" : "text-emerald-600")}>{formatINR(s.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Spot check — non-locking mid-day tally */}
            {session && (
              <Card className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium flex items-center gap-1.5"><ClipboardCheck className="w-4 h-4" /> Spot check</h3>
                  <span className="text-xs text-muted-foreground">interim count — does not close the day</span>
                </div>
                <details>
                  <summary className="cursor-pointer text-sm text-muted-foreground">Count the drawer now</summary>
                  <div className="mt-2 space-y-2">
                    <DenomGrid value={spotDenoms} onChange={setSpotDenoms} />
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-muted-foreground">Expected now</span><span className="font-mono">{formatINR(expected)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Counted</span><span className="font-mono">{formatINR(denomTotal(spotDenoms))}</span></div>
                      <div className="flex justify-between items-center"><span className="text-muted-foreground">Variance</span><VarianceBadge v={denomTotal(spotDenoms) - expected} /></div>
                    </div>
                    <Input value={spotNote} onChange={(e) => setSpotNote(e.target.value)} placeholder="Note (optional) — e.g. 11am check" />
                    <Button size="sm" variant="outline" className="w-full" onClick={doTally} disabled={busy || denomTotal(spotDenoms) === 0}>Record tally</Button>
                  </div>
                </details>
                {view.tallies.length > 0 && (
                  <div className="rounded-lg border border-border divide-y divide-border text-sm">
                    {view.tallies.map((t, i) => (
                      <div key={i} className="flex items-center justify-between px-3 py-1.5">
                        <span className="text-muted-foreground">{formatDateTime(t.checked_at)}{t.note ? ` · ${t.note}` : ""}</span>
                        <span className="flex items-center gap-2">
                          <span className="font-mono">{formatINR(t.counted)}</span>
                          <VarianceBadge v={dec(t.variance)} />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* Register */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-2 border-b border-border text-sm font-medium">Recent days</div>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0"><tr className="bg-muted/60 text-muted-foreground text-xs">
                    <th className="text-left px-3 py-1.5">Date</th><th className="text-left px-3 py-1.5">Status</th>
                    <th className="text-right px-3 py-1.5">Expected</th><th className="text-right px-3 py-1.5">Counted</th><th className="text-right px-3 py-1.5">Variance</th>
                  </tr></thead>
                  <tbody>
                    {register.map((r) => (
                      <tr key={r.id} className={"border-t border-border cursor-pointer hover:bg-accent/50 " + (r.business_date === date ? "bg-accent/40" : "")} onClick={() => setDate(r.business_date)}>
                        <td className="px-3 py-1.5">{formatDate(r.business_date)}</td>
                        <td className="px-3 py-1.5 capitalize">{r.status}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{r.expected_cash ? formatINR(r.expected_cash) : "—"}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{r.counted_cash ? formatINR(r.counted_cash) : "—"}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{r.cash_variance != null ? formatINR(r.cash_variance) : "—"}</td>
                      </tr>
                    ))}
                    {register.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">No day sessions yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          {/* Right: open / close panel */}
          <div className="space-y-4">
            {status === "none" && (
              <Card className="p-4 space-y-3">
                <h3 className="font-medium">Open the day</h3>
                <p className="text-xs text-muted-foreground">Enter the opening cash float. {view.proposed_opening && `Carried forward: ${formatINR(view.proposed_opening)}.`}</p>
                <div>
                  <Label className="text-xs">Opening float (or count below)</Label>
                  <Input value={openFloat} onChange={(e) => setOpenFloat(e.target.value)} placeholder="0.00" />
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Count denominations (optional)</summary>
                  <div className="mt-2"><DenomGrid value={openDenoms} onChange={setOpenDenoms} /></div>
                </details>
                <Button className="w-full" onClick={doOpen} disabled={busy}>Open day</Button>
              </Card>
            )}

            {(status === "open" || status === "reopened") && (
              <Card className="p-4 space-y-3">
                <h3 className="font-medium">Close the day — count the drawer</h3>
                <DenomGrid value={closeDenoms} onChange={setCloseDenoms} />
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Expected</span><span className="font-mono">{formatINR(expected)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Counted</span><span className="font-mono">{formatINR(countedClose)}</span></div>
                  <div className="flex justify-between items-center"><span className="text-muted-foreground">Variance</span><VarianceBadge v={liveVariance} /></div>
                </div>
                <div>
                  <Label className="text-xs">Notes {Math.abs(liveVariance) >= 0.005 && <span className="text-amber-600">(explain the variance)</span>}</Label>
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. ₹30 short — rounding" />
                </div>
                <Button className="w-full" onClick={doClose} disabled={busy}><Lock className="w-3.5 h-3.5 mr-1" /> Close day</Button>
              </Card>
            )}

            {status === "closed" && session && (
              <Card className="p-4 space-y-3">
                <h3 className="font-medium flex items-center gap-2"><Lock className="w-4 h-4" /> Day closed</h3>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Expected</span><span className="font-mono">{formatINR(session.expected_cash ?? "0")}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Counted</span><span className="font-mono">{formatINR(session.counted_cash ?? "0")}</span></div>
                  <div className="flex justify-between items-center"><span className="text-muted-foreground">Variance</span><VarianceBadge v={dec(session.cash_variance)} /></div>
                  {session.notes && <div className="text-xs text-muted-foreground pt-1">Note: {session.notes}</div>}
                  {session.closed_at && <div className="text-xs text-muted-foreground">Closed {formatDateTime(session.closed_at)}</div>}
                </div>
                <p className="text-xs text-muted-foreground">Variance posts to <b>Cash Short / Over</b> on the next accounts rebuild.</p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
