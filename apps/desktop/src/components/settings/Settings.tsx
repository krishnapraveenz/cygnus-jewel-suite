import { useEffect, useState } from "react";
import { Printer, Building2, Hash, ShieldCheck, RotateCcw, Save, SlidersHorizontal, Gem, Blocks, Lock } from "lucide-react";
import * as api from "@/api";
import { Materials } from "@/components/settings/Materials";
import { Users } from "@/components/users/Users";
import type { PreviewDoc } from "@/components/sales/InvoicePreview";
import { InvoicePreview } from "@/components/sales/InvoicePreview";
import {
  DEFAULT_PROFILE,
  PAGE_PRESETS,
  loadProfile,
  saveProfile,
  type PrintProfile,
} from "@/lib/printProfile";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { cn, getDateFormat, setDateFormat, getTimeZone, setTimeZone, type DateFormat } from "@/lib/utils";
import { formatINR } from "@/lib/utils";
import { getTickerItems, setTickerItems } from "@/lib/ticker";
import { isModuleOn, setModuleOn } from "@/lib/modules";
import { DEFAULT_COMPANY, loadCompany, saveCompany, type CompanyProfile } from "@/lib/company";
import { fyList } from "@/lib/fy";

const sel = "flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal, ready: true },
  { id: "print", label: "Print & Page", icon: Printer, ready: true },
  { id: "materials", label: "Materials", icon: Gem, ready: true },
  { id: "modules", label: "Modules", icon: Blocks, ready: true },
  { id: "company", label: "Company profile", icon: Building2, ready: true },
  { id: "series", label: "Document numbering", icon: Hash, ready: true },
  { id: "books", label: "Financial Year & Locking", icon: Lock, ready: true },
  { id: "users", label: "Users & roles", icon: ShieldCheck, ready: true },
] as const;

// Representative sample. By default a clean single-page sale; optionally with the
// old-gold voucher (which legitimately prints as a 2nd page).
function buildSample(withVoucher: boolean): PreviewDoc {
  return {
  document_no: "INV-2627-0001",
  type: "retail",
  created_at: new Date().toISOString(),
  fy: "2026-27",
  customer_name: "Sample Customer",
  payment_mode: withVoucher ? "split" : "cash",
  subtotal: "57019.60",
  discount_total: "530.28",
  grand_total: "58184.00",
  amount_payable: withVoucher ? "37000.00" : "58184.00",
  old_gold_value: withVoucher ? "21184.00" : "0",
  scheme_credit: "0",
  advance_applied: "0",
  tenders: withVoucher
    ? [
        { mode: "cash", amount: "7000.00", reference: null },
        { mode: "upi", amount: "30000.00", reference: null },
      ]
    : [{ mode: "cash", amount: "58184.00", reference: null }],
  old_gold_lots: withVoucher
    ? [
        { metal: "gold", purity: "18K", gross_weight: "2.000", deduction_percent: "20.00", net_weight: "1.600", fine_weight: "1.500", rate: "13240.00", value: "21184.00" },
      ]
    : [],
  lines: [
    {
      id: 1,
      item_id: null,
      returned: false,
      description: "Necklace",
      hsn: "7113",
      purity_label: "22K",
      gross_weight: "4.100",
      net_weight: "3.900",
      huid: "HUID12345678",
      making_label: "9%",
      rate_used: "13240.00",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      breakdown: { metal_value: "51636.00", making: "4633.32", stone_value: "220.00", cgst: "847.34", sgst: "847.34", igst: "0" } as any,
      taxable_value: "56489.32",
      line_total: "58184.00",
    },
  ],
  };
}

export function Settings() {
  const [section, setSection] = useState<string>("general");
  const isOwner = localStorage.getItem("cygnus_role") === "owner";
  const sections = SECTIONS.filter((s) => s.id !== "users" || isOwner);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">Configure printing, company details, numbering and access.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
        {/* Section nav */}
        <Card className="p-1.5 h-fit">
          {sections.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                disabled={!s.ready}
                onClick={() => s.ready && setSection(s.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  section === s.id ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/60",
                  !s.ready && "opacity-50 cursor-not-allowed",
                )}
              >
                <Icon className="w-4 h-4" />
                <span>{s.label}</span>
                {!s.ready && <span className="ml-auto text-[10px]">soon</span>}
              </button>
            );
          })}
        </Card>

        {section === "print" ? <PrintAndPage /> : section === "general" ? <General /> : section === "materials" ? <Materials /> : section === "modules" ? <Modules /> : section === "company" ? <CompanyProfileForm /> : section === "series" ? <DocNumbering /> : section === "books" ? <BooksLocking /> : section === "users" && isOwner ? <Users /> : null}
      </div>
    </div>
  );
}

