import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, ChevronDown,
  ShoppingBag, Contact, ShoppingCart, Package, RefreshCcwDot, Hammer, Landmark, Users, BarChart3,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { navGroups, type NavItem, type Page } from "@/lib/nav";
import { isModuleOn, type ModuleId } from "@/lib/modules";

const GROUP_ICON: Record<string, LucideIcon> = {
  Sales: ShoppingBag,
  Customers: Contact,
  Purchases: ShoppingCart,
  Inventory: Package,
  "Old Jewellery": RefreshCcwDot,
  Workshop: Hammer,
  "Banking & Cash": Landmark,
  "Staff & Payroll": Users,
  "Accounts & Reports": BarChart3,
};

interface SidebarProps {
  activePage: Page;
  setActivePage: (p: Page) => void;
  collapsed: boolean;
  toggle: () => void;
}

// Sidebar items gated behind an optional module toggle.
const PAGE_MODULE: Partial<Record<Page, ModuleId>> = {
  loose_stones: "loose_stones",
  schemes: "schemes",
};

// Groups pinned (always shown, no accordion header): Main (Dashboard) top, System (Settings) bottom.
const PINNED = new Set(["Main", "System"]);
const OPEN_KEY = "cygnus:sidebar_open_groups";
const groupOf = (page: Page) => navGroups.find((g) => g.items.some((i) => i.id === page))?.group;

