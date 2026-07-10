import { useEffect, useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import * as api from "@/api";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { fyList } from "@/lib/fy";
import { MonthField } from "@/components/ui/month-field";
import { ReportResultView, csvFor, type ReportResult } from "./views";

type FilterKind = "range" | "day" | "month" | "none";

interface ReportDef {
  id: string;
  section: string;
  label: string;
  desc?: string;
  group?: string;
  filter: FilterKind;
  load: (ctx: { from: string; to: string; day: string; month: string }) => Promise<ReportResult>;
}

/** All reports, grouped by their owning section. Order here drives the UI order. */
const REPORTS: ReportDef[] = [
  // ---- Sales ----
  { id: "sales-register", section: "Sales", label: "Sales register", desc: "Tax invoices, net of returns.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.salesRegister(from, to), money: ["taxable", "tax", "total"] }) },
  { id: "sales-by-purity", section: "Sales", label: "Sales by purity", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.salesByPurity(from, to), money: ["taxable", "tax"] }) },
  { id: "gross-profit", section: "Sales", label: "Gross profit", desc: "Margin on cost-tracked stock only.", filter: "range",
    load: async ({ from, to }) => ({ kind: "profit", p: await api.grossProfit(from, to) }) },
  { id: "payment-modes", section: "Sales", label: "Payment collections", desc: "Split by tender mode.", filter: "range",
    load: async ({ from, to }) => ({ kind: "payment", rows: await api.paymentModesRange(from, to) }) },
  { id: "sales-returns", section: "Sales", label: "Sales returns", desc: "Credit-note register.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.salesReturns(from, to), money: ["taxable", "tax", "total", "deduction", "net_refund"] }) },
  { id: "estimates", section: "Sales", label: "Estimates & quotations", desc: "Open / converted / expired.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.estimatesRegister(from, to), money: ["taxable", "tax", "total"] }) },
  { id: "approval-outstanding", section: "Sales", label: "On-approval outstanding", desc: "Goods out, not yet returned/billed.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.approvalOutstanding(), money: ["cost_value"] }) },

  // ---- Schemes ----
  { id: "scheme-dues", section: "Schemes", label: "Scheme dues", desc: "Overdue installments.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.schemeDues(), money: ["monthly", "amount_due_now", "total_paid"] }) },
  { id: "scheme-enrollment", section: "Schemes", label: "Enrollment register", desc: "All schemes & members.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.schemeEnrollment(), money: ["monthly", "total_paid", "maturity_value"] }) },
  { id: "scheme-collections", section: "Schemes", label: "Collections", desc: "Installments received.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.schemeCollections(from, to), money: ["amount", "rate"] }) },
  { id: "scheme-maturity", section: "Schemes", label: "Maturity & closure", desc: "Matured / closed schemes.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.schemeMaturity(), money: ["total_paid", "maturity_value"] }) },

  // ---- Parties ----
  { id: "outstanding", section: "Parties", label: "Outstanding", desc: "Party cash balances.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.outstandingReport(), money: ["cash_balance"] }) },
  { id: "party-metal", section: "Parties", label: "Metal balances", desc: "Party fine-gram positions.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.partyMetal(), money: [] }) },
  { id: "top-customers", section: "Parties", label: "Top customers", desc: "By sales value.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.topCustomers(from, to), money: ["sales"] }) },

  // ---- Advance ----
  { id: "advance-dues", section: "Advance", label: "Advance dues", desc: "Matured / overdue advances.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.advanceDues(), money: ["amount", "balance"] }) },
  { id: "advance-register", section: "Advance", label: "Advance register", desc: "All advances & metal bookings.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.advanceRegister(), money: ["amount", "balance", "locked_rate"] }) },

  // ---- Inventory ----
  { id: "stock-valuation", section: "Inventory", label: "Stock valuation", filter: "none",
    load: async () => ({ kind: "register", reg: await api.stockValuation(), money: ["value"] }) },
  { id: "stock-revaluation", section: "Inventory", label: "Stock revaluation", desc: "Book cost vs current metal rate.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.stockRevaluation(), money: ["cost", "market_metal_value", "gain_loss"] }) },
  { id: "stock-ageing", section: "Inventory", label: "Stock ageing", desc: "Dead & slow-moving stock.", filter: "none",
    load: async () => ({ kind: "ageing", a: await api.stockAgeing() }) },
  { id: "stock-overview", section: "Inventory", label: "Stock summary", desc: "By metal, purity & category.", filter: "none",
    load: async () => ({ kind: "overview", o: await api.stockOverview() }) },
  { id: "barcode-stock", section: "Inventory", label: "Barcode-wise stock", desc: "SKU-level in-stock list.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.barcodeStock(), money: ["cost_value"] }) },
  { id: "loose-stone-valuation", section: "Inventory", label: "Loose-stone valuation", desc: "In-stock loose stones.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.looseStoneValuation(), money: ["cost_value"] }) },
  { id: "resale-margin", section: "Inventory", label: "Resale stock & margin", desc: "Used-goods stock & margins.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.resaleMargin(), money: ["purchase_cost", "sale_price", "margin", "gst"] }) },

  // ---- Purchases ----
  { id: "purchase-register", section: "Purchases", label: "Purchase register", desc: "Bills, net of returns.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.purchaseRegister(from, to), money: ["taxable", "tax", "total"] }) },
  { id: "supplier-purchases", section: "Purchases", label: "Supplier-wise", desc: "Purchases grouped by supplier.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.supplierPurchases(from, to), money: ["taxable", "tax", "total"] }) },
  { id: "purchase-returns", section: "Purchases", label: "Purchase returns", desc: "Debit-note register.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.purchaseReturns(from, to), money: ["taxable", "tax", "total"] }) },

  // ---- Old Gold ----
  { id: "metal-account", section: "Old Jewellery", label: "Metal account", desc: "Fine-gram scrap / smith pool.", filter: "none",
    load: async () => ({ kind: "metal", rows: await api.metalAccount() }) },
  { id: "old-gold-intake", section: "Old Jewellery", label: "Old jewellery intake", desc: "Old items received: gross, fine, deduction.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.oldGoldIntake(from, to), money: ["rate", "value"] }) },
  { id: "rate-cut", section: "Old Jewellery", label: "Rate-cutting register", desc: "Metal ↔ money conversions.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.rateCutRegister(from, to), money: ["rate", "amount"] }) },

  // ---- Workshop ----
  { id: "smith-ledger", section: "Workshop", label: "Smith ledger", desc: "Metal + making, reconciled.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.karigarReport(), money: ["making_balance"] }) },
  { id: "job-work", section: "Workshop", label: "Job-work register", desc: "Issued / received / pending.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.jobWorkRegister(), money: ["making_charge"] }) },

  // ---- Staff ----
  { id: "leave-register", section: "Staff", label: "Leave register", desc: "Applications & status.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.leaveRegister(), money: [] }) },
  { id: "salary-advances", section: "Staff", label: "Salary advances", desc: "Loans & outstanding recovery.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.salaryAdvances(), money: ["amount", "recovery", "outstanding"] }) },
  { id: "statutory", section: "Staff", label: "Statutory register", desc: "PF / ESI / PT / TDS per payslip.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.statutoryRegister(), money: ["gross", "pf", "esi", "pt", "tds", "employer_pf", "employer_esi", "net_pay"] }) },

  // ---- Banking ----
  { id: "cheque-status", section: "Banking", label: "Cheque status", desc: "Pending / cleared / bounced.", filter: "none",
    load: async () => ({ kind: "register", reg: await api.chequeStatus(), money: ["amount"] }) },
  { id: "day-close-variance", section: "Banking", label: "Day-close variance", desc: "Daily cash short/over + stock variance.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.dayCloseReport(from, to), money: ["opening", "expected", "counted", "cash_variance"] }) },

  // ---- Accounts & Compliance ----
  { id: "compliance-overview", section: "Accounts & Compliance", group: "Overview", label: "Compliance overview", desc: "Period GST position + filing readiness.", filter: "month",
    load: async ({ month }) => ({ kind: "compliance_overview", co: await api.complianceOverview(month) }) },
  { id: "gst-net", section: "Accounts & Compliance", group: "GST Returns", label: "GST summary", desc: "Output tax vs ITC.", filter: "range",
    load: async ({ from, to }) => ({ kind: "gst", gst: await api.gstNet(from, to) }) },
  { id: "gstr1", section: "Accounts & Compliance", group: "GST Returns", label: "GSTR-1", desc: "Outward supplies return (GSTN JSON).", filter: "month",
    load: async ({ month }) => ({ kind: "compliance", c: await api.gstr1Return(month) }) },
  { id: "gstr3b", section: "Accounts & Compliance", group: "GST Returns", label: "GSTR-3B", desc: "Summary return (GSTN JSON).", filter: "month",
    load: async ({ month }) => ({ kind: "compliance", c: await api.gstr3bReturn(month) }) },
  { id: "hsn-summary", section: "Accounts & Compliance", group: "GST Returns", label: "HSN summary", desc: "HSN-wise outward supplies.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.hsnSummary(from, to), money: ["taxable", "cgst", "sgst", "igst", "tax"] }) },
  { id: "output-tax-register", section: "Accounts & Compliance", group: "Registers", label: "Output tax register", desc: "Invoice-wise tax charged.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.outputTaxRegister(from, to), money: ["taxable", "cgst", "sgst", "igst", "tax"] }) },
  { id: "itc-register", section: "Accounts & Compliance", group: "Registers", label: "ITC register", desc: "Purchase-wise input credit.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.itcRegister(from, to), money: ["taxable", "cgst", "sgst", "igst", "tax"] }) },
  { id: "cash-bank-book", section: "Accounts & Compliance", group: "Books", label: "Cash & bank book", desc: "Receipts vs payments by mode.", filter: "range",
    load: async ({ from, to }) => ({ kind: "cashbank", cb: await api.cashBankBook(from, to) }) },
  { id: "daily-collections", section: "Accounts & Compliance", group: "Books", label: "Daily collections", desc: "Day-wise Cash / UPI / Card / Bank / Cheque received.", filter: "range",
    load: async ({ from, to }) => ({ kind: "register", reg: await api.dailyCollections(from, to), money: ["cash", "upi", "card", "bank", "cheque", "total"] }) },
  { id: "cash-book", section: "Accounts & Compliance", group: "Books", label: "Cash book", desc: "Opening / receipts / payments / closing — running balance.", filter: "range",
    load: async ({ from, to }) => ({ kind: "cashbook", ck: await api.cashBook(from, to) }) },
  { id: "day-book", section: "Accounts & Compliance", group: "Books", label: "Day book", desc: "All ledger movements for a day.", filter: "day",
    load: async ({ day }) => ({ kind: "daybook", rows: (await api.dayBook(day)).rows }) },
  { id: "ledger", section: "Accounts & Compliance", group: "Books", label: "General ledger", desc: "Recent append-only audit trail.", filter: "none",
    load: async () => ({ kind: "ledger", rows: await api.ledgerReport(200) }) },
];

const SECTIONS = REPORTS.reduce<string[]>((acc, r) => (acc.includes(r.section) ? acc : [...acc, r.section]), []);

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = () => { const d = new Date(); return iso(new Date(d.getFullYear(), d.getMonth(), 1)); };

export function Reports() {
  const [section, setSection] = useState<string>(SECTIONS[0]);
  const [reportId, setReportId] = useState<string>(REPORTS[0].id);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(iso(new Date()));
  const [beginDate, setBeginDate] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.getSettings().then((s) => setBeginDate(s["books.begin_date"] || undefined)).catch(() => {});
  }, []);
  const fys = useMemo(() => fyList(beginDate), [beginDate]);
  const [day, setDay] = useState(iso(new Date()));
  // GST returns are filed for the completed month, so default to the previous month.
  const [month, setMonth] = useState(() => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sectionReports = useMemo(() => REPORTS.filter((r) => r.section === section), [section]);
  const active = REPORTS.find((r) => r.id === reportId)!;

  // Keep the selected report valid when the section changes.
  useEffect(() => {
    if (!sectionReports.some((r) => r.id === reportId)) setReportId(sectionReports[0].id);
  }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setResult(null);
    active.load({ from, to, day, month })
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => { if (!cancelled) setError(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reportId, from, to, day, month]); // eslint-disable-line react-hooks/exhaustive-deps

  function exportCsv() {
    if (!result) return;
    const csv = csvFor(result);
    if (!csv) return;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${active.id}-report.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex gap-4 h-full">
      {/* Section rail */}
      <aside className="w-48 shrink-0 border-r border-border pr-2 no-print">
        <div className="text-xs font-medium text-muted-foreground px-2 py-1.5 uppercase tracking-wide">Sections</div>
        <nav className="space-y-0.5">
          {SECTIONS.map((s) => (
            <button key={s} onClick={() => setSection(s)}
              className={`w-full text-left px-2 py-1.5 rounded-md text-sm ${section === s ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
              {s}
            </button>
          ))}
        </nav>
      </aside>

      {/* Canvas */}
      <div className="flex-1 min-w-0 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{active.label}</h2>
            <p className="text-sm text-muted-foreground">{active.desc ?? "Drawn from the append-only ledger."}</p>
          </div>
          <div className="flex items-center gap-2 no-print">
            {active.filter === "range" && <>
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                title="Financial year"
                value={fys.find((f) => f.from === from && f.to === to)?.label ?? ""}
                onChange={(e) => { const f = fys.find((x) => x.label === e.target.value); if (f) { setFrom(f.from); setTo(f.to); } }}
              >
                <option value="">FY…</option>
                {fys.map((f) => <option key={f.label} value={f.label}>FY {f.label}</option>)}
              </select>
              <DateField value={from} onChange={setFrom} /><span className="text-muted-foreground text-sm">to</span><DateField value={to} onChange={setTo} />
            </>}
            {active.filter === "day" && <DateField value={day} onChange={setDay} />}
            {active.filter === "month" && <MonthField value={month} onChange={setMonth} />}
            <Button size="sm" variant="outline" onClick={exportCsv}><Download className="w-3.5 h-3.5 mr-1" /> CSV</Button>
            <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
          </div>
        </div>

        {/* Report picker within the section (grouped when the section defines groups) */}
        {sectionReports.some((r) => r.group) ? (
          <div className="space-y-1.5 border-b border-border pb-2 no-print">
            {Array.from(new Set(sectionReports.map((r) => r.group))).map((g) => (
              <div key={g} className="flex items-center gap-2 flex-wrap">
                <span className="w-24 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g}</span>
                {sectionReports.filter((r) => r.group === g).map((r) => (
                  <button key={r.id} onClick={() => setReportId(r.id)}
                    className={`rounded-md px-2.5 py-1 text-sm ${reportId === r.id ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                    {r.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-1 border-b border-border flex-wrap no-print">
            {sectionReports.map((r) => (
              <button key={r.id} onClick={() => setReportId(r.id)}
                className={`px-3 py-2 text-sm ${reportId === r.id ? "border-b-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                {r.label}
              </button>
            ))}
          </div>
        )}

        {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}
        {loading && <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>}
        {!loading && result && <div className="print-area">{<ReportResultView r={result} />}</div>}
      </div>
    </div>
  );
}
