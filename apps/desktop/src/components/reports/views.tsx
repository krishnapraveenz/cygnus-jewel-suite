import type {
  RegisterReport, GstNet, DayBookRow, StockAgeing, GrossProfit,
  PaymentModeRow, MetalAccountRow, StockOverview, LedgerRow, ComplianceReturn,
  ComplianceOverview, CashBankBook, CashBook,
} from "@/api";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatINR, formatDate, formatDateTime } from "@/lib/utils";

/** Discriminated result of any report — lets the hub render + export generically. */
export type ReportResult =
  | { kind: "register"; reg: RegisterReport; money: string[] }
  | { kind: "gst"; gst: GstNet }
  | { kind: "profit"; p: GrossProfit }
  | { kind: "ageing"; a: StockAgeing }
  | { kind: "daybook"; rows: DayBookRow[] }
  | { kind: "payment"; rows: PaymentModeRow[] }
  | { kind: "metal"; rows: MetalAccountRow[] }
  | { kind: "overview"; o: StockOverview }
  | { kind: "ledger"; rows: LedgerRow[] }
  | { kind: "compliance"; c: ComplianceReturn }
  | { kind: "compliance_overview"; co: ComplianceOverview }
  | { kind: "cashbank"; cb: CashBankBook }
  | { kind: "cashbook"; ck: CashBook };

/** Renders any ReportResult. */
export function ReportResultView({ r }: { r: ReportResult }) {
  switch (r.kind) {
    case "register": return <RegisterView reg={r.reg} money={r.money} />;
    case "gst": return <GstView gst={r.gst} />;
    case "profit": return <ProfitView p={r.p} />;
    case "ageing": return <AgeingView a={r.a} />;
    case "daybook": return <DayBookView rows={r.rows} />;
    case "payment": return <PaymentModesView rows={r.rows} />;
    case "metal": return <MetalAccountView rows={r.rows} />;
    case "overview": return <StockOverviewView o={r.o} />;
    case "ledger": return <LedgerView rows={r.rows} />;
    case "compliance": return <ComplianceView c={r.c} />;
    case "compliance_overview": return <ComplianceOverviewView co={r.co} />;
    case "cashbank": return <CashBankView cb={r.cb} />;
    case "cashbook": return <CashBookView ck={r.ck} />;
  }
}

/** Build CSV text for any ReportResult, or null if nothing to export. */
export function csvFor(r: ReportResult): string | null {
  const build = (head: string[], rows: (string | number | null)[][]) =>
    [head.join(","), ...rows.map((row) => row.map((c) => `"${c ?? ""}"`).join(","))].join("\n");
  switch (r.kind) {
    case "register": {
      const head = Object.keys(r.reg.rows[0] ?? {});
      if (!head.length) return null;
      return build(head, r.reg.rows.map((row) => head.map((h) => row[h] ?? "")));
    }
    case "daybook":
      return build(["at", "subject", "event", "amount_delta", "weight_delta", "ref_doc_type", "ref_doc_id"],
        r.rows.map((x) => [x.at, x.subject, x.event, x.amount_delta, x.weight_delta, x.ref_doc_type, x.ref_doc_id]));
    case "payment":
      return build(["mode", "count", "total"], r.rows.map((x) => [x.mode, x.count, x.total]));
    case "metal":
      return build(["metal", "scrap_taken_in_fine", "scrap_on_hand_fine", "refined_pool_fine", "smith_holding_fine", "wastage_fine"],
        r.rows.map((x) => [x.metal, x.scrap_taken_in_fine, x.scrap_on_hand_fine, x.refined_pool_fine, x.smith_holding_fine, x.wastage_fine]));
    case "ledger":
      return build(["id", "occurred_at", "subject_type", "subject_id", "event_type", "amount_delta", "ref_doc_type", "ref_doc_id"],
        r.rows.map((x) => [x.id, x.occurred_at, x.subject_type, x.subject_id, x.event_type, x.amount_delta, x.ref_doc_type, x.ref_doc_id]));
    case "gst":
      return build(["output_taxable", "output_tax", "input_taxable", "input_tax", "net_payable"],
        [[r.gst.output_taxable, r.gst.output_tax, r.gst.input_taxable, r.gst.input_tax, r.gst.net_payable]]);
    case "profit":
      return build(["document_no", "sku", "revenue", "cost", "profit"],
        r.p.rows.map((x) => [x.document_no, x.sku, x.revenue, x.cost, x.profit]));
    default:
      return null;
  }
}