export function Sidebar({ activePage, setActivePage, collapsed, toggle }: SidebarProps) {
  // Re-render when module toggles change.
  const [, force] = useState(0);
  useEffect(() => {
    const onChange = () => force((n) => n + 1);
    window.addEventListener("cygnus:modules", onChange);
    return () => window.removeEventListener("cygnus:modules", onChange);
  }, []);
  const visible = (id: Page) => {
    const mod = PAGE_MODULE[id];
    return !mod || isModuleOn(mod);
  };

  // Which accordion groups are open (persisted). The active page's group is always forced open.
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(OPEN_KEY) || "null");
      if (Array.isArray(raw)) return new Set(raw as string[]);
    } catch { /* ignore */ }
    const g = groupOf(activePage);
    return new Set(g ? [g] : []);
  });
  useEffect(() => {
    const g = groupOf(activePage);
    if (g && !open.has(g)) setOpen((prev) => new Set(prev).add(g));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage]);
  useEffect(() => {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  }, [open]);
  const toggleGroup = (g: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      n.has(g) ? n.delete(g) : n.add(g);
      return n;
    });

  const renderItem = (item: (typeof navGroups)[number]["items"][number], indented = false) => {
    const Icon = item.icon;
    const isActive = activePage === item.id;
    return (
      <button
        key={item.id}
        onClick={() => setActivePage(item.id)}
        className={cn(
          "flex items-center w-full h-10 text-[15px] rounded-md transition-colors",
          collapsed ? "justify-center px-2" : indented ? "pl-11 pr-3" : "px-3",
          isActive ? "bg-primary/10 text-primary font-medium" : "text-foreground/70 hover:bg-accent hover:text-foreground",
        )}
        title={collapsed ? item.label : undefined}
      >
        <Icon className="w-5 h-5 shrink-0" />
        {!collapsed && <span className="ml-3 flex-1 text-left">{item.label}</span>}
      </button>
    );
  };

  return (
    <aside
      className={cn(
        "flex flex-col bg-muted/50 border-r border-border transition-all duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      {/* Logo area — logo sits on a dark badge so its light/white artwork stays visible
          in BOTH light and dark themes (the mark is designed for a dark backdrop). */}
      <div className={cn("flex items-center h-16 border-b border-border", collapsed ? "justify-center px-2" : "px-3")}>
        <div className="grid place-items-center w-12 h-12 rounded-xl bg-slate-900 ring-1 ring-black/5 shadow-sm shrink-0">
          <img src="/logo.png" alt="Cygnus" className="w-10 h-10 object-contain" />
        </div>
        {!collapsed && (
          <div className="ml-2.5 min-w-0">
            <div className="font-bold text-base leading-tight">Cygnus</div>
            <div className="text-[10px] text-muted-foreground leading-tight">Jewel Suite</div>
          </div>
        )}
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {navGroups.map((group) => {
          const items = group.items.filter((i) => visible(i.id));
          if (items.length === 0) return null;

          // Collapsed (icon rail): one icon per group. Single-item groups navigate
          // directly; multi-item groups reveal a hover flyout with their items.
          if (collapsed) {
            if (items.length === 1) return <div key={group.group}>{renderItem(items[0])}</div>;
            return (
              <CollapsedGroup
                key={group.group}
                group={group.group}
                items={items}
                icon={GROUP_ICON[group.group] ?? items[0].icon}
                activePage={activePage}
                setActivePage={setActivePage}
              />
            );
          }

          // Pinned groups (Dashboard / Settings): no header, always shown.
          if (PINNED.has(group.group)) return <div key={group.group}>{items.map((i) => renderItem(i))}</div>;

          // Accordion group.
          const isOpen = open.has(group.group);
          const hasActive = items.some((i) => i.id === activePage);
          const GIcon = GROUP_ICON[group.group];
          return (
            <div key={group.group}>
              <button
                onClick={() => toggleGroup(group.group)}
                className={cn(
                  "flex items-center w-full h-10 px-3 rounded-md transition-colors",
                  hasActive && !isOpen ? "text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {GIcon && <GIcon className="w-5 h-5 shrink-0" />}
                <span className="ml-3 flex-1 text-left text-xs font-semibold uppercase tracking-wide">{group.group}</span>
                {isOpen ? <ChevronDown className="w-4 h-4 opacity-60" /> : <ChevronRight className="w-4 h-4 opacity-60" />}
              </button>
              {isOpen && <div className="mt-0.5 mb-1 space-y-0.5">{items.map((i) => renderItem(i, true))}</div>}
            </div>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div className="border-t border-border p-2">
        <button
          onClick={toggle}
          className="flex items-center justify-center w-full h-7 rounded-md hover:bg-accent text-muted-foreground"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
    </aside>
  );
}

// Collapsed-rail group: a single group icon that reveals a flyout submenu on hover.
// The flyout is a DOM child of the wrapper (so moving onto it does NOT fire mouseleave)
// but uses fixed positioning to escape the nav's overflow clipping.
function CollapsedGroup({
  group, items, icon: Icon, activePage, setActivePage,
}: {
  group: string;
  items: NavItem[];
  icon: LucideIcon;
  activePage: Page;
  setActivePage: (p: Page) => void;
}) {
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hasActive = items.some((i) => i.id === activePage);

  const show = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setTop(r.top);
    setOpen(true);
  };

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <button
        ref={btnRef}
        onClick={show}
        title={group}
        className={cn(
          "flex items-center justify-center w-full h-9 rounded-md transition-colors",
          hasActive ? "bg-primary/10 text-primary" : "text-foreground/70 hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon className="w-5 h-5 shrink-0" />
      </button>
      {open && (
        <div className="fixed left-16 z-50" style={{ top }}>
          <div className="min-w-44 rounded-md border border-border bg-popover shadow-lg py-1">
            <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group}
            </div>
            {items.map((item) => {
              const ItemIcon = item.icon;
              const isActive = activePage === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => { setActivePage(item.id); setOpen(false); }}
                  className={cn(
                    "flex items-center w-full h-10 px-3 text-[15px] transition-colors",
                    isActive ? "bg-primary/10 text-primary font-medium" : "text-foreground/70 hover:bg-accent hover:text-foreground",
                  )}
                >
                  <ItemIcon className="w-5 h-5 shrink-0" />
                  <span className="ml-3 flex-1 text-left whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
