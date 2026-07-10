import { useEffect, useState } from "react";
import * as api from "@/api";
import type { RateRow } from "@/api";
import { type Page, pageTitle } from "@/lib/nav";
import { setDateFormat, setTimeZone, type DateFormat } from "@/lib/utils";
import { DialogHost } from "@/lib/dialog";
import { setTickerItems } from "@/lib/ticker";
import { applyServerModules } from "@/lib/modules";
import { applyCompany } from "@/lib/company";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { StatusBar } from "@/components/layout/StatusBar";
import { LoginScreen } from "@/components/auth/LoginScreen";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { SalesLayout } from "@/components/sales/SalesLayout";
import { StockList } from "@/components/inventory/StockList";
import { ChequeRegister } from "@/components/banking/ChequeRegister";
import { DailyRates } from "@/components/rates/DailyRates";
import { Advances } from "@/components/advances/Advances";
import { Smiths } from "@/components/smiths/Smiths";
import { Parties } from "@/components/parties/Parties";
import { OldGoldRegister } from "@/components/oldgold/OldGoldRegister";
import { MetalAccount } from "@/components/inventory/MetalAccount";
import { RateCutting } from "@/components/inventory/RateCutting";
import { Tagging } from "@/components/inventory/Tagging";
import { Staff } from "@/components/staff/Staff";
import { Attendance } from "@/components/staff/Attendance";
import { Leave } from "@/components/staff/Leave";
import { Payroll } from "@/components/staff/Payroll";
import { BiometricDevices } from "@/components/staff/BiometricDevices";
import { Reports } from "@/components/reports/Reports";
import { Accounts } from "@/components/accounts/Accounts";
import { BankAccounts } from "@/components/banking/BankAccounts";
import { DayClose } from "@/components/banking/DayClose";
import { LooseStones } from "@/components/inventory/LooseStones";
import { Resale } from "@/components/inventory/Resale";
import { Purchases } from "@/components/purchases/Purchases";
import { Schemes } from "@/components/schemes/Schemes";
import { Settings as SettingsScreen } from "@/components/settings/Settings";

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(localStorage.getItem("cygnus_theme") === "dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("cygnus_theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

export default function App() {
  const [authed, setAuthed] = useState(!!api.getToken());
  const [role, setRole] = useState(localStorage.getItem("cygnus_role") || "");

  if (!authed) {
    return (
      <LoginScreen
        onLogin={(r) => {
          setRole(r);
          localStorage.setItem("cygnus_role", r);
          setAuthed(true);
        }}
      />
    );
  }
  return <Shell role={role} onLogout={() => setAuthed(false)} />;
}

function Shell({ role, onLogout }: { role: string; onLogout: () => void }) {
  const [page, setPage] = useState<Page>("dashboard");
  const [collapsed, setCollapsed] = useState(false);
  const [dark, toggleDark] = useDarkMode();
  const [rates, setRates] = useState<RateRow[]>([]);
  const [online, setOnline] = useState(true);
  const [clients, setClients] = useState(0);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const st = await api.serverStatus();
      if (alive) {
        setOnline(st.online);
        setClients(st.clients);
      }
    };
    check();
    const t = setInterval(check, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const loadRates = () => api.listRates().then(setRates).catch(() => {});
    loadRates();
    // Refresh the ticker whenever rates are saved, or the window regains focus.
    window.addEventListener("cygnus:rates", loadRates);
    window.addEventListener("focus", loadRates);
    return () => {
      window.removeEventListener("cygnus:rates", loadRates);
      window.removeEventListener("focus", loadRates);
    };
  }, []);

  useEffect(() => {
    // Apply the saved global date format (server copy → overrides localStorage default).
    api
      .getSettings()
      .then((s) => {
        const v = s["display.date_format"] as DateFormat | undefined;
        if (v) setDateFormat(v);
        const tz = s["display.timezone"];
        if (tz) setTimeZone(tz);
        applyServerModules(s);
        applyCompany(s);
        const t = s["ticker.items"];
        if (t) {
          try {
            const arr = JSON.parse(t) as string[];
            if (Array.isArray(arr)) setTickerItems(arr);
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {});
  }, []);

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // best-effort server revoke; sign out locally regardless
    }
    api.clearToken();
    localStorage.removeItem("cygnus_role");
    onLogout();
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar activePage={page} setActivePage={setPage} collapsed={collapsed} toggle={() => setCollapsed((c) => !c)} />
      <div className="flex flex-col flex-1 min-w-0">
        <Topbar
          title={pageTitle[page]}
          role={role}
          rates={rates}
          dark={dark}
          toggleDark={toggleDark}
          onLogout={handleLogout}
          goSettings={() => setPage("settings")}
        />
        <main className="flex-1 overflow-y-auto p-5 bg-muted/15">
          <PageBody page={page} />
        </main>
        <StatusBar role={role} base={api.getBase()} online={online} clients={clients} />
      </div>
      <DialogHost />
    </div>
  );
}

function PageBody({ page }: { page: Page }) {
  switch (page) {
    case "dashboard":
      return <Dashboard />;
    case "sale":
      return <SalesLayout />;
    case "stock":
      return <StockList />;
    case "tagging":
      return <Tagging />;
    case "cheques":
      return <ChequeRegister />;
    case "advances":
      return <Advances />;
    case "smiths":
      return <Smiths />;
    case "staff":
      return <Staff />;
    case "attendance":
      return <Attendance />;
    case "leave":
      return <Leave />;
    case "payroll":
      return <Payroll />;
    case "biometric_devices":
      return <BiometricDevices />;
    case "rates":
      return <DailyRates />;
    case "old_gold":
      return <OldGoldRegister />;
    case "metal_account":
      return <MetalAccount />;
    case "rate_cutting":
      return <RateCutting />;
    case "loose_stones":
      return <LooseStones />;
    case "resale":
      return <Resale />;
    case "parties":
      return <Parties />;
    case "purchases":
      return <Purchases />;
    case "schemes":
      return <Schemes />;
    case "reports":
      return <Reports />;
    case "accounts":
      return <Accounts />;
    case "bank_accounts":
      return <BankAccounts />;
    case "day_close":
      return <DayClose />;
    case "settings":
      return <SettingsScreen />;
    default:
      return null;
  }
}