export function RegisterView({ reg, money }: { reg: RegisterReport; money: string[] }) {
  const cols = Object.keys(reg.rows[0] ?? {});
  if (cols.length === 0) return <Card className="p-10 text-center text-sm text-muted-foreground">No data for this selection.</Card>;
  const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
  const cell = (c: string, v: string | number | null) =>
    money.includes(c) ? formatINR(v ?? "0") : isDate(v) ? formatDateTime(v) : (v ?? "—");
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
          {cols.map((c) => <th key={c} className={`px-3 py-2 font-medium ${money.includes(c) ? "text-right" : "text-left"}`}>{c.replace(/_/g, " ")}</th>)}
        </tr></thead>
        <tbody>
          {reg.rows.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {cols.map((c) => <td key={c} className={`px-3 py-1.5 ${money.includes(c) ? "text-right font-mono" : ""}`}>{cell(c, row[c])}</td>)}
            </tr>
          ))}
        </tbody>
        {reg.totals && (
          <tfoot><tr className="border-t border-border bg-muted/40 font-medium">
            {cols.map((c, idx) => <td key={c} className={`px-3 py-2 ${money.includes(c) ? "text-right font-mono" : ""}`}>{idx === 0 ? "Total" : reg.totals[c] != null ? formatINR(reg.totals[c]) : ""}</td>)}
          </tr></tfoot>
        )}
      </table>
    </div>
  );
}

export function GstView({ gst }: { gst: GstNet }) {
  const net = Number(gst.net_payable);
  return (
    <div className="grid grid-cols-2 gap-4 max-w-2xl">
      <Card className="p-4">
        <div className="text-sm font-medium mb-2">Output tax (sales)</div>
        <div className="flex justify-between text-sm py-1"><span className="text-muted-foreground">Taxable</span><span className="font-mono">{formatINR(gst.output_taxable)}</span></div>
        <div className="flex justify-between text-sm py-1"><span className="text-muted-foreground">GST</span><span className="font-mono">{formatINR(gst.output_tax)}</span></div>
      </Card>
      <Card className="p-4">
        <div className="text-sm font-medium mb-2">Input tax credit (B2B purchases)</div>
        <div className="flex justify-between text-sm py-1"><span className="text-muted-foreground">Taxable</span><span className="font-mono">{formatINR(gst.input_taxable)}</span></div>
        <div className="flex justify-between text-sm py-1"><span className="text-muted-foreground">GST</span><span className="font-mono">{formatINR(gst.input_tax)}</span></div>
      </Card>
      <Card className="p-4 col-span-2">
        <div className="flex justify-between items-center">
          <span className="font-medium">{net >= 0 ? "Net GST payable" : "Net ITC carried forward"}</span>
          <span className={`text-lg font-mono font-semibold ${net >= 0 ? "" : "text-emerald-600"}`}>{formatINR(Math.abs(net))}</span>
        </div>
      </Card>
    </div>
  );
}

