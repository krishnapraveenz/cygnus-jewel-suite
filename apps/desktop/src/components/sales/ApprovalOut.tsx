import { useEffect, useMemo, useState } from "react";
import { Search, Send, CheckCircle2, PackageCheck } from "lucide-react";
import * as api from "@/api";
import type { Item, Customer, ApprovalRow } from "@/api";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DateField } from "@/components/ui/date-field";
import { formatDate } from "@/lib/utils";

export function ApprovalOut() {
  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [query, setQuery] = useState("");
  const [item, setItem] = useState<Item | null>(null);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [dueBack, setDueBack] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function refresh() {
    const [its, aps] = await Promise.all([api.listItems(), api.listApprovals()]);
    setItems(its.filter((i) => i.ownership_state === "in_stock"));
    setApprovals(aps);
  }
  useEffect(() => {
    refresh().catch((e) => setError(String(e instanceof Error ? e.message : e)));
    api.listCustomers().then(setCustomers).catch(() => {});
  }, []);

  const filtered = useMemo(
    () => items.filter((i) => i.sku.toLowerCase().includes(query.toLowerCase())).slice(0, 8),
    [items, query]
  );
  const open = approvals.filter((a) => a.status === "out");

  async function send() {
    if (!item) return;
    setError(null);
    setOk(null);
    try {
      const r = await api.approvalOut(item.id, {
        customer_id: customerId === "" ? undefined : Number(customerId),
        due_back_at: dueBack || undefined,
      });
      setOk(`Approval slip ${r.slip_no} issued for ${item.sku} — take-home trial, not a sale.`);
      setItem(null);
      setQuery("");
      setDueBack("");
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function back(id: number) {
    try {
      await api.approvalReturn(id);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div className="grid grid-cols-[1fr_1.3fr] gap-4">
      {/* Send on approval */}
      <Card className="p-4 space-y-3 h-fit">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Send className="w-4 h-4" /> Send on approval
        </h3>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input placeholder="Search SKU..." value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
          {query && filtered.length > 0 && !item && (
            <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-lg max-h-56 overflow-y-auto">
              {filtered.map((i) => (
                <button
                  key={i.id}
                  onClick={() => { setItem(i); setQuery(i.sku); }}
                  className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-accent text-left"
                >
                  <span className="font-mono text-xs">{i.sku}</span>
                  <span className="text-muted-foreground text-xs">net {i.net_weight} g</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {item && (
          <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
            <span className="font-mono font-medium">{item.sku}</span>
            <button className="text-xs text-destructive" onClick={() => { setItem(null); setQuery(""); }}>Remove</button>
          </div>
        )}
        <div className="space-y-1">
          <Label>Customer</Label>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : "")}
            className="flex h-8 w-full appearance-none rounded-sm border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">— select —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Return by</Label>
          <DateField value={dueBack} onChange={setDueBack} placeholder="Select return date" />
        </div>
        {ok && (
          <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="w-4 h-4" /> {ok}
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <Button onClick={send} disabled={!item}>Issue approval slip</Button>
      </Card>

      {/* Open approvals */}
      <Card className="overflow-hidden h-fit">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Out on approval</h3>
          <span className="text-xs text-muted-foreground">{open.length} open</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Slip</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Item</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Due back</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {open.map((a) => (
              <tr key={a.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-mono text-xs">{a.slip_no}</td>
                <td className="px-3 py-2 font-mono text-xs">{a.sku ?? `#${a.item_id}`}</td>
                <td className="px-3 py-2">
                  {a.due_back_at ? (
                    <Badge variant="warning">{formatDate(a.due_back_at)}</Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => back(a.id)} title="Mark returned">
                    <PackageCheck className="w-3.5 h-3.5 mr-1" /> Return
                  </Button>
                </td>
              </tr>
            ))}
            {open.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground text-xs">
                  Nothing out on approval.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
