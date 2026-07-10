import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import JsBarcode from "jsbarcode";
import { Printer, X } from "lucide-react";
import type { ItemTag } from "@/api";
import { Button } from "@/components/ui/button";
import { getCompany } from "@/lib/company";

/** One printable barcode tag per item. Prints on a label roll / A4 sheet of labels. */
export function TagSheet({ tags, onClose }: { tags: ItemTag[]; onClose: () => void }) {
  const co = getCompany();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Render a Code128 barcode into each tag's <svg>.
    rootRef.current?.querySelectorAll<SVGElement>("svg[data-code]").forEach((el) => {
      const code = el.getAttribute("data-code") || "";
      try {
        JsBarcode(el, code, { format: "CODE128", width: 1.4, height: 34, fontSize: 11, margin: 0, displayValue: true });
      } catch {
        /* ignore invalid code */
      }
    });
  }, [tags]);

  const shop = co.name || co.legalName || "Jewellery";

  return createPortal(
    <div className="print-root fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-card rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 no-print">
          <div className="text-sm font-medium">Print tags · {tags.length} item(s)</div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            <button onClick={onClose} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
          </div>
        </div>

        <div ref={rootRef} className="print-area bg-white text-black p-3">
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <div key={t.id} className="border border-black/40 rounded-sm px-2 py-1.5" style={{ width: 190 }}>
                <div className="text-[10px] font-semibold leading-tight truncate">{shop}</div>
                <svg data-code={t.sku} className="w-full" />
                <div className="text-[9px] leading-tight flex justify-between">
                  <span>{t.purity ?? t.metal}</span>
                  <span>G {Number(t.gross_weight).toFixed(3)} · N {Number(t.net_weight).toFixed(3)}</span>
                </div>
                <div className="text-[9px] leading-tight flex justify-between text-gray-700">
                  <span>{Number(t.stone_weight) > 0 ? `stone ${Number(t.stone_weight).toFixed(3)}g` : ""}</span>
                  <span>{t.huid ? `HUID ${t.huid}` : ""}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