export function ProfitView({ p }: { p: GrossProfit }) {
  const cov = Number(p.coverage_pct);
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-400/50 bg-amber-50/50 dark:bg-amber-500/5 px-3 py-2 text-sm">
        Margin is computed only on <b>cost-tracked</b> sales ({p.costed_lines} line{p.costed_lines !== 1 ? "s" : ""} · {cov}% of revenue).
        The remaining {formatINR(p.uncosted_revenue)} of sales are loose/manual lines with no recorded cost and are excluded — so this margin is accurate, not inflated.
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3"><div className="text-xs text-muted-foreground">Cost-tracked revenue</div><div className="text-lg font-semibold">{formatINR(p.costed_revenue)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">COGS</div><div className="text-lg font-semibold">{formatINR(p.cogs)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Gross profit</div><div className="text-lg font-semibold text-emerald-600">{formatINR(p.gross_profit)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Margin</div><div className="text-lg font-semibold">{p.margin_pct}%</div></Card>
      </div>
      {p.rows.length > 0 && (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium">Invoice</th>
              <th className="text-left px-3 py-2 font-medium">Barcode</th>
              <th className="text-right px-3 py-2 font-medium">Revenue</th>
              <th className="text-right px-3 py-2 font-medium">Cost</th>
              <th className="text-right px-3 py-2 font-medium">Profit</th>
            </tr></thead>
            <tbody>
              {p.rows.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">{row.document_no}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{row.sku}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatINR(row.revenue)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatINR(row.cost)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-emerald-600">{formatINR(row.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.rows.length === 0 && <Card className="p-8 text-center text-sm text-muted-foreground">No cost-tracked sales in this period. Sell purchased (barcoded) stock to see margins here.</Card>}
    </div>
  );
}

export function AgeingView({ a }: { a: StockAgeing }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {a.buckets.map((b) => (
          <Card key={b.bucket} className={`p-3 ${b.bucket === "over 1 year" ? "border-rose-400/50" : b.bucket === "181-365 days" ? "border-amber-400/50" : ""}`}>
            <div className="text-xs text-muted-foreground">{b.bucket}</div>
            <div className="text-lg font-semibold">{formatINR(b.value)}</div>
            <div className="text-xs text-muted-foreground">{b.pieces} pcs · {Number(b.net_weight).toFixed(1)} g</div>
          </Card>
        ))}
        {a.buckets.length === 0 && <div className="text-sm text-muted-foreground">No stock.</div>}
      </div>
      <div>
        <div className="text-sm font-medium mb-2">Slow movers (held over 180 days)</div>
        {a.slow_movers.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">Nothing over 180 days — stock is fresh.</Card>
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
                <th className="text-left px-3 py-2 font-medium">Barcode</th>
                <th className="text-left px-3 py-2 font-medium">Purity</th>
                <th className="text-left px-3 py-2 font-medium">Received</th>
                <th className="text-right px-3 py-2 font-medium">Days held</th>
                <th className="text-right px-3 py-2 font-medium">Net wt</th>
                <th className="text-right px-3 py-2 font-medium">Value</th>
              </tr></thead>
              <tbody>
                {a.slow_movers.map((row) => (
                  <tr key={row.sku} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 font-mono text-xs">{row.sku}</td>
                    <td className="px-3 py-1.5">{row.purity ?? "—"}</td>
                    <td className="px-3 py-1.5">{formatDate(row.received)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{row.days}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{Number(row.net_weight).toFixed(3)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatINR(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function DayBookView({ rows }: { rows: DayBookRow[] }) {
  if (rows.length === 0) return <Card className="p-10 text-center text-sm text-muted-foreground">No entries for this day.</Card>;
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
          <th className="text-left px-3 py-2 font-medium">Time</th>
          <th className="text-left px-3 py-2 font-medium">Subject</th>
          <th className="text-left px-3 py-2 font-medium">Event</th>
          <th className="text-left px-3 py-2 font-medium">Ref</th>
          <th className="text-right px-3 py-2 font-medium">Amount</th>
          <th className="text-right px-3 py-2 font-medium">Weight</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 whitespace-nowrap">{formatDateTime(r.at)}</td>
              <td className="px-3 py-1.5 capitalize">{r.subject}</td>
              <td className="px-3 py-1.5">{r.event.replace(/_/g, " ")}</td>
              <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.ref_doc_type ? `${r.ref_doc_type} #${r.ref_doc_id}` : "—"}</td>
              <td className={`px-3 py-1.5 text-right font-mono ${Number(r.amount_delta) < 0 ? "text-red-600" : ""}`}>{Number(r.amount_delta) !== 0 ? formatINR(r.amount_delta) : "—"}</td>
              <td className="px-3 py-1.5 text-right font-mono">{Number(r.weight_delta) !== 0 ? `${Number(r.weight_delta).toFixed(3)} g` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PaymentModesView({ rows }: { rows: PaymentModeRow[] }) {
  if (rows.length === 0) return <Card className="p-10 text-center text-sm text-muted-foreground">No collections in this period.</Card>;
  const total = rows.reduce((s, r) => s + Number(r.total), 0);
  return (
    <div className="rounded-lg border border-border overflow-x-auto max-w-xl">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
          <th className="text-left px-3 py-2 font-medium">Mode</th>
          <th className="text-right px-3 py-2 font-medium">Count</th>
          <th className="text-right px-3 py-2 font-medium">Total</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.mode} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 capitalize">{r.mode}</td>
              <td className="px-3 py-1.5 text-right font-mono">{r.count}</td>
              <td className="px-3 py-1.5 text-right font-mono">{formatINR(r.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="border-t border-border bg-muted/40 font-medium">
          <td className="px-3 py-2">Total</td><td className="px-3 py-2 text-right font-mono">{rows.reduce((s, r) => s + r.count, 0)}</td>
          <td className="px-3 py-2 text-right font-mono">{formatINR(total)}</td>
        </tr></tfoot>
      </table>
    </div>
  );
}

export function MetalAccountView({ rows }: { rows: MetalAccountRow[] }) {
  if (rows.length === 0) return <Card className="p-10 text-center text-sm text-muted-foreground">No metal-account activity.</Card>;
  const g = (v: string) => `${Number(v).toFixed(3)} g`;
  const cols: { k: keyof MetalAccountRow; label: string }[] = [
    { k: "scrap_taken_in_fine", label: "Scrap in (fine)" },
    { k: "scrap_on_hand_fine", label: "On hand (fine)" },
    { k: "melted_recovered_fine", label: "Melted (fine)" },
    { k: "melt_loss", label: "Melt loss" },
    { k: "refined_pool_fine", label: "Refined pool" },
    { k: "issued_to_smith_fine", label: "Issued → smith" },
    { k: "received_from_smith_fine", label: "Recd ← smith" },
    { k: "smith_holding_fine", label: "Smith holding" },
    { k: "wastage_fine", label: "Wastage" },
  ];
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
          <th className="text-left px-3 py-2 font-medium">Metal</th>
          {cols.map((c) => <th key={c.k} className="text-right px-3 py-2 font-medium">{c.label}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.metal} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 capitalize">{r.metal}</td>
              {cols.map((c) => <td key={c.k} className="px-3 py-1.5 text-right font-mono">{g(r[c.k] as string)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StockOverviewView({ o }: { o: StockOverview }) {
  return (
    <div className="space-y-5">
      <div>
        <div className="text-sm font-medium mb-2">By metal &amp; purity</div>
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium">Metal</th>
              <th className="text-right px-3 py-2 font-medium">Pieces</th>
              <th className="text-right px-3 py-2 font-medium">Gross</th>
              <th className="text-right px-3 py-2 font-medium">Net</th>
              <th className="text-right px-3 py-2 font-medium">Diamond ct</th>
            </tr></thead>
            <tbody>
              {o.metals.map((m, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">{m.label}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{m.pieces}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(m.gross).toFixed(3)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(m.net).toFixed(3)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{m.has_diamond ? Number(m.diamond_carat).toFixed(2) : "—"}</td>
                </tr>
              ))}
              {o.metals.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No metal stock.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div className="text-sm font-medium mb-2">By category</div>
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium">Category</th>
              <th className="text-left px-3 py-2 font-medium">Metal</th>
              <th className="text-right px-3 py-2 font-medium">Pieces</th>
              <th className="text-right px-3 py-2 font-medium">Net</th>
            </tr></thead>
            <tbody>
              {o.categories.map((c, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">{c.category}</td>
                  <td className="px-3 py-1.5 capitalize">{c.metal}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{c.pieces}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(c.net).toFixed(3)}</td>
                </tr>
              ))}
              {o.categories.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No categorised stock.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function LedgerView({ rows }: { rows: LedgerRow[] }) {
  if (rows.length === 0) return <Card className="p-10 text-center text-sm text-muted-foreground">No ledger events.</Card>;
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
          <th className="text-left px-3 py-2 font-medium">When</th>
          <th className="text-left px-3 py-2 font-medium">Subject</th>
          <th className="text-left px-3 py-2 font-medium">Event</th>
          <th className="text-left px-3 py-2 font-medium">Ref</th>
          <th className="text-right px-3 py-2 font-medium">Amount</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 whitespace-nowrap">{formatDateTime(r.occurred_at)}</td>
              <td className="px-3 py-1.5 capitalize">{r.subject_type} #{r.subject_id}</td>
              <td className="px-3 py-1.5">{r.event_type.replace(/_/g, " ")}</td>
              <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.ref_doc_type ? `${r.ref_doc_type} #${r.ref_doc_id}` : "—"}</td>
              <td className={`px-3 py-1.5 text-right font-mono ${Number(r.amount_delta) < 0 ? "text-red-600" : ""}`}>{r.amount_delta != null && Number(r.amount_delta) !== 0 ? formatINR(r.amount_delta) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ComplianceView({ c }: { c: ComplianceReturn }) {
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(c.gstn, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = c.filename; a.click();
    URL.revokeObjectURL(url);
  }
  const isMoney = (label: string) => !/invoices|recipients|groups|notes|lines|count/i.test(label);
  const sections = c.summary.reduce<string[]>((acc, r) => {
    const s = r.section ?? "";
    return acc.includes(s) ? acc : [...acc, s];
  }, []);
  return (
    <div className="space-y-4">
      {c.note && (
        <div className="rounded-md border border-sky-400/50 bg-sky-50/50 dark:bg-sky-500/5 px-3 py-2 text-sm">{c.note}</div>
      )}
      <div className="rounded-md border border-amber-400/50 bg-amber-50/50 dark:bg-amber-500/5 px-3 py-2 text-sm">
        Schema-aligned GSTN JSON, computed from the same net-of-returns figures as the GST report.
        <b> Validate in the GSTN offline tool before filing</b> — return schema versions change periodically.
      </div>
      {sections.map((sec) => (
        <div key={sec} className="space-y-2">
          {sec && <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{sec}</div>}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {c.summary.filter((r) => (r.section ?? "") === sec).map((row) => (
              <Card key={row.label} className={`p-3 ${row.label === "Net tax payable" ? "border-primary/50" : ""}`}>
                <div className="text-xs text-muted-foreground">{row.label}</div>
                <div className="text-lg font-semibold font-mono">{isMoney(row.label) ? formatINR(row.value) : row.value}</div>
              </Card>
            ))}
          </div>
        </div>
      ))}
      <div className="no-print">
        <Button size="sm" onClick={download}><Download className="w-3.5 h-3.5 mr-1" /> Download {c.filename}</Button>
      </div>
      <details className="no-print rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">Preview JSON payload</summary>
        <pre className="px-3 py-2 text-xs overflow-x-auto max-h-96 overflow-y-auto">{JSON.stringify(c.gstn, null, 2)}</pre>
      </details>
    </div>
  );
}

export function ComplianceOverviewView({ co }: { co: ComplianceOverview }) {
  const net = Number(co.net_payable);
  const badge = (s: string) =>
    s === "ok" ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
    : s === "warn" ? "bg-amber-500/15 text-amber-600 border-amber-500/30"
    : "bg-muted text-muted-foreground border-border";
  const Row = ({ label, c, s, i, t }: { label: string; c: string; s: string; i: string; t: string }) => (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-1.5">{label}</td>
      <td className="px-3 py-1.5 text-right font-mono">{formatINR(c)}</td>
      <td className="px-3 py-1.5 text-right font-mono">{formatINR(s)}</td>
      <td className="px-3 py-1.5 text-right font-mono">{formatINR(i)}</td>
      <td className="px-3 py-1.5 text-right font-mono font-medium">{formatINR(t)}</td>
    </tr>
  );
  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className={`p-3 ${net > 0 ? "border-rose-400/50" : "border-emerald-400/50"}`}>
          <div className="text-xs text-muted-foreground">{net > 0 ? "Net GST payable" : "Net ITC carried forward"}</div>
          <div className={`text-xl font-semibold font-mono ${net > 0 ? "text-rose-600" : "text-emerald-600"}`}>{formatINR(Math.abs(net))}</div>
        </Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Output tax</div><div className="text-xl font-semibold font-mono">{formatINR(co.output.tax)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Input tax credit</div><div className="text-xl font-semibold font-mono">{formatINR(co.itc.tax)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Taxable turnover</div><div className="text-xl font-semibold font-mono">{formatINR(co.turnover_taxable)}</div></Card>
      </div>

      {/* Output vs ITC split */}
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
            <th className="text-left px-3 py-2 font-medium">Tax</th>
            <th className="text-right px-3 py-2 font-medium">CGST</th>
            <th className="text-right px-3 py-2 font-medium">SGST</th>
            <th className="text-right px-3 py-2 font-medium">IGST</th>
            <th className="text-right px-3 py-2 font-medium">Total</th>
          </tr></thead>
          <tbody>
            <Row label="Output (sales)" c={co.output.cgst} s={co.output.sgst} i={co.output.igst} t={co.output.tax} />
            <Row label="ITC (purchases)" c={co.itc.cgst} s={co.itc.sgst} i={co.itc.igst} t={co.itc.tax} />
          </tbody>
        </table>
      </div>

      {/* B2B/B2C + counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3"><div className="text-xs text-muted-foreground">B2B invoices</div><div className="text-lg font-semibold">{co.b2b.invoices}</div><div className="text-xs text-muted-foreground font-mono">{formatINR(co.b2b.taxable)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">B2C invoices</div><div className="text-lg font-semibold">{co.b2c.invoices}</div><div className="text-xs text-muted-foreground font-mono">{formatINR(co.b2c.taxable)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Total invoices</div><div className="text-lg font-semibold">{co.invoices}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Credit notes</div><div className="text-lg font-semibold">{co.credit_notes}</div></Card>
      </div>

      {/* Filing-readiness checklist */}
      <div>
        <div className="text-sm font-medium mb-2">Filing readiness</div>
        <div className="space-y-1.5">
          {co.checks.map((chk, i) => (
            <div key={i} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span>{chk.label}</span>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-mono ${badge(chk.status)}`}>{chk.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CashBankView({ cb }: { cb: CashBankBook }) {
  const net = Number(cb.net);
  const Side = ({ title, rows, total }: { title: string; rows: { mode: string; count: number; total: string }[]; total: string }) => (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
          <th className="text-left px-3 py-2 font-medium">{title} — mode</th>
          <th className="text-right px-3 py-2 font-medium">Count</th>
          <th className="text-right px-3 py-2 font-medium">Total</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">None.</td></tr>}
          {rows.map((r) => (
            <tr key={r.mode} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 capitalize">{r.mode}</td>
              <td className="px-3 py-1.5 text-right font-mono">{r.count}</td>
              <td className="px-3 py-1.5 text-right font-mono">{formatINR(r.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="border-t border-border bg-muted/40 font-medium">
          <td className="px-3 py-2">Total</td><td /><td className="px-3 py-2 text-right font-mono">{formatINR(total)}</td>
        </tr></tfoot>
      </table>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Side title="Receipts (in)" rows={cb.receipts} total={cb.receipts_total} />
        <Side title="Payments (out)" rows={cb.payments} total={cb.payments_total} />
      </div>
      <Card className={`p-4 max-w-sm ${net >= 0 ? "border-emerald-400/50" : "border-rose-400/50"}`}>
        <div className="flex justify-between items-center">
          <span className="font-medium">Net cash flow</span>
          <span className={`text-lg font-mono font-semibold ${net >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{formatINR(cb.net)}</span>
        </div>
      </Card>
    </div>
  );
}

export function CashBookView({ ck }: { ck: CashBook }) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-sky-400/50 bg-sky-50/50 dark:bg-sky-500/5 px-3 py-2 text-sm">
        Running cash &amp; bank position for cross-checking: <b>opening + receipts − payments = closing</b>, carried forward each day. Cash vs bank split by tender mode.
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3"><div className="text-xs text-muted-foreground">Opening (cash + bank)</div><div className="text-lg font-semibold font-mono">{formatINR(ck.opening.total)}</div><div className="text-[11px] text-muted-foreground font-mono">cash {formatINR(ck.opening.cash)} · bank {formatINR(ck.opening.bank)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Total receipts (income)</div><div className="text-lg font-semibold font-mono text-emerald-600">{formatINR(ck.total_receipts)}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Total payments (expenses)</div><div className="text-lg font-semibold font-mono text-rose-600">{formatINR(ck.total_payments)}</div></Card>
        <Card className={`p-3 ${Number(ck.closing.total) < 0 ? "border-rose-400/50" : "border-emerald-400/50"}`}><div className="text-xs text-muted-foreground">Closing (cash + bank)</div><div className="text-lg font-semibold font-mono">{formatINR(ck.closing.total)}</div><div className="text-[11px] text-muted-foreground font-mono">cash {formatINR(ck.closing.cash)} · bank {formatINR(ck.closing.bank)}</div></Card>
      </div>
      {ck.rows.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">No cash/bank movement in this period.</Card>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-muted/50 border-b border-border text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium">Date</th>
              <th className="text-right px-3 py-2 font-medium">Opening</th>
              <th className="text-right px-3 py-2 font-medium">Cash in</th>
              <th className="text-right px-3 py-2 font-medium">Bank in</th>
              <th className="text-right px-3 py-2 font-medium">Receipts</th>
              <th className="text-right px-3 py-2 font-medium">Cash out</th>
              <th className="text-right px-3 py-2 font-medium">Bank out</th>
              <th className="text-right px-3 py-2 font-medium">Payments</th>
              <th className="text-right px-3 py-2 font-medium">Closing</th>
            </tr></thead>
            <tbody>
              {ck.rows.map((r, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(r.date)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{formatINR(r.opening)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(r.cash_in) ? formatINR(r.cash_in) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(r.bank_in) ? formatINR(r.bank_in) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-emerald-600">{Number(r.receipts) ? formatINR(r.receipts) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(r.cash_out) ? formatINR(r.cash_out) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{Number(r.bank_out) ? formatINR(r.bank_out) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-rose-600">{Number(r.payments) ? formatINR(r.payments) : "—"}</td>
                  <td className={`px-3 py-1.5 text-right font-mono font-medium ${Number(r.closing) < 0 ? "text-rose-600" : ""}`}>{formatINR(r.closing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
