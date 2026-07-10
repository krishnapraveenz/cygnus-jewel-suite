import { X, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { InvoiceDetailLine } from "@/api";
import { Button } from "@/components/ui/button";
import { formatDate, formatINR, rupeesInWords } from "@/lib/utils";
import { DEFAULT_PROFILE, injectPageStyle, loadProfile, profileVars, type PrintProfile } from "@/lib/printProfile";
import { getCompany, loadCompany } from "@/lib/company";

export interface PreviewDoc {
  document_no: string | null;
  type: string;
  created_at: string;
  fy?: string;
  valid_on?: string;
  status?: string;
  customer_name: string | null;
  payment_mode?: string | null;
  subtotal: string;
  discount_total?: string;
  grand_total: string;
  amount_payable?: string | null;
  old_gold_value?: string;
  scheme_credit?: string;
  advance_applied?: string;
  tenders?: { mode: string; amount: string; reference: string | null }[];
  old_gold_lots?: {
    metal: string;
    purity: string | null;
    gross_weight: string;
    deduction_percent: string;
    net_weight: string;
    fine_weight: string | null;
    rate: string;
    value: string;
  }[];
  lines: InvoiceDetailLine[];
}

export function InvoicePreview({
  doc,
  kind = "invoice",
  onClose,
  embedded = false,
  profile: profileProp,
}: {
  doc: PreviewDoc;
  kind?: "invoice" | "estimate" | "credit_note";
  onClose: () => void;
  embedded?: boolean;
  profile?: PrintProfile;
}) {
  const [loaded, setLoaded] = useState<PrintProfile | null>(null);
  useEffect(() => {
    if (!profileProp) loadProfile().then(setLoaded);
  }, [profileProp]);
  const profile = profileProp ?? loaded ?? DEFAULT_PROFILE;
  useEffect(() => {
    injectPageStyle(profile);
  }, [profile]);

  const [co, setCo] = useState(getCompany());
  useEffect(() => {
    loadCompany().then(setCo).catch(() => {});
  }, []);
  const coAddr = [co.address1, co.address2, co.city].filter(Boolean).join(", ") + (co.pincode ? ` — ${co.pincode}` : "");
  const coLine3 = [co.gstin ? `GSTIN: ${co.gstin}` : "", co.bis ? `BIS Hallmark: ${co.bis}` : "", co.phone].filter(Boolean).join(" · ");

  const inv = doc;
  const isEstimate = kind === "estimate";
  const isCredit = kind === "credit_note";
  const titleWord = isCredit ? "Credit Note" : isEstimate ? "Estimate" : "Invoice";
  const n = (s: string | null | undefined) => Number(s || 0);

  // HSN summary (taxable + tax grouped by HSN).
  const hsnMap = new Map<string, { taxable: number; tax: number }>();
  let cgst = 0, sgst = 0, igst = 0;
  for (const l of inv.lines) {
    const hsn = l.hsn || "7113";
    const tax = n(l.breakdown.cgst) + n(l.breakdown.sgst) + n(l.breakdown.igst);
    cgst += n(l.breakdown.cgst);
    sgst += n(l.breakdown.sgst);
    igst += n(l.breakdown.igst);
    const cur = hsnMap.get(hsn) || { taxable: 0, tax: 0 };
    cur.taxable += n(l.taxable_value);
    cur.tax += tax;
    hsnMap.set(hsn, cur);
  }

  const disc = Number(inv.discount_total || 0);
  const og = Number(inv.old_gold_value || 0);
  const sc = Number(inv.scheme_credit || 0);
  const adv = Number(inv.advance_applied || 0);
  const taxableAfter = Number(inv.subtotal) - disc;
  const lots = inv.old_gold_lots ?? [];
  const hasReductions = disc > 0 || og > 0 || sc > 0 || adv > 0;

  const sheet = (
    <div className="a4-sheet bg-card rounded-lg shadow-xl" style={profileVars(profile)}>
      {!embedded && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border no-print">
          <h3 className="text-sm font-semibold">{titleWord} {inv.document_no}</h3>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}>
              <Printer className="w-3.5 h-3.5 mr-1" /> Print
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* printable area */}
      <div className="print-area text-black bg-white">
          {/* ---- Invoice page ---- */}
          <div className="a4-page">
          {/* Seller / title */}
          <div className="flex items-start justify-between border-b-2 border-black pb-3">
            <div>
              <div className="text-lg font-bold">{co.name || co.legalName || "Your Jewellery Store"}</div>
              <div className="text-xs text-gray-600">{coAddr || "—"}</div>
              <div className="text-xs text-gray-600">{coLine3 || "—"}</div>
            </div>
            <div className="text-right">
              <div className="text-base font-bold uppercase tracking-wide">{isCredit ? "Credit Note" : isEstimate ? "Estimate" : "Tax Invoice"}</div>
              <div className="text-xs">No: <b>{inv.document_no}</b></div>
              <div className="text-xs">Date: {formatDate(inv.created_at)}</div>
              {isEstimate ? (
                <div className="text-xs font-semibold text-amber-700">Valid today only ({inv.valid_on})</div>
              ) : isCredit ? (
                <div className="text-xs font-semibold text-green-700">Refund / return</div>
              ) : (
                <div className="text-xs">FY: {inv.fy}</div>
              )}
            </div>
          </div>

          {/* Buyer */}
          <div className="flex justify-between py-3 text-xs">
            <div>
              <div className="text-gray-500 uppercase text-[10px]">{isEstimate ? "Estimate for" : "Billed to"}</div>
              <div className="font-medium">{inv.customer_name || "Walk-in Customer"}</div>
            </div>
            <div className="text-right">
              <div className="text-gray-500 uppercase text-[10px]">Supply</div>
              <div>{inv.type === "b2b" ? "B2B / Wholesale" : "Retail"}</div>
              {!isEstimate && <div>Payment: {inv.payment_mode || "—"}</div>}
            </div>
          </div>

          {/* Lines */}
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="bg-gray-100 border-y border-gray-400">
                <th className="text-left p-1 border-r border-gray-300">#</th>
                <th className="text-left p-1 border-r border-gray-300">Description</th>
                <th className="text-left p-1 border-r border-gray-300">HSN</th>
                <th className="text-left p-1 border-r border-gray-300">Purity</th>
                <th className="text-right p-1 border-r border-gray-300">Gross</th>
                <th className="text-right p-1 border-r border-gray-300">Dia ct</th>
                <th className="text-right p-1 border-r border-gray-300">Dia ₹</th>
                <th className="text-right p-1 border-r border-gray-300">Stone g</th>
                <th className="text-right p-1 border-r border-gray-300">Stone ₹</th>
                <th className="text-right p-1 border-r border-gray-300">Net</th>
                <th className="text-right p-1 border-r border-gray-300">Rate/g</th>
                <th className="text-right p-1 border-r border-gray-300">Making</th>
                <th className="text-right p-1">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l, i) => {
                const mv = Number(l.breakdown.metal_value);
                const mk = Number(l.breakdown.making);
                const effPct = mv > 0 ? (mk / mv) * 100 : 0;
                const stones = l.stones ?? [];
                const isDia = (st: { description?: string | null }) => (st.description ?? "").toLowerCase().includes("diam");
                const sum = (arr: typeof stones, f: (s: (typeof stones)[number]) => number) => arr.reduce((a, s) => a + f(s), 0);
                const diaList = stones.filter(isDia);
                const stnList = stones.filter((s) => !isDia(s));
                const diaCt = sum(diaList, (s) => Number(s.carat ?? 0));
                const diaVal = sum(diaList, (s) => Number(s.value ?? 0));
                const stnCt = sum(stnList, (s) => Number(s.carat ?? 0));
                const stnVal = sum(stnList, (s) => Number(s.value ?? 0));
                const stnG = stnCt * 0.2; // 1 carat = 0.2 g
                return (
                <tr key={i} className="border-b border-gray-200">
                  <td className="p-1 border-r border-gray-200">{i + 1}</td>
                  <td className="p-1 border-r border-gray-200">
                    {l.description}
                    {l.huid ? <span className="text-gray-500"> · HUID {l.huid}</span> : null}
                  </td>
                  <td className="p-1 border-r border-gray-200">{l.hsn || "7113"}</td>
                  <td className="p-1 border-r border-gray-200">{l.purity_label || "—"}</td>
                  <td className="p-1 border-r border-gray-200 text-right">{l.gross_weight ?? "—"}</td>
                  <td className="p-1 border-r border-gray-200 text-right">{diaCt > 0 ? diaCt.toFixed(3) : "—"}</td>
                  <td className="p-1 border-r border-gray-200 text-right">{diaVal > 0 ? formatINR(diaVal) : "—"}</td>
                  <td className="p-1 border-r border-gray-200 text-right">{stnG > 0 ? stnG.toFixed(3) : "—"}</td>
                  <td className="p-1 border-r border-gray-200 text-right">{stnVal > 0 ? formatINR(stnVal) : "—"}</td>
                  <td className="p-1 border-r border-gray-200 text-right">{l.net_weight ?? "—"}</td>
                  <td className="p-1 border-r border-gray-200 text-right">{Number(l.rate_used) > 0 ? formatINR(l.rate_used) : "—"}</td>
                  <td className="p-1 border-r border-gray-200 text-right">
                    {Number(l.breakdown.making) > 0 ? <>{formatINR(l.breakdown.making)}<span className="text-gray-500"> ({effPct.toFixed(1)}%)</span></> : "—"}
                  </td>
                  <td className="p-1 text-right font-medium">{formatINR(l.line_total)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>

          {/* HSN summary + totals */}
          <div className="flex justify-between gap-6 mt-4 avoid-break">
            <div className="flex-1">
              <div className="text-[10px] uppercase text-gray-500 mb-1">HSN summary{isEstimate ? " (indicative)" : ""}</div>
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="bg-gray-100 border-y border-gray-300">
                    <th className="text-left p-1 border-r border-gray-300">HSN</th>
                    <th className="text-right p-1 border-r border-gray-300">Taxable</th>
                    <th className="text-right p-1">GST (3%)</th>
                  </tr>
                </thead>
                <tbody>
                  {[...hsnMap.entries()].map(([hsn, v]) => (
                    <tr key={hsn} className="border-b border-gray-200">
                      <td className="p-1 border-r border-gray-200">{hsn}</td>
                      <td className="p-1 border-r border-gray-200 text-right">{formatINR(v.taxable)}</td>
                      <td className="p-1 text-right">{formatINR(v.tax)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="w-72 text-[12px]">
              {disc > 0 && <Tot label="Items value" value={formatINR(inv.subtotal)} />}
              {disc > 0 && <Tot label="Discount" value={`− ${formatINR(disc)}`} />}
              <Tot label="Taxable value" value={formatINR(taxableAfter)} />
              {igst > 0 ? (
                <Tot label={isEstimate ? "IGST 3% (indic.)" : "IGST 3%"} value={formatINR(igst)} />
              ) : (
                <>
                  <Tot label={isEstimate ? "CGST 1.5% (indic.)" : "CGST 1.5%"} value={formatINR(cgst)} />
                  <Tot label={isEstimate ? "SGST 1.5% (indic.)" : "SGST 1.5%"} value={formatINR(sgst)} />
                </>
              )}
              <div className="flex justify-between border-t-2 border-black mt-1 pt-1 font-bold text-sm">
                <span>{isCredit ? "Refund Total" : isEstimate ? "Estimated Total" : "Grand Total"}</span>
                <span>{formatINR(inv.grand_total)}</span>
              </div>
              {!isEstimate && !isCredit && og > 0 && <Tot label="Less: old jewellery exchange" value={`− ${formatINR(og)}`} />}
              {!isEstimate && !isCredit && sc > 0 && <Tot label="Less: scheme redemption" value={`− ${formatINR(sc)}`} />}
              {!isEstimate && !isCredit && adv > 0 && <Tot label="Less: advance applied" value={`− ${formatINR(adv)}`} />}
              {!isEstimate && inv.amount_payable && (hasReductions || isCredit) && (
                <div className="flex justify-between border-t border-black mt-1 pt-1 font-bold text-sm">
                  <span>{isCredit ? "Net refund" : "Net payable"}</span>
                  <span>{formatINR(inv.amount_payable)}</span>
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 text-[11px]">
            <b>Amount in words:</b> {rupeesInWords(inv.amount_payable || inv.grand_total)}
          </div>

          {!isEstimate && !isCredit && (inv.tenders?.length ?? 0) > 0 && (
            <div className="mt-1 text-[11px]">
              <b>Payment:</b>{" "}
              {inv.tenders!
                .map((t) => {
                  const m: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI", bank_transfer: "Bank", cheque: "Cheque", credit: "Credit (due)" };
                  return `${m[t.mode] || t.mode} ${formatINR(t.amount)}${t.reference ? ` [${t.reference}]` : ""}`;
                })
                .join("  ·  ")}
            </div>
          )}

          <div className="flex justify-between items-end mt-auto pt-10 text-[10px] text-gray-600 avoid-break">
            <div className="max-w-sm">
              {isEstimate ? (
                <b>This is an ESTIMATE, not a tax invoice. Valid for the day of issue only; prices are indicative and subject to the day's metal rate.</b>
              ) : isCredit ? (
                <b>Credit note issued against the original tax invoice under Sec. 34. Returned goods received back into stock; GST adjusted accordingly.</b>
              ) : (
                <>Goods once sold are governed by the store buy-back/exchange policy. Hallmarked as per BIS. E.&amp;O.E.</>
              )}
            </div>
            <div className="text-center">
              <div className="h-10" />
              <div className="border-t border-gray-400 pt-1">Authorised Signatory</div>
            </div>
          </div>
          </div>
          {/* ---- end invoice page ---- */}

          {/* Old Gold Purchase voucher — its own A4 page */}
          {!isEstimate && !isCredit && lots.length > 0 && (
            <div className="a4-page page-break-before">
              <div className="flex items-start justify-between border-b-2 border-black pb-3 avoid-break">
                <div>
                  <div className="text-lg font-bold">{co.name || co.legalName || "Your Jewellery Store"}</div>
                  <div className="text-xs text-gray-600">{coLine3 || "—"}</div>
                </div>
                <div className="text-right">
                  <div className="text-base font-bold uppercase tracking-wide">Old Jewellery Purchase</div>
                  <div className="text-xs">Against invoice: <b>{inv.document_no}</b></div>
                  <div className="text-xs">Date: {formatDate(inv.created_at)}</div>
                </div>
              </div>
              <div className="py-2 text-xs">
                <span className="text-gray-500 uppercase text-[10px]">Received from</span>
                <div className="font-medium">{inv.customer_name || "Walk-in Customer"}</div>
              </div>
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="bg-gray-100 border-y border-gray-400">
                    <th className="text-left p-1.5 border-r border-gray-300">#</th>
                    <th className="text-left p-1.5 border-r border-gray-300">Metal · Purity</th>
                    <th className="text-right p-1.5 border-r border-gray-300">Gross g</th>
                    <th className="text-right p-1.5 border-r border-gray-300">Ded %</th>
                    <th className="text-right p-1.5 border-r border-gray-300">Net g</th>
                    <th className="text-right p-1.5 border-r border-gray-300">Fine g</th>
                    <th className="text-right p-1.5 border-r border-gray-300">Rate/g</th>
                    <th className="text-right p-1.5">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((g, i) => (
                    <tr key={i} className="border-b border-gray-200">
                      <td className="p-1.5 border-r border-gray-200">{i + 1}</td>
                      <td className="p-1.5 border-r border-gray-200">{g.metal} {g.purity ?? ""}</td>
                      <td className="p-1.5 border-r border-gray-200 text-right">{g.gross_weight}</td>
                      <td className="p-1.5 border-r border-gray-200 text-right">{g.deduction_percent}</td>
                      <td className="p-1.5 border-r border-gray-200 text-right">{g.net_weight}</td>
                      <td className="p-1.5 border-r border-gray-200 text-right">{g.fine_weight ?? "—"}</td>
                      <td className="p-1.5 border-r border-gray-200 text-right">{formatINR(g.rate)}</td>
                      <td className="p-1.5 text-right font-medium">{formatINR(g.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex justify-end mt-2">
                <div className="w-64 text-[12px]">
                  <div className="flex justify-between border-t-2 border-black pt-1 font-bold text-sm">
                    <span>Total paid</span>
                    <span>{formatINR(og)}</span>
                  </div>
                </div>
              </div>
              <div className="mt-2 text-[11px]"><b>Amount in words:</b> {rupeesInWords(og)}</div>
              <div className="flex justify-between items-end mt-auto pt-10 text-[10px] text-gray-600 avoid-break">
                <div className="max-w-sm">
                  <b>Old jewellery purchased from an unregistered customer — NO GST.</b> Physical gross weight received into stock for refining.
                </div>
                <div className="text-center">
                  <div className="h-10" />
                  <div className="border-t border-gray-400 pt-1">Customer Signature</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
  );

  if (embedded) return sheet;
  return createPortal(
    <div className="print-root fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-8 no-print-bg">
      {sheet}
    </div>,
    document.body,
  );
}

function Tot({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={"flex justify-between py-0.5 " + (bold ? "font-semibold" : "")}>
      <span className="text-gray-600">{label}</span>
      <span>{value}</span>
    </div>
  );
}
