import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, X } from "lucide-react";
import type { PurchaseDetail } from "@/api";
import { Button } from "@/components/ui/button";
import { formatDate, formatINR } from "@/lib/utils";
import { DEFAULT_PROFILE, injectPageStyle, loadProfile, profileVars, type PrintProfile } from "@/lib/printProfile";
import { getCompany, loadCompany } from "@/lib/company";

/** Printable A4 purchase bill / voucher (supplier purchase). Mirrors the invoice layout
 *  but from the buyer's side — the party is the supplier we owe. */
export function PurchaseBillPrint({ bill, onClose }: { bill: PurchaseDetail; onClose: () => void }) {
  const [profile, setProfile] = useState<PrintProfile>(DEFAULT_PROFILE);
  useEffect(() => {
    loadProfile().then(setProfile).catch(() => {});
  }, []);
  useEffect(() => {
    injectPageStyle(profile);
  }, [profile]);

  const [co, setCo] = useState(getCompany());
  useEffect(() => {
    loadCompany().then(setCo).catch(() => {});
  }, []);
  const coAddr = [co.address1, co.address2, co.city].filter(Boolean).join(", ") + (co.pincode ? ` — ${co.pincode}` : "");
  const coLine3 = [co.gstin ? `GSTIN: ${co.gstin}` : "", co.phone].filter(Boolean).join(" · ");

  const n = (s: string | null | undefined) => Number(s || 0);
  const activeLines = bill.lines; // include returned lines but mark them

  return createPortal(
    <div className="print-root fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-8" onClick={onClose}>
      <div className="a4-sheet bg-card rounded-lg shadow-xl" style={profileVars(profile)} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border no-print">
          <h3 className="text-sm font-semibold">Purchase Bill {bill.document_no}</h3>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            <Button size="sm" variant="ghost" onClick={onClose}><X className="w-4 h-4" /></Button>
          </div>
        </div>

        <div className="print-area text-black bg-white">
          <div className="a4-page">
            {/* Buyer (us) / title */}
            <div className="flex items-start justify-between border-b-2 border-black pb-3">
              <div>
                <div className="text-lg font-bold">{co.name || co.legalName || "Your Jewellery Store"}</div>
                <div className="text-xs text-gray-600">{coAddr || "—"}</div>
                <div className="text-xs text-gray-600">{coLine3 || "—"}</div>
              </div>
              <div className="text-right">
                <div className="text-base font-bold uppercase tracking-wide">Purchase Bill</div>
                <div className="text-xs">No: <b>{bill.document_no}</b></div>
                <div className="text-xs">Date: {formatDate(bill.created_at)}</div>
                <div className="text-xs">{bill.bill_kind === "b2b" ? "B2B / Wholesale" : "Local"}{bill.rcm ? " · RCM" : ""}</div>
              </div>
            </div>

            {/* Supplier */}
            <div className="flex justify-between py-3 text-xs">
              <div>
                <div className="text-gray-500 uppercase text-[10px]">Supplier</div>
                <div className="font-medium">{bill.party_name || "—"}</div>
                {bill.supplier_invoice_no && <div className="text-gray-600">Supplier inv: {bill.supplier_invoice_no}</div>}
              </div>
              <div className="text-right">
                <div className="text-gray-500 uppercase text-[10px]">Status</div>
                <div className="capitalize">{bill.status}</div>
              </div>
            </div>

            {/* Lines */}
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="bg-gray-100 border-y border-gray-400">
                  <th className="text-left p-1.5 border-r border-gray-300">#</th>
                  <th className="text-left p-1.5 border-r border-gray-300">Description</th>
                  <th className="text-left p-1.5 border-r border-gray-300">Mode</th>
                  <th className="text-left p-1.5 border-r border-gray-300">HSN</th>
                  <th className="text-right p-1.5 border-r border-gray-300">Gross</th>
                  <th className="text-right p-1.5 border-r border-gray-300">St.wt</th>
                  <th className="text-right p-1.5 border-r border-gray-300">Net</th>
                  <th className="text-right p-1.5 border-r border-gray-300">Fine</th>
                  <th className="text-right p-1.5 border-r border-gray-300">Making</th>
                  <th className="text-right p-1.5 border-r border-gray-300">Stone ₹</th>
                  <th className="text-right p-1.5 border-r border-gray-300">GST%</th>
                  <th className="text-right p-1.5">Amount</th>
                </tr>
              </thead>
              <tbody>
                {activeLines.map((l, i) => (
                  <tr key={l.id} className={`border-b border-gray-200 ${l.returned ? "text-gray-400 line-through" : ""}`}>
                    <td className="p-1.5 border-r border-gray-200">{i + 1}</td>
                    <td className="p-1.5 border-r border-gray-200">
                      {l.description}
                      {l.returned ? <span className="text-red-600 no-underline"> (returned)</span> : null}
                    </td>
                    <td className="p-1.5 border-r border-gray-200">{l.pricing_mode}</td>
                    <td className="p-1.5 border-r border-gray-200">{l.hsn || "—"}</td>
                    <td className="p-1.5 border-r border-gray-200 text-right">{Number(l.gross_weight).toFixed(3)}</td>
                    <td className="p-1.5 border-r border-gray-200 text-right">{Number(l.stone_weight).toFixed(3)}</td>
                    <td className="p-1.5 border-r border-gray-200 text-right">{Number(l.net_weight).toFixed(3)}</td>
                    <td className="p-1.5 border-r border-gray-200 text-right">{Number(l.chargeable_fine).toFixed(3)}</td>
                    <td className="p-1.5 border-r border-gray-200 text-right">{formatINR(l.making_amount)}</td>
                    <td className="p-1.5 border-r border-gray-200 text-right">{formatINR(l.stone_value)}</td>
                    <td className="p-1.5 border-r border-gray-200 text-right">{l.gst_rate}</td>
                    <td className="p-1.5 text-right font-medium">{formatINR(l.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div className="flex justify-end mt-4 avoid-break">
              <table className="text-[12px] min-w-[260px]">
                <tbody>
                  <tr><td className="py-0.5 pr-6 text-gray-600">Metal + making + stones</td><td className="py-0.5 text-right font-mono">{formatINR(n(bill.subtotal) + n(bill.making_total) + n(bill.stone_total))}</td></tr>
                  <tr><td className="py-0.5 pr-6 text-gray-600">GST</td><td className="py-0.5 text-right font-mono">{formatINR(bill.tax_total)}</td></tr>
                  <tr className="border-t border-black"><td className="py-1 pr-6 font-semibold">Bill total</td><td className="py-1 text-right font-mono font-semibold">{formatINR(bill.total)}</td></tr>
                  <tr><td className="py-0.5 pr-6 text-gray-600">Total fine</td><td className="py-0.5 text-right font-mono">{Number(bill.total_fine).toFixed(3)} g</td></tr>
                  <tr><td className="py-0.5 pr-6 text-gray-600">Paid</td><td className="py-0.5 text-right font-mono">{formatINR(bill.paid_total)}</td></tr>
                  <tr className="border-t border-gray-400"><td className="py-1 pr-6 font-semibold">Balance payable</td><td className="py-1 text-right font-mono font-semibold">{formatINR(bill.balance)}</td></tr>
                </tbody>
              </table>
            </div>

            {/* Payments */}
            {bill.payments.length > 0 && (
              <div className="mt-4 text-[11px] avoid-break">
                <div className="text-[10px] uppercase text-gray-500 mb-1">Payments</div>
                {bill.payments.map((p, i) => (
                  <div key={i} className="flex justify-between border-b border-gray-100 py-0.5">
                    <span className="capitalize">{p.mode}{p.reference ? ` · ${p.reference}` : ""} · {formatDate(p.created_at)}</span>
                    <span className="font-mono">{formatINR(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-8 flex justify-between text-[11px] text-gray-500 avoid-break">
              <div>Received the above goods in order.</div>
              <div className="text-right">For {co.name || "us"}<div className="mt-6 border-t border-gray-400 pt-1">Authorised signatory</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
