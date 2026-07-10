import type { LucideIcon } from "lucide-react";

interface PlaceholderProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

/** Consistent empty-state used by modules whose backend wiring is pending. */
export function ModulePlaceholder({ icon: Icon, title, description }: PlaceholderProps) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">Module</p>
      </div>
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground rounded-lg border border-dashed border-border">
        <Icon className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs mt-1 max-w-md text-center">{description}</p>
        <span className="mt-4 inline-flex items-center rounded-full bg-warning/10 text-warning px-2.5 py-0.5 text-[11px] font-medium">
          Backend wiring in progress
        </span>
      </div>
    </div>
  );
}
