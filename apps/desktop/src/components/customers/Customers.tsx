import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import * as api from "@/api";
import type { AdvanceRow, Customer } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatINR } from "@/lib/utils";

export function Customers() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [advances, setAdvances] = useState<AdvanceRow[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pan, setPan] = useState("");

  async function load() {
    try {
      const [cs, adv] = await Promise.all([api.listCustomers(), api.listAdvances()]);
      setRows(cs);
      setAdvances(adv);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  // Aggregate live advance balance per customer.
  const balanceByCustomer = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of advances) m.set(a.customer_id, (m.get(a.customer_id) ?? 0) + Number(a.balance));
    return m;
  }, [advances]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(
      (c) => c.name.toLowerCase().includes(t) || (c.phone ?? "").includes(t) || (c.pan ?? "").toLowerCase().includes(t),
    );
  }, [rows, q]);

  async function add() {
    if (!name.trim()) return setError("Customer name is required");
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.createCustomer({ name, phone: phone || undefined, pan: pan || undefined });
      setOk(`Added ${name}`);
      setName("");
      setPhone("");
      setPan("");
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Customers</h2>
          <p className="text-sm text-muted-foreground">Directory with contact, PAN (Section 269ST), and advance balance.</p>
        </div>
        <Input className="w-64" placeholder="Search name / phone / PAN…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label>PAN</Label>
            <Input value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} placeholder="optional" />
          </div>
          <Button onClick={add} disabled={busy}>
            {busy ? "Adding…" : "Add customer"}
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Phone</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">PAN</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Advance balance</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const bal = balanceByCustomer.get(c.id) ?? 0;
              return (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent">
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{c.phone || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{c.pan || "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {bal > 0.005 ? <span className="text-success">{formatINR(bal)}</span> : "—"}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-muted-foreground">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">{q ? "No matching customers." : "No customers yet."}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
