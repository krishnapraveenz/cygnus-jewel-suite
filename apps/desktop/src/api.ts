// Minimal typed client for the Cygnus backend API.
// The backend address is configurable (LAN server); defaults to localhost.

const DEFAULT_BASE = "http://127.0.0.1:8787";

export function getBase(): string {
  return localStorage.getItem("cygnus_base") || DEFAULT_BASE;
}
export function setBase(b: string) {
  localStorage.setItem("cygnus_base", b);
}

/** Unauthenticated backend reachability check (drives the connection indicator). */
export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(getBase() + "/health");
    if (!res.ok) return false;
    const d = await res.json();
    return d?.db === true;
  } catch {
    return false;
  }
}

/** Reachability + how many terminals are connected to this server (server view). */
export async function serverStatus(): Promise<{ online: boolean; clients: number; terminals: number }> {
  try {
    const res = await fetch(getBase() + "/health");
    if (!res.ok) return { online: false, clients: 0, terminals: 0 };
    const d = await res.json();
    return {
      online: d?.db === true,
      clients: Number(d?.clients ?? 0),
      terminals: Number(d?.terminals ?? 0),
    };
  } catch {
    return { online: false, clients: 0, terminals: 0 };
  }
}

let token: string | null = localStorage.getItem("cygnus_token");

