import { useEffect, useState } from "react";
import { Plus, X, KeyRound, ShieldCheck, UserCog, User as UserIcon, Trash2, Calculator } from "lucide-react";
import * as api from "@/api";
import type { AppUser, UserRole } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { confirm, alertDialog } from "@/lib/dialog";
import { cn, formatDate } from "@/lib/utils";

const ROLES: UserRole[] = ["owner", "manager", "accountant", "cashier"];

const ROLE_INFO: Record<UserRole, { label: string; icon: typeof ShieldCheck; blurb: string; can: string[] }> = {
  owner: {
    label: "Owner",
    icon: ShieldCheck,
    blurb: "Full control of the business. The only role that can manage users and override cost floors.",
    can: [
      "Everything a Manager can do",
      "Manage users & roles (create, disable, reset passwords)",
      "Override sell-below-cost limits",
      "All settings, accounts, banking and day-close",
    ],
  },
  manager: {
    label: "Manager",
    icon: UserCog,
    blurb: "Runs day-to-day operations across all modules — but cannot manage user accounts.",
    can: [
      "Sales, purchases, returns & pricing",
      "Inventory, tagging, old gold & workshop",
      "Parties, schemes, advances",
      "Accounts, banking, day-close & reports",
      "Settings (except Users & Roles)",
    ],
  },
  accountant: {
    label: "Accountant",
    icon: Calculator,
    blurb: "Financial back-office: books, banking, day-close and reports — no sales, purchases or user control.",
    can: [
      "Accounts (P&L, Balance Sheet, Trial Balance, Journal, Ledger)",
      "Expenses, receipts & opening balances",
      "Bank accounts, transfers, reconciliation & statement import",
      "Day Close (cash + stock) and all reports / GST",
      "Read-only stock for valuation",
    ],
  },
  cashier: {
    label: "Cashier",
    icon: UserIcon,
    blurb: "Front-counter billing and customer handling. Restricted from back-office and financial controls.",
    can: [
      "Create sales & process returns",
      "Live price preview",
      "Read stock",
      "Manage customers & approvals",
      "Enroll / collect on schemes",
    ],
  },
};

const roleBadge = (r: UserRole) =>
  r === "owner" ? "default" : r === "manager" || r === "accountant" ? "secondary" : "outline";

