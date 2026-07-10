import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { InvoiceForm } from "./InvoiceForm";
import { Invoices } from "./Invoices";
import { Estimates } from "./Estimates";
import { SalesReturn } from "./SalesReturn";
import { ApprovalOut } from "./ApprovalOut";

type Tab = "invoices" | "estimates" | "return" | "approval";
type FormMode = "invoice" | "estimate";

const tabs: { id: Tab; label: string }[] = [
  { id: "invoices", label: "Invoices" },
  { id: "estimates", label: "Estimates" },
  { id: "return", label: "Sales Return" },
  { id: "approval", label: "On Approval (Out)" },
];

export function SalesLayout() {
  const [tab, setTab] = useState<Tab>("invoices");
  const [form, setForm] = useState<FormMode | null>(null);
  const [reload, setReload] = useState(0); // bump to refresh the active list

  function openForm(mode: FormMode) {
    setForm(mode);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Sales</h2>
        <p className="text-sm text-muted-foreground">Invoices, estimates, returns and take-home trials</p>
      </div>

      <div className="inline-flex h-9 items-center justify-start gap-0.5 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap px-3 py-2 text-sm transition-colors",
              tab === t.id ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div>
        {tab === "invoices" && <Invoices reloadKey={reload} embedded onNew={() => openForm("invoice")} />}
        {tab === "estimates" && <Estimates reloadKey={reload} onNew={() => openForm("estimate")} />}
        {tab === "return" && <SalesReturn />}
        {tab === "approval" && <ApprovalOut />}
      </div>

      {/* Full-screen overlay form */}
      {form && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col">
          <div className="flex items-center justify-between border-b border-border px-6 py-3 bg-card">
            <div className="text-lg font-semibold">{form === "invoice" ? "New Invoice" : "New Estimate"}</div>
            <button onClick={() => setForm(null)} className="rounded-md p-1.5 hover:bg-accent" title="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            <InvoiceForm mode={form} onPosted={() => setReload((n) => n + 1)} />
          </div>
        </div>
      )}
    </div>
  );
}
