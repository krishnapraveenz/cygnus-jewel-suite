import { createPortal } from "react-dom";
import { Printer, X } from "lucide-react";
import type { SchemeDetail } from "@/api";
import { Button } from "@/components/ui/button";
import { formatINR, formatDate } from "@/lib/utils";
import { getCompany } from "@/lib/company";

const MODE_LABEL: Record<string, string> = {
  cash: "Cash", upi: "UPI", bank: "Bank transfer", card: "Card", cheque: "Cheque",
};

/**
 * Printable scheme receipt / passbook. When `seq` is given, the matching installment is
 * highlighted (collection receipt); otherwise it prints the full passbook.
 */
export function SchemeReceipt({ detail, seq, onClose }: { detail: SchemeDetail; seq?: number; onClose: () => void }) {
  const co = getCompany();
  const paid = detail.installments.length;
  const balance = Math.max(0, detail.installments_required - paid);
  const isGram = detail.scheme_type === "gram";
  const here = seq ? detail.installments.find((i) => i.seq === seq) : undefined;
  const coAddr = [co.address1, co.address2, co.city].filter(Boolean).join(", ") + (co.pincode ? ` — ${co.pincode}` : "");
  const coLine3 = [co.gstin ? `GSTIN: ${co.gstin}` : "", co.phone].filter(Boolean).join(" · ");

  return createPortal(
    <div className="print-root fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-card rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 no-print">
          <div className="text-sm font-medium">{here ? "Installment receipt" : "Scheme passbook"}</div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="print-area text-black bg-white p-6 text-sm">
          {/* Shop header */}
          <div className="text-center border-b-2 border-black pb-2">
            <div className="text-lg font-bold">{co.name || co.legalName || "Your Jewellery Store"}</div>
            {coAddr.trim() && coAddr !== "—" && <div className="text-[11px] text-gray-600">{coAddr}</div>}
            {coLine3 && <div className="text-[11px] text-gray-600">{coLine3}</div>}
          </div>

          <div className="text-center font-semibold uppercase tracking-wide text-xs mt-2">
            {here ? "Savings Scheme — Installment Receipt" : "Savings Scheme — Passbook"}
          </div>

          {/* Meta */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 text-[12px]">
            <div><span className="text-gray-500">Scheme No:</span> <b>{detail.scheme_no || `#${detail.id}`}</b></div>
            <div className="text-right"><span className="text-gray-500">Date:</span> {formatDate(here?.paid_at || new Date().toISOString())}</div>
            <div><span className="text-gray-500">Customer:</span> {detail.customer_name || "Walk-in"}</div>
            <div className="text-right"><span className="text-gray-500">Type:</span> {isGram ? `Gram (${detail.metal ?? ""} ${detail.purity ?? ""})` : "Value (11+1)"}</div>
          </div>

          {/* Highlighted installment (collection receipt) */}
          {here && (
            <div className="mt-3 rounded border border-black/30 bg-gray-50 px-3 py-2">
              <div className="flex justify-between">
                <span>Installment <b>{here.seq}</b> of {detail.installments_required}</span>
                <span className="font-bold">{formatINR(here.amount)}</span>
              </div>
              <div className="flex justify-between text-[11px] text-gray-600 mt-0.5">
                <span>Paid via {MODE_LABEL[here.payment_mode || "cash"] || here.payment_mode}{here.reference ? ` · ${here.reference}` : ""}</span>
                {isGram && here.grams && <span>{Number(here.grams).toFixed(3)} g @ {formatINR(here.rate_used || "0")}/g</span>}
              </div>
            </div>
          )}

          {/* Running totals */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 text-[12px] border-t border-gray-300 pt-2">
            <div><span className="text-gray-500">Monthly:</span> {formatINR(detail.monthly_amount)}</div>
            <div className="text-right"><span className="text-gray-500">Installments:</span> {paid} / {detail.installments_required}{balance ? ` (${balance} left)` : ""}</div>
            <div><span className="text-gray-500">Total paid:</span> <b>{formatINR(detail.total_paid)}</b></div>
            {isGram
              ? <div className="text-right"><span className="text-gray-500">Total grams:</span> <b>{Number(detail.total_grams).toFixed(3)} g</b></div>
              : <div className="text-right"><span className="text-gray-500">Status:</span> {detail.status}</div>}
            {detail.status === "matured" && !isGram && detail.maturity_value && (
              <div className="col-span-2"><span className="text-gray-500">Maturity value (with bonus):</span> <b>{formatINR(detail.maturity_value)}</b></div>
            )}
            {detail.status === "matured" && isGram && detail.average_rate && (
              <div className="col-span-2"><span className="text-gray-500">Average rate:</span> <b>{formatINR(detail.average_rate)}/g</b></div>
            )}
          </div>

          {/* Passbook table */}
          <table className="w-full text-[11px] mt-3 border-t border-gray-300">
            <thead>
              <tr className="text-gray-500">
                <th className="text-left py-1">#</th>
                <th className="text-left py-1">Date</th>
                <th className="text-left py-1">Mode</th>
                {isGram && <th className="text-right py-1">Grams</th>}
                <th className="text-right py-1">Amount</th>
              </tr>
            </thead>
            <tbody>
              {detail.installments.map((i) => (
                <tr key={i.seq} className={i.seq === seq ? "font-semibold" : ""}>
                  <td className="py-0.5">{i.seq}</td>
                  <td className="py-0.5">{formatDate(i.paid_at)}</td>
                  <td className="py-0.5">{MODE_LABEL[i.payment_mode || "cash"] || i.payment_mode}</td>
                  {isGram && <td className="py-0.5 text-right">{i.grams ? Number(i.grams).toFixed(3) : "—"}</td>}
                  <td className="py-0.5 text-right">{formatINR(i.amount)}</td>
                </tr>
              ))}
              {detail.installments.length === 0 && (
                <tr><td colSpan={isGram ? 5 : 4} className="py-2 text-center text-gray-500">No installments yet.</td></tr>
              )}
            </tbody>
          </table>

          <div className="flex justify-between items-end mt-8 text-[11px]">
            <div className="text-gray-500">Thank you for saving with us.</div>
            <div className="text-center"><div className="border-t border-black w-32 pt-0.5">Authorised signatory</div></div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