export function getToken() {
  return token;
}
export function clearToken() {
  token = null;
  localStorage.removeItem("cygnus_token");
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const MAX_RETRIES = 3;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(getBase() + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // Network error (server down, no connectivity) — retry with exponential backoff.
      lastError = e instanceof Error ? e : new Error("Network error");
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000)); // 1s, 2s, 3s
        continue;
      }
      throw new Error(`Server unreachable after ${MAX_RETRIES} attempts — check the connection.`);
    }
    const text = await res.text();

    // Handle an expired/invalid session FIRST — the backend may return a plaintext
    // body (e.g. "invalid token"), so this must happen before any JSON parsing.
    if (
      res.status === 401 &&
      path !== "/auth/login" &&
      path !== "/auth/logout" &&
      path !== "/auth/change-password"
    ) {
      clearToken();
      localStorage.removeItem("cygnus_role");
      if (typeof window !== "undefined") window.location.reload();
      throw new Error("Session expired — please sign in again.");
    }

    // 5xx server errors: retry (transient backend issue).
    if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
      lastError = new Error(text || `HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
      continue;
    }

    // Parse defensively: error responses are often plaintext, not JSON.
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const msg = typeof data === "string" ? data : text || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data as T;
  }
  throw lastError ?? new Error("Request failed");
}

export interface PriceBreakdown {
  metal_value: string;
  making: string;
  wastage: string;
  stone_value: string;
  discount: string;
  taxable_value: string;
  cgst: string;
  sgst: string;
  igst: string;
  tax_total: string;
  round_off: string;
  grand_total: string;
}

export interface Item {
  id: number;
  sku: string;
  metal_type_id: number;
  purity_id: number;
  metal?: string;
  purity?: string | null;
  gross_weight: string;
  net_weight: string;
  cost_value?: string | null;
  huid?: string | null;
  ownership_state: string;
  tag_status?: string;
  lot_id?: number | null;
  category?: string | null;
}

export interface RateRow {
  metal: string;
  purity: string;
  buy_rate: string;
  sell_rate: string;
  cash_rate: string | null;
  effective_from: string;
}

export async function login(username: string, password: string): Promise<string> {
  return (await loginFull(username, password)).token;
}

export async function loginFull(
  username: string,
  password: string,
): Promise<{ token: string; role: string }> {
  const r = await req<{ token: string; role: string }>("POST", "/auth/login", {
    username,
    password,
  });
  token = r.token;
  localStorage.setItem("cygnus_token", token);
  return r;
}

export async function logout() {
  try {
    await req("POST", "/auth/logout");
  } finally {
    clearToken();
  }
}

export const changePassword = (old_password: string, new_password: string) =>
  req<{ password_changed: boolean }>("POST", "/auth/change-password", {
    old_password,
    new_password,
  });

// ---- Users & Roles ----
export type UserRole = "owner" | "manager" | "accountant" | "cashier";
export interface AppUser {
  id: number;
  username: string;
  role: UserRole;
  active: boolean;
  created_at: string;
}
export const listUsers = () => req<AppUser[]>("GET", "/users");
export const whoami = () => req<{ id: number; username: string; role: UserRole }>("GET", "/auth/me");export const createUser = (username: string, password: string, role: UserRole) =>
  req<{ id: number }>("POST", "/users", { username, password, role });
export const updateUser = (id: number, patch: { role?: UserRole; active?: boolean }) =>
  req<{ ok: boolean }>("POST", `/users/${id}`, patch);
export const resetUserPassword = (id: number, password: string) =>
  req<{ ok: boolean }>("POST", `/users/${id}/reset-password`, { password });
export const deleteUser = (id: number) => req<{ ok: boolean }>("DELETE", `/users/${id}`);

export const listItems = () => req<Item[]>("GET", "/items");

export interface ItemTag {
  id: number;
  sku: string;
  metal: string;
  purity: string | null;
  gross_weight: string;
  net_weight: string;
  stone_weight: string;
  huid: string | null;
}
export const itemTags = (ids: number[]) => req<ItemTag[]>("GET", `/items/tags?ids=${ids.join(",")}`);

export interface StockLot {
  id: number;
  lot_no: string | null;
  metal: string;
  purity: string | null;
  gross_weight: string;
  net_weight: string;
  pieces: number;
  remaining_gross: string;
  remaining_pieces: number;
  cost_value: string;
  created_at: string;
}
export interface TagPieceReq {
  gross_weight: string;
  net_weight?: string;
  stone_weight?: string;
  huid?: string;
  category_id?: number;
  department_id?: number;
}
export interface TagLotResult {
  lot_id: number;
  tagged: number;
  item_ids: number[];
  remaining_gross: string;
  remaining_pieces: number;
  status: string;
}
export const listStockLots = () => req<StockLot[]>("GET", "/stock-lots");
export const tagStockLot = (id: number, pieces: TagPieceReq[]) =>
  req<TagLotResult>("POST", `/stock-lots/${id}/tag`, { pieces });
export interface ItemDetail {
  id: number;
  sku: string;
  metal: string;
  purity: string | null;
  gross_weight: string;
  net_weight: string;
  cost_value: string | null;
  ownership_state: string;
  huid: string | null;
  category?: string | null;
  hsn?: string | null;
  stones: {
    description: string | null;
    carat: string | null;
    pieces: number | null;
    rate: string | null;
    value: string;
    certificate_no: string | null;
    lab: string | null;
  }[];
}
export const getItem = (id: number) => req<ItemDetail>("GET", `/items/${id}`);
export const listRates = () => req<RateRow[]>("GET", "/rates");

export interface PriceReq {
  metal_type_id: number;
  purity_id: number;
  net_weight: string;
  making_per_gram?: string;
  making_percent?: string;
  wastage_percent?: string;
  stone_value?: string;
  discount?: string;
  gst_rate?: string;
  inter_state?: boolean;
  pricing_mode?: "normal" | "touch";
  touch_percent?: string;
  pure_rate?: string;
  unfixed?: boolean;
}
export const pricePreview = (p: PriceReq) =>
  req<PriceBreakdown>("POST", "/price-preview", p);

export interface SellReq {
  making_per_gram?: string;
  making_percent?: string;
  wastage_percent?: string;
  stone_value?: string;
  discount?: string;
  gst_rate?: string;
  inter_state?: boolean;
  payment_mode?: string;
  cash_amount?: string;
  customer_id?: number;
  series_code?: string;
  redeem_scheme_id?: number;
  old_gold?: { gross_weight: string; fineness: string; buy_rate: string };
  old_gold_value?: string;
}
export interface SellResult {
  invoice_id: number;
  document_no: string;
  grand_total: string;
  old_gold_value: string;
  scheme_credit: string;
  amount_payable: string;
}
export const sell = (itemId: number, s: SellReq) =>
  req<SellResult>("POST", `/items/${itemId}/sell`, s);

// ---- Customers ----
export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  pan: string | null;
}
export const listCustomers = () => req<Customer[]>("GET", "/customers");
export const createCustomer = (c: { name: string; phone?: string; pan?: string }) =>
  req<{ id: number; name: string }>("POST", "/customers", c);

// ---- On Approval (Out) ----
export interface ApprovalRow {
  id: number;
  item_id: number;
  sku?: string;
  customer_id: number | null;
  slip_no: string;
  due_back_at: string | null;
  status: string;
}
export const approvalOut = (
  itemId: number,
  body: { customer_id?: number; due_back_at?: string; series_code?: string },
) => req<{ approval_id: number; slip_no: string }>("POST", `/items/${itemId}/approval-out`, body);
export const listApprovals = () => req<ApprovalRow[]>("GET", "/approvals");
export const approvalReturn = (id: number) =>
  req<{ approval_id: number; status: string }>("POST", `/approvals/${id}/return`);

// ---- Settings ----
export const getSettings = () => req<Record<string, string>>("GET", "/settings");
export const setSetting = (key: string, value: string) =>
  req<{ key: string; value: string }>("POST", "/settings", { key, value });

/** Set (or clear, with empty lock_date) the books lock date + optional begin date. */
export const setBooksLock = (body: { lock_date?: string; begin_date?: string }) =>
  req<{ lock_date: string }>("POST", "/books/lock", body);

/** Download a .cjs backup file (binary). */
export async function downloadBackup(): Promise<Blob> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(getBase() + "/backup", { method: "POST", headers });
  if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
  return res.blob();
}

/** Upload a .cjs backup file to restore (replaces all data). */
export async function uploadRestore(file: File): Promise<{ restored: boolean; backup_timestamp: string }> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(getBase() + "/restore", {
    method: "POST",
    headers: { ...headers, "content-type": "application/octet-stream" },
    body: file,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  return JSON.parse(text);
}

export interface OpeningPartyRow { id: number; display_name: string; opening_cash_balance: string; opening_metal_balance: string }
export const openingParties = () => req<OpeningPartyRow[]>("GET", "/opening/parties");
export const setOpeningParties = (rows: { party_id: number; opening_cash_balance: string; opening_metal_balance: string }[]) =>
  req<{ updated: number }>("POST", "/opening/parties", rows);
export interface OpeningStockSummary { rows: { department: string; pieces: number; cost: string }[]; total: string }
export const openingStockSummary = () => req<OpeningStockSummary>("GET", "/opening/stock-summary");
export interface OpeningStockItemReq { department_id?: number; metal_type_id: number; purity_id: number; gross_weight: string; net_weight: string; stone_weight?: string; huid?: string; cost_value: string; category_id?: number; sku?: string }
export const createOpeningStock = (items: OpeningStockItemReq[]) =>
  req<{ items: { item_id: number; sku: string }[]; item_ids: number[] }>("POST", "/opening/stock", { items });

// ---- Document numbering (series) ----
export interface DocSeries {
  doc_type: string;
  fy: string;
  series_code: string;
  prefix: string;
  suffix: string;
  pad_width: number;
  next_no: number;
  active: boolean;
}
export interface DocSeriesReq {
  doc_type: string;
  fy: string;
  series_code?: string;
  prefix: string;
  suffix?: string;
  pad_width?: number;
  start_no?: number;
}
export const listDocSeries = () => req<DocSeries[]>("GET", "/document-series");
export const upsertDocSeries = (body: DocSeriesReq) =>
  req<{ doc_type: string; fy: string; series_code: string; next_number_preview: string }>("POST", "/document-series", body);

// ---- Sales Return (credit note) ----
export interface ReturnReq {
  line_ids?: number[];
  reason?: string;
  refund_mode?: string;
  override_window?: boolean;
  deduction?: string;
  settlement_mode?: "store_credit" | "refund";
  old_gold_action?: "physical" | "cash";
}
export interface ReturnResult {
  credit_note_id: number;
  document_no: string;
  reason: string | null;
  settlement_mode: string;
  refund_mode: string;
  lines_returned: number;
  subtotal: string;
  tax_total: string;
  total: string;
  deduction: string;
  monetary_settlement: string;
  advance_recredit: string;
  scheme_credit: string;
  old_gold_physical: boolean;
  old_gold_cash: string;
  invoice_status: string;
}
export const returnInvoice = (invoiceId: number, body: ReturnReq) =>
  req<ReturnResult>("POST", `/invoices/${invoiceId}/return`, body);

export interface SalesSummary {
  bills: number;
  gross: string;
  tax: string;
  old_gold: string;
  net_received: string;
}
export interface StockRow {
  metal: string;
  purity: string;
  pieces: number;
  net_weight: string;
  cost_value: string;
}
export const salesSummary = () => req<SalesSummary>("GET", "/reports/sales-summary");
export const stockSummary = () => req<StockRow[]>("GET", "/reports/stock-summary");

export interface MetalAccountRow {
  metal: string;
  scrap_taken_in_fine: string;
  scrap_on_hand_fine: string;
  scrap_on_hand_gross: string;
  melted_recovered_fine: string;
  melt_loss: string;
  refined_pool_fine: string;
  issued_to_smith_fine: string;
  received_from_smith_fine: string;
  smith_holding_fine: string;
  wastage_fine: string;
}
export const metalAccount = () => req<MetalAccountRow[]>("GET", "/reports/metal-account");

export interface LooseStoneRow {
  id: number;
  description: string;
  grade: string;
  carat: string | null;
  pieces: number | null;
  cost_value: string;
  certificate_no: string | null;
  lab: string | null;
  source: "manual" | "old_gold" | "purchase";
  status: "in_stock" | "used" | "sold";
}
export const listLooseStones = () => req<LooseStoneRow[]>("GET", "/loose-stones");
export const createLooseStone = (body: {
  stone_type_id?: number;
  stone_quality_id?: number;
  description?: string;
  carat?: string;
  pieces?: number;
  cost_value: string;
  certificate_no?: string;
  lab?: string;
}) => req<{ id: number }>("POST", "/loose-stones", body);
export const updateLooseStone = (id: number, status: "in_stock" | "used" | "sold") =>
  req<unknown>("POST", `/loose-stones/${id}`, { status });

// ---- Resale (second-hand, margin scheme) ----
export interface ResaleItemRow {
  id: number;
  description: string;
  metal: string | null;
  purity: string | null;
  gross_weight: string | null;
  purchase_cost: string;
  status: "in_stock" | "sold";
  sale_price: string | null;
  margin: string | null;
  gst: string | null;
}
export const listResaleItems = () => req<ResaleItemRow[]>("GET", "/resale-items");
export const createResaleItem = (body: {
  description: string;
  metal_type_id?: number;
  purity_id?: number;
  gross_weight?: string;
  net_weight?: string;
  purchase_cost: string;
}) => req<{ id: number }>("POST", "/resale-items", body);
export const sellResaleItem = (id: number, body: { sale_price: string; gst_rate?: string }) =>
  req<{ id: number; sale_price: string; margin: string; gst: string; total: string }>("POST", `/resale-items/${id}/sell`, body);

// ---- Item categories + stock overview ----
export interface ItemCategory {
  id: number;
  name: string;
  active: boolean;
  sort_order: number;
}
export const listItemCategories = () => req<ItemCategory[]>("GET", "/item-categories");
export const createItemCategory = (body: { name: string; sort_order?: number }) =>
  req<{ id: number }>("POST", "/item-categories", body);
export const updateItemCategory = (id: number, body: { name?: string; active?: boolean; sort_order?: number }) =>
  req<unknown>("POST", `/item-categories/${id}`, body);

export interface Department { id: number; name: string; sort_order: number; active: boolean }
export const listDepartments = () => req<Department[]>("GET", "/departments");
export const createDepartment = (body: { name: string; sort_order?: number }) =>
  req<{ id: number }>("POST", "/departments", body);
export const updateDepartment = (id: number, body: { name?: string; sort_order?: number; active?: boolean }) =>
  req<{ updated: boolean }>("POST", `/departments/${id}`, body);

export interface StockOverview {
  metals: { department: string; metal: string; purity: string; label: string; has_diamond: boolean; pieces: number; gross: string; stone: string; net: string; diamond_carat: string }[];
  categories: { metal: string; has_diamond: boolean; category: string; pieces: number; gross: string; net: string; stone: string; diamond_carat: string }[];
  loose_stones: { stone: string; pieces: number; carat: string; value: string }[];
  old_metal: { metal: string; stone_set: boolean; label: string; lots: number; gross: string; stone: string; net: string; fine: string; value: string }[];
  old_stones: { stone: string; pieces: number; carat: string; value: string }[];
  open_lots?: { id: number; metal: string; purity: string | null; remaining_gross: string; remaining_pieces: number; cost_value: string }[];
  untagged_items?: { pieces: number; net: string };
}
export const stockOverview = () => req<StockOverview>("GET", "/reports/stock-overview");
export const listUntaggedItems = () => req<ItemTag[]>("GET", "/items/untagged");
export const markItemsTagged = (ids: number[]) =>
  req<{ updated: number }>("POST", "/items/mark-tagged", { ids });

export interface PaymentModeRow {
  mode: string;
  count: number;
  total: string;
}
export const paymentModes = () => req<PaymentModeRow[]>("GET", "/reports/payment-modes");

// ---- Metals master (for loose-line entry) ----
export interface PurityOpt {
  purity_id: number;
  label: string;
  fineness: number;
  sell_rate: string | null;
  buy_rate: string | null;
  cash_rate?: string | null;
}
export interface MetalOpt {
  metal_type_id: number;
  metal: string;
  default_hsn?: string | null;
  purities: PurityOpt[];
}
export const listMetals = () => req<MetalOpt[]>("GET", "/metals");

// ---- Multi-line invoice ----
export interface InvoiceLineReq {
  item_id?: number;
  metal_type_id?: number;
  purity_id?: number;
  description?: string;
  hsn?: string;
  huid?: string;
  gross_weight?: string;
  net_weight?: string;
  making_per_gram?: string;
  making_percent?: string;
  wastage_percent?: string;
  stone_value?: string;
  discount?: string;
  rate_override?: string;
  pricing_mode?: "normal" | "touch";
  touch_percent?: string;
  pure_rate?: string;
  department_id?: number;
  stones?: LineStoneReq[];
}
export interface LineStoneReq {
  stone_type_id?: number;
  stone_quality_id?: number;
  description?: string;
  carat?: string;
  pieces?: number;
  rate?: string;
  value: string;
  certificate_no?: string;
  lab?: string;
}
export interface OldGoldLineReq {
  metal_type_id: number;
  purity_id?: number;
  kind?: "gold" | "silver" | "platinum" | "diamond";
  gross_weight: string;
  deduction_percent?: string;
  rate?: string;
  stones?: LineStoneReq[];
  stone_action?: "return" | "buy";
  tested_fineness?: number;
  stone_weight?: string;
  buyback_percent?: string;
}
export interface TenderReq {
  mode: string;
  amount: string;
  reference?: string;
}
export interface InvoiceCreateReq {
  customer_id?: number;
  party_id?: number;
  invoice_type?: "retail" | "b2b";
  inter_state?: boolean;
  unfixed?: boolean;
  series_code?: string;
  payment_mode?: string;
  cash_amount?: string;
  tenders?: TenderReq[];
  old_gold_value?: string;
  old_gold?: OldGoldLineReq[];
  target_total?: string;
  redeem_scheme_id?: number;
  advance_applied?: string;
  gst_rate?: string;
  allow_below_cost?: boolean;
  lines: InvoiceLineReq[];
}
export interface InvoiceCreateResult {
  invoice_id: number;
  document_no: string;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  grand_total: string;
  old_gold_value: string;
  scheme_credit: string;
  advance_applied: string;
  amount_payable: string;
  lines: number;
}
export const createInvoice = (body: InvoiceCreateReq) =>
  req<InvoiceCreateResult>("POST", "/invoices", body);

export interface InvoiceListRow {
  id: number;
  document_no: string | null;
  created_at: string;
  invoice_type: string;
  grand_total: string;
  amount_payable: string | null;
  status: string;
  customer_name: string | null;
}
export const listInvoices = () => req<InvoiceListRow[]>("GET", "/invoices");

export interface InvoiceDetailLine {
  id: number;
  item_id: number | null;
  returned: boolean;
  description: string | null;
  hsn: string | null;
  purity_label: string | null;
  gross_weight: string | null;
  net_weight: string | null;
  huid: string | null;
  making_label: string | null;
  rate_used: string;
  breakdown: PriceBreakdown;
  taxable_value: string;
  line_total: string;
  stones?: {
    description: string | null;
    carat: string | null;
    pieces: number | null;
    rate: string | null;
    value: string;
    certificate_no: string | null;
    lab: string | null;
  }[];
}
export interface InvoiceDetail {
  id: number;
  document_no: string | null;
  type: string;
  created_at: string;
  fy: string;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  grand_total: string;
  amount_payable: string | null;
  payment_mode: string | null;
  status: string;
  customer_name: string | null;
  old_gold_value: string;
  scheme_credit: string;
  advance_applied: string;
  old_gold_lots: OldGoldRow[];
  tenders: { mode: string; amount: string; reference: string | null }[];
  lines: InvoiceDetailLine[];
}
export const getInvoice = (id: number) => req<InvoiceDetail>("GET", `/invoices/${id}`);

// ---- Old gold register (scrap stock) ----
export interface OldGoldRow {
  id: number;
  created_at: string;
  metal: string;
  purity: string | null;
  gross_weight: string;
  deduction_percent: string;
  net_weight: string;
  fine_weight: string | null;
  rate: string;
  value: string;
  status: string;
  document_no: string | null;
  customer_name: string | null;
  department?: string | null;
}
export const listOldGold = () => req<OldGoldRow[]>("GET", "/old-gold");

export interface ConvertLotReq {
  department_id?: number;
  category_id?: number;
  purity_id?: number;
  gross_weight?: string;
  net_weight?: string;
  stone_weight?: string;
  repair_cost?: string;
  making?: string;
  sku?: string;
  huid?: string;
}
export interface ConvertLotResp { item_id: number; sku: string; cost_value: string }
export const convertOldGold = (id: number, body: ConvertLotReq) =>
  req<ConvertLotResp>("POST", `/old-gold/${id}/convert`, body);

// ---- Schemes ----
export interface SchemeRow {
  id: number;
  scheme_no: string | null;
  customer_id: number | null;
  monthly_amount: string;
  installments_required: number;
  status: string;
  total_paid: string;
  maturity_value: string | null;
}
export interface SchemeInstallment {
  seq: number;
  amount: string;
  payment_mode: string | null;
  paid_at: string;
  rate_used: string | null;
  grams: string | null;
  reference: string | null;
}
export interface SchemeDetail {
  id: number;
  scheme_no: string | null;
  customer_id: number | null;
  customer_name: string | null;
  scheme_type: "value" | "gram";
  monthly_amount: string;
  installments_required: number;
  bonus_installments: number;
  total_paid: string;
  total_grams: string;
  status: string;
  maturity_value: string | null;
  average_rate: string | null;
  start_date: string;
  metal: string | null;
  purity: string | null;
  installments: SchemeInstallment[];
}
export const listSchemes = (status?: string) =>
  req<SchemeRow[]>("GET", `/schemes${status ? `?status=${status}` : ""}`);
export const getScheme = (id: number) => req<SchemeDetail>("GET", `/schemes/${id}`);

// ---- Customer advances ----
export interface AdvanceRow {
  id: number;
  advance_no: string | null;
  created_at: string;
  amount: string;
  balance: string;
  status: string;
  note: string | null;
  payment_mode: string | null;
  customer_id: number;
  customer_name: string | null;
  customer_phone: string | null;
  advance_type: "amount" | "metal";
  booked_weight: string;
  rate_locked: string | null;
  percent: string | null;
  due_date: string | null;
  metal: string | null;
  purity: string | null;
}
export interface AdvanceCreateReq {
  amount?: string;
  note?: string;
  payment_mode?: string;
  advance_type?: "amount" | "metal";
  metal_type_id?: number;
  purity_id?: number;
  booked_weight?: string;
  rate_locked?: string;
  percent?: string;
  due_date?: string;
}
export interface AdvanceMetrics {
  active_count: number;
  total_balance: string;
  total_amount: string;
  booked_weight: string;
  customers_with_balance: number;
  due_week_count: number;
  due_week: AdvanceRow[];
  by_type: { amount: { count: number; balance: string }; metal: { count: number; balance: string } };
}
export const recordAdvance = (customerId: number, body: AdvanceCreateReq) =>
  req<{ id: number; amount: string; advance_type: string; booked_weight: string; rate_locked: string | null; percent: string }>(
    "POST",
    `/customers/${customerId}/advances`,
    body,
  );
export const listCustomerAdvances = (customerId: number) =>
  req<{ balance: string; advances: AdvanceRow[] }>("GET", `/customers/${customerId}/advances`);
export const listAdvances = () => req<AdvanceRow[]>("GET", "/advances");
export const advanceMetrics = () => req<AdvanceMetrics>("GET", "/advances/metrics");
export const closeAdvance = (id: number, opts?: { note?: string; refund?: boolean; refund_mode?: string }) =>
  req<{ id: number; status: string; amount: string; refund_mode: string | null }>("POST", `/advances/${id}/close`, opts ?? {});

// ---- Cheque register ----
export interface ChequeRow {
  id: number;
  cheque_no: string | null;
  bank: string | null;
  amount: string;
  status: string;
  received_at: string;
  deposited_at: string | null;
  cleared_at: string | null;
  bounced_at: string | null;
  document_no: string | null;
  customer_name: string | null;
}
export const listCheques = (status?: string) =>
  req<ChequeRow[]>("GET", `/cheques${status ? `?status=${status}` : ""}`);
export const updateCheque = (id: number, body: { status: string; bank?: string }) =>
  req<{ id: number; status: string }>("POST", `/cheques/${id}/status`, body);

// ---- Estimates (same-day quotations) ----
export interface EstimateCreateReq {
  customer_id?: number;
  invoice_type?: "retail" | "b2b";
  inter_state?: boolean;
  series_code?: string;
  old_gold_value?: string;
  gst_rate?: string;
  lines: InvoiceLineReq[];
}
export interface EstimateCreateResult {
  estimate_id: number;
  document_no: string;
  subtotal: string;
  tax_total: string;
  grand_total: string;
  old_gold_value: string;
  valid_today: boolean;
  note: string;
}
export const createEstimate = (body: EstimateCreateReq) =>
  req<EstimateCreateResult>("POST", "/estimates", body);

export interface EstimateListRow {
  id: number;
  document_no: string;
  created_at: string;
  valid_on: string;
  valid_today: boolean;
  type: string;
  grand_total: string;
  status: string; // open | converted | expired (effective)
  converted_invoice_id: number | null;
  customer_name: string | null;
}
export const listEstimates = () => req<EstimateListRow[]>("GET", "/estimates");
export const deleteEstimate = (id: number) => req<{ deleted: boolean }>("DELETE", `/estimates/${id}`);

export interface EstimateDetail {
  id: number;
  document_no: string;
  type: string;
  created_at: string;
  valid_on: string;
  valid_today: boolean;
  subtotal: string;
  tax_total: string;
  grand_total: string;
  old_gold_value: string;
  status: string;
  converted_invoice_id: number | null;
  customer_name: string | null;
  lines: InvoiceDetailLine[];
}
export const getEstimate = (id: number) => req<EstimateDetail>("GET", `/estimates/${id}`);

export const convertEstimate = (id: number, body: { payment_mode?: string; cash_amount?: string }) =>
  req<InvoiceCreateResult>("POST", `/estimates/${id}/convert`, body);


// ---- Rates (daily entry) ----
export const createRate = (body: {
  metal_type_id: number;
  purity_id: number;
  buy_rate: string;
  sell_rate: string;
  cash_rate?: string;
  effective_date?: string;
}) => req<{ id: number }>("POST", "/rates", body);

// ---- Advance refund ----
export const refundAdvance = (
  customerId: number,
  body: { amount: string; refund_mode?: string; note?: string },
) => req<{ refunded: string; refund_mode: string }>("POST", `/customers/${customerId}/advances/refund`, body);

// ---- Smith job-work ----
export interface SmithRow {
  id: number;
  name: string;
  phone: string | null;
  gstin: string | null;
  gst_registered: boolean;
  metal_balance: string;
  cash_payable: string;
}
export const listSmiths = () => req<SmithRow[]>("GET", "/smiths");
export const createSmith = (body: { name: string; phone?: string; gstin?: string; gst_registered?: boolean; notes?: string }) =>
  req<{ id: number; name: string }>("POST", "/smiths", body);

export const createMelt = (body: { metal_type_id: number; old_gold_lot_ids: number[]; fine_recovered: string; note?: string }) =>
  req<{ melt_batch_id: number; gross: string; expected_fine: string; fine_recovered: string; loss: string; variance: string }>("POST", "/melts", body);

export interface SmithJobRow {
  id: number;
  smith: string;
  status: string;
  issued_fine: string;
  received_fine: string | null;
  wastage_weight: string | null;
  making_charge: string | null;
  rcm: boolean;
  item_sku: string | null;
}
export const listSmithJobs = () => req<SmithJobRow[]>("GET", "/smith-jobs");
export const issueSmithJob = (body: {
  smith_id: number;
  metal_type_id: number;
  source: "scrap" | "refined";
  issued_fine_weight: string;
  issued_gross_weight?: string;
  old_gold_lot_ids?: number[];
  wastage_percent_allowed?: string;
  making_per_gram?: string;
  making_per_piece?: string;
}) => req<{ smith_job_id: number; status: string }>("POST", "/smith-jobs", body);
export const receiveSmithJob = (
  id: number,
  body: { purity_id: number; sku?: string; received_gross: string; received_net: string; received_fine: string; pieces?: number; making_per_gram?: string; making_per_piece?: string; stones?: LineStoneReq[]; category_id?: number },
) => req<{ smith_job_id: number; item_id: number; sku: string; making_charge: string; making_gst: string; rcm: boolean; wastage_weight: string; payable_to_smith: string }>("POST", `/smith-jobs/${id}/receive`, body);
export const settleSmithJob = (id: number, body: { amount: string; mode?: string }) =>
  req<{ smith_job_id: number; status: string; paid: string }>("POST", `/smith-jobs/${id}/settle`, body);


// ---- Schemes (create / pay / close) ----
export const createScheme = (body: {
  customer_id?: number;
  monthly_amount: string;
  installments_required?: number;
  scheme_type?: "value" | "gram";
  metal_type_id?: number;
  purity_id?: number;
}) => req<{ scheme_id: number; scheme_no: string; status: string }>("POST", "/schemes", body);
export const schemePay = (id: number, body: { amount?: string; payment_mode?: string; reference?: string }) =>
  req<{ scheme_id: number; installment: number; total_paid: string; status: string; maturity_value: string | null }>(
    "POST",
    `/schemes/${id}/pay`,
    body,
  );
export const schemeClose = (id: number) =>
  req<{ scheme_id: number; status: string; redeemable_value?: string; redeemable_grams?: string; note: string }>(
    "POST",
    `/schemes/${id}/close`,
  );

// ---- Suppliers ----
export interface SupplierRow {
  id: number;
  name: string;
  gstin: string | null;
  balance: string;
}
export const listSuppliers = () => req<SupplierRow[]>("GET", "/suppliers");
export const createSupplier = (body: { name: string; gstin?: string }) =>
  req<{ id: number }>("POST", "/suppliers", body);

// ---- Purchases (v2) ----
export interface PurchaseRow {
  id: number;
  document_no: string | null;
  party_name: string | null;
  bill_kind: string;
  total: string;
  tax_total: string;
  paid_total: string;
  balance: string;
  status: string;
  created_at: string;
  supplier_invoice_no: string;
}
export interface PurchaseLineReq {
  pricing_mode: "fixed_cost" | "weight_rate" | "touch" | "stone" | "lot";
  sku?: string;
  metal_type_id?: number;
  purity_id?: number;
  gross_weight: string;
  net_weight?: string;
  stone_weight?: string;
  pieces?: number;
  touch_percent?: string;
  pure_rate?: string;
  rate?: string;
  making_per_gram?: string;
  cost_value?: string;
  huid?: string;
  category_id?: number;
  department_id?: number;
  hsn?: string;
  gst_rate?: string;
  stones?: LineStoneReq[];
}
export interface PurchasePaymentReq {
  mode: "cash" | "bank" | "cheque";
  amount: string;
  reference?: string;
}
export interface PurchaseCreateReq {
  party_id?: number;
  supplier_id?: number;
  bill_kind: "local" | "b2b";
  rcm?: boolean;
  inter_state?: boolean;
  unfixed?: boolean;
  supplier_invoice_no?: string;
  lines: PurchaseLineReq[];
  payments?: PurchasePaymentReq[];
  tag_now?: boolean;
}
export interface PurchaseCreateResult {
  purchase_bill_id: number;
  document_no: string;
  subtotal: string;
  tax_total: string;
  total: string;
  total_fine: string;
  paid_total: string;
  balance: string;
  items_received: number[];
}
export interface PurchaseDetail {
  id: number;
  document_no: string | null;
  party_name: string | null;
  bill_kind: string;
  rcm: boolean;
  inter_state: boolean;
  supplier_invoice_no: string | null;
  subtotal: string;
  making_total: string;
  stone_total: string;
  tax_total: string;
  total: string;
  total_fine: string;
  paid_total: string;
  balance: string;
  status: string;
  created_at: string;
  lines: {
    id: number;
    returned: boolean;
    description: string;
    pricing_mode: string;
    gross_weight: string;
    net_weight: string;
    stone_weight: string;
    touch_percent: string | null;
    pure_rate: string | null;
    chargeable_fine: string;
    making_amount: string;
    stone_value: string;
    taxable_value: string;
    gst_rate: string;
    line_total: string;
    hsn: string | null;
    stones: LineStoneReq[] | null;
  }[];
  payments: { mode: string; amount: string; reference: string | null; created_at: string }[];
}
export const listPurchases = () => req<PurchaseRow[]>("GET", "/purchases");
export const getPurchase = (id: number) => req<PurchaseDetail>("GET", `/purchases/${id}`);
export const createPurchase = (body: PurchaseCreateReq) =>
  req<PurchaseCreateResult>("POST", "/purchases", body);

export interface PurchaseReturnRow {
  id: number;
  document_no: string | null;
  party_name: string | null;
  total: string;
  tax_total: string;
  created_at: string;
  purchase_bill_id: number;
}
export const listPurchaseReturns = () => req<PurchaseReturnRow[]>("GET", "/purchase-returns");
export const createPurchaseReturn = (body: { purchase_bill_id: number; line_ids: number[]; refund_mode?: string; note?: string }) =>
  req<{ purchase_return_id: number; document_no: string; total: string }>("POST", "/purchase-returns", body);


// ---- Unified Party (Option C) ----
export type PartyRole = "customer" | "wholesale" | "supplier" | "smith" | "broker" | "consignee";

export interface PartyListRow {
  id: number;
  display_name: string;
  party_kind: "individual" | "business";
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  state_code: string | null;
  gst_registration_type: string;
  roles: PartyRole[];
  cash_balance: string;
  metal_balance: string;
}
export interface PartyDetail {
  id: number;
  display_name: string;
  legal_name: string | null;
  party_kind: "individual" | "business";
  phone: string | null;
  email: string | null;
  pan: string | null;
  gstin: string | null;
  gst_registration_type: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  pincode: string | null;
  state_code: string | null;
  cdd_risk_tier: string;
  created_at: string;
  roles: PartyRole[];
  balances: {
    party_cash: string;
    party_metal: string;
    advance_credit: string;
    supplier_payable: string;
    smith_metal: string;
    smith_payable: string;
  };
  terms: {
    price_tier: string;
    credit_limit: string;
    credit_days: number;
    default_making_percent: string | null;
    opening_cash_balance: string;
    opening_metal_balance: string;
  } | null;
  addresses: {
    id: number;
    label: string | null;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    pincode: string | null;
    state_code: string | null;
    is_default: boolean;
  }[];
}
export interface NewPartyReq {
  display_name: string;
  legal_name?: string;
  party_kind?: "individual" | "business";
  phone?: string;
  email?: string;
  pan?: string;
  gstin?: string;
  gst_registration_type?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  pincode?: string;
  state_code?: string;
  notes?: string;
  opening_cash_balance?: string;
  opening_metal_balance?: string;
  roles?: PartyRole[];
}
export interface PartyLedgerRow {
  id: number;
  at: string;
  event_type: string;
  amount_delta: string;
  weight_delta: string;
  detail: unknown;
}
export const listParties = (role?: string, q?: string, archived?: boolean) => {
  const p = new URLSearchParams();
  if (role) p.set("role", role);
  if (q) p.set("q", q);
  if (archived) p.set("archived", "true");
  const qs = p.toString();
  return req<PartyListRow[]>("GET", `/parties${qs ? `?${qs}` : ""}`);
};
export const createParty = (body: NewPartyReq) => req<{ id: number; display_name: string; roles: string[] }>("POST", "/parties", body);

export interface RateCutRow {
  id: number;
  document_no: string | null;
  party_name: string | null;
  grams: string;
  rate: string;
  amount: string;
  direction: string;
  created_at: string;
}
export const listRateCuts = () => req<RateCutRow[]>("GET", "/rate-cuts");
export const createRateCut = (body: { party_id: number; grams: string; rate: string; direction?: "we_owe" | "they_owe"; note?: string }) =>
  req<{ rate_cut_id: number; document_no: string; grams: string; rate: string; amount: string; direction: string }>("POST", "/rate-cuts", body);
export const getParty = (id: number) => req<PartyDetail>("GET", `/parties/${id}`);
export const updateParty = (id: number, body: Partial<NewPartyReq>) =>
  req<{ id: number; updated: boolean }>("POST", `/parties/${id}`, body);
export const deleteParty = (id: number) =>
  req<{ deleted: boolean; archived: boolean }>("DELETE", `/parties/${id}`);
export const restoreParty = (id: number) =>
  req<{ id: number; restored: boolean }>("POST", `/parties/${id}/restore`);
export const addPartyRole = (id: number, role: PartyRole) => req<unknown>("POST", `/parties/${id}/roles`, { role });
export const setPartyTerms = (
  id: number,
  body: { price_tier?: string; credit_limit?: string; credit_days?: number; default_making_percent?: string },
) => req<unknown>("POST", `/parties/${id}/terms`, body);
export const addPartyAddress = (
  id: number,
  body: { label?: string; address_line1?: string; address_line2?: string; city?: string; pincode?: string; state_code?: string; is_default?: boolean },
) => req<{ id: number }>("POST", `/parties/${id}/addresses`, body);
export const partyCashEntry = (id: number, body: { amount: string; entry_type: "debit" | "credit"; mode?: string; note?: string }) =>
  req<unknown>("POST", `/parties/${id}/cash-entry`, body);
export const partyMetalEntry = (
  id: number,
  body: { weight: string; metal_type_id?: number; entry_type: "debit" | "credit"; rate?: string; note?: string },
) => req<unknown>("POST", `/parties/${id}/metal-entry`, body);
export const partyLedger = (id: number) => req<PartyLedgerRow[]>("GET", `/parties/${id}/ledger`);
export const invoiceEinvoice = (id: number) => req<Record<string, unknown>>("GET", `/invoices/${id}/einvoice`);

// GST 2-digit state codes (for the B2B state dropdown / place of supply).
export const GST_STATE_CODES: { code: string; name: string }[] = [
  { code: "01", name: "Jammu & Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra & Nagar Haveli and Daman & Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman & Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];


// ---- Materials master: Metals ----
export interface MetalTypeMaster {
  id: number;
  name: string;
  base_unit: string;
  default_hsn: string | null;
  gst_rate: string | null;
  hallmark_applicable: boolean;
  active: boolean;
  purities: { id: number; label: string; karat: string | null; fineness: number; active: boolean }[];
}
export const listMetalTypes = () => req<MetalTypeMaster[]>("GET", "/metal-types");
export const createMetalType = (body: {
  name: string;
  base_unit?: string;
  default_hsn?: string;
  gst_rate?: string;
  hallmark_applicable?: boolean;
}) => req<{ id: number }>("POST", "/metal-types", body);
export const updateMetalType = (
  id: number,
  body: { default_hsn?: string; gst_rate?: string; hallmark_applicable?: boolean; active?: boolean },
) => req<unknown>("POST", `/metal-types/${id}`, body);
export const createPurity = (body: { metal_type_id: number; label: string; karat?: string; fineness: number }) =>
  req<{ id: number }>("POST", "/purities", body);
export const updatePurity = (
  id: number,
  body: { label?: string; karat?: string; fineness?: number; active?: boolean },
) => req<unknown>("POST", `/purities/${id}`, body);

// ---- Materials master: Stones ----
export type StoneCategory = "diamond" | "precious" | "semi_precious" | "pearl" | "synthetic";
export type StonePricingMode = "per_carat_quality" | "per_carat_flat" | "per_piece";
export interface StoneQualityMaster {
  id: number;
  grade_label: string;
  color: string | null;
  clarity: string | null;
  size_band: string | null;
  rate_per_carat: string;
  active: boolean;
}
export interface StoneTypeMaster {
  id: number;
  name: string;
  category: StoneCategory;
  unit: "carat" | "piece";
  pricing_mode: StonePricingMode;
  default_hsn: string | null;
  gst_rate: string | null;
  certifiable: boolean;
  active: boolean;
  qualities: StoneQualityMaster[];
}
export const listStoneTypes = () => req<StoneTypeMaster[]>("GET", "/stone-types");
export const createStoneType = (body: {
  name: string;
  category: StoneCategory;
  unit?: "carat" | "piece";
  pricing_mode?: StonePricingMode;
  default_hsn?: string;
  gst_rate?: string;
  certifiable?: boolean;
}) => req<{ id: number }>("POST", "/stone-types", body);
export const updateStoneType = (
  id: number,
  body: { unit?: string; pricing_mode?: string; default_hsn?: string; gst_rate?: string; certifiable?: boolean; active?: boolean },
) => req<unknown>("POST", `/stone-types/${id}`, body);
export const createStoneQuality = (body: {
  stone_type_id: number;
  grade_label: string;
  color?: string;
  clarity?: string;
  size_band?: string;
  rate_per_carat: string;
}) => req<{ id: number }>("POST", "/stone-qualities", body);
export const updateStoneQuality = (
  id: number,
  body: { grade_label?: string; color?: string; clarity?: string; size_band?: string; rate_per_carat?: string; active?: boolean },
) => req<unknown>("POST", `/stone-qualities/${id}`, body);

// ---- Staff / Attendance / Leave / Payroll / Biometric ----
export interface Staff {
  id: number;
  code: string;
  name: string;
  phone?: string | null;
  designation?: string | null;
  department?: string | null;
  join_date?: string | null;
  salary_type: "monthly" | "daily" | "hourly";
  base_salary: string;
  allowances: string;
  biometric_user_id?: string | null;
  pan?: string | null;
  aadhaar?: string | null;
  bank_account?: string | null;
  bank_ifsc?: string | null;
  uan?: string | null;
  esi_ip?: string | null;
  weekly_off: number;
  status: "active" | "inactive";
}
export interface StaffReq {
  code: string;
  name: string;
  phone?: string;
  designation?: string;
  department?: string;
  join_date?: string;
  salary_type?: string;
  base_salary?: string;
  allowances?: string;
  biometric_user_id?: string;
  pan?: string;
  aadhaar?: string;
  bank_account?: string;
  bank_ifsc?: string;
  uan?: string;
  esi_ip?: string;
  weekly_off?: number;
  status?: string;
}
export const listStaff = () => req<Staff[]>("GET", "/staff");
export const getStaff = (id: number) => req<Staff>("GET", `/staff/${id}`);
export const createStaff = (body: StaffReq) => req<{ id: number }>("POST", "/staff", body);
export const updateStaff = (id: number, body: StaffReq) => req<{ ok: boolean }>("POST", `/staff/${id}`, body);
export interface StatutoryFile { filename: string; content: string; members: number; skipped_no_uan?: number; skipped_no_ip?: number }
export const payrollPfEcr = (runId: number) => req<StatutoryFile>("GET", `/payroll-runs/${runId}/pf-ecr`);
export const payrollEsiReturn = (runId: number) => req<StatutoryFile>("GET", `/payroll-runs/${runId}/esi-return`);

export interface AttendanceRow {
  id: number;
  staff_id: number;
  staff_name: string;
  day: string;
  status: string;
  check_in: string | null;
  check_out: string | null;
  hours: string;
  source: string;
  note: string | null;
}
export interface AttendanceSummaryRow {
  staff_id: number;
  staff_name: string;
  present: number;
  half_day: number;
  leave: number;
  absent: number;
  week_off: number;
  holiday: number;
  hours: string;
}
export const listAttendance = (month: string, staffId?: number) =>
  req<AttendanceRow[]>("GET", `/attendance?month=${month}${staffId ? `&staff_id=${staffId}` : ""}`);
export const attendanceSummary = (month: string) =>
  req<AttendanceSummaryRow[]>("GET", `/attendance/summary?month=${month}`);
export const markAttendance = (body: { staff_id: number; day: string; status: string; check_in?: string; check_out?: string; note?: string }) =>
  req<{ ok: boolean }>("POST", "/attendance", body);

export interface LeaveType {
  id: number;
  code: string;
  name: string;
  paid: boolean;
  annual_quota: string;
}
export interface LeaveRequestRow {
  id: number;
  staff_id: number;
  staff_name: string;
  leave_type: string;
  paid: boolean;
  from_day: string;
  to_day: string;
  days: string;
  reason: string | null;
  status: string;
  applied_at: string;
}
export interface LeaveBalance {
  leave_type_id: number;
  code: string;
  name: string;
  paid: boolean;
  quota: string;
  used: string;
  balance: string;
}
export const listLeaveTypes = () => req<LeaveType[]>("GET", "/leave-types");
export const listLeaveRequests = (status?: string, staffId?: number) => {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (staffId) p.set("staff_id", String(staffId));
  const qs = p.toString();
  return req<LeaveRequestRow[]>("GET", `/leave-requests${qs ? `?${qs}` : ""}`);
};
export const applyLeave = (body: { staff_id: number; leave_type_id: number; from_day: string; to_day: string; reason?: string; half_day?: boolean }) =>
  req<{ id: number; days: string }>("POST", "/leave-requests", body);
export const decideLeave = (id: number, status: "approved" | "rejected") =>
  req<{ ok: boolean }>("POST", `/leave-requests/${id}/decide`, { status });
export const cancelLeave = (id: number) => req<{ ok: boolean }>("POST", `/leave-requests/${id}/cancel`, {});
export const leaveBalances = (staffId: number, year: string) =>
  req<LeaveBalance[]>("GET", `/leave-balances?staff_id=${staffId}&year=${year}`);

export interface PayrollRun {
  id: number;
  period: string;
  status: "draft" | "finalized" | "paid";
  days_in_month: number;
  gross_total: string;
  net_total: string;
  created_at?: string;
}
export interface Payslip {
  id: number;
  staff_id: number;
  staff_name: string;
  staff_code: string;
  present_days: string;
  paid_leave_days: string;
  lop_days: string;
  payable_days: string;
  base_earned: string;
  allowances: string;
  pf: string;
  esi: string;
  pt: string;
  tds: string;
  loan_recovery: string;
  deductions: string;
  ot_hours?: string;
  ot_pay?: string;
  employer_pf?: string;
  employer_esi?: string;
  net_pay: string;
  note: string | null;
}
export interface PayrollRunDetail extends PayrollRun {
  payslips: Payslip[];
}
export const listPayrollRuns = () => req<PayrollRun[]>("GET", "/payroll-runs");
export const getPayrollRun = (id: number) => req<PayrollRunDetail>("GET", `/payroll-runs/${id}`);
export const generatePayroll = (period: string) => req<PayrollRun>("POST", "/payroll-runs", { period });
export const setPayrollStatus = (id: number, status: "draft" | "finalized" | "paid") =>
  req<{ ok: boolean }>("POST", `/payroll-runs/${id}/status`, { status });
export const updatePayslip = (id: number, body: { allowances?: string; deductions?: string; pf?: string; esi?: string; pt?: string; tds?: string; note?: string }) =>
  req<{ ok: boolean }>("POST", `/payslips/${id}`, body);

export interface BiometricDevice {
  id: number;
  name: string;
  brand: "essl" | "cpplus" | "zkteco" | "other";
  ip: string | null;
  port: number;
  serial_no: string | null;
  enabled: boolean;
  last_sync: string | null;
}
export interface DeviceReq {
  name: string;
  brand?: string;
  ip?: string;
  port?: number;
  serial_no?: string;
  enabled?: boolean;
}
export const listDevices = () => req<BiometricDevice[]>("GET", "/biometric-devices");
export const createDevice = (body: DeviceReq) => req<{ id: number }>("POST", "/biometric-devices", body);
export const updateDevice = (id: number, body: DeviceReq) => req<{ ok: boolean }>("POST", `/biometric-devices/${id}`, body);
export const deleteDevice = (id: number) => req<{ ok: boolean }>("DELETE", `/biometric-devices/${id}`);
export const testDevice = (id: number) => req<{ ok: boolean; ms: number; error: string }>("POST", `/biometric-devices/${id}/test`);
export const syncDevice = (id: number) => req<{ ok: boolean; message: string }>("POST", `/biometric-devices/${id}/sync`);
export const importPunches = (csv: string, deviceId?: number) =>
  req<{ ok: boolean; received: number; inserted: number }>("POST", "/biometric-devices/import", { csv, device_id: deviceId });
export interface ScanResult { base: string; port: number; found: { ip: string; ms: number; registered: boolean }[] }
export const scanDevices = (base?: string, port?: number) =>
  req<ScanResult>("POST", "/biometric/scan", { base: base || undefined, port: port || undefined });
export interface DeviceStatus { id: number; ok: boolean; ms: number }
export const devicesStatus = () => req<DeviceStatus[]>("GET", "/biometric-devices/status");

// ---- HR: holidays, advances, unmatched punches ----
export interface Holiday { id: number; day: string; name: string }
export const listHolidays = (month: string) => req<Holiday[]>("GET", `/holidays?month=${month}`);
export const createHoliday = (day: string, name: string) => req<{ id: number }>("POST", "/holidays", { day, name });
export const deleteHoliday = (id: number) => req<{ ok: boolean }>("DELETE", `/holidays/${id}`);
export const fillCalendar = (period: string) => req<{ holidays_marked: number; week_offs_marked: number }>("POST", "/attendance/fill", { period });

export interface StaffAdvance {
  id: number;
  staff_id: number;
  staff_name: string;
  amount: string;
  recovery_per_month: string;
  outstanding: string;
  note: string | null;
  status: string;
  created_at: string;
}
export const listStaffAdvances = (staffId?: number) =>
  req<StaffAdvance[]>("GET", `/staff-advances${staffId ? `?staff_id=${staffId}` : ""}`);
export const createAdvance = (body: { staff_id: number; amount: string; recovery_per_month?: string; note?: string }) =>
  req<{ id: number }>("POST", "/staff-advances", body);

export interface UnmatchedPunch { biometric_user_id: string; count: number; first: string; last: string }
export const listUnmatchedPunches = () => req<UnmatchedPunch[]>("GET", "/biometric/unmatched");
export const relinkPunches = (biometric_user_id: string, staff_id: number) =>
  req<{ ok: boolean; linked_punches: number }>("POST", "/biometric/relink", { biometric_user_id, staff_id });

// ---- Reports ----
export interface RegisterReport { rows: Record<string, string | number | null>[]; totals: Record<string, string> }
export const salesRegister = (from: string, to: string) => req<RegisterReport>("GET", `/reports/sales-register?from=${from}&to=${to}`);
export const dayCloseReport = (from: string, to: string) => req<RegisterReport>("GET", `/reports/day-close?from=${from}&to=${to}`);
export const purchaseRegister = (from: string, to: string) => req<RegisterReport>("GET", `/reports/purchase-register?from=${from}&to=${to}`);
export const stockValuation = () => req<RegisterReport>("GET", "/reports/stock-valuation");
export interface GstNet { output_taxable: string; output_tax: string; input_taxable: string; input_tax: string; net_payable: string }
export const gstNet = (from: string, to: string) => req<GstNet>("GET", `/reports/gst-net?from=${from}&to=${to}`);
export const outstandingReport = () => req<RegisterReport>("GET", "/reports/outstanding");
export interface DayBookRow { at: string; subject: string; event: string; amount_delta: string; weight_delta: string; ref_doc_type: string | null; ref_doc_id: number | null }
export const dayBook = (day: string) => req<{ rows: DayBookRow[] }>("GET", `/reports/day-book?day=${day}`);

export interface DashboardMetrics {
  today: { bills: number; sales: string; old_gold: string };
  month: { bills: number; sales: string; purchases: string; gst_output: string; gst_input: string; gst_net: string };
  stock: { pieces: number; net_weight: string; value: string };
  outstanding: { receivable: string; payable: string };
  collections: { mode: string; total: string }[];
  trend: { month: string; sales: string }[];
  by_metal: { metal: string; pieces: number; net_weight: string; value: string }[];
}
export const dashboardMetrics = () => req<DashboardMetrics>("GET", "/reports/dashboard");

export const salesByPurity = (from: string, to: string) => req<RegisterReport>("GET", `/reports/sales-by-purity?from=${from}&to=${to}`);
export const schemeDues = () => req<RegisterReport>("GET", "/reports/scheme-dues");
export const advanceDues = () => req<RegisterReport>("GET", "/reports/advance-dues");
export interface StockAgeing {
  buckets: { bucket: string; pieces: number; net_weight: string; value: string }[];
  slow_movers: { sku: string; purity: string | null; days: number; net_weight: string; value: string; received: string }[];
}
export const stockAgeing = () => req<StockAgeing>("GET", "/reports/stock-ageing");

export interface GrossProfit {
  total_revenue: string; costed_revenue: string; cogs: string; gross_profit: string;
  margin_pct: string; coverage_pct: string; uncosted_revenue: string; costed_lines: number;
  rows: { document_no: string | null; sku: string; revenue: string; cost: string; profit: string }[];
}
export const grossProfit = (from: string, to: string) => req<GrossProfit>("GET", `/reports/gross-profit?from=${from}&to=${to}`);
export const stockRevaluation = () => req<RegisterReport>("GET", "/reports/stock-revaluation");
export const karigarReport = () => req<RegisterReport>("GET", "/reports/karigar");
export const paymentModesRange = (from?: string, to?: string) =>
  req<PaymentModeRow[]>("GET", `/reports/payment-modes${from && to ? `?from=${from}&to=${to}` : ""}`);
export interface LedgerRow {
  id: number; occurred_at: string; subject_type: string; subject_id: number;
  event_type: string; amount_delta: string | null; ref_doc_type: string | null; ref_doc_id: number | null;
}
export const ledgerReport = (limit = 200) => req<LedgerRow[]>("GET", `/reports/ledger?limit=${limit}`);

// ---- Phase 1 registers (all RegisterReport-shaped) ----
export const salesReturns = (from: string, to: string) => req<RegisterReport>("GET", `/reports/sales-returns?from=${from}&to=${to}`);
export const advanceRegister = () => req<RegisterReport>("GET", "/reports/advance-register");
export const barcodeStock = () => req<RegisterReport>("GET", "/reports/barcode-stock");
export const oldGoldIntake = (from: string, to: string) => req<RegisterReport>("GET", `/reports/old-gold-intake?from=${from}&to=${to}`);
export const rateCutRegister = (from: string, to: string) => req<RegisterReport>("GET", `/reports/rate-cut?from=${from}&to=${to}`);
export const jobWorkRegister = () => req<RegisterReport>("GET", "/reports/job-work");
export const leaveRegister = () => req<RegisterReport>("GET", "/reports/leave-register");
export const salaryAdvances = () => req<RegisterReport>("GET", "/reports/salary-advances");
export const chequeStatus = () => req<RegisterReport>("GET", "/reports/cheque-status");

// ---- Phase 2 registers ----
export const estimatesRegister = (from: string, to: string) => req<RegisterReport>("GET", `/reports/estimates?from=${from}&to=${to}`);
export const approvalOutstanding = () => req<RegisterReport>("GET", "/reports/approval-outstanding");
export const schemeEnrollment = () => req<RegisterReport>("GET", "/reports/scheme-enrollment");
export const schemeCollections = (from: string, to: string) => req<RegisterReport>("GET", `/reports/scheme-collections?from=${from}&to=${to}`);
export const schemeMaturity = () => req<RegisterReport>("GET", "/reports/scheme-maturity");
export const partyMetal = () => req<RegisterReport>("GET", "/reports/party-metal");
export const topCustomers = (from: string, to: string) => req<RegisterReport>("GET", `/reports/top-customers?from=${from}&to=${to}`);
export const supplierPurchases = (from: string, to: string) => req<RegisterReport>("GET", `/reports/supplier-purchases?from=${from}&to=${to}`);
export const purchaseReturns = (from: string, to: string) => req<RegisterReport>("GET", `/reports/purchase-returns?from=${from}&to=${to}`);
export const looseStoneValuation = () => req<RegisterReport>("GET", "/reports/loose-stone-valuation");
export const resaleMargin = () => req<RegisterReport>("GET", "/reports/resale-margin");
export const statutoryRegister = () => req<RegisterReport>("GET", "/reports/statutory");

// ---- Phase 3: GSTN return exports ----
export interface ComplianceReturn { filename: string; note?: string; summary: { label: string; value: string; section?: string }[]; gstn: unknown }
export const gstr1Return = (period: string) => req<ComplianceReturn>("GET", `/reports/gstr1?period=${period}`);
export const gstr3bReturn = (period: string) => req<ComplianceReturn>("GET", `/reports/gstr3b?period=${period}`);

// ---- Accounts & Compliance redesign ----
export interface ComplianceOverview {
  period: string; seller_gstin: string;
  output: { taxable: string; cgst: string; sgst: string; igst: string; tax: string };
  itc: { cgst: string; sgst: string; igst: string; tax: string };
  net_payable: string; turnover_taxable: string;
  b2b: { invoices: number; taxable: string }; b2c: { invoices: number; taxable: string };
  invoices: number; credit_notes: number;
  checks: { label: string; status: "ok" | "warn" | "info"; detail: string }[];
}
export interface CashBankBook {
  receipts: { mode: string; count: number; total: string }[];
  payments: { mode: string; count: number; total: string }[];
  receipts_total: string; payments_total: string; net: string;
}
export const complianceOverview = (period: string) => req<ComplianceOverview>("GET", `/reports/compliance-overview?period=${period}`);
export const hsnSummary = (from: string, to: string) => req<RegisterReport>("GET", `/reports/hsn-summary?from=${from}&to=${to}`);
export const outputTaxRegister = (from: string, to: string) => req<RegisterReport>("GET", `/reports/output-tax-register?from=${from}&to=${to}`);
export const itcRegister = (from: string, to: string) => req<RegisterReport>("GET", `/reports/itc-register?from=${from}&to=${to}`);
export const cashBankBook = (from: string, to: string) => req<CashBankBook>("GET", `/reports/cash-bank-book?from=${from}&to=${to}`);
export const dailyCollections = (from: string, to: string) => req<RegisterReport>("GET", `/reports/daily-collections?from=${from}&to=${to}`);
export interface CashBook {
  opening: { cash: string; bank: string; total: string };
  closing: { cash: string; bank: string; total: string };
  total_receipts: string; total_payments: string;
  rows: { date: string; opening: string; cash_in: string; bank_in: string; receipts: string;
          cash_out: string; bank_out: string; payments: string; closing_cash: string; closing_bank: string; closing: string }[];
}
export const cashBook = (from: string, to: string) => req<CashBook>("GET", `/reports/cash-book?from=${from}&to=${to}`);

// ---- Double-entry accounting ----
export interface Account { id: number; code: string; name: string; type: string; system: boolean; active: boolean; sort_order: number }
export const listAccounts = () => req<Account[]>("GET", "/accounts/coa");
export const createAccount = (b: { code: string; name: string; type: string }) => req<{ id: number }>("POST", "/accounts/coa", b);
export const accountsRebuild = () => req<{ entries: number }>("POST", "/accounts/rebuild", {});
export interface ExpenseRow { id: number; date: string; account_code: string; account: string; amount: string; mode: string; note: string | null }
export const listExpenses = () => req<ExpenseRow[]>("GET", "/accounts/expenses");
export const createExpense = (b: { expense_date: string; account_id: number; amount: string; mode?: string; reference?: string; note?: string }) =>
  req<{ id: number }>("POST", "/accounts/expenses", b);
export const trialBalance = (from: string, to: string) => req<RegisterReport>("GET", `/accounts/trial-balance?from=${from}&to=${to}`);
export interface PnL { income: { account: string; amount: string }[]; expenses: { account: string; amount: string }[]; total_income: string; total_expense: string; net_profit: string }
export const profitLoss = (from: string, to: string) => req<PnL>("GET", `/accounts/pnl?from=${from}&to=${to}`);
export interface BalanceSheet {
  assets: { account: string; amount: string }[]; liabilities: { account: string; amount: string }[]; equity: { account: string; amount: string }[];
  total_assets: string; total_liabilities: string; total_equity: string; balanced: boolean;
}
export const balanceSheet = (from: string, to: string) => req<BalanceSheet>("GET", `/accounts/balance-sheet?from=${from}&to=${to}`);
export interface JournalRow { entry_id: number; date: string; narration: string | null; source: string | null; account_code: string; account: string; debit: string; credit: string }
export const journalReport = (from: string, to: string) => req<{ rows: JournalRow[] }>("GET", `/accounts/journal?from=${from}&to=${to}`);
export interface ReceiptRow { id: number; date: string; party: string; amount: string; mode: string; note: string | null }
export const listReceipts = () => req<ReceiptRow[]>("GET", "/accounts/receipts");

export interface CreditNoteDetail {
  id: number; document_no: string | null; created_at: string; original_invoice_no: string | null;
  customer_name: string | null; reason: string | null; reason_detail: string | null;
  subtotal: string; tax_total: string; total: string; fy: string;
  refund_mode: string | null; deduction: string; net_refund: string;
  lines: { description: string; taxable_value: string; line_total: string }[];
}
export const getCreditNote = (id: number) => req<CreditNoteDetail>("GET", `/credit-notes/${id}`);
export const createReceipt = (b: { party_id: number; receipt_date: string; amount: string; mode?: string; reference?: string; note?: string }) =>
  req<{ id: number }>("POST", "/accounts/receipts", b);

// ---- Bank accounts & reconciliation ----
export interface BankAccount { id: number; name: string; bank_name: string | null; account_no: string | null; ifsc: string | null; opening_balance: string; is_primary: boolean; active: boolean; account_type: string }
export interface BankReconMovement { source_type: string; source_id: number; date: string; ref: string | null; mode: string; amount: string; cleared: boolean; balance: string }
export interface BankRecon { account: { id: number; name: string; opening_balance: string }; book_balance: string; cleared_balance: string; uncleared: string; rows: BankReconMovement[] }
export const listBankAccounts = () => req<BankAccount[]>("GET", "/bank-accounts");
export const createBankAccount = (b: { name: string; bank_name?: string; account_no?: string; ifsc?: string; opening_balance?: string; is_primary?: boolean; account_type?: string }) =>
  req<{ id: number }>("POST", "/bank-accounts", b);
export const updateBankAccount = (id: number, b: { name?: string; bank_name?: string; account_no?: string; ifsc?: string; opening_balance?: string; is_primary?: boolean; active?: boolean; account_type?: string }) =>
  req<{ ok: boolean }>("POST", `/bank-accounts/${id}`, b);
export const deleteBankAccount = (id: number) => req<{ deleted: boolean }>("DELETE", `/bank-accounts/${id}`);
export const createBankEntry = (b: { bank_account_id: number; entry_date: string; kind: string; amount: string; note?: string }) => req<{ id: number }>("POST", "/bank-entries", b);
export const updateBankEntry = (id: number, b: { bank_account_id: number; entry_date: string; kind: string; amount: string; note?: string }) => req<{ ok: boolean }>("POST", `/bank-entries/${id}`, b);
export const deleteBankEntry = (id: number) => req<{ deleted: boolean }>("DELETE", `/bank-entries/${id}`);

// ---- Bank statement import & reconciliation matching ----
export interface StmtLineIn { date?: string; description?: string; ref_no?: string; debit?: string; credit?: string; balance?: string }
export interface StmtImportResult { import_id: number; lines: number; matched: number; unmatched: number }
export const createStatementImport = (b: { bank_account_id: number; filename?: string; format?: string; window_days?: number; lines: StmtLineIn[] }) =>
  req<StmtImportResult>("POST", "/bank-statement-imports", b);
export interface StmtLine { id: number; date: string | null; description: string | null; ref_no: string | null; debit: string; credit: string; amount: string; balance: string | null; match_status: string; matched_source_type: string | null; matched_source_id: number | null }
export interface StmtMovement { source_type: string; source_id: number; date: string; amount: string; matched: boolean }
export interface StmtImportDetail {
  import: { id: number; filename: string | null; imported_at: string; account_id: number; account_name: string };
  lines: StmtLine[]; movements: StmtMovement[]; summary: { total: number; matched: number; unmatched: number };
}
export const getStatementImport = (id: number) => req<StmtImportDetail>("GET", `/bank-statement-imports/${id}`);
export const listStatementImports = (accountId: number) =>
  req<{ id: number; filename: string | null; imported_at: string; line_count: number; matched: number }[]>("GET", `/bank-statement-imports?account_id=${accountId}`);
export const deleteStatementImport = (id: number) => req<{ deleted: boolean }>("DELETE", `/bank-statement-imports/${id}`);
export const matchStmtLine = (id: number, b: { source_type: string; source_id: number }) => req<{ ok: boolean }>("POST", `/stmt-lines/${id}/match`, b);
export const unmatchStmtLine = (id: number) => req<{ ok: boolean }>("POST", `/stmt-lines/${id}/unmatch`, {});
export const createEntryFromStmtLine = (id: number) => req<{ ok: boolean }>("POST", `/stmt-lines/${id}/create-entry`, {});

// ---- Day close (cash) ----
export interface Denom { denom: number; qty: number }
export interface DaySession {
  id: number; status: string; opening_cash: string;
  expected_cash: string | null; counted_cash: string | null; cash_variance: string | null;
  opening_denoms: Denom[] | null; closing_denoms: Denom[] | null; notes: string | null; closed_at: string | null;
}
export interface DayCloseView {
  business_date: string; session: DaySession | null;
  cash_in: string; cash_out: string; opening_cash: string; expected_cash: string;
  proposed_opening: string | null; by_source: { source: string; amount: string }[];
  tallies: CashTally[];
}
export interface CashTally { checked_at: string; expected: string; counted: string; variance: string; note: string | null }
export const getDayClose = (date: string) => req<DayCloseView>("GET", `/day-close?date=${date}`);
export const recordCashTally = (b: { business_date: string; counted: string; denoms?: Denom[]; note?: string }) =>
  req<{ expected: string; counted: string; variance: string }>("POST", "/day-close/tally", b);
export const openDay = (b: { business_date: string; opening_cash: string; opening_denoms?: Denom[] }) =>
  req<{ id: number }>("POST", "/day-close/open", b);
export const closeDay = (b: { business_date: string; counted_cash: string; closing_denoms?: Denom[]; notes?: string }) =>
  req<{ expected_cash: string; counted_cash: string; variance: string }>("POST", "/day-close/close", b);
export const reopenDay = (business_date: string) => req<{ ok: boolean }>("POST", "/day-close/reopen", { business_date });
export interface DaySessionRow {
  id: number; business_date: string; status: string; opening_cash: string;
  expected_cash: string | null; counted_cash: string | null; cash_variance: string | null; closed_at: string | null;
}
export const listDaySessions = () => req<DaySessionRow[]>("GET", "/day-sessions");

// ---- Day close (stock) ----
export interface StockCountLine {
  bucket_kind: string; bucket_key: string; group_label: string; category_label: string;
  metal_type_id: number | null; purity_id: number | null; category_id: number | null;
  book_nos: number; book_gross: string; book_ct: string; book_stone: string; book_net: string;
  out_nos: number; out_gross: string;
  phys_nos: number | null; phys_gross: string | null; phys_ct: string | null; phys_stone: string | null; phys_net: string | null;
}
export interface StockCountView {
  business_date: string; session_status: string | null;
  count: { id: number; status: string; notes: string | null; counted_at: string | null; method: string; weigh_mode: boolean } | null;
  lines: StockCountLine[];
  tag_scans: TagScans | null;
}
export interface TagScanItem { sku: string | null; group_label: string | null; category_label: string | null; gross: string | null; net: string | null; weighed_gross: string | null }
export interface TagScans { present: number; weigh_mode: boolean; missing: TagScanItem[]; extra: TagScanItem[] }
export const getStockCount = (date: string) => req<StockCountView>("GET", `/day-close/stock?date=${date}`);
export interface StockPhysLine { bucket_key: string; phys_nos?: number; phys_gross?: string; phys_ct?: string; phys_stone?: string; phys_net?: string }
export const saveStockCount = (b: { business_date: string; method?: string; notes?: string; lines: StockPhysLine[] }) =>
  req<{ ok: boolean; lines: number }>("POST", "/day-close/stock", b);

// tag-scan counting
export interface ExpectedItem { item_id: number; sku: string; group_label: string; category_label: string; gross: string; net: string }
export interface StockExpectedView { session_status: string | null; count_method: string | null; weigh_mode: boolean; items: ExpectedItem[]; present_ids: number[] }
export const getStockExpected = (date: string) => req<StockExpectedView>("GET", `/day-close/stock/expected?date=${date}`);
export const tagSaveStockCount = (b: { business_date: string; weigh_mode?: boolean; notes?: string; present: { item_id: number; weighed_gross?: string }[]; extra_skus: string[] }) =>
  req<{ ok: boolean; present: number; missing: number; extra: number }>("POST", "/day-close/stock/tag-save", b);
export const bankReconcile = (id: number) => req<BankRecon>("GET", `/bank-accounts/${id}/reconcile`);
export const setBankRecon = (b: { source_type: string; source_id: number; bank_account_id: number; cleared: boolean }) =>
  req<{ ok: boolean }>("POST", "/bank-recon", b);
export const bankTransfer = (b: { from_account_id: number; to_account_id: number; amount: string; transfer_date: string; reference?: string; note?: string }) =>
  req<{ id: number }>("POST", "/bank-transfers", b);
