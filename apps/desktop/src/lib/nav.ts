import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  ShoppingBag,
  PiggyBank,
  Contact,
  Wallet,
  Package,
  RefreshCcwDot,
  ShoppingCart,
  Scale,
  Gem,
  Recycle,
  Scissors,
  ScanBarcode,
  Tag,
  Hammer,
  Users,
  CalendarCheck,
  CalendarOff,
  Wallet2,
  Fingerprint,
  Banknote,
  Landmark,
  Sunset,
  IndianRupee,
  BarChart3,
  BookOpen,
  Settings as SettingsIcon,
} from "lucide-react";

export type Page =
  | "dashboard"
  | "sale"
  | "old_gold"
  | "stock"
  | "barcoding"
  | "tagging"
  | "metal_account"
  | "rate_cutting"
  | "loose_stones"
  | "resale"
  | "parties"
  | "purchases"
  | "schemes"
  | "cheques"
  | "bank_accounts"
  | "day_close"
  | "advances"
  | "smiths"
  | "staff"
  | "attendance"
  | "leave"
  | "payroll"
  | "biometric_devices"
  | "rates"
  | "reports"
  | "accounts"
  | "settings";

export interface NavItem {
  id: Page;
  label: string;
  icon: LucideIcon;
}

export const navGroups: { group: string; items: NavItem[] }[] = [
  {
    group: "Main",
    items: [{ id: "dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    group: "Sales",
    items: [
      { id: "sale", label: "Sales", icon: ShoppingBag },
      { id: "schemes", label: "Gold Schemes", icon: PiggyBank },
      { id: "advances", label: "Advance", icon: Wallet },
    ],
  },
  {
    group: "Customers",
    items: [
      { id: "parties", label: "Parties", icon: Contact },
    ],
  },
  {
    group: "Purchases",
    items: [
      { id: "purchases", label: "Purchases", icon: ShoppingCart },
      { id: "tagging", label: "Tagging", icon: Tag },
    ],
  },
  {
    group: "Inventory",
    items: [
      { id: "stock", label: "Stock", icon: Package },
      { id: "barcoding", label: "Barcoding", icon: ScanBarcode },
      { id: "loose_stones", label: "Loose Stones", icon: Gem },
      { id: "resale", label: "Resale (Used)", icon: Recycle },
    ],
  },
  {
    group: "Old Jewellery",
    items: [
      { id: "old_gold", label: "Old Jewellery Register", icon: RefreshCcwDot },
      { id: "metal_account", label: "Old Metal Account", icon: Scale },
      { id: "rate_cutting", label: "Rate Cutting", icon: Scissors },
    ],
  },
  {
    group: "Workshop",
    items: [{ id: "smiths", label: "Smiths / Job Work", icon: Hammer }],
  },
  {
    group: "Banking & Cash",
    items: [
      { id: "bank_accounts", label: "Bank Accounts", icon: Landmark },
      { id: "day_close", label: "Day Close", icon: Sunset },
      { id: "cheques", label: "Cheque Register", icon: Banknote },
    ],
  },
  {
    group: "Staff & Payroll",
    items: [
      { id: "staff", label: "Staff", icon: Users },
      { id: "attendance", label: "Attendance", icon: CalendarCheck },
      { id: "leave", label: "Leave", icon: CalendarOff },
      { id: "payroll", label: "Payroll", icon: Wallet2 },
      { id: "biometric_devices", label: "Biometric Devices", icon: Fingerprint },
    ],
  },
  {
    group: "Accounts & Reports",
    items: [
      { id: "accounts", label: "Accounts", icon: BookOpen },
      { id: "reports", label: "Reports", icon: BarChart3 },
      { id: "rates", label: "Daily Rates", icon: IndianRupee },
    ],
  },
  {
    group: "System",
    items: [{ id: "settings", label: "Settings", icon: SettingsIcon }],
  },
];

export const pageTitle: Record<Page, string> = {
  dashboard: "Dashboard",
  sale: "New Sale",
  old_gold: "Old Jewellery Register",
  metal_account: "Old Metal Account",
  rate_cutting: "Rate Cutting",
  loose_stones: "Loose Stones",
  resale: "Resale (Used)",
  stock: "Stock",
  barcoding: "Barcoding",
  tagging: "Tagging",
  parties: "Parties",
  purchases: "Purchases",
  schemes: "Gold Schemes",
  cheques: "Cheque Register",
  bank_accounts: "Bank Accounts",
  day_close: "Day Close",
  advances: "Advance",
  smiths: "Smiths / Job Work",
  staff: "Staff",
  attendance: "Attendance",
  leave: "Leave",
  payroll: "Payroll",
  biometric_devices: "Biometric Devices",
  rates: "Daily Rates",
  reports: "Reports",
  accounts: "Accounts",
  settings: "Settings",
};

/** Pages that are wired to the backend today. Others render a styled placeholder. */
export const livePages: Set<Page> = new Set([
  "dashboard",
  "sale",
  "old_gold",
  "metal_account",
  "rate_cutting",
  "loose_stones",
  "resale",
  "stock",
  "barcoding",
  "tagging",
  "parties",
  "purchases",
  "schemes",
  "cheques",
  "bank_accounts",
  "day_close",
  "advances",
  "smiths",
  "staff",
  "attendance",
  "leave",
  "payroll",
  "biometric_devices",
  "rates",
  "reports",
  "accounts",
  "settings",
]);
