import { useState } from "react";
import { Server, User, Lock, Globe, ShieldCheck } from "lucide-react";
import * as api from "@/api";

// --- Developer / copyright footer ---
const DEVELOPER = "Bytesync Technologies and Communications";
const WEBSITE_URL = "https://cygnusjewelsuite.bytesync.in";

export function LoginScreen({ onLogin }: { onLogin: (role: string) => void }) {
  const [base, setBase] = useState(api.getBase());
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      api.setBase(base);
      const r = await api.loginFull(username, password);
      onLogin(r.role);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  const field =
    "flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="relative h-screen flex items-center justify-center overflow-hidden bg-gradient-to-b from-muted/40 via-background to-muted/30 p-4">
      <JewelleryBackdrop />
      <div className="relative z-10 w-full max-w-sm">
        {/* Brand header */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="grid place-items-center w-24 h-24 rounded-2xl bg-slate-900 shadow-lg ring-1 ring-black/10 mb-4">
            <img src="/logo.png" alt="Cygnus Jewel Suite" className="w-20 h-20 object-contain" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight leading-none">
            <span className="text-foreground">Cygnus</span>{" "}
            <span className="text-gold">Jewel Suite</span>
          </h1>
          <div className="mt-2 h-px w-16 bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
          <p className="text-sm text-muted-foreground mt-2">Jewellery Sales &amp; Management</p>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border border-border bg-card shadow-xl p-6">
          <div className="mb-4">
            <h2 className="text-base font-semibold">Sign in</h2>
            <p className="text-xs text-muted-foreground">Enter your credentials to continue</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-3.5">
            <div className="space-y-1">
              <label htmlFor="server" className="text-xs font-medium text-muted-foreground">Server</label>
              <div className="relative">
                <Server className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  id="server"
                  type="text"
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  className={field}
                  placeholder="http://server-ip:8787"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="username" className="text-xs font-medium text-muted-foreground">Username</label>
              <div className="relative">
                <User className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={field}
                  placeholder="Enter username"
                  autoFocus
                  required
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="password" className="text-xs font-medium text-muted-foreground">Password</label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={field}
                  placeholder="Enter password"
                  required
                />
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="inline-flex items-center justify-center w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary-hover disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {loading ? "Signing in…" : "Sign In"}
            </button>
          </form>

          <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5 text-green-600 dark:text-green-500" />
            Secure local-network mode
          </div>
        </div>

        {/* Developer footer */}
        <div className="mt-6 text-center space-y-1">
          <a
            href={WEBSITE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <Globe className="w-3.5 h-3.5" />
            Developed by {DEVELOPER}
          </a>
          <p className="text-[10px] text-muted-foreground/70">
            © {new Date().getFullYear()} {DEVELOPER}. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Small jewellery band repeated continuously across the very top, fading into the page. */
function JewelleryBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 overflow-hidden select-none">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url(/login-top.png)",
          backgroundRepeat: "repeat-x",
          backgroundSize: "auto 100%",
          backgroundPosition: "left top",
        }}
      />
    </div>
  );
}

