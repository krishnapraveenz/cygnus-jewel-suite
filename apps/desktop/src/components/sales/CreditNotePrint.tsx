import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, X } from "lucide-react";
import * as api from "@/api";
import type { CreditNoteDetail } from "@/api";
import { Button } from "@/components/ui/button";
import { getCompany } from "@/lib/company";
import { formatDate, formatINR } from "@/lib/utils";

export function CreditNotePrint({ creditNoteId, onClose }: { creditNoteId: number; onClose: () => void }) {
  const [cn, setCn] = useState<CreditNoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const co = getCompany();

  useEffect(() => {
    api.getCreditNote(creditNoteId).then(setCn).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [creditNoteId]);

  if (error) return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-card rounded-lg p-6 text-sm text-destructive">{error}</div>
    </div>, document.body);

  if (!cn) return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-card rounded-lg p-6 text-sm text-muted-foreground">Loading…</div>
    </div>, document.body);

  const shop = co.name || co.legalName || "Your Jewellery Store";
  const addr = [co.address1, co.address2, co.city, co.pincode].filter(Boolean).join(", ");

  return createPortal(
    <div className="print-root fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-2.5 no-print">
          <div className="text-sm font-medium">Credit Note — {cn.document_no}</div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="print-area p-8 text-black bg-white" style={{ fontSize: 12 }}>
          <div className="a4-sheet">
            <div className="a4-page">
              {/* Header */}
              <div className="flex items-start justify-between border-b-2 border-black pb-3 mb-4">
                <div>
                  <div className="text-lg font-bold">{shop}</div>
                  {addr && <div className="text-xs text-gray-600">{addr}</div>}
                  {co.gstin && <div className="text-xs">GSTIN: {co.gstin}</div>}
                  {co.phone && <div className="text-xs">Ph: {co.phone}</div>}
                </div>
                <div className="text-right">
                  <div className="text-base font-bold uppercase tracking-wide">Credit Note</div>
                  <div className="text-xs">No: <b>{cn.document_no || "—"}</b></div>
                  <div className="text-xs">Date: {formatDate(cn.created_at)}</div>
                  <div className="text-xs">Original Invoice: <b>{cn.original_invoice_no || "—"}</b></div>
                </div>
              </div>

              {/* Customer */}
              <div className="mb-4 text-xs">
                <span className="text-gray-600">Customer:</span> <b>{cn.customer_name || "Walk-in"}</b>
              </div>

              {/* Reason */}
              <div className="mb-4 text-xs">
                <span className="text-gray-600">Reason:</span> {cn.reason}{cn.reason_detail ? ` — ${cn.reason_detail}` : ""}
              </div>

              {/* Lines table */}
              <table className="w-full text-xs mb-4 border-collapse">
                <thead>
                  <tr className="border-b border-black">
                    <th className="text-left py-1">#</th>
                    <th className="text-left py-1">Item / Description</th>
                    <th className="text-right py-1">Taxable</th>
                    <th className="text-right py-1">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {cn.lines.map((l, i) => (
                    <tr key={i} className="border-b border-gray-300">
                      <td className="py-1">{i + 1}</td>
                      <td className="py-1">{l.description}</td>
                      <td className="py-1 text-right">{formatINR(l.taxable_value)}</td>
                      <td className="py-1 text-right">{formatINR(l.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Amounts */}
              <div className="flex justify-end">
                <div className="w-64 text-xs space-y-1">
                  <div className="flex justify-between"><span>Subtotal (taxable)</span><span>{formatINR(cn.subtotal)}</span></div>
                  <div className="flex justify-between"><span>Tax (GST)</span><span>{formatINR(cn.tax_total)}</span></div>
                  <div className="flex justify-between font-bold border-t border-black pt-1"><span>Credit note total</span><span>{formatINR(cn.total)}</span></div>
                  {Number(cn.deduction) > 0 && <div className="flex justify-between text-gray-600"><span>Less: deduction</span><span>− {formatINR(cn.deduction)}</span></div>}
                  <div className="flex justify-between font-bold"><span>Net amount to customer</span><span>{formatINR(cn.net_refund)}</span></div>
                </div>
              </div>

              {/* Settlement */}
              <div className="mt-6 border-t border-gray-300 pt-3 text-xs">
                <b>Settlement:</b> {cn.refund_mode === "store_credit" ? "Store credit (advance held for next purchase)" : `Refund via ${cn.refund_mode || "cash"}`}
                — <b>{formatINR(cn.net_refund)}</b>
              </div>

              {/* Footer */}
              <div className="mt-auto pt-8 text-[10px] text-gray-500 border-t border-gray-200 mt-8 pt-2">
                This is a computer-generated credit note. No signature required.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Small advance/store-credit receipt for the customer. */
export function AdvanceReceipt({ amount, customerName, creditNoteNo, onClose }: {
  amount: string; customerName: string; creditNoteNo: string; onClose: () => void;
}) {
  const co = getCompany();
  const shop = co.name || co.legalName || "Your Jewellery Store";

  return createPortal(
    <div className="print-root fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-2.5 no-print">
          <div className="text-sm font-medium">Store Credit Receipt</div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="print-area p-6 text-black bg-white text-center" style={{ fontSize: 12 }}>
          <div className="font-bold text-base mb-1">{shop}</div>
          <div className="text-xs text-gray-600 mb-4">Store Credit / Advance Receipt</div>
          <div className="border border-black rounded-md p-4 inline-block text-left">
            <div className="text-xs mb-2"><span className="text-gray-600">Customer:</span> <b>{customerName || "Walk-in"}</b></div>
            <div className="text-xs mb-2"><span className="text-gray-600">Against:</span> Credit Note {creditNoteNo}</div>
            <div className="text-xl font-bold text-center my-3">{formatINR(amount)}</div>
            <div className="text-xs text-gray-600 text-center">Credit balance available for next purchase</div>
          </div>
          <div className="text-[10px] text-gray-400 mt-4">{formatDate(new Date().toISOString().slice(0, 10))} · Computer generated</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