function previewDate(f: DateFormat): string {
  const y = "2026", mo = "03", da = "09";
  if (f === "MM/DD/YYYY") return `${mo}/${da}/${y}`;
  if (f === "YYYY/MM/DD") return `${y}/${mo}/${da}`;
  return `${da}/${mo}/${y}`;
}

function General() {
  const FORMATS: DateFormat[] = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY/MM/DD"];
  const TIMEZONES = [
    "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Kathmandu", "Asia/Colombo",
    "Europe/London", "America/New_York", "America/Los_Angeles", "UTC",
  ];
  const [fmt, setFmt] = useState<DateFormat>(getDateFormat());
  const [tz, setTz] = useState<string>(getTimeZone());
  const [stoneFloor, setStoneFloor] = useState(true);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tickKeys, setTickKeys] = useState<string[]>(getTickerItems());
  const [candidates, setCandidates] = useState<{ key: string; label: string; unit: string; rate: string | null }[]>([]);
  const [tickOk, setTickOk] = useState(false);

  useEffect(() => {
    // Build the ticker candidate list from live metals + diamond.
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    Promise.all([api.listMetals(), api.listStoneTypes()])
      .then(([metals, stones]) => {
        const cands: { key: string; label: string; unit: string; rate: string | null }[] = [];
        for (const m of metals) {
          for (const p of m.purities) {
            cands.push({ key: `${m.metal}:${p.label}`, label: `${cap(m.metal)} ${p.label}`, unit: "/g", rate: p.sell_rate });
          }
        }
        const dia = stones.find((t) => t.category === "diamond" && t.active);
        if (dia) {
          const rate = dia.qualities.filter((q) => q.active).map((q) => Number(q.rate_per_carat)).sort((a, b) => b - a)[0];
          cands.push({ key: "diamond", label: "Diamond", unit: "/CT", rate: rate ? String(rate) : null });
        }
        setCandidates(cands);
      })
      .catch(() => {});
    // Reflect the server-saved format if present.
    api
      .getSettings()
      .then((s) => {
        const v = s["display.date_format"] as DateFormat | undefined;
        if (v && FORMATS.includes(v)) {
          setFmt(v);
          setDateFormat(v);
        }
        const stz = s["display.timezone"];
        if (stz) {
          setTz(stz);
          setTimeZone(stz);
        }
        setStoneFloor(s["sales.stone_cost_floor"] !== "false");
        const t = s["ticker.items"];
        if (t) {
          try {
            const arr = JSON.parse(t) as string[];
            if (Array.isArray(arr)) {
              setTickKeys(arr);
              setTickerItems(arr);
            }
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleTick(key: string) {
    setTickKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    setTickOk(false);
  }
  async function saveTicker() {
    setTickerItems(tickKeys); // live-update the top bar
    try {
      await api.setSetting("ticker.items", JSON.stringify(tickKeys));
    } catch {
      /* localStorage already applied */
    }
    setTickOk(true);
  }

  async function save() {
    setBusy(true);
    setOk(null);
    try {
      setDateFormat(fmt);
      await api.setSetting("display.date_format", fmt);
      setTimeZone(tz);
      await api.setSetting("display.timezone", tz);
      await api.setSetting("sales.stone_cost_floor", stoneFloor ? "true" : "false");
      // Reload so every already-mounted screen re-renders with the new format.
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden max-w-xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
        <SlidersHorizontal className="w-4 h-4" /> General
      </div>
      <div className="p-4 space-y-5">
        {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">{ok}</div>}
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Date format</div>
          <div className="grid grid-cols-3 gap-2">
            {FORMATS.map((f) => (
              <button
                key={f}
                onClick={() => setFmt(f)}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm transition-colors",
                  fmt === f ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-accent/60",
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">
            Applies everywhere dates are shown (invoices, registers, ledgers). Preview:{" "}
            <span className="font-medium text-foreground">{previewDate(fmt)}</span>
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Diamond / stone cost protection</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={stoneFloor} onChange={(e) => setStoneFloor(e.target.checked)} />
            Block selling a tagged item's diamond/stone below its purchase rate
          </label>
          <div className="text-xs text-muted-foreground">
            When on, a sale can't set the diamond ₹/ct or stone ₹/g below what the piece cost on purchase — a manager/owner can override at billing.
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Time zone</div>
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {TIMEZONES.map((z) => (
              <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
            ))}
          </select>
          <div className="text-xs text-muted-foreground">
            Stored timestamps (UTC) are shown in this zone, with entry time as HH:MM:SS. Current time:{" "}
            <span className="font-medium text-foreground">
              {new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}
            </span>
          </div>
        </div>
        <Button onClick={save} disabled={busy}>
          <Save className="w-3.5 h-3.5 mr-1" /> {busy ? "Saving…" : "Save & apply"}
        </Button>

        <div className="space-y-2 border-t border-border pt-5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Top-bar rate ticker</div>
          <p className="text-xs text-muted-foreground">Choose which live rates show in the top bar. Toggle on/off as needed.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {candidates.map((c) => {
              const on = tickKeys.includes(c.key);
              return (
                <button
                  key={c.key}
                  onClick={() => toggleTick(c.key)}
                  className={cn(
                    "flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors",
                    on ? "border-primary bg-primary/10" : "border-border hover:bg-accent/60",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex h-4 w-7 items-center rounded-full px-0.5 transition-colors",
                        on ? "bg-primary justify-end" : "bg-muted-foreground/30 justify-start",
                      )}
                    >
                      <span className="h-3 w-3 rounded-full bg-white" />
                    </span>
                    {c.label}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.rate ? `${formatINR(c.rate)}${c.unit}` : "—"}
                  </span>
                </button>
              );
            })}
            {candidates.length === 0 && <div className="text-xs text-muted-foreground">No rates configured yet.</div>}
          </div>
          <div className="flex items-center gap-3 pt-1">
            <Button size="sm" onClick={saveTicker}>
              <Save className="w-3.5 h-3.5 mr-1" /> Save ticker
            </Button>
            {tickOk && <span className="text-xs text-success">Saved — top bar updated.</span>}
          </div>
        </div>
      </div>
    </Card>
  );
}

const OPTIONAL_MODULES: { id: import("@/lib/modules").ModuleId; label: string; desc: string }[] = [
  { id: "loose_stones", label: "Loose Stones", desc: "Track and manage loose diamonds, rubies, emeralds and other stones." },
  { id: "schemes", label: "Gold Schemes", desc: "Monthly savings / gold-scheme plans and redemptions." },
];

function Modules() {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  return (
    <Card className="overflow-hidden max-w-xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
        <Blocks className="w-4 h-4" /> Modules
      </div>
      <div className="p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          Turn modules on/off to match how you work. Off hides them from the sidebar; your data is kept and reappears when re-enabled.
        </p>
        {OPTIONAL_MODULES.map((m) => {
          const on = isModuleOn(m.id);
          return (
            <button
              key={m.id}
              onClick={() => { setModuleOn(m.id, !on); rerender(); }}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                on ? "border-primary bg-primary/10" : "border-border hover:bg-accent/60",
              )}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-muted-foreground">{m.desc}</span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">{on ? "Enabled" : "Hidden"}</span>
                <span className={cn("inline-flex h-4 w-7 items-center rounded-full px-0.5 transition-colors", on ? "bg-primary justify-end" : "bg-muted-foreground/30 justify-start")}>
                  <span className="h-3 w-3 rounded-full bg-white" />
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function CompanyProfileForm() {
  const [c, setC] = useState<CompanyProfile>(DEFAULT_COMPANY);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadCompany().then(setC).catch(() => {});
  }, []);
  const set = <K extends keyof CompanyProfile>(k: K, v: string) => { setC((p) => ({ ...p, [k]: v })); setOk(false); };
  // Keep GST state code in sync with the GSTIN's first two digits.
  const onGstin = (v: string) => {
    const up = v.toUpperCase();
    setC((p) => ({ ...p, gstin: up, stateCode: up.length >= 2 && /^\d{2}/.test(up) ? up.slice(0, 2) : p.stateCode }));
    setOk(false);
  };
  async function save() {
    setBusy(true);
    setOk(false);
    try {
      await saveCompany(c);
      setOk(true);
    } finally {
      setBusy(false);
    }
  }
  const F = ({ label, k, ph, wide }: { label: string; k: keyof CompanyProfile; ph?: string; wide?: boolean }) => (
    <div className={cn("space-y-1", wide && "sm:col-span-2")}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <Input value={c[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} />
    </div>
  );
  return (
    <Card className="overflow-hidden max-w-2xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
        <Building2 className="w-4 h-4" /> Company profile
      </div>
      <div className="p-4 space-y-4">
        <p className="text-xs text-muted-foreground">Shown on printed invoices and used to build the GST e-invoice seller block.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <F label="Trade name" k="name" ph="Shown big on the bill" wide />
          <F label="Legal name (GST)" k="legalName" ph="Registered name" wide />
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">GSTIN</div>
            <Input value={c.gstin} placeholder="15-char GSTIN" onChange={(e) => onGstin(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">State (GST)</div>
              <select className={sel} value={c.stateCode} onChange={(e) => set("stateCode", e.target.value)}>
                <option value="">Select…</option>
                {api.GST_STATE_CODES.map((s) => (
                  <option key={s.code} value={s.code}>{s.code} · {s.name}</option>
                ))}
              </select>
            </div>
            <F label="PAN" k="pan" />
          </div>
          <F label="Address line 1" k="address1" wide />
          <F label="Address line 2" k="address2" wide />
          <F label="City / Location" k="city" />
          <F label="Pincode" k="pincode" />
          <F label="Phone" k="phone" />
          <F label="Email" k="email" />
          <F label="BIS hallmark reg. no." k="bis" />
          <F label="Bank details (footer)" k="bank" ph="A/c · IFSC · Bank" wide />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={busy}>
            <Save className="w-3.5 h-3.5 mr-1" /> {busy ? "Saving…" : "Save company profile"}
          </Button>
          {ok && <span className="text-xs text-success">Saved — invoices &amp; e-invoice updated.</span>}
        </div>
      </div>
    </Card>
  );
}

const DOC_TYPES: [string, string][] = [
  ["invoice", "Tax Invoice"],
  ["estimate", "Estimate"],
  ["purchase_bill", "Purchase Bill"],
  ["credit_note", "Credit Note (sales return)"],
  ["debit_note", "Debit Note (purchase return)"],
  ["quotation", "Quotation"],
  ["approval_slip", "Approval Slip"],
  ["sale_or_return", "Sale or Return"],
  ["scheme", "Scheme"],
  ["advance", "Advance"],
];
function currentFY(): string {
  const d = new Date();
  const y = d.getFullYear();
  const start = d.getMonth() + 1 >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function DocNumbering() {
  const [rows, setRows] = useState<import("@/api").DocSeries[]>([]);
  const [docType, setDocType] = useState("invoice");
  const [fy, setFy] = useState(currentFY());
  const [seriesCode, setSeriesCode] = useState("MAIN");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [pad, setPad] = useState(4);
  const [startNo, setStartNo] = useState("");
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.listDocSeries().then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);

  function edit(r: import("@/api").DocSeries) {
    setDocType(r.doc_type); setFy(r.fy); setSeriesCode(r.series_code);
    setPrefix(r.prefix); setSuffix(r.suffix); setPad(r.pad_width); setStartNo(String(r.next_no));
    setOk(null); setErr(null);
  }

  const seqForPreview = Number(startNo) || rows.find((r) => r.doc_type === docType && r.fy === fy && r.series_code === seriesCode)?.next_no || 1;
  const preview = `${prefix}${String(seqForPreview).padStart(Math.max(1, pad), "0")}${suffix}`;
  const tooLong = preview.length > 16;

  async function save() {
    setErr(null); setOk(null);
    if (tooLong) { setErr("Number exceeds the GST 16-character limit."); return; }
    setBusy(true);
    try {
      const r = await api.upsertDocSeries({
        doc_type: docType, fy, series_code: seriesCode || "MAIN", prefix,
        suffix: suffix || undefined, pad_width: pad, start_no: startNo ? Number(startNo) : undefined,
      });
      setOk(`Saved — next ${docType} number: ${r.next_number_preview}`);
      setStartNo("");
      await load();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden max-w-3xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
        <Hash className="w-4 h-4" /> Document numbering
      </div>
      <div className="p-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          Configure prefixes and sequences per document type and financial year (set once at FY start).
          The final number must be ≤ 16 characters (GST Rule 46).
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Document type</div>
            <select className={sel} value={docType} onChange={(e) => setDocType(e.target.value)}>
              {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Financial year</div>
            <Input value={fy} onChange={(e) => setFy(e.target.value)} placeholder="2026-27" />
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Series code</div>
            <Input value={seriesCode} onChange={(e) => setSeriesCode(e.target.value.toUpperCase())} placeholder="MAIN / T1" />
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Prefix</div>
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="INV-2627-" />
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Suffix</div>
            <Input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="(optional)" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Pad</div>
              <Input value={String(pad)} onChange={(e) => setPad(Math.min(12, Math.max(1, Number(e.target.value) || 1)))} inputMode="numeric" />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Next no.</div>
              <Input value={startNo} onChange={(e) => setStartNo(e.target.value)} inputMode="numeric" placeholder="keep" />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">Preview</span>
          <span className={cn("font-mono text-sm font-semibold", tooLong && "text-destructive")}>
            {preview} <span className="text-[10px] font-normal text-muted-foreground">({preview.length}/16)</span>
          </span>
        </div>

        {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">{ok}</div>}
        {err && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{err}</div>}
        <Button onClick={save} disabled={busy || tooLong}>
          <Save className="w-3.5 h-3.5 mr-1" /> {busy ? "Saving…" : "Save series"}
        </Button>

        <div className="border-t border-border pt-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">Configured series</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border text-[11px]">
                <th className="text-left px-2 py-1.5 text-muted-foreground">Type</th>
                <th className="text-left px-2 py-1.5 text-muted-foreground">FY</th>
                <th className="text-left px-2 py-1.5 text-muted-foreground">Series</th>
                <th className="text-left px-2 py-1.5 text-muted-foreground">Next number</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const label = DOC_TYPES.find(([v]) => v === r.doc_type)?.[1] ?? r.doc_type;
                const ex = `${r.prefix}${String(r.next_no).padStart(Math.max(1, r.pad_width), "0")}${r.suffix}`;
                return (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-2 py-1.5">{label}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{r.fy}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{r.series_code}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{ex}</td>
                    <td className="px-2 py-1.5 text-right">
                      <Button variant="ghost" size="sm" onClick={() => edit(r)}>Edit</Button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-muted-foreground text-xs">No series configured yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function PrintAndPage() {
  const [p, setP] = useState<PrintProfile>(DEFAULT_PROFILE);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(0.62); // preview-fit only (not saved)
  const [withVoucher, setWithVoucher] = useState(false);

  useEffect(() => {
    loadProfile().then(setP);
  }, []);

  function set<K extends keyof PrintProfile>(k: K, v: PrintProfile[K]) {
    setP((prev) => {
      const next = { ...prev, [k]: v };
      if (k === "pageSize" && v !== "Custom") {
        const [w, h] = PAGE_PRESETS[v as string] || [next.pageW, next.pageH];
        next.pageW = w;
        next.pageH = h;
      }
      return next;
    });
    setOk(null);
  }

  async function save() {
    setBusy(true);
    try {
      await saveProfile(p);
      setOk("Saved — applies to invoices, estimates, credit notes and old-gold bills.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[330px_1fr] gap-4">
      {/* Controls */}
      <div className="space-y-4">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Printer className="w-4 h-4" /> Print &amp; Page
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setP(DEFAULT_PROFILE)}>
                <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reset
              </Button>
              <Button size="sm" onClick={save} disabled={busy}>
                <Save className="w-3.5 h-3.5 mr-1" /> {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>

          <div className="p-4 space-y-5">
            {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">{ok}</div>}

            {/* Page group */}
            <Group title="Page">
              <Field label="Paper size">
                <select className={sel} value={p.pageSize} onChange={(e) => set("pageSize", e.target.value as PrintProfile["pageSize"])}>
                  <option value="A4">A4 — 210 × 297 mm</option>
                  <option value="Letter">Letter — 216 × 279 mm</option>
                  <option value="Legal">Legal — 216 × 356 mm</option>
                  <option value="Custom">Custom…</option>
                </select>
              </Field>
              {p.pageSize === "Custom" && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Width (mm)">
                    <Input value={p.pageW} onChange={(e) => set("pageW", Number(e.target.value) || 0)} inputMode="decimal" />
                  </Field>
                  <Field label="Height (mm)">
                    <Input value={p.pageH} onChange={(e) => set("pageH", Number(e.target.value) || 0)} inputMode="decimal" />
                  </Field>
                </div>
              )}
              <SliderRow label="Margin" value={p.marginMm} min={4} max={25} step={1} unit="mm" onChange={(v) => set("marginMm", v)} />
            </Group>

            {/* Content group */}
            <Group title="Content">
              <SliderRow label="Scale" value={p.scale} min={0.6} max={1.3} step={0.01} unit="%" pct onChange={(v) => set("scale", v)} />
              <SliderRow label="Base font" value={p.fontPt} min={8} max={16} step={0.5} unit="pt" onChange={(v) => set("fontPt", v)} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={p.fill} onChange={(e) => set("fill", e.target.checked)} />
                Fill page — push footer to the bottom
              </label>
            </Group>

            <p className="text-xs text-muted-foreground border-t border-border pt-3">
              The dashed blue box marks the printable area (inside the margins). When printing, set the dialog's paper to match and Scale to 100%.
            </p>
          </div>
        </Card>
      </div>

      {/* Live preview */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Live preview · {p.pageSize} · {p.pageW}×{p.pageH} mm
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={withVoucher} onChange={(e) => setWithVoucher(e.target.checked)} />
              Old-gold page
            </label>
            <span className="flex items-center gap-2">
              <span>Zoom</span>
              <input type="range" min={0.35} max={1} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28" />
              <span className="w-9 tabular-nums">{Math.round(zoom * 100)}%</span>
            </span>
          </div>
        </div>
        <div className="print-guide max-h-[72vh] overflow-auto bg-muted/30 p-6 flex justify-center">
          <div style={{ zoom }}>
            <InvoicePreview embedded doc={buildSample(withVoucher)} kind="invoice" profile={p} onClose={() => {}} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  pct,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  pct?: boolean;
  onChange: (v: number) => void;
}) {
  const display = pct ? `${Math.round(value * 100)}` : String(value);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">
          {display} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}

/** Financial year & data-locking: set a lock date to freeze filed/audited periods. */
function BooksLocking() {
  const [lock, setLock] = useState("");
  const [begin, setBegin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [closeFy, setCloseFy] = useState("");
  const fys = fyList(begin || undefined);
  useEffect(() => {
    api.getSettings().then((s) => {
      setLock(s["books.lock_date"] || "");
      setBegin(s["books.begin_date"] || "");
    }).catch(() => {});
  }, []);
  async function save(clearLock = false) {
    setBusy(true); setMsg(null);
    try {
      await api.setBooksLock({ lock_date: clearLock ? "" : lock, begin_date: begin || undefined });
      if (clearLock) setLock("");
      setMsg(clearLock ? "Lock cleared." : "Saved.");
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-4 max-w-2xl space-y-4">
      <div>
        <div className="text-sm font-medium">Financial Year &amp; Data Locking</div>
        <p className="text-xs text-muted-foreground mt-1">
          The Indian financial year runs <b>Apr 1 – Mar 31</b>. Set a <b>lock date</b> to freeze the books up to and
          including that date — creating or editing any transaction on/before it is blocked (owner / manager only).
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-muted-foreground mb-1">Books begin date (go-live)</div>
          <DateField value={begin} onChange={setBegin} />
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Lock date (freeze up to)</div>
          <DateField value={lock} onChange={setLock} />
        </div>
      </div>
      {msg && <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">{msg}</div>}
      <div className="flex gap-2">
        <Button onClick={() => save(false)} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="outline" onClick={() => save(true)} disabled={busy}>Clear lock</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Enforced across sales, purchases &amp; returns, receipts, payments, expenses, bank entries, advances, schemes,
        rate-cutting and old-jewellery. Entries dated after the lock date are unaffected.
      </p>

      <div className="border-t border-border pt-4">
        <div className="text-sm font-medium">Close a financial year</div>
        <p className="text-xs text-muted-foreground mt-1">
          Closing a year locks it at <b>31 Mar</b>. Balances <b>carry forward automatically</b> — the ledger is
          continuous, so the next year opens from this year's closing without re-entering opening balances.
        </p>
        <div className="flex items-end gap-2 mt-2">
          <select className={sel + " max-w-[160px]"} value={closeFy} onChange={(e) => setCloseFy(e.target.value)}>
            <option value="">Select FY…</option>
            {fys.map((f) => <option key={f.label} value={f.label}>FY {f.label}</option>)}
          </select>
          <Button
            variant="outline"
            disabled={busy || !closeFy}
            onClick={async () => {
              const f = fys.find((x) => x.label === closeFy);
              if (!f) return;
              setBusy(true); setMsg(null);
              try {
                await api.setBooksLock({ lock_date: f.to, begin_date: begin || undefined });
                setLock(f.to);
                setMsg(`Financial year ${f.label} closed and locked at ${f.to}.`);
              } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
              finally { setBusy(false); }
            }}
          >
            Close &amp; lock year
          </Button>
        </div>
      </div>
    </Card>
  );
}
