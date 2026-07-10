import { useEffect, useMemo, useState } from "react";
import { FileText, X, Printer, Plus } from "lucide-react";
import * as api from "@/api";
import type { InvoiceDetail, InvoiceListRow } from "@/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatINR } from "@/lib/utils";
import { InvoicePreview } from "./InvoicePreview";

const statusBadge: Record<string, "default" | "secondary" | "success" | "destructive" | "warning"> = {
  posted: "success",
  paid: "success",
  credit: "warning",
  returned: "destructive",
  partially_returned: "warning",
};

export function Invoices({ reloadKey, embedded, onNew }: { reloadKey?: number; embedded?: boolean; onNew?: () => void } = {}) {
  const [rows, setRows] = useState<InvoiceListRow[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [printDoc, setPrintDoc] = useState<InvoiceDetail | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);

  useEffect(() => {
    api.listInvoices().then(setRows).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [reloadKey]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(
      (r) => (r.document_no ?? "").toLowerCase().includes(t) || (r.customer_name ?? "").toLowerCase().includes(t),
    );
  }, [rows, q]);

  async function open(id: number) {
    setLoadingId(id);
    setError(null);
    try {
      setDetail(await api.getInvoice(id));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {embedded ? <div /> : (
          <div>
            <h2 className="text-xl font-semibold">Invoices</h2>
            <p className="text-sm text-muted-foreground">Posted sales invoices — open to view lines, deductions and payment split.</p>
          </div>
        )}
        <div className="flex items-center gap-2">
          {onNew && (
            <Button size="sm" onClick={onNew} title="New invoice">
              <Plus className="w-4 h-4 mr-1" /> New Invoice
            </Button>
          )}
          <Input className="w-64" placeholder="Search invoice no. / customer…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Invoice no.</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Customer</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Grand total</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Payable</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2 font-mono text-xs">{r.document_no || `#${r.id}`}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs">{formatDate(r.created_at)}</td>
                <td className="px-3 py-2">{r.customer_name || "Walk-in"}</td>
                <td className="px-3 py-2 capitalize text-xs">{r.invoice_type}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(r.grand_total)}</td>
                <td className="px-3 py-2 text-right font-mono">{r.amount_payable ? formatINR(r.amount_payable) : "—"}</td>
                <td className="px-3 py-2 text-center">
                  <Badge variant={statusBadge[r.status] || "secondary"}>{r.status.replace("_", " ")}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="outline" disabled={loadingId === r.id} onClick={() => open(r.id)}>
                    View
                  </Button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">{q ? "No matching invoices." : "No invoices yet."}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {detail && <InvoiceDetailModal d={detail} onClose={() => setDetail(null)} onPrint={() => setPrintDoc(detail)} />}
      {printDoc && (
        <InvoicePreview
          doc={printDoc}
          kind={printDoc.type === "credit_note" ? "credit_note" : "invoice"}
          onClose={() => setPrintDoc(null)}
        />
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between py-1", strong && "font-semibold border-t border-border mt-1 pt-2")}>
      <span className={cn(!strong && "text-muted-foreground")}>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

function InvoiceDetailModal({ d, onClose, onPrint }: { d: InvoiceDetail; onClose: () => void; onPrint: () => void }) {
  const ded = Number(d.old_gold_value) + Number(d.scheme_credit) + Number(d.advance_applied);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-3xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3 sticky top-0 bg-card">
          <div>
            <div className="font-semibold">{d.document_no || `Invoice #${d.id}`}</div>
            <div className="text-xs text-muted-foreground">
              {formatDate(d.created_at)} · {d.customer_name || "Walk-in"} · {d.status.replace("_", " ")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onPrint}>
              <Printer className="w-3.5 h-3.5 mr-1" /> Print (A4)
            </Button>
            <button onClick={onClose} className="rounded-md p-1 hover:bg-accent">
            <X className="w-4 h-4" />
          </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Item</th>
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Purity</th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Net wt</th>
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Making</th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Rate</th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Taxable</th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Total</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.id} className={cn("border-b border-border last:border-0", l.returned && "opacity-50 line-through")}>
                  <td className="px-2 py-1.5">
                    {l.description || "—"}
                    {l.huid ? <span className="ml-1 text-xs text-muted-foreground font-mono">HUID {l.huid}</span> : ""}
                  </td>
                  <td className="px-2 py-1.5">{l.purity_label || "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{l.net_weight ? Number(l.net_weight).toFixed(3) : "—"}</td>
                  <td className="px-2 py-1.5 text-xs">{l.making_label || "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatINR(l.rate_used)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatINR(l.taxable_value)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatINR(l.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="text-sm">
              {d.tenders.length > 0 && (
                <>
                  <div className="font-medium mb-1">Payment split</div>
                  {d.tenders.map((t, i) => (
                    <div key={i} className="flex justify-between py-0.5 text-muted-foreground">
                      <span className="capitalize">
                        {t.mode.replace("_", " ")}
                        {t.reference ? ` · ${t.reference}` : ""}
                      </span>
                      <span className="font-mono">{formatINR(t.amount)}</span>
                    </div>
                  ))}
                </>
              )}
              {d.old_gold_lots.length > 0 && (
                <div className="mt-3">
                  <div className="font-medium mb-1">Old jewellery</div>
                  {d.old_gold_lots.map((o) => (
                    <div key={o.id} className="flex justify-between py-0.5 text-muted-foreground">
                      <span>
                        {o.metal}
                        {o.purity ? ` ${o.purity}` : ""} · {Number(o.gross_weight).toFixed(3)}g
                      </span>
                      <span className="font-mono">{formatINR(o.value)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="text-sm">
              <Row label="Subtotal" value={formatINR(d.subtotal)} />
              {Number(d.discount_total) > 0 && <Row label="Discount" value={`− ${formatINR(d.discount_total)}`} />}
              <Row label="GST" value={formatINR(d.tax_total)} />
              <Row label="Grand total" value={formatINR(d.grand_total)} strong />
              {Number(d.old_gold_value) > 0 && <Row label="Less: old jewellery" value={`− ${formatINR(d.old_gold_value)}`} />}
              {Number(d.scheme_credit) > 0 && <Row label="Less: scheme credit" value={`− ${formatINR(d.scheme_credit)}`} />}
              {Number(d.advance_applied) > 0 && <Row label="Less: advance" value={`− ${formatINR(d.advance_applied)}`} />}
              {ded > 0 && <Row label="Net payable" value={formatINR(d.amount_payable ?? d.grand_total)} strong />}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
