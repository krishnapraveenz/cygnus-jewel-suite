import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Month picker matching DateField's look (no native <input type=month>, unreliable in
 * the webview). Emits `YYYY-MM`; displays "Mon YYYY".
 */
export function MonthField({
  value,
  onChange,
  className,
  placeholder = "Select month",
}: {
  value: string; // YYYY-MM
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = new Date();
  const [y, m] = value ? value.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
  const [viewY, setViewY] = useState(y);

  useEffect(() => {
    if (open) {
      const yy = value ? Number(value.split("-")[0]) : now.getFullYear();
      setViewY(yy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const label = value ? `${MONTHS[m - 1]} ${y}` : placeholder;
  function pick(mi: number) {
    onChange(`${viewY}-${pad(mi)}`);
    setOpen(false);
  }

  return (
    <div className={cn("relative h-8 w-40", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-2.5 text-sm hover:bg-accent/40"
      >
        <span className={value ? "" : "text-muted-foreground"}>{label}</span>
        <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-56 rounded-md border border-border bg-background p-2 shadow-lg">
          <div className="flex items-center justify-between px-1 pb-2">
            <button type="button" onClick={() => setViewY((v) => v - 1)} className="rounded p-1 hover:bg-accent">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="text-sm font-medium">{viewY}</div>
            <button type="button" onClick={() => setViewY((v) => v + 1)} className="rounded p-1 hover:bg-accent">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {MONTHS.map((mn, i) => (
              <button
                key={mn}
                type="button"
                onClick={() => pick(i + 1)}
                className={cn(
                  "h-8 rounded text-xs hover:bg-accent",
                  `${viewY}-${pad(i + 1)}` === value && "bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                {mn}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
