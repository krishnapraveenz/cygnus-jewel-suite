import type { CSSProperties } from "react";
import { getSettings, setSetting } from "@/api";

/** A print/page profile. Persisted in app_setting (key/value) — tune from the
 *  Settings → Print & Page screen, no code change required. */
export interface PrintProfile {
  pageSize: "A4" | "Letter" | "Legal" | "Custom";
  pageW: number; // mm
  pageH: number; // mm
  marginMm: number;
  scale: number; // 0.6 .. 1.3 (content zoom)
  fontPt: number;
  fill: boolean; // push the footer to the bottom of the page
}

export const PAGE_PRESETS: Record<string, [number, number]> = {
  A4: [210, 297],
  Letter: [216, 279],
  Legal: [216, 356],
};

export const DEFAULT_PROFILE: PrintProfile = {
  pageSize: "A4",
  pageW: 210,
  pageH: 297,
  marginMm: 10,
  scale: 1,
  fontPt: 12,
  fill: true,
};

const K = {
  size: "print.page_size",
  w: "print.page_w",
  h: "print.page_h",
  margin: "print.margin_mm",
  scale: "print.scale",
  font: "print.font_pt",
  fill: "print.fill",
};

export function parseProfile(s: Record<string, string>): PrintProfile {
  const num = (k: string, d: number) => {
    const v = parseFloat(s[k]);
    return Number.isFinite(v) ? v : d;
  };
  const size = (s[K.size] as PrintProfile["pageSize"]) || DEFAULT_PROFILE.pageSize;
  let [pw, ph] = PAGE_PRESETS[size] || [DEFAULT_PROFILE.pageW, DEFAULT_PROFILE.pageH];
  if (size === "Custom") {
    pw = num(K.w, 210);
    ph = num(K.h, 297);
  }
  return {
    pageSize: size,
    pageW: pw,
    pageH: ph,
    marginMm: num(K.margin, DEFAULT_PROFILE.marginMm),
    scale: num(K.scale, 1),
    fontPt: num(K.font, 12),
    fill: (s[K.fill] ?? "true") !== "false",
  };
}

export async function loadProfile(): Promise<PrintProfile> {
  try {
    return parseProfile(await getSettings());
  } catch {
    return DEFAULT_PROFILE;
  }
}

export async function saveProfile(p: PrintProfile): Promise<void> {
  await Promise.all([
    setSetting(K.size, p.pageSize),
    setSetting(K.w, String(p.pageW)),
    setSetting(K.h, String(p.pageH)),
    setSetting(K.margin, String(p.marginMm)),
    setSetting(K.scale, String(p.scale)),
    setSetting(K.font, String(p.fontPt)),
    setSetting(K.fill, String(p.fill)),
  ]);
}

/** CSS custom properties consumed by .a4-sheet / .a4-page / .print-area. */
export function profileVars(p: PrintProfile): CSSProperties {
  // Keep the page-fill safely inside the printable area on any paper.
  const fill = Math.max(60, p.pageH - 2 * p.marginMm - 2);
  return {
    "--page-w": `${p.pageW}mm`,
    "--page-h": `${p.pageH}mm`,
    "--page-pad": `${p.marginMm}mm`,
    "--print-fill": p.fill ? `${fill}mm` : "0",
    "--print-font": `${p.fontPt}pt`,
    "--print-scale": String(p.scale),
  } as CSSProperties;
}

/** Inject/refresh the @page rule (size + margin) — @page can't read element vars. */
export function injectPageStyle(p: PrintProfile) {
  const id = "cygnus-print-page";
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = `@media print{@page{size:${p.pageW}mm ${p.pageH}mm;margin:${p.marginMm}mm;}}`;
}
