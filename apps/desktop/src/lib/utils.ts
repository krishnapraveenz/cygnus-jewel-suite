import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names and de-dupe conflicting Tailwind classes. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a rupee value string/number for display (Indian grouping). */
export function formatINR(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return String(value);
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Indian-system amount in words, e.g. 1,23,456 → "One Lakh Twenty Three Thousand...". */
export function rupeesInWords(value: string | number): string {
  const num = Math.round((typeof value === "string" ? Number(value) : value) || 0);
  if (num === 0) return "Zero Rupees Only";
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (n: number): string => {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
  };
  const three = (n: number): string => {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return (h ? ones[h] + " Hundred" + (r ? " " : "") : "") + (r ? two(r) : "");
  };
  let n = num;
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(three(crore) + " Crore");
  if (lakh) parts.push(three(lakh) + " Lakh");
  if (thousand) parts.push(three(thousand) + " Thousand");
  if (n) parts.push(three(n));
  return parts.join(" ").trim() + " Rupees Only";
}


/** Global display date format. Persisted in localStorage (and mirrored to server
 *  settings); changed from Settings → General. Default DD/MM/YYYY (Indian). */
export type DateFormat = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY/MM/DD";

const DATE_FORMATS: DateFormat[] = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY/MM/DD"];

let currentDateFormat: DateFormat = (() => {
  try {
    const v = localStorage.getItem("cygnus_date_format") as DateFormat | null;
    return v && DATE_FORMATS.includes(v) ? v : "DD/MM/YYYY";
  } catch {
    return "DD/MM/YYYY";
  }
})();

export function getDateFormat(): DateFormat {
  return currentDateFormat;
}

export function setDateFormat(f: DateFormat) {
  currentDateFormat = f;
  try {
    localStorage.setItem("cygnus_date_format", f);
  } catch {
    /* ignore */
  }
}

/* ---- Display time zone (IANA), applied to stored UTC timestamps. Default Asia/Kolkata (IST). */
let currentTimeZone: string = (() => {
  try {
    return localStorage.getItem("cygnus_timezone") || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
})();

export function getTimeZone(): string {
  return currentTimeZone;
}

export function setTimeZone(tz: string) {
  currentTimeZone = tz;
  try {
    localStorage.setItem("cygnus_timezone", tz);
  } catch {
    /* ignore */
  }
}

/** Parse a stored date/timestamp into calendar parts in the configured time zone.
 *  Date-only values (YYYY-MM-DD, no time) are treated as plain calendar dates and are
 *  NOT shifted. Timestamps ("YYYY-MM-DD HH:MM:SS[.ffffff][+TZ]" or ISO) are converted
 *  from their (UTC) instant into `currentTimeZone`. */
function zonedParts(value: string): { y: string; mo: string; da: string; time?: string } | null {
  const s = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) return { y: dateOnly[1], mo: dateOnly[2], da: dateOnly[3] };
  const hasTime = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s);
  if (hasTime) {
    // Normalise "YYYY-MM-DD HH:MM:SS.ffffff+00" → parseable ISO; pad bare "+00"/"-05" offsets.
    let iso = s.replace(" ", "T").replace(/([+-]\d{2})(?::?(\d{2}))?$/, (_m, h, mm) => `${h}:${mm ?? "00"}`);
    if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(iso)) iso += "Z"; // assume UTC if no offset present
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: currentTimeZone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).formatToParts(d);
      const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      const hh = g("hour") === "24" ? "00" : g("hour");
      return { y: g("year"), mo: g("month"), da: g("day"), time: `${hh}:${g("minute")}:${g("second")}` };
    }
  }
  // Fallback: pull the date portion without shifting.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? { y: m[1], mo: m[2], da: m[3] } : null;
}

function applyDateFormat(y: string, mo: string, da: string): string {
  switch (currentDateFormat) {
    case "MM/DD/YYYY": return `${mo}/${da}/${y}`;
    case "YYYY/MM/DD": return `${y}/${mo}/${da}`;
    default: return `${da}/${mo}/${y}`;
  }
}

/** Format a date value (YYYY-MM-DD, ISO, or "YYYY-MM-DD HH:MM:SS+TZ") for display
 *  using the global date format + time zone. Returns "—" for empty input. */
export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const p = zonedParts(String(value));
  return p ? applyDateFormat(p.y, p.mo, p.da) : String(value);
}

/** Like formatDate, but appends the entry time as HH:MM:SS (in the configured time zone)
 *  when the source value carries a time component. Date-only values format to just the date. */
export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const p = zonedParts(String(value));
  if (!p) return String(value);
  const date = applyDateFormat(p.y, p.mo, p.da);
  return p.time ? `${date} ${p.time}` : date;
}
