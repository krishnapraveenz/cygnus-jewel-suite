import { useEffect, useState } from "react";
import { Scale, ArrowDownToLine, ArrowUpFromLine, AlertTriangle } from "lucide-react";
import * as api from "@/api";
import type { MetalAccountRow } from "@/api";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const g = (v: string) => `${Number(v).toFixed(3)} g`;

export function MetalAccount() {
  const [rows, setRows] = useState<MetalAccountRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.metalAccount().then(setRows).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, []);

  // Only metals with any activity.
  const active = rows.filter(
    (r) =>
      Number(r.scrap_taken_in_fine) ||
      Number(r.melted_recovered_fine) ||
      Number(r.issued_to_smith_fine) ||
      Number(r.scrap_on_hand_fine),
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Old Metal Account</h2>
        <p className="text-sm text-muted-foreground">
          Old-gold / scrap fine-metal reconciliation — what came in as old gold, what was melted/refined, and what smiths still hold.
        </p>
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

      {(active.length ? active : rows).map((r) => {
        const pool = Number(r.refined_pool_fine);
        const holding = Number(r.smith_holding_fine);
        return (
          <Card key={r.metal} className="overflow-hidden">
            <div className="border-b border-border px-4 py-2.5 text-sm font-semibold capitalize flex items-center gap-2">
              <Scale className="w-4 h-4" /> {r.metal}
              <span className="ml-auto text-xs font-normal text-muted-foreground">all weights = fine (pure) grams</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-px bg-border">
              <Metric icon={<ArrowDownToLine className="w-4 h-4" />} label="Scrap on hand" value={g(r.scrap_on_hand_fine)} sub={`${Number(r.scrap_on_hand_gross).toFixed(3)} g gross`} tone="in" />
              <Metric label="Scrap taken in (total)" value={g(r.scrap_taken_in_fine)} />
              <Metric label="Melted → recovered" value={g(r.melted_recovered_fine)} sub={`loss ${g(r.melt_loss)}`} />
              <Metric
                label="Refined pool"
                value={g(r.refined_pool_fine)}
                tone={pool < 0 ? "warn" : "in"}
                sub={pool < 0 ? "issued more than melted — check" : "available to issue"}
              />
              <Metric icon={<ArrowUpFromLine className="w-4 h-4" />} label="Issued to smiths" value={g(r.issued_to_smith_fine)} tone="out" />
              <Metric label="Received from smiths" value={g(r.received_from_smith_fine)} tone="in" />
              <Metric
                label="Smiths still holding"
                value={g(r.smith_holding_fine)}
                tone={holding > 0 ? "warn" : "default"}
                sub={holding > 0 ? "metal out at smiths" : "settled"}
              />
              <Metric label="Wastage" value={g(r.wastage_fine)} />
            </div>
          </Card>
        );
      })}

      {rows.length === 0 && !error && (
        <Card className="p-10 text-center text-muted-foreground">
          <Scale className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <div className="text-sm">No metal activity yet.</div>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Built from old-gold lots, melt batches and smith jobs. A negative refined pool or a large smith-holding balance flags metal that needs reconciling.
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = "default",
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "in" | "out" | "warn";
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-base font-semibold tabular-nums",
          tone === "in" && "text-success",
          tone === "out" && "text-primary",
          tone === "warn" && "text-destructive",
        )}
      >
        {value}
      </div>
      {sub && (
        <div className={cn("text-[11px]", tone === "warn" ? "text-destructive" : "text-muted-foreground")}>
          {tone === "warn" && <AlertTriangle className="inline w-3 h-3 mr-0.5 -mt-0.5" />}
          {sub}
        </div>
      )}
    </div>
  );
}
