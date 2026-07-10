import { useEffect, useMemo, useState } from "react";
import { Scissors } from "lucide-react";
import * as api from "@/api";
import type { PartyListRow, RateCutRow } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatDate, formatINR } from "@/lib/utils";

const num = (v: string) => Number(v) || 0;

export function RateCutting() {
  const [parties, setParties] = useState<PartyListRow[]>([]);
  const [cuts, setCuts] = useState<RateCutRow[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [grams, setGrams] = useState("");
  const [rate, setRate] = useState("");
  const [dir, setDir] = useState<"auto" | "we_owe" | "they_owe">("auto");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [ps, cs] = await Promise.all([api.listParties(), api.listRateCuts()]);
      setParties(ps);
      setCuts(cs);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  // Rate cutting is B2B-only — wholesale customers and suppliers, not retail (B2C).
  const b2bParties = useMemo(
    () => parties.filter((p) => p.roles.some((r) => r === "wholesale" || r === "supplier")),
    [parties],
  );
  // Parties carrying an unfixed metal (fine-gram) balance.
  const openMetal = useMemo(
    () => b2bParties.filter((p) => Math.abs(num(p.metal_balance)) > 0.0005),
    [b2bParties],
  );
  const selParty = parties.find((p) => p.id === sel);
  const selBal = selParty ? num(selParty.metal_balance) : 0;
  const effDir = dir !== "auto" ? dir : selBal < 0 ? "we_owe" : "they_owe";
  const amount = Math.round(num(grams) * num(rate) * 100) / 100;

  async function cut() {
    if (!sel) return setError("Select a party");
    if (num(grams) <= 0 || num(rate) <= 0) return setError("Enter grams and rate");
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await api.createRateCut({
        party_id: sel,
        grams,
        rate,
        direction: dir === "auto" ? undefined : dir,
        note: note || undefined,
      });
      setOk(`${r.document_no}: cut ${r.grams}g @ ${formatINR(r.rate)}/g = ${formatINR(r.amount)} (${r.direction === "we_owe" ? "we owe" : "they owe"})`);
      setGrams("");
      setNote("");
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Rate Cutting</h2>
        <p className="text-sm text-muted-foreground">
          Fix an unfixed metal position into money — convert a party's fine-gram balance to rupees at a chosen bullion rate. Works for suppliers (we owe) and B2B customers (they owe); partial cuts allowed.
        </p>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        {/* Parties with open fine-gram balance */}
        <Card className="overflow-hidden h-fit">
          <div className="bg-muted/50 border-b border-border px-3 py-2 text-sm font-medium">Open metal balances (fine g)</div>
          <div className="max-h-[520px] overflow-auto">
            {openMetal.map((p) => {
              const b = num(p.metal_balance);
              return (
                <button
                  key={p.id}
                  onClick={() => setSel(p.id)}
                  className={cn("flex w-full items-center justify-between px-3 py-2 text-sm border-b border-border last:border-0 hover:bg-accent", sel === p.id && "bg-accent")}
                >
                  <span className="min-w-0 truncate">{p.display_name}</span>
                  <span className={cn("font-mono shrink-0", b < 0 ? "text-destructive" : "text-success")}>
                    {b > 0 ? "+" : ""}{b.toFixed(3)} g
                  </span>
                </button>
              );
            })}
            {openMetal.length === 0 && (
              <div className="px-3 py-10 text-center text-muted-foreground">
                <Scissors className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <div className="text-sm">No open metal balances.</div>
                <div className="text-xs mt-1">Unfixed bills post fine grams here to be cut.</div>
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-4 space-y-3">
            <div className="text-sm font-medium">New rate cut</div>
            <div>
              <Label>Party</Label>
              <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={sel ?? ""} onChange={(e) => setSel(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Select a party…</option>
                {b2bParties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                    {Math.abs(num(p.metal_balance)) > 0.0005 ? ` · ${num(p.metal_balance).toFixed(3)}g` : ""}
                  </option>
                ))}
              </select>
              {selParty && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Current: {Math.abs(selBal).toFixed(3)} g {selBal < 0 ? "we owe" : "they owe"} · money {formatINR(selParty.cash_balance)}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><Label>Grams to fix</Label><Input value={grams} onChange={(e) => setGrams(e.target.value)} inputMode="decimal" placeholder={selParty ? Math.abs(selBal).toFixed(3) : ""} /></div>
              <div><Label>Bullion rate ₹/g</Label><Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></div>
              <div>
                <Label>Direction</Label>
                <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={dir} onChange={(e) => setDir(e.target.value as "auto" | "we_owe" | "they_owe")}>
                  <option value="auto">Auto ({effDir === "we_owe" ? "we owe" : "they owe"})</option>
                  <option value="they_owe">They owe us</option>
                  <option value="we_owe">We owe them</option>
                </select>
              </div>
              <div><Label>Note</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" /></div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <span className="text-muted-foreground">Amount fixed: </span>
                <span className="font-mono font-semibold">{formatINR(amount)}</span>
                <span className="text-xs text-muted-foreground"> · {effDir === "we_owe" ? "increases what we owe" : "increases what they owe us"}</span>
              </div>
              <Button onClick={cut} disabled={busy}><Scissors className="w-4 h-4 mr-1.5" /> Cut rate</Button>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="bg-muted/50 border-b border-border px-3 py-2 text-sm font-medium">Recent rate cuts</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border text-xs">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">No.</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Party</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Grams</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Rate</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Amount</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Dir</th>
                </tr>
              </thead>
              <tbody>
                {cuts.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{c.document_no || `#${c.id}`}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(c.created_at)}</td>
                    <td className="px-3 py-2">{c.party_name || "—"}</td>
                    <td className="px-3 py-2 text-right font-mono">{Number(c.grams).toFixed(3)}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatINR(c.rate)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{formatINR(c.amount)}</td>
                    <td className="px-3 py-2 text-xs">{c.direction === "we_owe" ? "we owe" : "they owe"}</td>
                  </tr>
                ))}
                {cuts.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground text-sm">No rate cuts yet.</td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </div>
  );
}
