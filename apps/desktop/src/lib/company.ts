// Company (seller) profile — shown on printed invoices and used to build the e-invoice
// seller block. Stored as individual app_setting key/values (reuses the existing
// `seller_*` keys the backend e-invoice already reads, plus a few `company.*` extras).
import { getSettings, setSetting } from "@/api";

export interface CompanyProfile {
  name: string; // trade name (big on the bill)
  legalName: string; // registered legal name (GST docs / e-invoice LglNm)
  gstin: string;
  stateCode: string; // GST 2-digit state code
  pan: string;
  address1: string;
  address2: string;
  city: string;
  pincode: string;
  phone: string;
  email: string;
  bis: string; // BIS hallmark registration no.
  bank: string; // free-text bank line for the invoice footer
}

export const DEFAULT_COMPANY: CompanyProfile = {
  name: "", legalName: "", gstin: "", stateCode: "", pan: "",
  address1: "", address2: "", city: "", pincode: "", phone: "", email: "", bis: "", bank: "",
};

// Map each field to its app_setting key. `seller_*` keys are shared with the backend
// e-invoice builder, so editing them here keeps e-invoices correct.
const KEYS: Record<keyof CompanyProfile, string> = {
  name: "company.name",
  legalName: "seller_legal_name",
  gstin: "seller_gstin",
  stateCode: "seller_state_code",
  pan: "company.pan",
  address1: "seller_address1",
  address2: "company.address2",
  city: "seller_loc",
  pincode: "seller_pincode",
  phone: "company.phone",
  email: "company.email",
  bis: "company.bis_hallmark",
  bank: "company.bank",
};

let cache: CompanyProfile = { ...DEFAULT_COMPANY };

export function parseCompany(s: Record<string, string>): CompanyProfile {
  const out = { ...DEFAULT_COMPANY };
  (Object.keys(KEYS) as (keyof CompanyProfile)[]).forEach((k) => {
    const v = s[KEYS[k]];
    if (v != null) out[k] = v;
  });
  return out;
}

/** Populate the cache from an already-fetched settings map (called on app load). */
export function applyCompany(s: Record<string, string>) {
  cache = parseCompany(s);
}

/** Synchronous accessor — returns the last loaded profile (or defaults). */
export function getCompany(): CompanyProfile {
  return cache;
}

export async function loadCompany(): Promise<CompanyProfile> {
  cache = parseCompany(await getSettings());
  return cache;
}

export async function saveCompany(p: CompanyProfile): Promise<void> {
  cache = { ...p };
  await Promise.all(
    (Object.keys(KEYS) as (keyof CompanyProfile)[]).map((k) => setSetting(KEYS[k], (p[k] ?? "").trim())),
  );
  window.dispatchEvent(new Event("cygnus:company"));
}
