import { getCompany } from "@/lib/company";
import { useEffect, useState } from "react";

interface StatusBarProps {
  role: string;
  base: string;
  online: boolean;
  clients?: number;
}

/** This PC hosts the backend (server / standalone) when the API address is local;
 *  otherwise it is a counter connecting to a remote shop server. */
function isLocalBase(base: string): boolean {
  try {
    const h = new URL(base).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
  } catch {
    return true;
  }
}

export function StatusBar({ role, base, online, clients = 0 }: StatusBarProps) {
  const isServer = isLocalBase(base);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.version) setUpdateVersion(detail.version);
    };
    window.addEventListener("cygnus:update-available", handler);
    return () => window.removeEventListener("cygnus:update-available", handler);
  }, []);

  return (
    <footer className="flex items-center h-6 px-4 border-t border-border bg-muted/30 text-[10px] text-muted-foreground select-none shrink-0">
      <span>Cygnus Jewel Suite v0.1</span>
      <span className="mx-2">•</span>
      <span>{getCompany().name?.trim() || "Main Showroom"}</span>
      <span className="mx-2">•</span>
      <span className="capitalize">{role || "—"}</span>
      {updateVersion && (
        <>
          <span className="mx-2">•</span>
          <span className="px-1.5 py-0.5 rounded font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 animate-pulse" title="Go to Settings → General to update">
            Update v{updateVersion} available
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-3">
        <span
          className={
            isServer
              ? "px-1.5 py-0.5 rounded font-semibold bg-primary/10 text-primary"
              : "px-1.5 py-0.5 rounded font-semibold bg-blue-500/10 text-blue-600 dark:text-blue-400"
          }
          title={isServer ? "This PC runs the database/backend" : "Connected to a shop server"}
        >
          {isServer ? "Server" : "Client"}
        </span>
        {isServer && (
          <span title="Counter PCs connected to this server (active in the last minute)">
            {clients} client{clients === 1 ? "" : "s"} connected
          </span>
        )}
        <span className="text-muted-foreground/80">{base}</span>
        {online ? (
          <span className="text-green-600 dark:text-green-400">● Connected</span>
        ) : (
          <span className="text-amber-600 dark:text-amber-400">● Offline</span>
        )}
      </span>
    </footer>
  );
}
