import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");
const toISO = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/**
 * Date field with a self-contained calendar popup (no native <input type=date>,
 * which is unreliable in the webview). Displays the date in the app's configured
 * format; emits ISO `YYYY-MM-DD`.
 */
export function DateField({
  value,
  onChange,
  className,
  placeholder = "Select date",
}: {
  value: string; // ISO YYYY-MM-DD
  onChange: (iso: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const base = value ? new Date(`${value}T00:00:00`) : new Date();
  const [view, setView] = useState({ y: base.getFullYear(), m: base.getMonth() });

  // Re-centre on the selected month each time the popup opens.
  useEffect(() => {
    if (open) {
      const b = value ? new Date(`${value}T00:00:00`) : new Date();
      setView({ y: b.getFullYear(), m: b.getMonth() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const first = new Date(view.y, view.m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const now = new Date();
  const todayISO = toISO(now.getFullYear(), now.getMonth(), now.getDate());
  const monthName = first.toLocaleString("en-US", { month: "long" });

  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  function pick(d: number) {
    onChange(toISO(view.y, view.m, d));
    setOpen(false);
  }
  function shift(delta: number) {
    const nm = new Date(view.y, view.m + delta, 1);
    setView({ y: nm.getFullYear(), m: nm.getMonth() });
  }

  return (
    <div className={cn("relative h-8 w-40", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-2.5 text-sm hover:bg-accent/40"
      >
        <span className={value ? "" : "text-muted-foreground"}>{value ? formatDate(value) : placeholder}</span>
        <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-64 rounded-md border border-border bg-background p-2 shadow-lg">
          <div className="flex items-center justify-between px-1 pb-2">
            <button type="button" onClick={() => shift(-1)} className="rounded p-1 hover:bg-accent">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="text-sm font-medium">
              {monthName} {view.y}
            </div>
            <button type="button" onClick={() => shift(1)} className="rounded p-1 hover:bg-accent">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-muted-foreground">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) =>
              d === null ? (
                <div key={`e${i}`} />
              ) : (
                <button
                  key={d}
                  type="button"
                  onClick={() => pick(d)}
                  className={cn(
                    "h-7 rounded text-xs hover:bg-accent",
                    toISO(view.y, view.m, d) === value && "bg-primary text-primary-foreground hover:bg-primary",
                    toISO(view.y, view.m, d) === todayISO &&
                      toISO(view.y, view.m, d) !== value &&
                      "ring-1 ring-primary/50",
                  )}
                >
                  {d}
                </button>
              ),
            )}
          </div>
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={() => {
                onChange(todayISO);
                setOpen(false);
              }}
              className="rounded px-2 py-0.5 text-xs text-primary hover:bg-accent"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