export function Users() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [meId, setMeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  // Add-user form
  const [adding, setAdding] = useState(false);
  const [nu, setNu] = useState<{ username: string; password: string; role: UserRole }>({
    username: "",
    password: "",
    role: "cashier",
  });

  // Reset-password inline
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPw, setResetPw] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [list, me] = await Promise.all([api.listUsers(), api.whoami()]);
      setUsers(list);
      setMeId(me.id);
    } catch (e) {
      await alertDialog({ title: "Users", message: String(e), tone: "danger" });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const addUser = async () => {
    if (!nu.username.trim()) return alertDialog({ message: "Username is required." });
    if (nu.password.length < 6) return alertDialog({ message: "Password must be at least 6 characters." });
    try {
      await api.createUser(nu.username.trim(), nu.password, nu.role);
      setAdding(false);
      setNu({ username: "", password: "", role: "cashier" });
      await load();
    } catch (e) {
      await alertDialog({ title: "Add user", message: String(e), tone: "danger" });
    }
  };

  const changeRole = async (u: AppUser, role: UserRole) => {
    if (role === u.role) return;
    setBusy(u.id);
    try {
      await api.updateUser(u.id, { role });
      await load();
    } catch (e) {
      await alertDialog({ title: "Change role", message: String(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (u: AppUser) => {
    const ok = await confirm({
      title: u.active ? "Disable user" : "Enable user",
      message: u.active
        ? `Disable "${u.username}"? They will be signed out immediately and can no longer log in.`
        : `Enable "${u.username}"? They will be able to log in again.`,
      confirmText: u.active ? "Disable" : "Enable",
      danger: u.active,
    });
    if (!ok) return;
    setBusy(u.id);
    try {
      await api.updateUser(u.id, { active: !u.active });
      await load();
    } catch (e) {
      await alertDialog({ title: "Update user", message: String(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const doReset = async (u: AppUser) => {
    if (resetPw.length < 6) return alertDialog({ message: "Password must be at least 6 characters." });
    setBusy(u.id);
    try {
      await api.resetUserPassword(u.id, resetPw);
      setResetId(null);
      setResetPw("");
      await alertDialog({ title: "Password reset", message: `"${u.username}" must sign in again with the new password.`, tone: "info" });
    } catch (e) {
      await alertDialog({ title: "Reset password", message: String(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const removeUser = async (u: AppUser) => {
    const ok = await confirm({
      title: "Delete user",
      message: `Permanently delete "${u.username}"? This can't be undone — they'll be signed out and their login removed. (To keep records, use Disable instead.)`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(u.id);
    try {
      await api.deleteUser(u.id);
      await load();
    } catch (e) {
      await alertDialog({ title: "Delete user", message: String(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 space-y-5 max-w-5xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Users &amp; Roles</h2>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add user
          </Button>
        )}
      </div>

      {/* Add-user form */}
      {adding && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium">New user</h3>
            <button onClick={() => setAdding(false)} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Username</label>
              <Input value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} placeholder="e.g. anita" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Password</label>
              <Input type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} placeholder="min 6 chars" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Role</label>
              <select
                className="h-8 w-full rounded-sm border border-border bg-background px-2 text-sm"
                value={nu.role}
                onChange={(e) => setNu({ ...nu, role: e.target.value as UserRole })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_INFO[r].label}</option>
                ))}
              </select>
            </div>
            <Button size="sm" onClick={addUser}>Create user</Button>
          </div>
        </Card>
      )}

      {/* Users table */}
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && users.map((u) => {
              const isMe = u.id === meId;
              return (
                <tr key={u.id} className={cn("border-b border-border/60 last:border-0", !u.active && "opacity-60")}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{u.username}</span>
                    {isMe && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                  </td>
                  <td className="px-3 py-2">
                    {isMe ? (
                      <Badge variant={roleBadge(u.role)}>{ROLE_INFO[u.role].label}</Badge>
                    ) : (
                      <select
                        className="h-7 rounded-sm border border-border bg-background px-1.5 text-xs disabled:opacity-50"
                        value={u.role}
                        disabled={busy === u.id}
                        onChange={(e) => changeRole(u, e.target.value as UserRole)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_INFO[r].label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={u.active ? "secondary" : "outline"}>{u.active ? "Active" : "Disabled"}</Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDate(u.created_at)}</td>
                  <td className="px-3 py-2">
                    {resetId === u.id ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <Input
                          type="password"
                          autoFocus
                          className="h-7 w-36 text-xs"
                          placeholder="new password"
                          value={resetPw}
                          onChange={(e) => setResetPw(e.target.value)}
                        />
                        <Button size="sm" onClick={() => doReset(u)} disabled={busy === u.id}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setResetId(null); setResetPw(""); }}>Cancel</Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => { setResetId(u.id); setResetPw(""); }}>
                          <KeyRound className="w-3.5 h-3.5 mr-1" /> Reset
                        </Button>
                        {!isMe && (
                          <Button
                            size="sm"
                            variant={u.active ? "outline" : "secondary"}
                            disabled={busy === u.id}
                            onClick={() => toggleActive(u)}
                          >
                            {u.active ? "Disable" : "Enable"}
                          </Button>
                        )}
                        {!isMe && (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy === u.id}
                            onClick={() => removeUser(u)}
                            title="Delete user"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && users.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No users.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Roles reference */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">Roles</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {ROLES.map((r) => {
            const info = ROLE_INFO[r];
            const Icon = info.icon;
            return (
              <Card key={r} className="p-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon className="w-4 h-4 text-primary" />
                  <span className="font-semibold">{info.label}</span>
                </div>
                <p className="text-xs text-muted-foreground mb-2.5">{info.blurb}</p>
                <ul className="space-y-1 text-xs">
                  {info.can.map((c, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-primary">•</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Roles are built-in and permission sets are fixed. Assign the closest role to each user.
        </p>
      </div>
    </div>
  );
}
