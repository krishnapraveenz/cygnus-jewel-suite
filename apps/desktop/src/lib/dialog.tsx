import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Info, HelpCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * App-wide dialogs — a single styled modal used for every confirm/alert, so we never
 * fall back to the ugly native browser dialog. Imperative API (works anywhere):
 *
 *   const ok = await confirm({ title, message, danger: true });
 *   await alertDialog({ title, message });
 */
export type DialogKind = "confirm" | "alert";
export interface DialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  tone?: "default" | "danger" | "info";
}
interface DialogReq extends DialogOptions {
  id: number;
  kind: DialogKind;
  resolve: (v: boolean) => void;
}

let current: DialogReq | null = null;
let seq = 0;
const listeners = new Set<(d: DialogReq | null) => void>();
function emit() {
  listeners.forEach((l) => l(current));
}

export function confirm(opts: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    current = { ...opts, id: ++seq, kind: "confirm", resolve };
    emit();
  });
}

export function alertDialog(opts: DialogOptions): Promise<void> {
  return new Promise((resolve) => {
    current = { ...opts, id: ++seq, kind: "alert", resolve: () => resolve() };
    emit();
  });
}

export function DialogHost() {
  const [d, setD] = useState<DialogReq | null>(current);
  useEffect(() => {
    const l = (x: DialogReq | null) => setD(x);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!d) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  if (!d) return null;

  const close = (v: boolean) => {
    d.resolve(v);
    if (current?.id === d.id) {
      current = null;
      emit();
    }
  };

  const tone = d.tone ?? (d.danger ? "danger" : d.kind === "alert" ? "info" : "default");
  const Icon = tone === "danger" ? AlertTriangle : tone === "info" ? Info : HelpCircle;
  const iconClass =
    tone === "danger" ? "text-destructive" : tone === "info" ? "text-primary" : "text-muted-foreground";

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={() => close(false)}
    >
      <Card className="w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex gap-3 p-5">
          <div className={cn("mt-0.5 shrink-0", iconClass)}>
            <Icon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{d.title ?? (d.kind === "alert" ? "Notice" : "Please confirm")}</div>
            <p className="mt-1 text-sm text-muted-foreground whitespace-pre-line">{d.message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {d.kind === "confirm" && (
            <Button variant="outline" size="sm" onClick={() => close(false)}>
              {d.cancelText ?? "Cancel"}
            </Button>
          )}
          <Button
            size="sm"
            variant={tone === "danger" ? "destructive" : "default"}
            onClick={() => close(true)}
            autoFocus
          >
            {d.confirmText ?? (d.kind === "alert" ? "OK" : "Confirm")}
          </Button>
        </div>
      </Card>
    </div>,
    document.body,
  );
}
