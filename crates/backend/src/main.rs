//! Cygnus Jewel Suite — backend API (Phase 1 slice).
//!
//! Axum HTTP server over PostgreSQL (sqlx). Endpoints:
//!   GET  /health         — liveness + DB check
//!   GET  /rates          — list metal rates (with labels)
//!   POST /rates          — add a rate for a (metal, purity)
//!   GET  /items          — list stock items
//!   POST /items          — create an item (+ append-only ledger_event, in one txn)
//!   POST /price-preview   — live price via the shared core-engine + latest rate
//!
//! Runtime-checked sqlx queries (no compile-time DB needed).

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::{
    async_trait,
    extract::{ConnectInfo, FromRequestParts, Path, Query, State},
    http::request::Parts,
    http::{header::AUTHORIZATION, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::{Datelike, FixedOffset, Utc};
use core_engine::valuation::{value_line, LineInput, PriceBreakdown, Supply};
use core_engine::{net_fine_weight, round_money, Charge, StonePrice};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashMap;
use std::env;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone)]
struct AppState {
    db: PgPool,
    default_branch: i64,
    /// Per-username failed-login tracking for rate limiting (in-memory).
    login_attempts: Arc<Mutex<HashMap<String, LoginAttempt>>>,
    /// Last-seen time per connecting client IP (heartbeat via /health), used to report
    /// how many terminals are currently connected to this server.
    clients: Arc<Mutex<HashMap<IpAddr, Instant>>>,
}

impl AppState {
    fn new(db: PgPool, default_branch: i64) -> Self {
        Self {
            db,
            default_branch,
            login_attempts: Arc::new(Mutex::new(HashMap::new())),
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct LoginAttempt {
    count: u32,
    first: Instant,
}

const LOGIN_MAX_ATTEMPTS: u32 = 5;
const LOGIN_WINDOW: Duration = Duration::from_secs(5 * 60);
/// A client is counted as "connected" if its heartbeat (a /health ping every ~15s from the
/// desktop app) was seen within this window.
const CLIENT_WINDOW: Duration = Duration::from_secs(60);

type ApiError = (StatusCode, String);

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// Indian financial year (Apr–Mar) for the current IST date, e.g. "2026-27".
fn current_fy() -> String {
    let ist = FixedOffset::east_opt(5 * 3600 + 30 * 60).expect("valid offset");
    let now = Utc::now().with_timezone(&ist);
    let (y, m) = (now.year(), now.month());
    let (start, end) = if m >= 4 { (y, y + 1) } else { (y - 1, y) };
    format!("{start}-{:02}", end % 100)
}

/// Today's date (YYYY-MM-DD) in IST — the default transaction date.
fn today_ist() -> String {
    let ist = FixedOffset::east_opt(5 * 3600 + 30 * 60).expect("valid offset");
    Utc::now().with_timezone(&ist).format("%Y-%m-%d").to_string()
}

/// Period lock (data locking): reject a mutating entry dated on/before `books.lock_date`.
/// A transaction whose date ≤ the lock date is frozen (filed/audited period protection).
async fn assert_not_locked(db: &PgPool, date: &str) -> Result<(), ApiError> {
    let lock: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_setting WHERE key = 'books.lock_date'")
            .fetch_optional(db)
            .await
            .map_err(internal)?;
    if let Some(ld) = lock.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        let d = date.get(0..10).unwrap_or(date); // normalise timestamp → YYYY-MM-DD
        if d <= ld.as_str() {
            return Err((
                StatusCode::CONFLICT,
                format!("Accounting period is locked up to {ld}. Entries dated on/before that date are frozen — change the lock in Settings → Financial Year & Locking."),
            ));
        }
    }
    Ok(())
}

// ---- Auth & RBAC ----

fn hash_password(pw: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(internal)
}

fn verify_password(pw: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(pw.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Validate an Indian PAN: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).
fn valid_pan(pan: &str) -> bool {
    let b = pan.as_bytes();
    b.len() == 10
        && b[0..5].iter().all(u8::is_ascii_uppercase)
        && b[5..9].iter().all(u8::is_ascii_digit)
        && b[9].is_ascii_uppercase()
}

/// Action-level permissions mapped from the user's role.
fn has_permission(role: &str, perm: &str) -> bool {
    match role {
        "owner" => true,
        "manager" => perm != "user.manage",
        "cashier" => matches!(
            perm,
            "sale.create"
                | "sale.return"
                | "price.preview"
                | "stock.read"
                | "customer.manage"
                | "approval.manage"
                | "scheme.manage"
        ),
        // Financial back-office: books, banking, day-close, reports (all gated on
        // `report.view`) plus read-only stock for valuation. No sales/purchase/user powers.
        "accountant" => matches!(perm, "report.view" | "stock.read"),
        _ => false,
    }
}

/// Authenticated user, resolved from a `Authorization: Bearer <token>` session token.
struct AuthUser {
    id: i64,
    role: String,
    username: String,
    token: String,
}

impl AuthUser {
    /// Enforce that this user's role grants `perm`, else 403.
    fn require(&self, perm: &str) -> Result<(), ApiError> {
        if has_permission(&self.role, perm) {
            Ok(())
        } else {
            Err((
                StatusCode::FORBIDDEN,
                format!("role '{}' lacks permission '{perm}'", self.role),
            ))
        }
    }
}

#[derive(sqlx::FromRow)]
struct AuthRow {
    id: i64,
    role: String,
    username: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or((StatusCode::UNAUTHORIZED, "missing bearer token".to_string()))?;

        let row: Option<AuthRow> = sqlx::query_as(
            "SELECT u.id, u.role, u.username FROM session s \
             JOIN app_user u ON u.id = s.user_id \
             WHERE s.token = $1 AND s.expires_at > now() AND u.active",
        )
        .bind(token)
        .fetch_optional(&state.db)
        .await
        .map_err(internal)?;

        let row = row.ok_or((
            StatusCode::UNAUTHORIZED,
            "invalid or expired token".to_string(),
        ))?;
        Ok(AuthUser {
            id: row.id,
            role: row.role,
            username: row.username,
            token: token.to_string(),
        })
    }
}

/// Build the application router with all routes (shared by `main` and integration tests).
fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/change-password", post(change_password))
        .route("/auth/me", get(me))
        .route("/users", get(list_users).post(create_user))
        .route("/users/:id", post(update_user).delete(delete_user))
        .route("/users/:id/reset-password", post(reset_user_password))
        .route("/customers", get(list_customers).post(create_customer))
        .route("/parties", get(list_parties).post(create_party))
        .route("/parties/:id", get(get_party).post(update_party).delete(delete_party))
        .route("/parties/:id/restore", post(restore_party))
        .route("/parties/:id/roles", post(add_party_role))
        .route("/parties/:id/terms", post(set_party_terms))
        .route("/parties/:id/addresses", post(add_party_address))
        .route("/parties/:id/cash-entry", post(party_cash_entry))
        .route("/parties/:id/metal-entry", post(party_metal_entry))
        .route("/parties/:id/ledger", get(party_ledger))
        .route("/rate-cuts", get(list_rate_cuts).post(create_rate_cut))
        .route("/customers/:id/advances", get(list_customer_advances).post(record_advance))
        .route("/customers/:id/advances/refund", post(refund_advance))
        .route("/advances", get(list_advances))
        .route("/advances/metrics", get(advance_metrics))
        .route("/advances/:id/close", post(close_advance))
        .route("/rates", get(list_rates).post(create_rate))
        .route("/metal-types", get(list_metal_types).post(create_metal_type))
        .route("/departments", get(list_departments).post(create_department))
        .route("/departments/:id", post(update_department))
        .route("/metal-types/:id", post(update_metal_type))
        .route("/purities", post(create_purity))
        .route("/purities/:id", post(update_purity))
        .route("/stone-types", get(list_stone_types).post(create_stone_type))
        .route("/stone-types/:id", post(update_stone_type))
        .route("/stone-qualities", post(create_stone_quality))
        .route("/stone-qualities/:id", post(update_stone_quality))
        .route("/loose-stones", get(list_loose_stones).post(create_loose_stone))
        .route("/loose-stones/:id", post(update_loose_stone))
        .route("/resale-items", get(list_resale_items).post(create_resale_item))
        .route("/resale-items/:id/sell", post(sell_resale_item))
        .route("/items", get(list_items).post(create_item))
        .route("/items/tags", get(item_tags))
        .route("/items/untagged", get(list_untagged_items))
        .route("/items/mark-tagged", post(mark_items_tagged))
        .route("/items/:id", get(get_item))
        .route("/items/:id/sell", post(sell_item))
        .route("/metals", get(list_metals))
        .route("/invoices", get(list_invoices).post(create_invoice))
        .route("/invoices/:id", get(get_invoice))
        .route("/invoices/:id/einvoice", get(invoice_einvoice))
        .route("/estimates", get(list_estimates).post(create_estimate))
        .route("/estimates/:id", get(get_estimate))
        .route("/estimates/:id/convert", post(convert_estimate))
        .route("/settings", get(list_settings).post(upsert_setting))
        .route("/books/lock", post(set_books_lock))
        .route("/old-gold", get(list_old_gold))
        .route("/old-gold/:id/convert", post(convert_old_gold))
        .route("/cheques", get(list_cheques))
        .route("/cheques/:id/status", post(update_cheque))
        .route("/smiths", get(list_smiths).post(create_smith))
        .route("/melts", post(create_melt))
        .route("/smith-jobs", get(list_smith_jobs).post(issue_smith_job))
        .route("/smith-jobs/:id/receive", post(receive_smith_job))
        .route("/smith-jobs/:id/settle", post(settle_smith_job))
        .route("/items/:id/approval-out", post(approval_out))
        .route("/approvals", get(list_approvals))
        .route("/approvals/:id/return", post(approval_return))
        .route("/items/:id/sor-out", post(sor_out))
        .route("/sale-or-returns", get(list_sor))
        .route("/sale-or-returns/:id/return", post(sor_return))
        .route("/schemes", get(list_schemes).post(create_scheme))
        .route("/schemes/:id", get(get_scheme))
        .route("/schemes/:id/pay", post(scheme_pay))
        .route("/schemes/:id/close", post(scheme_close))
        .route("/invoices/:id/return", post(return_invoice))
        .route("/suppliers", get(list_suppliers).post(create_supplier))
        .route("/purchases", get(list_purchases).post(create_purchase))
        .route("/purchases/:id", get(get_purchase))
        .route("/purchase-returns", get(list_purchase_returns).post(create_purchase_return))
        .route("/stock-lots", get(list_stock_lots))
        .route("/stock-lots/:id/tag", post(tag_stock_lot))
        // ---- Staff / Attendance / Leave / Payroll ----
        .route("/staff", get(list_staff).post(create_staff))
        .route("/staff/:id", get(get_staff).post(update_staff))
        .route("/holidays", get(list_holidays).post(create_holiday))
        .route("/holidays/:id", post(delete_holiday).delete(delete_holiday))
        .route("/attendance", get(list_attendance).post(mark_attendance))
        .route("/attendance/summary", get(attendance_summary))
        .route("/attendance/fill", post(fill_calendar))
        .route("/leave-types", get(list_leave_types))
        .route("/leave-requests", get(list_leave_requests).post(apply_leave))
        .route("/leave-requests/:id/decide", post(decide_leave))
        .route("/leave-requests/:id/cancel", post(cancel_leave))
        .route("/leave-balances", get(leave_balances))
        .route("/staff-advances", get(list_staff_advances).post(create_advance))
        .route("/payroll-runs", get(list_payroll_runs).post(generate_payroll))
        .route("/payroll-runs/:id", get(get_payroll_run))
        .route("/payroll-runs/:id/status", post(set_payroll_status))
        .route("/payroll-runs/:id/pf-ecr", get(payroll_pf_ecr))
        .route("/payroll-runs/:id/esi-return", get(payroll_esi_return))
        .route("/payslips/:id", post(update_payslip))
        .route("/biometric-devices", get(list_devices).post(create_device))
        .route("/biometric-devices/status", get(devices_status))
        .route("/biometric/scan", post(scan_devices))
        .route("/biometric/agent-ingest", post(agent_ingest))
        .route("/biometric-devices/:id", post(update_device).delete(delete_device))
        .route("/biometric-devices/:id/test", post(test_device))
        .route("/biometric-devices/:id/sync", post(sync_device))
        .route("/biometric-devices/import", post(import_punches))
        .route("/biometric/unmatched", get(list_unmatched_punches))
        .route("/biometric/relink", post(relink_punches))
        // iclock / ADMS push (public — LAN only)
        .route("/iclock/cdata", get(iclock_handshake).post(iclock_cdata))
        .route("/iclock/getrequest", get(iclock_getrequest))
        .route("/document-series", get(list_series).post(upsert_series))
        .route("/price-preview", post(price_preview))
        .route("/reports/sales-summary", get(report_sales))
        .route("/reports/stock-summary", get(report_stock))
        .route("/reports/metal-account", get(report_metal_account))
        .route("/reports/stock-overview", get(report_stock_overview))
        .route("/item-categories", get(list_item_categories).post(create_item_category))
        .route("/item-categories/:id", post(update_item_category))
        .route("/reports/gst-summary", get(report_gst))
        .route("/reports/payment-modes", get(report_payment_modes))
        .route("/reports/dashboard", get(report_dashboard))
        .route("/reports/sales-register", get(report_sales_register))
        .route("/reports/purchase-register", get(report_purchase_register))
        .route("/reports/stock-valuation", get(report_stock_valuation))
        .route("/reports/gst-net", get(report_gst_summary))
        .route("/reports/outstanding", get(report_outstanding))
        .route("/reports/stock-ageing", get(report_stock_ageing))
        .route("/reports/sales-by-purity", get(report_sales_by_purity))
        .route("/reports/scheme-dues", get(report_scheme_dues))
        .route("/reports/advance-dues", get(report_advance_dues))
        .route("/reports/gross-profit", get(report_gross_profit))
        .route("/reports/stock-revaluation", get(report_stock_revaluation))
        .route("/reports/karigar", get(report_karigar))
        .route("/reports/day-book", get(report_day_book))
        .route("/reports/ledger", get(report_ledger))
        .route("/reports/sales-returns", get(report_sales_returns))
        .route("/reports/advance-register", get(report_advance_register))
        .route("/reports/barcode-stock", get(report_barcode_stock))
        .route("/reports/old-gold-intake", get(report_old_gold_intake))
        .route("/reports/rate-cut", get(report_rate_cut_register))
        .route("/reports/job-work", get(report_job_work))
        .route("/reports/leave-register", get(report_leave_register))
        .route("/reports/salary-advances", get(report_salary_advances))
        .route("/reports/cheque-status", get(report_cheque_status))
        .route("/reports/estimates", get(report_estimates))
        .route("/reports/approval-outstanding", get(report_approval_outstanding))
        .route("/reports/scheme-enrollment", get(report_scheme_enrollment))
        .route("/reports/scheme-collections", get(report_scheme_collections))
        .route("/reports/scheme-maturity", get(report_scheme_maturity))
        .route("/reports/party-metal", get(report_party_metal))
        .route("/reports/top-customers", get(report_top_customers))
        .route("/reports/supplier-purchases", get(report_supplier_purchases))
        .route("/reports/purchase-returns", get(report_purchase_returns))
        .route("/reports/loose-stone-valuation", get(report_loose_stone_valuation))
        .route("/reports/resale-margin", get(report_resale_margin))
        .route("/reports/statutory", get(report_statutory))
        .route("/reports/gstr1", get(report_gstr1))
        .route("/reports/gstr3b", get(report_gstr3b))
        .route("/reports/compliance-overview", get(report_compliance_overview))
        .route("/reports/hsn-summary", get(report_hsn_summary))
        .route("/reports/output-tax-register", get(report_output_tax_register))
        .route("/reports/itc-register", get(report_itc_register))
        .route("/reports/cash-bank-book", get(report_cash_bank_book))
        .route("/reports/daily-collections", get(report_daily_collections))
        .route("/reports/cash-book", get(report_cash_book))
        .route("/reports/day-close", get(report_day_close))
        .route("/accounts/rebuild", post(accounts_rebuild))
        .route("/opening/parties", get(opening_parties).post(set_opening_parties))
        .route("/opening/stock-summary", get(opening_stock_summary))
        .route("/opening/stock", post(create_opening_stock))
        .route("/accounts/coa", get(accounts_coa).post(accounts_create))
        .route("/accounts/expenses", get(accounts_expense_list).post(accounts_expense_create))
        .route("/accounts/receipts", get(customer_receipt_list).post(customer_receipt_create))
        .route("/accounts/trial-balance", get(accounts_trial_balance))
        .route("/accounts/pnl", get(accounts_pnl))
        .route("/accounts/balance-sheet", get(accounts_balance_sheet))
        .route("/accounts/ledger", get(accounts_ledger))
        .route("/accounts/journal", get(accounts_journal))
        .route("/bank-accounts", get(bank_accounts_list).post(bank_account_create))
        .route("/bank-accounts/:id", post(bank_account_update).delete(bank_account_delete))
        .route("/bank-accounts/:id/reconcile", get(bank_reconcile))
        .route("/bank-recon", post(bank_recon_set))
        .route("/bank-transfers", post(bank_transfer_create))
        .route("/bank-entries", post(bank_entry_create))
        .route("/bank-entries/:id", post(bank_entry_update).delete(bank_entry_delete))
        .route("/bank-statement-imports", get(list_statement_imports).post(create_statement_import))
        .route("/bank-statement-imports/:id", get(get_statement_import).delete(delete_statement_import))
        .route("/stmt-lines/:id/match", post(stmt_line_match))
        .route("/stmt-lines/:id/unmatch", post(stmt_line_unmatch))
        .route("/stmt-lines/:id/create-entry", post(stmt_line_create_entry))
        .route("/day-close", get(get_day_session))
        .route("/day-close/open", post(open_day))
        .route("/day-close/close", post(close_day))
        .route("/day-close/reopen", post(reopen_day))
        .route("/day-close/tally", post(record_cash_tally))
        .route("/day-close/stock", get(get_stock_count).post(save_stock_count))
        .route("/day-close/stock/expected", get(get_stock_expected))
        .route("/day-close/stock/tag-save", post(tag_save_stock_count))
        .route("/day-sessions", get(list_day_sessions))
        // LAN desktop/web clients call this API cross-origin; auth is via bearer token.
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state)
}

// ===================== Old gold register (scrap stock) =====================

#[derive(sqlx::FromRow)]
struct OldGoldRow {
    id: i64,
    created_at: String,
    metal: String,
    purity: Option<String>,
    gross_weight: Decimal,
    deduction_percent: Decimal,
    net_weight: Decimal,
    fine_weight: Option<Decimal>,
    rate: Decimal,
    value: Decimal,
    status: String,
    document_no: Option<String>,
    customer_name: Option<String>,
    department: Option<String>,
}

fn old_gold_json(r: &OldGoldRow) -> Value {
    json!({
        "id": r.id,
        "created_at": r.created_at,
        "metal": r.metal,
        "purity": r.purity,
        "gross_weight": r.gross_weight.to_string(),
        "deduction_percent": r.deduction_percent.to_string(),
        "net_weight": r.net_weight.to_string(),
        "fine_weight": r.fine_weight.map(|d| d.to_string()),
        "rate": r.rate.to_string(),
        "value": r.value.to_string(),
        "status": r.status,
        "document_no": r.document_no,
        "customer_name": r.customer_name,
        "department": r.department,
    })
}

async fn list_old_gold(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, OldGoldRow>(
        "SELECT ogl.id, ogl.created_at::text AS created_at, mt.name AS metal, p.label AS purity, \
            ogl.gross_weight, ogl.deduction_percent, ogl.net_weight, ogl.fine_weight, ogl.rate, ogl.value, ogl.status, \
            i.document_no, c.name AS customer_name, d.name AS department \
         FROM old_gold_lot ogl \
         JOIN metal_type mt ON mt.id = ogl.metal_type_id \
         LEFT JOIN purity p ON p.id = ogl.purity_id \
         LEFT JOIN invoice i ON i.id = ogl.invoice_id \
         LEFT JOIN customer c ON c.id = ogl.customer_id \
         LEFT JOIN department d ON d.id = ogl.department_id \
         ORDER BY ogl.id DESC LIMIT 200",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows.iter().map(old_gold_json).collect::<Vec<_>>())))
}

/// Convert (refurbish) an in-scrap old-jewellery lot into a barcoded, sellable stock item.
/// Cost = value paid for the old piece + optional repair + making. The metal/purity/department
/// carry over (overridable); a barcode SKU is auto-generated when none is supplied.
#[derive(Deserialize)]
struct ConvertLotReq {
    department_id: Option<i64>,
    category_id: Option<i64>,
    purity_id: Option<i64>,
    gross_weight: Option<Decimal>,
    net_weight: Option<Decimal>,
    stone_weight: Option<Decimal>,
    repair_cost: Option<Decimal>,
    making: Option<Decimal>,
    sku: Option<String>,
    huid: Option<String>,
}

async fn convert_old_gold(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ConvertLotReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let lot: Option<(i64, Option<i64>, Decimal, Decimal, Decimal, String, Option<i64>)> = sqlx::query_as(
        "SELECT metal_type_id, purity_id, gross_weight, net_weight, value, status, department_id \
         FROM old_gold_lot WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (mt, pid_lot, gross_lot, net_lot, value, status, dept_lot) =
        lot.ok_or((StatusCode::NOT_FOUND, format!("lot {id} not found")))?;
    if status != "in_scrap" {
        return Err((
            StatusCode::CONFLICT,
            format!("lot {id} is '{status}' — only an in-scrap lot can be converted to stock"),
        ));
    }
    let purity_id = req.purity_id.or(pid_lot).ok_or((
        StatusCode::BAD_REQUEST,
        "a purity is required to create a stock item".to_string(),
    ))?;
    let gross = req.gross_weight.unwrap_or(gross_lot);
    let net = req.net_weight.unwrap_or(net_lot);
    let repair = round_money(req.repair_cost.unwrap_or(Decimal::ZERO));
    let making = round_money(req.making.unwrap_or(Decimal::ZERO));
    // Cost basis = what we paid for the old piece + refurbishment.
    let cost_value = round_money(value) + repair + making;
    let dept = req.department_id.or(dept_lot);
    let fy = current_fy();
    let sku = match req.sku.as_deref() {
        Some(x) if !x.trim().is_empty() => x.to_string(),
        _ => {
            let (seq, _doc) = allocate_doc_no(&mut tx, "tag", &fy, SERIES_DEFAULT).await?;
            gen_item_barcode(&mut tx, mt, purity_id, seq).await?
        }
    };
    let item_id: i64 = sqlx::query_scalar(
        "INSERT INTO item (branch_id, sku, metal_type_id, purity_id, gross_weight, net_weight, \
            stone_weight, huid, cost_value, ownership_state, category_id, department_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'in_stock', $10, $11) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(&sku)
    .bind(mt)
    .bind(purity_id)
    .bind(gross)
    .bind(net)
    .bind(req.stone_weight.unwrap_or(Decimal::ZERO))
    .bind(req.huid.as_deref())
    .bind(cost_value)
    .bind(req.category_id)
    .bind(dept)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query("UPDATE old_gold_lot SET status = 'converted', converted_item_id = $2, repair_cost = $3 WHERE id = $1")
        .bind(id)
        .bind(item_id)
        .bind(repair)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
            weight_delta, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'item', $2, 'old_gold_converted', $3, $4, $5, 'old_gold_lot', $6)",
    )
    .bind(s.default_branch)
    .bind(item_id)
    .bind(json!({"sku": sku, "from_lot": id, "repair_cost": repair.to_string(), "cost_value": cost_value.to_string()}))
    .bind(gross)
    .bind(cost_value)
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "item_id": item_id, "sku": sku, "cost_value": cost_value.to_string() })))
}

// ===================== Customer advances =====================

#[derive(Deserialize)]
struct NewAdvance {
    amount: Option<Decimal>,
    note: Option<String>,
    payment_mode: Option<String>,
    advance_type: Option<String>, // amount | metal
    metal_type_id: Option<i64>,
    purity_id: Option<i64>,
    booked_weight: Option<Decimal>,
    rate_locked: Option<Decimal>,
    percent: Option<Decimal>,
    due_date: Option<String>, // YYYY-MM-DD
}

async fn record_advance(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(cid): Path<i64>,
    Json(n): Json<NewAdvance>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    let adv_type = if n.advance_type.as_deref() == Some("metal") { "metal" } else { "amount" };
    let percent = n.percent.unwrap_or_else(|| Decimal::from(100));
    if !(Decimal::ZERO < percent && percent <= Decimal::from(100)) {
        return Err((StatusCode::BAD_REQUEST, "percent must be between 0 and 100".to_string()));
    }

    let mut tx = s.db.begin().await.map_err(internal)?;

    // Resolve the booking weight, locked rate and amount paid now.
    let (booked_weight, rate_locked, amount) = if adv_type == "metal" {
        let mt = n.metal_type_id.ok_or((StatusCode::BAD_REQUEST, "metal advance needs metal_type_id".to_string()))?;
        let pid = n.purity_id.ok_or((StatusCode::BAD_REQUEST, "metal advance needs purity_id".to_string()))?;
        let wt = n.booked_weight.unwrap_or(Decimal::ZERO);
        if wt <= Decimal::ZERO {
            return Err((StatusCode::BAD_REQUEST, "booked_weight must be > 0".to_string()));
        }
        let rate = match n.rate_locked {
            Some(r) if r > Decimal::ZERO => r,
            _ => sqlx::query_scalar::<_, Decimal>(
                "SELECT sell_rate FROM metal_rate WHERE metal_type_id = $1 AND purity_id = $2 \
                 ORDER BY effective_from DESC LIMIT 1",
            )
            .bind(mt)
            .bind(pid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?
            .ok_or((StatusCode::BAD_REQUEST, "no rate set for this metal/purity".to_string()))?,
        };
        let amt = round_money(wt * rate * percent / Decimal::from(100));
        (wt, Some(rate), amt)
    } else {
        let amt = n.amount.unwrap_or(Decimal::ZERO);
        if amt <= Decimal::ZERO {
            return Err((StatusCode::BAD_REQUEST, "amount must be > 0".to_string()));
        }
        (Decimal::ZERO, None, amt)
    };

    let (_adv_seq, advance_no) =
        allocate_doc_no(&mut tx, "advance", &current_fy(), SERIES_DEFAULT).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO customer_advance (branch_id, customer_id, amount, balance, note, payment_mode, \
            advance_type, metal_type_id, purity_id, booked_weight, rate_locked, percent, due_date, advance_no) \
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(cid)
    .bind(amount)
    .bind(n.note.as_deref())
    .bind(n.payment_mode.as_deref())
    .bind(adv_type)
    .bind(n.metal_type_id)
    .bind(n.purity_id)
    .bind(booked_weight)
    .bind(rate_locked)
    .bind(percent)
    .bind(n.due_date.as_deref())
    .bind(&advance_no)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
            amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'advance', $2, 'advance_received', $3, $4, 'customer', $5)",
    )
    .bind(s.default_branch)
    .bind(id)
    .bind(json!({"customer_id": cid, "advance_type": adv_type}))
    .bind(amount)
    .bind(cid)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "id": id, "advance_no": advance_no, "amount": amount.to_string(), "advance_type": adv_type,
        "booked_weight": booked_weight.to_string(),
        "rate_locked": rate_locked.map(|r| r.to_string()), "percent": percent.to_string(),
    })))
}

#[derive(sqlx::FromRow)]
struct AdvanceRow {
    id: i64,
    advance_no: Option<String>,
    created_at: String,
    amount: Decimal,
    balance: Decimal,
    status: String,
    note: Option<String>,
    payment_mode: Option<String>,
    customer_id: i64,
    customer_name: Option<String>,
    customer_phone: Option<String>,
    advance_type: String,
    booked_weight: Decimal,
    rate_locked: Option<Decimal>,
    percent: Option<Decimal>,
    due_date: Option<String>,
    metal: Option<String>,
    purity: Option<String>,
}

fn advance_json(r: &AdvanceRow) -> Value {
    json!({
        "id": r.id,
        "advance_no": r.advance_no,
        "created_at": r.created_at,
        "amount": r.amount.to_string(),
        "balance": r.balance.to_string(),
        "status": r.status,
        "note": r.note,
        "payment_mode": r.payment_mode,
        "customer_id": r.customer_id,
        "customer_name": r.customer_name,
        "customer_phone": r.customer_phone,
        "advance_type": r.advance_type,
        "booked_weight": r.booked_weight.to_string(),
        "rate_locked": r.rate_locked.map(|v| v.to_string()),
        "percent": r.percent.map(|v| v.to_string()),
        "due_date": r.due_date,
        "metal": r.metal,
        "purity": r.purity,
    })
}

const ADVANCE_SELECT: &str =
    "SELECT a.id, a.created_at::text AS created_at, a.amount, a.balance, a.status, a.note, \
        a.payment_mode, a.customer_id, c.name AS customer_name, c.phone AS customer_phone, a.advance_type, a.booked_weight, \
        a.rate_locked, a.percent, a.due_date::text AS due_date, mt.name AS metal, p.label AS purity, a.advance_no \
     FROM customer_advance a LEFT JOIN customer c ON c.id = a.customer_id \
     LEFT JOIN metal_type mt ON mt.id = a.metal_type_id LEFT JOIN purity p ON p.id = a.purity_id";

async fn list_customer_advances(
    State(s): State<AppState>,
    _auth: AuthUser,
    Path(cid): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, AdvanceRow>(
        &format!("{ADVANCE_SELECT} WHERE a.customer_id = $1 ORDER BY a.id DESC"),
    )
    .bind(cid)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let balance: Decimal = rows
        .iter()
        .filter(|r| r.status == "active")
        .map(|r| r.balance)
        .sum();
    Ok(Json(json!({
        "balance": balance.to_string(),
        "advances": rows.iter().map(advance_json).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct RefundAdvanceReq {
    amount: Decimal,
    refund_mode: Option<String>,
    note: Option<String>,
}

async fn refund_advance(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(cid): Path<i64>,
    Json(req): Json<RefundAdvanceReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    if req.amount <= Decimal::ZERO {
        return Err((StatusCode::BAD_REQUEST, "amount must be > 0".to_string()));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;
    let avail: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(balance), 0) FROM customer_advance WHERE customer_id = $1 AND status = 'active'",
    )
    .bind(cid)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if req.amount > avail {
        return Err((
            StatusCode::CONFLICT,
            format!("refund {} exceeds available advance balance {}", req.amount, avail),
        ));
    }
    let limit = Decimal::from(setting_i64(&s.db, "cash_refund_limit", 20000).await);
    let mode = req
        .refund_mode
        .clone()
        .unwrap_or_else(|| if req.amount <= limit { "cash".to_string() } else { "bank_transfer".to_string() });

    // Draw down FIFO across the customer's active advances.
    let advs: Vec<(i64, Decimal)> = sqlx::query_as(
        "SELECT id, balance FROM customer_advance WHERE customer_id = $1 AND status = 'active' AND balance > 0 ORDER BY id",
    )
    .bind(cid)
    .fetch_all(&mut *tx)
    .await
    .map_err(internal)?;
    let mut remaining = req.amount;
    for (aid, bal) in advs {
        if remaining <= Decimal::ZERO {
            break;
        }
        let take = remaining.min(bal);
        sqlx::query(
            "UPDATE customer_advance SET balance = balance - $2, \
                status = CASE WHEN balance - $2 <= 0 THEN 'refunded' ELSE status END WHERE id = $1",
        )
        .bind(aid)
        .bind(take)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        remaining -= take;
    }
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
            amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'advance', $2, 'advance_refunded', $3, $4, 'customer', $2)",
    )
    .bind(s.default_branch)
    .bind(cid)
    .bind(json!({"refund_mode": mode, "note": req.note}))
    .bind(-req.amount)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "refunded": req.amount.to_string(), "refund_mode": mode })))
}

async fn list_advances(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, AdvanceRow>(
        &format!("{ADVANCE_SELECT} ORDER BY a.id DESC LIMIT 200"),
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows.iter().map(advance_json).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct CloseAdvanceReq {
    note: Option<String>,
    #[serde(default)]
    refund: bool,
    refund_mode: Option<String>,
}

/// Finalise a specific advance chosen from the list — either **close** (settle/redeem, no
/// cash out) or **refund** (return the balance to the customer). Zeroes the balance and
/// records the movement in the ledger.
async fn close_advance(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<CloseAdvanceReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let row: Option<(i64, Decimal, String)> = sqlx::query_as(
        "SELECT customer_id, balance, status FROM customer_advance WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (cid, balance, status) = row.ok_or((StatusCode::NOT_FOUND, format!("advance {id} not found")))?;
    if status != "active" {
        return Err((StatusCode::CONFLICT, format!("advance {id} is '{status}' — already finalised")));
    }
    let new_status = if req.refund { "refunded" } else { "closed" };
    // Default refund route: cash for small amounts, else bank (traceable).
    let mode = if req.refund {
        Some(req.refund_mode.clone().unwrap_or_else(|| {
            if balance <= Decimal::from(20000) { "cash".to_string() } else { "bank_transfer".to_string() }
        }))
    } else {
        None
    };
    sqlx::query("UPDATE customer_advance SET balance = 0, status = $2, note = COALESCE($3, note) WHERE id = $1")
        .bind(id)
        .bind(new_status)
        .bind(req.note.as_deref())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
            amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'advance', $2, $6, $3, $4, 'customer', $5)",
    )
    .bind(s.default_branch)
    .bind(id)
    .bind(json!({"customer_id": cid, "note": req.note, "refund_mode": mode}))
    .bind(-balance)
    .bind(cid)
    .bind(if req.refund { "advance_refunded" } else { "advance_closed" })
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": id, "status": new_status, "amount": balance.to_string(), "refund_mode": mode })))
}

/// Advance dashboard metrics: active totals, booked gold weight, and advances due this week.
async fn advance_metrics(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let (active_count, total_balance, total_amount, booked_weight): (i64, Decimal, Decimal, Decimal) =
        sqlx::query_as(
            "SELECT count(*), COALESCE(sum(balance),0), COALESCE(sum(amount),0), \
                COALESCE(sum(CASE WHEN advance_type='metal' THEN booked_weight ELSE 0 END),0) \
             FROM customer_advance WHERE status='active'",
        )
        .fetch_one(&s.db)
        .await
        .map_err(internal)?;

    let customers_with_balance: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT customer_id) FROM customer_advance WHERE status='active' AND balance > 0",
    )
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;

    // Advances due within the next 7 days (active, with a due date).
    let due = sqlx::query_as::<_, AdvanceRow>(
        &format!(
            "{ADVANCE_SELECT} WHERE a.status='active' AND a.due_date IS NOT NULL \
                AND a.due_date <= CURRENT_DATE + INTERVAL '7 days' ORDER BY a.due_date"
        ),
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    let (amt_count, amt_balance): (i64, Decimal) = sqlx::query_as(
        "SELECT count(*), COALESCE(sum(balance),0) FROM customer_advance WHERE status='active' AND advance_type='amount'",
    )
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    let (metal_count, metal_balance): (i64, Decimal) = sqlx::query_as(
        "SELECT count(*), COALESCE(sum(balance),0) FROM customer_advance WHERE status='active' AND advance_type='metal'",
    )
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;

    Ok(Json(json!({
        "active_count": active_count,
        "total_balance": total_balance.to_string(),
        "total_amount": total_amount.to_string(),
        "booked_weight": booked_weight.to_string(),
        "customers_with_balance": customers_with_balance,
        "due_week_count": due.len(),
        "due_week": due.iter().map(advance_json).collect::<Vec<_>>(),
        "by_type": {
            "amount": { "count": amt_count, "balance": amt_balance.to_string() },
            "metal": { "count": metal_count, "balance": metal_balance.to_string() },
        },
    })))
}

#[derive(sqlx::FromRow)]
struct ChequeRow {
    id: i64,
    cheque_no: Option<String>,
    bank: Option<String>,
    amount: Decimal,
    status: String,
    received_at: String,
    deposited_at: Option<String>,
    cleared_at: Option<String>,
    bounced_at: Option<String>,
    document_no: Option<String>,
    customer_name: Option<String>,
}

async fn list_cheques(
    State(s): State<AppState>,
    _auth: AuthUser,
    Query(q): Query<StatusFilter>,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, ChequeRow>(
        "SELECT ch.id, ch.cheque_no, ch.bank, ch.amount, ch.status, \
            ch.received_at::text AS received_at, ch.deposited_at::text AS deposited_at, \
            ch.cleared_at::text AS cleared_at, ch.bounced_at::text AS bounced_at, \
            i.document_no, c.name AS customer_name \
         FROM cheque ch \
         LEFT JOIN invoice i ON i.id = ch.invoice_id \
         LEFT JOIN customer c ON c.id = ch.customer_id \
         WHERE ($1::text IS NULL OR ch.status = $1) \
         ORDER BY ch.id DESC LIMIT 300",
    )
    .bind(q.status.as_deref())
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "cheque_no": r.cheque_no,
                "bank": r.bank,
                "amount": r.amount.to_string(),
                "status": r.status,
                "received_at": r.received_at,
                "deposited_at": r.deposited_at,
                "cleared_at": r.cleared_at,
                "bounced_at": r.bounced_at,
                "document_no": r.document_no,
                "customer_name": r.customer_name,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct ChequeStatusReq {
    status: String,
    bank: Option<String>,
}

async fn update_cheque(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ChequeStatusReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let row: Option<(String, Decimal, i64, i64)> = sqlx::query_as(
        "SELECT status, amount, branch_id, COALESCE(invoice_id, 0) FROM cheque WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (cur, amount, branch_id, invoice_id) =
        row.ok_or((StatusCode::NOT_FOUND, format!("cheque {id} not found")))?;

    // Allowed transitions.
    let ok = matches!(
        (cur.as_str(), req.status.as_str()),
        ("received", "deposited")
            | ("received", "cleared")
            | ("received", "bounced")
            | ("deposited", "cleared")
            | ("deposited", "bounced")
    );
    if !ok {
        return Err((
            StatusCode::CONFLICT,
            format!("cannot move cheque from '{cur}' to '{}'", req.status),
        ));
    }

    let ts_col = match req.status.as_str() {
        "deposited" => "deposited_at",
        "cleared" => "cleared_at",
        "bounced" => "bounced_at",
        _ => "received_at",
    };
    sqlx::query(&format!(
        "UPDATE cheque SET status = $2, bank = COALESCE($3, bank), {ts_col} = now() WHERE id = $1"
    ))
    .bind(id)
    .bind(&req.status)
    .bind(req.bank.as_deref())
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    // Ledger: clearing confirms; a bounce reverses the earlier payment.
    if req.status == "cleared" || req.status == "bounced" {
        let (ev, delta) = if req.status == "cleared" {
            ("cheque_cleared", Decimal::ZERO)
        } else {
            ("cheque_bounced", -amount)
        };
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'cheque', $2, $3, $4, $5, 'invoice', $6)",
        )
        .bind(branch_id)
        .bind(id)
        .bind(ev)
        .bind(json!({"cheque_id": id}))
        .bind(delta)
        .bind(if invoice_id == 0 { None } else { Some(invoice_id) })
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": id, "status": req.status })))
}

// ===================== Unified Party (Option C) =====================

#[derive(Deserialize)]
struct NewParty {
    display_name: String,
    legal_name: Option<String>,
    party_kind: Option<String>, // individual | business
    phone: Option<String>,
    email: Option<String>,
    pan: Option<String>,
    gstin: Option<String>,
    gst_registration_type: Option<String>,
    address_line1: Option<String>,
    address_line2: Option<String>,
    city: Option<String>,
    pincode: Option<String>,
    state_code: Option<String>,
    notes: Option<String>,
    /// Opening balance at go-live (debtor-positive: + = party owes us, − = we owe party).
    #[serde(default)]
    opening_cash_balance: Option<Decimal>,
    /// Opening metal balance in fine grams (debtor-positive).
    #[serde(default)]
    opening_metal_balance: Option<Decimal>,
    #[serde(default)]
    roles: Vec<String>,
}

/// Light GST/KYC validation so created parties are e-invoice ready.
fn validate_party(n: &NewParty) -> Result<(), ApiError> {
    if n.display_name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "display_name is required".to_string()));
    }
    if let Some(g) = n.gstin.as_deref().filter(|g| !g.is_empty()) {
        if g.len() != 15 {
            return Err((StatusCode::BAD_REQUEST, "GSTIN must be 15 characters".to_string()));
        }
        // GSTIN's first two chars are the state code; keep them consistent.
        if let Some(sc) = n.state_code.as_deref().filter(|s| !s.is_empty()) {
            if &g[0..2] != sc {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("GSTIN state prefix '{}' does not match state_code '{}'", &g[0..2], sc),
                ));
            }
        }
    }
    if let Some(p) = n.pan.as_deref().filter(|p| !p.is_empty()) {
        if p.len() != 10 {
            return Err((StatusCode::BAD_REQUEST, "PAN must be 10 characters".to_string()));
        }
    }
    Ok(())
}

async fn create_party(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewParty>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    validate_party(&n)?;
    let kind = n.party_kind.as_deref().unwrap_or("individual");
    let reg = n
        .gst_registration_type
        .as_deref()
        .unwrap_or(if n.gstin.as_deref().filter(|g| !g.is_empty()).is_some() { "regular" } else { "unregistered" });
    let mut tx = s.db.begin().await.map_err(internal)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO party (branch_id, display_name, legal_name, party_kind, phone, email, pan, gstin, \
            gst_registration_type, address_line1, address_line2, city, pincode, state_code, notes) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(n.display_name.trim())
    .bind(n.legal_name.as_deref())
    .bind(kind)
    .bind(n.phone.as_deref())
    .bind(n.email.as_deref())
    .bind(n.pan.as_deref())
    .bind(n.gstin.as_deref())
    .bind(reg)
    .bind(n.address_line1.as_deref())
    .bind(n.address_line2.as_deref())
    .bind(n.city.as_deref())
    .bind(n.pincode.as_deref())
    .bind(n.state_code.as_deref())
    .bind(n.notes.as_deref())
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    let roles = if n.roles.is_empty() {
        vec![if kind == "business" { "wholesale".to_string() } else { "customer".to_string() }]
    } else {
        n.roles.clone()
    };
    for r in &roles {
        sqlx::query("INSERT INTO party_role (party_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(r)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    sqlx::query(
        "INSERT INTO party_terms (party_id, price_tier) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(if kind == "business" { "wholesale" } else { "retail" })
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    if n.opening_cash_balance.is_some() || n.opening_metal_balance.is_some() {
        sqlx::query(
            "UPDATE party_terms SET opening_cash_balance = COALESCE($2, 0), opening_metal_balance = COALESCE($3, 0) WHERE party_id = $1",
        )
        .bind(id)
        .bind(n.opening_cash_balance)
        .bind(n.opening_metal_balance)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": id, "display_name": n.display_name, "roles": roles })))
}

#[derive(Deserialize)]
struct PartyQuery {
    role: Option<String>,
    q: Option<String>,
    archived: Option<bool>,
}

#[derive(sqlx::FromRow)]
struct PartyListRow {
    id: i64,
    display_name: String,
    party_kind: String,
    phone: Option<String>,
    gstin: Option<String>,
    pan: Option<String>,
    state_code: Option<String>,
    gst_registration_type: String,
    roles: Vec<String>,
    cash: Decimal,
    metal: Decimal,
}

async fn list_parties(
    State(s): State<AppState>,
    _auth: AuthUser,
    Query(q): Query<PartyQuery>,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, PartyListRow>(
        "SELECT p.id, p.display_name, p.party_kind, p.phone, p.gstin, p.pan, p.state_code, p.gst_registration_type, \
            COALESCE((SELECT array_agg(role) FROM party_role WHERE party_id = p.id), ARRAY[]::text[]) AS roles, \
            COALESCE((SELECT sum(amount_delta) FROM ledger_event WHERE subject_type='party' AND subject_id=p.id),0) \
              + COALESCE((SELECT opening_cash_balance FROM party_terms WHERE party_id=p.id),0) AS cash, \
            COALESCE((SELECT sum(weight_delta) FROM ledger_event WHERE subject_type='party' AND subject_id=p.id),0) \
              + COALESCE((SELECT opening_metal_balance FROM party_terms WHERE party_id=p.id),0) AS metal \
         FROM party p \
         WHERE p.archived = $3 \
           AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM party_role r WHERE r.party_id=p.id AND r.role=$1)) \
           AND ($2::text IS NULL OR p.display_name ILIKE '%'||$2||'%' OR p.phone ILIKE '%'||$2||'%' OR p.gstin ILIKE '%'||$2||'%') \
         ORDER BY p.id DESC LIMIT 500",
    )
    .bind(q.role.as_deref())
    .bind(q.q.as_deref())
    .bind(q.archived.unwrap_or(false))
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id, "display_name": r.display_name, "party_kind": r.party_kind,
                "phone": r.phone, "gstin": r.gstin, "pan": r.pan, "state_code": r.state_code,
                "gst_registration_type": r.gst_registration_type, "roles": r.roles,
                "cash_balance": r.cash.to_string(), "metal_balance": r.metal.to_string(),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

async fn get_party(
    State(s): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let head: Option<(String, Option<String>, String, Option<String>, Option<String>, Option<String>, Option<String>, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, String)> =
        sqlx::query_as(
            "SELECT display_name, legal_name, party_kind, phone, email, pan, gstin, gst_registration_type, \
                address_line1, address_line2, city, pincode, state_code, cdd_risk_tier, created_at::text \
             FROM party WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    let h = head.ok_or((StatusCode::NOT_FOUND, format!("party {id} not found")))?;

    let roles: Vec<String> = sqlx::query_scalar("SELECT role FROM party_role WHERE party_id=$1 ORDER BY role")
        .bind(id)
        .fetch_all(&s.db)
        .await
        .map_err(internal)?;

    // Canonical party ledger (debtor-positive): + = party owes us, − = we owe party.
    let party_cash: Decimal = sqlx::query_scalar(
        "SELECT (SELECT COALESCE(sum(amount_delta),0) FROM ledger_event WHERE subject_type='party' AND subject_id=$1) \
         + COALESCE((SELECT opening_cash_balance FROM party_terms WHERE party_id=$1),0)",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    let party_metal: Decimal = sqlx::query_scalar(
        "SELECT (SELECT COALESCE(sum(weight_delta),0) FROM ledger_event WHERE subject_type='party' AND subject_id=$1) \
         + COALESCE((SELECT opening_metal_balance FROM party_terms WHERE party_id=$1),0)",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;

    // Linked legacy balances (surfaced read-only so nothing is hidden).
    let advance_credit: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(ca.balance),0) FROM customer_advance ca JOIN customer c ON c.id=ca.customer_id \
         WHERE c.party_id=$1 AND ca.status='active'",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    let supplier_payable: Decimal =
        sqlx::query_scalar("SELECT COALESCE(sum(balance),0) FROM supplier WHERE party_id=$1")
            .bind(id)
            .fetch_one(&s.db)
            .await
            .map_err(internal)?;
    let smith_metal: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(weight_delta),0) FROM ledger_event WHERE subject_type='smith' \
         AND subject_id IN (SELECT id FROM smith WHERE party_id=$1)",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    let smith_payable: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(amount_delta),0) FROM ledger_event WHERE subject_type='smith' \
         AND subject_id IN (SELECT id FROM smith WHERE party_id=$1)",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;

    let terms: Option<(String, Decimal, i32, Option<Decimal>, Decimal, Decimal)> = sqlx::query_as(
        "SELECT price_tier, credit_limit, credit_days, default_making_percent, opening_cash_balance, opening_metal_balance \
         FROM party_terms WHERE party_id=$1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?;

    let addrs = sqlx::query_as::<_, (i64, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, bool)>(
        "SELECT id, label, address_line1, address_line2, city, pincode, state_code, is_default FROM party_address WHERE party_id=$1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    Ok(Json(json!({
        "id": id,
        "display_name": h.0, "legal_name": h.1, "party_kind": h.2, "phone": h.3, "email": h.4,
        "pan": h.5, "gstin": h.6, "gst_registration_type": h.7,
        "address_line1": h.8, "address_line2": h.9, "city": h.10, "pincode": h.11, "state_code": h.12,
        "cdd_risk_tier": h.13, "created_at": h.14,
        "roles": roles,
        "balances": {
            "party_cash": party_cash.to_string(),
            "party_metal": party_metal.to_string(),
            "advance_credit": advance_credit.to_string(),
            "supplier_payable": supplier_payable.to_string(),
            "smith_metal": smith_metal.to_string(),
            "smith_payable": smith_payable.to_string(),
        },
        "terms": terms.map(|t| json!({
            "price_tier": t.0, "credit_limit": t.1.to_string(), "credit_days": t.2,
            "default_making_percent": t.3.map(|v| v.to_string()),
            "opening_cash_balance": t.4.to_string(), "opening_metal_balance": t.5.to_string(),
        })),
        "addresses": addrs.iter().map(|a| json!({
            "id": a.0, "label": a.1, "address_line1": a.2, "address_line2": a.3,
            "city": a.4, "pincode": a.5, "state_code": a.6, "is_default": a.7,
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct UpdatePartyReq {
    display_name: Option<String>,
    legal_name: Option<String>,
    party_kind: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    pan: Option<String>,
    gstin: Option<String>,
    gst_registration_type: Option<String>,
    address_line1: Option<String>,
    address_line2: Option<String>,
    city: Option<String>,
    pincode: Option<String>,
    state_code: Option<String>,
    notes: Option<String>,
    opening_cash_balance: Option<Decimal>,
    opening_metal_balance: Option<Decimal>,
}

async fn update_party(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(u): Json<UpdatePartyReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    if let Some(g) = u.gstin.as_deref().filter(|g| !g.is_empty()) {
        if g.len() != 15 {
            return Err((StatusCode::BAD_REQUEST, "GSTIN must be 15 characters".to_string()));
        }
        if let Some(sc) = u.state_code.as_deref().filter(|s| !s.is_empty()) {
            if &g[0..2] != sc {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("GSTIN state prefix '{}' does not match state_code '{}'", &g[0..2], sc),
                ));
            }
        }
    }
    if let Some(p) = u.pan.as_deref().filter(|p| !p.is_empty()) {
        if p.len() != 10 {
            return Err((StatusCode::BAD_REQUEST, "PAN must be 10 characters".to_string()));
        }
    }
    sqlx::query(
        "UPDATE party SET \
            display_name = COALESCE($2, display_name), \
            legal_name = COALESCE($3, legal_name), \
            party_kind = COALESCE($4, party_kind), \
            phone = COALESCE($5, phone), \
            email = COALESCE($6, email), \
            pan = COALESCE($7, pan), \
            gstin = COALESCE($8, gstin), \
            gst_registration_type = COALESCE($9, gst_registration_type), \
            address_line1 = COALESCE($10, address_line1), \
            address_line2 = COALESCE($11, address_line2), \
            city = COALESCE($12, city), \
            pincode = COALESCE($13, pincode), \
            state_code = COALESCE($14, state_code), \
            notes = COALESCE($15, notes) \
         WHERE id = $1",
    )
    .bind(id)
    .bind(u.display_name.as_deref().filter(|v| !v.is_empty()))
    .bind(u.legal_name.as_deref())
    .bind(u.party_kind.as_deref())
    .bind(u.phone.as_deref())
    .bind(u.email.as_deref())
    .bind(u.pan.as_deref())
    .bind(u.gstin.as_deref())
    .bind(u.gst_registration_type.as_deref())
    .bind(u.address_line1.as_deref())
    .bind(u.address_line2.as_deref())
    .bind(u.city.as_deref())
    .bind(u.pincode.as_deref())
    .bind(u.state_code.as_deref())
    .bind(u.notes.as_deref())
    .execute(&s.db)
    .await
    .map_err(internal)?;
    if u.opening_cash_balance.is_some() || u.opening_metal_balance.is_some() {
        sqlx::query(
            "INSERT INTO party_terms (party_id, opening_cash_balance, opening_metal_balance) \
             VALUES ($1, COALESCE($2,0), COALESCE($3,0)) \
             ON CONFLICT (party_id) DO UPDATE SET \
                opening_cash_balance = COALESCE($2, party_terms.opening_cash_balance), \
                opening_metal_balance = COALESCE($3, party_terms.opening_metal_balance)",
        )
        .bind(id)
        .bind(u.opening_cash_balance)
        .bind(u.opening_metal_balance)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    }
    Ok(Json(json!({ "id": id, "updated": true })))
}

async fn restore_party(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    sqlx::query("UPDATE party SET archived = false WHERE id = $1")
        .bind(id)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "id": id, "restored": true })))
}

async fn delete_party(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    // Does this party have any history that must be preserved?
    let invoices: i64 = sqlx::query_scalar("SELECT count(*) FROM invoice WHERE party_id = $1")
        .bind(id)
        .fetch_one(&s.db)
        .await
        .map_err(internal)?;
    let ledger: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ledger_event WHERE subject_type='party' AND subject_id=$1",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    let linked: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM customer WHERE party_id=$1) \
              + (SELECT count(*) FROM supplier WHERE party_id=$1) \
              + (SELECT count(*) FROM smith WHERE party_id=$1)",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;

    if invoices == 0 && ledger == 0 && linked == 0 {
        // No history — safe to remove entirely.
        let mut tx = s.db.begin().await.map_err(internal)?;
        for q in [
            "DELETE FROM party_role WHERE party_id=$1",
            "DELETE FROM party_terms WHERE party_id=$1",
            "DELETE FROM party_address WHERE party_id=$1",
            "DELETE FROM party WHERE id=$1",
        ] {
            sqlx::query(q).bind(id).execute(&mut *tx).await.map_err(internal)?;
        }
        tx.commit().await.map_err(internal)?;
        Ok(Json(json!({ "deleted": true, "archived": false })))
    } else {
        // Has history — archive (hide) instead of breaking references.
        sqlx::query("UPDATE party SET archived = true WHERE id = $1")
            .bind(id)
            .execute(&s.db)
            .await
            .map_err(internal)?;
        Ok(Json(json!({ "deleted": false, "archived": true })))
    }
}

#[derive(Deserialize)]
struct RoleReq {
    role: String,
}
async fn add_party_role(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(r): Json<RoleReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    sqlx::query("INSERT INTO party_role (party_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(&r.role)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "party_id": id, "role": r.role })))
}

#[derive(Deserialize)]
struct PartyTermsReq {
    price_tier: Option<String>,
    credit_limit: Option<Decimal>,
    credit_days: Option<i32>,
    default_making_percent: Option<Decimal>,
}
async fn set_party_terms(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(t): Json<PartyTermsReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    sqlx::query(
        "INSERT INTO party_terms (party_id, price_tier, credit_limit, credit_days, default_making_percent) \
         VALUES ($1, COALESCE($2,'retail'), COALESCE($3,0), COALESCE($4,0), $5) \
         ON CONFLICT (party_id) DO UPDATE SET \
            price_tier=COALESCE($2, party_terms.price_tier), \
            credit_limit=COALESCE($3, party_terms.credit_limit), \
            credit_days=COALESCE($4, party_terms.credit_days), \
            default_making_percent=COALESCE($5, party_terms.default_making_percent)",
    )
    .bind(id)
    .bind(t.price_tier.as_deref())
    .bind(t.credit_limit)
    .bind(t.credit_days)
    .bind(t.default_making_percent)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "party_id": id, "updated": true })))
}

#[derive(Deserialize)]
struct PartyAddressReq {
    label: Option<String>,
    address_line1: Option<String>,
    address_line2: Option<String>,
    city: Option<String>,
    pincode: Option<String>,
    state_code: Option<String>,
    #[serde(default)]
    is_default: bool,
}
async fn add_party_address(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(a): Json<PartyAddressReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    let aid: i64 = sqlx::query_scalar(
        "INSERT INTO party_address (party_id, label, address_line1, address_line2, city, pincode, state_code, is_default) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    )
    .bind(id)
    .bind(a.label.as_deref())
    .bind(a.address_line1.as_deref())
    .bind(a.address_line2.as_deref())
    .bind(a.city.as_deref())
    .bind(a.pincode.as_deref())
    .bind(a.state_code.as_deref())
    .bind(a.is_default)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": aid })))
}

// ---- Dual cash + metal ledger (gram khata) for wholesale/dealers ----
// Convention: entry_type 'debit' => party owes us more (+); 'credit' => we owe party / they settled (−).

#[derive(Deserialize)]
struct PartyCashEntry {
    amount: Decimal,
    entry_type: String, // 'debit' | 'credit'
    mode: Option<String>,
    note: Option<String>,
}
async fn party_cash_entry(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(e): Json<PartyCashEntry>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    if e.amount <= Decimal::ZERO {
        return Err((StatusCode::BAD_REQUEST, "amount must be > 0".to_string()));
    }
    let signed = if e.entry_type == "credit" { -e.amount } else { e.amount };
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1,'party',$2,$3,$4,$5,'party',$2)",
    )
    .bind(s.default_branch)
    .bind(id)
    .bind(format!("party_cash_{}", e.entry_type))
    .bind(json!({"mode": e.mode, "note": e.note}))
    .bind(signed)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "party_id": id, "amount_delta": signed.to_string() })))
}

#[derive(Deserialize)]
struct PartyMetalEntry {
    weight: Decimal, // fine grams
    metal_type_id: Option<i64>,
    entry_type: String, // 'debit' | 'credit'
    rate: Option<Decimal>,
    note: Option<String>,
}
async fn party_metal_entry(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(e): Json<PartyMetalEntry>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    if e.weight <= Decimal::ZERO {
        return Err((StatusCode::BAD_REQUEST, "weight must be > 0".to_string()));
    }
    let signed = if e.entry_type == "credit" { -e.weight } else { e.weight };
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, weight_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1,'party',$2,$3,$4,$5,'party',$2)",
    )
    .bind(s.default_branch)
    .bind(id)
    .bind(format!("party_metal_{}", e.entry_type))
    .bind(json!({"metal_type_id": e.metal_type_id, "rate": e.rate.map(|r| r.to_string()), "note": e.note}))
    .bind(signed)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "party_id": id, "weight_delta": signed.to_string() })))
}

async fn party_ledger(
    State(s): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, String, String, Option<Decimal>, Option<Decimal>, Value)>(
        "SELECT id, occurred_at::text, event_type, amount_delta, weight_delta, after_json \
         FROM ledger_event WHERE subject_type='party' AND subject_id=$1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|(eid, at, ev, amt, wt, j)| {
            json!({
                "id": eid, "at": at, "event_type": ev,
                "amount_delta": amt.unwrap_or(Decimal::ZERO).to_string(),
                "weight_delta": wt.unwrap_or(Decimal::ZERO).to_string(),
                "detail": j,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

// ---- Rate cutting (fix an unfixed metal position into money) ----

#[derive(Deserialize)]
struct NewRateCut {
    party_id: i64,
    grams: Decimal,
    rate: Decimal,
    direction: Option<String>, // 'we_owe' | 'they_owe' — inferred from balance if omitted
    note: Option<String>,
    series_code: Option<String>,
}

/// Record a rate cut on a party's account: convert `grams` of fine metal into money at
/// `rate`. Direction defaults from the party's current metal balance (debtor-positive:
/// positive = they owe us grams → they_owe; negative = we owe them → we_owe).
async fn create_rate_cut(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewRateCut>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    if n.grams <= Decimal::ZERO || n.rate <= Decimal::ZERO {
        return Err((StatusCode::BAD_REQUEST, "grams and rate must be positive".to_string()));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;

    // Rate cutting is a wholesale concept — only B2B parties (wholesale/supplier), not
    // retail (B2C) customers.
    let is_b2b: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM party_role WHERE party_id=$1 AND role IN ('wholesale','supplier'))",
    )
    .bind(n.party_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if !is_b2b {
        return Err((
            StatusCode::BAD_REQUEST,
            "rate cutting applies only to B2B parties (wholesale / supplier)".to_string(),
        ));
    }

    let metal_bal: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(weight_delta),0) FROM ledger_event WHERE subject_type='party' AND subject_id=$1",
    )
    .bind(n.party_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    let direction = match n.direction.as_deref() {
        Some("we_owe") => "we_owe",
        Some("they_owe") => "they_owe",
        _ => if metal_bal < Decimal::ZERO { "we_owe" } else { "they_owe" },
    };
    let amount = round_money(n.grams * n.rate);
    // they_owe: reduce grams they owe us (−), raise money they owe us (+).
    // we_owe:   reduce grams we owe them (+ toward zero), raise money we owe them (−).
    let (wd, ad) = if direction == "we_owe" {
        (n.grams, -amount)
    } else {
        (-n.grams, amount)
    };

    let fy = current_fy();
    let series = n.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let (cut_no, document_no) = allocate_doc_no(&mut tx, "rate_cut", &fy, series).await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO rate_cut (branch_id, party_id, series_code, cut_no, document_no, fy, grams, rate, amount, direction, note) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(n.party_id)
    .bind(series)
    .bind(cut_no)
    .bind(&document_no)
    .bind(&fy)
    .bind(n.grams)
    .bind(n.rate)
    .bind(amount)
    .bind(direction)
    .bind(n.note.as_deref())
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
            weight_delta, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1,'party',$2,'rate_cut',$3,$4,$5,'rate_cut',$6)",
    )
    .bind(s.default_branch)
    .bind(n.party_id)
    .bind(json!({"document_no": document_no, "grams": n.grams.to_string(), "rate": n.rate.to_string(), "direction": direction}))
    .bind(wd)
    .bind(ad)
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "rate_cut_id": id, "document_no": document_no, "grams": n.grams.to_string(),
        "rate": n.rate.to_string(), "amount": amount.to_string(), "direction": direction,
    })))
}

async fn list_rate_cuts(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, Option<String>, Option<String>, Decimal, Decimal, Decimal, String, String)>(
        "SELECT rc.id, rc.document_no, p.display_name, rc.grams, rc.rate, rc.amount, rc.direction, rc.created_at::text \
         FROM rate_cut rc LEFT JOIN party p ON p.id = rc.party_id ORDER BY rc.id DESC LIMIT 200",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|(id, doc, name, grams, rate, amount, dir, at)| json!({
            "id": id, "document_no": doc, "party_name": name, "grams": grams.to_string(),
            "rate": rate.to_string(), "amount": amount.to_string(), "direction": dir, "created_at": at,
        }))
        .collect::<Vec<_>>())))
}

// ---- e-invoice (NIC schema) readiness ----

async fn setting_text(db: &sqlx::PgPool, key: &str, default: &str) -> String {
    sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key=$1")
        .bind(key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| default.to_string())
}

/// Build a NIC e-invoice (IRN) schema-compatible JSON payload for an invoice.
/// This produces the exact request shape for later IRP/e-way-bill submission; it does
/// not call the IRP. Buyer is resolved through the invoice's customer → linked party.
async fn invoice_einvoice(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;

    let inv: Option<(Option<String>, String, String, Decimal, Decimal, Decimal, Decimal, Option<i64>, Option<i64>)> =
        sqlx::query_as(
            "SELECT document_no, created_at::text, type, subtotal, discount_total, tax_total, grand_total, customer_id, party_id \
             FROM invoice WHERE id=$1",
        )
        .bind(id)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    let (doc_no, created_at, _typ, subtotal, _disc, tax_total, grand_total, customer_id, party_id) =
        inv.ok_or((StatusCode::NOT_FOUND, format!("invoice {id} not found")))?;

    // Seller (company) details from settings.
    let seller_gstin = setting_text(&s.db, "seller_gstin", "27AAAAA0000A1Z5").await;
    let seller_state = setting_text(&s.db, "seller_state_code", &seller_gstin[0..2.min(seller_gstin.len())]).await;
    let seller = json!({
        "Gstin": seller_gstin,
        "LglNm": setting_text(&s.db, "seller_legal_name", "Cygnus Jewellers").await,
        "Addr1": setting_text(&s.db, "seller_address1", "").await,
        "Loc": setting_text(&s.db, "seller_loc", "").await,
        "Pin": setting_text(&s.db, "seller_pincode", "").await,
        "Stcd": seller_state,
    });

    // Buyer: prefer the invoice's linked party; else the customer's linked party (URP if none).
    let buyer_party: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String)> =
        if let Some(pid) = party_id {
            sqlx::query_as(
                "SELECT display_name, legal_name, gstin, address_line1, city, pincode, COALESCE(state_code, '') \
                 FROM party WHERE id=$1",
            )
            .bind(pid)
            .fetch_optional(&s.db)
            .await
            .map_err(internal)?
        } else if let Some(cid) = customer_id {
            sqlx::query_as(
                "SELECT p.display_name, p.legal_name, p.gstin, p.address_line1, p.city, p.pincode, COALESCE(p.state_code, '') \
                 FROM party p JOIN customer c ON c.party_id = p.id WHERE c.id=$1",
            )
            .bind(cid)
            .fetch_optional(&s.db)
            .await
            .map_err(internal)?
        } else {
            None
        };
    let (buyer, pos) = match buyer_party {
        Some((name, legal, gstin, addr, loc, pin, stcd)) => {
            let pos = if stcd.is_empty() { seller_state.clone() } else { stcd.clone() };
            (
                json!({
                    "Gstin": gstin.unwrap_or_else(|| "URP".to_string()),
                    "LglNm": legal.unwrap_or(name),
                    "Pos": pos,
                    "Addr1": addr,
                    "Loc": loc,
                    "Pin": pin,
                    "Stcd": stcd,
                }),
                pos,
            )
        }
        None => (json!({ "Gstin": "URP", "LglNm": "Walk-in", "Pos": seller_state, "Stcd": seller_state }), seller_state.clone()),
    };
    let inter_state = pos != seller_state;

    // Items.
    let lines = sqlx::query_as::<_, (Option<String>, Option<String>, Option<Decimal>, Decimal, Decimal)>(
        "SELECT description, hsn, net_weight, taxable_value, line_total FROM invoice_line WHERE invoice_id=$1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let mut item_list: Vec<Value> = Vec::new();
    for (i, (desc, hsn, qty, taxable, total)) in lines.iter().enumerate() {
        let gst_amt = round_money(*total - *taxable);
        let (cgst, sgst, igst) = if inter_state {
            (Decimal::ZERO, Decimal::ZERO, gst_amt)
        } else {
            let half = round_money(gst_amt / Decimal::from(2));
            (half, gst_amt - half, Decimal::ZERO)
        };
        item_list.push(json!({
            "SlNo": (i + 1).to_string(),
            "PrdDesc": desc.clone().unwrap_or_default(),
            "HsnCd": hsn.clone().unwrap_or_else(|| "7113".to_string()),
            "Qty": qty.map(|q| q.to_string()).unwrap_or_else(|| "1".to_string()),
            "Unit": "GMS",
            "TotAmt": taxable.to_string(),
            "AssAmt": taxable.to_string(),
            "GstRt": "3",
            "IgstAmt": igst.to_string(),
            "CgstAmt": cgst.to_string(),
            "SgstAmt": sgst.to_string(),
            "TotItemVal": total.to_string(),
        }));
    }
    let (cgst_val, sgst_val, igst_val) = if inter_state {
        (Decimal::ZERO, Decimal::ZERO, tax_total)
    } else {
        let half = round_money(tax_total / Decimal::from(2));
        (half, tax_total - half, Decimal::ZERO)
    };

    let payload = json!({
        "Version": "1.1",
        "TranDtls": { "TaxSch": "GST", "SupTyp": if inter_state { "B2B" } else { "B2B" }, "RegRev": "N" },
        "DocDtls": { "Typ": "INV", "No": doc_no.clone().unwrap_or_else(|| format!("INV-{id}")), "Dt": created_at.get(0..10).unwrap_or("") },
        "SellerDtls": seller,
        "BuyerDtls": buyer,
        "ItemList": item_list,
        "ValDtls": {
            "AssVal": subtotal.to_string(),
            "CgstVal": cgst_val.to_string(),
            "SgstVal": sgst_val.to_string(),
            "IgstVal": igst_val.to_string(),
            "TotInvVal": grand_total.to_string(),
        },
        "_meta": {
            "place_of_supply": pos,
            "supply": if inter_state { "inter_state" } else { "intra_state" },
            "eway_bill_required": grand_total >= Decimal::from(50000),
            "note": "Schema-compatible payload for IRP/e-way submission; IRN not yet requested.",
        },
    });
    Ok(Json(payload))
}

// ===================== Smith job-work =====================

#[derive(Deserialize)]
struct NewSmith {
    name: String,
    phone: Option<String>,
    gstin: Option<String>,
    #[serde(default)]
    gst_registered: bool,
    notes: Option<String>,
}

async fn create_smith(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewSmith>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO smith (branch_id, name, phone, gstin, gst_registered, notes) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(&n.name)
    .bind(n.phone.as_deref())
    .bind(n.gstin.as_deref())
    .bind(n.gst_registered)
    .bind(n.notes.as_deref())
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id, "name": n.name })))
}

async fn list_smiths(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, bool, Decimal, Decimal)>(
        "SELECT s.id, s.name, s.phone, s.gstin, s.gst_registered, \
            COALESCE((SELECT sum(weight_delta) FROM ledger_event WHERE subject_type='smith' AND subject_id=s.id),0) AS metal_balance, \
            COALESCE((SELECT sum(amount_delta) FROM ledger_event WHERE subject_type='smith' AND subject_id=s.id),0) AS cash_payable \
         FROM smith s ORDER BY s.id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|(id, name, phone, gstin, reg, metal, cash)| {
            json!({
                "id": id, "name": name, "phone": phone, "gstin": gstin, "gst_registered": reg,
                "metal_balance": metal.to_string(), "cash_payable": cash.to_string(),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct MeltReq {
    metal_type_id: i64,
    old_gold_lot_ids: Vec<i64>,
    fine_recovered: Decimal,
    note: Option<String>,
}

async fn create_melt(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(req): Json<MeltReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    if req.old_gold_lot_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "select scrap lots to melt".to_string()));
    }
    assert_not_locked(&s.db, &today_ist()).await?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let mut gross = Decimal::ZERO;
    let mut fine_in = Decimal::ZERO;
    for lid in &req.old_gold_lot_ids {
        let row: Option<(Decimal, Option<Decimal>, String, i64)> =
            sqlx::query_as("SELECT gross_weight, fine_weight, status, metal_type_id FROM old_gold_lot WHERE id = $1 FOR UPDATE")
                .bind(lid)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?;
        let (g, f, st, mtid) = row.ok_or((StatusCode::NOT_FOUND, format!("lot {lid} not found")))?;
        if st != "in_scrap" {
            return Err((StatusCode::CONFLICT, format!("lot {lid} is '{st}', not in scrap")));
        }
        // A melt batch must be a single metal — never mix gold/silver/platinum.
        if mtid != req.metal_type_id {
            return Err((
                StatusCode::CONFLICT,
                format!("lot {lid} is a different metal than the batch — a melt batch must be one metal"),
            ));
        }
        gross += g;
        fine_in += f.unwrap_or(Decimal::ZERO);
    }
    let loss = (fine_in - req.fine_recovered).max(Decimal::ZERO);
    let batch_id: i64 = sqlx::query_scalar(
        "INSERT INTO melt_batch (branch_id, metal_type_id, gross_weight, fine_recovered, loss_weight, note, expected_fine) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(req.metal_type_id)
    .bind(gross)
    .bind(req.fine_recovered)
    .bind(loss)
    .bind(req.note.as_deref())
    .bind(fine_in)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    for lid in &req.old_gold_lot_ids {
        sqlx::query("INSERT INTO melt_batch_lot (melt_batch_id, old_gold_lot_id) VALUES ($1, $2)")
            .bind(batch_id)
            .bind(lid)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("UPDATE old_gold_lot SET status = 'melted' WHERE id = $1")
            .bind(lid)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, weight_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'metal', $2, 'melt_loss', $3, $4, 'melt_batch', $2)",
    )
    .bind(s.default_branch)
    .bind(batch_id)
    .bind(json!({"gross": gross.to_string(), "fine_recovered": req.fine_recovered.to_string()}))
    .bind(-loss)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "melt_batch_id": batch_id, "gross": gross.to_string(),
        "expected_fine": fine_in.to_string(),
        "fine_recovered": req.fine_recovered.to_string(),
        "loss": loss.to_string(),
        "variance": (req.fine_recovered - fine_in).to_string(),
    })))
}

#[derive(Deserialize)]
struct IssueJobReq {
    smith_id: i64,
    metal_type_id: i64,
    source: String, // 'scrap' | 'refined'
    issued_fine_weight: Decimal,
    issued_gross_weight: Option<Decimal>,
    #[serde(default)]
    old_gold_lot_ids: Vec<i64>,
    #[serde(default)]
    wastage_percent_allowed: Decimal,
    making_per_gram: Option<Decimal>,
    making_per_piece: Option<Decimal>,
}

async fn issue_smith_job(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(req): Json<IssueJobReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let job_id: i64 = sqlx::query_scalar(
        "INSERT INTO smith_job (branch_id, smith_id, metal_type_id, source, issued_fine_weight, \
            issued_gross_weight, wastage_percent_allowed, making_per_gram, making_per_piece) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(req.smith_id)
    .bind(req.metal_type_id)
    .bind(&req.source)
    .bind(req.issued_fine_weight)
    .bind(req.issued_gross_weight)
    .bind(req.wastage_percent_allowed)
    .bind(req.making_per_gram)
    .bind(req.making_per_piece)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if req.source == "scrap" {
        for lid in &req.old_gold_lot_ids {
            // A smith issue is a single metal — lots must match the job's metal and be issuable.
            let row: Option<(i64, String)> =
                sqlx::query_as("SELECT metal_type_id, status FROM old_gold_lot WHERE id = $1 FOR UPDATE")
                    .bind(lid)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(internal)?;
            let (mtid, st) = row.ok_or((StatusCode::NOT_FOUND, format!("lot {lid} not found")))?;
            if mtid != req.metal_type_id {
                return Err((
                    StatusCode::CONFLICT,
                    format!("lot {lid} is a different metal than the issue — a smith issue must be one metal"),
                ));
            }
            if !matches!(st.as_str(), "in_scrap" | "melted") {
                return Err((StatusCode::CONFLICT, format!("lot {lid} is '{st}', not available to issue")));
            }
            sqlx::query("UPDATE old_gold_lot SET status = 'issued' WHERE id = $1")
                .bind(lid)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            sqlx::query("INSERT INTO smith_job_lot (smith_job_id, old_gold_lot_id) VALUES ($1, $2)")
                .bind(job_id)
                .bind(lid)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
        }
    }
    // Metal account: smith now holds our fine metal.
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, weight_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'smith', $2, 'metal_issued', $3, $4, 'smith_job', $5)",
    )
    .bind(s.default_branch)
    .bind(req.smith_id)
    .bind(json!({"job_id": job_id, "source": req.source}))
    .bind(req.issued_fine_weight)
    .bind(job_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "smith_job_id": job_id, "status": "issued" })))
}

#[derive(Deserialize)]
struct ReceiveJobReq {
    purity_id: i64,
    sku: Option<String>,
    received_gross: Decimal,
    received_net: Decimal,
    received_fine: Decimal,
    #[serde(default = "one_i32")]
    pieces: i32,
    making_per_gram: Option<Decimal>,
    making_per_piece: Option<Decimal>,
    #[serde(default)]
    stones: Vec<LineStoneReq>,
    category_id: Option<i64>,
}
fn one_i32() -> i32 {
    1
}

async fn receive_smith_job(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(job_id): Path<i64>,
    Json(req): Json<ReceiveJobReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let job: Option<(i64, i64, i64, Decimal, Option<Decimal>, Option<Decimal>, String, Option<bool>)> = sqlx::query_as(
        "SELECT smith_id, metal_type_id, branch_id, issued_fine_weight, making_per_gram, making_per_piece, status, \
            (SELECT gst_registered FROM smith WHERE id = smith_job.smith_id) \
         FROM smith_job WHERE id = $1 FOR UPDATE",
    )
    .bind(job_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (smith_id, metal_type_id, branch_id, issued_fine, job_mpg, job_mpp, status, registered) =
        job.ok_or((StatusCode::NOT_FOUND, format!("job {job_id} not found")))?;
    if status != "issued" {
        return Err((StatusCode::CONFLICT, format!("job {job_id} is '{status}', not awaiting receipt")));
    }

    let mpg = req.making_per_gram.or(job_mpg).unwrap_or(Decimal::ZERO);
    let mpp = req.making_per_piece.or(job_mpp).unwrap_or(Decimal::ZERO);
    let making_charge = round_money(mpg * req.received_net + mpp * Decimal::from(req.pieces));
    let rcm = !registered.unwrap_or(false);
    let making_gst = round_money(making_charge * Decimal::new(5, 2)); // 5%
    let wastage_weight = (issued_fine - req.received_fine).max(Decimal::ZERO);

    // New finished ornament → stock. Cost ≈ metal (net × purity buy rate) + making.
    let buy_rate: Decimal = sqlx::query_scalar(
        "SELECT buy_rate FROM metal_rate WHERE purity_id = $1 ORDER BY effective_from DESC LIMIT 1",
    )
    .bind(req.purity_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    .unwrap_or(Decimal::ZERO);
    let stones_value: Decimal = req.stones.iter().map(|s| s.value).sum();
    let cost_value = round_money(req.received_net * buy_rate) + making_charge + stones_value;
    let sku = req.sku.clone().unwrap_or_else(|| format!("SMJ-{job_id}"));
    let smj_dept = resolve_department(&mut tx, None, &req.stones, Some(metal_type_id), Some(req.purity_id)).await?;
    let item_id: i64 = sqlx::query_scalar(
        "INSERT INTO item (branch_id, sku, metal_type_id, purity_id, gross_weight, net_weight, cost_value, ownership_state, category_id, department_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_stock', $8, $9) RETURNING id",
    )
    .bind(branch_id)
    .bind(&sku)
    .bind(metal_type_id)
    .bind(req.purity_id)
    .bind(req.received_gross)
    .bind(req.received_net)
    .bind(cost_value)
    .bind(req.category_id)
    .bind(smj_dept)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    // Record the ornament's stone composition.
    for st in &req.stones {
        sqlx::query(
            "INSERT INTO item_stone (item_id, stone_type_id, stone_quality_id, description, carat, pieces, rate, value, certificate_no, lab) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(item_id)
        .bind(st.stone_type_id)
        .bind(st.stone_quality_id)
        .bind(st.description.as_deref())
        .bind(st.carat)
        .bind(st.pieces)
        .bind(st.rate)
        .bind(st.value)
        .bind(st.certificate_no.as_deref())
        .bind(st.lab.as_deref())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    sqlx::query(
        "UPDATE smith_job SET status = 'received', item_id = $2, received_gross = $3, received_net = $4, \
            received_fine = $5, pieces = $6, wastage_weight = $7, making_charge = $8, making_gst = $9, \
            rcm = $10, received_at = now() WHERE id = $1",
    )
    .bind(job_id)
    .bind(item_id)
    .bind(req.received_gross)
    .bind(req.received_net)
    .bind(req.received_fine)
    .bind(req.pieces)
    .bind(wastage_weight)
    .bind(making_charge)
    .bind(making_gst)
    .bind(rcm)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    // Metal returned (reduces smith's holding) + making payable.
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, weight_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'smith', $2, 'metal_returned', $3, $4, 'smith_job', $5)",
    )
    .bind(branch_id)
    .bind(smith_id)
    .bind(json!({"job_id": job_id, "item_id": item_id, "wastage": wastage_weight.to_string()}))
    .bind(-req.received_fine)
    .bind(job_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    let payable = making_charge + if rcm { Decimal::ZERO } else { making_gst };
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'smith', $2, 'making_payable', $3, $4, 'smith_job', $5)",
    )
    .bind(branch_id)
    .bind(smith_id)
    .bind(json!({"job_id": job_id, "making": making_charge.to_string(), "gst": making_gst.to_string(), "rcm": rcm}))
    .bind(payable)
    .bind(job_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "smith_job_id": job_id, "item_id": item_id, "sku": sku,
        "making_charge": making_charge.to_string(), "making_gst": making_gst.to_string(),
        "rcm": rcm, "wastage_weight": wastage_weight.to_string(),
        "payable_to_smith": payable.to_string(),
    })))
}

#[derive(Deserialize)]
struct SettleSmithReq {
    amount: Decimal,
    mode: Option<String>,
}

async fn settle_smith_job(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(job_id): Path<i64>,
    Json(req): Json<SettleSmithReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let row: Option<(i64, i64, String)> =
        sqlx::query_as("SELECT smith_id, branch_id, status FROM smith_job WHERE id = $1 FOR UPDATE")
            .bind(job_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    let (smith_id, branch_id, status) =
        row.ok_or((StatusCode::NOT_FOUND, format!("job {job_id} not found")))?;
    if status != "received" {
        return Err((StatusCode::CONFLICT, format!("job {job_id} is '{status}', cannot settle")));
    }
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'smith', $2, 'smith_paid', $3, $4, 'smith_job', $5)",
    )
    .bind(branch_id)
    .bind(smith_id)
    .bind(json!({"job_id": job_id, "mode": req.mode}))
    .bind(-req.amount)
    .bind(job_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query("UPDATE smith_job SET status = 'settled', settled_at = now() WHERE id = $1")
        .bind(job_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "smith_job_id": job_id, "status": "settled", "paid": req.amount.to_string() })))
}

async fn list_smith_jobs(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, String, String, Decimal, Option<Decimal>, Option<Decimal>, Option<Decimal>, bool, Option<String>)>(
        "SELECT j.id, sm.name, j.status, j.issued_fine_weight, j.received_fine, j.wastage_weight, \
            j.making_charge, j.rcm, (SELECT sku FROM item WHERE item.id = j.item_id) \
         FROM smith_job j JOIN smith sm ON sm.id = j.smith_id ORDER BY j.id DESC LIMIT 200",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|(id, smith, status, issued, recv, wastage, making, rcm, sku)| {
            json!({
                "id": id, "smith": smith, "status": status,
                "issued_fine": issued.to_string(),
                "received_fine": recv.map(|d| d.to_string()),
                "wastage_weight": wastage.map(|d| d.to_string()),
                "making_charge": making.map(|d| d.to_string()),
                "rcm": rcm, "item_sku": sku,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

// ===================== Materials master — Metals =====================

#[derive(sqlx::FromRow)]
struct MetalTypeRow {
    id: i64,
    name: String,
    base_unit: String,
    default_hsn: Option<String>,
    gst_rate: Option<Decimal>,
    hallmark_applicable: bool,
    active: bool,
}
#[derive(sqlx::FromRow)]
struct PurityMasterRow {
    id: i64,
    metal_type_id: i64,
    label: String,
    karat: Option<Decimal>,
    fineness: i32,
    active: bool,
}

async fn list_metal_types(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let metals = sqlx::query_as::<_, MetalTypeRow>(
        "SELECT id, name, base_unit, default_hsn, gst_rate, hallmark_applicable, active FROM metal_type ORDER BY id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let purs = sqlx::query_as::<_, PurityMasterRow>(
        "SELECT id, metal_type_id, label, karat, fineness, active FROM purity ORDER BY metal_type_id, id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = metals
        .iter()
        .map(|m| {
            let ps: Vec<Value> = purs
                .iter()
                .filter(|p| p.metal_type_id == m.id)
                .map(|p| {
                    json!({
                        "id": p.id, "label": p.label,
                        "karat": p.karat.map(|d| d.to_string()),
                        "fineness": p.fineness, "active": p.active,
                    })
                })
                .collect();
            json!({
                "id": m.id, "name": m.name, "base_unit": m.base_unit,
                "default_hsn": m.default_hsn, "gst_rate": m.gst_rate.map(|d| d.to_string()),
                "hallmark_applicable": m.hallmark_applicable, "active": m.active,
                "purities": ps,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct NewMetalType {
    name: String,
    base_unit: Option<String>,
    default_hsn: Option<String>,
    gst_rate: Option<Decimal>,
    #[serde(default)]
    hallmark_applicable: bool,
}
async fn create_metal_type(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewMetalType>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    if n.name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "metal name required".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO metal_type (name, base_unit, default_hsn, gst_rate, hallmark_applicable) \
         VALUES ($1, COALESCE($2,'gram'), COALESCE($3,'7113'), COALESCE($4,3.00), $5) RETURNING id",
    )
    .bind(n.name.trim().to_lowercase())
    .bind(n.base_unit.as_deref())
    .bind(n.default_hsn.as_deref())
    .bind(n.gst_rate)
    .bind(n.hallmark_applicable)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct UpdateMetalType {
    default_hsn: Option<String>,
    gst_rate: Option<Decimal>,
    hallmark_applicable: Option<bool>,
    active: Option<bool>,
}
async fn update_metal_type(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(u): Json<UpdateMetalType>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    sqlx::query(
        "UPDATE metal_type SET \
            default_hsn = COALESCE($2, default_hsn), \
            gst_rate = COALESCE($3, gst_rate), \
            hallmark_applicable = COALESCE($4, hallmark_applicable), \
            active = COALESCE($5, active) \
         WHERE id = $1",
    )
    .bind(id)
    .bind(u.default_hsn.as_deref())
    .bind(u.gst_rate)
    .bind(u.hallmark_applicable)
    .bind(u.active)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id, "updated": true })))
}

// ---- Departments (jewellery type: Gold Ornaments / Diamond Ornaments / …) ----
#[derive(sqlx::FromRow)]
struct DeptRow { id: i64, name: String, sort_order: i32, active: bool }
async fn list_departments(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("stock.read")?;
    let rows = sqlx::query_as::<_, DeptRow>(
        "SELECT id, name, sort_order, active FROM department ORDER BY sort_order, name")
        .fetch_all(&s.db).await.map_err(internal)?;
    Ok(Json(json!(rows.iter().map(|r| json!({
        "id": r.id, "name": r.name, "sort_order": r.sort_order, "active": r.active })).collect::<Vec<_>>())))
}
#[derive(Deserialize)]
struct NewDept { name: String, sort_order: Option<i32> }
async fn create_department(State(s): State<AppState>, auth: AuthUser, Json(n): Json<NewDept>) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    if n.name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "department name required".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO department (name, sort_order) VALUES ($1, COALESCE($2,100)) \
         ON CONFLICT (name) DO UPDATE SET sort_order=EXCLUDED.sort_order RETURNING id")
        .bind(n.name.trim()).bind(n.sort_order).fetch_one(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}
#[derive(Deserialize)]
struct UpdDept { name: Option<String>, sort_order: Option<i32>, active: Option<bool> }
async fn update_department(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(u): Json<UpdDept>) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    sqlx::query(
        "UPDATE department SET name=COALESCE($2,name), sort_order=COALESCE($3,sort_order), active=COALESCE($4,active) WHERE id=$1")
        .bind(id).bind(u.name.as_deref()).bind(u.sort_order).bind(u.active)
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "updated": true })))
}

#[derive(Deserialize)]
struct NewPurity {
    metal_type_id: i64,
    label: String,
    karat: Option<Decimal>,
    fineness: i32,
}
async fn create_purity(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewPurity>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    if n.label.trim().is_empty() || n.fineness <= 0 || n.fineness > 1000 {
        return Err((StatusCode::BAD_REQUEST, "label + fineness (1..1000) required".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO purity (metal_type_id, label, karat, fineness) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(n.metal_type_id)
    .bind(n.label.trim())
    .bind(n.karat)
    .bind(n.fineness)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct UpdatePurity {
    label: Option<String>,
    karat: Option<Decimal>,
    fineness: Option<i32>,
    active: Option<bool>,
}
async fn update_purity(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(u): Json<UpdatePurity>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    sqlx::query(
        "UPDATE purity SET label = COALESCE($2,label), karat = COALESCE($3,karat), \
            fineness = COALESCE($4,fineness), active = COALESCE($5,active) WHERE id = $1",
    )
    .bind(id)
    .bind(u.label.as_deref())
    .bind(u.karat)
    .bind(u.fineness)
    .bind(u.active)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id, "updated": true })))
}

// ===================== Materials master — Stones =====================

#[derive(sqlx::FromRow)]
struct StoneTypeRow {
    id: i64,
    name: String,
    category: String,
    unit: String,
    pricing_mode: String,
    default_hsn: Option<String>,
    gst_rate: Option<Decimal>,
    certifiable: bool,
    active: bool,
}
#[derive(sqlx::FromRow)]
struct StoneQualityRow {
    id: i64,
    stone_type_id: i64,
    grade_label: String,
    color: Option<String>,
    clarity: Option<String>,
    size_band: Option<String>,
    rate_per_carat: Decimal,
    active: bool,
}

async fn list_stone_types(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let stones = sqlx::query_as::<_, StoneTypeRow>(
        "SELECT id, name, category, unit, pricing_mode, default_hsn, gst_rate, certifiable, active \
         FROM stone_type ORDER BY id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let quals = sqlx::query_as::<_, StoneQualityRow>(
        "SELECT id, stone_type_id, grade_label, color, clarity, size_band, rate_per_carat, active \
         FROM stone_quality ORDER BY stone_type_id, id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = stones
        .iter()
        .map(|st| {
            let qs: Vec<Value> = quals
                .iter()
                .filter(|q| q.stone_type_id == st.id)
                .map(|q| {
                    json!({
                        "id": q.id, "grade_label": q.grade_label, "color": q.color,
                        "clarity": q.clarity, "size_band": q.size_band,
                        "rate_per_carat": q.rate_per_carat.to_string(), "active": q.active,
                    })
                })
                .collect();
            json!({
                "id": st.id, "name": st.name, "category": st.category, "unit": st.unit,
                "pricing_mode": st.pricing_mode, "default_hsn": st.default_hsn,
                "gst_rate": st.gst_rate.map(|d| d.to_string()),
                "certifiable": st.certifiable, "active": st.active, "qualities": qs,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct NewStoneType {
    name: String,
    category: String,
    unit: Option<String>,
    pricing_mode: Option<String>,
    default_hsn: Option<String>,
    gst_rate: Option<Decimal>,
    #[serde(default)]
    certifiable: bool,
}
async fn create_stone_type(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewStoneType>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    if n.name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "stone name required".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO stone_type (name, category, unit, pricing_mode, default_hsn, gst_rate, certifiable) \
         VALUES ($1, $2, COALESCE($3,'carat'), COALESCE($4,'per_carat_flat'), $5, COALESCE($6,3.00), $7) RETURNING id",
    )
    .bind(n.name.trim())
    .bind(&n.category)
    .bind(n.unit.as_deref())
    .bind(n.pricing_mode.as_deref())
    .bind(n.default_hsn.as_deref())
    .bind(n.gst_rate)
    .bind(n.certifiable)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct UpdateStoneType {
    unit: Option<String>,
    pricing_mode: Option<String>,
    default_hsn: Option<String>,
    gst_rate: Option<Decimal>,
    certifiable: Option<bool>,
    active: Option<bool>,
}
async fn update_stone_type(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(u): Json<UpdateStoneType>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    sqlx::query(
        "UPDATE stone_type SET unit = COALESCE($2,unit), pricing_mode = COALESCE($3,pricing_mode), \
            default_hsn = COALESCE($4,default_hsn), gst_rate = COALESCE($5,gst_rate), \
            certifiable = COALESCE($6,certifiable), active = COALESCE($7,active) WHERE id = $1",
    )
    .bind(id)
    .bind(u.unit.as_deref())
    .bind(u.pricing_mode.as_deref())
    .bind(u.default_hsn.as_deref())
    .bind(u.gst_rate)
    .bind(u.certifiable)
    .bind(u.active)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id, "updated": true })))
}

#[derive(Deserialize)]
struct NewStoneQuality {
    stone_type_id: i64,
    grade_label: String,
    color: Option<String>,
    clarity: Option<String>,
    size_band: Option<String>,
    rate_per_carat: Decimal,
}
async fn create_stone_quality(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewStoneQuality>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    if n.grade_label.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "grade label required".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO stone_quality (stone_type_id, grade_label, color, clarity, size_band, rate_per_carat) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(n.stone_type_id)
    .bind(n.grade_label.trim())
    .bind(n.color.as_deref())
    .bind(n.clarity.as_deref())
    .bind(n.size_band.as_deref())
    .bind(n.rate_per_carat)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct UpdateStoneQuality {
    grade_label: Option<String>,
    color: Option<String>,
    clarity: Option<String>,
    size_band: Option<String>,
    rate_per_carat: Option<Decimal>,
    active: Option<bool>,
}
async fn update_stone_quality(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(u): Json<UpdateStoneQuality>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    sqlx::query(
        "UPDATE stone_quality SET grade_label = COALESCE($2,grade_label), color = COALESCE($3,color), \
            clarity = COALESCE($4,clarity), size_band = COALESCE($5,size_band), \
            rate_per_carat = COALESCE($6,rate_per_carat), active = COALESCE($7,active) WHERE id = $1",
    )
    .bind(id)
    .bind(u.grade_label.as_deref())
    .bind(u.color.as_deref())
    .bind(u.clarity.as_deref())
    .bind(u.size_band.as_deref())
    .bind(u.rate_per_carat)
    .bind(u.active)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id, "updated": true })))
}

// ===================== Resale (second-hand, margin scheme) =====================

#[derive(Deserialize)]
struct NewResaleItem {
    description: String,
    metal_type_id: Option<i64>,
    purity_id: Option<i64>,
    gross_weight: Option<Decimal>,
    net_weight: Option<Decimal>,
    purchase_cost: Decimal,
}
async fn create_resale_item(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewResaleItem>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    if n.description.trim().is_empty() || n.purchase_cost < Decimal::ZERO {
        return Err((StatusCode::BAD_REQUEST, "description + purchase cost required".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO resale_item (branch_id, description, metal_type_id, purity_id, gross_weight, net_weight, purchase_cost) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(n.description.trim())
    .bind(n.metal_type_id)
    .bind(n.purity_id)
    .bind(n.gross_weight)
    .bind(n.net_weight)
    .bind(n.purchase_cost)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

async fn list_resale_items(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, Option<Decimal>, Decimal, String, Option<Decimal>, Option<Decimal>, Option<Decimal>)>(
        "SELECT r.id, r.description, mt.name, p.label, r.gross_weight, r.purchase_cost, r.status, \
            r.sale_price, r.margin, r.gst \
         FROM resale_item r \
         LEFT JOIN metal_type mt ON mt.id = r.metal_type_id \
         LEFT JOIN purity p ON p.id = r.purity_id \
         ORDER BY r.id DESC LIMIT 500",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|(id, desc, metal, purity, gross, cost, status, sale, margin, gst)| {
            json!({
                "id": id, "description": desc, "metal": metal, "purity": purity,
                "gross_weight": gross.map(|d| d.to_string()), "purchase_cost": cost.to_string(),
                "status": status, "sale_price": sale.map(|d| d.to_string()),
                "margin": margin.map(|d| d.to_string()), "gst": gst.map(|d| d.to_string()),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct SellResaleReq {
    sale_price: Decimal,
    gst_rate: Option<Decimal>, // default 0.03
}
async fn sell_resale_item(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(r): Json<SellResaleReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let row: Option<(Decimal, String)> =
        sqlx::query_as("SELECT purchase_cost, status FROM resale_item WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    let (cost, status) = row.ok_or((StatusCode::NOT_FOUND, format!("resale item {id} not found")))?;
    if status != "in_stock" {
        return Err((StatusCode::CONFLICT, "item already sold".to_string()));
    }
    // Margin scheme: GST only on the positive margin (sale − cost).
    let margin = (r.sale_price - cost).max(Decimal::ZERO);
    let rate = r.gst_rate.unwrap_or_else(|| Decimal::new(3, 2));
    let gst = round_money(margin * rate);
    sqlx::query(
        "UPDATE resale_item SET status='sold', sale_price=$2, margin=$3, gst=$4, sold_at=now() WHERE id=$1",
    )
    .bind(id)
    .bind(r.sale_price)
    .bind(margin)
    .bind(gst)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1,'resale',$2,'margin_sale',$3,$4,'resale_item',$2)",
    )
    .bind(s.default_branch)
    .bind(id)
    .bind(json!({"sale_price": r.sale_price.to_string(), "margin": margin.to_string(), "gst": gst.to_string()}))
    .bind(r.sale_price + gst)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "id": id, "sale_price": r.sale_price.to_string(), "margin": margin.to_string(),
        "gst": gst.to_string(), "total": (r.sale_price + gst).to_string(),
    })))
}

// ===================== Loose-stone stock =====================

async fn list_loose_stones(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, Option<String>, Option<String>, Option<Decimal>, Option<i32>, Decimal, Option<String>, Option<String>, String, String, String)>(
        "SELECT ls.id, COALESCE(ls.description, st.name, 'Stone') AS description, st.name, \
            ls.carat, ls.pieces, ls.cost_value, ls.certificate_no, ls.lab, ls.source, ls.status, \
            COALESCE(sq.grade_label, '') AS grade \
         FROM loose_stone ls \
         LEFT JOIN stone_type st ON st.id = ls.stone_type_id \
         LEFT JOIN stone_quality sq ON sq.id = ls.stone_quality_id \
         ORDER BY ls.id DESC LIMIT 500",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|(id, desc, _stname, carat, pieces, cost, cert, lab, source, status, grade)| {
            json!({
                "id": id, "description": desc, "grade": grade,
                "carat": carat.map(|d| d.to_string()), "pieces": pieces,
                "cost_value": cost.to_string(), "certificate_no": cert, "lab": lab,
                "source": source, "status": status,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct NewLooseStone {
    stone_type_id: Option<i64>,
    stone_quality_id: Option<i64>,
    description: Option<String>,
    carat: Option<Decimal>,
    pieces: Option<i32>,
    cost_value: Decimal,
    certificate_no: Option<String>,
    lab: Option<String>,
}
async fn create_loose_stone(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewLooseStone>,
) -> Result<Json<Value>, ApiError> {
    auth.require("stock.manage")?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO loose_stone (branch_id, stone_type_id, stone_quality_id, description, carat, pieces, \
            cost_value, certificate_no, lab, source) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual') RETURNING id",
    )
    .bind(s.default_branch)
    .bind(n.stone_type_id)
    .bind(n.stone_quality_id)
    .bind(n.description.as_deref())
    .bind(n.carat)
    .bind(n.pieces)
    .bind(n.cost_value)
    .bind(n.certificate_no.as_deref())
    .bind(n.lab.as_deref())
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct LooseStoneStatusReq {
    status: String,
}
async fn update_loose_stone(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(r): Json<LooseStoneStatusReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("stock.manage")?;
    if !matches!(r.status.as_str(), "in_stock" | "used" | "sold") {
        return Err((StatusCode::BAD_REQUEST, "invalid status".to_string()));
    }
    sqlx::query("UPDATE loose_stone SET status = $2 WHERE id = $1")
        .bind(id)
        .bind(&r.status)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "id": id, "status": r.status })))
}

// ===================== Item categories (ornament types) =====================

async fn list_item_categories(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, String, bool, i32)>(
        "SELECT id, name, active, sort_order FROM item_category ORDER BY sort_order, name",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|(id, name, active, so)| json!({ "id": id, "name": name, "active": active, "sort_order": so }))
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct NewItemCategory {
    name: String,
    sort_order: Option<i32>,
}
async fn create_item_category(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewItemCategory>,
) -> Result<Json<Value>, ApiError> {
    auth.require("stock.manage")?;
    if n.name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "category name required".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO item_category (name, sort_order) VALUES ($1, COALESCE($2, 100)) RETURNING id",
    )
    .bind(n.name.trim())
    .bind(n.sort_order)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct UpdateItemCategory {
    name: Option<String>,
    active: Option<bool>,
    sort_order: Option<i32>,
}
async fn update_item_category(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(u): Json<UpdateItemCategory>,
) -> Result<Json<Value>, ApiError> {
    auth.require("stock.manage")?;
    sqlx::query(
        "UPDATE item_category SET name = COALESCE($2,name), active = COALESCE($3,active), \
            sort_order = COALESCE($4,sort_order) WHERE id = $1",
    )
    .bind(id)
    .bind(u.name.as_deref())
    .bind(u.active)
    .bind(u.sort_order)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id, "updated": true })))
}

fn cap_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Stock overview: metal summary (gross/stone/net per metal+purity), category breakdown
/// (per metal+category), and loose-stone carat.
async fn report_stock_overview(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let metals = sqlx::query_as::<_, (String, i32, String, String, Decimal, i64, Decimal, Decimal, Decimal, Decimal, bool)>(
        "SELECT dept, dsort, metal, purity, pkarat, count(*), COALESCE(sum(gross),0), COALESCE(sum(stone),0), \
            COALESCE(sum(net),0), COALESCE(sum(dia_ct),0), bool_or(has_dia) FROM ( \
          SELECT COALESCE(d.name, CASE WHEN mt.name='gold' THEN 'Gold Ornaments' ELSE initcap(mt.name)||' Ornaments' END) AS dept, \
            COALESCE(d.sort_order, 999) AS dsort, mt.name AS metal, p.label AS purity, COALESCE(p.karat,0) AS pkarat, \
            i.gross_weight AS gross, i.stone_weight AS stone, i.net_weight AS net, \
            COALESCE((SELECT sum(ist.carat) FROM item_stone ist JOIN stone_type st ON st.id=ist.stone_type_id \
              WHERE ist.item_id=i.id AND st.category='diamond'),0) AS dia_ct, \
            COALESCE((SELECT sum(ist.carat) FROM item_stone ist JOIN stone_type st ON st.id=ist.stone_type_id \
              WHERE ist.item_id=i.id AND st.category='diamond'),0) > 0 AS has_dia \
          FROM item i JOIN metal_type mt ON mt.id=i.metal_type_id JOIN purity p ON p.id=i.purity_id \
            LEFT JOIN department d ON d.id=i.department_id \
          WHERE i.ownership_state='in_stock' \
        ) q GROUP BY dept, dsort, metal, purity, pkarat ORDER BY dsort, pkarat DESC, purity",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let cats = sqlx::query_as::<_, (String, bool, String, i64, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT metal, has_dia, category, count(*), COALESCE(sum(gross),0), COALESCE(sum(net),0), \
            COALESCE(sum(stone),0), COALESCE(sum(dia_ct),0) FROM ( \
          SELECT mt.name AS metal, COALESCE(ic.name,'Uncategorised') AS category, \
            i.gross_weight AS gross, i.net_weight AS net, i.stone_weight AS stone, \
            COALESCE((SELECT sum(ist.carat) FROM item_stone ist JOIN stone_type st ON st.id=ist.stone_type_id \
              WHERE ist.item_id=i.id AND st.category='diamond'),0) AS dia_ct, \
            COALESCE((SELECT sum(ist.carat) FROM item_stone ist JOIN stone_type st ON st.id=ist.stone_type_id \
              WHERE ist.item_id=i.id AND st.category='diamond'),0) > 0 AS has_dia \
          FROM item i JOIN metal_type mt ON mt.id=i.metal_type_id LEFT JOIN item_category ic ON ic.id=i.category_id \
          WHERE i.ownership_state='in_stock' \
        ) q GROUP BY metal, has_dia, category ORDER BY metal, count(*) DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let stones = sqlx::query_as::<_, (String, i64, Decimal, Decimal)>(
        "SELECT COALESCE(st.name,'Stone'), count(*), COALESCE(sum(ls.carat),0), COALESCE(sum(ls.cost_value),0) \
         FROM loose_stone ls LEFT JOIN stone_type st ON st.id=ls.stone_type_id \
         WHERE ls.status='in_stock' GROUP BY st.name ORDER BY st.name",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    // Old / scrap metal on hand (Old Gold / Silver / Platinum) from in-scrap lots.
    let old_metal = sqlx::query_as::<_, (String, bool, i64, Decimal, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT mt.name, (ogl.stone_weight > 0) AS stone_set, count(*), COALESCE(sum(ogl.gross_weight),0), \
            COALESCE(sum(ogl.stone_weight),0), COALESCE(sum(ogl.net_weight),0), \
            COALESCE(sum(ogl.fine_weight),0), COALESCE(sum(ogl.value),0) \
         FROM old_gold_lot ogl JOIN metal_type mt ON mt.id=ogl.metal_type_id \
         WHERE ogl.status='in_scrap' GROUP BY mt.id, mt.name, (ogl.stone_weight > 0) ORDER BY mt.id, stone_set",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    // Old / bought-back stones (Old Diamonds etc.) from loose stock sourced from old gold.
    let old_stones = sqlx::query_as::<_, (String, i64, Decimal, Decimal)>(
        "SELECT COALESCE(st.name,'Stone'), count(*), COALESCE(sum(ls.carat),0), COALESCE(sum(ls.cost_value),0) \
         FROM loose_stone ls LEFT JOIN stone_type st ON st.id=ls.stone_type_id \
         WHERE ls.status='in_stock' AND ls.source='old_gold' GROUP BY st.name ORDER BY st.name",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    // Bulk lots not yet fully tagged, and itemised pieces awaiting tag printing.
    let open_lots = sqlx::query_as::<_, (i64, String, Option<String>, Decimal, i32, Decimal)>(
        "SELECT sl.id, mt.name, p.label, sl.remaining_gross, sl.remaining_pieces, sl.cost_value \
         FROM stock_lot sl JOIN metal_type mt ON mt.id = sl.metal_type_id \
         LEFT JOIN purity p ON p.id = sl.purity_id \
         WHERE sl.status = 'open' ORDER BY sl.id DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let untagged_items: (i64, Decimal) = sqlx::query_as(
        "SELECT count(*), COALESCE(sum(net_weight),0) FROM item \
         WHERE tag_status = 'untagged' AND ownership_state = 'in_stock'",
    )
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({
        "metals": metals.iter().map(|(dept,_ds,m,p,_pk,pc,gr,st,net,dia,has_dia)| json!({
            "department": dept, "metal": m, "purity": p, "has_diamond": has_dia, "pieces": pc,
            "gross": gr.to_string(), "stone": st.to_string(), "net": net.to_string(),
            "diamond_carat": dia.to_string(),
            "label": format!("{dept} {p}"),
        })).collect::<Vec<_>>(),
        "categories": cats.iter().map(|(m,has_dia,c,pc,gr,net,stone,dia)| json!({
            "metal": m, "has_diamond": has_dia, "category": c, "pieces": pc,
            "gross": gr.to_string(), "net": net.to_string(),
            "stone": stone.to_string(), "diamond_carat": dia.to_string(),
        })).collect::<Vec<_>>(),
        "loose_stones": stones.iter().map(|(name,pc,ct,val)| json!({
            "stone": name, "pieces": pc, "carat": ct.to_string(), "value": val.to_string(),
        })).collect::<Vec<_>>(),
        "old_metal": old_metal.iter().map(|(m,stone_set,lots,gr,st,net,fine,val)| json!({
            "metal": m, "stone_set": stone_set, "lots": lots, "gross": gr.to_string(), "stone": st.to_string(),
            "net": net.to_string(), "fine": fine.to_string(), "value": val.to_string(),
            "label": if *stone_set {
                if m == "gold" { "Old Diamond ornaments".to_string() } else { format!("Old {} (stone-set)", cap_first(m)) }
            } else {
                format!("Old {}", cap_first(m))
            },
        })).collect::<Vec<_>>(),
        "old_stones": old_stones.iter().map(|(name,pc,ct,val)| json!({
            "stone": name, "pieces": pc, "carat": ct.to_string(), "value": val.to_string(),
        })).collect::<Vec<_>>(),
        "open_lots": open_lots.iter().map(|(id,metal,purity,rg,rp,cost)| json!({
            "id": id, "metal": metal, "purity": purity,
            "remaining_gross": rg.to_string(), "remaining_pieces": rp, "cost_value": cost.to_string(),
        })).collect::<Vec<_>>(),
        "untagged_items": { "pieces": untagged_items.0, "net": untagged_items.1.to_string() },
    })))
}

// ===================== Reports =====================

/// Consolidated dashboard metrics (today / month / stock / outstanding / trend).
async fn report_dashboard(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let b = s.default_branch;
    // Today (IST) — issued invoices net of credit notes.
    let today: (i64, Decimal, Decimal) = sqlx::query_as(
        "SELECT count(*), COALESCE(sum(grand_total),0), COALESCE(sum(old_gold_value),0) FROM invoice \
         WHERE branch_id=$1 AND status IN ('final','returned') \
           AND created_at AT TIME ZONE 'Asia/Kolkata' >= (now() AT TIME ZONE 'Asia/Kolkata')::date",
    )
    .bind(b).fetch_one(&s.db).await.map_err(internal)?;
    let today_cn: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(total),0) FROM credit_note WHERE branch_id=$1 \
           AND created_at AT TIME ZONE 'Asia/Kolkata' >= (now() AT TIME ZONE 'Asia/Kolkata')::date",
    ).bind(b).fetch_one(&s.db).await.map_err(internal)?;
    // This month.
    let msales: (i64, Decimal) = sqlx::query_as(
        "SELECT count(*), COALESCE(sum(grand_total),0) FROM invoice WHERE branch_id=$1 AND status IN ('final','returned') \
         AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')",
    ).bind(b).fetch_one(&s.db).await.map_err(internal)?;
    let msales_cn: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(total),0) FROM credit_note WHERE branch_id=$1 \
         AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')",
    ).bind(b).fetch_one(&s.db).await.map_err(internal)?;
    let mpurch: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(total),0) FROM purchase_bill WHERE branch_id=$1 AND status='posted' \
         AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')",
    ).bind(b).fetch_one(&s.db).await.map_err(internal)?;
    let mpurch_ret: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(total),0) FROM purchase_return WHERE branch_id=$1 \
         AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')",
    ).bind(b).fetch_one(&s.db).await.map_err(internal)?;
    // GST this month: output = invoices − credit notes; input = B2B purchases − purchase returns.
    let gst_out: Decimal = sqlx::query_scalar(
        "SELECT COALESCE((SELECT sum(tax_total) FROM invoice WHERE branch_id=$1 AND status IN ('final','returned') \
              AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')),0) \
          - COALESCE((SELECT sum(tax_total) FROM credit_note WHERE branch_id=$1 \
              AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')),0)",
    ).bind(b).fetch_one(&s.db).await.map_err(internal)?;
    let gst_in: Decimal = sqlx::query_scalar(
        "SELECT COALESCE((SELECT sum(tax_total) FROM purchase_bill WHERE branch_id=$1 AND bill_kind='b2b' AND status='posted' \
              AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')),0) \
          - COALESCE((SELECT sum(pr.tax_total) FROM purchase_return pr JOIN purchase_bill pb ON pb.id=pr.purchase_bill_id \
              WHERE pr.branch_id=$1 AND pb.bill_kind='b2b' \
              AND to_char(pr.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')),0)",
    ).bind(b).fetch_one(&s.db).await.map_err(internal)?;
    // Stock.
    let stock: (i64, Decimal, Decimal) = sqlx::query_as(
        "SELECT count(*), COALESCE(sum(net_weight),0), COALESCE(sum(cost_value),0) FROM item \
         WHERE branch_id=$1 AND ownership_state='in_stock'",
    ).bind(b).fetch_one(&s.db).await.map_err(internal)?;
    // Outstanding (party ledger).
    let outst: (Decimal, Decimal) = sqlx::query_as(
        "SELECT COALESCE(sum(amount_delta) FILTER (WHERE amount_delta>0),0), \
                COALESCE(-sum(amount_delta) FILTER (WHERE amount_delta<0),0) \
         FROM (SELECT subject_id, sum(amount_delta) AS amount_delta FROM ledger_event \
               WHERE subject_type='party' GROUP BY subject_id) t",
    ).fetch_one(&s.db).await.map_err(internal)?;
    // Collections this month by mode.
    let modes = sqlx::query_as::<_, (Option<String>, Decimal)>(
        "SELECT payment_mode, COALESCE(sum(grand_total),0) FROM invoice WHERE branch_id=$1 \
         AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM') \
         GROUP BY payment_mode ORDER BY 2 DESC",
    ).bind(b).fetch_all(&s.db).await.map_err(internal)?;
    // 6-month sales trend (net of credit notes).
    let trend = sqlx::query_as::<_, (String, Decimal)>(
        "SELECT to_char(d,'YYYY-MM') AS m, \
            COALESCE((SELECT sum(i.grand_total) FROM invoice i WHERE i.branch_id=$1 AND i.status IN ('final','returned') \
                AND to_char(i.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=to_char(d,'YYYY-MM')),0) \
          - COALESCE((SELECT sum(cn.total) FROM credit_note cn WHERE cn.branch_id=$1 \
                AND to_char(cn.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=to_char(d,'YYYY-MM')),0) \
         FROM generate_series(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - interval '5 months', \
                              date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata'), interval '1 month') d \
         ORDER BY d",
    ).bind(b).fetch_all(&s.db).await.map_err(internal)?;
    // In-stock by metal.
    let by_metal = sqlx::query_as::<_, (String, i64, Decimal, Decimal)>(
        "SELECT mt.name, count(*), COALESCE(sum(i.net_weight),0), COALESCE(sum(i.cost_value),0) \
         FROM item i JOIN metal_type mt ON mt.id=i.metal_type_id \
         WHERE i.branch_id=$1 AND i.ownership_state='in_stock' GROUP BY mt.name ORDER BY 4 DESC",
    ).bind(b).fetch_all(&s.db).await.map_err(internal)?;

    Ok(Json(json!({
        "today": { "bills": today.0, "sales": (today.1 - today_cn).to_string(), "old_gold": today.2.to_string() },
        "month": { "bills": msales.0, "sales": (msales.1 - msales_cn).to_string(), "purchases": (mpurch - mpurch_ret).to_string(),
                   "gst_output": gst_out.to_string(), "gst_input": gst_in.to_string(), "gst_net": (gst_out - gst_in).to_string() },
        "stock": { "pieces": stock.0, "net_weight": stock.1.to_string(), "value": stock.2.to_string() },
        "outstanding": { "receivable": outst.0.to_string(), "payable": outst.1.to_string() },
        "collections": modes.iter().map(|(m,v)| json!({ "mode": m.clone().unwrap_or_else(|| "other".into()), "total": v.to_string() })).collect::<Vec<_>>(),
        "trend": trend.iter().map(|(m,v)| json!({ "month": m, "sales": v.to_string() })).collect::<Vec<_>>(),
        "by_metal": by_metal.iter().map(|(m,p,n,v)| json!({ "metal": m, "pieces": p, "net_weight": n.to_string(), "value": v.to_string() })).collect::<Vec<_>>(),
    })))
}


#[derive(Deserialize)]
struct RangeQuery {
    from: String,
    to: String,
}

async fn report_sales_register(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, String, Decimal, Decimal, Decimal, Option<String>)>(
        "SELECT i.document_no, i.created_at::text, COALESCE(c.name, p.display_name, 'Walk-in'), i.type, \
            (i.subtotal - i.discount_total), i.tax_total, i.grand_total, i.payment_mode \
         FROM invoice i LEFT JOIN customer c ON c.id=i.customer_id LEFT JOIN party p ON p.id=i.party_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND i.created_at::date BETWEEN $2::date AND $3::date \
         UNION ALL \
         SELECT cn.document_no, cn.created_at::text, COALESCE(c.name, 'Return'), 'credit_note', \
            -cn.subtotal, -cn.tax_total, -cn.total, cn.refund_mode \
         FROM credit_note cn LEFT JOIN customer c ON c.id=cn.customer_id \
         WHERE cn.branch_id=$1 AND cn.created_at::date BETWEEN $2::date AND $3::date \
         ORDER BY 2",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to)
    .fetch_all(&s.db).await.map_err(internal)?;
    let (mut taxable, mut tax, mut total) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        taxable += r.4; tax += r.5; total += r.6;
        json!({ "document_no": r.0, "date": r.1, "party": r.2, "type": r.3, "taxable": r.4.to_string(), "tax": r.5.to_string(), "total": r.6.to_string(), "payment_mode": r.7 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "taxable": taxable.to_string(), "tax": tax.to_string(), "total": total.to_string() } })))
}

async fn report_purchase_register(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, Decimal, Decimal, Decimal)>(
        "SELECT pb.document_no, pb.created_at::text, COALESCE(p.display_name, s.name, '-'), \
            (pb.subtotal), pb.tax_total, pb.total \
         FROM purchase_bill pb LEFT JOIN party p ON p.id=pb.party_id LEFT JOIN supplier s ON s.id=pb.supplier_id \
         WHERE pb.branch_id=$1 AND pb.status='posted' AND pb.created_at::date BETWEEN $2::date AND $3::date \
         UNION ALL \
         SELECT pr.document_no, pr.created_at::text, COALESCE(p.display_name, 'Return'), \
            -pr.subtotal, -pr.tax_total, -pr.total \
         FROM purchase_return pr LEFT JOIN party p ON p.id=pr.party_id \
         WHERE pr.branch_id=$1 AND pr.created_at::date BETWEEN $2::date AND $3::date \
         ORDER BY 2",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to)
    .fetch_all(&s.db).await.map_err(internal)?;
    let (mut taxable, mut tax, mut total) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        taxable += r.3; tax += r.4; total += r.5;
        json!({ "document_no": r.0, "date": r.1, "party": r.2, "taxable": r.3.to_string(), "tax": r.4.to_string(), "total": r.5.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "taxable": taxable.to_string(), "tax": tax.to_string(), "total": total.to_string() } })))
}

async fn report_stock_valuation(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, Option<String>, i64, Decimal, Decimal)>(
        "SELECT mt.name, pu.label, count(*), COALESCE(sum(i.net_weight),0), COALESCE(sum(i.cost_value),0) \
         FROM item i JOIN metal_type mt ON mt.id=i.metal_type_id LEFT JOIN purity pu ON pu.id=i.purity_id \
         WHERE i.branch_id=$1 AND i.ownership_state='in_stock' GROUP BY mt.name, pu.label ORDER BY mt.name, pu.label",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut pcs, mut net, mut val) = (0i64, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        pcs += r.2; net += r.3; val += r.4;
        json!({ "metal": r.0, "purity": r.1, "pieces": r.2, "net_weight": r.3.to_string(), "value": r.4.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "pieces": pcs, "net_weight": net.to_string(), "value": val.to_string() } })))
}

async fn report_gst_summary(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    // OUTPUT: issued tax invoices (final + returned) minus credit notes (sales returns).
    let inv: (Decimal, Decimal) = sqlx::query_as(
        "SELECT COALESCE(sum(subtotal - discount_total),0), COALESCE(sum(tax_total),0) FROM invoice \
         WHERE branch_id=$1 AND status IN ('final','returned') AND created_at::date BETWEEN $2::date AND $3::date",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_one(&s.db).await.map_err(internal)?;
    let cn: (Decimal, Decimal) = sqlx::query_as(
        "SELECT COALESCE(sum(subtotal),0), COALESCE(sum(tax_total),0) FROM credit_note \
         WHERE branch_id=$1 AND created_at::date BETWEEN $2::date AND $3::date",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_one(&s.db).await.map_err(internal)?;
    // INPUT (ITC): B2B purchase bills minus purchase returns (debit notes) on B2B bills.
    let pur: (Decimal, Decimal) = sqlx::query_as(
        "SELECT COALESCE(sum(subtotal),0), COALESCE(sum(tax_total),0) FROM purchase_bill \
         WHERE branch_id=$1 AND bill_kind='b2b' AND status='posted' AND created_at::date BETWEEN $2::date AND $3::date",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_one(&s.db).await.map_err(internal)?;
    let pr: (Decimal, Decimal) = sqlx::query_as(
        "SELECT COALESCE(sum(pr.subtotal),0), COALESCE(sum(pr.tax_total),0) FROM purchase_return pr \
         JOIN purchase_bill pb ON pb.id=pr.purchase_bill_id \
         WHERE pr.branch_id=$1 AND pb.bill_kind='b2b' AND pr.created_at::date BETWEEN $2::date AND $3::date",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_one(&s.db).await.map_err(internal)?;
    let output_taxable = inv.0 - cn.0;
    let output_tax = inv.1 - cn.1;
    let input_taxable = pur.0 - pr.0;
    let input_tax = pur.1 - pr.1;
    Ok(Json(json!({
        "output_taxable": output_taxable.to_string(), "output_tax": output_tax.to_string(),
        "input_taxable": input_taxable.to_string(), "input_tax": input_tax.to_string(),
        "net_payable": (output_tax - input_tax).to_string(),
    })))
}

async fn report_outstanding(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, Decimal, Decimal)>(
        "SELECT p.id, p.display_name, \
            COALESCE(sum(le.amount_delta),0), COALESCE(sum(le.weight_delta),0) \
         FROM party p JOIN ledger_event le ON le.subject_type='party' AND le.subject_id=p.id \
         GROUP BY p.id, p.display_name \
         HAVING COALESCE(sum(le.amount_delta),0) <> 0 OR COALESCE(sum(le.weight_delta),0) <> 0 \
         ORDER BY COALESCE(sum(le.amount_delta),0) DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut recv, mut pay) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        if r.2 > Decimal::ZERO { recv += r.2; } else { pay += r.2; }
        json!({ "party_id": r.0, "party": r.1, "cash_balance": r.2.to_string(), "metal_balance": r.3.to_string(),
                "side": if r.2 > Decimal::ZERO { "receivable" } else if r.2 < Decimal::ZERO { "payable" } else { "settled" } })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "receivable": recv.to_string(), "payable": pay.abs().to_string() } })))
}

#[derive(Deserialize)]
struct DayQuery {
    day: String,
}

async fn report_day_book(State(s): State<AppState>, auth: AuthUser, Query(q): Query<DayQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, String, String, Decimal, Decimal, Option<String>, Option<i64>)>(
        "SELECT le.occurred_at::text, le.subject_type, le.event_type, COALESCE(le.amount_delta,0), COALESCE(le.weight_delta,0), le.ref_doc_type, le.ref_doc_id \
         FROM ledger_event le WHERE le.branch_id=$1 AND le.occurred_at::date = $2::date ORDER BY le.occurred_at",
    )
    .bind(s.default_branch).bind(&q.day).fetch_all(&s.db).await.map_err(internal)?;
    let items: Vec<Value> = rows.iter().map(|r| json!({
        "at": r.0, "subject": r.1, "event": r.2, "amount_delta": r.3.to_string(), "weight_delta": r.4.to_string(),
        "ref_doc_type": r.5, "ref_doc_id": r.6,
    })).collect();
    Ok(Json(json!({ "rows": items })))
}

/// Stock ageing — in-stock items bucketed by days held (dead/slow-moving), + a slow-mover list.
async fn report_stock_ageing(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let buckets = sqlx::query_as::<_, (String, i64, Decimal, Decimal)>(
        "SELECT CASE WHEN age<=90 THEN '0-90 days' WHEN age<=180 THEN '91-180 days' \
                     WHEN age<=365 THEN '181-365 days' ELSE 'over 1 year' END AS bucket, \
             count(*), COALESCE(sum(net_weight),0), COALESCE(sum(cost_value),0) \
         FROM (SELECT net_weight, cost_value, (CURRENT_DATE - created_at::date) AS age \
               FROM item WHERE branch_id=$1 AND ownership_state='in_stock') t \
         GROUP BY bucket ORDER BY min(age)",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let slow = sqlx::query_as::<_, (String, Option<String>, i64, Decimal, Decimal, String)>(
        "SELECT i.sku, pu.label, (CURRENT_DATE - i.created_at::date), i.net_weight, i.cost_value, i.created_at::date::text \
         FROM item i LEFT JOIN purity pu ON pu.id=i.purity_id \
         WHERE i.branch_id=$1 AND i.ownership_state='in_stock' AND (CURRENT_DATE - i.created_at::date) > 180 \
         ORDER BY i.created_at LIMIT 200",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    Ok(Json(json!({
        "buckets": buckets.iter().map(|b| json!({ "bucket": b.0, "pieces": b.1, "net_weight": b.2.to_string(), "value": b.3.to_string() })).collect::<Vec<_>>(),
        "slow_movers": slow.iter().map(|r| json!({ "sku": r.0, "purity": r.1, "days": r.2, "net_weight": r.3.to_string(), "value": r.4.to_string(), "received": r.5 })).collect::<Vec<_>>(),
    })))
}

/// Sales by purity — net (non-returned) invoice lines grouped by purity label.
async fn report_sales_by_purity(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, i64, Decimal, Decimal, Decimal)>(
        "SELECT il.purity_label, count(*), COALESCE(sum(il.net_weight),0), COALESCE(sum(il.taxable_value),0), \
            COALESCE(sum((il.breakdown_json->>'tax_total')::numeric),0) \
         FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND il.returned=false \
           AND i.created_at::date BETWEEN $2::date AND $3::date \
         GROUP BY il.purity_label ORDER BY 4 DESC",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut net, mut taxable, mut tax) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        net += r.2; taxable += r.3; tax += r.4;
        json!({ "purity": r.0, "pieces": r.1, "net_weight": r.2.to_string(), "taxable": r.3.to_string(), "tax": r.4.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "net_weight": net.to_string(), "taxable": taxable.to_string(), "tax": tax.to_string() } })))
}

/// Scheme dues — active schemes with installments paid vs required and amount due.
async fn report_scheme_dues(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, Option<String>, String, Decimal, i32, i64, Decimal)>(
        "SELECT s.scheme_no, c.name, s.scheme_type, s.monthly_amount, s.installments_required, \
            (SELECT count(*) FROM scheme_installment si WHERE si.scheme_id=s.id), s.total_paid \
         FROM scheme s LEFT JOIN customer c ON c.id=s.customer_id \
         WHERE s.branch_id=$1 AND s.status='active' ORDER BY s.scheme_no",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let mut due_total = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        let remaining = (r.4 as i64 - r.5).max(0);
        let due = if remaining > 0 { r.3 } else { Decimal::ZERO };
        due_total += due;
        json!({ "scheme_no": r.0, "customer": r.1, "type": r.2, "monthly": r.3.to_string(),
                "required": r.4, "paid_count": r.5, "remaining": remaining, "amount_due_now": due.to_string(), "total_paid": r.6.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "amount_due_now": due_total.to_string() } })))
}

/// Advance dues — active customer advances with an outstanding balance.
async fn report_advance_dues(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, Option<String>, String, Decimal, Decimal, Option<String>)>(
        "SELECT ca.advance_no, c.name, ca.advance_type, ca.amount, ca.balance, ca.due_date::text \
         FROM customer_advance ca LEFT JOIN customer c ON c.id=ca.customer_id \
         WHERE ca.branch_id=$1 AND ca.status='active' AND ca.balance > 0 ORDER BY ca.due_date NULLS LAST",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let mut bal = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        bal += r.4;
        json!({ "advance_no": r.0, "customer": r.1, "type": r.2, "amount": r.3.to_string(), "balance": r.4.to_string(), "due_date": r.5 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "balance": bal.to_string() } })))
}

/// Gross profit on cost-tracked (item-linked) sales. Transparent coverage: loose/manual lines
/// without a recorded cost are reported separately, never silently assumed zero-cost.
async fn report_gross_profit(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let total_rev: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(il.taxable_value),0) FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND il.returned=false \
           AND i.created_at::date BETWEEN $2::date AND $3::date",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_one(&s.db).await.map_err(internal)?;
    let costed: (Decimal, Decimal, i64) = sqlx::query_as(
        "SELECT COALESCE(sum(il.taxable_value),0), COALESCE(sum(it.cost_value),0), count(*) \
         FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id JOIN item it ON it.id=il.item_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND il.returned=false \
           AND it.cost_value > 0 AND i.created_at::date BETWEEN $2::date AND $3::date",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_one(&s.db).await.map_err(internal)?;
    let lines = sqlx::query_as::<_, (Option<String>, String, Decimal, Decimal)>(
        "SELECT i.document_no, it.sku, il.taxable_value, it.cost_value \
         FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id JOIN item it ON it.id=il.item_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND il.returned=false \
           AND it.cost_value > 0 AND i.created_at::date BETWEEN $2::date AND $3::date ORDER BY (il.taxable_value - it.cost_value) DESC LIMIT 200",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (costed_rev, cogs) = (costed.0, costed.1);
    let profit = costed_rev - cogs;
    let margin = if costed_rev > Decimal::ZERO { (profit / costed_rev * Decimal::from(100)).round_dp(2) } else { Decimal::ZERO };
    let coverage = if total_rev > Decimal::ZERO { (costed_rev / total_rev * Decimal::from(100)).round_dp(1) } else { Decimal::ZERO };
    Ok(Json(json!({
        "total_revenue": total_rev.to_string(),
        "costed_revenue": costed_rev.to_string(),
        "cogs": cogs.to_string(),
        "gross_profit": profit.to_string(),
        "margin_pct": margin.to_string(),
        "coverage_pct": coverage.to_string(),
        "uncosted_revenue": (total_rev - costed_rev).to_string(),
        "costed_lines": costed.2,
        "rows": lines.iter().map(|r| json!({ "document_no": r.0, "sku": r.1, "revenue": r.2.to_string(), "cost": r.3.to_string(), "profit": (r.2 - r.3).to_string() })).collect::<Vec<_>>(),
    })))
}

/// Stock revaluation — metal value of in-stock items at the current rate vs book cost.
async fn report_stock_revaluation(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, Option<String>, i64, Decimal, Decimal, Decimal)>(
        "SELECT mt.name, pu.label, count(*), COALESCE(sum(i.net_weight),0), COALESCE(sum(i.cost_value),0), \
            COALESCE(sum(i.net_weight * COALESCE(r.buy_rate,0)),0) \
         FROM item i JOIN metal_type mt ON mt.id=i.metal_type_id LEFT JOIN purity pu ON pu.id=i.purity_id \
         LEFT JOIN LATERAL (SELECT buy_rate FROM metal_rate mr WHERE mr.purity_id=i.purity_id ORDER BY effective_from DESC LIMIT 1) r ON true \
         WHERE i.branch_id=$1 AND i.ownership_state='in_stock' GROUP BY mt.name, pu.label ORDER BY mt.name, pu.label",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut cost, mut market) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        cost += r.4; market += r.5;
        json!({ "metal": r.0, "purity": r.1, "pieces": r.2, "net_weight": r.3.to_string(),
                "cost": r.4.to_string(), "market_metal_value": r.5.to_string(), "gain_loss": (r.5 - r.4).to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "cost": cost.to_string(), "market_metal_value": market.to_string(), "gain_loss": (market - cost).to_string() } })))
}

/// Karigar (smith) ledger — metal with each smith (issued − returned) and making balance (payable − paid).
async fn report_karigar(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT sm.name, \
            COALESCE(sum(le.weight_delta) FILTER (WHERE le.event_type='metal_issued'),0), \
            COALESCE(-sum(le.weight_delta) FILTER (WHERE le.event_type='metal_returned'),0), \
            COALESCE(sum(le.weight_delta),0), \
            COALESCE(sum(le.amount_delta),0) \
         FROM smith sm LEFT JOIN ledger_event le ON le.subject_type='smith' AND le.subject_id=sm.id \
         WHERE sm.branch_id=$1 GROUP BY sm.name ORDER BY sm.name",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut metal, mut making) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        metal += r.3; making += r.4;
        json!({ "smith": r.0, "metal_issued": r.1.to_string(), "metal_returned": r.2.to_string(),
                "metal_with_smith": r.3.to_string(), "making_balance": r.4.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "metal_with_smith": metal.to_string(), "making_balance": making.to_string() } })))
}

// ---- Phase 1 registers ----

async fn report_sales_returns(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, Option<String>, Option<String>, Decimal, Decimal, Decimal, Decimal, Decimal, Option<String>)>(
        "SELECT cn.document_no, cn.created_at::text, COALESCE(c.name,'-'), i.document_no, cn.reason, \
            cn.subtotal, cn.tax_total, cn.total, COALESCE(cn.deduction,0), COALESCE(cn.net_refund, cn.total), cn.refund_mode \
         FROM credit_note cn LEFT JOIN customer c ON c.id=cn.customer_id \
         LEFT JOIN invoice i ON i.id=cn.original_invoice_id \
         WHERE cn.branch_id=$1 AND cn.created_at::date BETWEEN $2::date AND $3::date ORDER BY cn.created_at",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut total, mut refund) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        total += r.7; refund += r.9;
        json!({ "document_no": r.0, "date": r.1, "customer": r.2, "original_invoice": r.3, "reason": r.4,
                "taxable": r.5.to_string(), "tax": r.6.to_string(), "total": r.7.to_string(),
                "deduction": r.8.to_string(), "net_refund": r.9.to_string(), "refund_mode": r.10 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "total": total.to_string(), "net_refund": refund.to_string() } })))
}

async fn report_advance_register(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, Option<String>, Option<String>, Decimal, Decimal, Decimal, Decimal, Decimal, Option<String>, Option<String>)>(
        "SELECT ca.advance_no, ca.created_at::text, COALESCE(c.name,'-'), ca.advance_type, ca.status, \
            COALESCE(ca.amount,0), COALESCE(ca.balance,0), COALESCE(ca.booked_weight,0), COALESCE(ca.rate_locked,0), \
            COALESCE(ca.percent,0), ca.due_date::text, ca.payment_mode \
         FROM customer_advance ca LEFT JOIN customer c ON c.id=ca.customer_id \
         WHERE ca.branch_id=$1 ORDER BY ca.created_at DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut amount, mut balance) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        amount += r.5; balance += r.6;
        json!({ "advance_no": r.0, "date": r.1, "customer": r.2, "type": r.3, "status": r.4,
                "amount": r.5.to_string(), "balance": r.6.to_string(), "booked_g": r.7.to_string(),
                "locked_rate": r.8.to_string(), "percent": r.9.to_string(), "due_date": r.10, "mode": r.11 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "amount": amount.to_string(), "balance": balance.to_string() } })))
}

async fn report_barcode_stock(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, String, Option<String>, Option<String>, Decimal, Decimal, Decimal, Option<String>, Decimal, String, Option<String>)>(
        "SELECT i.sku, mt.name, pu.label, ic.name, COALESCE(i.gross_weight,0), COALESCE(i.net_weight,0), \
            COALESCE(i.stone_weight,0), i.huid, COALESCE(i.cost_value,0), i.created_at::text, i.tag_status \
         FROM item i JOIN metal_type mt ON mt.id=i.metal_type_id \
         LEFT JOIN purity pu ON pu.id=i.purity_id LEFT JOIN item_category ic ON ic.id=i.category_id \
         WHERE i.branch_id=$1 AND i.ownership_state='in_stock' ORDER BY i.sku",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut pcs, mut net, mut val) = (0i64, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        pcs += 1; net += r.5; val += r.8;
        json!({ "sku": r.0, "metal": r.1, "purity": r.2, "category": r.3, "gross": r.4.to_string(),
                "net": r.5.to_string(), "stone": r.6.to_string(), "huid": r.7, "cost_value": r.8.to_string(),
                "received": r.9, "tag_status": r.10 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "sku": format!("{} pcs", pcs), "net": net.to_string(), "cost_value": val.to_string() } })))
}

async fn report_old_gold_intake(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, String, Option<String>, String, String, Option<String>, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Option<String>, Decimal, Decimal)>(
        "SELECT ogl.created_at::text, COALESCE(c.name,'-'), i.document_no, COALESCE(d.name,'-'), mt.name, pu.label, \
            COALESCE(ogl.gross_weight,0), COALESCE(ogl.stone_weight,0), COALESCE(ogl.net_weight,0), COALESCE(ogl.fine_weight,0), \
            COALESCE(ogl.deduction_percent,0), COALESCE(ogl.rate,0), COALESCE(ogl.value,0), ogl.status, \
            COALESCE((SELECT sum(carat) FROM old_gold_stone WHERE old_gold_lot_id=ogl.id),0), \
            COALESCE((SELECT sum(value) FROM old_gold_stone WHERE old_gold_lot_id=ogl.id AND action='bought'),0) \
         FROM old_gold_lot ogl LEFT JOIN customer c ON c.id=ogl.customer_id LEFT JOIN invoice i ON i.id=ogl.invoice_id \
         JOIN metal_type mt ON mt.id=ogl.metal_type_id LEFT JOIN purity pu ON pu.id=ogl.purity_id \
         LEFT JOIN department d ON d.id=ogl.department_id \
         WHERE ogl.branch_id=$1 AND ogl.created_at::date BETWEEN $2::date AND $3::date ORDER BY ogl.created_at",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut gross, mut net, mut fine, mut val, mut dia_ct, mut dia_val) =
        (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        gross += r.6; net += r.8; fine += r.9; val += r.12; dia_ct += r.14; dia_val += r.15;
        json!({ "date": r.0, "customer": r.1, "invoice": r.2, "type": r.3, "metal": r.4, "purity": r.5, "gross": r.6.to_string(),
                "stone": r.7.to_string(), "net": r.8.to_string(), "fine": r.9.to_string(), "deduction_pct": r.10.to_string(),
                "rate": r.11.to_string(), "dia_ct": r.14.to_string(), "dia_bought": r.15.to_string(), "value": r.12.to_string(), "status": r.13 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "gross": gross.to_string(), "net": net.to_string(), "fine": fine.to_string(), "dia_ct": dia_ct.to_string(), "dia_bought": dia_val.to_string(), "value": val.to_string() } })))
}

async fn report_rate_cut_register(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, Option<String>, Decimal, Decimal, Decimal, Option<String>)>(
        "SELECT rc.document_no, rc.created_at::text, COALESCE(p.display_name,'-'), rc.direction, \
            COALESCE(rc.grams,0), COALESCE(rc.rate,0), COALESCE(rc.amount,0), rc.note \
         FROM rate_cut rc LEFT JOIN party p ON p.id=rc.party_id \
         WHERE rc.branch_id=$1 AND rc.created_at::date BETWEEN $2::date AND $3::date ORDER BY rc.created_at",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut grams, mut amount) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        grams += r.4; amount += r.6;
        json!({ "document_no": r.0, "date": r.1, "party": r.2, "direction": r.3,
                "grams": r.4.to_string(), "rate": r.5.to_string(), "amount": r.6.to_string(), "note": r.7 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "grams": grams.to_string(), "amount": amount.to_string() } })))
}

async fn report_job_work(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, Option<String>, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Option<String>, Option<String>)>(
        "SELECT sj.id, sm.name, mt.name, sj.status, sj.source, \
            COALESCE(sj.issued_gross_weight,0), COALESCE(sj.issued_fine_weight,0), COALESCE(sj.received_gross,0), \
            COALESCE(sj.received_fine,0), COALESCE(sj.wastage_weight,0), COALESCE(sj.making_charge,0), \
            sj.issued_at::text, sj.received_at::text \
         FROM smith_job sj JOIN smith sm ON sm.id=sj.smith_id JOIN metal_type mt ON mt.id=sj.metal_type_id \
         WHERE sj.branch_id=$1 ORDER BY sj.issued_at DESC NULLS LAST",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut issued, mut received, mut making) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        issued += r.6; received += r.8; making += r.10;
        json!({ "job_id": r.0, "smith": r.1, "metal": r.2, "status": r.3, "source": r.4,
                "issued_gross": r.5.to_string(), "issued_fine": r.6.to_string(), "received_gross": r.7.to_string(),
                "received_fine": r.8.to_string(), "wastage": r.9.to_string(), "making_charge": r.10.to_string(),
                "issued": r.11, "received": r.12 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "issued_fine": issued.to_string(), "received_fine": received.to_string(), "making_charge": making.to_string() } })))
}

async fn report_leave_register(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, String, String, Decimal, bool, Option<String>, Option<String>)>(
        "SELECT lr.applied_at::text, st.name, lt.name, lr.from_day::text, lr.to_day::text, \
            COALESCE(lr.days,0), COALESCE(lr.half_day,false), lr.status, lr.reason \
         FROM leave_request lr JOIN staff st ON st.id=lr.staff_id JOIN leave_type lt ON lt.id=lr.leave_type_id \
         WHERE st.branch_id=$1 ORDER BY lr.from_day DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let mut days = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        days += r.5;
        json!({ "applied": r.0, "staff": r.1, "leave_type": r.2, "from": r.3, "to": r.4,
                "days": r.5.to_string(), "half_day": if r.6 { "Yes" } else { "No" }, "status": r.7, "reason": r.8 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "days": days.to_string() } })))
}

async fn report_salary_advances(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, String, Decimal, Decimal, Decimal, Option<String>, Option<String>)>(
        "SELECT sa.created_at::text, st.name, COALESCE(sa.amount,0), COALESCE(sa.recovery_per_month,0), \
            COALESCE(sa.outstanding,0), sa.status, sa.note \
         FROM staff_advance sa JOIN staff st ON st.id=sa.staff_id \
         WHERE sa.branch_id=$1 ORDER BY sa.created_at DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut amount, mut outstanding) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        amount += r.2; outstanding += r.4;
        json!({ "date": r.0, "staff": r.1, "amount": r.2.to_string(), "recovery": r.3.to_string(),
                "outstanding": r.4.to_string(), "status": r.5, "note": r.6 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "amount": amount.to_string(), "outstanding": outstanding.to_string() } })))
}

async fn report_cheque_status(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, Option<String>, Decimal, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, Option<String>)>(
        "SELECT ch.cheque_no, ch.bank, COALESCE(ch.amount,0), ch.status, ch.received_at::text, ch.deposited_at::text, \
            ch.cleared_at::text, ch.bounced_at::text, COALESCE(c.name,'-'), i.document_no \
         FROM cheque ch LEFT JOIN customer c ON c.id=ch.customer_id LEFT JOIN invoice i ON i.id=ch.invoice_id \
         WHERE ch.branch_id=$1 ORDER BY ch.created_at DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let mut amount = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        amount += r.2;
        json!({ "cheque_no": r.0, "bank": r.1, "amount": r.2.to_string(), "status": r.3, "received": r.4,
                "deposited": r.5, "cleared": r.6, "bounced": r.7, "customer": r.8, "invoice": r.9 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "amount": amount.to_string() } })))
}

// ---- Phase 2 registers ----

async fn report_estimates(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, Option<String>, Option<String>, Option<String>, Decimal, Decimal, Decimal, Option<String>)>(
        "SELECT e.document_no, e.created_at::text, COALESCE(c.name,'-'), e.type, e.status, e.valid_on::text, \
            (e.subtotal - e.discount_total), e.tax_total, e.grand_total, ci.document_no \
         FROM estimate e LEFT JOIN customer c ON c.id=e.customer_id LEFT JOIN invoice ci ON ci.id=e.converted_invoice_id \
         WHERE e.branch_id=$1 AND e.created_at::date BETWEEN $2::date AND $3::date ORDER BY e.created_at DESC",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let mut total = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        total += r.8;
        json!({ "document_no": r.0, "date": r.1, "customer": r.2, "type": r.3, "status": r.4, "valid_on": r.5,
                "taxable": r.6.to_string(), "tax": r.7.to_string(), "total": r.8.to_string(), "converted_to": r.9 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "total": total.to_string() } })))
}

async fn report_approval_outstanding(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, Option<String>, Option<String>, String, Option<String>, Option<String>, Decimal, Decimal)>(
        "SELECT 'approval', ao.slip_no, ao.out_at::text, COALESCE(c.name,'-'), it.sku, ao.due_back_at::text, \
            COALESCE(it.net_weight,0), COALESCE(it.cost_value,0) \
         FROM approval_out ao LEFT JOIN customer c ON c.id=ao.customer_id LEFT JOIN item it ON it.id=ao.item_id \
         WHERE ao.branch_id=$1 AND ao.status='out' \
         UNION ALL \
         SELECT 'sale_or_return', sor.doc_no, sor.out_at::text, COALESCE(c.name,'-'), it.sku, sor.due_back_at::text, \
            COALESCE(it.net_weight,0), COALESCE(it.cost_value,0) \
         FROM sale_or_return_out sor LEFT JOIN customer c ON c.id=sor.customer_id LEFT JOIN item it ON it.id=sor.item_id \
         WHERE sor.branch_id=$1 AND sor.status='out' ORDER BY 3",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let mut cost = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        cost += r.7;
        json!({ "kind": r.0, "ref_no": r.1, "out_on": r.2, "customer": r.3, "sku": r.4, "due_back": r.5,
                "net_weight": r.6.to_string(), "cost_value": r.7.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "cost_value": cost.to_string() } })))
}

async fn report_scheme_enrollment(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, Option<String>, Option<String>, Option<String>, Decimal, i32, Decimal, Decimal, Decimal)>(
        "SELECT s.scheme_no, s.created_at::text, COALESCE(c.name,'-'), s.scheme_type, s.status, s.start_date::text, \
            COALESCE(s.monthly_amount,0), COALESCE(s.installments_required,0), COALESCE(s.total_paid,0), \
            COALESCE(s.total_grams,0), COALESCE(s.maturity_value,0) \
         FROM scheme s LEFT JOIN customer c ON c.id=s.customer_id WHERE s.branch_id=$1 ORDER BY s.created_at DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let mut paid = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        paid += r.8;
        json!({ "scheme_no": r.0, "date": r.1, "customer": r.2, "type": r.3, "status": r.4, "start_date": r.5,
                "monthly": r.6.to_string(), "installments": r.7, "total_paid": r.8.to_string(),
                "grams": r.9.to_string(), "maturity_value": r.10.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "total_paid": paid.to_string() } })))
}

async fn report_scheme_collections(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, Option<String>, String, i32, Decimal, Option<String>, Decimal, Decimal, Option<String>)>(
        "SELECT si.paid_at::text, s.scheme_no, COALESCE(c.name,'-'), si.seq, COALESCE(si.amount,0), si.payment_mode, \
            COALESCE(si.rate_used,0), COALESCE(si.grams,0), si.reference \
         FROM scheme_installment si JOIN scheme s ON s.id=si.scheme_id LEFT JOIN customer c ON c.id=s.customer_id \
         WHERE s.branch_id=$1 AND si.paid_at::date BETWEEN $2::date AND $3::date ORDER BY si.paid_at DESC",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let mut amount = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        amount += r.4;
        json!({ "date": r.0, "scheme_no": r.1, "customer": r.2, "seq": r.3, "amount": r.4.to_string(),
                "mode": r.5, "rate": r.6.to_string(), "grams": r.7.to_string(), "reference": r.8 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "amount": amount.to_string() } })))
}

async fn report_scheme_maturity(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, Option<String>, Option<String>, Option<String>, Option<String>, Decimal, Decimal)>(
        "SELECT s.scheme_no, COALESCE(c.name,'-'), s.scheme_type, s.status, s.matured_at::text, s.closed_at::text, \
            COALESCE(s.total_paid,0), COALESCE(s.maturity_value,0) \
         FROM scheme s LEFT JOIN customer c ON c.id=s.customer_id \
         WHERE s.branch_id=$1 AND (s.matured_at IS NOT NULL OR s.closed_at IS NOT NULL) \
         ORDER BY COALESCE(s.closed_at, s.matured_at) DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let mut mv = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        mv += r.7;
        json!({ "scheme_no": r.0, "customer": r.1, "type": r.2, "status": r.3, "matured_at": r.4, "closed_at": r.5,
                "total_paid": r.6.to_string(), "maturity_value": r.7.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "maturity_value": mv.to_string() } })))
}

async fn report_party_metal(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, Decimal)>(
        "SELECT p.id, p.display_name, COALESCE(sum(le.weight_delta),0) \
         FROM party p JOIN ledger_event le ON le.subject_type='party' AND le.subject_id=p.id \
         GROUP BY p.id, p.display_name HAVING COALESCE(sum(le.weight_delta),0) <> 0 \
         ORDER BY COALESCE(sum(le.weight_delta),0) DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let mut net = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        net += r.2;
        json!({ "party_id": r.0, "party": r.1, "metal_g": r.2.to_string(),
                "side": if r.2 > Decimal::ZERO { "party owes us" } else { "we owe party" } })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "metal_g": net.to_string() } })))
}

async fn report_top_customers(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, i64, Decimal)>(
        "SELECT COALESCE(c.name, p.display_name, 'Walk-in'), count(*), COALESCE(sum(i.grand_total),0) \
         FROM invoice i LEFT JOIN customer c ON c.id=i.customer_id LEFT JOIN party p ON p.id=i.party_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND i.created_at::date BETWEEN $2::date AND $3::date \
         GROUP BY COALESCE(c.name, p.display_name, 'Walk-in') ORDER BY sum(i.grand_total) DESC LIMIT 50",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let mut sales = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        sales += r.2;
        json!({ "customer": r.0, "bills": r.1, "sales": r.2.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "sales": sales.to_string() } })))
}

async fn report_supplier_purchases(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, i64, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT COALESCE(p.display_name, su.name, '-'), count(*), \
            COALESCE(sum(pb.subtotal),0), COALESCE(sum(pb.tax_total),0), \
            COALESCE(sum(pb.total),0), COALESCE(sum(pb.total_fine),0) \
         FROM purchase_bill pb LEFT JOIN party p ON p.id=pb.party_id LEFT JOIN supplier su ON su.id=pb.supplier_id \
         WHERE pb.branch_id=$1 AND pb.status='posted' AND pb.created_at::date BETWEEN $2::date AND $3::date \
         GROUP BY COALESCE(p.display_name, su.name, '-') ORDER BY sum(pb.total) DESC",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut taxable, mut tax, mut total) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        taxable += r.2; tax += r.3; total += r.4;
        json!({ "supplier": r.0, "bills": r.1, "taxable": r.2.to_string(), "tax": r.3.to_string(),
                "total": r.4.to_string(), "fine_g": r.5.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "taxable": taxable.to_string(), "tax": tax.to_string(), "total": total.to_string() } })))
}

async fn report_purchase_returns(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, Option<String>, Decimal, Decimal, Decimal, Option<String>, Option<String>)>(
        "SELECT pr.document_no, pr.created_at::text, COALESCE(p.display_name,'-'), pb.document_no, \
            pr.subtotal, pr.tax_total, pr.total, pr.refund_mode, pr.note \
         FROM purchase_return pr LEFT JOIN party p ON p.id=pr.party_id LEFT JOIN purchase_bill pb ON pb.id=pr.purchase_bill_id \
         WHERE pr.branch_id=$1 AND pr.created_at::date BETWEEN $2::date AND $3::date ORDER BY pr.created_at DESC",
    )
    .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let mut total = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        total += r.6;
        json!({ "document_no": r.0, "date": r.1, "party": r.2, "against_bill": r.3, "taxable": r.4.to_string(),
                "tax": r.5.to_string(), "total": r.6.to_string(), "refund_mode": r.7, "note": r.8 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "total": total.to_string() } })))
}

async fn report_loose_stone_valuation(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, Decimal, i32, Decimal, Option<String>, Option<String>, Option<String>)>(
        "SELECT ls.description, st.name, sq.grade_label, COALESCE(ls.carat,0), COALESCE(ls.pieces,0), \
            COALESCE(ls.cost_value,0), ls.certificate_no, ls.lab, ls.source \
         FROM loose_stone ls LEFT JOIN stone_type st ON st.id=ls.stone_type_id \
         LEFT JOIN stone_quality sq ON sq.id=ls.stone_quality_id \
         WHERE ls.branch_id=$1 AND ls.status='in_stock' ORDER BY st.name NULLS LAST",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut pcs, mut val) = (0i64, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        pcs += r.4 as i64; val += r.5;
        json!({ "description": r.0, "stone": r.1, "grade": r.2, "carat": r.3.to_string(), "pieces": r.4,
                "cost_value": r.5.to_string(), "certificate": r.6, "lab": r.7, "source": r.8 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "pieces": pcs, "cost_value": val.to_string() } })))
}

async fn report_resale_margin(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, Decimal, Decimal, Decimal, Option<String>, Decimal, Decimal, Decimal, Option<String>)>(
        "SELECT r.description, mt.name, pu.label, COALESCE(r.gross_weight,0), COALESCE(r.net_weight,0), \
            COALESCE(r.purchase_cost,0), r.status, COALESCE(r.sale_price,0), COALESCE(r.margin,0), COALESCE(r.gst,0), r.sold_at::text \
         FROM resale_item r LEFT JOIN metal_type mt ON mt.id=r.metal_type_id LEFT JOIN purity pu ON pu.id=r.purity_id \
         WHERE r.branch_id=$1 ORDER BY r.created_at DESC",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut cost, mut margin) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        cost += r.5; margin += r.8;
        json!({ "description": r.0, "metal": r.1, "purity": r.2, "gross": r.3.to_string(), "net": r.4.to_string(),
                "purchase_cost": r.5.to_string(), "status": r.6, "sale_price": r.7.to_string(),
                "margin": r.8.to_string(), "gst": r.9.to_string(), "sold_at": r.10 })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "purchase_cost": cost.to_string(), "margin": margin.to_string() } })))
}

async fn report_statutory(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT ps.period, st.name, COALESCE(ps.gross,0), COALESCE(ps.pf,0), COALESCE(ps.esi,0), COALESCE(ps.pt,0), \
            COALESCE(ps.tds,0), COALESCE(ps.employer_pf,0), COALESCE(ps.employer_esi,0), COALESCE(ps.net_pay,0) \
         FROM payslip ps JOIN staff st ON st.id=ps.staff_id \
         WHERE st.branch_id=$1 ORDER BY ps.period DESC, st.name",
    )
    .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let (mut pf, mut esi, mut pt, mut tds) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        pf += r.3; esi += r.4; pt += r.5; tds += r.6;
        json!({ "period": r.0, "staff": r.1, "gross": r.2.to_string(), "pf": r.3.to_string(), "esi": r.4.to_string(),
                "pt": r.5.to_string(), "tds": r.6.to_string(), "employer_pf": r.7.to_string(),
                "employer_esi": r.8.to_string(), "net_pay": r.9.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "pf": pf.to_string(), "esi": esi.to_string(), "pt": pt.to_string(), "tds": tds.to_string() } })))
}

// ===================== GSTN return exports (GSTR-1 / GSTR-3B) =====================
// Schema-aligned JSON for the GSTN offline utility. Figures come from the same
// net-of-returns ledger the other GST reports use. Validate against the current
// offline tool before actual filing (schema versions change periodically).

#[derive(Deserialize)]
struct PeriodQuery {
    period: String, // "YYYY-MM"
}

/// One outward invoice line, flattened with its recipient + tax split.
struct OutLine {
    inv_id: i64,
    doc: String,
    idt: String,     // DD-MM-YYYY
    val: Decimal,    // invoice grand total
    gstin: Option<String>,
    state: Option<String>,
    txval: Decimal,
    cgst: Decimal,
    sgst: Decimal,
    igst: Decimal,
    hsn: Option<String>,
    qty: Decimal,
}

/// One credit note, flattened with recipient + derived tax split.
struct CnRow {
    doc: String,
    idt: String,
    val: Decimal,
    txval: Decimal,
    tax: Decimal,
    gstin: Option<String>,
    state: Option<String>,
}

fn gst_date(iso: &str) -> String {
    let p: Vec<&str> = iso.split('-').collect();
    if p.len() == 3 { format!("{}-{}-{}", p[2], p[1], p[0]) } else { iso.to_string() }
}
fn fnum(d: Decimal) -> Value {
    json!(d.round_dp(2).to_string().parse::<f64>().unwrap_or(0.0))
}
fn rate_of(tax: Decimal, txval: Decimal) -> Decimal {
    if txval.is_zero() { Decimal::ZERO } else { (tax / txval * Decimal::from(100)).round_dp(2) }
}
fn rate_key(rt: Decimal) -> i64 {
    (rt * Decimal::from(100)).round().to_string().parse::<i64>().unwrap_or(0)
}
fn rate_val(key: i64) -> Value {
    json!((key as f64) / 100.0)
}

/// The shop's own 2-digit GST state code (from Company profile). Empty if unset.
async fn seller_state_code(s: &AppState) -> Result<String, ApiError> {
    Ok(sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='seller_state_code'")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or_default())
}

async fn load_outward_lines(s: &AppState, period: &str) -> Result<Vec<OutLine>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, Option<String>, String, Decimal, Option<String>, Option<String>, Decimal, Decimal, Decimal, Decimal, Option<String>, Option<i32>)>(
        "SELECT i.id, i.document_no, i.created_at::date::text, COALESCE(i.grand_total,0), \
            p.gstin, p.state_code, il.taxable_value, \
            COALESCE((il.breakdown_json->>'cgst')::numeric,0), COALESCE((il.breakdown_json->>'sgst')::numeric,0), \
            COALESCE((il.breakdown_json->>'igst')::numeric,0), il.hsn, il.hsn_qty \
         FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id \
         LEFT JOIN customer cu ON cu.id=i.customer_id \
         LEFT JOIN party p ON p.id = COALESCE(i.party_id, cu.party_id) \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND to_char(i.created_at,'YYYY-MM')=$2",
    )
    .bind(s.default_branch).bind(period).fetch_all(&s.db).await.map_err(internal)?;
    Ok(rows.into_iter().map(|r| OutLine {
        inv_id: r.0, doc: r.1.unwrap_or_default(), idt: gst_date(&r.2), val: r.3,
        gstin: r.4, state: r.5, txval: r.6, cgst: r.7, sgst: r.8, igst: r.9,
        hsn: r.10, qty: Decimal::from(r.11.unwrap_or(0)),
    }).collect())
}

async fn load_credit_notes(s: &AppState, period: &str) -> Result<Vec<CnRow>, ApiError> {
    let rows = sqlx::query_as::<_, (Option<String>, String, Decimal, Decimal, Decimal, Option<String>, Option<String>)>(
        "SELECT cn.document_no, cn.created_at::date::text, COALESCE(cn.total,0), COALESCE(cn.subtotal,0), \
            COALESCE(cn.tax_total,0), p.gstin, p.state_code \
         FROM credit_note cn LEFT JOIN customer cu ON cu.id=cn.customer_id LEFT JOIN party p ON p.id=cu.party_id \
         WHERE cn.branch_id=$1 AND to_char(cn.created_at,'YYYY-MM')=$2",
    )
    .bind(s.default_branch).bind(period).fetch_all(&s.db).await.map_err(internal)?;
    Ok(rows.into_iter().map(|r| CnRow {
        doc: r.0.unwrap_or_default(), idt: gst_date(&r.1), val: r.2, txval: r.3, tax: r.4,
        gstin: r.5, state: r.6,
    }).collect())
}

async fn report_gstr1(State(s): State<AppState>, auth: AuthUser, Query(q): Query<PeriodQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    use std::collections::BTreeMap;
    let seller_gstin = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='seller_gstin'")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or_default();
    let seller_state = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='seller_state_code'")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or_default();
    let (yyyy, mm) = q.period.split_once('-').unwrap_or(("", ""));
    let fp = format!("{}{}", mm, yyyy);
    const B2CL_THRESHOLD: i64 = 100_000; // ₹1L, w.e.f. 01-Aug-2024

    let lines = load_outward_lines(&s, &q.period).await?;
    let cns = load_credit_notes(&s, &q.period).await?;

    // (txval, camt, samt, iamt)
    type Sums = (Decimal, Decimal, Decimal, Decimal);
    struct Inv { inum: String, idt: String, val: Decimal, pos: String, rates: BTreeMap<i64, Sums> }
    let add = |m: &mut Sums, l: &OutLine| { m.0 += l.txval; m.1 += l.cgst; m.2 += l.sgst; m.3 += l.igst; };

    let mut b2b: BTreeMap<String, BTreeMap<i64, Inv>> = BTreeMap::new();
    let mut b2cl: BTreeMap<String, BTreeMap<i64, Inv>> = BTreeMap::new();
    let mut b2cs: BTreeMap<(String, String, i64), Sums> = BTreeMap::new();
    let mut hsn: BTreeMap<(String, i64), (Decimal, Decimal, Decimal, Decimal, Decimal)> = BTreeMap::new(); // qty,txval,camt,samt,iamt
    let mut total_taxable = Decimal::ZERO;
    let (mut o_cgst, mut o_sgst, mut o_igst) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);

    for l in &lines {
        total_taxable += l.txval;
        o_cgst += l.cgst; o_sgst += l.sgst; o_igst += l.igst;
        let inter = l.igst > Decimal::ZERO;
        let pos = l.state.clone().filter(|x| !x.is_empty()).unwrap_or_else(|| seller_state.clone());
        let rt = rate_of(l.cgst + l.sgst + l.igst, l.txval);
        let rk = rate_key(rt);
        // HSN summary (all supplies)
        let hs = l.hsn.clone().unwrap_or_else(|| "-".into());
        let e = hsn.entry((hs, rk)).or_insert((Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
        e.0 += l.qty; e.1 += l.txval; e.2 += l.cgst; e.3 += l.sgst; e.4 += l.igst;

        if l.gstin.as_deref().map(|g| g.len() == 15).unwrap_or(false) {
            let ctin = l.gstin.clone().unwrap();
            let inv = b2b.entry(ctin).or_default().entry(l.inv_id).or_insert_with(|| Inv {
                inum: l.doc.clone(), idt: l.idt.clone(), val: l.val, pos: pos.clone(), rates: BTreeMap::new(),
            });
            add(inv.rates.entry(rk).or_insert((Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO)), l);
        } else if inter && l.val > Decimal::from(B2CL_THRESHOLD) {
            let inv = b2cl.entry(pos.clone()).or_default().entry(l.inv_id).or_insert_with(|| Inv {
                inum: l.doc.clone(), idt: l.idt.clone(), val: l.val, pos: pos.clone(), rates: BTreeMap::new(),
            });
            add(inv.rates.entry(rk).or_insert((Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO)), l);
        } else {
            let ty = if inter { "INTER" } else { "INTRA" };
            let e = b2cs.entry((pos.clone(), ty.into(), rk)).or_insert((Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
            add(e, l);
        }
    }

    // Credit notes: registered -> cdnr; unregistered B2C -> net out of b2cs.
    struct Note { nt_num: String, nt_dt: String, val: Decimal, pos: String, txval: Decimal, camt: Decimal, samt: Decimal, iamt: Decimal, rt: Decimal }
    let mut cdnr: BTreeMap<String, Vec<Note>> = BTreeMap::new();
    for c in &cns {
        let inter = c.state.as_deref().map(|x| !x.is_empty() && x != seller_state).unwrap_or(false);
        let pos = c.state.clone().filter(|x| !x.is_empty()).unwrap_or_else(|| seller_state.clone());
        let rt = rate_of(c.tax, c.txval);
        let (camt, samt, iamt) = if inter { (Decimal::ZERO, Decimal::ZERO, c.tax) } else { (c.tax / Decimal::from(2), c.tax / Decimal::from(2), Decimal::ZERO) };
        if c.gstin.as_deref().map(|g| g.len() == 15).unwrap_or(false) {
            cdnr.entry(c.gstin.clone().unwrap()).or_default().push(Note {
                nt_num: c.doc.clone(), nt_dt: c.idt.clone(), val: c.val, pos: pos.clone(), txval: c.txval, camt, samt, iamt, rt,
            });
        } else {
            let ty = if inter { "INTER" } else { "INTRA" };
            let e = b2cs.entry((pos, ty.into(), rate_key(rt))).or_insert((Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
            e.0 -= c.txval; e.1 -= camt; e.2 -= samt; e.3 -= iamt;
        }
    }

    // ---- serialize ----
    let b2b_json: Vec<Value> = b2b.iter().map(|(ctin, invs)| {
        let inv: Vec<Value> = invs.values().map(|iv| {
            let itms: Vec<Value> = iv.rates.iter().enumerate().map(|(n, (rk, s))| json!({
                "num": n + 1,
                "itm_det": { "txval": fnum(s.0), "rt": rate_val(*rk), "camt": fnum(s.1), "samt": fnum(s.2), "iamt": fnum(s.3), "csamt": 0 }
            })).collect();
            json!({ "inum": iv.inum, "idt": iv.idt, "val": fnum(iv.val), "pos": iv.pos, "rchrg": "N", "inv_typ": "R", "itms": itms })
        }).collect();
        json!({ "ctin": ctin, "inv": inv })
    }).collect();

    let b2cl_json: Vec<Value> = b2cl.iter().map(|(pos, invs)| {
        let inv: Vec<Value> = invs.values().map(|iv| {
            let itms: Vec<Value> = iv.rates.iter().enumerate().map(|(n, (rk, s))| json!({
                "num": n + 1,
                "itm_det": { "txval": fnum(s.0), "rt": rate_val(*rk), "iamt": fnum(s.3), "csamt": 0 }
            })).collect();
            json!({ "inum": iv.inum, "idt": iv.idt, "val": fnum(iv.val), "itms": itms })
        }).collect();
        json!({ "pos": pos, "inv": inv })
    }).collect();

    let b2cs_json: Vec<Value> = b2cs.iter().filter(|(_, s)| s.0 != Decimal::ZERO).map(|((pos, ty, rk), s)| json!({
        "sply_ty": ty, "pos": pos, "typ": "OE", "rt": rate_val(*rk),
        "txval": fnum(s.0), "camt": fnum(s.1), "samt": fnum(s.2), "iamt": fnum(s.3), "csamt": 0
    })).collect();

    let cdnr_json: Vec<Value> = cdnr.iter().map(|(ctin, notes)| {
        let nt: Vec<Value> = notes.iter().map(|n| json!({
            "ntty": "C", "nt_num": n.nt_num, "nt_dt": n.nt_dt, "val": fnum(n.val), "pos": n.pos, "rchrg": "N", "inv_typ": "R",
            "itms": [ { "num": 1, "itm_det": { "txval": fnum(n.txval), "rt": rate_val(rate_key(n.rt)), "camt": fnum(n.camt), "samt": fnum(n.samt), "iamt": fnum(n.iamt), "csamt": 0 } } ]
        })).collect();
        json!({ "ctin": ctin, "nt": nt })
    }).collect();

    let hsn_json: Vec<Value> = hsn.iter().enumerate().map(|(n, ((hs, rk), v))| json!({
        "num": n + 1, "hsn_sc": hs, "uqc": "GMS", "qty": fnum(v.0), "rt": rate_val(*rk),
        "txval": fnum(v.1), "camt": fnum(v.2), "samt": fnum(v.3), "iamt": fnum(v.4), "csamt": 0
    })).collect();

    let mut gstn = serde_json::Map::new();
    gstn.insert("gstin".into(), json!(seller_gstin));
    gstn.insert("fp".into(), json!(fp));
    gstn.insert("gt".into(), fnum(total_taxable));
    gstn.insert("cur_gt".into(), fnum(total_taxable));
    if !b2b_json.is_empty() { gstn.insert("b2b".into(), json!(b2b_json)); }
    if !b2cl_json.is_empty() { gstn.insert("b2cl".into(), json!(b2cl_json)); }
    if !b2cs_json.is_empty() { gstn.insert("b2cs".into(), json!(b2cs_json)); }
    if !cdnr_json.is_empty() { gstn.insert("cdnr".into(), json!(cdnr_json)); }
    if !hsn_json.is_empty() { gstn.insert("hsn".into(), json!({ "data": hsn_json })); }

    let summary = json!([
        { "label": "Taxable value", "value": total_taxable.round_dp(2).to_string(), "section": "Outward supplies (sales)" },
        { "label": "CGST", "value": o_cgst.round_dp(2).to_string(), "section": "Outward supplies (sales)" },
        { "label": "SGST", "value": o_sgst.round_dp(2).to_string(), "section": "Outward supplies (sales)" },
        { "label": "IGST", "value": o_igst.round_dp(2).to_string(), "section": "Outward supplies (sales)" },
        { "label": "Total tax", "value": (o_cgst + o_sgst + o_igst).round_dp(2).to_string(), "section": "Outward supplies (sales)" },
        { "label": "B2B recipients", "value": b2b.len().to_string(), "section": "Section counts" },
        { "label": "B2C large invoices", "value": b2cl.values().map(|m| m.len()).sum::<usize>().to_string(), "section": "Section counts" },
        { "label": "B2C small groups", "value": b2cs_json.len().to_string(), "section": "Section counts" },
        { "label": "Credit notes (registered)", "value": cdnr.values().map(|v| v.len()).sum::<usize>().to_string(), "section": "Section counts" },
        { "label": "HSN lines", "value": hsn_json.len().to_string(), "section": "Section counts" },
    ]);
    Ok(Json(json!({
        "filename": format!("GSTR1_{}.json", fp),
        "note": "GSTR-1 reports OUTWARD SUPPLIES (sales) only. The same sales tax also appears as section 3.1(a) in GSTR-3B — so those figures matching is expected.",
        "summary": summary, "gstn": Value::Object(gstn) })))
}

async fn report_gstr3b(State(s): State<AppState>, auth: AuthUser, Query(q): Query<PeriodQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    use std::collections::BTreeMap;
    let seller_gstin = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='seller_gstin'")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or_default();
    let seller_state = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='seller_state_code'")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or_default();
    let (yyyy, mm) = q.period.split_once('-').unwrap_or(("", ""));
    let fp = format!("{}{}", mm, yyyy);

    let lines = load_outward_lines(&s, &q.period).await?;
    let cns = load_credit_notes(&s, &q.period).await?;

    // 3.1(a) outward taxable, net of credit notes.
    let (mut txval, mut camt, mut samt, mut iamt) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    // 3.2 inter-state supplies to unregistered persons, pos-wise.
    let mut inter_unreg: BTreeMap<String, (Decimal, Decimal)> = BTreeMap::new(); // pos -> (txval, iamt)
    for l in &lines {
        txval += l.txval; camt += l.cgst; samt += l.sgst; iamt += l.igst;
        let registered = l.gstin.as_deref().map(|g| g.len() == 15).unwrap_or(false);
        if !registered && l.igst > Decimal::ZERO {
            let pos = l.state.clone().filter(|x| !x.is_empty()).unwrap_or_else(|| seller_state.clone());
            let e = inter_unreg.entry(pos).or_insert((Decimal::ZERO, Decimal::ZERO));
            e.0 += l.txval; e.1 += l.igst;
        }
    }
    for c in &cns {
        let inter = c.state.as_deref().map(|x| !x.is_empty() && x != seller_state).unwrap_or(false);
        txval -= c.txval;
        if inter { iamt -= c.tax; } else { camt -= c.tax / Decimal::from(2); samt -= c.tax / Decimal::from(2); }
    }

    // Section 4 ITC: B2B purchases net of purchase returns, split by inter/intra
    // determined from supplier/party GST state code vs the seller's state.
    let purch = sqlx::query_as::<_, (bool, Decimal)>(
        "SELECT (COALESCE(NULLIF(left(COALESCE(pa.gstin, su.gstin),2),''), pa.state_code, $3) <> $3), COALESCE(pb.tax_total,0) \
         FROM purchase_bill pb LEFT JOIN party pa ON pa.id=pb.party_id LEFT JOIN supplier su ON su.id=pb.supplier_id \
         WHERE pb.branch_id=$1 AND pb.bill_kind='b2b' AND pb.status='posted' AND to_char(pb.created_at,'YYYY-MM')=$2",
    )
    .bind(s.default_branch).bind(&q.period).bind(&seller_state).fetch_all(&s.db).await.map_err(internal)?;
    let (mut itc_c, mut itc_s, mut itc_i) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    for (inter, tax) in &purch {
        if *inter { itc_i += *tax; } else { itc_c += *tax / Decimal::from(2); itc_s += *tax / Decimal::from(2); }
    }
    let pret = sqlx::query_as::<_, (bool, Decimal)>(
        "SELECT (COALESCE(NULLIF(left(COALESCE(pa.gstin, su.gstin),2),''), pa.state_code, $3) <> $3), COALESCE(pr.tax_total,0) \
         FROM purchase_return pr JOIN purchase_bill pb ON pb.id=pr.purchase_bill_id \
         LEFT JOIN party pa ON pa.id=pb.party_id LEFT JOIN supplier su ON su.id=pb.supplier_id \
         WHERE pr.branch_id=$1 AND pb.bill_kind='b2b' AND to_char(pr.created_at,'YYYY-MM')=$2",
    )
    .bind(s.default_branch).bind(&q.period).bind(&seller_state).fetch_all(&s.db).await.map_err(internal)?;
    for (inter, tax) in &pret {
        if *inter { itc_i -= *tax; } else { itc_c -= *tax / Decimal::from(2); itc_s -= *tax / Decimal::from(2); }
    }

    let z = || json!({ "txval": 0, "iamt": 0, "camt": 0, "samt": 0, "csamt": 0 });
    let unreg: Vec<Value> = inter_unreg.iter().map(|(pos, (tx, ia))| json!({ "pos": pos, "txval": fnum(*tx), "iamt": fnum(*ia) })).collect();
    let gstn = json!({
        "gstin": seller_gstin,
        "ret_period": fp,
        "sup_details": {
            "osup_det": { "txval": fnum(txval), "camt": fnum(camt), "samt": fnum(samt), "iamt": fnum(iamt), "csamt": 0 },
            "osup_zero": z(), "osup_nil_exmp": z(), "isup_rev": z(), "osup_nongst": z()
        },
        "inter_sup": { "unreg_details": unreg, "comp_details": [], "uin_details": [] },
        "itc_elg": {
            "itc_avl": [ { "ty": "OTH", "iamt": fnum(itc_i), "camt": fnum(itc_c), "samt": fnum(itc_s), "csamt": 0 } ],
            "itc_net": { "iamt": fnum(itc_i), "camt": fnum(itc_c), "samt": fnum(itc_s), "csamt": 0 }
        }
    });
    let summary = json!([
        { "label": "Outward taxable (3.1a)", "value": txval.round_dp(2).to_string(), "section": "Sales — outward (same as GSTR-1)" },
        { "label": "Output CGST", "value": camt.round_dp(2).to_string(), "section": "Sales — outward (same as GSTR-1)" },
        { "label": "Output SGST", "value": samt.round_dp(2).to_string(), "section": "Sales — outward (same as GSTR-1)" },
        { "label": "Output IGST", "value": iamt.round_dp(2).to_string(), "section": "Sales — outward (same as GSTR-1)" },
        { "label": "Output tax total", "value": (camt + samt + iamt).round_dp(2).to_string(), "section": "Sales — outward (same as GSTR-1)" },
        { "label": "ITC CGST", "value": itc_c.round_dp(2).to_string(), "section": "Purchases — input tax credit" },
        { "label": "ITC SGST", "value": itc_s.round_dp(2).to_string(), "section": "Purchases — input tax credit" },
        { "label": "ITC IGST", "value": itc_i.round_dp(2).to_string(), "section": "Purchases — input tax credit" },
        { "label": "ITC total", "value": (itc_c + itc_s + itc_i).round_dp(2).to_string(), "section": "Purchases — input tax credit" },
        { "label": "Net tax payable", "value": ((camt - itc_c) + (samt - itc_s) + (iamt - itc_i)).round_dp(2).to_string(), "section": "Net position" },
    ]);
    Ok(Json(json!({
        "filename": format!("GSTR3B_{}.json", fp),
        "note": "GSTR-3B is a SUMMARY return: outward sales tax (3.1a — identical to GSTR-1) MINUS input tax credit on purchases = net tax payable. The sales block intentionally matches GSTR-1; the ITC (purchases) block is what differs.",
        "summary": summary, "gstn": gstn })))
}

// ---- Accounts & Compliance redesign ----

async fn report_compliance_overview(State(s): State<AppState>, auth: AuthUser, Query(q): Query<PeriodQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let period = &q.period;
    let seller_gstin = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='seller_gstin'")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or_default();
    let seller_state = seller_state_code(&s).await?;

    // Output side (per line), + lines missing HSN.
    let out: (Decimal, Decimal, Decimal, Decimal, i64) = sqlx::query_as(
        "SELECT COALESCE(sum(il.taxable_value),0), COALESCE(sum((il.breakdown_json->>'cgst')::numeric),0), \
                COALESCE(sum((il.breakdown_json->>'sgst')::numeric),0), COALESCE(sum((il.breakdown_json->>'igst')::numeric),0), \
                count(*) FILTER (WHERE il.hsn IS NULL OR il.hsn='') \
         FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND to_char(i.created_at,'YYYY-MM')=$2",
    ).bind(s.default_branch).bind(period).fetch_one(&s.db).await.map_err(internal)?;

    let cn: (Decimal, Decimal, i64) = sqlx::query_as(
        "SELECT COALESCE(sum(subtotal),0), COALESCE(sum(tax_total),0), count(*) FROM credit_note \
         WHERE branch_id=$1 AND to_char(created_at,'YYYY-MM')=$2",
    ).bind(s.default_branch).bind(period).fetch_one(&s.db).await.map_err(internal)?;

    let split: (i64, i64, Decimal, i64, Decimal) = sqlx::query_as(
        "SELECT count(DISTINCT i.id), \
                count(DISTINCT i.id) FILTER (WHERE p.gstin IS NOT NULL AND length(p.gstin)=15), \
                COALESCE(sum(il.taxable_value) FILTER (WHERE p.gstin IS NOT NULL AND length(p.gstin)=15),0), \
                count(DISTINCT i.id) FILTER (WHERE p.gstin IS NULL OR length(p.gstin)<>15), \
                COALESCE(sum(il.taxable_value) FILTER (WHERE p.gstin IS NULL OR length(p.gstin)<>15),0) \
         FROM invoice i JOIN invoice_line il ON il.invoice_id=i.id \
         LEFT JOIN customer cu ON cu.id=i.customer_id LEFT JOIN party p ON p.id=COALESCE(i.party_id, cu.party_id) \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND to_char(i.created_at,'YYYY-MM')=$2",
    ).bind(s.default_branch).bind(period).fetch_one(&s.db).await.map_err(internal)?;

    let pur: (Decimal, Decimal) = sqlx::query_as(
        "SELECT COALESCE(sum(pb.tax_total) FILTER (WHERE COALESCE(NULLIF(left(COALESCE(pa.gstin, su.gstin),2),''), pa.state_code, $3) <> $3),0), \
                COALESCE(sum(pb.tax_total) FILTER (WHERE COALESCE(NULLIF(left(COALESCE(pa.gstin, su.gstin),2),''), pa.state_code, $3) = $3),0) \
         FROM purchase_bill pb LEFT JOIN party pa ON pa.id=pb.party_id LEFT JOIN supplier su ON su.id=pb.supplier_id \
         WHERE pb.branch_id=$1 AND pb.bill_kind='b2b' AND pb.status='posted' AND to_char(pb.created_at,'YYYY-MM')=$2",
    ).bind(s.default_branch).bind(period).bind(&seller_state).fetch_one(&s.db).await.map_err(internal)?;
    let pret: (Decimal, Decimal) = sqlx::query_as(
        "SELECT COALESCE(sum(pr.tax_total) FILTER (WHERE COALESCE(NULLIF(left(COALESCE(pa.gstin, su.gstin),2),''), pa.state_code, $3) <> $3),0), \
                COALESCE(sum(pr.tax_total) FILTER (WHERE COALESCE(NULLIF(left(COALESCE(pa.gstin, su.gstin),2),''), pa.state_code, $3) = $3),0) \
         FROM purchase_return pr JOIN purchase_bill pb ON pb.id=pr.purchase_bill_id \
         LEFT JOIN party pa ON pa.id=pb.party_id LEFT JOIN supplier su ON su.id=pb.supplier_id \
         WHERE pr.branch_id=$1 AND pb.bill_kind='b2b' AND to_char(pr.created_at,'YYYY-MM')=$2",
    ).bind(s.default_branch).bind(period).bind(&seller_state).fetch_one(&s.db).await.map_err(internal)?;

    let two = Decimal::from(2);
    let out_cgst = out.1 - cn.1 / two;
    let out_sgst = out.2 - cn.1 / two;
    let out_igst = out.3; // CN igst split unknown at header; treated intra by default
    let output_tax = out_cgst + out_sgst + out_igst;
    let turnover = out.0 - cn.0;
    let itc_igst = pur.0 - pret.0;
    let itc_intra = pur.1 - pret.1;
    let itc_cgst = itc_intra / two;
    let itc_sgst = itc_intra / two;
    let itc_total = itc_cgst + itc_sgst + itc_igst;
    let net_payable = output_tax - itc_total;

    let checks = json!([
        { "label": "Seller GSTIN configured", "status": if seller_gstin.len()==15 {"ok"} else {"warn"},
          "detail": if seller_gstin.is_empty() { "Set it in Settings → Company profile".to_string() } else { seller_gstin.clone() } },
        { "label": "Invoice lines missing HSN", "status": if out.4==0 {"ok"} else {"warn"},
          "detail": format!("{} line(s)", out.4) },
        { "label": "Net GST payable this period", "status": "info", "detail": net_payable.round_dp(2).to_string() },
    ]);
    Ok(Json(json!({
        "period": period, "seller_gstin": seller_gstin,
        "output": { "taxable": turnover.to_string(), "cgst": out_cgst.to_string(), "sgst": out_sgst.to_string(), "igst": out_igst.to_string(), "tax": output_tax.to_string() },
        "itc": { "cgst": itc_cgst.to_string(), "sgst": itc_sgst.to_string(), "igst": itc_igst.to_string(), "tax": itc_total.to_string() },
        "net_payable": net_payable.to_string(),
        "turnover_taxable": turnover.to_string(),
        "b2b": { "invoices": split.1, "taxable": split.2.to_string() },
        "b2c": { "invoices": split.3, "taxable": split.4.to_string() },
        "invoices": split.0, "credit_notes": cn.2,
        "checks": checks,
    })))
}

async fn report_hsn_summary(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, Decimal, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT COALESCE(NULLIF(il.hsn,''),'—'), COALESCE(sum(il.hsn_qty),0)::numeric, COALESCE(sum(il.taxable_value),0), \
            COALESCE(sum((il.breakdown_json->>'cgst')::numeric),0), COALESCE(sum((il.breakdown_json->>'sgst')::numeric),0), \
            COALESCE(sum((il.breakdown_json->>'igst')::numeric),0) \
         FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND i.created_at::date BETWEEN $2::date AND $3::date \
         GROUP BY 1 ORDER BY 1",
    ).bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut qty, mut txv, mut cg, mut sg, mut ig) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        qty += r.1; txv += r.2; cg += r.3; sg += r.4; ig += r.5;
        json!({ "hsn": r.0, "qty": r.1.to_string(), "taxable": r.2.to_string(), "cgst": r.3.to_string(),
                "sgst": r.4.to_string(), "igst": r.5.to_string(), "tax": (r.3+r.4+r.5).to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "taxable": txv.to_string(), "cgst": cg.to_string(), "sgst": sg.to_string(), "igst": ig.to_string(), "tax": (cg+sg+ig).to_string() } })))
}

async fn report_output_tax_register(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT i.document_no, i.created_at::text, COALESCE(c.name, p.display_name, 'Walk-in'), \
            COALESCE(sum(il.taxable_value),0), COALESCE(sum((il.breakdown_json->>'cgst')::numeric),0), \
            COALESCE(sum((il.breakdown_json->>'sgst')::numeric),0), COALESCE(sum((il.breakdown_json->>'igst')::numeric),0) \
         FROM invoice i JOIN invoice_line il ON il.invoice_id=i.id \
         LEFT JOIN customer c ON c.id=i.customer_id LEFT JOIN party p ON p.id=i.party_id \
         WHERE i.branch_id=$1 AND i.status IN ('final','returned') AND i.created_at::date BETWEEN $2::date AND $3::date \
         GROUP BY i.id, i.document_no, i.created_at, c.name, p.display_name ORDER BY i.created_at",
    ).bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut txv, mut cg, mut sg, mut ig) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        txv += r.3; cg += r.4; sg += r.5; ig += r.6;
        json!({ "document_no": r.0, "date": r.1, "party": r.2, "taxable": r.3.to_string(),
                "cgst": r.4.to_string(), "sgst": r.5.to_string(), "igst": r.6.to_string(), "tax": (r.4+r.5+r.6).to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "taxable": txv.to_string(), "cgst": cg.to_string(), "sgst": sg.to_string(), "igst": ig.to_string(), "tax": (cg+sg+ig).to_string() } })))
}

async fn report_itc_register(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let seller_state = seller_state_code(&s).await?;
    let rows = sqlx::query_as::<_, (Option<String>, String, String, bool, Decimal, Decimal)>(
        "SELECT pb.document_no, pb.created_at::text, COALESCE(p.display_name, su.name, '-'), \
            (COALESCE(NULLIF(left(COALESCE(p.gstin, su.gstin),2),''), p.state_code, $4) <> $4), \
            (pb.subtotal), COALESCE(pb.tax_total,0) \
         FROM purchase_bill pb LEFT JOIN party p ON p.id=pb.party_id LEFT JOIN supplier su ON su.id=pb.supplier_id \
         WHERE pb.branch_id=$1 AND pb.bill_kind='b2b' AND pb.status='posted' AND pb.created_at::date BETWEEN $2::date AND $3::date \
         ORDER BY pb.created_at",
    ).bind(s.default_branch).bind(&q.from).bind(&q.to).bind(&seller_state).fetch_all(&s.db).await.map_err(internal)?;
    let two = Decimal::from(2);
    let (mut txv, mut cg, mut sg, mut ig) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        let inter = r.3;
        let (c, sgv, igv) = if inter { (Decimal::ZERO, Decimal::ZERO, r.5) } else { (r.5 / two, r.5 / two, Decimal::ZERO) };
        txv += r.4; cg += c; sg += sgv; ig += igv;
        json!({ "document_no": r.0, "date": r.1, "supplier": r.2, "supply": if inter {"inter-state"} else {"intra-state"},
                "taxable": r.4.to_string(), "cgst": c.to_string(), "sgst": sgv.to_string(), "igst": igv.to_string(), "tax": r.5.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "taxable": txv.to_string(), "cgst": cg.to_string(), "sgst": sg.to_string(), "igst": ig.to_string(), "tax": (cg+sg+ig).to_string() } })))
}

async fn report_cash_bank_book(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let receipts = sqlx::query_as::<_, (String, i64, Decimal)>(
        "SELECT t.mode, count(*), COALESCE(sum(t.amount),0) FROM invoice_tender t \
         WHERE t.created_at::date BETWEEN $1::date AND $2::date GROUP BY t.mode ORDER BY t.mode",
    ).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let payments = sqlx::query_as::<_, (String, i64, Decimal)>(
        "SELECT pp.mode, count(*), COALESCE(sum(pp.amount),0) FROM purchase_payment pp \
         WHERE pp.created_at::date BETWEEN $1::date AND $2::date GROUP BY pp.mode ORDER BY pp.mode",
    ).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let mut rt = Decimal::ZERO;
    let rec: Vec<Value> = receipts.iter().map(|r| { rt += r.2; json!({ "mode": r.0, "count": r.1, "total": r.2.to_string() }) }).collect();
    let mut pt = Decimal::ZERO;
    let pay: Vec<Value> = payments.iter().map(|r| { pt += r.2; json!({ "mode": r.0, "count": r.1, "total": r.2.to_string() }) }).collect();
    Ok(Json(json!({ "receipts": rec, "payments": pay, "receipts_total": rt.to_string(), "payments_total": pt.to_string(), "net": (rt - pt).to_string() })))
}

async fn report_daily_collections(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    // Day-wise money received, split by tender mode (cash / UPI / card / bank / cheque).
    let rows = sqlx::query_as::<_, (String, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT t.created_at::date::text, \
            COALESCE(sum(t.amount) FILTER (WHERE t.mode='cash'),0), \
            COALESCE(sum(t.amount) FILTER (WHERE t.mode='upi'),0), \
            COALESCE(sum(t.amount) FILTER (WHERE t.mode='card'),0), \
            COALESCE(sum(t.amount) FILTER (WHERE t.mode IN ('bank','bank_transfer')),0), \
            COALESCE(sum(t.amount) FILTER (WHERE t.mode='cheque'),0), \
            COALESCE(sum(t.amount),0) \
         FROM invoice_tender t \
         WHERE t.created_at::date BETWEEN $1::date AND $2::date \
         GROUP BY t.created_at::date ORDER BY t.created_at::date",
    ).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut c, mut u, mut cd, mut b, mut ch, mut tot) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        c += r.1; u += r.2; cd += r.3; b += r.4; ch += r.5; tot += r.6;
        json!({ "date": r.0, "cash": r.1.to_string(), "upi": r.2.to_string(), "card": r.3.to_string(),
                "bank": r.4.to_string(), "cheque": r.5.to_string(), "total": r.6.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": {
        "cash": c.to_string(), "upi": u.to_string(), "card": cd.to_string(),
        "bank": b.to_string(), "cheque": ch.to_string(), "total": tot.to_string() } })))
}

async fn report_cash_book(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    // All money movements: + = received (income), − = paid out (expense). Cash vs bank by mode.
    let union = "SELECT created_at::date d, (mode='cash') is_cash, amount amt FROM invoice_tender \
         UNION ALL SELECT paid_at::date, (payment_mode='cash'), amount FROM scheme_installment \
         UNION ALL SELECT created_at::date, (payment_mode='cash'), amount FROM customer_advance \
         UNION ALL SELECT created_at::date, (mode='cash'), -amount FROM purchase_payment \
         UNION ALL SELECT created_at::date, false, -amount FROM staff_advance \
         UNION ALL SELECT occurred_at::date, false, COALESCE(amount_delta,0) FROM ledger_event WHERE event_type='salary_paid'";
    let opening: (Decimal, Decimal) = sqlx::query_as(&format!(
        "WITH mv AS ({union}) SELECT COALESCE(sum(amt) FILTER (WHERE is_cash),0), \
            COALESCE(sum(amt) FILTER (WHERE NOT is_cash),0) FROM mv WHERE d < $1::date"
    )).bind(&q.from).fetch_one(&s.db).await.map_err(internal)?;
    let rows = sqlx::query_as::<_, (String, Decimal, Decimal, Decimal, Decimal)>(&format!(
        "WITH mv AS ({union}) SELECT d::text, \
            COALESCE(sum(amt) FILTER (WHERE is_cash AND amt>0),0), \
            COALESCE(-sum(amt) FILTER (WHERE is_cash AND amt<0),0), \
            COALESCE(sum(amt) FILTER (WHERE NOT is_cash AND amt>0),0), \
            COALESCE(-sum(amt) FILTER (WHERE NOT is_cash AND amt<0),0) \
         FROM mv WHERE d BETWEEN $1::date AND $2::date GROUP BY d ORDER BY d"
    )).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut cash, mut bank) = (opening.0, opening.1);
    let (mut tr, mut tp) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        let (ci, co, bi, bo) = (r.1, r.2, r.3, r.4);
        let opening_total = cash + bank;
        cash += ci - co; bank += bi - bo;
        tr += ci + bi; tp += co + bo;
        json!({ "date": r.0, "opening": opening_total.to_string(),
                "cash_in": ci.to_string(), "bank_in": bi.to_string(), "receipts": (ci + bi).to_string(),
                "cash_out": co.to_string(), "bank_out": bo.to_string(), "payments": (co + bo).to_string(),
                "closing_cash": cash.to_string(), "closing_bank": bank.to_string(), "closing": (cash + bank).to_string() })
    }).collect();
    Ok(Json(json!({
        "opening": { "cash": opening.0.to_string(), "bank": opening.1.to_string(), "total": (opening.0 + opening.1).to_string() },
        "closing": { "cash": cash.to_string(), "bank": bank.to_string(), "total": (cash + bank).to_string() },
        "total_receipts": tr.to_string(), "total_payments": tp.to_string(),
        "rows": items,
    })))
}

// ===================== Double-entry accounting =====================
// The journal is a projection of business documents. `accounts_rebuild` wipes and
// regenerates all posting-engine entries from source data, so the ledger is always
// consistent and every entry is balanced by construction.

async fn post_je<'a>(
    tx: &mut sqlx::Transaction<'a, Postgres>,
    branch: i64, date: &str, narration: &str, stype: &str, sid: Option<i64>,
    lines: &[(i64, Decimal, Decimal)],
) -> Result<(), ApiError> {
    let eid: i64 = sqlx::query_scalar(
        "INSERT INTO journal_entry (branch_id, entry_date, narration, source_type, source_id) \
         VALUES ($1,$2::date,$3,$4,$5) RETURNING id")
        .bind(branch).bind(date).bind(narration).bind(stype).bind(sid)
        .fetch_one(&mut **tx).await.map_err(internal)?;
    for (acc, d, c) in lines {
        if *d == Decimal::ZERO && *c == Decimal::ZERO { continue; }
        sqlx::query("INSERT INTO journal_line (entry_id, account_id, debit, credit) VALUES ($1,$2,$3,$4)")
            .bind(eid).bind(acc).bind(*d).bind(*c).execute(&mut **tx).await.map_err(internal)?;
    }
    Ok(())
}

// ===================== Opening balances workbench =====================

async fn opening_parties(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, Decimal, Decimal)>(
        "SELECT p.id, p.display_name, COALESCE(t.opening_cash_balance,0), COALESCE(t.opening_metal_balance,0) \
         FROM party p LEFT JOIN party_terms t ON t.party_id = p.id \
         WHERE p.archived = false ORDER BY p.display_name")
        .fetch_all(&s.db).await.map_err(internal)?;
    Ok(Json(json!(rows.iter().map(|r| json!({
        "id": r.0, "display_name": r.1,
        "opening_cash_balance": r.2.to_string(), "opening_metal_balance": r.3.to_string(),
    })).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct OpeningPartyRow {
    party_id: i64,
    opening_cash_balance: Decimal,
    opening_metal_balance: Decimal,
}

async fn set_opening_parties(State(s): State<AppState>, auth: AuthUser, Json(rows): Json<Vec<OpeningPartyRow>>) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    for r in &rows {
        sqlx::query(
            "INSERT INTO party_terms (party_id, opening_cash_balance, opening_metal_balance) VALUES ($1, $2, $3) \
             ON CONFLICT (party_id) DO UPDATE SET opening_cash_balance = $2, opening_metal_balance = $3")
            .bind(r.party_id).bind(r.opening_cash_balance).bind(r.opening_metal_balance)
            .execute(&mut *tx).await.map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "updated": rows.len() })))
}

async fn opening_stock_summary(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (Option<String>, i64, Decimal)>(
        "SELECT d.name, count(*), COALESCE(sum(i.cost_value),0) FROM item i \
         LEFT JOIN department d ON d.id = i.department_id \
         WHERE i.ownership_state = 'in_stock' GROUP BY d.name ORDER BY d.name")
        .fetch_all(&s.db).await.map_err(internal)?;
    let total: Decimal = rows.iter().map(|r| r.2).sum();
    Ok(Json(json!({
        "rows": rows.iter().map(|r| json!({
            "department": r.0.clone().unwrap_or_else(|| "(untagged)".into()),
            "pieces": r.1, "cost": r.2.to_string(),
        })).collect::<Vec<_>>(),
        "total": total.to_string(),
    })))
}

/// Opening stock intake: bring existing inventory into stock as barcoded items at go-live,
/// WITHOUT any purchase side-effects (no supplier payable, no ITC, no Purchases expense).
/// Items contribute to the Stock asset via the closing-stock snapshot; Capital is the plug.
#[derive(Deserialize)]
struct OpeningStockItem {
    department_id: Option<i64>,
    metal_type_id: i64,
    purity_id: i64,
    gross_weight: Decimal,
    net_weight: Decimal,
    stone_weight: Option<Decimal>,
    huid: Option<String>,
    cost_value: Decimal,
    category_id: Option<i64>,
    sku: Option<String>,
}
#[derive(Deserialize)]
struct OpeningStockReq {
    items: Vec<OpeningStockItem>,
}

async fn create_opening_stock(State(s): State<AppState>, auth: AuthUser, Json(req): Json<OpeningStockReq>) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    if req.items.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no opening-stock items".to_string()));
    }
    let branch = s.default_branch;
    let fy = current_fy();
    let mut tx = s.db.begin().await.map_err(internal)?;
    let mut created: Vec<Value> = Vec::new();
    let mut ids: Vec<i64> = Vec::new();
    for it in &req.items {
        let sku = match it.sku.as_deref() {
            Some(x) if !x.trim().is_empty() => x.to_string(),
            _ => {
                let (seq, _doc) = allocate_doc_no(&mut tx, "tag", &fy, SERIES_DEFAULT).await?;
                gen_item_barcode(&mut tx, it.metal_type_id, it.purity_id, seq).await?
            }
        };
        let dept = match it.department_id {
            Some(d) => Some(d),
            None => resolve_department(&mut tx, None, &[], Some(it.metal_type_id), Some(it.purity_id)).await?,
        };
        let item_id: i64 = sqlx::query_scalar(
            "INSERT INTO item (branch_id, sku, metal_type_id, purity_id, gross_weight, net_weight, \
                stone_weight, huid, cost_value, ownership_state, category_id, department_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'in_stock', $10, $11) RETURNING id",
        )
        .bind(branch)
        .bind(&sku)
        .bind(it.metal_type_id)
        .bind(it.purity_id)
        .bind(it.gross_weight)
        .bind(it.net_weight)
        .bind(it.stone_weight.unwrap_or(Decimal::ZERO))
        .bind(it.huid.as_deref())
        .bind(it.cost_value)
        .bind(it.category_id)
        .bind(dept)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
                weight_delta, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'item', $2, 'opening_stock', $3, $4, $5, 'opening', $2)",
        )
        .bind(branch)
        .bind(item_id)
        .bind(json!({"sku": sku, "no_gst": true, "opening": true, "cost_value": it.cost_value.to_string()}))
        .bind(it.gross_weight)
        .bind(it.cost_value)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        created.push(json!({ "item_id": item_id, "sku": sku }));
        ids.push(item_id);
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "items": created, "item_ids": ids })))
}

async fn accounts_rebuild(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let branch = s.default_branch;
    let mut tx = s.db.begin().await.map_err(internal)?;
    sqlx::query("DELETE FROM journal_line").execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("DELETE FROM journal_entry").execute(&mut *tx).await.map_err(internal)?;

    let accs: Vec<(i64, String)> = sqlx::query_as("SELECT id, code FROM chart_of_account")
        .fetch_all(&mut *tx).await.map_err(internal)?;
    let acc: std::collections::HashMap<String, i64> = accs.into_iter().map(|(id, c)| (c, id)).collect();
    let ac = |code: &str| *acc.get(code).unwrap_or(&0);
    let z = Decimal::ZERO;
    let mut count = 0i64;

    // Per-bank ledgers: each bank movement resolves to its bank account's COA ledger.
    // Assignment comes from bank_recon (source_type, source_id) → bank_account, defaulting to
    // the primary account. Movements with no per-movement bank tag (advances, scheme, CN
    // refunds) fall back to the primary bank ledger.
    let banks: Vec<(i64, Option<i64>, bool, Decimal)> = sqlx::query_as(
        "SELECT id, coa_account_id, is_primary, opening_balance FROM bank_account")
        .fetch_all(&mut *tx).await.map_err(internal)?;
    let bank_coa: std::collections::HashMap<i64, i64> = banks.iter().filter_map(|b| b.1.map(|c| (b.0, c))).collect();
    let bank1010 = ac("1010");
    let primary_bank: i64 = banks.iter().find(|b| b.2).map(|b| b.0).or_else(|| banks.first().map(|b| b.0)).unwrap_or(0);
    let primary_bank_coa = bank_coa.get(&primary_bank).copied().unwrap_or(bank1010);
    let recon_rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT source_type, source_id, bank_account_id FROM bank_recon")
        .fetch_all(&mut *tx).await.map_err(internal)?;
    let recon_map: std::collections::HashMap<(String, i64), i64> = recon_rows.into_iter().map(|(st, sid, ba)| ((st, sid), ba)).collect();
    let bankacc = |st: &str, sid: i64| -> i64 {
        let ba = recon_map.get(&(st.to_string(), sid)).copied().unwrap_or(primary_bank);
        bank_coa.get(&ba).copied().unwrap_or(primary_bank_coa)
    };
    // bank movements without a per-movement assignment → primary bank ledger.
    let modeacc = |m: &str| if m == "cash" { ac("1000") } else { primary_bank_coa };

    // ---- Opening balances (from settings; capital is the balancing figure) ----
    let osettings: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value FROM app_setting WHERE key LIKE 'accounts.opening_%'")
        .fetch_all(&mut *tx).await.map_err(internal)?;
    let om: std::collections::HashMap<String, String> = osettings.into_iter().collect();
    let dget = |k: &str| om.get(k).and_then(|v| v.parse::<Decimal>().ok()).unwrap_or(z);
    let open_date = om.get("accounts.opening_date").cloned().unwrap_or_else(|| "2026-04-01".to_string());
    // Bank opening: per-account from the bank master when accounts exist, else the single setting.
    let bank_open_total: Decimal = banks.iter().map(|b| b.3).sum();
    let obank = if banks.is_empty() { dget("accounts.opening_bank") } else { bank_open_total };
    let (ocash, odeb, ocred) = (dget("accounts.opening_cash"), dget("accounts.opening_debtors"), dget("accounts.opening_creditors"));
    // Per-party opening balances (debtor-positive) drive Sundry Debtors/Creditors; the lump
    // settings above are only a fallback for when no party openings are entered.
    let party_deb: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(opening_cash_balance),0) FROM party_terms WHERE opening_cash_balance > 0")
        .fetch_one(&mut *tx).await.map_err(internal)?;
    let party_cred: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(-sum(opening_cash_balance),0) FROM party_terms WHERE opening_cash_balance < 0")
        .fetch_one(&mut *tx).await.map_err(internal)?;
    let odeb = if party_deb != z { party_deb } else { odeb };
    let ocred = if party_cred != z { party_cred } else { ocred };
    // Additional go-live opening ledgers.
    let ofa = dget("accounts.opening_fixed_assets");     // 1500 asset
    let oigst = dget("accounts.opening_input_gst");      // 1400 asset
    let oloans = dget("accounts.opening_loans");         // 2500 liability
    let ocadv = dget("accounts.opening_cust_advances");  // 2100 liability
    let oscheme = dget("accounts.opening_scheme_deposits"); // 2200 liability
    let oogst = dget("accounts.opening_output_gst");     // 2300 liability
    let assets = ocash + obank + odeb + ofa + oigst;
    let liab = ocred + oloans + ocadv + oscheme + oogst;
    let capital = assets - liab;
    let any = [ocash, obank, odeb, ocred, ofa, oigst, oloans, ocadv, oscheme, oogst].iter().any(|v| *v != z);
    if any {
        let mut lines: Vec<(i64, Decimal, Decimal)> = Vec::new();
        if ocash != z { lines.push((ac("1000"), ocash, z)); }
        if odeb != z { lines.push((ac("1100"), odeb, z)); }
        if ofa != z { lines.push((ac("1500"), ofa, z)); }
        if oigst != z { lines.push((ac("1400"), oigst, z)); }
        if ocred != z { lines.push((ac("2000"), z, ocred)); }
        if oloans != z { lines.push((ac("2500"), z, oloans)); }
        if ocadv != z { lines.push((ac("2100"), z, ocadv)); }
        if oscheme != z { lines.push((ac("2200"), z, oscheme)); }
        if oogst != z { lines.push((ac("2300"), z, oogst)); }
        if banks.is_empty() {
            if obank != z { lines.push((bank1010, obank, z)); }
        } else {
            for b in &banks { if b.3 != z { lines.push((bank_coa.get(&b.0).copied().unwrap_or(bank1010), b.3, z)); } }
        }
        if capital >= z { lines.push((ac("3000"), z, capital)); } else { lines.push((ac("3000"), -capital, z)); }
        post_je(&mut tx, branch, &open_date, "Opening balances", "opening", None, &lines).await?; count += 1;
    }

    // ---- Sales invoices (final/returned) ----
    let invs = sqlx::query_as::<_, (i64, String, String, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT id, document_no, created_at::date::text, COALESCE(subtotal,0), COALESCE(discount_total,0), \
            COALESCE(tax_total,0), COALESCE(grand_total,0), COALESCE(old_gold_value,0), COALESCE(scheme_credit,0), \
            COALESCE(advance_applied,0), COALESCE(amount_payable,0) \
         FROM invoice WHERE branch_id=$1 AND status IN ('final','returned') ORDER BY created_at")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    let tenders = sqlx::query_as::<_, (i64, i64, String, Decimal)>(
        "SELECT t.invoice_id, t.id, t.mode, COALESCE(t.amount,0) FROM invoice_tender t \
         JOIN invoice i ON i.id=t.invoice_id WHERE i.branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    let mut tmap: std::collections::HashMap<i64, Vec<(i64, String, Decimal)>> = std::collections::HashMap::new();
    for (iid, tid, m, amt) in tenders { tmap.entry(iid).or_default().push((tid, m, amt)); }
    for iv in &invs {
        let (id, docno, date, subtotal, disc, tax, grand, oldg, sch, adv, payable) = (iv.0, &iv.1, &iv.2, iv.3, iv.4, iv.5, iv.6, iv.7, iv.8, iv.9, iv.10);
        let net = subtotal - disc;
        let mut lines: Vec<(i64, Decimal, Decimal)> = Vec::new();
        let mut tender_sum = z;
        if let Some(ts) = tmap.get(&id) {
            for (tid, m, amt) in ts {
                let acct = if m == "cash" { ac("1000") } else { bankacc("tender", *tid) };
                lines.push((acct, *amt, z)); tender_sum += *amt;
            }
        }
        let debtor = payable - tender_sum;               // unpaid → receivable
        if debtor > z { lines.push((ac("1100"), debtor, z)); }
        else if debtor < z { lines.push((ac("2100"), z, -debtor)); } // over-paid / old gold exceeds bill → we owe the customer (credit held)
        if oldg > z { lines.push((ac("1210"), oldg, z)); }
        if sch > z { lines.push((ac("2200"), sch, z)); }  // scheme redeemed → reduce liability
        if adv > z { lines.push((ac("2100"), adv, z)); }  // advance applied → reduce liability
        lines.push((ac("4000"), z, net));
        lines.push((ac("2300"), z, tax));
        let round = grand - net - tax;
        if round > z { lines.push((ac("5990"), z, round)); } else if round < z { lines.push((ac("5990"), -round, z)); }
        post_je(&mut tx, branch, date, &format!("Sale {docno}"), "invoice", Some(id), &lines).await?; count += 1;
    }

    // ---- Credit notes (sales returns) ----
    let cns = sqlx::query_as::<_, (i64, Option<String>, String, Decimal, Decimal, Decimal, Decimal, Option<String>)>(
        "SELECT id, document_no, created_at::date::text, COALESCE(subtotal,0), COALESCE(tax_total,0), \
            COALESCE(total,0), COALESCE(net_refund, total), refund_mode FROM credit_note WHERE branch_id=$1 ORDER BY created_at")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for c in &cns {
        let (id, sub, tax, total, refund, mode) = (c.0, c.3, c.4, c.5, c.6, c.7.as_deref().unwrap_or("cash"));
        let deduction = total - refund;
        let mut lines = vec![(ac("4000"), sub, z), (ac("2300"), tax, z), (modeacc(mode), z, refund)];
        if deduction > z { lines.push((ac("4100"), z, deduction)); }  // retained deduction = other income
        else if deduction < z { lines.push((ac("4100"), -deduction, z)); }
        post_je(&mut tx, branch, &c.2, &format!("Sales return {}", c.1.clone().unwrap_or_default()), "credit_note", Some(id), &lines).await?; count += 1;
    }

    // ---- Purchases ----
    let purs = sqlx::query_as::<_, (i64, Option<String>, String, Decimal, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT id, document_no, created_at::date::text, COALESCE(subtotal,0), COALESCE(making_total,0), \
            COALESCE(stone_total,0), COALESCE(tax_total,0), COALESCE(total,0) FROM purchase_bill \
         WHERE branch_id=$1 AND status='posted' ORDER BY created_at")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for p in &purs {
        let (tax, total) = (p.6, p.7);
        let purchases = total - tax;   // subtotal already = taxable (making/stone are breakdowns within it)
        let lines = vec![(ac("5000"), purchases, z), (ac("1400"), tax, z), (ac("2000"), z, total)];
        post_je(&mut tx, branch, &p.2, &format!("Purchase {}", p.1.clone().unwrap_or_default()), "purchase_bill", Some(p.0), &lines).await?; count += 1;
    }

    // ---- Purchase payments ----
    let pays = sqlx::query_as::<_, (i64, i64, String, Decimal, String)>(
        "SELECT pp.purchase_bill_id, pp.id, pp.mode, COALESCE(pp.amount,0), pp.created_at::date::text FROM purchase_payment pp \
         JOIN purchase_bill pb ON pb.id=pp.purchase_bill_id WHERE pb.branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for p in &pays {
        let acct = if p.2 == "cash" { ac("1000") } else { bankacc("purchase_payment", p.1) };
        post_je(&mut tx, branch, &p.4, "Supplier payment", "purchase_payment", Some(p.0),
            &[(ac("2000"), p.3, z), (acct, z, p.3)]).await?; count += 1;
    }

    // ---- Purchase returns (debit notes) — reverse the purchase ----
    let prets = sqlx::query_as::<_, (i64, Option<String>, String, Decimal, Decimal, Decimal)>(
        "SELECT id, document_no, created_at::date::text, COALESCE(subtotal,0), COALESCE(tax_total,0), COALESCE(total,0) \
         FROM purchase_return WHERE branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for r in &prets {
        let (sub, tax, total) = (r.3, r.4, r.5);
        let mut lines = vec![(ac("2000"), total, z), (ac("5000"), z, sub), (ac("1400"), z, tax)];
        let round = total - sub - tax;
        if round > z { lines.push((ac("5990"), z, round)); } else if round < z { lines.push((ac("5990"), -round, z)); }
        post_je(&mut tx, branch, &r.2, &format!("Purchase return {}", r.1.clone().unwrap_or_default()), "purchase_return", Some(r.0), &lines).await?; count += 1;
    }

    // ---- Rate cutting — fixing unpriced metal into money ----
    // we_owe:   we owe the party money for metal received (unfixed purchase) → Dr Purchases, Cr Creditors.
    // they_owe: customer owes money for an unfixed sale                       → Dr Debtors,   Cr Sales.
    let rcs = sqlx::query_as::<_, (i64, Option<String>, String, Decimal, Option<String>)>(
        "SELECT id, document_no, created_at::date::text, COALESCE(amount,0), direction FROM rate_cut WHERE branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for r in &rcs {
        let amt = r.3;
        let lines = if r.4.as_deref() == Some("we_owe") {
            vec![(ac("5000"), amt, z), (ac("2000"), z, amt)]
        } else {
            vec![(ac("1100"), amt, z), (ac("4000"), z, amt)]
        };
        post_je(&mut tx, branch, &r.2, &format!("Rate cut {}", r.1.clone().unwrap_or_default()), "rate_cut", Some(r.0), &lines).await?; count += 1;
    }

    // ---- Customer advances received ----
    let advs = sqlx::query_as::<_, (i64, String, Decimal, Option<String>)>(
        "SELECT id, created_at::date::text, COALESCE(amount,0), payment_mode FROM customer_advance WHERE branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for a in &advs {
        post_je(&mut tx, branch, &a.1, "Customer advance received", "advance", Some(a.0),
            &[(modeacc(a.3.as_deref().unwrap_or("cash")), a.2, z), (ac("2100"), z, a.2)]).await?; count += 1;
    }
    // ---- Advance refunds — return money, reverse the liability ----
    let arefs = sqlx::query_as::<_, (i64, String, Decimal, Option<String>)>(
        "SELECT id, created_at::date::text, COALESCE(amount,0), payment_mode FROM customer_advance \
         WHERE branch_id=$1 AND status='refunded'")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for a in &arefs {
        post_je(&mut tx, branch, &a.1, "Customer advance refunded", "advance_refund", Some(a.0),
            &[(ac("2100"), a.2, z), (modeacc(a.3.as_deref().unwrap_or("cash")), z, a.2)]).await?; count += 1;
    }

    // ---- Customer receipts (payments received against debtors) ----
    let recs = sqlx::query_as::<_, (i64, String, Decimal, String)>(
        "SELECT id, receipt_date::text, COALESCE(amount,0), mode FROM customer_receipt WHERE branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for r in &recs {
        let acct = if r.3 == "cash" { ac("1000") } else { bankacc("receipt", r.0) };
        post_je(&mut tx, branch, &r.1, "Customer receipt", "receipt", Some(r.0),
            &[(acct, r.2, z), (ac("1100"), z, r.2)]).await?; count += 1;
    }

    // ---- Manual bank entries (deposits / withdrawals / interest / charges) ----
    let bes = sqlx::query_as::<_, (i64, String, String, Decimal, i64)>(
        "SELECT id, entry_date::text, kind, COALESCE(amount,0), bank_account_id FROM bank_entry WHERE branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for be in &bes {
        let (id, date, kind, amt) = (be.0, &be.1, be.2.as_str(), be.3);
        let bk = bank_coa.get(&be.4).copied().unwrap_or(primary_bank_coa);
        let lines = match kind {
            "deposit"      => vec![(bk, amt, z), (ac("1000"), z, amt)], // cash → bank
            "withdrawal"   => vec![(ac("1000"), amt, z), (bk, z, amt)], // bank → cash
            "interest"     => vec![(bk, amt, z), (ac("4100"), z, amt)], // interest income
            "charges"      => vec![(ac("5320"), amt, z), (bk, z, amt)], // bank charges
            "other_credit" => vec![(bk, amt, z), (ac("4100"), z, amt)],
            _              => vec![(ac("5900"), amt, z), (bk, z, amt)], // other_debit
        };
        post_je(&mut tx, branch, date, &format!("Bank {}", kind.replace('_', " ")), "bank_entry", Some(id), &lines).await?; count += 1;
    }

    // ---- Inter-bank fund transfers (contra: Dr destination bank, Cr source bank) ----
    let xfers = sqlx::query_as::<_, (i64, String, Decimal, i64, i64)>(
        "SELECT id, transfer_date::text, COALESCE(amount,0), from_account_id, to_account_id FROM bank_transfer WHERE branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for x in &xfers {
        let from_coa = bank_coa.get(&x.3).copied().unwrap_or(primary_bank_coa);
        let to_coa = bank_coa.get(&x.4).copied().unwrap_or(primary_bank_coa);
        if from_coa != to_coa {
            post_je(&mut tx, branch, &x.1, "Bank transfer", "bank_transfer", Some(x.0),
                &[(to_coa, x.2, z), (from_coa, z, x.2)]).await?; count += 1;
        }
    }

    // ---- Scheme installments ----
    let sis = sqlx::query_as::<_, (i64, String, Decimal, Option<String>)>(
        "SELECT si.id, si.paid_at::date::text, COALESCE(si.amount,0), si.payment_mode FROM scheme_installment si \
         JOIN scheme sc ON sc.id=si.scheme_id WHERE sc.branch_id=$1 AND si.paid_at IS NOT NULL")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for si in &sis {
        post_je(&mut tx, branch, &si.1, "Scheme collection", "scheme", Some(si.0),
            &[(modeacc(si.3.as_deref().unwrap_or("cash")), si.2, z), (ac("2200"), z, si.2)]).await?; count += 1;
    }
    // ---- Scheme closures paid in cash (exclude those redeemed into a sale) ----
    let scloses = sqlx::query_as::<_, (i64, String, Decimal, Decimal, bool)>(
        "SELECT id, COALESCE(closed_at::date::text, created_at::date::text), COALESCE(total_paid,0), \
            COALESCE(maturity_value,0), (matured_at IS NOT NULL) \
         FROM scheme WHERE branch_id=$1 AND status='closed' \
           AND id NOT IN (SELECT redeemed_scheme_id FROM invoice WHERE redeemed_scheme_id IS NOT NULL)")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for sc in &scloses {
        let (id, date, paid, mv, matured) = (sc.0, &sc.1, sc.2, sc.3, sc.4);
        let value = if matured && mv > z { mv } else { paid };
        let bonus = value - paid;
        let mut lines = vec![(ac("2200"), paid, z)];        // clear the deposit liability
        if bonus > z { lines.push((ac("5900"), bonus, z)); } // maturity bonus = expense
        else if bonus < z { lines.push((ac("5900"), z, -bonus)); }
        lines.push((ac("1000"), z, value));                  // paid out in cash
        post_je(&mut tx, branch, date, "Scheme closed (cash)", "scheme_close", Some(id), &lines).await?; count += 1;
    }

    // ---- Payroll (paid runs) ----
    let slips = sqlx::query_as::<_, (i64, String, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT ps.id, pr.created_at::date::text, COALESCE(ps.gross,0), COALESCE(ps.pf,0), COALESCE(ps.esi,0), \
            COALESCE(ps.pt,0), COALESCE(ps.tds,0), COALESCE(ps.loan_recovery,0), COALESCE(ps.deductions,0), COALESCE(ps.net_pay,0) \
         FROM payslip ps JOIN payroll_run pr ON pr.id=ps.payroll_run_id WHERE pr.branch_id=$1 AND pr.status='paid'")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for ps in &slips {
        let (id, date, gross, pf, esi, pt, tds, loan, ded, net) = (ps.0, &ps.1, ps.2, ps.3, ps.4, ps.5, ps.6, ps.7, ps.8, ps.9);
        let statutory = pf + esi + pt + tds + ded;
        let mut lines = vec![(ac("5100"), gross, z)];
        if statutory > z { lines.push((ac("2400"), z, statutory)); }
        if loan > z { lines.push((ac("1300"), z, loan)); }   // recover staff loan
        lines.push((bankacc("salary", id), z, net));          // net paid via bank
        // balancing round-off if any
        let credited = statutory + loan + net;
        let diff = gross - credited;
        if diff > z { lines.push((ac("5990"), diff, z)); } else if diff < z { lines.push((ac("5990"), z, -diff)); }
        post_je(&mut tx, branch, date, "Salary paid", "payroll", Some(id), &lines).await?; count += 1;
    }

    // ---- Staff advances / loans given ----
    let sadv = sqlx::query_as::<_, (i64, String, Decimal)>(
        "SELECT id, created_at::date::text, COALESCE(amount,0) FROM staff_advance WHERE branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for a in &sadv {
        post_je(&mut tx, branch, &a.1, "Staff loan/advance given", "staff_advance", Some(a.0),
            &[(ac("1300"), a.2, z), (bankacc("staff_advance", a.0), z, a.2)]).await?; count += 1;
    }

    // ---- Manual expenses ----
    let exps = sqlx::query_as::<_, (i64, String, i64, Decimal, String)>(
        "SELECT id, expense_date::text, account_id, COALESCE(amount,0), mode FROM expense WHERE branch_id=$1")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for e in &exps {
        post_je(&mut tx, branch, &e.1, "Expense", "expense", Some(e.0),
            &[(e.2, e.3, z), (modeacc(&e.4), z, e.3)]).await?; count += 1;
    }

    // ---- Day-close cash variance (shortage/excess) → Cash Short/Over ----
    let dayvar = sqlx::query_as::<_, (i64, String, Decimal)>(
        "SELECT id, business_date::text, COALESCE(cash_variance,0) FROM day_session \
         WHERE branch_id=$1 AND status IN ('closed','reopened') AND COALESCE(cash_variance,0) <> 0")
        .bind(branch).fetch_all(&mut *tx).await.map_err(internal)?;
    for d in &dayvar {
        let v = d.2;
        let lines = if v < z {
            vec![(ac("5995"), -v, z), (ac("1000"), z, -v)]   // shortage: expense up, cash down
        } else {
            vec![(ac("1000"), v, z), (ac("5995"), z, v)]      // excess: cash up, contra-expense
        };
        post_je(&mut tx, branch, &d.1, "Cash short/over (day close)", "day_close", Some(d.0), &lines).await?; count += 1;
    }

    // ---- Closing stock (periodic inventory adjustment, dated latest) ----
    let stock_val: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(cost_value),0) FROM item WHERE branch_id=$1 AND ownership_state='in_stock'")
        .bind(branch).fetch_one(&mut *tx).await.map_err(internal)?;
    let latest: Option<String> = sqlx::query_scalar(
        "SELECT greatest(COALESCE((SELECT max(created_at::date) FROM invoice WHERE branch_id=$1),'2026-04-01'), \
                         COALESCE((SELECT max(created_at::date) FROM purchase_bill WHERE branch_id=$1),'2026-04-01'))::text")
        .bind(branch).fetch_optional(&mut *tx).await.map_err(internal)?.flatten();
    if stock_val > z {
        let d = latest.unwrap_or_else(|| "2026-07-05".to_string());
        post_je(&mut tx, branch, &d, "Closing stock", "closing_stock", None,
            &[(ac("1200"), stock_val, z), (ac("4200"), z, stock_val)]).await?; count += 1;
    }

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "entries": count })))
}

async fn accounts_coa(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, String, String, bool, bool, i32)>(
        "SELECT id, code, name, type, system, active, sort_order FROM chart_of_account ORDER BY sort_order, code")
        .fetch_all(&s.db).await.map_err(internal)?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.0, "code": r.1, "name": r.2, "type": r.3, "system": r.4, "active": r.5, "sort_order": r.6 })).collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct NewAccount { code: String, name: String, #[serde(rename = "type")] type_: String }
async fn accounts_create(State(s): State<AppState>, auth: AuthUser, Json(n): Json<NewAccount>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO chart_of_account (code, name, type, system, sort_order) VALUES ($1,$2,$3,false,900) RETURNING id")
        .bind(&n.code).bind(&n.name).bind(&n.type_).fetch_one(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct NewExpense { expense_date: String, account_id: i64, amount: Decimal, mode: Option<String>, reference: Option<String>, note: Option<String> }
async fn accounts_expense_create(State(s): State<AppState>, auth: AuthUser, Json(n): Json<NewExpense>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    assert_not_locked(&s.db, &n.expense_date).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO expense (branch_id, expense_date, account_id, amount, mode, reference, note) \
         VALUES ($1,$2::date,$3,$4,$5,$6,$7) RETURNING id")
        .bind(s.default_branch).bind(&n.expense_date).bind(n.account_id).bind(n.amount)
        .bind(n.mode.as_deref().unwrap_or("cash")).bind(n.reference.as_deref()).bind(n.note.as_deref())
        .fetch_one(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}
async fn accounts_expense_list(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, String, String, Decimal, String, Option<String>)>(
        "SELECT e.id, e.expense_date::text, a.code, a.name, e.amount, e.mode, e.note \
         FROM expense e JOIN chart_of_account a ON a.id=e.account_id WHERE e.branch_id=$1 ORDER BY e.expense_date DESC, e.id DESC")
        .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.0, "date": r.1, "account_code": r.2, "account": r.3, "amount": r.4.to_string(), "mode": r.5, "note": r.6 })).collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct NewReceipt { party_id: i64, receipt_date: String, amount: Decimal, mode: Option<String>, reference: Option<String>, note: Option<String> }
async fn customer_receipt_create(State(s): State<AppState>, auth: AuthUser, Json(n): Json<NewReceipt>) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    assert_not_locked(&s.db, &n.receipt_date).await?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO customer_receipt (branch_id, party_id, receipt_date, amount, mode, reference, note) \
         VALUES ($1,$2,$3::date,$4,$5,$6,$7) RETURNING id")
        .bind(s.default_branch).bind(n.party_id).bind(&n.receipt_date).bind(n.amount)
        .bind(n.mode.as_deref().unwrap_or("cash")).bind(n.reference.as_deref()).bind(n.note.as_deref())
        .fetch_one(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}
async fn customer_receipt_list(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, String, Decimal, String, Option<String>)>(
        "SELECT r.id, r.receipt_date::text, p.display_name, r.amount, r.mode, r.note \
         FROM customer_receipt r JOIN party p ON p.id=r.party_id WHERE r.branch_id=$1 ORDER BY r.receipt_date DESC, r.id DESC")
        .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.0, "date": r.1, "party": r.2, "amount": r.3.to_string(), "mode": r.4, "note": r.5 })).collect();
    Ok(Json(json!(out)))
}

async fn accounts_trial_balance(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, String, String, Decimal, Decimal)>(
        "SELECT a.code, a.name, a.type, COALESCE(sum(jl.debit),0), COALESCE(sum(jl.credit),0) \
         FROM chart_of_account a JOIN journal_line jl ON jl.account_id=a.id \
         JOIN journal_entry je ON je.id=jl.entry_id \
         WHERE je.entry_date BETWEEN $1::date AND $2::date \
         GROUP BY a.code, a.name, a.type, a.sort_order HAVING COALESCE(sum(jl.debit),0) <> COALESCE(sum(jl.credit),0) \
         ORDER BY a.sort_order, a.code")
        .bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut td, mut tc) = (Decimal::ZERO, Decimal::ZERO);
    let items: Vec<Value> = rows.iter().map(|r| {
        let bal = r.3 - r.4;
        let (dr, cr) = if bal >= Decimal::ZERO { (bal, Decimal::ZERO) } else { (Decimal::ZERO, -bal) };
        td += dr; tc += cr;
        json!({ "code": r.0, "account": r.1, "type": r.2, "debit": dr.to_string(), "credit": cr.to_string() })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "debit": td.to_string(), "credit": tc.to_string() } })))
}

async fn accounts_pnl(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, String, Decimal)>(
        "SELECT a.type, a.name, COALESCE(sum(jl.credit - jl.debit),0) \
         FROM chart_of_account a JOIN journal_line jl ON jl.account_id=a.id JOIN journal_entry je ON je.id=jl.entry_id \
         WHERE a.type IN ('income','expense') AND je.entry_date BETWEEN $1::date AND $2::date \
         GROUP BY a.type, a.name, a.sort_order ORDER BY a.sort_order")
        .bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut income, mut expense) = (Decimal::ZERO, Decimal::ZERO);
    let (mut inc_rows, mut exp_rows): (Vec<Value>, Vec<Value>) = (vec![], vec![]);
    for r in &rows {
        if r.0 == "income" { income += r.2; inc_rows.push(json!({ "account": r.1, "amount": r.2.to_string() })); }
        else { let amt = -r.2; expense += amt; exp_rows.push(json!({ "account": r.1, "amount": amt.to_string() })); }
    }
    Ok(Json(json!({
        "income": inc_rows, "expenses": exp_rows,
        "total_income": income.to_string(), "total_expense": expense.to_string(),
        "net_profit": (income - expense).to_string() })))
}

async fn accounts_balance_sheet(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    // As-of `to`: balances of asset/liability/equity accounts + net profit into equity.
    let rows = sqlx::query_as::<_, (String, String, Decimal, Decimal)>(
        "SELECT a.type, a.name, COALESCE(sum(jl.debit),0), COALESCE(sum(jl.credit),0) \
         FROM chart_of_account a JOIN journal_line jl ON jl.account_id=a.id JOIN journal_entry je ON je.id=jl.entry_id \
         WHERE je.entry_date <= $1::date GROUP BY a.type, a.name, a.sort_order ORDER BY a.sort_order")
        .bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let (mut assets, mut liabs, mut equity) = (vec![], vec![], vec![]);
    let (mut ta, mut tl, mut te, mut income, mut expense) = (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    for r in &rows {
        let dr = r.2; let cr = r.3;
        match r.0.as_str() {
            "asset" => { let b = dr - cr; ta += b; assets.push(json!({ "account": r.1, "amount": b.to_string() })); }
            "liability" => { let b = cr - dr; tl += b; liabs.push(json!({ "account": r.1, "amount": b.to_string() })); }
            "equity" => { let b = cr - dr; te += b; equity.push(json!({ "account": r.1, "amount": b.to_string() })); }
            "income" => { income += cr - dr; }
            "expense" => { expense += dr - cr; }
            _ => {}
        }
    }
    let net_profit = income - expense;
    equity.push(json!({ "account": "Net profit (period)", "amount": net_profit.to_string() }));
    te += net_profit;
    Ok(Json(json!({
        "assets": assets, "liabilities": liabs, "equity": equity,
        "total_assets": ta.to_string(), "total_liabilities": tl.to_string(), "total_equity": te.to_string(),
        "balanced": (ta - (tl + te)).abs() < Decimal::new(1, 0) })))
}

#[derive(Deserialize)]
struct LedgerQ { account_id: i64, from: String, to: String }
async fn accounts_ledger(State(s): State<AppState>, auth: AuthUser, Query(q): Query<LedgerQ>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let opening: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(sum(jl.debit - jl.credit),0) FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id \
         WHERE jl.account_id=$1 AND je.entry_date < $2::date")
        .bind(q.account_id).bind(&q.from).fetch_one(&s.db).await.map_err(internal)?;
    let rows = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<i64>, Decimal, Decimal)>(
        "SELECT je.entry_date::text, je.narration, je.source_type, je.source_id, jl.debit, jl.credit \
         FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id \
         WHERE jl.account_id=$1 AND je.entry_date BETWEEN $2::date AND $3::date ORDER BY je.entry_date, je.id")
        .bind(q.account_id).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let mut bal = opening;
    let items: Vec<Value> = rows.iter().map(|r| {
        bal += r.4 - r.5;
        json!({ "date": r.0, "narration": r.1, "source": r.2, "source_id": r.3,
                "debit": r.4.to_string(), "credit": r.5.to_string(), "balance": bal.to_string() })
    }).collect();
    Ok(Json(json!({ "opening": opening.to_string(), "rows": items, "closing": bal.to_string() })))
}

async fn accounts_journal(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, String, String, Decimal, Decimal)>(
        "SELECT je.id, je.entry_date::text, je.narration, je.source_type, a.code, a.name, jl.debit, jl.credit \
         FROM journal_entry je JOIN journal_line jl ON jl.entry_id=je.id JOIN chart_of_account a ON a.id=jl.account_id \
         WHERE je.entry_date BETWEEN $1::date AND $2::date ORDER BY je.entry_date, je.id, jl.id")
        .bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let items: Vec<Value> = rows.iter().map(|r| json!({
        "entry_id": r.0, "date": r.1, "narration": r.2, "source": r.3,
        "account_code": r.4, "account": r.5, "debit": r.6.to_string(), "credit": r.7.to_string() })).collect();
    Ok(Json(json!({ "rows": items })))
}

// ===================== Bank accounts & reconciliation =====================

const BANK_MOVEMENTS: &str = "\
    SELECT 'tender'::text st, t.id sid, t.created_at::date d, t.amount amt, t.mode, i.document_no ref \
      FROM invoice_tender t JOIN invoice i ON i.id=t.invoice_id WHERE t.mode <> 'cash' \
    UNION ALL SELECT 'receipt', r.id, r.receipt_date, r.amount, r.mode, p.display_name \
      FROM customer_receipt r JOIN party p ON p.id=r.party_id WHERE r.mode <> 'cash' \
    UNION ALL SELECT 'purchase_payment', pp.id, pp.created_at::date, -pp.amount, pp.mode, pb.document_no \
      FROM purchase_payment pp JOIN purchase_bill pb ON pb.id=pp.purchase_bill_id WHERE pp.mode <> 'cash' \
    UNION ALL SELECT 'expense', e.id, e.expense_date, -e.amount, e.mode, e.note FROM expense e WHERE e.mode <> 'cash' \
    UNION ALL SELECT 'salary', ps.id, pr.created_at::date, -COALESCE(ps.net_pay,0), 'bank', 'Salary' \
      FROM payslip ps JOIN payroll_run pr ON pr.id=ps.payroll_run_id WHERE pr.status='paid' \
    UNION ALL SELECT 'staff_advance', sa.id, sa.created_at::date, -COALESCE(sa.amount,0), 'bank', 'Staff advance' FROM staff_advance sa";

async fn bank_accounts_list(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, Option<String>, Decimal, bool, bool, String)>(
        "SELECT id, name, bank_name, account_no, ifsc, opening_balance, is_primary, active, account_type FROM bank_account ORDER BY is_primary DESC, id")
        .fetch_all(&s.db).await.map_err(internal)?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.0, "name": r.1, "bank_name": r.2, "account_no": r.3, "ifsc": r.4,
        "opening_balance": r.5.to_string(), "is_primary": r.6, "active": r.7, "account_type": r.8 })).collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct NewBankAccount { name: String, bank_name: Option<String>, account_no: Option<String>, ifsc: Option<String>, opening_balance: Option<Decimal>, is_primary: Option<bool>, account_type: Option<String> }
async fn bank_account_create(State(s): State<AppState>, auth: AuthUser, Json(n): Json<NewBankAccount>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    if n.is_primary.unwrap_or(false) {
        sqlx::query("UPDATE bank_account SET is_primary=false").execute(&mut *tx).await.map_err(internal)?;
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO bank_account (branch_id, name, bank_name, account_no, ifsc, opening_balance, is_primary, account_type) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id")
        .bind(s.default_branch).bind(&n.name).bind(n.bank_name.as_deref()).bind(n.account_no.as_deref())
        .bind(n.ifsc.as_deref()).bind(n.opening_balance.unwrap_or(Decimal::ZERO)).bind(n.is_primary.unwrap_or(false))
        .bind(n.account_type.as_deref().unwrap_or("current"))
        .fetch_one(&mut *tx).await.map_err(internal)?;
    // Give the account its own ledger in the Chart of Accounts (for per-bank balances).
    let coa_id: i64 = sqlx::query_scalar(
        "INSERT INTO chart_of_account (code, name, type, system, sort_order) VALUES ($1,$2,'asset',true,21) \
         ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id")
        .bind(format!("1010.{id}")).bind(&n.name).fetch_one(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE bank_account SET coa_account_id=$1 WHERE id=$2").bind(coa_id).bind(id)
        .execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct UpdBankAccount { name: Option<String>, bank_name: Option<String>, account_no: Option<String>, ifsc: Option<String>, opening_balance: Option<Decimal>, is_primary: Option<bool>, active: Option<bool>, account_type: Option<String> }
async fn bank_account_update(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(n): Json<UpdBankAccount>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    if n.is_primary == Some(true) {
        sqlx::query("UPDATE bank_account SET is_primary=false").execute(&mut *tx).await.map_err(internal)?;
    }
    sqlx::query(
        "UPDATE bank_account SET name=COALESCE($2,name), bank_name=COALESCE($3,bank_name), \
            account_no=COALESCE($4,account_no), ifsc=COALESCE($5,ifsc), \
            opening_balance=COALESCE($6,opening_balance), is_primary=COALESCE($7,is_primary), active=COALESCE($8,active), \
            account_type=COALESCE($9,account_type) \
         WHERE id=$1")
        .bind(id).bind(n.name.as_deref()).bind(n.bank_name.as_deref()).bind(n.account_no.as_deref())
        .bind(n.ifsc.as_deref()).bind(n.opening_balance).bind(n.is_primary).bind(n.active).bind(n.account_type.as_deref())
        .execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct NewTransfer { from_account_id: i64, to_account_id: i64, amount: Decimal, transfer_date: String, reference: Option<String>, note: Option<String> }
async fn bank_transfer_create(State(s): State<AppState>, auth: AuthUser, Json(n): Json<NewTransfer>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    if n.from_account_id == n.to_account_id {
        return Err((StatusCode::BAD_REQUEST, "from and to accounts must differ".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO bank_transfer (branch_id, from_account_id, to_account_id, amount, transfer_date, reference, note) \
         VALUES ($1,$2,$3,$4,$5::date,$6,$7) RETURNING id")
        .bind(s.default_branch).bind(n.from_account_id).bind(n.to_account_id).bind(n.amount)
        .bind(&n.transfer_date).bind(n.reference.as_deref()).bind(n.note.as_deref())
        .fetch_one(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

async fn bank_account_delete(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let is_primary: bool = sqlx::query_scalar("SELECT is_primary FROM bank_account WHERE id=$1")
        .bind(id).fetch_optional(&s.db).await.map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "bank account not found".to_string()))?;
    if is_primary {
        return Err((StatusCode::CONFLICT, "Cannot delete the primary account. Set another account as primary first.".to_string()));
    }
    let transfers: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM bank_transfer WHERE from_account_id=$1 OR to_account_id=$1")
        .bind(id).fetch_one(&s.db).await.map_err(internal)?;
    if transfers > 0 {
        return Err((StatusCode::CONFLICT, "This account has fund transfers and cannot be deleted.".to_string()));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;
    sqlx::query("DELETE FROM bank_recon WHERE bank_account_id=$1").bind(id).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("DELETE FROM bank_account WHERE id=$1").bind(id).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "deleted": true })))
}

async fn bank_reconcile(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let acct: Option<(String, Decimal)> = sqlx::query_as("SELECT name, opening_balance FROM bank_account WHERE id=$1")
        .bind(id).fetch_optional(&s.db).await.map_err(internal)?;
    let (name, opening) = acct.ok_or((StatusCode::NOT_FOUND, "bank account not found".to_string()))?;
    let primary_id: i64 = sqlx::query_scalar("SELECT id FROM bank_account WHERE is_primary ORDER BY id LIMIT 1")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or(0);
    // All movements for this account (regular flows + fund transfers), oldest first for the running balance.
    let rows = sqlx::query_as::<_, (String, i64, String, Option<String>, String, Decimal, bool)>(&format!(
        "WITH base AS ( {BANK_MOVEMENTS} \
            UNION ALL SELECT 'transfer_out'::text, bt.id, bt.transfer_date, -bt.amount, 'transfer', ('To '||ta.name) \
              FROM bank_transfer bt JOIN bank_account ta ON ta.id=bt.to_account_id \
            UNION ALL SELECT 'transfer_in', bt.id, bt.transfer_date, bt.amount, 'transfer', ('From '||fa.name) \
              FROM bank_transfer bt JOIN bank_account fa ON fa.id=bt.from_account_id \
            UNION ALL SELECT 'bank_entry', be.id, be.entry_date, \
              CASE WHEN be.kind IN ('withdrawal','charges','other_debit') THEN -be.amount ELSE be.amount END, \
              be.kind, COALESCE(be.note, be.kind) FROM bank_entry be ), \
         mv AS ( SELECT b.st, b.sid, b.d, b.ref, b.mode, b.amt, \
            CASE WHEN b.st='transfer_out' THEN (SELECT from_account_id FROM bank_transfer WHERE id=b.sid) \
                 WHEN b.st='transfer_in'  THEN (SELECT to_account_id FROM bank_transfer WHERE id=b.sid) \
                 WHEN b.st='bank_entry'   THEN (SELECT bank_account_id FROM bank_entry WHERE id=b.sid) \
                 ELSE COALESCE(br.bank_account_id, $1) END AS acct, \
            COALESCE(br.cleared,false) AS cleared \
          FROM base b LEFT JOIN bank_recon br ON br.source_type=b.st AND br.source_id=b.sid ) \
         SELECT st, sid, d::text, ref, mode, amt, cleared FROM mv WHERE acct=$2 ORDER BY d, sid"))
        .bind(primary_id).bind(id).fetch_all(&s.db).await.map_err(internal)?;
    let (mut running, mut cleared_bal) = (opening, opening);
    let mut items: Vec<Value> = rows.iter().map(|r| {
        running += r.5;
        if r.6 { cleared_bal += r.5; }
        json!({ "source_type": r.0, "source_id": r.1, "date": r.2, "ref": r.3, "mode": r.4,
                "amount": r.5.to_string(), "cleared": r.6, "balance": running.to_string() })
    }).collect();
    items.reverse(); // latest first
    Ok(Json(json!({
        "account": { "id": id, "name": name, "opening_balance": opening.to_string() },
        "book_balance": running.to_string(), "cleared_balance": cleared_bal.to_string(),
        "uncleared": (running - cleared_bal).to_string(), "rows": items })))
}

#[derive(Deserialize)]
struct ReconSet { source_type: String, source_id: i64, bank_account_id: i64, cleared: bool }
async fn bank_recon_set(State(s): State<AppState>, auth: AuthUser, Json(n): Json<ReconSet>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    sqlx::query(
        "INSERT INTO bank_recon (branch_id, source_type, source_id, bank_account_id, cleared, cleared_on) \
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $5 THEN CURRENT_DATE ELSE NULL END) \
         ON CONFLICT (source_type, source_id) DO UPDATE SET \
            bank_account_id=EXCLUDED.bank_account_id, cleared=EXCLUDED.cleared, cleared_on=EXCLUDED.cleared_on")
        .bind(s.default_branch).bind(&n.source_type).bind(n.source_id).bind(n.bank_account_id).bind(n.cleared)
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct NewBankEntry { bank_account_id: i64, entry_date: String, kind: String, amount: Decimal, note: Option<String> }
async fn bank_entry_create(State(s): State<AppState>, auth: AuthUser, Json(n): Json<NewBankEntry>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    assert_not_locked(&s.db, &n.entry_date).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO bank_entry (branch_id, bank_account_id, entry_date, kind, amount, note) \
         VALUES ($1,$2,$3::date,$4,$5,$6) RETURNING id")
        .bind(s.default_branch).bind(n.bank_account_id).bind(&n.entry_date).bind(&n.kind).bind(n.amount).bind(n.note.as_deref())
        .fetch_one(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}
async fn bank_entry_update(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(n): Json<NewBankEntry>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    assert_not_locked(&s.db, &n.entry_date).await?;
    sqlx::query(
        "UPDATE bank_entry SET bank_account_id=$2, entry_date=$3::date, kind=$4, amount=$5, note=$6 WHERE id=$1")
        .bind(id).bind(n.bank_account_id).bind(&n.entry_date).bind(&n.kind).bind(n.amount).bind(n.note.as_deref())
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}
async fn bank_entry_delete(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let d: Option<String> = sqlx::query_scalar("SELECT entry_date::text FROM bank_entry WHERE id=$1")
        .bind(id).fetch_optional(&s.db).await.map_err(internal)?;
    if let Some(d) = d { assert_not_locked(&s.db, &d).await?; }
    sqlx::query("DELETE FROM bank_entry WHERE id=$1").bind(id).execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "deleted": true })))
}

// ===================== Bank statement import & reconciliation matching =====================

/// All bank movements for an account (source_type, source_id, date, signed amount).
async fn account_movements(db: &sqlx::PgPool, primary_id: i64, account_id: i64)
    -> Result<Vec<(String, i64, String, Decimal)>, ApiError> {
    sqlx::query_as::<_, (String, i64, String, Decimal)>(&format!(
        "WITH base AS ( {BANK_MOVEMENTS} \
            UNION ALL SELECT 'transfer_out'::text, bt.id, bt.transfer_date, -bt.amount, 'transfer', ('To '||ta.name) \
              FROM bank_transfer bt JOIN bank_account ta ON ta.id=bt.to_account_id \
            UNION ALL SELECT 'transfer_in', bt.id, bt.transfer_date, bt.amount, 'transfer', ('From '||fa.name) \
              FROM bank_transfer bt JOIN bank_account fa ON fa.id=bt.from_account_id \
            UNION ALL SELECT 'bank_entry', be.id, be.entry_date, \
              CASE WHEN be.kind IN ('withdrawal','charges','other_debit') THEN -be.amount ELSE be.amount END, \
              be.kind, COALESCE(be.note, be.kind) FROM bank_entry be ), \
         mv AS ( SELECT b.st, b.sid, b.d, b.amt, \
            CASE WHEN b.st='transfer_out' THEN (SELECT from_account_id FROM bank_transfer WHERE id=b.sid) \
                 WHEN b.st='transfer_in'  THEN (SELECT to_account_id FROM bank_transfer WHERE id=b.sid) \
                 WHEN b.st='bank_entry'   THEN (SELECT bank_account_id FROM bank_entry WHERE id=b.sid) \
                 ELSE COALESCE(br.bank_account_id, $1) END AS acct \
          FROM base b LEFT JOIN bank_recon br ON br.source_type=b.st AND br.source_id=b.sid ) \
         SELECT st, sid, d::text, amt FROM mv WHERE acct=$2 ORDER BY d"))
        .bind(primary_id).bind(account_id).fetch_all(db).await.map_err(internal)
}

async fn matched_movement_keys(db: &sqlx::PgPool, account_id: i64) -> Result<std::collections::HashSet<(String, i64)>, ApiError> {
    let rows = sqlx::query_as::<_, (Option<String>, Option<i64>)>(
        "SELECT matched_source_type, matched_source_id FROM stmt_line \
         WHERE bank_account_id=$1 AND match_status='matched' AND matched_source_id IS NOT NULL")
        .bind(account_id).fetch_all(db).await.map_err(internal)?;
    Ok(rows.into_iter().filter_map(|(t, i)| Some((t?, i?))).collect())
}

async fn clear_recon(db: &sqlx::PgPool, branch: i64, st: &str, sid: i64, acct: i64, cleared: bool) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO bank_recon (branch_id, source_type, source_id, bank_account_id, cleared, cleared_on) \
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $5 THEN CURRENT_DATE ELSE NULL END) \
         ON CONFLICT (source_type, source_id) DO UPDATE SET bank_account_id=EXCLUDED.bank_account_id, cleared=EXCLUDED.cleared, cleared_on=EXCLUDED.cleared_on")
        .bind(branch).bind(st).bind(sid).bind(acct).bind(cleared).execute(db).await.map_err(internal)?;
    Ok(())
}

fn pdate(s: &str) -> Option<chrono::NaiveDate> { chrono::NaiveDate::parse_from_str(&s[..s.len().min(10)], "%Y-%m-%d").ok() }

#[derive(Deserialize)]
struct StmtLineIn { date: Option<String>, description: Option<String>, ref_no: Option<String>, debit: Option<Decimal>, credit: Option<Decimal>, balance: Option<Decimal> }
#[derive(Deserialize)]
struct NewImport { bank_account_id: i64, filename: Option<String>, format: Option<String>, window_days: Option<i64>, lines: Vec<StmtLineIn> }

async fn create_statement_import(State(s): State<AppState>, auth: AuthUser, Json(req): Json<NewImport>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let acct = req.bank_account_id;
    let window = req.window_days.unwrap_or(4);
    let branch = s.default_branch;
    let import_id: i64 = sqlx::query_scalar(
        "INSERT INTO stmt_import (branch_id, bank_account_id, filename, format, line_count) VALUES ($1,$2,$3,$4,$5) RETURNING id")
        .bind(branch).bind(acct).bind(req.filename.as_deref()).bind(req.format.as_deref()).bind(req.lines.len() as i32)
        .fetch_one(&s.db).await.map_err(internal)?;
    let mut inserted: Vec<(i64, Option<chrono::NaiveDate>, Decimal)> = Vec::new();
    for l in &req.lines {
        let (debit, credit) = (l.debit.unwrap_or(Decimal::ZERO), l.credit.unwrap_or(Decimal::ZERO));
        let amount = credit - debit;
        let lid: i64 = sqlx::query_scalar(
            "INSERT INTO stmt_line (import_id, bank_account_id, txn_date, description, ref_no, debit, credit, amount, balance) \
             VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9) RETURNING id")
            .bind(import_id).bind(acct).bind(l.date.as_deref()).bind(l.description.as_deref()).bind(l.ref_no.as_deref())
            .bind(debit).bind(credit).bind(amount).bind(l.balance)
            .fetch_one(&s.db).await.map_err(internal)?;
        inserted.push((lid, l.date.as_deref().and_then(pdate), amount));
    }
    // Auto-match against book movements.
    let primary_id: i64 = sqlx::query_scalar("SELECT id FROM bank_account WHERE is_primary ORDER BY id LIMIT 1")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or(0);
    let movs_raw = account_movements(&s.db, primary_id, acct).await?;
    let movs: Vec<(String, i64, Option<chrono::NaiveDate>, Decimal)> =
        movs_raw.into_iter().map(|(st, sid, d, amt)| { let pd = pdate(&d); (st, sid, pd, amt) }).collect();
    let mut used = matched_movement_keys(&s.db, acct).await?;
    let mut matched = 0i64;
    for (lid, ldate, lamt) in &inserted {
        let mut best: Option<usize> = None;
        let mut best_dd: i64 = i64::MAX;
        for (i, (mst, msid, mdate, mamt)) in movs.iter().enumerate() {
            if used.contains(&(mst.clone(), *msid)) { continue; }
            if round_money(*mamt) != round_money(*lamt) { continue; }
            let dd = match (ldate, mdate) { (Some(a), Some(b)) => (*a - *b).num_days().abs(), _ => window };
            if dd <= window && dd < best_dd { best_dd = dd; best = Some(i); }
        }
        if let Some(i) = best {
            let (mst, msid, _, _) = &movs[i];
            used.insert((mst.clone(), *msid));
            sqlx::query("UPDATE stmt_line SET match_status='matched', matched_source_type=$2, matched_source_id=$3 WHERE id=$1")
                .bind(lid).bind(mst).bind(msid).execute(&s.db).await.map_err(internal)?;
            clear_recon(&s.db, branch, mst, *msid, acct, true).await?;
            matched += 1;
        }
    }
    Ok(Json(json!({ "import_id": import_id, "lines": inserted.len(), "matched": matched, "unmatched": inserted.len() as i64 - matched })))
}

async fn get_statement_import(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let head: Option<(i64, Option<String>, String, String)> = sqlx::query_as(
        "SELECT si.bank_account_id, si.filename, si.imported_at::text, ba.name \
         FROM stmt_import si JOIN bank_account ba ON ba.id=si.bank_account_id WHERE si.id=$1")
        .bind(id).fetch_optional(&s.db).await.map_err(internal)?;
    let (acct, filename, imported_at, acct_name) = head.ok_or((StatusCode::NOT_FOUND, "import not found".to_string()))?;
    let lines = sqlx::query_as::<_, (i64, Option<String>, Option<String>, Option<String>, Decimal, Decimal, Decimal, Option<Decimal>, String, Option<String>, Option<i64>)>(
        "SELECT id, txn_date::text, description, ref_no, debit, credit, amount, balance, match_status, matched_source_type, matched_source_id \
         FROM stmt_line WHERE import_id=$1 ORDER BY txn_date, id")
        .bind(id).fetch_all(&s.db).await.map_err(internal)?;
    let line_items: Vec<Value> = lines.iter().map(|r| json!({
        "id": r.0, "date": r.1, "description": r.2, "ref_no": r.3, "debit": r.4.to_string(), "credit": r.5.to_string(),
        "amount": r.6.to_string(), "balance": r.7.map(|d| d.to_string()), "match_status": r.8,
        "matched_source_type": r.9, "matched_source_id": r.10 })).collect();
    // Candidate book movements (unmatched ones are selectable for manual matching).
    let primary_id: i64 = sqlx::query_scalar("SELECT id FROM bank_account WHERE is_primary ORDER BY id LIMIT 1")
        .fetch_optional(&s.db).await.map_err(internal)?.unwrap_or(0);
    let movs = account_movements(&s.db, primary_id, acct).await?;
    let used = matched_movement_keys(&s.db, acct).await?;
    let mov_items: Vec<Value> = movs.iter().map(|(st, sid, d, amt)| json!({
        "source_type": st, "source_id": sid, "date": d, "amount": amt.to_string(),
        "matched": used.contains(&(st.clone(), *sid)) })).collect();
    let matched = lines.iter().filter(|r| r.8 == "matched").count();
    Ok(Json(json!({
        "import": { "id": id, "filename": filename, "imported_at": imported_at, "account_id": acct, "account_name": acct_name },
        "lines": line_items, "movements": mov_items,
        "summary": { "total": lines.len(), "matched": matched, "unmatched": lines.len() - matched } })))
}

#[derive(Deserialize)]
struct MatchReq { source_type: String, source_id: i64 }
async fn stmt_line_match(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(m): Json<MatchReq>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let acct: i64 = sqlx::query_scalar("SELECT bank_account_id FROM stmt_line WHERE id=$1")
        .bind(id).fetch_optional(&s.db).await.map_err(internal)?.ok_or((StatusCode::NOT_FOUND, "line not found".to_string()))?;
    sqlx::query("UPDATE stmt_line SET match_status='matched', matched_source_type=$2, matched_source_id=$3 WHERE id=$1")
        .bind(id).bind(&m.source_type).bind(m.source_id).execute(&s.db).await.map_err(internal)?;
    clear_recon(&s.db, s.default_branch, &m.source_type, m.source_id, acct, true).await?;
    Ok(Json(json!({ "ok": true })))
}
async fn stmt_line_unmatch(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let row: Option<(i64, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT bank_account_id, matched_source_type, matched_source_id FROM stmt_line WHERE id=$1")
        .bind(id).fetch_optional(&s.db).await.map_err(internal)?;
    if let Some((acct, Some(st), Some(sid))) = row {
        clear_recon(&s.db, s.default_branch, &st, sid, acct, false).await?;
    }
    sqlx::query("UPDATE stmt_line SET match_status='unmatched', matched_source_type=NULL, matched_source_id=NULL WHERE id=$1")
        .bind(id).execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}
async fn stmt_line_create_entry(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let row: Option<(i64, Option<String>, Decimal, Option<String>)> = sqlx::query_as(
        "SELECT bank_account_id, txn_date::text, amount, description FROM stmt_line WHERE id=$1")
        .bind(id).fetch_optional(&s.db).await.map_err(internal)?;
    let (acct, date, amount, desc) = row.ok_or((StatusCode::NOT_FOUND, "line not found".to_string()))?;
    let kind = if amount >= Decimal::ZERO { "other_credit" } else { "other_debit" };
    let entry_id: i64 = sqlx::query_scalar(
        "INSERT INTO bank_entry (branch_id, bank_account_id, entry_date, kind, amount, note) VALUES ($1,$2,$3::date,$4,$5,$6) RETURNING id")
        .bind(s.default_branch).bind(acct).bind(date.as_deref()).bind(kind).bind(amount.abs()).bind(desc.as_deref())
        .fetch_one(&s.db).await.map_err(internal)?;
    sqlx::query("UPDATE stmt_line SET match_status='matched', matched_source_type='bank_entry', matched_source_id=$2 WHERE id=$1")
        .bind(id).bind(entry_id).execute(&s.db).await.map_err(internal)?;
    clear_recon(&s.db, s.default_branch, "bank_entry", entry_id, acct, true).await?;
    Ok(Json(json!({ "ok": true, "bank_entry_id": entry_id })))
}

async fn list_statement_imports(State(s): State<AppState>, auth: AuthUser, Query(q): Query<std::collections::HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let acct: i64 = q.get("account_id").and_then(|v| v.parse().ok()).unwrap_or(0);
    let rows = sqlx::query_as::<_, (i64, Option<String>, String, i32, i64)>(
        "SELECT si.id, si.filename, si.imported_at::text, si.line_count, \
            (SELECT count(*) FROM stmt_line l WHERE l.import_id=si.id AND l.match_status='matched') \
         FROM stmt_import si WHERE si.bank_account_id=$1 ORDER BY si.imported_at DESC")
        .bind(acct).fetch_all(&s.db).await.map_err(internal)?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.0, "filename": r.1, "imported_at": r.2, "line_count": r.3, "matched": r.4 })).collect();
    Ok(Json(json!(out)))
}
async fn delete_statement_import(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    sqlx::query("DELETE FROM stmt_import WHERE id=$1").bind(id).execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "deleted": true })))
}

// ===================== Day close (cash) =====================

/// All CASH movements (physical drawer), signed +in / −out, with a source label.
/// Mirror of BANK_MOVEMENTS but for mode='cash'; salary/staff-advances are treated
/// as bank (not cash) per the existing convention.
const CASH_MOVEMENTS: &str = "\
    SELECT t.created_at::date d, t.amount amt, 'Cash sales'::text src FROM invoice_tender t WHERE t.mode='cash' \
    UNION ALL SELECT r.receipt_date, r.amount, 'Receipts' FROM customer_receipt r WHERE r.mode='cash' \
    UNION ALL SELECT si.paid_at::date, si.amount, 'Scheme collections' FROM scheme_installment si WHERE si.payment_mode='cash' \
    UNION ALL SELECT ca.created_at::date, ca.amount, 'Advances' FROM customer_advance ca WHERE ca.payment_mode='cash' \
    UNION ALL SELECT pp.created_at::date, -pp.amount, 'Purchase payments' FROM purchase_payment pp WHERE pp.mode='cash' \
    UNION ALL SELECT e.expense_date, -e.amount, 'Expenses' FROM expense e WHERE e.mode='cash'";

#[derive(Deserialize)]
struct DayCloseQuery { date: String }

/// The day's cash-in / cash-out totals for a single business date.
async fn day_cash_flows(s: &AppState, date: &str) -> Result<(Decimal, Decimal), ApiError> {
    let (cin, cout): (Decimal, Decimal) = sqlx::query_as(&format!(
        "WITH mv AS ({CASH_MOVEMENTS}) SELECT \
            COALESCE(sum(amt) FILTER (WHERE amt>0),0), \
            COALESCE(-sum(amt) FILTER (WHERE amt<0),0) FROM mv WHERE d=$1::date"))
        .bind(date).fetch_one(&s.db).await.map_err(internal)?;
    Ok((cin, cout))
}

async fn get_day_session(State(s): State<AppState>, auth: AuthUser, Query(q): Query<DayCloseQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let br = s.default_branch;
    let by_src = sqlx::query_as::<_, (String, Decimal)>(&format!(
        "WITH mv AS ({CASH_MOVEMENTS}) SELECT src, COALESCE(sum(amt),0) FROM mv WHERE d=$1::date GROUP BY src ORDER BY src"))
        .bind(&q.date).fetch_all(&s.db).await.map_err(internal)?;
    let (cin, cout) = day_cash_flows(&s, &q.date).await?;
    let sess = sqlx::query_as::<_, (i64, String, Decimal, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<String>, Option<String>, Option<String>, Option<String>)>(
        "SELECT id, status, opening_cash, expected_cash, counted_cash, cash_variance, \
            opening_denoms::text, closing_denoms::text, notes, closed_at::text \
         FROM day_session WHERE branch_id=$1 AND business_date=$2::date")
        .bind(br).bind(&q.date).fetch_optional(&s.db).await.map_err(internal)?;
    let prior: Option<Decimal> = sqlx::query_scalar(
        "SELECT counted_cash FROM day_session WHERE branch_id=$1 AND business_date<$2::date \
            AND counted_cash IS NOT NULL ORDER BY business_date DESC LIMIT 1")
        .bind(br).bind(&q.date).fetch_optional(&s.db).await.map_err(internal)?;
    let opening = sess.as_ref().map(|r| r.2).or(prior).unwrap_or(Decimal::ZERO);
    let expected = opening + cin - cout;
    let src_json: Vec<Value> = by_src.iter().map(|r| json!({ "source": r.0, "amount": r.1.to_string() })).collect();
    let sess_json = sess.as_ref().map(|r| json!({
        "id": r.0, "status": r.1, "opening_cash": r.2.to_string(),
        "expected_cash": r.3.map(|v| v.to_string()), "counted_cash": r.4.map(|v| v.to_string()),
        "cash_variance": r.5.map(|v| v.to_string()),
        "opening_denoms": r.6.as_ref().and_then(|t| serde_json::from_str::<Value>(t).ok()),
        "closing_denoms": r.7.as_ref().and_then(|t| serde_json::from_str::<Value>(t).ok()),
        "notes": r.8, "closed_at": r.9 }));
    let tallies: Vec<Value> = if let Some(r) = sess.as_ref() {
        let rows = sqlx::query_as::<_, (String, Decimal, Decimal, Decimal, Option<String>)>(
            "SELECT checked_at::text, expected, counted, variance, note FROM cash_tally \
             WHERE session_id=$1 ORDER BY checked_at DESC")
            .bind(r.0).fetch_all(&s.db).await.map_err(internal)?;
        rows.iter().map(|t| json!({ "checked_at": t.0, "expected": t.1.to_string(),
            "counted": t.2.to_string(), "variance": t.3.to_string(), "note": t.4 })).collect()
    } else { Vec::new() };
    Ok(Json(json!({
        "business_date": q.date, "session": sess_json,
        "cash_in": cin.to_string(), "cash_out": cout.to_string(),
        "opening_cash": opening.to_string(), "expected_cash": expected.to_string(),
        "proposed_opening": prior.map(|v| v.to_string()), "by_source": src_json, "tallies": tallies })))
}

#[derive(Deserialize)]
struct OpenDay { business_date: String, opening_cash: Decimal, opening_denoms: Option<Value> }
async fn open_day(State(s): State<AppState>, auth: AuthUser, Json(n): Json<OpenDay>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM day_session WHERE branch_id=$1 AND business_date=$2::date")
        .bind(s.default_branch).bind(&n.business_date).fetch_optional(&s.db).await.map_err(internal)?;
    if exists.is_some() {
        return Err((StatusCode::CONFLICT, "This business day is already open.".to_string()));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO day_session (branch_id, business_date, status, opening_cash, opening_denoms, opened_by) \
         VALUES ($1,$2::date,'open',$3,$4,$5) RETURNING id")
        .bind(s.default_branch).bind(&n.business_date).bind(n.opening_cash).bind(n.opening_denoms).bind(auth.id)
        .fetch_one(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct CloseDay { business_date: String, counted_cash: Decimal, closing_denoms: Option<Value>, notes: Option<String> }
async fn close_day(State(s): State<AppState>, auth: AuthUser, Json(n): Json<CloseDay>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let sess: Option<(i64, String, Decimal)> = sqlx::query_as(
        "SELECT id, status, opening_cash FROM day_session WHERE branch_id=$1 AND business_date=$2::date")
        .bind(s.default_branch).bind(&n.business_date).fetch_optional(&s.db).await.map_err(internal)?;
    let (sid, status, opening) = sess.ok_or((StatusCode::NOT_FOUND, "Open this day before closing it.".to_string()))?;
    if status == "closed" {
        return Err((StatusCode::CONFLICT, "This day is already closed. Reopen it to make changes.".to_string()));
    }
    let (cin, cout) = day_cash_flows(&s, &n.business_date).await?;
    let expected = opening + cin - cout;
    let variance = n.counted_cash - expected;
    sqlx::query(
        "UPDATE day_session SET status='closed', expected_cash=$2, counted_cash=$3, cash_variance=$4, \
            closing_denoms=$5, notes=$6, closed_at=now(), closed_by=$7 WHERE id=$1")
        .bind(sid).bind(expected).bind(n.counted_cash).bind(variance)
        .bind(n.closing_denoms).bind(n.notes.as_deref()).bind(auth.id)
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "expected_cash": expected.to_string(), "counted_cash": n.counted_cash.to_string(),
                    "variance": variance.to_string() })))
}

#[derive(Deserialize)]
struct ReopenDay { business_date: String }
async fn reopen_day(State(s): State<AppState>, auth: AuthUser, Json(n): Json<ReopenDay>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query(
        "UPDATE day_session SET status='reopened' WHERE branch_id=$1 AND business_date=$2::date AND status='closed'")
        .bind(s.default_branch).bind(&n.business_date).execute(&s.db).await.map_err(internal)?.rows_affected();
    if rows == 0 {
        return Err((StatusCode::NOT_FOUND, "No closed day found for that date.".to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn list_day_sessions(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (i64, String, String, Decimal, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<String>)>(
        "SELECT id, business_date::text, status, opening_cash, expected_cash, counted_cash, cash_variance, closed_at::text \
         FROM day_session WHERE branch_id=$1 ORDER BY business_date DESC LIMIT 120")
        .bind(s.default_branch).fetch_all(&s.db).await.map_err(internal)?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.0, "business_date": r.1, "status": r.2, "opening_cash": r.3.to_string(),
        "expected_cash": r.4.map(|v| v.to_string()), "counted_cash": r.5.map(|v| v.to_string()),
        "cash_variance": r.6.map(|v| v.to_string()), "closed_at": r.7 })).collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct CashTallyIn { business_date: String, counted: Decimal, denoms: Option<Value>, note: Option<String> }
async fn record_cash_tally(State(s): State<AppState>, auth: AuthUser, Json(n): Json<CashTallyIn>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let sess: Option<(i64, Decimal)> = sqlx::query_as(
        "SELECT id, opening_cash FROM day_session WHERE branch_id=$1 AND business_date=$2::date")
        .bind(s.default_branch).bind(&n.business_date).fetch_optional(&s.db).await.map_err(internal)?;
    let (sid, opening) = sess.ok_or((StatusCode::NOT_FOUND, "Open this day before a spot-check.".to_string()))?;
    let (cin, cout) = day_cash_flows(&s, &n.business_date).await?;
    let expected = opening + cin - cout;
    let variance = n.counted - expected;
    sqlx::query(
        "INSERT INTO cash_tally (session_id, checked_by, expected, counted, variance, denoms, note) \
         VALUES ($1,$2,$3,$4,$5,$6,$7)")
        .bind(sid).bind(auth.id).bind(expected).bind(n.counted).bind(variance).bind(n.denoms).bind(n.note.as_deref())
        .execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "expected": expected.to_string(), "counted": n.counted.to_string(), "variance": variance.to_string() })))
}

async fn report_day_close(State(s): State<AppState>, auth: AuthUser, Query(q): Query<RangeQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, String, Decimal, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<String>, Option<Decimal>, Option<i64>, i64)>(
        "SELECT ds.business_date::text, ds.status, ds.opening_cash, ds.expected_cash, ds.counted_cash, ds.cash_variance, \
            sc.method, \
            CASE WHEN sc.id IS NOT NULL THEN (SELECT COALESCE(sum(l.phys_gross - l.book_gross),0) FROM stock_count_line l WHERE l.count_id=sc.id AND l.phys_gross IS NOT NULL) END, \
            CASE WHEN sc.method='tag' THEN (SELECT count(*) FROM stock_count_scan sn WHERE sn.count_id=sc.id AND sn.status='missing') \
                 WHEN sc.method='category' THEN (SELECT COALESCE(sum(GREATEST(l.book_nos - COALESCE(l.phys_nos,0),0)),0)::bigint FROM stock_count_line l WHERE l.count_id=sc.id AND l.phys_nos IS NOT NULL) \
                 END, \
            (SELECT count(*) FROM cash_tally t WHERE t.session_id=ds.id) \
         FROM day_session ds LEFT JOIN stock_count sc ON sc.session_id=ds.id \
         WHERE ds.branch_id=$1 AND ds.business_date BETWEEN $2::date AND $3::date \
         ORDER BY ds.business_date DESC")
        .bind(s.default_branch).bind(&q.from).bind(&q.to).fetch_all(&s.db).await.map_err(internal)?;
    let mut net_var = Decimal::ZERO;
    let items: Vec<Value> = rows.iter().map(|r| {
        if let Some(v) = r.5 { net_var += v; }
        json!({
            "date": r.0, "status": r.1,
            "opening": r.2.to_string(),
            "expected": r.3.map(|v| v.to_string()), "counted": r.4.map(|v| v.to_string()),
            "cash_variance": r.5.map(|v| v.to_string()),
            "stock_method": r.6, "stock_gross_var": r.7.map(|v| v.to_string()),
            "missing_pcs": r.8, "spot_checks": r.9,
        })
    }).collect();
    Ok(Json(json!({ "rows": items, "totals": { "cash_variance": net_var.to_string() } })))
}

// ===================== Day close (stock) =====================

#[derive(sqlx::FromRow)]
struct BookBucket {
    metal_type_id: i64, metal_name: String, purity_id: i64, purity_label: String,
    category_id: i64, category_name: String, department_id: i64, department_name: String,
    book_nos: i64, book_gross: Decimal, book_stone: Decimal, book_net: Decimal,
    out_nos: i64, out_gross: Decimal, book_ct: Decimal,
}

/// Live book aggregation of tagged stock by Department → Purity → Category.
/// Diamond CT = carat of diamond stones only; Stone = total stone weight;
/// out_* = owned pieces currently off-floor (approval / sale-or-return).
async fn stock_book_buckets(s: &AppState, branch: i64) -> Result<Vec<BookBucket>, ApiError> {
    sqlx::query_as::<_, BookBucket>(
        "SELECT mt.id AS metal_type_id, mt.name AS metal_name, p.id AS purity_id, p.label AS purity_label, \
            COALESCE(ic.id,0) AS category_id, COALESCE(ic.name,'Uncategorised') AS category_name, \
            COALESCE(d.id,0) AS department_id, \
            COALESCE(d.name, CASE WHEN mt.name='gold' THEN 'Gold Ornaments' ELSE initcap(mt.name)||' Ornaments' END) AS department_name, \
            count(*) FILTER (WHERE it.ownership_state='in_stock') AS book_nos, \
            COALESCE(sum(it.gross_weight) FILTER (WHERE it.ownership_state='in_stock'),0) AS book_gross, \
            COALESCE(sum(it.stone_weight) FILTER (WHERE it.ownership_state='in_stock'),0) AS book_stone, \
            COALESCE(sum(it.net_weight) FILTER (WHERE it.ownership_state='in_stock'),0) AS book_net, \
            count(*) FILTER (WHERE it.ownership_state IN ('on_approval_out','sale_or_return_out')) AS out_nos, \
            COALESCE(sum(it.gross_weight) FILTER (WHERE it.ownership_state IN ('on_approval_out','sale_or_return_out')),0) AS out_gross, \
            COALESCE(sum(ds.carat) FILTER (WHERE it.ownership_state='in_stock'),0) AS book_ct \
         FROM item it \
         JOIN metal_type mt ON mt.id=it.metal_type_id \
         JOIN purity p ON p.id=it.purity_id \
         LEFT JOIN item_category ic ON ic.id=it.category_id \
         LEFT JOIN department d ON d.id=it.department_id \
         LEFT JOIN (SELECT ist.item_id, sum(ist.carat) carat FROM item_stone ist \
              JOIN stone_type st ON st.id=ist.stone_type_id WHERE st.category='diamond' GROUP BY ist.item_id) ds ON ds.item_id=it.id \
         WHERE it.branch_id=$1 AND it.ownership_state IN ('in_stock','on_approval_out','sale_or_return_out') \
         GROUP BY d.id, d.name, d.sort_order, mt.name, p.id, p.label, p.karat, ic.id, ic.name, mt.id \
         ORDER BY COALESCE(d.sort_order,999), p.karat DESC NULLS LAST, ic.name")
        .bind(branch).fetch_all(&s.db).await.map_err(internal)
}

fn bucket_key(b: &BookBucket) -> String { format!("dept|{}|{}|{}|{}", b.department_id, b.metal_type_id, b.purity_id, b.category_id) }

#[derive(sqlx::FromRow)]
struct StockLineRow {
    bucket_kind: String, bucket_key: String, group_label: String, category_label: String,
    metal_type_id: Option<i64>, purity_id: Option<i64>, category_id: Option<i64>,
    book_nos: i32, book_gross: Decimal, book_ct: Decimal, book_stone: Decimal, book_net: Decimal,
    out_nos: i32, out_gross: Decimal,
    phys_nos: Option<i32>, phys_gross: Option<Decimal>, phys_ct: Option<Decimal>, phys_stone: Option<Decimal>, phys_net: Option<Decimal>,
}

fn book_bucket_json(b: &BookBucket) -> Value {
    json!({
        "bucket_kind": "metal", "bucket_key": bucket_key(b),
        "group_label": format!("{} {}", b.department_name, b.purity_label),
        "category_label": b.category_name,
        "metal_type_id": b.metal_type_id, "purity_id": b.purity_id,
        "category_id": if b.category_id == 0 { Value::Null } else { json!(b.category_id) },
        "book_nos": b.book_nos, "book_gross": b.book_gross.to_string(), "book_ct": b.book_ct.to_string(),
        "book_stone": b.book_stone.to_string(), "book_net": b.book_net.to_string(),
        "out_nos": b.out_nos, "out_gross": b.out_gross.to_string(),
        "phys_nos": Value::Null, "phys_gross": Value::Null, "phys_ct": Value::Null, "phys_stone": Value::Null, "phys_net": Value::Null,
    })
}

async fn get_stock_count(State(s): State<AppState>, auth: AuthUser, Query(q): Query<DayCloseQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let br = s.default_branch;
    let sess: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, status FROM day_session WHERE branch_id=$1 AND business_date=$2::date")
        .bind(br).bind(&q.date).fetch_optional(&s.db).await.map_err(internal)?;
    let (session_id, session_status) = match sess { Some((id, st)) => (Some(id), Some(st)), None => (None, None) };
    let saved: Option<(i64, String, Option<String>, Option<String>, String, bool)> = if let Some(sid) = session_id {
        sqlx::query_as("SELECT id, status, notes, counted_at::text, method, weigh_mode FROM stock_count WHERE session_id=$1")
            .bind(sid).fetch_optional(&s.db).await.map_err(internal)?
    } else { None };
    let lines: Vec<Value> = if let Some((cid, ..)) = &saved {
        let rows = sqlx::query_as::<_, StockLineRow>(
            "SELECT bucket_kind, bucket_key, group_label, category_label, metal_type_id, purity_id, category_id, \
                book_nos, book_gross, book_ct, book_stone, book_net, out_nos, out_gross, \
                phys_nos, phys_gross, phys_ct, phys_stone, phys_net \
             FROM stock_count_line WHERE count_id=$1 ORDER BY group_label, category_label")
            .bind(cid).fetch_all(&s.db).await.map_err(internal)?;
        rows.iter().map(|r| json!({
            "bucket_kind": r.bucket_kind, "bucket_key": r.bucket_key, "group_label": r.group_label,
            "category_label": r.category_label, "metal_type_id": r.metal_type_id, "purity_id": r.purity_id, "category_id": r.category_id,
            "book_nos": r.book_nos, "book_gross": r.book_gross.to_string(), "book_ct": r.book_ct.to_string(),
            "book_stone": r.book_stone.to_string(), "book_net": r.book_net.to_string(),
            "out_nos": r.out_nos, "out_gross": r.out_gross.to_string(),
            "phys_nos": r.phys_nos, "phys_gross": r.phys_gross.as_ref().map(|v| v.to_string()),
            "phys_ct": r.phys_ct.as_ref().map(|v| v.to_string()), "phys_stone": r.phys_stone.as_ref().map(|v| v.to_string()),
            "phys_net": r.phys_net.as_ref().map(|v| v.to_string()),
        })).collect()
    } else {
        stock_book_buckets(&s, br).await?.iter().map(book_bucket_json).collect()
    };
    let count_json = saved.as_ref().map(|(id, st, notes, at, method, weigh)| json!({ "id": id, "status": st, "notes": notes, "counted_at": at, "method": method, "weigh_mode": weigh }));
    let tag_scans = if let Some((cid, _, _, _, method, weigh)) = &saved {
        if method == "tag" {
            let rows = sqlx::query_as::<_, (String, Option<i64>, Option<String>, Option<String>, Option<String>, Option<Decimal>, Option<Decimal>, Option<Decimal>)>(
                "SELECT s.status, s.item_id, COALESCE(it.sku, s.raw_sku) AS sku, \
                    CASE WHEN it.id IS NULL THEN NULL ELSE initcap(mt.name)||' '||p.label END AS grp, \
                    ic.name AS cat, it.gross_weight, it.net_weight, s.weighed_gross \
                 FROM stock_count_scan s LEFT JOIN item it ON it.id=s.item_id \
                 LEFT JOIN metal_type mt ON mt.id=it.metal_type_id LEFT JOIN purity p ON p.id=it.purity_id \
                 LEFT JOIN item_category ic ON ic.id=it.category_id WHERE s.count_id=$1 ORDER BY s.status, sku")
                .bind(cid).fetch_all(&s.db).await.map_err(internal)?;
            let mut present = 0i64;
            let (mut missing, mut extra): (Vec<Value>, Vec<Value>) = (Vec::new(), Vec::new());
            for r in &rows {
                let item = json!({ "sku": r.2, "group_label": r.3, "category_label": r.4,
                    "gross": r.5.map(|v| v.to_string()), "net": r.6.map(|v| v.to_string()),
                    "weighed_gross": r.7.map(|v| v.to_string()) });
                match r.0.as_str() {
                    "present" => present += 1,
                    "missing" => missing.push(item),
                    "extra" => extra.push(item),
                    _ => {}
                }
            }
            Some(json!({ "present": present, "weigh_mode": weigh, "missing": missing, "extra": extra }))
        } else { None }
    } else { None };
    Ok(Json(json!({ "business_date": q.date, "session_status": session_status, "count": count_json, "lines": lines, "tag_scans": tag_scans })))
}

#[derive(Deserialize)]
struct StockPhysLine { bucket_key: String, phys_nos: Option<i32>, phys_gross: Option<Decimal>, phys_ct: Option<Decimal>, phys_stone: Option<Decimal>, phys_net: Option<Decimal> }
#[derive(Deserialize)]
struct SaveStockCount { business_date: String, method: Option<String>, notes: Option<String>, lines: Vec<StockPhysLine> }

async fn save_stock_count(State(s): State<AppState>, auth: AuthUser, Json(n): Json<SaveStockCount>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let br = s.default_branch;
    let sess: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, status FROM day_session WHERE branch_id=$1 AND business_date=$2::date")
        .bind(br).bind(&n.business_date).fetch_optional(&s.db).await.map_err(internal)?;
    let (sid, status) = sess.ok_or((StatusCode::NOT_FOUND, "Open this day before counting stock.".to_string()))?;
    if status == "closed" {
        return Err((StatusCode::CONFLICT, "This day is closed. Reopen it to edit the stock count.".to_string()));
    }
    let phys: std::collections::HashMap<String, &StockPhysLine> = n.lines.iter().map(|l| (l.bucket_key.clone(), l)).collect();
    let bks = stock_book_buckets(&s, br).await?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    sqlx::query("DELETE FROM stock_count WHERE session_id=$1").bind(sid).execute(&mut *tx).await.map_err(internal)?;
    let cid: i64 = sqlx::query_scalar(
        "INSERT INTO stock_count (session_id, method, status, notes, counted_by) VALUES ($1,$2,'counted',$3,$4) RETURNING id")
        .bind(sid).bind(n.method.as_deref().unwrap_or("category")).bind(n.notes.as_deref()).bind(auth.id)
        .fetch_one(&mut *tx).await.map_err(internal)?;
    for b in &bks {
        let key = bucket_key(b);
        let p = phys.get(&key);
        let group_label = format!("{} {}", b.department_name, b.purity_label);
        sqlx::query(
            "INSERT INTO stock_count_line (count_id, bucket_kind, bucket_key, group_label, category_label, \
                metal_type_id, purity_id, category_id, book_nos, book_gross, book_ct, book_stone, book_net, \
                out_nos, out_gross, phys_nos, phys_gross, phys_ct, phys_stone, phys_net) \
             VALUES ($1,'metal',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)")
            .bind(cid).bind(&key).bind(&group_label).bind(&b.category_name)
            .bind(b.metal_type_id).bind(b.purity_id).bind(if b.category_id == 0 { None } else { Some(b.category_id) })
            .bind(b.book_nos as i32).bind(b.book_gross).bind(b.book_ct).bind(b.book_stone).bind(b.book_net)
            .bind(b.out_nos as i32).bind(b.out_gross)
            .bind(p.and_then(|x| x.phys_nos)).bind(p.and_then(|x| x.phys_gross))
            .bind(p.and_then(|x| x.phys_ct)).bind(p.and_then(|x| x.phys_stone)).bind(p.and_then(|x| x.phys_net))
            .execute(&mut *tx).await.map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true, "lines": bks.len() })))
}

// ---- Tag-scan counting (Phase 3) + full-weigh ----

#[derive(sqlx::FromRow)]
struct ExpectedItem { item_id: i64, sku: String, group_label: String, category_label: String, gross: Decimal, net: Decimal }

async fn get_stock_expected(State(s): State<AppState>, auth: AuthUser, Query(q): Query<DayCloseQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let br = s.default_branch;
    let sess: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, status FROM day_session WHERE branch_id=$1 AND business_date=$2::date")
        .bind(br).bind(&q.date).fetch_optional(&s.db).await.map_err(internal)?;
    let (session_id, session_status) = match sess { Some((id, st)) => (Some(id), Some(st)), None => (None, None) };
    let items = sqlx::query_as::<_, ExpectedItem>(
        "SELECT it.id AS item_id, it.sku AS sku, initcap(mt.name)||' '||p.label AS group_label, \
            COALESCE(ic.name,'Uncategorised') AS category_label, it.gross_weight AS gross, it.net_weight AS net \
         FROM item it JOIN metal_type mt ON mt.id=it.metal_type_id JOIN purity p ON p.id=it.purity_id \
         LEFT JOIN item_category ic ON ic.id=it.category_id \
         WHERE it.branch_id=$1 AND it.ownership_state='in_stock' ORDER BY group_label, category_label, it.sku")
        .bind(br).fetch_all(&s.db).await.map_err(internal)?;
    let (mut present_ids, mut count_method, mut weigh_mode): (Vec<i64>, Option<String>, bool) = (Vec::new(), None, false);
    if let Some(sid) = session_id {
        let existing: Option<(i64, String, bool)> = sqlx::query_as(
            "SELECT id, method, weigh_mode FROM stock_count WHERE session_id=$1")
            .bind(sid).fetch_optional(&s.db).await.map_err(internal)?;
        if let Some((cid, method, weigh)) = existing {
            count_method = Some(method); weigh_mode = weigh;
            present_ids = sqlx::query_scalar(
                "SELECT item_id FROM stock_count_scan WHERE count_id=$1 AND status='present' AND item_id IS NOT NULL")
                .bind(cid).fetch_all(&s.db).await.map_err(internal)?;
        }
    }
    let items_json: Vec<Value> = items.iter().map(|i| json!({
        "item_id": i.item_id, "sku": i.sku, "group_label": i.group_label,
        "category_label": i.category_label, "gross": i.gross.to_string(), "net": i.net.to_string() })).collect();
    Ok(Json(json!({ "session_status": session_status, "count_method": count_method,
        "weigh_mode": weigh_mode, "items": items_json, "present_ids": present_ids })))
}

#[derive(sqlx::FromRow)]
struct ItemDetail { id: i64, metal_type_id: i64, purity_id: i64, cat: i64, gross: Decimal, stone: Decimal, net: Decimal, ct: Decimal }

#[derive(Deserialize)]
struct TagPresent { item_id: i64, weighed_gross: Option<Decimal> }
#[derive(Deserialize)]
struct TagSave { business_date: String, weigh_mode: Option<bool>, notes: Option<String>, present: Vec<TagPresent>, extra_skus: Vec<String> }

async fn tag_save_stock_count(State(s): State<AppState>, auth: AuthUser, Json(n): Json<TagSave>) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let br = s.default_branch;
    let sess: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, status FROM day_session WHERE branch_id=$1 AND business_date=$2::date")
        .bind(br).bind(&n.business_date).fetch_optional(&s.db).await.map_err(internal)?;
    let (sid, status) = sess.ok_or((StatusCode::NOT_FOUND, "Open this day before counting stock.".to_string()))?;
    if status == "closed" {
        return Err((StatusCode::CONFLICT, "This day is closed. Reopen it to edit the stock count.".to_string()));
    }
    let weigh = n.weigh_mode.unwrap_or(false);
    let details = sqlx::query_as::<_, ItemDetail>(
        "SELECT it.id AS id, it.metal_type_id AS metal_type_id, it.purity_id AS purity_id, COALESCE(it.category_id,0) AS cat, \
            it.gross_weight AS gross, it.stone_weight AS stone, it.net_weight AS net, \
            COALESCE((SELECT sum(ist.carat) FROM item_stone ist JOIN stone_type st ON st.id=ist.stone_type_id \
                WHERE ist.item_id=it.id AND st.category='diamond'),0) AS ct \
         FROM item it WHERE it.branch_id=$1 AND it.ownership_state='in_stock'")
        .bind(br).fetch_all(&s.db).await.map_err(internal)?;
    let detail_by_id: std::collections::HashMap<i64, &ItemDetail> = details.iter().map(|d| (d.id, d)).collect();
    let expected_ids: std::collections::HashSet<i64> = details.iter().map(|d| d.id).collect();
    let mut present_ids: Vec<i64> = Vec::new();
    let mut weighed: std::collections::HashMap<i64, Option<Decimal>> = std::collections::HashMap::new();
    for p in &n.present {
        if expected_ids.contains(&p.item_id) { present_ids.push(p.item_id); weighed.insert(p.item_id, p.weighed_gross); }
    }
    present_ids.sort(); present_ids.dedup();
    let present_set: std::collections::HashSet<i64> = present_ids.iter().cloned().collect();
    let missing_ids: Vec<i64> = expected_ids.iter().filter(|id| !present_set.contains(id)).cloned().collect();
    let mut extra: Vec<(Option<i64>, String)> = Vec::new();
    for sku in &n.extra_skus {
        let iid: Option<i64> = sqlx::query_scalar("SELECT id FROM item WHERE branch_id=$1 AND sku=$2")
            .bind(br).bind(sku).fetch_optional(&s.db).await.map_err(internal)?;
        extra.push((iid, sku.clone()));
    }
    let bks = stock_book_buckets(&s, br).await?;
    let mut phys: std::collections::HashMap<String, (i32, Decimal, Decimal, Decimal, Decimal)> = std::collections::HashMap::new();
    for pid in &present_ids {
        if let Some(d) = detail_by_id.get(pid) {
            let key = format!("metal|{}|{}|{}", d.metal_type_id, d.purity_id, d.cat);
            let g = if weigh { weighed.get(pid).cloned().flatten().unwrap_or(d.gross) } else { d.gross };
            let e = phys.entry(key).or_insert((0, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
            e.0 += 1; e.1 += g; e.2 += d.ct; e.3 += d.stone; e.4 += d.net;
        }
    }
    let mut tx = s.db.begin().await.map_err(internal)?;
    sqlx::query("DELETE FROM stock_count WHERE session_id=$1").bind(sid).execute(&mut *tx).await.map_err(internal)?;
    let cid: i64 = sqlx::query_scalar(
        "INSERT INTO stock_count (session_id, method, weigh_mode, status, notes, counted_by) \
         VALUES ($1,'tag',$2,'counted',$3,$4) RETURNING id")
        .bind(sid).bind(weigh).bind(n.notes.as_deref()).bind(auth.id).fetch_one(&mut *tx).await.map_err(internal)?;
    for b in &bks {
        let key = bucket_key(b);
        let p = phys.get(&key).cloned().unwrap_or((0, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
        let group_label = format!("{} {}", b.department_name, b.purity_label);
        sqlx::query(
            "INSERT INTO stock_count_line (count_id, bucket_kind, bucket_key, group_label, category_label, \
                metal_type_id, purity_id, category_id, book_nos, book_gross, book_ct, book_stone, book_net, \
                out_nos, out_gross, phys_nos, phys_gross, phys_ct, phys_stone, phys_net) \
             VALUES ($1,'metal',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)")
            .bind(cid).bind(&key).bind(&group_label).bind(&b.category_name)
            .bind(b.metal_type_id).bind(b.purity_id).bind(if b.category_id == 0 { None } else { Some(b.category_id) })
            .bind(b.book_nos as i32).bind(b.book_gross).bind(b.book_ct).bind(b.book_stone).bind(b.book_net)
            .bind(b.out_nos as i32).bind(b.out_gross)
            .bind(p.0).bind(p.1).bind(p.2).bind(p.3).bind(p.4)
            .execute(&mut *tx).await.map_err(internal)?;
    }
    for pid in &present_ids {
        sqlx::query("INSERT INTO stock_count_scan (count_id, item_id, status, weighed_gross) VALUES ($1,$2,'present',$3)")
            .bind(cid).bind(pid).bind(if weigh { weighed.get(pid).cloned().flatten() } else { None })
            .execute(&mut *tx).await.map_err(internal)?;
    }
    for mid in &missing_ids {
        sqlx::query("INSERT INTO stock_count_scan (count_id, item_id, status) VALUES ($1,$2,'missing')")
            .bind(cid).bind(mid).execute(&mut *tx).await.map_err(internal)?;
    }
    for (iid, raw) in &extra {
        sqlx::query("INSERT INTO stock_count_scan (count_id, item_id, raw_sku, status) VALUES ($1,$2,$3,'extra')")
            .bind(cid).bind(*iid).bind(raw).execute(&mut *tx).await.map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true, "present": present_ids.len(), "missing": missing_ids.len(), "extra": extra.len() })))
}

// ===================== App settings =====================

async fn setting_i64(db: &sqlx::PgPool, key: &str, default: i64) -> i64 {
    sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(default)
}

async fn setting_dec(db: &sqlx::PgPool, key: &str, default: Decimal) -> Decimal {
    sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse::<Decimal>().ok())
        .unwrap_or(default)
}

async fn setting_bool(db: &sqlx::PgPool, key: &str, default: bool) -> bool {
    sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .map(|v| v == "true" || v == "1")
        .unwrap_or(default)
}

async fn list_settings(State(s): State<AppState>, _auth: AuthUser) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (String, String)>("SELECT key, value FROM app_setting")
        .fetch_all(&s.db)
        .await
        .map_err(internal)?;
    let mut map = serde_json::Map::new();
    for (k, v) in rows {
        map.insert(k, Value::String(v));
    }
    Ok(Json(Value::Object(map)))
}

#[derive(Deserialize)]
struct SettingReq {
    key: String,
    value: String,
}

async fn upsert_setting(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(r): Json<SettingReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("user.manage")?;
    sqlx::query(
        "INSERT INTO app_setting (key, value) VALUES ($1, $2) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(&r.key)
    .bind(&r.value)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "key": r.key, "value": r.value })))
}

// ===================== Books: financial-year & data locking =====================

#[derive(Deserialize)]
struct BooksLockReq {
    /// Lock date (YYYY-MM-DD); empty string clears the lock.
    lock_date: Option<String>,
    /// Optional: books-beginning date (go-live).
    begin_date: Option<String>,
}

async fn set_books_lock(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(b): Json<BooksLockReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("books.lock")?;
    let lock = b.lock_date.unwrap_or_default().trim().to_string();
    sqlx::query(
        "INSERT INTO app_setting (key, value) VALUES ('books.lock_date', $1) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(&lock)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    if let Some(bd) = b.begin_date {
        sqlx::query(
            "INSERT INTO app_setting (key, value) VALUES ('books.begin_date', $1) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(bd.trim())
        .execute(&s.db)
        .await
        .map_err(internal)?;
    }
    Ok(Json(json!({ "lock_date": lock })))
}

// ===================== Estimates (same-day quotations) =====================

#[derive(Deserialize)]
struct EstimateCreateReq {
    customer_id: Option<i64>,
    #[serde(default = "default_invoice_type")]
    invoice_type: String,
    #[serde(default)]
    inter_state: bool,
    #[serde(default)]
    unfixed: bool,
    series_code: Option<String>,
    old_gold_value: Option<Decimal>,
    gst_rate: Option<Decimal>,
    lines: Vec<InvoiceLineReq>,
}

struct EstPrepared {
    line_input: Value,
    description: String,
    hsn: Option<String>,
    purity_label: Option<String>,
    gross_weight: Option<Decimal>,
    net_weight: Decimal,
    huid: Option<String>,
    making_label: Option<String>,
    rate: Decimal,
    breakdown: PriceBreakdown,
}

async fn create_estimate(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(req): Json<EstimateCreateReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    if req.lines.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "estimate has no lines".to_string()));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;
    let fy = current_fy();
    let series = req.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let gst_rate = req.gst_rate.unwrap_or_else(|| Decimal::new(3, 2));
    let supply = if req.inter_state {
        Supply::Inter
    } else {
        Supply::Intra
    };
    let branch_id = s.default_branch;

    let mut subtotal = Decimal::ZERO;
    let mut discount_total = Decimal::ZERO;
    let mut tax_total = Decimal::ZERO;
    let mut grand_total = Decimal::ZERO;
    let mut total_fine = Decimal::ZERO;
    let mut prepared: Vec<EstPrepared> = Vec::new();

    for ln in &req.lines {
        let (metal_type_id, purity_id, net_weight, gross_weight, mut description, huid);
        if let Some(iid) = ln.item_id {
            let it: Option<SaleItem> = sqlx::query_as(
                "SELECT sku, net_weight, metal_type_id, purity_id, ownership_state, branch_id \
                 FROM item WHERE id = $1",
            )
            .bind(iid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
            let it = it.ok_or((StatusCode::NOT_FOUND, format!("item {iid} not found")))?;
            let gw: Option<Decimal> =
                sqlx::query_scalar("SELECT gross_weight FROM item WHERE id = $1")
                    .bind(iid)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(internal)?;
            metal_type_id = it.metal_type_id;
            purity_id = it.purity_id;
            net_weight = it.net_weight;
            gross_weight = gw;
            description = ln.description.clone().unwrap_or_default();
            huid = ln.huid.clone();
        } else {
            let mt = ln.metal_type_id.ok_or((
                StatusCode::BAD_REQUEST,
                "loose line needs metal_type_id".to_string(),
            ))?;
            let pid = ln.purity_id.ok_or((
                StatusCode::BAD_REQUEST,
                "loose line needs purity_id".to_string(),
            ))?;
            let nw = ln.net_weight.ok_or((
                StatusCode::BAD_REQUEST,
                "loose line needs net_weight".to_string(),
            ))?;
            metal_type_id = mt;
            purity_id = pid;
            net_weight = nw;
            gross_weight = ln.gross_weight;
            description = ln.description.clone().unwrap_or_default();
            huid = ln.huid.clone();
        }

        let purity_label: Option<String> =
            sqlx::query_scalar("SELECT label FROM purity WHERE id = $1")
                .bind(purity_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?;
        // Clean default description: the piece's category (e.g. "DMD Necklace"), else its
        // department (e.g. "Diamond Ornaments"), else the purity — never "loose".
        if description.trim().is_empty() {
            if let Some(iid) = ln.item_id {
                let names: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                    "SELECT (SELECT name FROM item_category WHERE id=i.category_id), \
                        (SELECT name FROM department WHERE id=i.department_id) FROM item i WHERE i.id=$1")
                    .bind(iid).fetch_optional(&mut *tx).await.map_err(internal)?;
                let (cat, dep) = names.unwrap_or((None, None));
                description = cat.or(dep).or_else(|| purity_label.clone()).unwrap_or_else(|| "Item".to_string());
            } else {
                let dept = resolve_department(&mut tx, ln.department_id, &ln.stones, Some(metal_type_id), Some(purity_id)).await?;
                let dn: Option<String> = if let Some(d) = dept {
                    sqlx::query_scalar("SELECT name FROM department WHERE id=$1").bind(d).fetch_optional(&mut *tx).await.map_err(internal)?
                } else { None };
                description = dn.or_else(|| purity_label.clone()).unwrap_or_else(|| "Item".to_string());
            }
        }

        let is_touch = ln.pricing_mode.as_deref() == Some("touch");

        // Fine (pure) grams for this line — used to bill unfixed sales in metal.
        let line_fine = if is_touch {
            (net_weight * ln.touch_percent.unwrap_or(Decimal::ZERO) / Decimal::from(100)).round_dp(3)
        } else {
            let fineness: i32 = sqlx::query_scalar("SELECT fineness FROM purity WHERE id=$1")
                .bind(purity_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
            (net_weight * Decimal::from(fineness) / Decimal::from(1000)).round_dp(3)
        };
        if req.unfixed {
            total_fine += line_fine;
        }

        let rate = if req.unfixed {
            // Metal unpriced on an unfixed sale — owed in fine grams, fixed later.
            Decimal::ZERO
        } else if is_touch {
            // Effective per-gram rate so that net × rate = chargeable_fine × pure_rate.
            let touch = ln.touch_percent.unwrap_or(Decimal::ZERO);
            let pure = ln.pure_rate.unwrap_or(Decimal::ZERO);
            touch / Decimal::from(100) * pure
        } else {
            match ln.rate_override {
                Some(r) => r,
                None => sqlx::query_scalar::<_, Decimal>(
                    "SELECT sell_rate FROM metal_rate WHERE metal_type_id = $1 AND purity_id = $2 \
                     ORDER BY effective_from DESC LIMIT 1",
                )
                .bind(metal_type_id)
                .bind(purity_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?
                .ok_or((
                    StatusCode::BAD_REQUEST,
                    format!("no rate for metal {metal_type_id} / purity {purity_id}"),
                ))?,
            }
        };

        // In touch mode making/wastage are folded into the touch; otherwise use the inputs.
        let making = if is_touch {
            None
        } else {
            match (ln.making_per_gram, ln.making_percent) {
                (Some(pg), _) => Some(Charge::PerGram(pg)),
                (None, Some(pct)) => Some(Charge::Percent(pct)),
                _ => None,
            }
        };
        let making_label = if is_touch {
            Some(format!("{} touch", ln.touch_percent.unwrap_or(Decimal::ZERO)))
        } else {
            match (ln.making_per_gram, ln.making_percent) {
                (Some(pg), _) => Some(format!("₹{pg}/g")),
                (None, Some(pct)) => Some(format!("{pct}%")),
                _ => None,
            }
        };
        let wastage = if is_touch {
            None
        } else {
            ln.wastage_percent.map(Charge::Percent)
        };
        let stones = match ln.stone_value {
            Some(v) if v > Decimal::ZERO => vec![StonePrice::PerPiece {
                rate: v,
                pieces: Decimal::ONE,
            }],
            _ => vec![],
        };
        let bd = value_line(&LineInput {
            metal_rate_per_gram: rate,
            net_weight,
            making,
            wastage,
            stones,
            discount: ln.discount,
            gst_rate,
            supply,
        });

        subtotal += bd.taxable_value + bd.discount;
        discount_total += bd.discount;
        tax_total += bd.tax_total;
        grand_total += bd.grand_total;

        prepared.push(EstPrepared {
            line_input: serde_json::to_value(ln).map_err(internal)?,
            description,
            hsn: ln.hsn.clone(),
            purity_label,
            gross_weight,
            net_weight,
            huid,
            making_label,
            rate,
            breakdown: bd,
        });
    }

    let old_gold_value = round_money(req.old_gold_value.unwrap_or(Decimal::ZERO));
    let inv_type = if req.invoice_type == "b2b" { "b2b" } else { "retail" };
    let (est_no, document_no) = allocate_doc_no(&mut tx, "estimate", &fy, series).await?;

    let estimate_id: i64 = sqlx::query_scalar(
        "INSERT INTO estimate (branch_id, customer_id, series_code, est_no, document_no, fy, type, \
            inter_state, subtotal, discount_total, tax_total, grand_total, old_gold_value) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id",
    )
    .bind(branch_id)
    .bind(req.customer_id)
    .bind(series)
    .bind(est_no)
    .bind(&document_no)
    .bind(&fy)
    .bind(inv_type)
    .bind(req.inter_state)
    .bind(subtotal)
    .bind(discount_total)
    .bind(tax_total)
    .bind(grand_total)
    .bind(old_gold_value)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    for pl in &prepared {
        let breakdown_json = serde_json::to_value(&pl.breakdown).map_err(internal)?;
        sqlx::query(
            "INSERT INTO estimate_line (estimate_id, line_input, description, hsn, purity_label, \
                gross_weight, net_weight, huid, making_label, rate_used, breakdown_json, \
                taxable_value, line_total) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        )
        .bind(estimate_id)
        .bind(&pl.line_input)
        .bind(&pl.description)
        .bind(pl.hsn.as_deref())
        .bind(pl.purity_label.as_deref())
        .bind(pl.gross_weight)
        .bind(pl.net_weight)
        .bind(pl.huid.as_deref())
        .bind(pl.making_label.as_deref())
        .bind(pl.rate)
        .bind(&breakdown_json)
        .bind(pl.breakdown.taxable_value)
        .bind(pl.breakdown.grand_total)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "estimate_id": estimate_id,
        "document_no": document_no,
        "subtotal": subtotal.to_string(),
        "tax_total": tax_total.to_string(),
        "grand_total": grand_total.to_string(),
        "old_gold_value": old_gold_value.to_string(),
        "valid_today": true,
        "note": "Estimate valid for today only; GST shown is indicative.",
    })))
}

#[derive(sqlx::FromRow)]
struct EstimateListRow {
    id: i64,
    document_no: String,
    created_at: String,
    valid_on: String,
    valid_today: bool,
    #[sqlx(rename = "type")]
    invoice_type: String,
    grand_total: Decimal,
    status: String,
    converted_invoice_id: Option<i64>,
    customer_name: Option<String>,
}

async fn list_estimates(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, EstimateListRow>(
        "SELECT e.id, e.document_no, e.created_at::text AS created_at, e.valid_on::text AS valid_on, \
            (e.valid_on = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS valid_today, \
            e.type, e.grand_total, e.status, e.converted_invoice_id, c.name AS customer_name \
         FROM estimate e LEFT JOIN customer c ON c.id = e.customer_id \
         ORDER BY e.id DESC LIMIT 200",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    let out: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let effective = if r.status == "open" && !r.valid_today {
                "expired"
            } else {
                r.status.as_str()
            };
            json!({
                "id": r.id,
                "document_no": r.document_no,
                "created_at": r.created_at,
                "valid_on": r.valid_on,
                "valid_today": r.valid_today,
                "type": r.invoice_type,
                "grand_total": r.grand_total.to_string(),
                "status": effective,
                "converted_invoice_id": r.converted_invoice_id,
                "customer_name": r.customer_name,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(sqlx::FromRow)]
struct EstDetailLine {
    description: Option<String>,
    hsn: Option<String>,
    purity_label: Option<String>,
    gross_weight: Option<Decimal>,
    net_weight: Option<Decimal>,
    huid: Option<String>,
    making_label: Option<String>,
    rate_used: Decimal,
    breakdown_json: Value,
    taxable_value: Decimal,
    line_total: Decimal,
}

async fn get_estimate(
    State(s): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let h: Option<(String, String, String, String, bool, Decimal, Decimal, Decimal, Decimal, String, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT e.document_no, e.type, e.created_at::text, e.valid_on::text, \
            (e.valid_on = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS valid_today, \
            e.subtotal, e.tax_total, e.grand_total, e.old_gold_value, e.status, \
            e.converted_invoice_id, c.name \
         FROM estimate e LEFT JOIN customer c ON c.id = e.customer_id WHERE e.id = $1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?;
    let h = h.ok_or((StatusCode::NOT_FOUND, format!("estimate {id} not found")))?;

    let lines = sqlx::query_as::<_, EstDetailLine>(
        "SELECT description, hsn, purity_label, gross_weight, net_weight, huid, making_label, \
            rate_used, breakdown_json, taxable_value, line_total \
         FROM estimate_line WHERE estimate_id = $1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let lines_json: Vec<Value> = lines
        .into_iter()
        .map(|l| {
            json!({
                "description": l.description,
                "hsn": l.hsn,
                "purity_label": l.purity_label,
                "gross_weight": l.gross_weight.map(|d| d.to_string()),
                "net_weight": l.net_weight.map(|d| d.to_string()),
                "huid": l.huid,
                "making_label": l.making_label,
                "rate_used": l.rate_used.to_string(),
                "breakdown": l.breakdown_json,
                "taxable_value": l.taxable_value.to_string(),
                "line_total": l.line_total.to_string(),
            })
        })
        .collect();

    let effective = if h.9 == "open" && !h.4 { "expired" } else { h.9.as_str() };
    Ok(Json(json!({
        "id": id,
        "document_no": h.0,
        "type": h.1,
        "created_at": h.2,
        "valid_on": h.3,
        "valid_today": h.4,
        "subtotal": h.5.to_string(),
        "tax_total": h.6.to_string(),
        "grand_total": h.7.to_string(),
        "old_gold_value": h.8.to_string(),
        "status": effective,
        "converted_invoice_id": h.10,
        "customer_name": h.11,
        "lines": lines_json,
    })))
}

#[derive(Deserialize)]
struct ConvertEstimateReq {
    payment_mode: Option<String>,
    cash_amount: Option<Decimal>,
}

async fn convert_estimate(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<ConvertEstimateReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    let mut tx = s.db.begin().await.map_err(internal)?;

    let row: Option<(String, String, bool, Decimal, Option<i64>, bool)> = sqlx::query_as(
        "SELECT status, type, inter_state, old_gold_value, customer_id, \
            (valid_on = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS today \
         FROM estimate WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (status, etype, inter_state, old_gold_value, customer_id, today) =
        row.ok_or((StatusCode::NOT_FOUND, format!("estimate {id} not found")))?;

    if status == "converted" {
        return Err((
            StatusCode::CONFLICT,
            format!("estimate {id} is already converted"),
        ));
    }
    if !today {
        return Err((
            StatusCode::CONFLICT,
            "estimate has expired (valid for the creation day only) — create a fresh estimate".to_string(),
        ));
    }

    let line_inputs: Vec<Value> =
        sqlx::query_scalar("SELECT line_input FROM estimate_line WHERE estimate_id = $1 ORDER BY id")
            .bind(id)
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
    let lines: Vec<InvoiceLineReq> = line_inputs
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<_, _>>()
        .map_err(internal)?;

    let inv_req = InvoiceCreateReq {
        customer_id,
        party_id: None,
        invoice_type: etype,
        inter_state,
        unfixed: false,
        series_code: None,
        payment_mode: body.payment_mode,
        cash_amount: body.cash_amount,
        tenders: vec![],
        old_gold_value: Some(old_gold_value),
        old_gold: vec![],
        target_total: None,
        allow_below_cost: false,
        redeem_scheme_id: None,
        advance_applied: None,
        gst_rate: None,
        lines,
    };

    let (mut tx, res) = build_invoice(tx, s.default_branch, &inv_req).await?;
    let invoice_id = res["invoice_id"].as_i64();
    sqlx::query("UPDATE estimate SET status = 'converted', converted_invoice_id = $2 WHERE id = $1")
        .bind(id)
        .bind(invoice_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;

    Ok(Json(res))
}

/// Home directory (cross-platform), used for the default embedded-PG data location.
#[cfg(feature = "embedded-pg")]
fn home_dir() -> std::path::PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// Boot a self-managed PostgreSQL 18 for "server" installs and return its connection URL.
/// The data directory is persistent (survives restarts) and the DB binds to localhost only
/// — client PCs talk to the backend over HTTP, never to PostgreSQL directly.
#[cfg(feature = "embedded-pg")]
async fn start_embedded_postgres(
) -> Result<(String, postgresql_embedded::PostgreSQL), Box<dyn std::error::Error>> {
    use postgresql_embedded::{PostgreSQL, SettingsBuilder, VersionReq};

    let data_dir = env::var("CYGNUS_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".cygnus").join("pgdata"));
    let port: u16 = env::var("EMBEDDED_PG_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5433);
    let password = env::var("EMBEDDED_PG_PASSWORD").unwrap_or_else(|_| "cygnus_local".to_string());

    println!(
        "Starting embedded PostgreSQL 18 (data dir: {}, port: {port})…",
        data_dir.display()
    );
    let settings = SettingsBuilder::new()
        .version(VersionReq::parse("=18")?) // pin to PostgreSQL 18.x
        .data_dir(data_dir)
        .host("127.0.0.1")
        .port(port)
        .username("postgres")
        .password(&password)
        .temporary(false) // keep the shop's data across restarts
        .build();

    let mut pg = PostgreSQL::new(settings);
    pg.setup().await?;
    pg.start().await?;
    let db_name = "cygnus";
    if !pg.database_exists(db_name).await? {
        pg.create_database(db_name).await?;
    }
    let url =
        format!("postgresql://postgres:{password}@127.0.0.1:{port}/{db_name}?sslmode=disable");
    Ok((url, pg))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Role selection. The SAME binary serves both roles; the role is a runtime flag, not a
    // separate build/product:
    //   • Server PC  → run with `--server` (or CYGNUS_MODE=server). When compiled with the
    //     `embedded-pg` feature it boots and manages its own PostgreSQL, and opens the API
    //     to the LAN (BIND_ADDR defaults to 0.0.0.0:8787).
    //   • Counter PC → runs no backend at all; the desktop app points at the server's URL.
    let server_mode = std::env::args().any(|a| a == "--server")
        || env::var("CYGNUS_MODE").map(|m| m == "server").unwrap_or(false);

    #[cfg(feature = "embedded-pg")]
    let mut _embedded_pg = if server_mode {
        let (embedded_url, pg) = start_embedded_postgres().await?;
        env::set_var("DATABASE_URL", &embedded_url); // embedded DB is the source of truth
        if env::var("BIND_ADDR").is_err() {
            env::set_var("BIND_ADDR", "0.0.0.0:8787"); // reachable by counter PCs
        }
        println!("Embedded PostgreSQL ready — running in SERVER mode.");
        Some(pg) // keep alive for the process lifetime; drop stops the DB
    } else {
        None
    };

    #[cfg(not(feature = "embedded-pg"))]
    if server_mode {
        eprintln!(
            "note: --server requested but this build lacks the `embedded-pg` feature; \
             connecting to DATABASE_URL instead. Rebuild with `--features embedded-pg` \
             to embed PostgreSQL."
        );
        if env::var("BIND_ADDR").is_err() {
            env::set_var("BIND_ADDR", "0.0.0.0:8787");
        }
    }

    let url = env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgresql://postgres@localhost:5433/cygnus?sslmode=disable".to_string()
    });
    let db = PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await?;

    // Apply any pending migrations on startup (formalizes DB setup — no manual psql).
    sqlx::migrate!("../../db/migrations").run(&db).await?;

    let default_branch = env::var("DEFAULT_BRANCH_ID")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1);

    bootstrap_owner(&db).await?;

    let state = AppState::new(db, default_branch);
    let app = build_router(state);

    // Bind address is configurable so the same binary serves both roles:
    //   - Standalone / single-PC: default 127.0.0.1:8787 (localhost only, safe).
    //   - Shop server (LAN): BIND_ADDR=0.0.0.0:8787 so counter PCs can connect.
    // Keep the localhost default; only a server install should open it to the LAN.
    let addr = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("Cygnus backend listening on http://{addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    // Graceful embedded-PG shutdown: stop the managed database before exiting so it isn't
    // orphaned when the process receives SIGTERM/SIGINT (Rust Drop doesn't run on signals).
    #[cfg(feature = "embedded-pg")]
    if let Some(mut pg) = _embedded_pg {
        println!("Stopping embedded PostgreSQL…");
        let _ = pg.stop().await;
    }

    Ok(())
}

/// Wait for SIGINT (Ctrl+C) or SIGTERM (service stop / kill) to trigger graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        ctrl_c.await.ok();
    }
    println!("Shutdown signal received — stopping…");
}

async fn health(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> Json<Value> {
    // Record this caller's heartbeat and compute how many terminals are currently connected.
    // `clients` = distinct remote (non-loopback) machines; `terminals` includes this server.
    let (clients, terminals) = {
        let now = Instant::now();
        let mut map = s.clients.lock().unwrap();
        map.insert(peer.ip(), now);
        map.retain(|_, &mut seen| now.duration_since(seen) <= CLIENT_WINDOW);
        let terminals = map.len();
        let clients = map.keys().filter(|ip| !ip.is_loopback()).count();
        (clients, terminals)
    };

    let db_ok = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM metal_type")
        .fetch_one(&s.db)
        .await
        .is_ok();
    Json(json!({ "status": "ok", "db": db_ok, "clients": clients, "terminals": terminals }))
}

// ---- Rates ----

#[derive(Deserialize)]
struct NewRate {
    metal_type_id: i64,
    purity_id: i64,
    buy_rate: Decimal,
    sell_rate: Decimal,
    cash_rate: Option<Decimal>,
    /// Optional rate date (YYYY-MM-DD). Defaults to now() if omitted.
    effective_date: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct RateRow {
    metal: String,
    purity: String,
    buy_rate: Decimal,
    sell_rate: Decimal,
    cash_rate: Option<Decimal>,
    effective_from: String,
}

async fn list_rates(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Vec<RateRow>>, ApiError> {
    let rows = sqlx::query_as::<_, RateRow>(
        "SELECT mt.name AS metal, p.label AS purity, r.buy_rate, r.sell_rate, r.cash_rate, \
            r.effective_from::text AS effective_from \
         FROM metal_rate r \
         JOIN metal_type mt ON mt.id = r.metal_type_id \
         JOIN purity p ON p.id = r.purity_id \
         ORDER BY r.effective_from DESC, r.id DESC LIMIT 500",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

async fn create_rate(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(r): Json<NewRate>,
) -> Result<Json<Value>, ApiError> {
    auth.require("rate.edit")?;
    if r.buy_rate <= Decimal::ZERO || r.sell_rate <= Decimal::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "rates must be positive".to_string(),
        ));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO metal_rate (metal_type_id, purity_id, buy_rate, sell_rate, cash_rate, effective_from) \
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now())) RETURNING id",
    )
    .bind(r.metal_type_id)
    .bind(r.purity_id)
    .bind(r.buy_rate)
    .bind(r.sell_rate)
    .bind(r.cash_rate)
    .bind(r.effective_date.as_deref())
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

// ---- Items ----

#[derive(Deserialize)]
struct NewItem {
    branch_id: i64,
    sku: String,
    metal_type_id: i64,
    purity_id: i64,
    gross_weight: Decimal,
    net_weight: Decimal,
    #[serde(default)]
    stone_weight: Decimal,
    huid: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct ItemRow {
    id: i64,
    sku: String,
    metal_type_id: i64,
    purity_id: i64,
    metal: String,
    purity: Option<String>,
    gross_weight: Decimal,
    net_weight: Decimal,
    cost_value: Option<Decimal>,
    huid: Option<String>,
    ownership_state: String,
    tag_status: String,
    lot_id: Option<i64>,
    category: Option<String>,
}

async fn list_items(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Vec<ItemRow>>, ApiError> {
    let rows = sqlx::query_as::<_, ItemRow>(
        "SELECT i.id, i.sku, i.metal_type_id, i.purity_id, mt.name AS metal, p.label AS purity, \
            i.gross_weight, i.net_weight, i.cost_value, i.huid, i.ownership_state, i.tag_status, i.lot_id, \
            (SELECT name FROM item_category WHERE id = i.category_id) AS category \
         FROM item i JOIN metal_type mt ON mt.id = i.metal_type_id \
         LEFT JOIN purity p ON p.id = i.purity_id ORDER BY i.id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct TagIdsQuery {
    ids: String, // comma-separated item ids
}

/// Tag/label data for a set of items (barcode = sku, plus purity/weights/HUID).
async fn item_tags(
    State(s): State<AppState>,
    _auth: AuthUser,
    Query(q): Query<TagIdsQuery>,
) -> Result<Json<Value>, ApiError> {
    let ids: Vec<i64> = q.ids.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    if ids.is_empty() {
        return Ok(Json(json!([])));
    }
    let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, Decimal, Decimal, Decimal, Option<String>)>(
        "SELECT i.id, i.sku, mt.name, p.label, i.gross_weight, i.net_weight, i.stone_weight, i.huid \
         FROM item i JOIN metal_type mt ON mt.id = i.metal_type_id \
         LEFT JOIN purity p ON p.id = i.purity_id \
         WHERE i.id = ANY($1) ORDER BY i.id",
    )
    .bind(&ids)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|(id, sku, metal, purity, gross, net, stone, huid)| json!({
            "id": id, "sku": sku, "metal": metal, "purity": purity,
            "gross_weight": gross.to_string(), "net_weight": net.to_string(),
            "stone_weight": stone.to_string(), "huid": huid,
        }))
        .collect::<Vec<_>>())))
}

/// Items recorded but not yet tag-printed (deferred tagging), still in stock.
async fn list_untagged_items(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, Decimal, Decimal, Decimal, Option<String>)>(
        "SELECT i.id, i.sku, mt.name, p.label, i.gross_weight, i.net_weight, i.stone_weight, i.huid \
         FROM item i JOIN metal_type mt ON mt.id = i.metal_type_id \
         LEFT JOIN purity p ON p.id = i.purity_id \
         WHERE i.tag_status = 'untagged' AND i.ownership_state = 'in_stock' ORDER BY i.id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|(id, sku, metal, purity, gross, net, stone, huid)| json!({
            "id": id, "sku": sku, "metal": metal, "purity": purity,
            "gross_weight": gross.to_string(), "net_weight": net.to_string(),
            "stone_weight": stone.to_string(), "huid": huid,
        }))
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct MarkTaggedReq {
    ids: Vec<i64>,
}

/// Mark items as tag-printed (moves them off the pending list).
async fn mark_items_tagged(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(req): Json<MarkTaggedReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    if req.ids.is_empty() {
        return Ok(Json(json!({ "updated": 0 })));
    }
    let r = sqlx::query("UPDATE item SET tag_status = 'tagged' WHERE id = ANY($1) AND tag_status = 'untagged'")
        .bind(&req.ids)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "updated": r.rows_affected() })))
}

/// Item detail with metal + stone composition (for the stock detail view).
async fn get_item(
    State(s): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let head: Option<(String, String, Option<String>, Decimal, Decimal, Option<Decimal>, String, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT i.sku, mt.name AS metal, p.label AS purity, i.gross_weight, i.net_weight, \
                i.cost_value, i.ownership_state, i.huid, ic.name AS category, mt.default_hsn \
             FROM item i JOIN metal_type mt ON mt.id = i.metal_type_id \
             LEFT JOIN purity p ON p.id = i.purity_id \
             LEFT JOIN item_category ic ON ic.id = i.category_id WHERE i.id = $1",
        )
        .bind(id)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    let h = head.ok_or((StatusCode::NOT_FOUND, format!("item {id} not found")))?;
    let stones = sqlx::query_as::<_, (String, Option<Decimal>, Option<i32>, Option<Decimal>, Decimal, Option<String>, Option<String>)>(
        "SELECT COALESCE(ist.description, st.name, 'Stone') AS description, ist.carat, ist.pieces, ist.rate, \
            ist.value, ist.certificate_no, ist.lab \
         FROM item_stone ist LEFT JOIN stone_type st ON st.id = ist.stone_type_id \
         WHERE ist.item_id = $1 ORDER BY ist.id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({
        "id": id, "sku": h.0, "metal": h.1, "purity": h.2,
        "gross_weight": h.3.to_string(), "net_weight": h.4.to_string(),
        "cost_value": h.5.map(|d| d.to_string()), "ownership_state": h.6, "huid": h.7, "category": h.8,
        "hsn": h.9.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "7113".to_string()),
        "stones": stones.iter().map(|r| json!({
            "description": r.0, "carat": r.1.map(|d| d.to_string()), "pieces": r.2,
            "rate": r.3.map(|d| d.to_string()), "value": r.4.to_string(),
            "certificate_no": r.5, "lab": r.6,
        })).collect::<Vec<_>>(),
    })))
}
async fn create_item(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(it): Json<NewItem>,
) -> Result<Json<Value>, ApiError> {
    auth.require("stock.manage")?;
    if it.net_weight <= Decimal::ZERO || it.gross_weight <= Decimal::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "weights must be positive".to_string(),
        ));
    }
    if it.net_weight > it.gross_weight {
        return Err((
            StatusCode::BAD_REQUEST,
            "net weight cannot exceed gross weight".to_string(),
        ));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO item (branch_id, sku, metal_type_id, purity_id, gross_weight, net_weight, stone_weight, huid) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(it.branch_id)
    .bind(&it.sku)
    .bind(it.metal_type_id)
    .bind(it.purity_id)
    .bind(it.gross_weight)
    .bind(it.net_weight)
    .bind(it.stone_weight)
    .bind(it.huid.as_deref())
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    let after = json!({
        "sku": it.sku,
        "net_weight": it.net_weight.to_string(),
        "ownership_state": "in_stock"
    });
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, weight_delta) \
         VALUES ($1, 'item', $2, 'created', $3, $4)",
    )
    .bind(it.branch_id)
    .bind(id)
    .bind(after)
    .bind(it.net_weight)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": id, "ownership_state": "in_stock" })))
}

// ---- Price preview ----

#[derive(Deserialize)]
struct PriceReq {
    metal_type_id: i64,
    purity_id: i64,
    net_weight: Decimal,
    making_per_gram: Option<Decimal>,
    making_percent: Option<Decimal>,
    wastage_percent: Option<Decimal>,
    stone_value: Option<Decimal>,
    #[serde(default)]
    discount: Decimal,
    gst_rate: Option<Decimal>,
    #[serde(default)]
    inter_state: bool,
    pricing_mode: Option<String>,
    touch_percent: Option<Decimal>,
    pure_rate: Option<Decimal>,
    #[serde(default)]
    unfixed: bool,
}

/// Look up the latest sell rate for (metal, purity) and run the shared engine.
async fn price_preview(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(req): Json<PriceReq>,
) -> Result<Json<PriceBreakdown>, ApiError> {
    auth.require("price.preview")?;
    let is_touch = req.pricing_mode.as_deref() == Some("touch");
    let rate: Decimal = if req.unfixed {
        Decimal::ZERO
    } else if is_touch {
        req.touch_percent.unwrap_or(Decimal::ZERO) / Decimal::from(100)
            * req.pure_rate.unwrap_or(Decimal::ZERO)
    } else {
        sqlx::query_scalar(
            "SELECT sell_rate FROM metal_rate \
             WHERE metal_type_id = $1 AND purity_id = $2 \
             ORDER BY effective_from DESC LIMIT 1",
        )
        .bind(req.metal_type_id)
        .bind(req.purity_id)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::NOT_FOUND,
            "no rate for that metal/purity".to_string(),
        ))?
    };

    let making = if is_touch {
        None
    } else {
        match (req.making_per_gram, req.making_percent) {
            (Some(pg), _) => Some(Charge::PerGram(pg)),
            (None, Some(pct)) => Some(Charge::Percent(pct)),
            _ => None,
        }
    };

    let wastage = if is_touch {
        None
    } else {
        req.wastage_percent.map(Charge::Percent)
    };
    let stones = match req.stone_value {
        Some(v) if v > Decimal::ZERO => vec![StonePrice::PerPiece {
            rate: v,
            pieces: Decimal::ONE,
        }],
        _ => vec![],
    };

    let breakdown = value_line(&LineInput {
        metal_rate_per_gram: rate,
        net_weight: req.net_weight,
        making,
        wastage,
        stones,
        discount: req.discount,
        gst_rate: req.gst_rate.unwrap_or_else(|| Decimal::new(3, 2)), // 0.03
        supply: if req.inter_state {
            Supply::Inter
        } else {
            Supply::Intra
        },
    });
    Ok(Json(breakdown))
}

// ---- Sell (double-sale guard + invoice) ----

const SERIES_DEFAULT: &str = "T1";

#[derive(Deserialize)]
struct SellReq {
    making_per_gram: Option<Decimal>,
    making_percent: Option<Decimal>,
    wastage_percent: Option<Decimal>,
    stone_value: Option<Decimal>,
    #[serde(default)]
    discount: Decimal,
    gst_rate: Option<Decimal>,
    #[serde(default)]
    inter_state: bool,
    customer_id: Option<i64>,
    series_code: Option<String>,
    /// Old gold taken in exchange — a value/cash deduction (NO GST on it).
    old_gold_value: Option<Decimal>,
    old_gold: Option<OldGoldIn>,
    /// Payment: mode and the cash portion (for Sec 269ST / PAN checks).
    payment_mode: Option<String>,
    cash_amount: Option<Decimal>,
    /// Redeem a matured savings scheme as a tender (reduces amount payable).
    redeem_scheme_id: Option<i64>,
}

/// Old gold received: valued live at the buy rate; carries NO GST.
#[derive(Deserialize)]
struct OldGoldIn {
    gross_weight: Decimal,
    fineness: Decimal, // parts per 1000, e.g. 916 for 22K
    buy_rate: Decimal, // per gram of pure metal
}

#[derive(sqlx::FromRow)]
struct SaleItem {
    sku: String,
    net_weight: Decimal,
    metal_type_id: i64,
    purity_id: i64,
    ownership_state: String,
    branch_id: i64,
}

// ===================== Metals master (for loose-line entry) =====================

#[derive(sqlx::FromRow)]
struct MetalPurityRow {
    metal_type_id: i64,
    metal: String,
    default_hsn: Option<String>,
    purity_id: i64,
    label: String,
    fineness: i32,
    sell_rate: Option<Decimal>,
    buy_rate: Option<Decimal>,
    cash_rate: Option<Decimal>,
}

async fn list_metals(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, MetalPurityRow>(
        "SELECT mt.id AS metal_type_id, mt.name AS metal, mt.default_hsn, p.id AS purity_id, p.label, p.fineness, \
            (SELECT sell_rate FROM metal_rate r WHERE r.metal_type_id = mt.id AND r.purity_id = p.id \
             ORDER BY effective_from DESC, id DESC LIMIT 1) AS sell_rate, \
            (SELECT buy_rate FROM metal_rate r WHERE r.metal_type_id = mt.id AND r.purity_id = p.id \
             ORDER BY effective_from DESC, id DESC LIMIT 1) AS buy_rate, \
            (SELECT cash_rate FROM metal_rate r WHERE r.metal_type_id = mt.id AND r.purity_id = p.id \
             ORDER BY effective_from DESC, id DESC LIMIT 1) AS cash_rate \
         FROM metal_type mt JOIN purity p ON p.metal_type_id = mt.id \
         ORDER BY mt.id, p.id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    let mut metals: Vec<Value> = Vec::new();
    for r in rows {
        let purity = json!({
            "purity_id": r.purity_id,
            "label": r.label,
            "fineness": r.fineness,
            "sell_rate": r.sell_rate.map(|d| d.to_string()),
            "buy_rate": r.buy_rate.map(|d| d.to_string()),
            "cash_rate": r.cash_rate.map(|d| d.to_string()),
        });
        match metals
            .iter_mut()
            .find(|m| m["metal_type_id"].as_i64() == Some(r.metal_type_id))
        {
            Some(m) => m["purities"].as_array_mut().unwrap().push(purity),
            None => metals.push(json!({
                "metal_type_id": r.metal_type_id,
                "metal": r.metal,
                "default_hsn": r.default_hsn,
                "purities": [purity],
            })),
        }
    }
    Ok(Json(json!(metals)))
}

// ===================== Multi-line invoice create =====================

#[derive(Deserialize, Serialize, Clone)]
struct InvoiceLineReq {
    item_id: Option<i64>,
    metal_type_id: Option<i64>,
    purity_id: Option<i64>,
    description: Option<String>,
    hsn: Option<String>,
    huid: Option<String>,
    gross_weight: Option<Decimal>,
    net_weight: Option<Decimal>,
    making_per_gram: Option<Decimal>,
    making_percent: Option<Decimal>,
    wastage_percent: Option<Decimal>,
    stone_value: Option<Decimal>,
    #[serde(default)]
    discount: Decimal,
    rate_override: Option<Decimal>,
    /// Wholesale touch billing: when pricing_mode == "touch", the line metal value is
    /// (net_weight × touch_percent/100) × pure_rate, with making/wastage folded into touch.
    pricing_mode: Option<String>, // "normal" (default) | "touch"
    touch_percent: Option<Decimal>,
    pure_rate: Option<Decimal>,
    department_id: Option<i64>,
    #[serde(default)]
    stones: Vec<LineStoneReq>,
}

#[derive(Deserialize, Serialize, Clone)]
struct LineStoneReq {
    stone_type_id: Option<i64>,
    stone_quality_id: Option<i64>,
    description: Option<String>,
    carat: Option<Decimal>,
    pieces: Option<i32>,
    rate: Option<Decimal>,
    value: Decimal,
    certificate_no: Option<String>,
    lab: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
struct OldGoldLineReq {
    metal_type_id: i64,
    purity_id: Option<i64>,
    /// Exchange type chosen in the sale form; maps directly to a department
    /// (gold/silver/platinum/diamond → *Ornaments*). Falls back to auto-detect if absent.
    kind: Option<String>,
    gross_weight: Decimal,
    #[serde(default)]
    deduction_percent: Decimal,
    /// Buy rate per gram for the purity; defaults to the day's buy rate.
    rate: Option<Decimal>,
    /// Stones recovered from the old piece, and what to do with them.
    #[serde(default)]
    stones: Vec<LineStoneReq>,
    stone_action: Option<String>, // 'return' (default) | 'buy'
    /// XRF/tested purity (parts per 1000). Overrides the declared purity for fine content.
    tested_fineness: Option<i32>,
    /// Total weight of set stones (grams) — subtracted from gross to get the gold weight.
    /// If omitted, derived from recovered stones' carat (1 ct = 0.2 g).
    stone_weight: Option<Decimal>,
    /// Diamond/stone buyback: flat % of assessed value actually paid (e.g. 70 / 80).
    /// None = value entered manually (credited in full as entered).
    buyback_percent: Option<Decimal>,
}

#[derive(Deserialize, Serialize, Clone)]
struct TenderReq {
    mode: String,
    amount: Decimal,
    reference: Option<String>,
}

#[derive(Deserialize)]
struct InvoiceCreateReq {
    customer_id: Option<i64>,
    /// Optional unified party to bill (B2B/wholesale). Falls back to the customer's party.
    party_id: Option<i64>,
    #[serde(default = "default_invoice_type")]
    invoice_type: String,
    #[serde(default)]
    inter_state: bool,
    /// Unfixed (wholesale) sale: metal not priced now — customer owes fine grams (metal
    /// account) to be fixed later via rate cutting.
    #[serde(default)]
    unfixed: bool,
    series_code: Option<String>,
    payment_mode: Option<String>,
    cash_amount: Option<Decimal>,
    #[serde(default)]
    tenders: Vec<TenderReq>,
    old_gold_value: Option<Decimal>,
    #[serde(default)]
    old_gold: Vec<OldGoldLineReq>,
    /// Manager's negotiated grand total: back-solve making so the bill equals this.
    target_total: Option<Decimal>,
    /// Override the diamond/stone cost floor (sell below purchase rate). Manager/owner only.
    #[serde(default)]
    allow_below_cost: bool,
    /// Redeem a matured savings scheme as a credit against the payable.
    redeem_scheme_id: Option<i64>,
    /// Apply this much of the customer's advance balance to the payable.
    advance_applied: Option<Decimal>,
    gst_rate: Option<Decimal>,
    lines: Vec<InvoiceLineReq>,
}
fn default_invoice_type() -> String {
    "retail".to_string()
}

struct PreparedLine {
    item_id: Option<i64>,
    description: String,
    rate: Decimal,
    breakdown: PriceBreakdown,
    hsn: Option<String>,
    purity_label: Option<String>,
    gross_weight: Option<Decimal>,
    net_weight: Decimal,
    huid: Option<String>,
    making_label: Option<String>,
    department_id: Option<i64>,
    metal_type_id: Option<i64>,
    purity_id: Option<i64>,
    stones: Vec<LineStoneReq>,
}

async fn create_invoice(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(req): Json<InvoiceCreateReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    if req.allow_below_cost && !has_permission(&auth.role, "cost.override") {
        return Err((StatusCode::FORBIDDEN, "Only a manager or owner can sell diamonds/stones below cost.".to_string()));
    }
    let tx = s.db.begin().await.map_err(internal)?;
    let (tx, res) = build_invoice(tx, s.default_branch, &req).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(res))
}

/// Core invoice builder shared by `POST /invoices` and estimate conversion.
/// Takes ownership of the transaction and returns it (uncommitted) so callers can
/// perform additional work (e.g. mark an estimate converted) in the same atomic unit.
async fn build_invoice<'a>(
    mut tx: Transaction<'a, Postgres>,
    branch_id: i64,
    req: &InvoiceCreateReq,
) -> Result<(Transaction<'a, Postgres>, Value), ApiError> {
    if req.lines.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "invoice has no lines".to_string()));
    }
    let fy = current_fy();
    let series = req.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let gst_rate = req.gst_rate.unwrap_or_else(|| Decimal::new(3, 2));
    let supply = if req.inter_state {
        Supply::Inter
    } else {
        Supply::Intra
    };

    let mut subtotal = Decimal::ZERO;
    let mut discount_total = Decimal::ZERO;
    let mut tax_total = Decimal::ZERO;
    let mut grand_total = Decimal::ZERO;
    let mut total_fine = Decimal::ZERO;
    let mut prepared: Vec<PreparedLine> = Vec::new();
    let mut tagged_item_ids: Vec<i64> = Vec::new();

    for ln in &req.lines {
        // Resolve metal/purity/net weight/description from a tagged item or loose entry.
        let (metal_type_id, purity_id, net_weight, gross_weight, mut description, huid, item_id);
        if let Some(iid) = ln.item_id {
            let it: Option<SaleItem> = sqlx::query_as(
                "SELECT sku, net_weight, metal_type_id, purity_id, ownership_state, branch_id \
                 FROM item WHERE id = $1 FOR UPDATE",
            )
            .bind(iid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
            let it = it.ok_or((StatusCode::NOT_FOUND, format!("item {iid} not found")))?;
            if it.ownership_state != "in_stock"
                && it.ownership_state != "on_approval_out"
                && it.ownership_state != "sale_or_return_out"
            {
                return Err((
                    StatusCode::CONFLICT,
                    format!("item {iid} is '{}', not available", it.ownership_state),
                ));
            }
            let gw: Option<Decimal> =
                sqlx::query_scalar("SELECT gross_weight FROM item WHERE id = $1")
                    .bind(iid)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(internal)?;
            let hu: Option<String> = sqlx::query_scalar("SELECT huid FROM item WHERE id = $1")
                .bind(iid)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?
                .flatten();
            metal_type_id = it.metal_type_id;
            purity_id = it.purity_id;
            net_weight = it.net_weight;
            gross_weight = gw;
            description = ln.description.clone().unwrap_or_default();
            huid = ln.huid.clone().or(hu);
            item_id = Some(iid);
            tagged_item_ids.push(iid);
        } else {
            let mt = ln.metal_type_id.ok_or((
                StatusCode::BAD_REQUEST,
                "loose line needs metal_type_id".to_string(),
            ))?;
            let pid = ln.purity_id.ok_or((
                StatusCode::BAD_REQUEST,
                "loose line needs purity_id".to_string(),
            ))?;
            let nw = ln.net_weight.ok_or((
                StatusCode::BAD_REQUEST,
                "loose line needs net_weight".to_string(),
            ))?;
            metal_type_id = mt;
            purity_id = pid;
            net_weight = nw;
            gross_weight = ln.gross_weight;
            description = ln.description.clone().unwrap_or_default();
            huid = ln.huid.clone();
            item_id = None;
        }

        // Purity label for the printed line.
        let purity_label: Option<String> =
            sqlx::query_scalar("SELECT label FROM purity WHERE id = $1")
                .bind(purity_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?;
        // Clean default description: the piece's category (e.g. "DMD Necklace"), else its
        // department (e.g. "Diamond Ornaments"), else the purity — never "loose".
        if description.trim().is_empty() {
            if let Some(iid) = ln.item_id {
                let names: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                    "SELECT (SELECT name FROM item_category WHERE id=i.category_id), \
                        (SELECT name FROM department WHERE id=i.department_id) FROM item i WHERE i.id=$1")
                    .bind(iid).fetch_optional(&mut *tx).await.map_err(internal)?;
                let (cat, dep) = names.unwrap_or((None, None));
                description = cat.or(dep).or_else(|| purity_label.clone()).unwrap_or_else(|| "Item".to_string());
            } else {
                let dept = resolve_department(&mut tx, ln.department_id, &ln.stones, Some(metal_type_id), Some(purity_id)).await?;
                let dn: Option<String> = if let Some(d) = dept {
                    sqlx::query_scalar("SELECT name FROM department WHERE id=$1").bind(d).fetch_optional(&mut *tx).await.map_err(internal)?
                } else { None };
                description = dn.or_else(|| purity_label.clone()).unwrap_or_else(|| "Item".to_string());
            }
        }

        let is_touch = ln.pricing_mode.as_deref() == Some("touch");

        // Fine (pure) grams for this line — used to bill unfixed sales in metal.
        let line_fine = if is_touch {
            (net_weight * ln.touch_percent.unwrap_or(Decimal::ZERO) / Decimal::from(100)).round_dp(3)
        } else {
            let fineness: i32 = sqlx::query_scalar("SELECT fineness FROM purity WHERE id=$1")
                .bind(purity_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
            (net_weight * Decimal::from(fineness) / Decimal::from(1000)).round_dp(3)
        };
        if req.unfixed {
            total_fine += line_fine;
        }

        let rate = if req.unfixed {
            // Metal unpriced on an unfixed sale — owed in fine grams, fixed later.
            Decimal::ZERO
        } else if is_touch {
            // Effective per-gram rate so that net × rate = chargeable_fine × pure_rate.
            let touch = ln.touch_percent.unwrap_or(Decimal::ZERO);
            let pure = ln.pure_rate.unwrap_or(Decimal::ZERO);
            touch / Decimal::from(100) * pure
        } else {
            match ln.rate_override {
                Some(r) => r,
                None => sqlx::query_scalar::<_, Decimal>(
                    "SELECT sell_rate FROM metal_rate WHERE metal_type_id = $1 AND purity_id = $2 \
                     ORDER BY effective_from DESC LIMIT 1",
                )
                .bind(metal_type_id)
                .bind(purity_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?
                .ok_or((
                    StatusCode::BAD_REQUEST,
                    format!("no rate for metal {metal_type_id} / purity {purity_id}"),
                ))?,
            }
        };

        // In touch mode making/wastage are folded into the touch; otherwise use the inputs.
        let making = if is_touch {
            None
        } else {
            match (ln.making_per_gram, ln.making_percent) {
                (Some(pg), _) => Some(Charge::PerGram(pg)),
                (None, Some(pct)) => Some(Charge::Percent(pct)),
                _ => None,
            }
        };
        let making_label = if is_touch {
            Some(format!("{} touch", ln.touch_percent.unwrap_or(Decimal::ZERO)))
        } else {
            match (ln.making_per_gram, ln.making_percent) {
                (Some(pg), _) => Some(format!("₹{pg}/g")),
                (None, Some(pct)) => Some(format!("{pct}%")),
                _ => None,
            }
        };
        let wastage = if is_touch {
            None
        } else {
            ln.wastage_percent.map(Charge::Percent)
        };
        let stones = match ln.stone_value {
            Some(v) if v > Decimal::ZERO => vec![StonePrice::PerPiece {
                rate: v,
                pieces: Decimal::ONE,
            }],
            _ => vec![],
        };

        let bd = value_line(&LineInput {
            metal_rate_per_gram: rate,
            net_weight,
            making,
            wastage,
            stones,
            discount: ln.discount,
            gst_rate,
            supply,
        });

        subtotal += bd.taxable_value + bd.discount;
        discount_total += bd.discount;
        tax_total += bd.tax_total;
        grand_total += bd.grand_total;

        let line_hsn = match ln.hsn.clone() {
            Some(h) if !h.trim().is_empty() => Some(h),
            _ => sqlx::query_scalar::<_, Option<String>>("SELECT default_hsn FROM metal_type WHERE id=$1")
                    .bind(metal_type_id).fetch_optional(&mut *tx).await.map_err(internal)?.flatten(),
        };
        prepared.push(PreparedLine {
            item_id,
            description,
            rate,
            breakdown: bd,
            hsn: line_hsn,
            purity_label,
            gross_weight,
            net_weight,
            huid,
            making_label,
            department_id: ln.department_id,
            metal_type_id: ln.metal_type_id,
            purity_id: ln.purity_id,
            stones: ln.stones.clone(),
        });
    }

    // Negotiated target total: hold metal/stone/wastage fixed and scale down making across
    // lines so the bill's grand total equals the manager's figure. The reduction surfaces as
    // a discount and a lower effective making %.
    if let Some(target) = req.target_total {
        if target > Decimal::ZERO && target < grand_total {
            let total_making: Decimal = prepared.iter().map(|p| p.breakdown.making).sum();
            let total_fixed: Decimal = prepared
                .iter()
                .map(|p| p.breakdown.metal_value + p.breakdown.wastage + p.breakdown.stone_value)
                .sum();
            let target_taxable = round_money(target / (Decimal::ONE + gst_rate));
            let desired_making = target_taxable - total_fixed;
            if desired_making.is_sign_negative() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("target {target} is below the metal + stone + wastage floor ({total_fixed})"),
                ));
            }
            let factor = if total_making > Decimal::ZERO {
                desired_making / total_making
            } else {
                Decimal::ZERO
            };
            let orig_taxable: Decimal = prepared.iter().map(|p| p.breakdown.taxable_value).sum();
            let mut new_taxable = Decimal::ZERO;
            let mut new_tax = Decimal::ZERO;
            for p in prepared.iter_mut() {
                let new_making = round_money(p.breakdown.making * factor);
                let stones = if p.breakdown.stone_value > Decimal::ZERO {
                    vec![StonePrice::PerPiece {
                        rate: p.breakdown.stone_value,
                        pieces: Decimal::ONE,
                    }]
                } else {
                    vec![]
                };
                let bd = value_line(&LineInput {
                    metal_rate_per_gram: p.rate,
                    net_weight: p.net_weight,
                    making: Some(Charge::Flat(new_making)),
                    wastage: if p.breakdown.wastage > Decimal::ZERO {
                        Some(Charge::Flat(p.breakdown.wastage))
                    } else {
                        None
                    },
                    stones,
                    discount: Decimal::ZERO,
                    gst_rate,
                    supply,
                });
                new_taxable += bd.taxable_value;
                new_tax += bd.tax_total;
                p.breakdown = bd;
            }
            subtotal = orig_taxable; // pre-discount taxable
            discount_total = orig_taxable - new_taxable; // making reduction shown as discount
            tax_total = new_tax;
            grand_total = target; // exact negotiated figure
        }
    }

    // Old gold exchange — each lot valued at the day's BUY rate for its purity, less an
    // optional deduction (melting/refining loss). NO GST; it only reduces the payable.
    // Physical stock = gross weight; `net` is only the valuation basis for what we pay.
    #[allow(clippy::type_complexity)]
    let mut old_gold_lots: Vec<(
        i64,
        Option<i64>,
        Decimal,
        Decimal,
        Decimal,
        Decimal,
        Decimal,
        Decimal,
        Option<i32>,
        Decimal,
        Option<i64>,
    )> = Vec::new();
    // Recovered stones per lot (parallel to old_gold_lots): stones, action, buyback %.
    let mut og_stones: Vec<(Vec<LineStoneReq>, String, Option<Decimal>)> = Vec::new();
    let old_gold_value;
    if !req.old_gold.is_empty() {
        let mut sum = Decimal::ZERO;
        for og in &req.old_gold {
            let rate = match og.rate {
                Some(r) => r,
                None => {
                    let pid = og.purity_id.ok_or((
                        StatusCode::BAD_REQUEST,
                        "old gold line needs purity_id or an explicit rate".to_string(),
                    ))?;
                    sqlx::query_scalar::<_, Decimal>(
                        "SELECT buy_rate FROM metal_rate WHERE metal_type_id = $1 AND purity_id = $2 \
                         ORDER BY effective_from DESC LIMIT 1",
                    )
                    .bind(og.metal_type_id)
                    .bind(pid)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(internal)?
                    .ok_or((
                        StatusCode::BAD_REQUEST,
                        format!("no buy rate for metal {} purity {pid}", og.metal_type_id),
                    ))?
                }
            };
            // Fineness (parts per 1000) for the pure-content calculation.
            let fineness: i32 = match og.purity_id {
                Some(pid) => sqlx::query_scalar("SELECT fineness FROM purity WHERE id = $1")
                    .bind(pid)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(internal)?
                    .unwrap_or(1000),
                None => 1000,
            };
            // Stone weight (grams): explicit, else derived from recovered stones (1 ct = 0.2 g).
            let stone_grams = og.stone_weight.unwrap_or_else(|| {
                og.stones
                    .iter()
                    .filter_map(|s| s.carat)
                    .fold(Decimal::ZERO, |a, c| a + c * Decimal::new(2, 1))
            });
            // Gold = gross − stones; we only pay gold rate on the gold, never on the stones.
            let gold_weight = (og.gross_weight - stone_grams).max(Decimal::ZERO);
            // Net = valuation weight (what we pay for); gross stays the physical quantity.
            let net = (gold_weight * (Decimal::ONE_HUNDRED - og.deduction_percent)
                / Decimal::ONE_HUNDRED)
                .round_dp(3);
            // Effective fineness: tested (XRF) overrides the declared purity for fine content.
            let eff_fineness = og.tested_fineness.filter(|f| *f > 0).unwrap_or(fineness);
            let fine = (gold_weight * Decimal::from(eff_fineness) / Decimal::from(1000)).round_dp(3);
            // If we BUY the recovered stones, add their value to what we credit the customer.
            // Diamond buyback pays a flat % of assessed value (e.g. 70/80); None = manual (full).
            let action = og.stone_action.as_deref().unwrap_or("return");
            let buyback_factor = og
                .buyback_percent
                .filter(|p| *p > Decimal::ZERO)
                .map(|p| p / Decimal::ONE_HUNDRED)
                .unwrap_or(Decimal::ONE);
            let stone_buy: Decimal = if action == "buy" {
                round_money(og.stones.iter().map(|s| s.value).sum::<Decimal>() * buyback_factor)
            } else {
                Decimal::ZERO
            };
            let value = round_money(net * rate) + stone_buy;
            sum += value;
            // Department (Gold / Silver / Platinum / Diamond Ornaments) for register grouping.
            // The exchange Type chosen in the form takes precedence; else auto-detect.
            let dept = match og.kind.as_deref() {
                Some(k) => {
                    let name = match k {
                        "silver" => "Silver Ornaments",
                        "platinum" => "Platinum Ornaments",
                        "diamond" => "Diamond Ornaments",
                        _ => "Gold Ornaments",
                    };
                    sqlx::query_scalar::<_, i64>("SELECT id FROM department WHERE name = $1")
                        .bind(name)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(internal)?
                }
                None => {
                    resolve_department(&mut tx, None, &og.stones, Some(og.metal_type_id), og.purity_id).await?
                }
            };
            og_stones.push((
                og.stones.clone(),
                if action == "buy" { "bought" } else { "returned" }.to_string(),
                if action == "buy" { og.buyback_percent } else { None },
            ));
            old_gold_lots.push((
                og.metal_type_id,
                og.purity_id,
                og.gross_weight,
                og.deduction_percent,
                net,
                fine,
                rate,
                value,
                og.tested_fineness,
                stone_grams,
                dept,
            ));
        }
        old_gold_value = sum;
    } else {
        old_gold_value = round_money(req.old_gold_value.unwrap_or(Decimal::ZERO));
    }
    // Scheme redemption — a matured savings scheme applied as a credit (closed below).
    let mut scheme_credit = Decimal::ZERO;
    if let Some(scid) = req.redeem_scheme_id {
        let sr: Option<SchemeRedeemRow> = sqlx::query_as(
            "SELECT status, scheme_type, maturity_value, total_grams, metal_type_id, purity_id \
             FROM scheme WHERE id = $1 FOR UPDATE",
        )
        .bind(scid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let sr = sr.ok_or((StatusCode::NOT_FOUND, format!("scheme {scid} not found")))?;
        if sr.status != "matured" {
            return Err((
                StatusCode::CONFLICT,
                format!("scheme {scid} is '{}' — only a matured scheme can be redeemed", sr.status),
            ));
        }
        scheme_credit = if sr.scheme_type == "gram" {
            let r: Decimal = sqlx::query_scalar(
                "SELECT sell_rate FROM metal_rate WHERE metal_type_id = $1 AND purity_id = $2 \
                 ORDER BY effective_from DESC LIMIT 1",
            )
            .bind(sr.metal_type_id)
            .bind(sr.purity_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?
            .ok_or((StatusCode::BAD_REQUEST, "no current rate for scheme metal/purity".to_string()))?;
            round_money(sr.total_grams * r)
        } else {
            sr.maturity_value.unwrap_or(Decimal::ZERO)
        };
    }

    // Customer advance — capped to available balance and to the remaining payable.
    let after_credits = grand_total - old_gold_value - scheme_credit;
    let mut advance_used = Decimal::ZERO;
    if let Some(reqd) = req.advance_applied {
        if reqd > Decimal::ZERO {
            let cid = req.customer_id.ok_or((
                StatusCode::BAD_REQUEST,
                "applying an advance needs a customer".to_string(),
            ))?;
            let avail: Decimal = sqlx::query_scalar(
                "SELECT COALESCE(sum(balance), 0) FROM customer_advance WHERE customer_id = $1 AND status = 'active'",
            )
            .bind(cid)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
            advance_used = reqd.min(avail).min(after_credits.max(Decimal::ZERO));
        }
    }

    // Payable waterfall: grand − old gold − scheme − advance.
    let amount_payable = after_credits - advance_used;

    // Split tender: if provided, it must sum to the net payable. Cash portion drives 269ST.
    let (payment_mode, cash_paid) = if !req.tenders.is_empty() {
        let sum: Decimal = req.tenders.iter().map(|t| t.amount).sum();
        if round_money(sum) != round_money(amount_payable.max(Decimal::ZERO)) {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "payment split (₹{}) must equal the net payable (₹{})",
                    round_money(sum),
                    round_money(amount_payable.max(Decimal::ZERO))
                ),
            ));
        }
        let cash: Decimal = req
            .tenders
            .iter()
            .filter(|t| t.mode == "cash")
            .map(|t| t.amount)
            .sum();
        let mode = if req.tenders.len() == 1 {
            req.tenders[0].mode.clone()
        } else {
            "split".to_string()
        };
        (mode, cash)
    } else {
        let pm = req.payment_mode.as_deref().unwrap_or("cash").to_string();
        let cash = req.cash_amount.unwrap_or(if pm == "cash" {
            amount_payable.max(Decimal::ZERO)
        } else {
            Decimal::ZERO
        });
        (pm, cash)
    };
    enforce_cash_pan(&mut tx, grand_total, req.customer_id, cash_paid).await?;

    let inv_type = if req.invoice_type == "b2b" { "b2b" } else { "retail" };
    let (invoice_no, document_no) = allocate_doc_no(&mut tx, "invoice", &fy, series).await?;

    // Resolve the unified party: explicit party_id wins, else the customer's linked party.
    let resolved_party_id: Option<i64> = match req.party_id {
        Some(pid) => Some(pid),
        None => match req.customer_id {
            Some(cid) => sqlx::query_scalar("SELECT party_id FROM customer WHERE id = $1")
                .bind(cid)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?
                .flatten(),
            None => None,
        },
    };

    let invoice_id: i64 = sqlx::query_scalar(
        "INSERT INTO invoice (branch_id, customer_id, party_id, series_code, invoice_no, document_no, fy, type, \
            subtotal, discount_total, tax_total, grand_total, old_gold_value, amount_payable, \
            payment_mode, cash_amount, scheme_credit, redeemed_scheme_id, advance_applied) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id",
    )
    .bind(branch_id)
    .bind(req.customer_id)
    .bind(resolved_party_id)
    .bind(series)
    .bind(invoice_no)
    .bind(&document_no)
    .bind(&fy)
    .bind(inv_type)
    .bind(subtotal)
    .bind(discount_total)
    .bind(tax_total)
    .bind(grand_total)
    .bind(old_gold_value)
    .bind(amount_payable)
    .bind(payment_mode)
    .bind(cash_paid)
    .bind(scheme_credit)
    .bind(req.redeem_scheme_id)
    .bind(advance_used)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    // ---- Diamond/stone cost floor: on tagged items the sale rate can't dip below the
    // recorded purchase rate (diamond ₹/ct, stone ₹/ct-normalized). Manager override skips it. ----
    let floor_on = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='sales.stone_cost_floor'")
        .fetch_optional(&mut *tx).await.map_err(internal)?.map(|v| v != "false").unwrap_or(true);
    if floor_on && !req.allow_below_cost {
        let dia_ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM stone_type WHERE category='diamond'")
            .fetch_all(&mut *tx).await.map_err(internal)?;
        let zz = Decimal::ZERO;
        let eps = Decimal::new(1, 2); // 1 paisa/ct tolerance
        let mut violations: Vec<String> = Vec::new();
        for pl in &prepared {
            let iid = match pl.item_id { Some(i) => i, None => continue };
            if pl.stones.is_empty() { continue; }
            let (pd_val, pd_ct, ps_val, ps_ct): (Decimal, Decimal, Decimal, Decimal) = sqlx::query_as(
                "SELECT COALESCE(sum(ist.value) FILTER (WHERE st.category='diamond'),0), \
                    COALESCE(sum(ist.carat) FILTER (WHERE st.category='diamond'),0), \
                    COALESCE(sum(ist.value) FILTER (WHERE st.category<>'diamond'),0), \
                    COALESCE(sum(ist.carat) FILTER (WHERE st.category<>'diamond'),0) \
                 FROM item_stone ist JOIN stone_type st ON st.id=ist.stone_type_id WHERE ist.item_id=$1")
                .bind(iid).fetch_one(&mut *tx).await.map_err(internal)?;
            let (mut sd_val, mut sd_ct, mut ss_val, mut ss_ct) = (zz, zz, zz, zz);
            for st in &pl.stones {
                let (v, c) = (st.value, st.carat.unwrap_or(zz));
                if st.stone_type_id.map(|x| dia_ids.contains(&x)).unwrap_or(false) { sd_val += v; sd_ct += c; }
                else { ss_val += v; ss_ct += c; }
            }
            if pd_ct > zz && sd_ct > zz {
                let (pr, sr) = (pd_val / pd_ct, sd_val / sd_ct);
                if sr < pr - eps { violations.push(format!("{}: diamond ₹{}/ct below cost ₹{}/ct", pl.description, sr.round_dp(0), pr.round_dp(0))); }
            }
            if ps_ct > zz && ss_ct > zz {
                let (pr, sr) = (ps_val / ps_ct, ss_val / ss_ct);
                if sr < pr - eps { violations.push(format!("{}: stone rate below cost", pl.description)); }
            }
        }
        if !violations.is_empty() {
            return Err((StatusCode::CONFLICT, format!("Below cost — {}. A manager/owner can override.", violations.join("; "))));
        }
    }

    for pl in &prepared {
        let breakdown_json = serde_json::to_value(&pl.breakdown).map_err(internal)?;
        // Department: explicit → the sold item's department (tagged) → derived from metal+diamond+purity.
        let dept_id: Option<i64> = match pl.department_id {
            Some(d) => Some(d),
            None => {
                let from_item = if let Some(iid) = pl.item_id {
                    sqlx::query_scalar::<_, Option<i64>>("SELECT department_id FROM item WHERE id=$1")
                        .bind(iid).fetch_optional(&mut *tx).await.map_err(internal)?.flatten()
                } else { None };
                match from_item {
                    Some(d) => Some(d),
                    None => resolve_department(&mut tx, None, &pl.stones, pl.metal_type_id, pl.purity_id).await?,
                }
            }
        };
        let line_id: i64 = sqlx::query_scalar(
            "INSERT INTO invoice_line (invoice_id, item_id, description, rate_used, breakdown_json, \
                taxable_value, line_total, hsn, purity_label, gross_weight, net_weight, huid, making_label, department_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id",
        )
        .bind(invoice_id)
        .bind(pl.item_id)
        .bind(&pl.description)
        .bind(pl.rate)
        .bind(&breakdown_json)
        .bind(pl.breakdown.taxable_value)
        .bind(pl.breakdown.grand_total)
        .bind(pl.hsn.as_deref())
        .bind(pl.purity_label.as_deref())
        .bind(pl.gross_weight)
        .bind(pl.net_weight)
        .bind(pl.huid.as_deref())
        .bind(pl.making_label.as_deref())
        .bind(dept_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;

        // Persist the stone breakdown captured at billing (from the Materials catalogue).
        for st in &pl.stones {
            sqlx::query(
                "INSERT INTO invoice_line_stone (invoice_line_id, stone_type_id, stone_quality_id, \
                    description, carat, pieces, rate, value, certificate_no, lab) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            )
            .bind(line_id)
            .bind(st.stone_type_id)
            .bind(st.stone_quality_id)
            .bind(st.description.as_deref())
            .bind(st.carat)
            .bind(st.pieces)
            .bind(st.rate)
            .bind(st.value)
            .bind(st.certificate_no.as_deref())
            .bind(st.lab.as_deref())
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }
    }

    // Stock + ledger for each tagged line.
    for iid in &tagged_item_ids {
        sqlx::query("UPDATE item SET ownership_state = 'sold' WHERE id = $1")
            .bind(iid)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query(
            "UPDATE approval_out SET status = 'converted' WHERE item_id = $1 AND status = 'out'",
        )
        .bind(iid)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "UPDATE sale_or_return_out SET status = 'invoiced' WHERE item_id = $1 AND status = 'out'",
        )
        .bind(iid)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                before_json, after_json, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'item', $2, 'sold', $3, $4, 'invoice', $5)",
        )
        .bind(branch_id)
        .bind(iid)
        .bind(json!({"ownership_state": "in_stock"}))
        .bind(json!({"ownership_state": "sold"}))
        .bind(invoice_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    if !old_gold_lots.is_empty() {
        // Register each old-gold lot as scrap stock + a metal-in ledger event.
        // The PHYSICAL quantity is the gross weight; net is only the valuation basis.
        for (idx, (mt, pid, gross, ded, net, fine, rate, value, tested, stone_g, dept)) in old_gold_lots.iter().enumerate() {
            let lot_id: i64 = sqlx::query_scalar(
                "INSERT INTO old_gold_lot (branch_id, invoice_id, customer_id, metal_type_id, \
                    purity_id, gross_weight, deduction_percent, net_weight, fine_weight, rate, value, tested_fineness, stone_weight, department_id) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id",
            )
            .bind(branch_id)
            .bind(invoice_id)
            .bind(req.customer_id)
            .bind(mt)
            .bind(*pid)
            .bind(*gross)
            .bind(*ded)
            .bind(*net)
            .bind(*fine)
            .bind(*rate)
            .bind(*value)
            .bind(*tested)
            .bind(*stone_g)
            .bind(*dept)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
            sqlx::query(
                "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                    after_json, weight_delta, amount_delta, ref_doc_type, ref_doc_id) \
                 VALUES ($1, 'lot', $2, 'old_gold_in', $3, $4, $5, 'invoice', $6)",
            )
            .bind(branch_id)
            .bind(lot_id)
            .bind(json!({"kind": "old_gold_scrap", "no_gst": true, "gross_weight": gross.to_string(), "fine_weight": fine.to_string()}))
            .bind(*gross)
            .bind(*value)
            .bind(invoice_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;

            // Recovered stones from this old piece (returned to customer or bought).
            if let Some((stones, action, buyback_pct)) = og_stones.get(idx) {
                // Buyback pays a flat % of assessed value; None = manual (full value).
                let factor = (*buyback_pct)
                    .filter(|p| *p > Decimal::ZERO)
                    .map(|p| p / Decimal::ONE_HUNDRED)
                    .unwrap_or(Decimal::ONE);
                for st in stones {
                    let paid = if action == "bought" {
                        round_money(st.value * factor)
                    } else {
                        Decimal::ZERO
                    };
                    let ogs_id: i64 = sqlx::query_scalar(
                        "INSERT INTO old_gold_stone (old_gold_lot_id, stone_type_id, stone_quality_id, \
                            description, carat, pieces, value, action, buyback_percent) \
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
                    )
                    .bind(lot_id)
                    .bind(st.stone_type_id)
                    .bind(st.stone_quality_id)
                    .bind(st.description.as_deref())
                    .bind(st.carat)
                    .bind(st.pieces)
                    .bind(paid)
                    .bind(action)
                    .bind(*buyback_pct)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(internal)?;

                    // A bought stone enters reusable loose-stone stock at the buyback price.
                    if action == "bought" {
                        sqlx::query(
                            "INSERT INTO loose_stone (branch_id, stone_type_id, stone_quality_id, description, \
                                carat, pieces, cost_value, certificate_no, lab, source, old_gold_stone_id) \
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'old_gold', $10)",
                        )
                        .bind(branch_id)
                        .bind(st.stone_type_id)
                        .bind(st.stone_quality_id)
                        .bind(st.description.as_deref())
                        .bind(st.carat)
                        .bind(st.pieces)
                        .bind(paid)
                        .bind(st.certificate_no.as_deref())
                        .bind(st.lab.as_deref())
                        .bind(ogs_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(internal)?;
                    }
                }
            }
        }
    } else if old_gold_value > Decimal::ZERO {
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'old_gold', $2, 'old_gold_in', $3, $4, 'invoice', $2)",
        )
        .bind(branch_id)
        .bind(invoice_id)
        .bind(json!({"note": "old gold received as value/cash", "no_gst": true}))
        .bind(old_gold_value)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    // Close the redeemed scheme + record the credit in the ledger.
    if let Some(scid) = req.redeem_scheme_id {
        sqlx::query("UPDATE scheme SET status = 'closed', closed_at = now() WHERE id = $1")
            .bind(scid)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'scheme', $2, 'scheme_redeemed', $3, $4, 'invoice', $5)",
        )
        .bind(branch_id)
        .bind(scid)
        .bind(json!({"applied_to_invoice": invoice_id}))
        .bind(scheme_credit)
        .bind(invoice_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    // Apply the advance FIFO across the customer's active advances + ledger.
    if advance_used > Decimal::ZERO {
        if let Some(cid) = req.customer_id {
            let advs: Vec<(i64, Decimal)> = sqlx::query_as(
                "SELECT id, balance FROM customer_advance \
                 WHERE customer_id = $1 AND status = 'active' AND balance > 0 ORDER BY id",
            )
            .bind(cid)
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
            let mut remaining = advance_used;
            for (aid, bal) in advs {
                if remaining <= Decimal::ZERO {
                    break;
                }
                let take = remaining.min(bal);
                sqlx::query(
                    "UPDATE customer_advance SET balance = balance - $2, \
                        status = CASE WHEN balance - $2 <= 0 THEN 'consumed' ELSE status END \
                     WHERE id = $1",
                )
                .bind(aid)
                .bind(take)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
                sqlx::query(
                    "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                        after_json, amount_delta, ref_doc_type, ref_doc_id) \
                     VALUES ($1, 'advance', $2, 'advance_applied', $3, $4, 'invoice', $5)",
                )
                .bind(branch_id)
                .bind(aid)
                .bind(json!({"applied_to_invoice": invoice_id}))
                .bind(-take)
                .bind(invoice_id)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
                remaining -= take;
            }
        }
    }

    // Persist the payment split + a ledger event per tender (every rupee is tracked).
    for t in &req.tenders {
        sqlx::query(
            "INSERT INTO invoice_tender (invoice_id, mode, amount, reference) VALUES ($1, $2, $3, $4)",
        )
        .bind(invoice_id)
        .bind(&t.mode)
        .bind(t.amount)
        .bind(t.reference.as_deref())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

        let event_type = if t.mode == "credit" {
            "credit_sale"
        } else {
            "payment_received"
        };
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'tender', $2, $3, $4, $5, 'invoice', $2)",
        )
        .bind(branch_id)
        .bind(invoice_id)
        .bind(event_type)
        .bind(json!({"mode": t.mode, "reference": t.reference}))
        .bind(t.amount)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

        // A credit tender is a receivable from the party: post it to the party ledger
        // (debtor-positive: + = party owes us). Payment later is recorded as a credit entry.
        if t.mode == "credit" {
            if let Some(pid) = resolved_party_id {
                sqlx::query(
                    "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                        after_json, amount_delta, ref_doc_type, ref_doc_id) \
                     VALUES ($1, 'party', $2, 'credit_sale', $3, $4, 'invoice', $5)",
                )
                .bind(branch_id)
                .bind(pid)
                .bind(json!({"invoice_id": invoice_id, "document_no": document_no}))
                .bind(t.amount)
                .bind(invoice_id)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            }
        }

        // Cheque tenders enter the cheque register (lifecycle tracked separately).
        if t.mode == "cheque" {
            sqlx::query(
                "INSERT INTO cheque (branch_id, invoice_id, customer_id, cheque_no, amount, status) \
                 VALUES ($1, $2, $3, $4, $5, 'received')",
            )
            .bind(branch_id)
            .bind(invoice_id)
            .bind(req.customer_id)
            .bind(t.reference.as_deref())
            .bind(t.amount)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }
    }

    // Unfixed sale: the customer owes us the metal in fine grams (metal account, positive =
    // they owe us). Fixed later via rate cutting.
    if req.unfixed && total_fine > Decimal::ZERO {
        if let Some(pid) = resolved_party_id {
            sqlx::query(
                "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                    after_json, weight_delta, ref_doc_type, ref_doc_id) \
                 VALUES ($1, 'party', $2, 'sale_unfixed', $3, $4, 'invoice', $5)",
            )
            .bind(branch_id)
            .bind(pid)
            .bind(json!({"invoice_id": invoice_id, "document_no": document_no, "fine_grams": total_fine.to_string()}))
            .bind(total_fine)
            .bind(invoice_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }
    }

    Ok((tx, json!({
        "invoice_id": invoice_id,
        "document_no": document_no,
        "subtotal": subtotal.to_string(),
        "discount_total": discount_total.to_string(),
        "tax_total": tax_total.to_string(),
        "grand_total": grand_total.to_string(),
        "old_gold_value": old_gold_value.to_string(),
        "scheme_credit": scheme_credit.to_string(),
        "advance_applied": advance_used.to_string(),
        "amount_payable": amount_payable.to_string(),
        "lines": prepared.len(),
    })))
}

// ===================== Invoice register + detail =====================

#[derive(sqlx::FromRow, Serialize)]
struct InvoiceListRow {
    id: i64,
    document_no: Option<String>,
    created_at: String,
    #[sqlx(rename = "type")]
    invoice_type: String,
    grand_total: Decimal,
    amount_payable: Option<Decimal>,
    status: String,
    customer_name: Option<String>,
}

async fn list_invoices(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Vec<InvoiceListRow>>, ApiError> {
    let rows = sqlx::query_as::<_, InvoiceListRow>(
        "SELECT i.id, i.document_no, i.created_at::text AS created_at, i.type, i.grand_total, \
            i.amount_payable, i.status, c.name AS customer_name \
         FROM invoice i LEFT JOIN customer c ON c.id = i.customer_id \
         ORDER BY i.id DESC LIMIT 200",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

#[derive(sqlx::FromRow)]
struct InvoiceDetailLine {
    id: i64,
    item_id: Option<i64>,
    returned: bool,
    description: Option<String>,
    hsn: Option<String>,
    purity_label: Option<String>,
    gross_weight: Option<Decimal>,
    net_weight: Option<Decimal>,
    huid: Option<String>,
    making_label: Option<String>,
    rate_used: Decimal,
    breakdown_json: Value,
    taxable_value: Decimal,
    line_total: Decimal,
}

async fn get_invoice(
    State(s): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let header: Option<(Option<String>, String, String, String, Decimal, Decimal, Decimal, Decimal, Option<Decimal>, Option<String>, String, Option<String>, Decimal, Decimal, Decimal)> = sqlx::query_as(
        "SELECT i.document_no, i.type, i.created_at::text, i.fy, i.subtotal, i.discount_total, i.tax_total, \
            i.grand_total, i.amount_payable, i.payment_mode, i.status, c.name, \
            i.old_gold_value, i.scheme_credit, i.advance_applied \
         FROM invoice i LEFT JOIN customer c ON c.id = i.customer_id WHERE i.id = $1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?;
    let h = header.ok_or((StatusCode::NOT_FOUND, format!("invoice {id} not found")))?;

    let lines = sqlx::query_as::<_, InvoiceDetailLine>(
        "SELECT id, item_id, returned, description, hsn, purity_label, gross_weight, net_weight, huid, making_label, \
            rate_used, breakdown_json, taxable_value, line_total \
         FROM invoice_line WHERE invoice_id = $1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    let stone_rows: Vec<(i64, String, Option<Decimal>, Option<i32>, Option<Decimal>, Decimal, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT ils.invoice_line_id, COALESCE(ils.description, st.name, 'Stone') AS description, \
                ils.carat, ils.pieces, ils.rate, ils.value, ils.certificate_no, ils.lab \
             FROM invoice_line_stone ils LEFT JOIN stone_type st ON st.id = ils.stone_type_id \
             WHERE ils.invoice_line_id IN (SELECT id FROM invoice_line WHERE invoice_id = $1) ORDER BY ils.id",
        )
        .bind(id)
        .fetch_all(&s.db)
        .await
        .map_err(internal)?;

    let lines_json: Vec<Value> = lines
        .into_iter()
        .map(|l| {
            json!({
                "id": l.id,
                "item_id": l.item_id,
                "returned": l.returned,
                "description": l.description,
                "hsn": l.hsn,
                "purity_label": l.purity_label,
                "gross_weight": l.gross_weight.map(|d| d.to_string()),
                "net_weight": l.net_weight.map(|d| d.to_string()),
                "huid": l.huid,
                "making_label": l.making_label,
                "rate_used": l.rate_used.to_string(),
                "breakdown": l.breakdown_json,
                "taxable_value": l.taxable_value.to_string(),
                "line_total": l.line_total.to_string(),
                "stones": stone_rows.iter().filter(|r| r.0 == l.id).map(|r| json!({
                    "description": r.1,
                    "carat": r.2.map(|d| d.to_string()),
                    "pieces": r.3,
                    "rate": r.4.map(|d| d.to_string()),
                    "value": r.5.to_string(),
                    "certificate_no": r.6,
                    "lab": r.7,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    // Old gold lots taken in on this invoice (for the purchase voucher).
    let og = sqlx::query_as::<_, OldGoldRow>(
        "SELECT ogl.id, ogl.created_at::text AS created_at, mt.name AS metal, p.label AS purity, \
            ogl.gross_weight, ogl.deduction_percent, ogl.net_weight, ogl.fine_weight, ogl.rate, ogl.value, ogl.status, \
            i.document_no, c.name AS customer_name \
         FROM old_gold_lot ogl \
         JOIN metal_type mt ON mt.id = ogl.metal_type_id \
         LEFT JOIN purity p ON p.id = ogl.purity_id \
         LEFT JOIN invoice i ON i.id = ogl.invoice_id \
         LEFT JOIN customer c ON c.id = ogl.customer_id \
         WHERE ogl.invoice_id = $1 ORDER BY ogl.id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let old_gold_lots: Vec<Value> = og.iter().map(old_gold_json).collect();

    // Payment split.
    let tenders = sqlx::query_as::<_, (String, Decimal, Option<String>)>(
        "SELECT mode, amount, reference FROM invoice_tender WHERE invoice_id = $1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let tenders_json: Vec<Value> = tenders
        .iter()
        .map(|(mode, amount, reference)| json!({ "mode": mode, "amount": amount.to_string(), "reference": reference }))
        .collect();

    Ok(Json(json!({
        "id": id,
        "document_no": h.0,
        "type": h.1,
        "created_at": h.2,
        "fy": h.3,
        "subtotal": h.4.to_string(),
        "discount_total": h.5.to_string(),
        "tax_total": h.6.to_string(),
        "grand_total": h.7.to_string(),
        "amount_payable": h.8.map(|d| d.to_string()),
        "payment_mode": h.9,
        "status": h.10,
        "customer_name": h.11,
        "old_gold_value": h.12.to_string(),
        "scheme_credit": h.13.to_string(),
        "advance_applied": h.14.to_string(),
        "old_gold_lots": old_gold_lots,
        "tenders": tenders_json,
        "lines": lines_json,
    })))
}

#[derive(sqlx::FromRow)]
struct SchemeRedeemRow {
    status: String,
    scheme_type: String,
    maturity_value: Option<Decimal>,
    total_grams: Decimal,
    metal_type_id: Option<i64>,
    purity_id: Option<i64>,
}

/// Sell an item. The whole thing is one transaction:
///   1. lock the item row (`FOR UPDATE`) and verify it is `in_stock` — this is the
///      double-sale guard: a concurrent second sale blocks, then sees `sold` and is rejected;
///   2. price it via the shared engine using the latest rate;
///   3. reserve the next gapless invoice number for the series/FY (row-locked counter);
///   4. write the invoice + frozen line snapshot;
///   5. flip ownership to `sold` and append a `ledger_event`.
async fn sell_item(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<SellReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.create")?;
    let mut tx = s.db.begin().await.map_err(internal)?;

    let item: Option<SaleItem> = sqlx::query_as(
        "SELECT sku, net_weight, metal_type_id, purity_id, ownership_state, branch_id \
         FROM item WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;

    let item = match item {
        None => return Err((StatusCode::NOT_FOUND, format!("item {id} not found"))),
        Some(it)
            if it.ownership_state != "in_stock"
                && it.ownership_state != "on_approval_out"
                && it.ownership_state != "sale_or_return_out" =>
        {
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "item {id} is '{}', not available for sale",
                    it.ownership_state
                ),
            ));
        }
        Some(it) => it,
    };

    let rate: Decimal = sqlx::query_scalar(
        "SELECT sell_rate FROM metal_rate WHERE metal_type_id = $1 AND purity_id = $2 \
         ORDER BY effective_from DESC LIMIT 1",
    )
    .bind(item.metal_type_id)
    .bind(item.purity_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    .ok_or((
        StatusCode::BAD_REQUEST,
        "no rate set for this item".to_string(),
    ))?;

    let making = match (req.making_per_gram, req.making_percent) {
        (Some(pg), _) => Some(Charge::PerGram(pg)),
        (None, Some(pct)) => Some(Charge::Percent(pct)),
        _ => None,
    };
    let wastage = req.wastage_percent.map(Charge::Percent);
    let stones = match req.stone_value {
        Some(v) if v > Decimal::ZERO => vec![StonePrice::PerPiece {
            rate: v,
            pieces: Decimal::ONE,
        }],
        _ => vec![],
    };
    let breakdown = value_line(&LineInput {
        metal_rate_per_gram: rate,
        net_weight: item.net_weight,
        making,
        wastage,
        stones,
        discount: req.discount,
        gst_rate: req.gst_rate.unwrap_or_else(|| Decimal::new(3, 2)),
        supply: if req.inter_state {
            Supply::Inter
        } else {
            Supply::Intra
        },
    });

    // Allocate the next configured document number (prefix + zero-padded seq + suffix).
    let series = req.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let fy = current_fy();
    let branch_id = item.branch_id;

    // Old gold exchange: a value/cash deduction with NO GST. GST is on the full new value;
    // old gold only reduces the amount the customer pays.
    let old_gold_value = if let Some(og) = &req.old_gold {
        round_money(og.buy_rate * net_fine_weight(og.gross_weight, og.fineness))
    } else {
        round_money(req.old_gold_value.unwrap_or(Decimal::ZERO))
    };

    // Scheme redemption as a tender (reduces amount payable). Value scheme -> maturity value;
    // gram scheme -> accumulated grams valued at today's rate (realises the rate-averaging).
    let mut scheme_credit = Decimal::ZERO;
    if let Some(scid) = req.redeem_scheme_id {
        let sr: Option<SchemeRedeemRow> = sqlx::query_as(
            "SELECT status, scheme_type, maturity_value, total_grams, metal_type_id, purity_id \
             FROM scheme WHERE id = $1 FOR UPDATE",
        )
        .bind(scid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let sr = sr.ok_or((StatusCode::NOT_FOUND, format!("scheme {scid} not found")))?;
        if sr.status != "matured" {
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "scheme {scid} is '{}' — only a matured scheme can be redeemed",
                    sr.status
                ),
            ));
        }
        scheme_credit = if sr.scheme_type == "gram" {
            let r: Decimal = sqlx::query_scalar(
                "SELECT sell_rate FROM metal_rate WHERE metal_type_id = $1 AND purity_id = $2 \
                 ORDER BY effective_from DESC LIMIT 1",
            )
            .bind(sr.metal_type_id)
            .bind(sr.purity_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?
            .ok_or((
                StatusCode::BAD_REQUEST,
                "no current rate for scheme metal/purity".to_string(),
            ))?;
            round_money(sr.total_grams * r)
        } else {
            sr.maturity_value.unwrap_or(Decimal::ZERO)
        };
        sqlx::query("UPDATE scheme SET status = 'closed', closed_at = now() WHERE id = $1")
            .bind(scid)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }

    let amount_payable = breakdown.grand_total - old_gold_value - scheme_credit;

    // Cash-limit (Sec 269ST) + PAN compliance — enforced BEFORE consuming a document number.
    let payment_mode = req.payment_mode.as_deref().unwrap_or("cash");
    let cash_paid = req.cash_amount.unwrap_or(if payment_mode == "cash" {
        amount_payable.max(Decimal::ZERO)
    } else {
        Decimal::ZERO
    });
    enforce_cash_pan(&mut tx, breakdown.grand_total, req.customer_id, cash_paid).await?;

    let (invoice_no, document_no) = allocate_doc_no(&mut tx, "invoice", &fy, series).await?;

    let subtotal = breakdown.taxable_value + breakdown.discount;
    let invoice_id: i64 = sqlx::query_scalar(
        "INSERT INTO invoice (branch_id, customer_id, series_code, invoice_no, document_no, fy, type, \
            subtotal, discount_total, tax_total, grand_total, old_gold_value, amount_payable, \
            payment_mode, cash_amount, scheme_credit, redeemed_scheme_id) \
         VALUES ($12, $1, $2, $3, $4, $5, 'retail', $6, $7, $8, $9, $10, $11, $13, $14, $15, $16) RETURNING id",
    )
    .bind(req.customer_id)
    .bind(series)
    .bind(invoice_no)
    .bind(&document_no)
    .bind(&fy)
    .bind(subtotal)
    .bind(breakdown.discount)
    .bind(breakdown.tax_total)
    .bind(breakdown.grand_total)
    .bind(old_gold_value)
    .bind(amount_payable)
    .bind(branch_id)
    .bind(payment_mode)
    .bind(cash_paid)
    .bind(scheme_credit)
    .bind(req.redeem_scheme_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    let breakdown_json = serde_json::to_value(&breakdown).map_err(internal)?;
    sqlx::query(
        "INSERT INTO invoice_line (invoice_id, item_id, description, rate_used, breakdown_json, \
            taxable_value, line_total) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(invoice_id)
    .bind(id)
    .bind(&item.sku)
    .bind(rate)
    .bind(breakdown_json.clone())
    .bind(breakdown.taxable_value)
    .bind(breakdown.grand_total)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    sqlx::query("UPDATE item SET ownership_state = 'sold' WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    // If this item was out on approval, close that approval as converted.
    sqlx::query(
        "UPDATE approval_out SET status = 'converted' WHERE item_id = $1 AND status = 'out'",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    // If this item was out on sale-or-return, close that as invoiced.
    sqlx::query(
        "UPDATE sale_or_return_out SET status = 'invoiced' WHERE item_id = $1 AND status = 'out'",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
            before_json, after_json, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($6, 'item', $1, 'sold', $2, $3, $4, 'invoice', $5)",
    )
    .bind(id)
    .bind(json!({"ownership_state": "in_stock"}))
    .bind(json!({"ownership_state": "sold"}))
    .bind(breakdown.grand_total)
    .bind(invoice_id)
    .bind(branch_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    if old_gold_value > Decimal::ZERO {
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($4, 'old_gold', $1, 'old_gold_in', $2, $3, 'invoice', $1)",
        )
        .bind(invoice_id)
        .bind(json!({"note": "old gold received as value/cash", "no_gst": true}))
        .bind(old_gold_value)
        .bind(branch_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    if scheme_credit > Decimal::ZERO {
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'scheme', $2, 'scheme_redeemed', $3, $4, 'invoice', $5)",
        )
        .bind(branch_id)
        .bind(req.redeem_scheme_id)
        .bind(json!({"applied_to_invoice": invoice_id}))
        .bind(scheme_credit)
        .bind(invoice_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    tx.commit().await.map_err(internal)?;

    Ok(Json(json!({
        "invoice_id": invoice_id,
        "series": series,
        "invoice_no": invoice_no,
        "document_no": document_no,
        "grand_total": breakdown.grand_total.to_string(),
        "old_gold_value": old_gold_value.to_string(),
        "scheme_credit": scheme_credit.to_string(),
        "amount_payable": amount_payable.to_string(),
        "breakdown": breakdown_json,
    })))
}

// ---- Document numbering (configurable prefix/suffix + zero-padded sequence) ----
// Works for ALL document types: invoice, purchase_bill, credit_note, debit_note, etc.

#[derive(sqlx::FromRow)]
struct SeriesRow {
    prefix: String,
    suffix: String,
    pad_width: i32,
    next_no: i64,
}

/// "2026-27" -> "2627" (last two of each year). Fallback: keep alphanumerics.
fn compact_fy(fy: &str) -> String {
    if let Some((a, b)) = fy.split_once('-') {
        let a2: String = a
            .chars()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{a2}{b}")
    } else {
        fy.chars().filter(|c| c.is_alphanumeric()).collect()
    }
}

/// Default prefix when a series hasn't been configured yet, e.g. invoice -> "INV-2627-".
fn default_prefix(doc_type: &str, fy: &str) -> String {
    let code = match doc_type {
        "invoice" => "INV",
        "purchase_bill" => "PUR",
        "credit_note" => "CRN",
        "debit_note" => "DBN",
        "approval_slip" => "APP",
        "sale_or_return" => "SOR",
        "quotation" => "QTN",
        "estimate" => "EST",
        "scheme" => "SCH",
        "advance" => "ADV",
        "rate_cut" => "RC",
        "tag" => "TAG",
        _ => "DOC",
    };
    format!("{code}-{}-", compact_fy(fy))
}

/// Allocate the next document number for (doc_type, fy, series).
/// Returns `(sequence, formatted)` e.g. `(1, "INV-2627-0001")`. The series row is locked
/// (`FOR UPDATE`) so numbers are gapless and unique even under concurrency.
async fn allocate_doc_no(
    tx: &mut Transaction<'_, Postgres>,
    doc_type: &str,
    fy: &str,
    series: &str,
) -> Result<(i64, String), ApiError> {
    sqlx::query(
        "INSERT INTO document_series (doc_type, fy, series_code, prefix, suffix, pad_width, next_no) \
         VALUES ($1, $2, $3, $4, '', 4, 1) ON CONFLICT (doc_type, fy, series_code) DO NOTHING",
    )
    .bind(doc_type)
    .bind(fy)
    .bind(series)
    .bind(default_prefix(doc_type, fy))
    .execute(&mut **tx)
    .await
    .map_err(internal)?;

    let row: SeriesRow = sqlx::query_as(
        "SELECT prefix, suffix, pad_width, next_no FROM document_series \
         WHERE doc_type = $1 AND fy = $2 AND series_code = $3 FOR UPDATE",
    )
    .bind(doc_type)
    .bind(fy)
    .bind(series)
    .fetch_one(&mut **tx)
    .await
    .map_err(internal)?;

    let seq = row.next_no;
    sqlx::query(
        "UPDATE document_series SET next_no = next_no + 1 \
         WHERE doc_type = $1 AND fy = $2 AND series_code = $3",
    )
    .bind(doc_type)
    .bind(fy)
    .bind(series)
    .execute(&mut **tx)
    .await
    .map_err(internal)?;

    let width = row.pad_width.max(1) as usize;
    let formatted = format!("{}{:0width$}{}", row.prefix, seq, row.suffix, width = width);
    // GST Rule 46: document number must be <= 16 characters.
    if formatted.chars().count() > 16 {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("document number '{formatted}' exceeds the GST 16-character limit"),
        ));
    }
    Ok((seq, formatted))
}

#[derive(Serialize, sqlx::FromRow)]
struct SeriesListRow {
    doc_type: String,
    fy: String,
    series_code: String,
    prefix: String,
    suffix: String,
    pad_width: i32,
    next_no: i64,
    active: bool,
}

async fn list_series(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Vec<SeriesListRow>>, ApiError> {
    let rows = sqlx::query_as::<_, SeriesListRow>(
        "SELECT doc_type, fy, series_code, prefix, suffix, pad_width, next_no, active \
         FROM document_series ORDER BY doc_type, fy, series_code",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct NewSeries {
    doc_type: String,
    fy: String,
    series_code: Option<String>,
    prefix: String,
    suffix: Option<String>,
    pad_width: Option<i32>,
    /// Starting/next sequence number; set at FY start. Omit to keep the current value.
    start_no: Option<i64>,
}

/// Configure (or update) a document series — typically once at the start of a financial year.
async fn upsert_series(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewSeries>,
) -> Result<Json<Value>, ApiError> {
    auth.require("settings.manage")?;
    let series = n.series_code.unwrap_or_else(|| "MAIN".to_string());
    let suffix = n.suffix.unwrap_or_default();
    let pad = n.pad_width.unwrap_or(4);
    if !(1..=12).contains(&pad) {
        return Err((
            StatusCode::BAD_REQUEST,
            "pad_width must be between 1 and 12".to_string(),
        ));
    }

    // Validate the formatted length BEFORE persisting so an over-long series is never saved.
    // Check at the starting number and at a high end-of-FY value (widest case).
    let start = n.start_no.unwrap_or(1).max(1);
    let widest = 10i64.pow(pad.clamp(1, 12) as u32) - 1; // e.g. pad 4 -> 9999
    for seq in [start, widest] {
        let candidate = format!("{}{:0width$}{}", n.prefix, seq, suffix, width = pad.max(1) as usize);
        if candidate.chars().count() > 16 {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("number '{candidate}' would exceed the GST 16-character limit — shorten the prefix/suffix or reduce padding"),
            ));
        }
    }

    sqlx::query(
        "INSERT INTO document_series (doc_type, fy, series_code, prefix, suffix, pad_width, next_no) \
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 1)) \
         ON CONFLICT (doc_type, fy, series_code) DO UPDATE SET \
            prefix = $4, suffix = $5, pad_width = $6, \
            next_no = COALESCE($7, document_series.next_no)",
    )
    .bind(&n.doc_type)
    .bind(&n.fy)
    .bind(&series)
    .bind(&n.prefix)
    .bind(&suffix)
    .bind(pad)
    .bind(n.start_no)
    .execute(&s.db)
    .await
    .map_err(internal)?;

    // Preview the next number for confirmation.
    let next_no: i64 = sqlx::query_scalar(
        "SELECT next_no FROM document_series WHERE doc_type = $1 AND fy = $2 AND series_code = $3",
    )
    .bind(&n.doc_type)
    .bind(&n.fy)
    .bind(&series)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    let preview = format!(
        "{}{:0width$}{}",
        n.prefix,
        next_no,
        suffix,
        width = pad.max(1) as usize
    );
    Ok(Json(json!({
        "doc_type": n.doc_type,
        "fy": n.fy,
        "series_code": series,
        "next_number_preview": preview,
    })))
}

// ---- Returns (GST credit note) ----

#[derive(Deserialize)]
struct ReturnReq {
    /// Specific invoice_line ids to return; omit/empty = all not-yet-returned lines.
    #[serde(default)]
    line_ids: Vec<i64>,
    #[serde(default)]
    reason: Option<String>,
    refund_mode: Option<String>,
    /// Accept a return beyond the configured return window (manager override).
    #[serde(default)]
    override_window: bool,
    /// Optional deduction (handling/restocking) subtracted from the refund.
    deduction: Option<Decimal>,
    /// How to settle: 'store_credit' (default, a customer advance) or 'refund'.
    settlement_mode: Option<String>,
    /// Old gold on a full return: 'physical' (hand the lot back) or 'cash' (cash-rate value).
    old_gold_action: Option<String>,
    series_code: Option<String>,
}

/// Create a store-credit / advance row for a customer (used by return settlement).
async fn create_store_credit(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: i64,
    customer_id: i64,
    amount: Decimal,
    note: &str,
) -> Result<i64, ApiError> {
    let id = sqlx::query_scalar(
        "INSERT INTO customer_advance (branch_id, customer_id, amount, balance, note, payment_mode, status) \
         VALUES ($1, $2, $3, $3, $4, 'store_credit', 'active') RETURNING id",
    )
    .bind(branch_id)
    .bind(customer_id)
    .bind(amount)
    .bind(note)
    .fetch_one(&mut **tx)
    .await
    .map_err(internal)?;
    Ok(id)
}

async fn ledger_credit(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: i64,
    advance_id: i64,
    event: &str,
    amount: Decimal,
    cn_id: i64,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
            after_json, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'advance', $2, $3, $4, $5, 'credit_note', $6)",
    )
    .bind(branch_id)
    .bind(advance_id)
    .bind(event)
    .bind(json!({"from_return": true}))
    .bind(amount)
    .bind(cn_id)
    .execute(&mut **tx)
    .await
    .map_err(internal)?;
    Ok(())
}

/// Return an invoice: issue a credit note, restore the item to stock, and reverse the
/// movement in the ledger — all in one transaction. The original invoice is untouched.
async fn return_invoice(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(invoice_id): Path<i64>,
    Json(req): Json<ReturnReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sale.return")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    let mut tx = s.db.begin().await.map_err(internal)?;

    // Invoice header (locked) + age + deductions.
    let hdr: Option<(Option<i64>, String, String, i64, i64, Decimal, Decimal, Decimal, Option<Decimal>)> = sqlx::query_as(
        "SELECT customer_id, fy, status, branch_id, \
            ((now() AT TIME ZONE 'Asia/Kolkata')::date - created_at::date)::bigint AS age_days, \
            old_gold_value, scheme_credit, advance_applied, amount_payable \
         FROM invoice WHERE id = $1 FOR UPDATE",
    )
    .bind(invoice_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (customer_id, fy, status, branch_id, age_days, og_value, scheme_inv, advance_inv, payable_inv) =
        hdr.ok_or((StatusCode::NOT_FOUND, format!("invoice {invoice_id} not found")))?;
    if status != "final" && status != "partially_returned" {
        return Err((
            StatusCode::CONFLICT,
            format!("invoice {invoice_id} is '{status}', cannot return"),
        ));
    }

    let window = setting_i64(&s.db, "return_window_days", 7).await;
    if age_days > window && !req.override_window {
        return Err((
            StatusCode::CONFLICT,
            format!("invoice is {age_days} days old, beyond the {window}-day return window — manager override required"),
        ));
    }

    let all_lines: Vec<(i64, Option<i64>, Option<String>, Decimal, Decimal, Value, bool)> =
        sqlx::query_as(
            "SELECT id, item_id, description, taxable_value, line_total, breakdown_json, returned \
             FROM invoice_line WHERE invoice_id = $1 ORDER BY id",
        )
        .bind(invoice_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(internal)?;

    let unreturned_total = all_lines.iter().filter(|l| !l.6).count();
    let want: std::collections::HashSet<i64> = req.line_ids.iter().copied().collect();
    let selected: Vec<(i64, Option<i64>, Option<String>, Decimal, Decimal, Value, bool)> = all_lines
        .into_iter()
        .filter(|(id, _, _, _, _, _, returned)| !*returned && (want.is_empty() || want.contains(id)))
        .collect();
    if selected.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no returnable lines selected".to_string()));
    }
    let is_full = selected.len() == unreturned_total;
    let has_deductions = og_value > Decimal::ZERO || scheme_inv > Decimal::ZERO || advance_inv > Decimal::ZERO;
    if has_deductions && !is_full {
        return Err((
            StatusCode::CONFLICT,
            "this invoice used old gold / scheme / advance — return all items (full return) so they can be settled".to_string(),
        ));
    }

    // Validate items + accumulate GST-reversal totals (returned line values).
    let mut subtotal = Decimal::ZERO;
    let mut tax_total = Decimal::ZERO;
    let mut total = Decimal::ZERO;
    for (_id, item_id, _desc, taxable, line_total, bd, _r) in &selected {
        subtotal += *taxable;
        tax_total += bd
            .get("tax_total")
            .and_then(|v| v.as_str())
            .and_then(|x| x.parse().ok())
            .unwrap_or(Decimal::ZERO);
        total += *line_total;
        if let Some(iid) = item_id {
            let st: Option<String> =
                sqlx::query_scalar("SELECT ownership_state FROM item WHERE id = $1 FOR UPDATE")
                    .bind(*iid)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(internal)?;
            if st.as_deref() != Some("sold") {
                return Err((
                    StatusCode::CONFLICT,
                    format!("item {iid} is '{}', not returnable", st.as_deref().unwrap_or("missing")),
                ));
            }
        }
    }

    // ===== Settlement computation =====
    let settlement_mode = req.settlement_mode.as_deref().unwrap_or("store_credit");
    let deduction = round_money(req.deduction.unwrap_or(Decimal::ZERO));
    let cash_limit = Decimal::from(setting_i64(&s.db, "cash_refund_limit", 20000).await);
    let cash_ded_pct = Decimal::from(setting_i64(&s.db, "cash_rate_deduction_percent", 8).await);

    let advance_recredit = if is_full { advance_inv } else { Decimal::ZERO };
    let scheme_to_credit = if is_full { scheme_inv } else { Decimal::ZERO };

    // Old gold: hand back physical lots if in scrap, else settle at the cash buy-back rate.
    let mut old_gold_physical = false;
    let mut old_gold_cash = Decimal::ZERO;
    #[allow(clippy::type_complexity)]
    let mut og_lots: Vec<(i64, Decimal)> = Vec::new(); // (lot_id, gross) for physical return
    if is_full && og_value > Decimal::ZERO {
        let lots: Vec<(i64, Option<i64>, Decimal, Decimal, String)> = sqlx::query_as(
            "SELECT id, purity_id, gross_weight, net_weight, status FROM old_gold_lot \
             WHERE invoice_id = $1 AND status <> 'returned'",
        )
        .bind(invoice_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(internal)?;
        let all_in_scrap = !lots.is_empty() && lots.iter().all(|l| l.4 == "in_scrap");
        let action = req
            .old_gold_action
            .as_deref()
            .unwrap_or(if all_in_scrap { "physical" } else { "cash" });
        if action == "physical" && all_in_scrap {
            old_gold_physical = true;
            for (lid, _pid, gross, _net, _st) in &lots {
                og_lots.push((*lid, *gross));
            }
        } else {
            for (_lid, pid, _gross, net, _st) in &lots {
                let cash_rate: Decimal = match pid {
                    Some(p) => {
                        let row: Option<(Option<Decimal>, Decimal)> = sqlx::query_as(
                            "SELECT cash_rate, buy_rate FROM metal_rate WHERE purity_id = $1 \
                             ORDER BY effective_from DESC LIMIT 1",
                        )
                        .bind(p)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(internal)?;
                        match row {
                            // Prefer the manually-set cash rate; else fall back to buy − deduction%.
                            Some((Some(cr), _)) => cr,
                            Some((None, buy)) => buy * (Decimal::ONE_HUNDRED - cash_ded_pct) / Decimal::ONE_HUNDRED,
                            None => Decimal::ZERO,
                        }
                    }
                    None => Decimal::ZERO,
                };
                old_gold_cash += round_money(*net * cash_rate);
            }
        }
    }

    // Monetary base = the money the customer actually paid (cash tenders) on a deduction
    // invoice; otherwise the returned line value. Plus any cash-settled old gold, less deduction.
    let base = if has_deductions {
        let recv: Decimal = sqlx::query_scalar(
            "SELECT COALESCE(sum(amount), 0) FROM invoice_tender WHERE invoice_id = $1 AND mode <> 'credit'",
        )
        .bind(invoice_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
        if recv > Decimal::ZERO { recv } else { payable_inv.unwrap_or(total) }
    } else {
        total
    };
    let monetary = (base + old_gold_cash - deduction).max(Decimal::ZERO);

    let final_refund_mode: String = if settlement_mode == "store_credit" {
        "store_credit".to_string()
    } else {
        req.refund_mode.clone().unwrap_or_else(|| {
            if monetary <= cash_limit { "cash".to_string() } else { "bank_transfer".to_string() }
        })
    };

    // Credit note (GST reversal on the returned lines).
    let series = req.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let (cn_no, document_no) = allocate_doc_no(&mut tx, "credit_note", &fy, series).await?;
    let reason_detail = req.reason.as_deref();
    let cn_id: i64 = sqlx::query_scalar(
        "INSERT INTO credit_note (branch_id, original_invoice_id, customer_id, series_code, cn_no, \
            document_no, fy, reason, reason_detail, subtotal, tax_total, total, refund_mode, deduction, net_refund) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'return', $8, $9, $10, $11, $12, $13, $14) RETURNING id",
    )
    .bind(branch_id)
    .bind(invoice_id)
    .bind(customer_id)
    .bind(series)
    .bind(cn_no)
    .bind(&document_no)
    .bind(&fy)
    .bind(reason_detail)
    .bind(subtotal)
    .bind(tax_total)
    .bind(total)
    .bind(&final_refund_mode)
    .bind(deduction)
    .bind(monetary)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    for (line_id, item_id, desc, taxable, line_total, _bd, _r) in &selected {
        sqlx::query(
            "INSERT INTO credit_note_line (credit_note_id, item_id, description, taxable_value, line_total) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(cn_id)
        .bind(*item_id)
        .bind(desc.as_deref())
        .bind(*taxable)
        .bind(*line_total)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query("UPDATE invoice_line SET returned = true WHERE id = $1")
            .bind(*line_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        if let Some(iid) = item_id {
            sqlx::query("UPDATE item SET ownership_state = 'in_stock' WHERE id = $1")
                .bind(*iid)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            sqlx::query(
                "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                    before_json, after_json, amount_delta, ref_doc_type, ref_doc_id) \
                 VALUES ($1, 'item', $2, 'returned', $3, $4, $5, 'credit_note', $6)",
            )
            .bind(branch_id)
            .bind(*iid)
            .bind(json!({"ownership_state": "sold"}))
            .bind(json!({"ownership_state": "in_stock"}))
            .bind(-*line_total)
            .bind(cn_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }
    }

    // Old gold: physical return (remove from scrap) or cash settle.
    for (lid, gross) in &og_lots {
        sqlx::query("UPDATE old_gold_lot SET status = 'returned' WHERE id = $1")
            .bind(lid)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, weight_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'old_gold', $2, 'old_gold_returned', $3, $4, 'credit_note', $5)",
        )
        .bind(branch_id)
        .bind(lid)
        .bind(json!({"note": "physical old gold returned to customer"}))
        .bind(-*gross)
        .bind(cn_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }
    if old_gold_cash > Decimal::ZERO {
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'old_gold', $2, 'old_gold_cash_settle', $3, $4, 'credit_note', $2)",
        )
        .bind(branch_id)
        .bind(invoice_id)
        .bind(json!({"note": "old gold settled at cash buy-back rate"}))
        .bind(old_gold_cash)
        .bind(cn_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    // Settlement instruments (store credit = customer advance; advance re-credit; scheme credit).
    if let Some(cid) = customer_id {
        if settlement_mode == "store_credit" && monetary > Decimal::ZERO {
            let aid = create_store_credit(&mut tx, branch_id, cid, monetary, &format!("Return store credit {document_no}")).await?;
            ledger_credit(&mut tx, branch_id, aid, "store_credit_issued", monetary, cn_id).await?;
        }
        if advance_recredit > Decimal::ZERO {
            let aid = create_store_credit(&mut tx, branch_id, cid, advance_recredit, &format!("Advance re-credit {document_no}")).await?;
            ledger_credit(&mut tx, branch_id, aid, "advance_restored", advance_recredit, cn_id).await?;
        }
        if scheme_to_credit > Decimal::ZERO {
            let aid = create_store_credit(&mut tx, branch_id, cid, scheme_to_credit, &format!("Scheme return credit {document_no}")).await?;
            ledger_credit(&mut tx, branch_id, aid, "store_credit_issued", scheme_to_credit, cn_id).await?;
        }
    }
    if settlement_mode != "store_credit" && monetary > Decimal::ZERO {
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1, 'cash', $2, 'refund_paid', $3, $4, 'credit_note', $2)",
        )
        .bind(branch_id)
        .bind(invoice_id)
        .bind(json!({"refund_mode": final_refund_mode}))
        .bind(-monetary)
        .bind(cn_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM invoice_line WHERE invoice_id = $1 AND returned = false",
    )
    .bind(invoice_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    let new_status = if remaining == 0 { "returned" } else { "partially_returned" };
    sqlx::query("UPDATE invoice SET status = $2 WHERE id = $1")
        .bind(invoice_id)
        .bind(new_status)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

    tx.commit().await.map_err(internal)?;

    Ok(Json(json!({
        "credit_note_id": cn_id,
        "document_no": document_no,
        "reason": reason_detail,
        "settlement_mode": settlement_mode,
        "refund_mode": final_refund_mode,
        "lines_returned": selected.len(),
        "subtotal": subtotal.to_string(),
        "tax_total": tax_total.to_string(),
        "total": total.to_string(),
        "deduction": deduction.to_string(),
        "monetary_settlement": monetary.to_string(),
        "advance_recredit": advance_recredit.to_string(),
        "scheme_credit": scheme_to_credit.to_string(),
        "old_gold_physical": old_gold_physical,
        "old_gold_cash": old_gold_cash.to_string(),
        "invoice_status": new_status,
    })))
}

// ---- Suppliers ----

#[derive(Deserialize)]
struct NewSupplier {
    name: String,
    gstin: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct SupplierRow {
    id: i64,
    name: String,
    gstin: Option<String>,
    balance: Decimal,
}

async fn list_suppliers(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Vec<SupplierRow>>, ApiError> {
    let rows = sqlx::query_as::<_, SupplierRow>(
        "SELECT id, name, gstin, balance FROM supplier ORDER BY id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

async fn create_supplier(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewSupplier>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    let id: i64 =
        sqlx::query_scalar("INSERT INTO supplier (name, gstin) VALUES ($1, $2) RETURNING id")
            .bind(&n.name)
            .bind(n.gstin.as_deref())
            .fetch_one(&s.db)
            .await
            .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

// ---- Purchases (inbound stock) ----

fn default_bill_kind() -> String {
    "b2b".to_string()
}

#[derive(Deserialize)]
struct PurchaseLineReq {
    #[serde(default = "default_pricing_mode")]
    pricing_mode: String, // fixed_cost | weight_rate | touch | stone | lot
    #[serde(default)]
    sku: String,
    metal_type_id: Option<i64>,
    purity_id: Option<i64>,
    #[serde(default)]
    gross_weight: Decimal,
    net_weight: Option<Decimal>,
    #[serde(default)]
    stone_weight: Decimal,
    touch_percent: Option<Decimal>,
    pure_rate: Option<Decimal>,
    rate: Option<Decimal>,
    making_per_gram: Option<Decimal>,
    cost_value: Option<Decimal>,
    huid: Option<String>,
    category_id: Option<i64>,
    department_id: Option<i64>,
    hsn: Option<String>,
    gst_rate: Option<Decimal>,
    pieces: Option<i32>, // for lot lines: number of pieces in the bulk lot
    #[serde(default)]
    stones: Vec<LineStoneReq>,
}
fn default_pricing_mode() -> String {
    "fixed_cost".to_string()
}

#[derive(Deserialize)]
struct PurchasePaymentReq {
    mode: String, // cash | bank | cheque
    amount: Decimal,
    reference: Option<String>,
}

#[derive(Deserialize)]
struct NewPurchase {
    party_id: Option<i64>,
    supplier_id: Option<i64>,
    #[serde(default = "default_bill_kind")]
    bill_kind: String, // local | b2b
    #[serde(default)]
    rcm: bool,
    #[serde(default)]
    inter_state: bool,
    #[serde(default)]
    unfixed: bool, // true = metal is unfixed → post fine grams to the supplier's metal account
    supplier_invoice_no: Option<String>,
    series_code: Option<String>,
    fy: Option<String>,
    branch_id: Option<i64>,
    lines: Vec<PurchaseLineReq>,
    #[serde(default)]
    payments: Vec<PurchasePaymentReq>,
    tag_now: Option<bool>, // itemised pieces: assign+print tags now (default) or defer (untagged)
}

async fn list_purchases(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, Option<String>, Option<String>, String, Decimal, Decimal, Decimal, String, Option<String>, String)>(
        "SELECT pb.id, pb.document_no, \
            COALESCE(p.display_name, sup.name) AS party_name, \
            pb.bill_kind, pb.total, pb.tax_total, pb.paid_total, pb.status, \
            pb.created_at::text, COALESCE(pb.supplier_invoice_no, '') \
         FROM purchase_bill pb \
         LEFT JOIN party p ON p.id = pb.party_id \
         LEFT JOIN supplier sup ON sup.id = pb.supplier_id \
         ORDER BY pb.id DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|(id, doc, name, kind, total, tax, paid, status, at, supinv)| {
            json!({
                "id": id, "document_no": doc, "party_name": name, "bill_kind": kind,
                "total": total.to_string(), "tax_total": tax.to_string(),
                "paid_total": paid.to_string(), "balance": (total - paid).to_string(),
                "status": status, "created_at": at, "supplier_invoice_no": supinv,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(sqlx::FromRow)]
struct PurchLineRow {
    id: i64,
    description: String,
    pricing_mode: String,
    gross_weight: Decimal,
    net_weight: Decimal,
    stone_weight: Decimal,
    touch_percent: Option<Decimal>,
    pure_rate: Option<Decimal>,
    chargeable_fine: Decimal,
    making_amount: Decimal,
    stone_value: Decimal,
    taxable_value: Decimal,
    gst_rate: Decimal,
    line_total: Decimal,
    hsn: Option<String>,
    stone_json: Option<Value>,
    returned: bool,
}

/// Purchase bill detail: head + lines + payments.
async fn get_purchase(
    State(s): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let head: Option<(i64, Option<String>, Option<String>, String, bool, bool, Option<String>, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, Decimal, String, String)> =
        sqlx::query_as(
            "SELECT pb.id, pb.document_no, COALESCE(p.display_name, sup.name), pb.bill_kind, pb.rcm, pb.inter_state, \
                pb.supplier_invoice_no, pb.subtotal, pb.making_total, pb.stone_total, pb.tax_total, pb.total, \
                pb.total_fine, pb.paid_total, pb.status, pb.created_at::text \
             FROM purchase_bill pb LEFT JOIN party p ON p.id=pb.party_id LEFT JOIN supplier sup ON sup.id=pb.supplier_id \
             WHERE pb.id=$1",
        )
        .bind(id)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    let h = head.ok_or((StatusCode::NOT_FOUND, format!("purchase {id} not found")))?;

    let lines = sqlx::query_as::<_, PurchLineRow>(
        "SELECT id, description, pricing_mode, gross_weight, net_weight, stone_weight, touch_percent, pure_rate, \
            chargeable_fine, making_amount, stone_value, taxable_value, gst_rate, line_total, hsn, stone_json, returned \
         FROM purchase_bill_line WHERE purchase_bill_id=$1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    let payments = sqlx::query_as::<_, (String, Decimal, Option<String>, String)>(
        "SELECT mode, amount, reference, created_at::text FROM purchase_payment WHERE purchase_bill_id=$1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    Ok(Json(json!({
        "id": h.0, "document_no": h.1, "party_name": h.2, "bill_kind": h.3, "rcm": h.4, "inter_state": h.5,
        "supplier_invoice_no": h.6, "subtotal": h.7.to_string(), "making_total": h.8.to_string(),
        "stone_total": h.9.to_string(), "tax_total": h.10.to_string(), "total": h.11.to_string(),
        "total_fine": h.12.to_string(), "paid_total": h.13.to_string(), "balance": (h.11 - h.13).to_string(),
        "status": h.14, "created_at": h.15,
        "lines": lines.iter().map(|l| json!({
            "id": l.id, "returned": l.returned,
            "description": l.description, "pricing_mode": l.pricing_mode, "gross_weight": l.gross_weight.to_string(), "net_weight": l.net_weight.to_string(),
            "stone_weight": l.stone_weight.to_string(), "touch_percent": l.touch_percent.map(|d|d.to_string()), "pure_rate": l.pure_rate.map(|d|d.to_string()),
            "chargeable_fine": l.chargeable_fine.to_string(), "making_amount": l.making_amount.to_string(), "stone_value": l.stone_value.to_string(),
            "taxable_value": l.taxable_value.to_string(), "gst_rate": l.gst_rate.to_string(), "line_total": l.line_total.to_string(),
            "hsn": l.hsn, "stones": l.stone_json,
        })).collect::<Vec<_>>(),
        "payments": payments.iter().map(|(m,a,r,at)| json!({
            "mode": m, "amount": a.to_string(), "reference": r, "created_at": at,
        })).collect::<Vec<_>>(),
    })))
}

/// Create a purchase bill (Stage 1): values each line by its pricing mode
/// (fixed_cost | weight_rate | touch), applies GST for B2B (or RCM), receives each line as
/// a new in-stock item (with its stones recorded), records payments, and posts the net
/// payable to the supplier's party ledger (debtor-positive: a purchase is NEGATIVE).
/// Generate an auto item barcode/SKU: metal+karat prefix + a running tag sequence,
/// e.g. gold 22K → "G22-000123". Unique because the sequence is monotonic.
async fn gen_item_barcode(
    tx: &mut Transaction<'_, Postgres>,
    metal_type_id: i64,
    purity_id: i64,
    seq: i64,
) -> Result<String, ApiError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT mt.name, p.label FROM metal_type mt JOIN purity p ON p.id = $2 WHERE mt.id = $1",
    )
    .bind(metal_type_id)
    .bind(purity_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(internal)?;
    let (metal, label) = row.unwrap_or_else(|| ("gold".to_string(), String::new()));
    let mc = match metal.as_str() {
        "gold" => "G",
        "silver" => "S",
        "platinum" => "P",
        _ => "X",
    };
    let karat: String = label.chars().filter(|c| c.is_ascii_digit()).collect();
    Ok(format!("{mc}{karat}-{seq:06}"))
}

/// Resolve a line's department: use the explicit id, else derive from metal + diamond
/// presence + purity (matching the backfill logic) and look it up by name.
async fn resolve_department(
    tx: &mut Transaction<'_, Postgres>,
    explicit: Option<i64>,
    stones: &[LineStoneReq],
    mt_id: Option<i64>,
    pid: Option<i64>,
) -> Result<Option<i64>, ApiError> {
    if explicit.is_some() {
        return Ok(explicit);
    }
    let mname = if let Some(m) = mt_id {
        sqlx::query_scalar::<_, String>("SELECT name FROM metal_type WHERE id=$1").bind(m)
            .fetch_optional(&mut **tx).await.map_err(internal)?
    } else { None };
    let plabel = if let Some(pp) = pid {
        sqlx::query_scalar::<_, String>("SELECT label FROM purity WHERE id=$1").bind(pp)
            .fetch_optional(&mut **tx).await.map_err(internal)?
    } else { None };
    let ids: Vec<i64> = stones.iter().filter_map(|s| s.stone_type_id).collect();
    let has_dia = if ids.is_empty() { false } else {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM stone_type WHERE category='diamond' AND id = ANY($1)")
            .bind(&ids).fetch_one(&mut **tx).await.map_err(internal)? > 0
    };
    let m = mname.as_deref().unwrap_or("");
    let pl = plabel.as_deref().unwrap_or("");
    let dname = if m == "silver" { "Silver Ornaments" }
        else if m == "platinum" { "Platinum Ornaments" }
        else if has_dia { "Diamond Ornaments" }
        else if matches!(pl, "999.9" | "995" | "999") { "Fine Gold" }
        else if m == "gold" { "Gold Ornaments" }
        else { return Ok(None) };
    sqlx::query_scalar::<_, i64>("SELECT id FROM department WHERE name=$1").bind(dname)
        .fetch_optional(&mut **tx).await.map_err(internal)
}

async fn create_purchase(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(p): Json<NewPurchase>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    if p.lines.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "purchase must have at least one line".to_string()));
    }
    let bill_kind = if p.bill_kind == "local" { "local" } else { "b2b" };
    let apply_gst = bill_kind == "b2b" || p.rcm;
    let unfixed = p.unfixed;
    let rate_basis = if unfixed { "unfixed" } else { "fixed" };
    let fy = p.fy.clone().unwrap_or_else(current_fy);
    let series = p.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let branch_id = p.branch_id.unwrap_or(s.default_branch);

    let mut tx = s.db.begin().await.map_err(internal)?;

    let tag_now = p.tag_now.unwrap_or(true);

    // Resolve the party we owe: explicit party_id, else the legacy supplier's linked party.
    let eff_party: Option<i64> = if let Some(pid) = p.party_id {
        Some(pid)
    } else if let Some(sid) = p.supplier_id {
        sqlx::query_scalar("SELECT party_id FROM supplier WHERE id=$1")
            .bind(sid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?
            .flatten()
    } else {
        None
    };

    // Inter-state is a fact of the parties' GST registrations, not a client choice:
    // derive it from the supplier/party state (GSTIN first 2 digits, else state_code)
    // vs the shop's own state. Fall back to the client hint only when states are unknown.
    let seller_state: String = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='seller_state_code'")
        .fetch_optional(&mut *tx).await.map_err(internal)?.unwrap_or_default();
    let recip_state: Option<String> = if let Some(pid) = eff_party {
        sqlx::query_scalar::<_, Option<String>>("SELECT COALESCE(NULLIF(left(gstin,2),''), state_code) FROM party WHERE id=$1")
            .bind(pid).fetch_optional(&mut *tx).await.map_err(internal)?.flatten()
    } else if let Some(sid) = p.supplier_id {
        sqlx::query_scalar::<_, Option<String>>("SELECT NULLIF(left(gstin,2),'') FROM supplier WHERE id=$1")
            .bind(sid).fetch_optional(&mut *tx).await.map_err(internal)?.flatten()
    } else {
        None
    };
    let inter_state = match recip_state.as_deref() {
        Some(rs) if !rs.is_empty() && !seller_state.is_empty() => rs != seller_state,
        _ => p.inter_state,
    };

    let (bill_no, document_no) = allocate_doc_no(&mut tx, "purchase_bill", &fy, series).await?;

    // Insert the bill head first (totals updated after the lines are valued).
    let bill_id: i64 = sqlx::query_scalar(
        "INSERT INTO purchase_bill (branch_id, supplier_id, party_id, bill_kind, rcm, inter_state, \
            series_code, bill_no, document_no, fy, supplier_invoice_no, total, rate_basis) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12) RETURNING id",
    )
    .bind(branch_id)
    .bind(p.supplier_id)
    .bind(eff_party)
    .bind(bill_kind)
    .bind(p.rcm)
    .bind(inter_state)
    .bind(series)
    .bind(bill_no)
    .bind(&document_no)
    .bind(&fy)
    .bind(p.supplier_invoice_no.as_deref())
    .bind(rate_basis)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    let mut subtotal = Decimal::ZERO;
    let mut making_total = Decimal::ZERO;
    let mut stone_total = Decimal::ZERO;
    let mut tax_total = Decimal::ZERO;
    let mut total_fine = Decimal::ZERO;
    let mut item_ids: Vec<i64> = Vec::with_capacity(p.lines.len());

    let hundred = Decimal::from(100);
    let thousand = Decimal::from(1000);

    for line in &p.lines {
        let is_stone = line.pricing_mode == "stone";
        let is_lot = line.pricing_mode == "lot";
        let stone_value: Decimal = line.stones.iter().map(|st| st.value).sum();
        let net = line
            .net_weight
            .unwrap_or(line.gross_weight - line.stone_weight)
            .max(Decimal::ZERO);

        // Resolve metal/purity (required for metal lines, absent for loose-stone lines).
        let (mt_id, pid): (Option<i64>, Option<i64>) = if is_stone {
            (None, None)
        } else {
            let m = line.metal_type_id.ok_or((
                StatusCode::BAD_REQUEST,
                "metal line needs metal_type_id".to_string(),
            ))?;
            let p = line.purity_id.ok_or((
                StatusCode::BAD_REQUEST,
                "metal line needs purity_id".to_string(),
            ))?;
            (Some(m), Some(p))
        };

        // Auto-assign a barcode (SKU) when none is typed, for metal (piece) lines.
        let sku: String = if !is_stone && !is_lot && line.sku.trim().is_empty() {
            let (seq, _doc) = allocate_doc_no(&mut tx, "tag", &fy, series).await?;
            gen_item_barcode(&mut tx, mt_id.unwrap(), pid.unwrap(), seq).await?
        } else {
            line.sku.clone()
        };

        // Metal valuation (skipped entirely for loose-stone lines).
        let (mut metal_amount, making_amount, chargeable_fine) = if is_stone {
            (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO)
        } else {            let fineness: i32 = sqlx::query_scalar("SELECT fineness FROM purity WHERE id=$1")
                .bind(pid.unwrap())
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
            let fine_content = (net * Decimal::from(fineness) / thousand).round_dp(3);
            match line.pricing_mode.as_str() {
                "touch" => {
                    let touch = line.touch_percent.unwrap_or(Decimal::ZERO);
                    let pure = line.pure_rate.unwrap_or(Decimal::ZERO);
                    let cf = (net * touch / hundred).round_dp(3);
                    let ma = round_money(cf * pure);
                    let mk = line.making_per_gram.map(|m| round_money(net * m)).unwrap_or(Decimal::ZERO);
                    (ma, mk, cf)
                }
                "weight_rate" => {
                    let rate = line.rate.unwrap_or(Decimal::ZERO);
                    let ma = round_money(net * rate);
                    let mk = line.making_per_gram.map(|m| round_money(net * m)).unwrap_or(Decimal::ZERO);
                    (ma, mk, fine_content)
                }
                _ => {
                    // fixed_cost / lot: cost_value (or net×rate for a weighed lot) as the
                    // all-in metal+making cost (ex stones).
                    let c = match line.cost_value {
                        Some(c) if c > Decimal::ZERO => c,
                        _ => round_money(net * line.rate.unwrap_or(Decimal::ZERO)),
                    };
                    (c, Decimal::ZERO, fine_content)
                }
            }
        };

        // Unfixed bill: the metal (gold) is not priced now — it's owed in fine grams and
        // fixed later via rate cutting. Only making/stones are money here.
        if unfixed && !is_stone {
            metal_amount = Decimal::ZERO;
        }

        let taxable = metal_amount + making_amount + stone_value;
        let gst_rate_eff = if apply_gst {
            if is_stone {
                // Diamonds / precious stones are 0.25% GST by default.
                line.gst_rate.unwrap_or(Decimal::new(25, 2))
            } else {
                let mt_gst: Option<Decimal> =
                    sqlx::query_scalar("SELECT gst_rate FROM metal_type WHERE id=$1")
                        .bind(mt_id.unwrap())
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(internal)?;
                line.gst_rate.or(mt_gst).unwrap_or(Decimal::from(3))
            }
        } else {
            Decimal::ZERO
        };
        let tax_amount = round_money(taxable * gst_rate_eff / hundred);
        let line_total = taxable + tax_amount;

        subtotal += taxable;
        making_total += making_amount;
        stone_total += stone_value;
        tax_total += tax_amount;
        total_fine += chargeable_fine;

        // Item cost basis: ex-GST for B2B (GST is input credit); incl for local (no ITC).
        let item_cost = if bill_kind == "b2b" { taxable } else { line_total };
        let dept_id = resolve_department(&mut tx, line.department_id, &line.stones, mt_id, pid).await?;

        // Bulk lot: no piece items yet — create a stock_lot to be tagged later.
        let mut lot_ref: Option<i64> = None;
        if is_lot {
            let gross = if line.gross_weight > Decimal::ZERO { line.gross_weight } else { net };
            let pcs = line.pieces.unwrap_or(0);
            let lid: i64 = sqlx::query_scalar(
                "INSERT INTO stock_lot (branch_id, purchase_bill_id, metal_type_id, purity_id, gross_weight, \
                    net_weight, stone_weight, pieces, remaining_gross, remaining_pieces, cost_value, fine_weight) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5,$8,$9,$10) RETURNING id",
            )
            .bind(branch_id)
            .bind(bill_id)
            .bind(mt_id.unwrap())
            .bind(pid.unwrap())
            .bind(gross)
            .bind(net)
            .bind(line.stone_weight)
            .bind(pcs)
            .bind(taxable)
            .bind(chargeable_fine)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
            lot_ref = Some(lid);
        }

        // Loose-stone lines book each stone into loose-stone inventory (no metal item);
        // metal lines create a stock item and record any set stones (diamond-studded).
        let item_id: Option<i64> = if is_stone {
            for st in &line.stones {
                sqlx::query(
                    "INSERT INTO loose_stone (branch_id, stone_type_id, stone_quality_id, description, \
                        carat, pieces, cost_value, certificate_no, lab, source) \
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'purchase')",
                )
                .bind(branch_id)
                .bind(st.stone_type_id)
                .bind(st.stone_quality_id)
                .bind(st.description.as_deref())
                .bind(st.carat)
                .bind(st.pieces)
                .bind(st.value)
                .bind(st.certificate_no.as_deref())
                .bind(st.lab.as_deref())
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            }
            None
        } else if is_lot {
            None
        } else {
            let iid: i64 = sqlx::query_scalar(
                "INSERT INTO item (branch_id, sku, metal_type_id, purity_id, gross_weight, net_weight, \
                    stone_weight, huid, cost_value, ownership_state, category_id, tag_status, department_id) \
                 VALUES ($9,$1,$2,$3,$4,$5,$6,$7,$8,'in_stock',$10,$11,$12) RETURNING id",
            )
            .bind(&sku)
            .bind(mt_id.unwrap())
            .bind(pid.unwrap())
            .bind(line.gross_weight)
            .bind(net)
            .bind(line.stone_weight)
            .bind(line.huid.as_deref())
            .bind(item_cost)
            .bind(branch_id)
            .bind(line.category_id)
            .bind(if tag_now { "tagged" } else { "untagged" })
            .bind(dept_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;

            // Record the stones set in this item (so diamond ornaments show in stock).
            for st in &line.stones {
                sqlx::query(
                    "INSERT INTO item_stone (item_id, stone_type_id, stone_quality_id, description, \
                        carat, pieces, rate, value, certificate_no, lab) \
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                )
                .bind(iid)
                .bind(st.stone_type_id)
                .bind(st.stone_quality_id)
                .bind(st.description.as_deref())
                .bind(st.carat)
                .bind(st.pieces)
                .bind(st.rate)
                .bind(st.value)
                .bind(st.certificate_no.as_deref())
                .bind(st.lab.as_deref())
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            }

            sqlx::query(
                "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                    after_json, weight_delta, amount_delta, ref_doc_type, ref_doc_id) \
                 VALUES ($6,'item',$1,'received',$2,$3,$4,'purchase_bill',$5)",
            )
            .bind(iid)
            .bind(json!({"ownership_state":"in_stock","sku":sku.clone()}))
            .bind(net)
            .bind(item_cost)
            .bind(bill_id)
            .bind(branch_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;

            Some(iid)
        };

        let stone_json = if line.stones.is_empty() {
            None
        } else {
            Some(serde_json::to_value(&line.stones).map_err(internal)?)
        };
        let line_hsn: Option<String> = match line.hsn.clone() {
            Some(h) if !h.trim().is_empty() => Some(h),
            _ => {
                if let Some(m) = mt_id {
                    sqlx::query_scalar::<_, Option<String>>("SELECT default_hsn FROM metal_type WHERE id=$1")
                        .bind(m).fetch_optional(&mut *tx).await.map_err(internal)?.flatten()
                } else if line.pricing_mode == "stone" {
                    Some("7102".to_string())
                } else {
                    None
                }
            }
        };
        sqlx::query(
            "INSERT INTO purchase_bill_line (purchase_bill_id, item_id, description, cost_value, \
                pricing_mode, metal_type_id, purity_id, gross_weight, net_weight, stone_weight, \
                touch_percent, pure_rate, rate, making_per_gram, making_amount, chargeable_fine, \
                stone_value, hsn, taxable_value, gst_rate, tax_amount, line_total, stone_json, stock_lot_id, department_id) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)",
        )
        .bind(bill_id)
        .bind(item_id)
        .bind(&sku)
        .bind(line_total)
        .bind(&line.pricing_mode)
        .bind(mt_id)
        .bind(pid)
        .bind(line.gross_weight)
        .bind(net)
        .bind(line.stone_weight)
        .bind(line.touch_percent)
        .bind(line.pure_rate)
        .bind(line.rate)
        .bind(line.making_per_gram)
        .bind(making_amount)
        .bind(chargeable_fine)
        .bind(stone_value)
        .bind(line_hsn.as_deref())
        .bind(taxable)
        .bind(gst_rate_eff)
        .bind(tax_amount)
        .bind(line_total)
        .bind(stone_json)
        .bind(lot_ref)
        .bind(dept_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

        if let Some(iid) = item_id {
            item_ids.push(iid);
        }
    }

    // Round the grand total to the nearest rupee; keep the rounding delta.
    let grand_raw = subtotal + tax_total;
    let grand = grand_raw.round_dp(0);
    let round_off = grand - grand_raw;

    // Settlement payments.
    let mut paid_total = Decimal::ZERO;
    for pay in &p.payments {
        if pay.amount <= Decimal::ZERO {
            continue;
        }
        let mode = match pay.mode.as_str() {
            "bank" => "bank",
            "cheque" => "cheque",
            _ => "cash",
        };
        sqlx::query(
            "INSERT INTO purchase_payment (purchase_bill_id, mode, amount, reference) VALUES ($1,$2,$3,$4)",
        )
        .bind(bill_id)
        .bind(mode)
        .bind(pay.amount)
        .bind(pay.reference.as_deref())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        paid_total += pay.amount;
    }

    sqlx::query(
        "UPDATE purchase_bill SET subtotal=$1, making_total=$2, stone_total=$3, tax_total=$4, \
            round_off=$5, total=$6, total_fine=$7, paid_total=$8 WHERE id=$9",
    )
    .bind(subtotal)
    .bind(making_total)
    .bind(stone_total)
    .bind(tax_total)
    .bind(round_off)
    .bind(grand)
    .bind(total_fine)
    .bind(paid_total)
    .bind(bill_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    // Post to the supplier's party ledger (debtor-positive): purchase = we owe (negative),
    // payment reduces what we owe (positive).
    if let Some(pid) = eff_party {
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                after_json, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($5,'party',$1,'purchase',$2,$3,'purchase_bill',$4)",
        )
        .bind(pid)
        .bind(json!({"document_no": document_no, "bill_kind": bill_kind}))
        .bind(-grand)
        .bind(bill_id)
        .bind(branch_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        if paid_total > Decimal::ZERO {
            sqlx::query(
                "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                    after_json, amount_delta, ref_doc_type, ref_doc_id) \
                 VALUES ($5,'party',$1,'payment',$2,$3,'purchase_bill',$4)",
            )
            .bind(pid)
            .bind(json!({"document_no": document_no, "paid": paid_total.to_string()}))
            .bind(paid_total)
            .bind(bill_id)
            .bind(branch_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }
        // Unfixed bill: we owe the supplier the metal in fine grams (metal account, negative).
        if unfixed && total_fine > Decimal::ZERO {
            sqlx::query(
                "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
                    after_json, weight_delta, ref_doc_type, ref_doc_id) \
                 VALUES ($5,'party',$1,'purchase_unfixed',$2,$3,'purchase_bill',$4)",
            )
            .bind(pid)
            .bind(json!({"document_no": document_no, "fine_grams": total_fine.to_string()}))
            .bind(-total_fine)
            .bind(bill_id)
            .bind(branch_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }
    }

    tx.commit().await.map_err(internal)?;

    Ok(Json(json!({
        "purchase_bill_id": bill_id,
        "document_no": document_no,
        "subtotal": subtotal.to_string(),
        "tax_total": tax_total.to_string(),
        "total": grand.to_string(),
        "total_fine": total_fine.to_string(),
        "paid_total": paid_total.to_string(),
        "balance": (grand - paid_total).to_string(),
        "items_received": item_ids,
    })))
}

// ---- Purchase returns (debit note) ----

#[derive(Deserialize)]
struct NewPurchaseReturn {
    purchase_bill_id: i64,
    line_ids: Vec<i64>,
    refund_mode: Option<String>,
    note: Option<String>,
    series_code: Option<String>,
}

/// Return selected lines of a purchase bill to the supplier (debit note). Items leave stock,
/// the lines are marked returned, and the supplier payable is reduced (party ledger credit).
async fn create_purchase_return(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewPurchaseReturn>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    if n.line_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "select at least one line to return".to_string()));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;

    // Bill head → party + branch.
    let head: Option<(i64, Option<i64>, String)> = sqlx::query_as(
        "SELECT branch_id, party_id, fy FROM purchase_bill WHERE id=$1",
    )
    .bind(n.purchase_bill_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (branch_id, party_id, fy) =
        head.ok_or((StatusCode::NOT_FOUND, format!("purchase bill {} not found", n.purchase_bill_id)))?;

    let series = n.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let (ret_no, document_no) = allocate_doc_no(&mut tx, "debit_note", &fy, series).await?;

    let ret_id: i64 = sqlx::query_scalar(
        "INSERT INTO purchase_return (branch_id, purchase_bill_id, party_id, series_code, return_no, \
            document_no, fy, refund_mode, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    )
    .bind(branch_id)
    .bind(n.purchase_bill_id)
    .bind(party_id)
    .bind(series)
    .bind(ret_no)
    .bind(&document_no)
    .bind(&fy)
    .bind(n.refund_mode.as_deref().unwrap_or("payable_adjust"))
    .bind(n.note.as_deref())
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    let mut subtotal = Decimal::ZERO;
    let mut tax_total = Decimal::ZERO;
    let mut total = Decimal::ZERO;

    for lid in &n.line_ids {
        // Lock the line; skip if already returned or on a different bill.
        let line: Option<(i64, Option<i64>, String, Decimal, Decimal, Decimal, bool)> = sqlx::query_as(
            "SELECT purchase_bill_id, item_id, COALESCE(description,''), taxable_value, tax_amount, line_total, returned \
             FROM purchase_bill_line WHERE id=$1 FOR UPDATE",
        )
        .bind(lid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let Some((bill_id, item_id, desc, taxable, tax, line_total, returned)) = line else { continue };
        if bill_id != n.purchase_bill_id || returned {
            continue;
        }

        sqlx::query("UPDATE purchase_bill_line SET returned = true WHERE id=$1")
            .bind(lid)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;

        // Item leaves stock (only if still in stock).
        if let Some(iid) = item_id {
            sqlx::query("UPDATE item SET ownership_state='returned' WHERE id=$1 AND ownership_state='in_stock'")
                .bind(iid)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            sqlx::query(
                "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
                    ref_doc_type, ref_doc_id) VALUES ($1,'item',$2,'returned_to_supplier',$3,'purchase_return',$4)",
            )
            .bind(branch_id)
            .bind(iid)
            .bind(json!({"ownership_state": "returned"}))
            .bind(ret_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }

        sqlx::query(
            "INSERT INTO purchase_return_line (purchase_return_id, purchase_bill_line_id, item_id, \
                description, taxable_value, tax_amount, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(ret_id)
        .bind(lid)
        .bind(item_id)
        .bind(&desc)
        .bind(taxable)
        .bind(tax)
        .bind(line_total)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

        subtotal += taxable;
        tax_total += tax;
        total += line_total;
    }

    if total == Decimal::ZERO {
        return Err((StatusCode::CONFLICT, "nothing to return (lines already returned or invalid)".to_string()));
    }

    sqlx::query("UPDATE purchase_return SET subtotal=$1, tax_total=$2, total=$3 WHERE id=$4")
        .bind(subtotal)
        .bind(tax_total)
        .bind(total)
        .bind(ret_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

    // Reduce what we owe the supplier (party ledger is debtor-positive; a return credits us).
    if let Some(pid) = party_id {
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
                amount_delta, ref_doc_type, ref_doc_id) VALUES ($1,'party',$2,'purchase_return',$3,$4,'purchase_return',$5)",
        )
        .bind(branch_id)
        .bind(pid)
        .bind(json!({"document_no": document_no}))
        .bind(total) // positive: reduces our payable to the supplier
        .bind(ret_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "purchase_return_id": ret_id, "document_no": document_no,
        "subtotal": subtotal.to_string(), "tax_total": tax_total.to_string(), "total": total.to_string(),
    })))
}

async fn list_purchase_returns(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, Option<String>, Option<String>, Decimal, Decimal, String, i64)>(
        "SELECT pr.id, pr.document_no, COALESCE(p.display_name, sup.name), pr.total, pr.tax_total, \
            pr.created_at::text, pr.purchase_bill_id \
         FROM purchase_return pr \
         LEFT JOIN party p ON p.id = pr.party_id \
         LEFT JOIN purchase_bill pb ON pb.id = pr.purchase_bill_id \
         LEFT JOIN supplier sup ON sup.id = pb.supplier_id \
         ORDER BY pr.id DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|(id, doc, name, total, tax, at, bill)| json!({
            "id": id, "document_no": doc, "party_name": name, "total": total.to_string(),
            "tax_total": tax.to_string(), "created_at": at, "purchase_bill_id": bill,
        }))
        .collect::<Vec<_>>())))
}


// ---- Stock lots (bulk) + tagging ----

async fn list_stock_lots(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query_as::<_, (i64, Option<String>, String, Option<String>, Decimal, Decimal, i32, Decimal, i32, Decimal, String)>(
        "SELECT sl.id, sl.lot_no, mt.name, p.label, sl.gross_weight, sl.net_weight, sl.pieces, \
            sl.remaining_gross, sl.remaining_pieces, sl.cost_value, sl.created_at::text \
         FROM stock_lot sl JOIN metal_type mt ON mt.id = sl.metal_type_id \
         LEFT JOIN purity p ON p.id = sl.purity_id \
         WHERE sl.status = 'open' ORDER BY sl.id DESC",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|(id, no, metal, purity, gross, net, pcs, rg, rp, cost, at)| json!({
            "id": id, "lot_no": no, "metal": metal, "purity": purity,
            "gross_weight": gross.to_string(), "net_weight": net.to_string(), "pieces": pcs,
            "remaining_gross": rg.to_string(), "remaining_pieces": rp, "cost_value": cost.to_string(),
            "created_at": at,
        }))
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct TagPieceReq {
    gross_weight: Decimal,
    net_weight: Option<Decimal>,
    #[serde(default)]
    stone_weight: Decimal,
    huid: Option<String>,
    category_id: Option<i64>,
    department_id: Option<i64>,
}
#[derive(Deserialize)]
struct TagLotReq {
    pieces: Vec<TagPieceReq>,
}

/// Tag (carve) weighed pieces out of a bulk lot into barcoded stock items, decrementing the
/// lot's remaining balance. Returns the new item ids (for tag printing).
async fn tag_stock_lot(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<TagLotReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("purchase.create")?;
    if req.pieces.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "add at least one piece to tag".to_string()));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;
    let lot: Option<(i64, i64, i64, Decimal, Decimal, Decimal, i32, String)> = sqlx::query_as(
        "SELECT branch_id, metal_type_id, purity_id, net_weight, cost_value, remaining_gross, \
            remaining_pieces, status FROM stock_lot WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (branch_id, mt, pid, lot_net, lot_cost, mut rem_gross, mut rem_pieces, status) =
        lot.ok_or((StatusCode::NOT_FOUND, format!("lot {id} not found")))?;
    if status != "open" {
        return Err((StatusCode::CONFLICT, format!("lot {id} is '{status}' — cannot tag")));
    }
    let fy = current_fy();
    let mut created: Vec<i64> = Vec::new();
    for p in &req.pieces {
        let net = p.net_weight.unwrap_or(p.gross_weight - p.stone_weight).max(Decimal::ZERO);
        let (seq, _doc) = allocate_doc_no(&mut tx, "tag", &fy, SERIES_DEFAULT).await?;
        let sku = gen_item_barcode(&mut tx, mt, pid, seq).await?;
        let cost = if lot_net > Decimal::ZERO {
            round_money(lot_cost * net / lot_net)
        } else {
            Decimal::ZERO
        };
        let iid: i64 = sqlx::query_scalar(
            "INSERT INTO item (branch_id, sku, metal_type_id, purity_id, gross_weight, net_weight, \
                stone_weight, huid, cost_value, ownership_state, category_id, lot_id, department_id) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'in_stock',$10,$11,$12) RETURNING id",
        )
        .bind(branch_id)
        .bind(&sku)
        .bind(mt)
        .bind(pid)
        .bind(p.gross_weight)
        .bind(net)
        .bind(p.stone_weight)
        .bind(p.huid.as_deref())
        .bind(cost)
        .bind(p.category_id)
        .bind(id)
        .bind(resolve_department(&mut tx, p.department_id, &[], Some(mt), Some(pid)).await?)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
                weight_delta, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($6,'item',$1,'tagged',$2,$3,$4,'stock_lot',$5)",
        )
        .bind(iid)
        .bind(json!({"ownership_state":"in_stock","sku":sku,"lot_id":id}))
        .bind(net)
        .bind(cost)
        .bind(id)
        .bind(branch_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        rem_gross -= p.gross_weight;
        rem_pieces -= 1;
        created.push(iid);
    }
    let new_status = if rem_gross <= Decimal::new(5, 2) || rem_pieces <= 0 { "closed" } else { "open" };
    sqlx::query("UPDATE stock_lot SET remaining_gross = $1, remaining_pieces = $2, status = $3 WHERE id = $4")
        .bind(rem_gross)
        .bind(rem_pieces)
        .bind(new_status)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "lot_id": id, "tagged": created.len(), "item_ids": created,
        "remaining_gross": rem_gross.to_string(), "remaining_pieces": rem_pieces, "status": new_status,
    })))
}

// ===================== Staff / Attendance / Leave / Payroll =====================

fn days_in_month(y: i32, m: u32) -> i32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 },
        _ => 30,
    }
}

#[derive(Deserialize)]
struct StaffReq {
    code: String,
    name: String,
    phone: Option<String>,
    designation: Option<String>,
    department: Option<String>,
    join_date: Option<String>,
    salary_type: Option<String>,
    base_salary: Option<Decimal>,
    allowances: Option<Decimal>,
    biometric_user_id: Option<String>,
    pan: Option<String>,
    aadhaar: Option<String>,
    bank_account: Option<String>,
    bank_ifsc: Option<String>,
    uan: Option<String>,
    esi_ip: Option<String>,
    weekly_off: Option<i32>,
    status: Option<String>,
}

async fn list_staff(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, Option<String>, Option<String>, Option<String>, String, Decimal, Decimal, Option<String>, i32, String, Option<String>, Option<String>)>(
        "SELECT id, code, name, phone, designation, department, join_date::text, salary_type, base_salary, \
            allowances, biometric_user_id, weekly_off, status, uan, esi_ip FROM staff WHERE branch_id=$1 ORDER BY status, name",
    )
    .bind(s.default_branch)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "id": r.0, "code": r.1, "name": r.2, "phone": r.3, "designation": r.4, "department": r.5,
            "join_date": r.6, "salary_type": r.7, "base_salary": r.8.to_string(), "allowances": r.9.to_string(),
            "biometric_user_id": r.10, "weekly_off": r.11, "status": r.12, "uan": r.13, "esi_ip": r.14,
        }))
        .collect::<Vec<_>>())))
}

async fn get_staff(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    #[derive(sqlx::FromRow)]
    struct StaffDetailRow {
        id: i64,
        code: String,
        name: String,
        phone: Option<String>,
        designation: Option<String>,
        department: Option<String>,
        join_date: Option<String>,
        salary_type: String,
        base_salary: Decimal,
        allowances: Decimal,
        biometric_user_id: Option<String>,
        pan: Option<String>,
        aadhaar: Option<String>,
        bank_account: Option<String>,
        bank_ifsc: Option<String>,
        uan: Option<String>,
        esi_ip: Option<String>,
        weekly_off: i32,
        status: String,
    }
    let r: Option<StaffDetailRow> = sqlx::query_as(
        "SELECT id, code, name, phone, designation, department, join_date::text AS join_date, salary_type, base_salary, \
            allowances, biometric_user_id, pan, aadhaar, bank_account, bank_ifsc, uan, esi_ip, weekly_off, status \
         FROM staff WHERE id=$1 AND branch_id=$2",
    )
    .bind(id)
    .bind(s.default_branch)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?;
    let r = r.ok_or((StatusCode::NOT_FOUND, "staff not found".to_string()))?;
    Ok(Json(json!({
        "id": r.id, "code": r.code, "name": r.name, "phone": r.phone, "designation": r.designation, "department": r.department,
        "join_date": r.join_date, "salary_type": r.salary_type, "base_salary": r.base_salary.to_string(), "allowances": r.allowances.to_string(),
        "biometric_user_id": r.biometric_user_id, "pan": r.pan, "aadhaar": r.aadhaar, "bank_account": r.bank_account, "bank_ifsc": r.bank_ifsc,
        "uan": r.uan, "esi_ip": r.esi_ip, "weekly_off": r.weekly_off, "status": r.status,
    })))
}

async fn create_staff(State(s): State<AppState>, auth: AuthUser, Json(r): Json<StaffReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO staff (branch_id, code, name, phone, designation, department, join_date, salary_type, \
            base_salary, allowances, biometric_user_id, pan, aadhaar, bank_account, bank_ifsc, uan, esi_ip, weekly_off, status) \
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19,'active')) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(&r.code)
    .bind(&r.name)
    .bind(&r.phone)
    .bind(&r.designation)
    .bind(&r.department)
    .bind(&r.join_date)
    .bind(r.salary_type.as_deref().unwrap_or("monthly"))
    .bind(r.base_salary.unwrap_or_default())
    .bind(r.allowances.unwrap_or_default())
    .bind(&r.biometric_user_id)
    .bind(&r.pan)
    .bind(&r.aadhaar)
    .bind(&r.bank_account)
    .bind(&r.bank_ifsc)
    .bind(&r.uan)
    .bind(&r.esi_ip)
    .bind(r.weekly_off.unwrap_or(0))
    .bind(&r.status)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

async fn update_staff(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(r): Json<StaffReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    sqlx::query(
        "UPDATE staff SET code=$2, name=$3, phone=$4, designation=$5, department=$6, join_date=$7::date, \
            salary_type=$8, base_salary=$9, allowances=$10, biometric_user_id=$11, pan=$12, aadhaar=$13, \
            bank_account=$14, bank_ifsc=$15, uan=$16, esi_ip=$17, weekly_off=$18, status=COALESCE($19,status) WHERE id=$1 AND branch_id=$20",
    )
    .bind(id)
    .bind(&r.code)
    .bind(&r.name)
    .bind(&r.phone)
    .bind(&r.designation)
    .bind(&r.department)
    .bind(&r.join_date)
    .bind(r.salary_type.as_deref().unwrap_or("monthly"))
    .bind(r.base_salary.unwrap_or_default())
    .bind(r.allowances.unwrap_or_default())
    .bind(&r.biometric_user_id)
    .bind(&r.pan)
    .bind(&r.aadhaar)
    .bind(&r.bank_account)
    .bind(&r.bank_ifsc)
    .bind(&r.uan)
    .bind(&r.esi_ip)
    .bind(r.weekly_off.unwrap_or(0))
    .bind(&r.status)
    .bind(s.default_branch)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

// ---- Attendance ----

#[derive(Deserialize)]
struct AttendanceReq {
    staff_id: i64,
    day: String,
    status: String,
    check_in: Option<String>,
    check_out: Option<String>,
    note: Option<String>,
}

async fn mark_attendance(State(s): State<AppState>, auth: AuthUser, Json(r): Json<AttendanceReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    if r.status == "clear" {
        sqlx::query("DELETE FROM attendance WHERE staff_id=$1 AND day=$2::date")
            .bind(r.staff_id).bind(&r.day).execute(&s.db).await.map_err(internal)?;
        return Ok(Json(json!({ "ok": true, "cleared": true })));
    }
    sqlx::query(
        "INSERT INTO attendance (staff_id, day, status, check_in, check_out, hours, source, note) \
         VALUES ($1,$2::date,$3,$4::timestamptz,$5::timestamptz, \
            COALESCE(ROUND(EXTRACT(EPOCH FROM ($5::timestamptz - $4::timestamptz))/3600.0, 2), 0), 'manual', $6) \
         ON CONFLICT (staff_id, day) DO UPDATE SET status=EXCLUDED.status, check_in=EXCLUDED.check_in, \
            check_out=EXCLUDED.check_out, hours=EXCLUDED.hours, source='manual', note=EXCLUDED.note, updated_at=now()",
    )
    .bind(r.staff_id)
    .bind(&r.day)
    .bind(&r.status)
    .bind(&r.check_in)
    .bind(&r.check_out)
    .bind(&r.note)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct MonthQuery {
    month: String,
    staff_id: Option<i64>,
}

async fn list_attendance(State(s): State<AppState>, auth: AuthUser, Query(q): Query<MonthQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, i64, String, String, String, Option<String>, Option<String>, Decimal, String, Option<String>)>(
        "SELECT a.id, a.staff_id, st.name, a.day::text, a.status, a.check_in::text, a.check_out::text, a.hours, a.source, a.note \
         FROM attendance a JOIN staff st ON st.id=a.staff_id \
         WHERE st.branch_id=$1 AND to_char(a.day,'YYYY-MM')=$2 AND ($3::bigint IS NULL OR a.staff_id=$3) \
         ORDER BY a.day, st.name",
    )
    .bind(s.default_branch)
    .bind(&q.month)
    .bind(q.staff_id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "id": r.0, "staff_id": r.1, "staff_name": r.2, "day": r.3, "status": r.4,
            "check_in": r.5, "check_out": r.6, "hours": r.7.to_string(), "source": r.8, "note": r.9,
        }))
        .collect::<Vec<_>>())))
}

async fn attendance_summary(State(s): State<AppState>, auth: AuthUser, Query(q): Query<MonthQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, String, i64, i64, i64, i64, i64, i64, Decimal)>(
        "SELECT st.id, st.name, \
            count(a.*) FILTER (WHERE a.status='present'), \
            count(a.*) FILTER (WHERE a.status='half_day'), \
            count(a.*) FILTER (WHERE a.status='leave'), \
            count(a.*) FILTER (WHERE a.status='absent'), \
            count(a.*) FILTER (WHERE a.status='week_off'), \
            count(a.*) FILTER (WHERE a.status='holiday'), \
            COALESCE(sum(a.hours),0) \
         FROM staff st LEFT JOIN attendance a ON a.staff_id=st.id AND to_char(a.day,'YYYY-MM')=$2 \
         WHERE st.branch_id=$1 AND st.status='active' GROUP BY st.id, st.name ORDER BY st.name",
    )
    .bind(s.default_branch)
    .bind(&q.month)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "staff_id": r.0, "staff_name": r.1, "present": r.2, "half_day": r.3, "leave": r.4,
            "absent": r.5, "week_off": r.6, "holiday": r.7, "hours": r.8.to_string(),
        }))
        .collect::<Vec<_>>())))
}

// ---- Holidays + calendar fill ----

async fn list_holidays(State(s): State<AppState>, auth: AuthUser, Query(q): Query<MonthQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT id, day::text, name FROM holiday WHERE branch_id=$1 AND ($2 = '' OR to_char(day,'YYYY-MM')=$2) ORDER BY day",
    )
    .bind(s.default_branch)
    .bind(&q.month)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows.iter().map(|r| json!({ "id": r.0, "day": r.1, "name": r.2 })).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct HolidayReq {
    day: String,
    name: String,
}

async fn create_holiday(State(s): State<AppState>, auth: AuthUser, Json(r): Json<HolidayReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO holiday (branch_id, day, name) VALUES ($1,$2::date,$3) \
         ON CONFLICT (branch_id, day) DO UPDATE SET name=EXCLUDED.name RETURNING id",
    )
    .bind(s.default_branch)
    .bind(&r.day)
    .bind(&r.name)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

async fn delete_holiday(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    sqlx::query("DELETE FROM holiday WHERE id=$1 AND branch_id=$2").bind(id).bind(s.default_branch).execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

/// Materialise 'holiday' and 'week_off' attendance rows for a month, only on days that
/// have no attendance yet. Holidays take precedence over week-offs. Idempotent.
async fn fill_calendar_tx(tx: &mut Transaction<'_, Postgres>, branch: i64, month: &str) -> Result<(u64, u64), ApiError> {
    let h = sqlx::query(
        "INSERT INTO attendance (staff_id, day, status, source) \
         SELECT st.id, h.day, 'holiday', 'auto' FROM staff st JOIN holiday h ON h.branch_id=st.branch_id \
         WHERE st.branch_id=$1 AND st.status='active' AND to_char(h.day,'YYYY-MM')=$2 \
         ON CONFLICT (staff_id, day) DO NOTHING",
    )
    .bind(branch)
    .bind(month)
    .execute(&mut **tx)
    .await
    .map_err(internal)?;
    let w = sqlx::query(
        "INSERT INTO attendance (staff_id, day, status, source) \
         SELECT st.id, gs::date, 'week_off', 'auto' FROM staff st, \
            generate_series(($2||'-01')::date, (($2||'-01')::date + interval '1 month - 1 day')::date, interval '1 day') gs \
         WHERE st.branch_id=$1 AND st.status='active' AND EXTRACT(DOW FROM gs) = st.weekly_off \
         ON CONFLICT (staff_id, day) DO NOTHING",
    )
    .bind(branch)
    .bind(month)
    .execute(&mut **tx)
    .await
    .map_err(internal)?;
    Ok((h.rows_affected(), w.rows_affected()))
}

async fn fill_calendar(State(s): State<AppState>, auth: AuthUser, Json(q): Json<PayrollReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let (h, w) = fill_calendar_tx(&mut tx, s.default_branch, &q.period).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "holidays_marked": h, "week_offs_marked": w })))
}

// ---- Leave ----

async fn list_leave_types(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, String, String, bool, Decimal)>(
        "SELECT id, code, name, paid, annual_quota FROM leave_type WHERE active ORDER BY code",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({ "id": r.0, "code": r.1, "name": r.2, "paid": r.3, "annual_quota": r.4.to_string() }))
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct LeaveReq {
    staff_id: i64,
    leave_type_id: i64,
    from_day: String,
    to_day: String,
    reason: Option<String>,
    half_day: Option<bool>,
}

async fn apply_leave(State(s): State<AppState>, auth: AuthUser, Json(r): Json<LeaveReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    if r.to_day < r.from_day {
        return Err((StatusCode::BAD_REQUEST, "'to' date cannot be before 'from' date".to_string()));
    }
    let half = r.half_day.unwrap_or(false);
    if half && r.to_day != r.from_day {
        return Err((StatusCode::BAD_REQUEST, "half-day leave must be a single day".to_string()));
    }
    let fd = chrono::NaiveDate::parse_from_str(&r.from_day, "%Y-%m-%d").map_err(|_| (StatusCode::BAD_REQUEST, "bad from date".to_string()))?;
    let td = chrono::NaiveDate::parse_from_str(&r.to_day, "%Y-%m-%d").map_err(|_| (StatusCode::BAD_REQUEST, "bad to date".to_string()))?;
    let requested = if half { Decimal::new(5, 1) } else { Decimal::from((td - fd).num_days() + 1) };

    // Overlap with existing pending/approved leave for this staff.
    let overlap: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM leave_request WHERE staff_id=$1 AND status IN ('pending','approved') \
         AND NOT (to_day < $2::date OR from_day > $3::date)",
    )
    .bind(r.staff_id)
    .bind(&r.from_day)
    .bind(&r.to_day)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    if overlap > 0 {
        return Err((StatusCode::CONFLICT, "overlaps an existing leave request".to_string()));
    }

    // Balance check for paid leave types.
    let lt: Option<(bool, Decimal)> = sqlx::query_as("SELECT paid, annual_quota FROM leave_type WHERE id=$1")
        .bind(r.leave_type_id)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    let (paid, quota) = lt.ok_or((StatusCode::BAD_REQUEST, "unknown leave type".to_string()))?;
    if paid && quota > Decimal::ZERO {
        let year = &r.from_day[0..4];
        let used: Decimal = sqlx::query_scalar(
            "SELECT COALESCE(sum(days),0) FROM leave_request WHERE staff_id=$1 AND leave_type_id=$2 \
             AND status='approved' AND to_char(from_day,'YYYY')=$3",
        )
        .bind(r.staff_id)
        .bind(r.leave_type_id)
        .bind(year)
        .fetch_one(&s.db)
        .await
        .map_err(internal)?;
        if used + requested > quota {
            return Err((StatusCode::CONFLICT, format!("insufficient balance: {} used + {} requested > {} quota", used, requested, quota)));
        }
    }

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO leave_request (staff_id, leave_type_id, from_day, to_day, days, reason, half_day) \
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7) RETURNING id",
    )
    .bind(r.staff_id)
    .bind(r.leave_type_id)
    .bind(&r.from_day)
    .bind(&r.to_day)
    .bind(requested)
    .bind(&r.reason)
    .bind(half)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id, "days": requested.to_string() })))
}

#[derive(Deserialize)]
struct LeaveFilter {
    status: Option<String>,
    staff_id: Option<i64>,
}

async fn list_leave_requests(State(s): State<AppState>, auth: AuthUser, Query(q): Query<LeaveFilter>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, i64, String, String, bool, String, String, Decimal, Option<String>, String, String)>(
        "SELECT lr.id, lr.staff_id, st.name, lt.name, lt.paid, lr.from_day::text, lr.to_day::text, lr.days, \
            lr.reason, lr.status, lr.applied_at::text \
         FROM leave_request lr JOIN staff st ON st.id=lr.staff_id JOIN leave_type lt ON lt.id=lr.leave_type_id \
         WHERE st.branch_id=$1 AND ($2::text IS NULL OR lr.status=$2) AND ($3::bigint IS NULL OR lr.staff_id=$3) \
         ORDER BY lr.applied_at DESC",
    )
    .bind(s.default_branch)
    .bind(&q.status)
    .bind(q.staff_id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "id": r.0, "staff_id": r.1, "staff_name": r.2, "leave_type": r.3, "paid": r.4,
            "from_day": r.5, "to_day": r.6, "days": r.7.to_string(), "reason": r.8, "status": r.9, "applied_at": r.10,
        }))
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct DecideReq {
    status: String, // approved | rejected
}

async fn decide_leave(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(r): Json<DecideReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    if r.status != "approved" && r.status != "rejected" {
        return Err((StatusCode::BAD_REQUEST, "status must be approved or rejected".to_string()));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;
    sqlx::query("UPDATE leave_request SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1")
        .bind(id)
        .bind(&r.status)
        .bind(auth.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    if r.status == "approved" {
        // Write attendance for the leave span: half-day → 'half_day', paid → 'leave', unpaid → 'absent'.
        sqlx::query(
            "INSERT INTO attendance (staff_id, day, status, source) \
             SELECT lr.staff_id, gs::date, \
                CASE WHEN lr.half_day THEN 'half_day' WHEN lt.paid THEN 'leave' ELSE 'absent' END, 'auto' \
             FROM leave_request lr JOIN leave_type lt ON lt.id=lr.leave_type_id, \
                  generate_series(lr.from_day, lr.to_day, interval '1 day') gs \
             WHERE lr.id=$1 \
             ON CONFLICT (staff_id, day) DO UPDATE SET status=EXCLUDED.status, source='auto', updated_at=now()",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

/// Cancel a leave request; if it was approved, remove the auto-posted attendance in its span.
async fn cancel_leave(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    sqlx::query(
        "DELETE FROM attendance a USING leave_request lr \
         WHERE lr.id=$1 AND a.staff_id=lr.staff_id AND a.day BETWEEN lr.from_day AND lr.to_day \
           AND a.source='auto' AND a.status IN ('leave','absent','half_day')",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query("UPDATE leave_request SET status='cancelled', decided_by=$2, decided_at=now() WHERE id=$1")
        .bind(id)
        .bind(auth.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

// ---- Staff advances / loans ----

#[derive(Deserialize)]
struct AdvanceReq {
    staff_id: i64,
    amount: Decimal,
    recovery_per_month: Option<Decimal>,
    note: Option<String>,
}

async fn create_advance(State(s): State<AppState>, auth: AuthUser, Json(r): Json<AdvanceReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO staff_advance (branch_id, staff_id, amount, recovery_per_month, outstanding, note) \
         VALUES ($1,$2,$3,$4,$3,$5) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(r.staff_id)
    .bind(r.amount)
    .bind(r.recovery_per_month.unwrap_or_default())
    .bind(&r.note)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct AdvanceFilter {
    staff_id: Option<i64>,
}

async fn list_staff_advances(State(s): State<AppState>, auth: AuthUser, Query(q): Query<AdvanceFilter>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, i64, String, Decimal, Decimal, Decimal, Option<String>, String, String)>(
        "SELECT sa.id, sa.staff_id, st.name, sa.amount, sa.recovery_per_month, sa.outstanding, sa.note, sa.status, sa.created_at::text \
         FROM staff_advance sa JOIN staff st ON st.id=sa.staff_id \
         WHERE sa.branch_id=$1 AND ($2::bigint IS NULL OR sa.staff_id=$2) ORDER BY sa.created_at DESC",
    )
    .bind(s.default_branch)
    .bind(q.staff_id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows.iter().map(|r| json!({
        "id": r.0, "staff_id": r.1, "staff_name": r.2, "amount": r.3.to_string(),
        "recovery_per_month": r.4.to_string(), "outstanding": r.5.to_string(), "note": r.6, "status": r.7, "created_at": r.8,
    })).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct BalanceQuery {
    staff_id: i64,
    year: String,
}

async fn leave_balances(State(s): State<AppState>, auth: AuthUser, Query(q): Query<BalanceQuery>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, String, String, bool, Decimal, Decimal)>(
        "SELECT lt.id, lt.code, lt.name, lt.paid, lt.annual_quota, \
            COALESCE((SELECT sum(days) FROM leave_request r WHERE r.staff_id=$1 AND r.leave_type_id=lt.id \
                AND r.status='approved' AND to_char(r.from_day,'YYYY')=$2),0) \
         FROM leave_type lt WHERE lt.active ORDER BY lt.code",
    )
    .bind(q.staff_id)
    .bind(&q.year)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "leave_type_id": r.0, "code": r.1, "name": r.2, "paid": r.3,
            "quota": r.4.to_string(), "used": r.5.to_string(), "balance": (r.4 - r.5).to_string(),
        }))
        .collect::<Vec<_>>())))
}

// ---- Payroll ----

#[derive(Deserialize)]
struct PayrollReq {
    period: String, // YYYY-MM
}

async fn generate_payroll(State(s): State<AppState>, auth: AuthUser, Json(r): Json<PayrollReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    // Lock check: payroll for a period should be blocked if that period is locked.
    // Use last day of the month (period = "YYYY-MM") as the effective date.
    {
        let lock_date = format!("{}-31", r.period); // conservative; ISO compare handles month-end
        assert_not_locked(&s.db, &lock_date).await?;
    }
    let (y, m): (i32, u32) = {
        let parts: Vec<&str> = r.period.split('-').collect();
        if parts.len() != 2 {
            return Err((StatusCode::BAD_REQUEST, "period must be YYYY-MM".to_string()));
        }
        (
            parts[0].parse().map_err(|_| (StatusCode::BAD_REQUEST, "bad year".to_string()))?,
            parts[1].parse().map_err(|_| (StatusCode::BAD_REQUEST, "bad month".to_string()))?,
        )
    };
    let dim = days_in_month(y, m);
    let mut tx = s.db.begin().await.map_err(internal)?;
    let run: (i64, String) = sqlx::query_as(
        "INSERT INTO payroll_run (branch_id, period, days_in_month) VALUES ($1,$2,$3) \
         ON CONFLICT (branch_id, period) DO UPDATE SET days_in_month=EXCLUDED.days_in_month RETURNING id, status",
    )
    .bind(s.default_branch)
    .bind(&r.period)
    .bind(dim)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    let (run_id, status) = run;
    if status != "draft" {
        return Err((StatusCode::CONFLICT, format!("payroll for {} is '{}' — cannot regenerate", r.period, status)));
    }
    sqlx::query("DELETE FROM payslip WHERE payroll_run_id=$1").bind(run_id).execute(&mut *tx).await.map_err(internal)?;

    // Make sure week-offs and holidays are materialised so monthly pay is correct.
    fill_calendar_tx(&mut tx, s.default_branch, &r.period).await?;

    let staff = sqlx::query_as::<_, (i64, String, Decimal, Decimal, i64, i64, i64, i64, i64, Decimal)>(
        "SELECT st.id, st.salary_type, st.base_salary, st.allowances, \
            count(a.*) FILTER (WHERE a.status='present'), \
            count(a.*) FILTER (WHERE a.status='half_day'), \
            count(a.*) FILTER (WHERE a.status='leave'), \
            count(a.*) FILTER (WHERE a.status='absent'), \
            count(a.*) FILTER (WHERE a.status IN ('week_off','holiday')), \
            COALESCE(sum(a.hours),0) \
         FROM staff st LEFT JOIN attendance a ON a.staff_id=st.id AND to_char(a.day,'YYYY-MM')=$2 \
         WHERE st.branch_id=$1 AND st.status='active' \
         GROUP BY st.id, st.salary_type, st.base_salary, st.allowances ORDER BY st.name",
    )
    .bind(s.default_branch)
    .bind(&r.period)
    .fetch_all(&mut *tx)
    .await
    .map_err(internal)?;

    // Statutory config.
    let pf_on = setting_bool(&s.db, "payroll.pf_enabled", true).await;
    let pf_pct = setting_dec(&s.db, "payroll.pf_percent", Decimal::from(12)).await;
    let pf_ceiling = setting_dec(&s.db, "payroll.pf_wage_ceiling", Decimal::from(15000)).await;
    let esi_on = setting_bool(&s.db, "payroll.esi_enabled", true).await;
    let esi_pct = setting_dec(&s.db, "payroll.esi_percent", Decimal::new(75, 2)).await;
    let esi_ceiling = setting_dec(&s.db, "payroll.esi_wage_ceiling", Decimal::from(21000)).await;
    let pt_amt = setting_dec(&s.db, "payroll.pt_amount", Decimal::from(200)).await;
    let hundred = Decimal::from(100);
    // OT + employer config.
    let ot_on = setting_bool(&s.db, "payroll.ot_enabled", false).await;
    let ot_mult = setting_dec(&s.db, "payroll.ot_rate_multiplier", Decimal::from(2)).await;
    let full_hours = setting_dec(&s.db, "attendance.full_hours", Decimal::from(8)).await;
    let er_pf_pct = setting_dec(&s.db, "payroll.employer_pf_percent", Decimal::from(13)).await;
    let er_esi_pct = setting_dec(&s.db, "payroll.employer_esi_percent", Decimal::new(325, 2)).await;
    // PT slabs (JSON [{upto, amount}]); empty → flat pt_amt.
    let pt_slabs: Vec<(Decimal, Decimal)> = {
        let raw = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='payroll.pt_slabs'")
            .fetch_optional(&s.db).await.ok().flatten().unwrap_or_default();
        serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok().map(|arr| {
            arr.iter().filter_map(|v| {
                let upto = v.get("upto").and_then(|x| x.as_f64()).map(|f| Decimal::try_from(f).unwrap_or_default())?;
                let amount = v.get("amount").and_then(|x| x.as_f64()).map(|f| Decimal::try_from(f).unwrap_or_default())?;
                Some((upto, amount))
            }).collect()
        }).unwrap_or_default()
    };
    // OT hours per staff = sum of hours beyond the standard day (device-tracked days only).
    let ot_map: std::collections::HashMap<i64, Decimal> = if ot_on {
        sqlx::query_as::<_, (i64, Decimal)>(
            "SELECT a.staff_id, COALESCE(sum(GREATEST(0, a.hours - $3)),0) FROM attendance a \
             JOIN staff st ON st.id=a.staff_id \
             WHERE st.branch_id=$1 AND to_char(a.day,'YYYY-MM')=$2 AND a.status IN ('present','half_day') \
             GROUP BY a.staff_id",
        )
        .bind(s.default_branch)
        .bind(&r.period)
        .bind(full_hours)
        .fetch_all(&mut *tx)
        .await
        .map_err(internal)?
        .into_iter()
        .collect()
    } else {
        Default::default()
    };

    let dim_d = Decimal::from(dim);
    let half = Decimal::new(5, 1); // 0.5
    let mut gross_total = Decimal::ZERO;
    let mut net_total = Decimal::ZERO;
    for (sid, stype, base, allow, present, half_days, paid_leave, absent, offdays, hours) in &staff {
        let present_d = Decimal::from(*present) + Decimal::from(*half_days) * half;
        let paid_leave_d = Decimal::from(*paid_leave);
        let off_d = Decimal::from(*offdays);
        let payable = present_d + paid_leave_d + off_d;
        let lop = Decimal::from(*absent);
        let (base_earned, allow_earned) = match stype.as_str() {
            "daily" => (round_money(*base * present_d), *allow),
            "hourly" => (round_money(*base * *hours), *allow),
            _ => {
                let factor = if dim_d.is_zero() { Decimal::ZERO } else { payable / dim_d };
                (round_money(*base * factor), round_money(*allow * factor))
            }
        };

        // Overtime pay: OT hours × normal hourly rate × multiplier.
        let ot_hours = ot_map.get(sid).copied().unwrap_or(Decimal::ZERO);
        let hourly = match stype.as_str() {
            "hourly" => *base,
            "daily" => if full_hours.is_zero() { Decimal::ZERO } else { *base / full_hours },
            _ => if (dim_d * full_hours).is_zero() { Decimal::ZERO } else { *base / (dim_d * full_hours) },
        };
        let ot_pay = if ot_on { round_money(ot_hours * hourly * ot_mult) } else { Decimal::ZERO };

        let gross = base_earned + allow_earned + ot_pay;

        // Statutory deductions (employee share). PF on basic; ESI/PT on gross.
        let pf = if pf_on { round_money(base_earned.min(pf_ceiling) * pf_pct / hundred) } else { Decimal::ZERO };
        let esi = if esi_on && gross <= esi_ceiling { round_money(gross * esi_pct / hundred) } else { Decimal::ZERO };
        let pt = if gross <= Decimal::ZERO {
            Decimal::ZERO
        } else if pt_slabs.is_empty() {
            pt_amt
        } else {
            // first slab whose ceiling covers gross, else the highest slab's amount
            pt_slabs.iter().find(|(upto, _)| gross <= *upto).map(|(_, a)| *a)
                .unwrap_or_else(|| pt_slabs.last().map(|(_, a)| *a).unwrap_or(Decimal::ZERO))
        };
        let tds = Decimal::ZERO; // manual — editable per payslip

        // Employer contributions (informational, not deducted from net).
        let employer_pf = if pf_on { round_money(base_earned.min(pf_ceiling) * er_pf_pct / hundred) } else { Decimal::ZERO };
        let employer_esi = if esi_on && gross <= esi_ceiling { round_money(gross * er_esi_pct / hundred) } else { Decimal::ZERO };

        // Loan/advance recovery: pull this month's installment, capped at outstanding.
        let adv: Vec<(i64, Decimal, Decimal)> = sqlx::query_as(
            "SELECT id, recovery_per_month, outstanding FROM staff_advance \
             WHERE staff_id=$1 AND status='active' ORDER BY created_at",
        )
        .bind(sid)
        .fetch_all(&mut *tx)
        .await
        .map_err(internal)?;
        let loan_recovery: Decimal = adv.iter().map(|(_, rpm, out)| (*rpm).min(*out).max(Decimal::ZERO)).sum();

        let net = gross - pf - esi - pt - tds - loan_recovery;
        sqlx::query(
            "INSERT INTO payslip (payroll_run_id, staff_id, period, present_days, paid_leave_days, lop_days, \
                payable_days, base_earned, allowances, deductions, pf, esi, pt, tds, loan_recovery, gross, net_pay, \
                ot_hours, ot_pay, employer_pf, employer_esi) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)",
        )
        .bind(run_id)
        .bind(sid)
        .bind(&r.period)
        .bind(present_d)
        .bind(paid_leave_d)
        .bind(lop)
        .bind(payable)
        .bind(base_earned)
        .bind(allow_earned)
        .bind(pf)
        .bind(esi)
        .bind(pt)
        .bind(tds)
        .bind(loan_recovery)
        .bind(gross)
        .bind(net)
        .bind(ot_hours)
        .bind(ot_pay)
        .bind(employer_pf)
        .bind(employer_esi)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
        gross_total += gross;
        net_total += net;
    }
    sqlx::query("UPDATE payroll_run SET gross_total=$2, net_total=$3 WHERE id=$1")
        .bind(run_id)
        .bind(gross_total)
        .bind(net_total)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": run_id, "period": r.period, "staff": staff.len(), "gross_total": gross_total.to_string(), "net_total": net_total.to_string() })))
}

async fn list_payroll_runs(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, String, String, i32, Decimal, Decimal, String)>(
        "SELECT id, period, status, days_in_month, gross_total, net_total, created_at::text \
         FROM payroll_run WHERE branch_id=$1 ORDER BY period DESC",
    )
    .bind(s.default_branch)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "id": r.0, "period": r.1, "status": r.2, "days_in_month": r.3,
            "gross_total": r.4.to_string(), "net_total": r.5.to_string(), "created_at": r.6,
        }))
        .collect::<Vec<_>>())))
}

async fn get_payroll_run(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let run: Option<(i64, String, String, i32, Decimal, Decimal)> = sqlx::query_as(
        "SELECT id, period, status, days_in_month, gross_total, net_total FROM payroll_run WHERE id=$1 AND branch_id=$2",
    )
    .bind(id)
    .bind(s.default_branch)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?;
    let run = run.ok_or((StatusCode::NOT_FOUND, "payroll run not found".to_string()))?;
    #[derive(sqlx::FromRow)]
    struct SlipRow {
        id: i64,
        staff_id: i64,
        name: String,
        code: String,
        present_days: Decimal,
        paid_leave_days: Decimal,
        lop_days: Decimal,
        payable_days: Decimal,
        base_earned: Decimal,
        allowances: Decimal,
        pf: Decimal,
        esi: Decimal,
        pt: Decimal,
        tds: Decimal,
        loan_recovery: Decimal,
        deductions: Decimal,
        net_pay: Decimal,
        ot_hours: Decimal,
        ot_pay: Decimal,
        employer_pf: Decimal,
        employer_esi: Decimal,
        note: Option<String>,
    }
    let slips = sqlx::query_as::<_, SlipRow>(
        "SELECT ps.id, ps.staff_id, st.name, st.code, ps.present_days, ps.paid_leave_days, ps.lop_days, \
            ps.payable_days, ps.base_earned, ps.allowances, ps.pf, ps.esi, ps.pt, ps.tds, ps.loan_recovery, \
            ps.deductions, ps.net_pay, ps.ot_hours, ps.ot_pay, ps.employer_pf, ps.employer_esi, ps.note \
         FROM payslip ps JOIN staff st ON st.id=ps.staff_id WHERE ps.payroll_run_id=$1 ORDER BY st.name",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({
        "id": run.0, "period": run.1, "status": run.2, "days_in_month": run.3,
        "gross_total": run.4.to_string(), "net_total": run.5.to_string(),
        "payslips": slips.iter().map(|r| json!({
            "id": r.id, "staff_id": r.staff_id, "staff_name": r.name, "staff_code": r.code,
            "present_days": r.present_days.to_string(), "paid_leave_days": r.paid_leave_days.to_string(), "lop_days": r.lop_days.to_string(),
            "payable_days": r.payable_days.to_string(), "base_earned": r.base_earned.to_string(), "allowances": r.allowances.to_string(),
            "pf": r.pf.to_string(), "esi": r.esi.to_string(), "pt": r.pt.to_string(), "tds": r.tds.to_string(),
            "loan_recovery": r.loan_recovery.to_string(), "deductions": r.deductions.to_string(),
            "ot_hours": r.ot_hours.to_string(), "ot_pay": r.ot_pay.to_string(),
            "employer_pf": r.employer_pf.to_string(), "employer_esi": r.employer_esi.to_string(),
            "net_pay": r.net_pay.to_string(), "note": r.note,
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct PayrollStatusReq {
    status: String, // finalized | paid
}

async fn set_payroll_status(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(r): Json<PayrollStatusReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    if r.status != "finalized" && r.status != "paid" && r.status != "draft" {
        return Err((StatusCode::BAD_REQUEST, "invalid status".to_string()));
    }
    let mut tx = s.db.begin().await.map_err(internal)?;
    let cur: Option<(String, String, Decimal)> = sqlx::query_as(
        "SELECT status, period, net_total FROM payroll_run WHERE id=$1 AND branch_id=$2 FOR UPDATE",
    )
    .bind(id)
    .bind(s.default_branch)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (prev_status, period, net_total) = cur.ok_or((StatusCode::NOT_FOUND, "payroll run not found".to_string()))?;
    sqlx::query("UPDATE payroll_run SET status=$2 WHERE id=$1")
        .bind(id)
        .bind(&r.status)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    // Transition into 'paid' (once): recover advances FIFO and post the salary payout ledger.
    if r.status == "paid" && prev_status != "paid" {
        let recoveries: Vec<(i64, Decimal)> = sqlx::query_as(
            "SELECT staff_id, loan_recovery FROM payslip WHERE payroll_run_id=$1 AND loan_recovery > 0",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(internal)?;
        for (staff_id, mut rec) in recoveries {
            let advs: Vec<(i64, Decimal)> = sqlx::query_as(
                "SELECT id, outstanding FROM staff_advance WHERE staff_id=$1 AND status='active' ORDER BY created_at",
            )
            .bind(staff_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
            for (aid, out) in advs {
                if rec <= Decimal::ZERO { break; }
                let take = rec.min(out);
                let new_out = out - take;
                sqlx::query("UPDATE staff_advance SET outstanding=$2, status=CASE WHEN $2<=0 THEN 'closed' ELSE 'active' END WHERE id=$1")
                    .bind(aid)
                    .bind(new_out)
                    .execute(&mut *tx)
                    .await
                    .map_err(internal)?;
                rec -= take;
            }
        }
        // Post the salary payout to the append-only ledger (cash out).
        sqlx::query(
            "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, after_json, \
                weight_delta, amount_delta, ref_doc_type, ref_doc_id) \
             VALUES ($1,'payroll',$2,'salary_paid',$3,0,$4,'payroll_run',$2)",
        )
        .bind(s.default_branch)
        .bind(id)
        .bind(json!({ "period": period, "net_total": net_total.to_string() }))
        .bind(-net_total)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct PayslipEditReq {
    allowances: Option<Decimal>,
    deductions: Option<Decimal>,
    pf: Option<Decimal>,
    esi: Option<Decimal>,
    pt: Option<Decimal>,
    tds: Option<Decimal>,
    note: Option<String>,
}

async fn payroll_run_period(s: &AppState, id: i64) -> Result<String, ApiError> {
    sqlx::query_scalar("SELECT period FROM payroll_run WHERE id=$1 AND branch_id=$2")
        .bind(id).bind(s.default_branch).fetch_optional(&s.db).await.map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "payroll run not found".to_string()))
}

/// PF ECR (Electronic Challan cum Return) 2.0 text file — one line per member,
/// fields delimited by `#~#`. Amounts in whole rupees. Reconstructs EPF wages
/// from the payslip PF at the configured PF %; EPS = 8.33% capped at ₹1250.
async fn payroll_pf_ecr(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let period = payroll_run_period(&s, id).await?;
    let pf_pct: Decimal = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='payroll.pf_percent'")
        .fetch_optional(&s.db).await.map_err(internal)?
        .and_then(|v| v.parse().ok()).unwrap_or(Decimal::from(12));
    let rows = sqlx::query_as::<_, (Option<String>, String, Decimal, Decimal, Decimal)>(
        "SELECT st.uan, st.name, ps.gross, ps.pf, ps.lop_days FROM payslip ps JOIN staff st ON st.id=ps.staff_id \
         WHERE ps.payroll_run_id=$1 AND COALESCE(ps.pf,0) > 0 ORDER BY st.name")
        .bind(id).fetch_all(&s.db).await.map_err(internal)?;
    let (c100, ceil, eps_rate, eps_cap) = (Decimal::from(100), Decimal::from(15000), Decimal::new(833, 4), Decimal::from(1250));
    let mut lines: Vec<String> = Vec::new();
    let mut skipped = 0;
    for r in &rows {
        let uan = r.0.as_deref().unwrap_or("").trim();
        if uan.is_empty() { skipped += 1; continue; }
        let epf_wages = if pf_pct != Decimal::ZERO { (r.3 / (pf_pct / c100)).round_dp(0) } else { r.3.round_dp(0) };
        let eps_wages = epf_wages.min(ceil);
        let eps = (eps_wages * eps_rate).round_dp(0).min(eps_cap);
        let ee = r.3.round_dp(0);
        let er = ee - eps;
        lines.push(format!("{}#~#{}#~#{}#~#{}#~#{}#~#{}#~#{}#~#{}#~#{}#~#{}#~#0",
            uan, r.1.to_uppercase(), r.2.round_dp(0), epf_wages, eps_wages, eps_wages, ee, eps, er, r.4.round_dp(0)));
    }
    Ok(Json(json!({ "filename": format!("PF_ECR_{}.txt", period), "content": lines.join("\n"),
        "members": lines.len(), "skipped_no_uan": skipped })))
}

/// ESI monthly contribution CSV — one row per insured person with ESI deducted.
async fn payroll_esi_return(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let period = payroll_run_period(&s, id).await?;
    let rows = sqlx::query_as::<_, (Option<String>, String, Decimal, Decimal)>(
        "SELECT st.esi_ip, st.name, ps.payable_days, ps.gross FROM payslip ps JOIN staff st ON st.id=ps.staff_id \
         WHERE ps.payroll_run_id=$1 AND COALESCE(ps.esi,0) > 0 ORDER BY st.name")
        .bind(id).fetch_all(&s.db).await.map_err(internal)?;
    let mut lines = vec!["IP Number,IP Name,No of Days,Total Monthly Wages,Reason Code for Zero Working Days,Last Working Day".to_string()];
    let mut skipped = 0;
    for r in &rows {
        let ip = r.0.as_deref().unwrap_or("").trim();
        if ip.is_empty() { skipped += 1; continue; }
        let name = r.1.replace(',', " ");
        lines.push(format!("{},{},{},{},,", ip, name, r.2.round_dp(0), r.3.round_dp(0)));
    }
    Ok(Json(json!({ "filename": format!("ESI_{}.csv", period), "content": lines.join("\n"),
        "members": lines.len().saturating_sub(1), "skipped_no_ip": skipped })))
}

async fn update_payslip(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(r): Json<PayslipEditReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    sqlx::query(
        "UPDATE payslip SET allowances=COALESCE($2,allowances), deductions=COALESCE($3,deductions), \
            pf=COALESCE($4,pf), esi=COALESCE($5,esi), pt=COALESCE($6,pt), tds=COALESCE($7,tds), \
            note=COALESCE($8,note), \
            gross=base_earned+COALESCE($2,allowances), \
            net_pay=base_earned+COALESCE($2,allowances) - COALESCE($4,pf) - COALESCE($5,esi) \
                - COALESCE($6,pt) - COALESCE($7,tds) - loan_recovery - COALESCE($3,deductions) \
         WHERE id=$1",
    )
    .bind(id)
    .bind(r.allowances)
    .bind(r.deductions)
    .bind(r.pf)
    .bind(r.esi)
    .bind(r.pt)
    .bind(r.tds)
    .bind(&r.note)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    sqlx::query(
        "UPDATE payroll_run SET gross_total=(SELECT COALESCE(sum(gross),0) FROM payslip WHERE payroll_run_id=payroll_run.id), \
            net_total=(SELECT COALESCE(sum(net_pay),0) FROM payslip WHERE payroll_run_id=payroll_run.id) \
         WHERE id=(SELECT payroll_run_id FROM payslip WHERE id=$1)",
    )
    .bind(id)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

// ---- Biometric devices + punch ingestion ----

/// Insert punches (deduped) and fold each affected staff-day into attendance.
async fn ingest_punches(db: &sqlx::PgPool, branch: i64, device_id: Option<i64>, entries: &[(String, String)], source: &str) -> Result<usize, ApiError> {
    let mut n = 0usize;
    let work_start = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='attendance.work_start'")
        .fetch_optional(db).await.ok().flatten().unwrap_or_else(|| "10:00".to_string());
    let half_day_hours = setting_dec(db, "attendance.half_day_hours", Decimal::from(4)).await;
    let grace = setting_i64(db, "attendance.late_grace_min", 15).await;
    for (bio, ts) in entries {
        if bio.trim().is_empty() || ts.trim().is_empty() {
            continue;
        }
        let staff_id: Option<i64> = sqlx::query_scalar("SELECT id FROM staff WHERE branch_id=$1 AND biometric_user_id=$2")
            .bind(branch)
            .bind(bio)
            .fetch_optional(db)
            .await
            .map_err(internal)?;
        let res = sqlx::query(
            "INSERT INTO attendance_punch (branch_id, staff_id, biometric_user_id, punch_at, device_id, source) \
             VALUES ($1,$2,$3,$4::timestamptz,$5,$6) ON CONFLICT (biometric_user_id, punch_at, device_id) DO NOTHING",
        )
        .bind(branch)
        .bind(staff_id)
        .bind(bio)
        .bind(ts)
        .bind(device_id)
        .bind(source)
        .execute(db)
        .await
        .map_err(internal)?;
        if res.rows_affected() > 0 {
            n += 1;
        }
        if let Some(sid) = staff_id {
            sqlx::query(
                "INSERT INTO attendance (staff_id, day, status, check_in, check_out, hours, late_minutes, source) \
                 SELECT $1, $2::timestamptz::date, \
                    CASE WHEN ROUND(EXTRACT(EPOCH FROM (max(punch_at)-min(punch_at)))/3600.0,2) < $3 THEN 'half_day' ELSE 'present' END, \
                    min(punch_at), max(punch_at), \
                    ROUND(EXTRACT(EPOCH FROM (max(punch_at)-min(punch_at)))/3600.0, 2), \
                    GREATEST(0, (EXTRACT(EPOCH FROM (min(punch_at)::time - $4::time))/60 - $5)::int), 'device' \
                 FROM attendance_punch WHERE staff_id=$1 AND punch_at::date = $2::timestamptz::date \
                 ON CONFLICT (staff_id, day) DO UPDATE SET check_in=EXCLUDED.check_in, check_out=EXCLUDED.check_out, \
                    hours=EXCLUDED.hours, late_minutes=EXCLUDED.late_minutes, \
                    status=CASE WHEN attendance.status IN ('leave','holiday','week_off') THEN attendance.status ELSE EXCLUDED.status END, \
                    source='device', updated_at=now()",
            )
            .bind(sid)
            .bind(ts)
            .bind(half_day_hours)
            .bind(&work_start)
            .bind(grace)
            .execute(db)
            .await
            .map_err(internal)?;
        }
    }
    Ok(n)
}

#[derive(Deserialize)]
struct DeviceReq {
    name: String,
    brand: Option<String>,
    ip: Option<String>,
    port: Option<i32>,
    serial_no: Option<String>,
    enabled: Option<bool>,
}

async fn list_devices(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, i32, Option<String>, bool, Option<String>)>(
        "SELECT id, name, brand, ip, port, serial_no, enabled, last_sync::text FROM biometric_device WHERE branch_id=$1 ORDER BY name",
    )
    .bind(s.default_branch)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "id": r.0, "name": r.1, "brand": r.2, "ip": r.3, "port": r.4,
            "serial_no": r.5, "enabled": r.6, "last_sync": r.7,
        }))
        .collect::<Vec<_>>())))
}

async fn create_device(State(s): State<AppState>, auth: AuthUser, Json(r): Json<DeviceReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO biometric_device (branch_id, name, brand, ip, port, serial_no, enabled) \
         VALUES ($1,$2,COALESCE($3,'zkteco'),$4,COALESCE($5,4370),$6,COALESCE($7,true)) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(&r.name)
    .bind(&r.brand)
    .bind(&r.ip)
    .bind(r.port)
    .bind(&r.serial_no)
    .bind(r.enabled)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "id": id })))
}

async fn update_device(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>, Json(r): Json<DeviceReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    sqlx::query(
        "UPDATE biometric_device SET name=$2, brand=COALESCE($3,brand), ip=$4, port=COALESCE($5,port), \
            serial_no=$6, enabled=COALESCE($7,enabled) WHERE id=$1 AND branch_id=$8",
    )
    .bind(id)
    .bind(&r.name)
    .bind(&r.brand)
    .bind(&r.ip)
    .bind(r.port)
    .bind(&r.serial_no)
    .bind(r.enabled)
    .bind(s.default_branch)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_device(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    sqlx::query("DELETE FROM biometric_device WHERE id=$1 AND branch_id=$2")
        .bind(id)
        .bind(s.default_branch)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

async fn test_device(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let row: Option<(Option<String>, i32)> = sqlx::query_as("SELECT ip, port FROM biometric_device WHERE id=$1 AND branch_id=$2")
        .bind(id)
        .bind(s.default_branch)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    let (ip, port) = row.ok_or((StatusCode::NOT_FOUND, "device not found".to_string()))?;
    let ip = ip.ok_or((StatusCode::BAD_REQUEST, "device has no IP configured".to_string()))?;
    let addr = format!("{ip}:{port}");
    let res = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        let start = std::time::Instant::now();
        match addr.to_socket_addrs().ok().and_then(|mut it| it.next()) {
            Some(sa) => match std::net::TcpStream::connect_timeout(&sa, std::time::Duration::from_secs(3)) {
                Ok(_) => (true, start.elapsed().as_millis() as i64, String::new()),
                Err(e) => (false, 0i64, e.to_string()),
            },
            None => (false, 0i64, "cannot resolve address".to_string()),
        }
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": res.0, "ms": res.1, "error": res.2 })))
}

async fn sync_device(State(s): State<AppState>, auth: AuthUser, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    // Live TCP pull (ZK protocol, port 4370) requires an on-LAN agent and physical device;
    // it cannot run from this server reliably. The supported LAN paths are ADMS/iclock push
    // (configure the device's server IP → it POSTs to /iclock/cdata) and CSV import.
    sqlx::query("UPDATE biometric_device SET last_sync=now() WHERE id=$1 AND branch_id=$2")
        .bind(id)
        .bind(s.default_branch)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({
        "ok": true,
        "message": "Direct pull needs the LAN agent. Point the device's ADMS/cloud server to this host (/iclock) for live push, or use CSV import."
    })))
}

#[derive(Deserialize)]
struct PunchImportReq {
    csv: String,
    device_id: Option<i64>,
}

async fn import_punches(State(s): State<AppState>, auth: AuthUser, Json(r): Json<PunchImportReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    // Each line: biometric_user_id,YYYY-MM-DD HH:MM:SS
    let entries: Vec<(String, String)> = r
        .csv
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut it = line.splitn(2, ',');
            match (it.next(), it.next()) {
                (Some(a), Some(b)) => Some((a.trim().to_string(), b.trim().to_string())),
                _ => None,
            }
        })
        .collect();
    let inserted = ingest_punches(&s.db, s.default_branch, r.device_id, &entries, "import").await?;
    Ok(Json(json!({ "ok": true, "received": entries.len(), "inserted": inserted })))
}

// ---- On-LAN sync agent ingest (key-guarded; the agent has no user login) ----

#[derive(Deserialize)]
struct AgentIngestReq {
    #[serde(default)]
    punches: Vec<(String, String)>, // [[biometric_user_id, "YYYY-MM-DD HH:MM:SS"], ...]
    device_id: Option<i64>,
}

async fn agent_ingest(
    State(s): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(r): Json<AgentIngestReq>,
) -> Result<Json<Value>, ApiError> {
    // Auth via shared secret (app_setting biometric.agent_key). Empty key ⇒ disabled.
    let key = sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key='biometric.agent_key'")
        .fetch_optional(&s.db)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    if key.trim().is_empty() {
        return Err((StatusCode::FORBIDDEN, "agent ingest disabled — set an agent key first".to_string()));
    }
    let given = headers.get("x-agent-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    if given != key {
        return Err((StatusCode::UNAUTHORIZED, "bad agent key".to_string()));
    }
    let inserted = ingest_punches(&s.db, s.default_branch, r.device_id, &r.punches, "device").await?;
    Ok(Json(json!({ "ok": true, "received": r.punches.len(), "inserted": inserted })))
}

// ---- Device discovery + live connection status ----

/// Best-effort detect this host's LAN /24 base (e.g. "192.168.1") for scanning.
fn local_subnet_base() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?; // no packets sent; just picks the default route
    if let std::net::IpAddr::V4(v4) = sock.local_addr().ok()?.ip() {
        let o = v4.octets();
        Some(format!("{}.{}.{}", o[0], o[1], o[2]))
    } else {
        None
    }
}

async fn probe(addr: String) -> (bool, i64) {
    let start = std::time::Instant::now();
    match tokio::time::timeout(std::time::Duration::from_millis(700), tokio::net::TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => (true, start.elapsed().as_millis() as i64),
        _ => (false, 0),
    }
}

#[derive(Deserialize)]
struct ScanReq {
    base: Option<String>,
    port: Option<i32>,
}

/// Scan the LAN /24 for hosts listening on the biometric port (default 4370).
async fn scan_devices(State(s): State<AppState>, auth: AuthUser, Json(req): Json<ScanReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let base = req
        .base
        .filter(|b| !b.trim().is_empty())
        .or_else(local_subnet_base)
        .ok_or((StatusCode::BAD_REQUEST, "could not detect LAN subnet — enter a base like 192.168.1".to_string()))?;
    let port = req.port.unwrap_or(4370);
    // Which IPs are already registered (to flag them in results).
    let known: Vec<String> = sqlx::query_scalar("SELECT ip FROM biometric_device WHERE branch_id=$1 AND ip IS NOT NULL")
        .bind(s.default_branch)
        .fetch_all(&s.db)
        .await
        .map_err(internal)?;
    let mut handles = Vec::new();
    for i in 1..=254u8 {
        let ip = format!("{base}.{i}");
        let addr = format!("{ip}:{port}");
        handles.push(tokio::spawn(async move {
            let (ok, ms) = probe(addr).await;
            if ok { Some((ip, ms)) } else { None }
        }));
    }
    let mut found = Vec::new();
    for h in handles {
        if let Ok(Some((ip, ms))) = h.await {
            let registered = known.iter().any(|k| k == &ip);
            found.push(json!({ "ip": ip, "ms": ms, "registered": registered }));
        }
    }
    Ok(Json(json!({ "base": base, "port": port, "found": found })))
}

/// Live reachability for every registered device (parallel TCP probe).
async fn devices_status(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let devs: Vec<(i64, Option<String>, i32)> =
        sqlx::query_as("SELECT id, ip, port FROM biometric_device WHERE branch_id=$1")
            .bind(s.default_branch)
            .fetch_all(&s.db)
            .await
            .map_err(internal)?;
    let mut handles = Vec::new();
    for (id, ip, port) in devs {
        handles.push(tokio::spawn(async move {
            match ip {
                Some(ip) if !ip.trim().is_empty() => {
                    let (ok, ms) = probe(format!("{ip}:{port}")).await;
                    json!({ "id": id, "ok": ok, "ms": ms })
                }
                _ => json!({ "id": id, "ok": false, "ms": 0 }),
            }
        }));
    }
    let mut out = Vec::new();
    for h in handles {
        if let Ok(v) = h.await {
            out.push(v);
        }
    }
    Ok(Json(json!(out)))
}

// ---- Unmatched punches (unknown biometric id) ----

async fn list_unmatched_punches(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let rows = sqlx::query_as::<_, (String, i64, String, String)>(
        "SELECT biometric_user_id, count(*), min(punch_at)::text, max(punch_at)::text \
         FROM attendance_punch WHERE branch_id=$1 AND staff_id IS NULL AND biometric_user_id IS NOT NULL \
         GROUP BY biometric_user_id ORDER BY biometric_user_id",
    )
    .bind(s.default_branch)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows.iter().map(|r| json!({
        "biometric_user_id": r.0, "count": r.1, "first": r.2, "last": r.3,
    })).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct RelinkReq {
    biometric_user_id: String,
    staff_id: i64,
}

/// Assign a biometric id to a staff member and fold their (now-matched) punches into attendance.
async fn relink_punches(State(s): State<AppState>, auth: AuthUser, Json(r): Json<RelinkReq>) -> Result<Json<Value>, ApiError> {
    auth.require("staff.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    // Remember the id on the staff record so future punches match automatically.
    sqlx::query("UPDATE staff SET biometric_user_id=$2 WHERE id=$1 AND branch_id=$3")
        .bind(r.staff_id)
        .bind(&r.biometric_user_id)
        .bind(s.default_branch)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    let upd = sqlx::query(
        "UPDATE attendance_punch SET staff_id=$1 WHERE biometric_user_id=$2 AND branch_id=$3 AND staff_id IS NULL",
    )
    .bind(r.staff_id)
    .bind(&r.biometric_user_id)
    .bind(s.default_branch)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    // Fold all of this staff's punch-days into attendance.
    sqlx::query(
        "INSERT INTO attendance (staff_id, day, status, check_in, check_out, hours, source) \
         SELECT staff_id, punch_at::date, 'present', min(punch_at), max(punch_at), \
            ROUND(EXTRACT(EPOCH FROM (max(punch_at)-min(punch_at)))/3600.0, 2), 'device' \
         FROM attendance_punch WHERE staff_id=$1 GROUP BY staff_id, punch_at::date \
         ON CONFLICT (staff_id, day) DO UPDATE SET check_in=EXCLUDED.check_in, check_out=EXCLUDED.check_out, \
            hours=EXCLUDED.hours, \
            status=CASE WHEN attendance.status IN ('leave','holiday','week_off') THEN attendance.status ELSE 'present' END, \
            source='device', updated_at=now()",
    )
    .bind(r.staff_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true, "linked_punches": upd.rows_affected() })))
}

// ---- iclock / ADMS push (PUBLIC — LAN-only; device cannot authenticate) ----

#[derive(Deserialize)]
struct IclockQ {
    #[serde(rename = "SN")]
    sn: Option<String>,
    table: Option<String>,
}

/// Device registration/handshake. Real ZK/eSSL firmware reads its polling options here.
async fn iclock_handshake(Query(q): Query<IclockQ>) -> String {
    let sn = q.sn.unwrap_or_default();
    // Standard ADMS option block. Realtime=1 → device pushes ATTLOG as it happens.
    format!(
        "GET OPTION FROM: {sn}\nStamp=9999\nOpStamp=9999\nErrorDelay=30\nDelay=30\n\
         TransTimes=00:00;14:05\nTransInterval=1\nTransFlag=1111000000\nTimeZone=530\n\
         Realtime=1\nEncrypt=0\n"
    )
}

/// Command poll — reply with no pending commands.
async fn iclock_getrequest(Query(_q): Query<IclockQ>) -> String {
    "OK\n".to_string()
}

/// Device posts records. `table=ATTLOG` → punches (`PIN \t YYYY-MM-DD HH:MM:SS \t ...`).
/// Other tables (OPERLOG/OPTIONS/USERINFO) are acknowledged without ingesting.
async fn iclock_cdata(State(s): State<AppState>, Query(q): Query<IclockQ>, body: String) -> String {
    let table = q.table.unwrap_or_default();
    if !table.is_empty() && table != "ATTLOG" {
        return "OK\n".to_string();
    }
    let entries: Vec<(String, String)> = body
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() >= 2 && !cols[0].trim().is_empty() {
                Some((cols[0].trim().to_string(), cols[1].trim().to_string()))
            } else {
                None
            }
        })
        .collect();
    match ingest_punches(&s.db, s.default_branch, None, &entries, "device").await {
        // Most firmware treats a leading "OK" as success; count is informational.
        Ok(n) => format!("OK: {n}\n"),
        Err(_) => "ERROR\n".to_string(),
    }
}

// ---- Auth handlers ----
// ---- Auth handlers ----

/// On first run, create an 'owner' user so the system is usable. Password from
/// BOOTSTRAP_OWNER_PASSWORD (default "admin123" — change immediately).
async fn bootstrap_owner(db: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM app_user")
        .fetch_one(db)
        .await?;
    if count == 0 {
        let pw = env::var("BOOTSTRAP_OWNER_PASSWORD").unwrap_or_else(|_| "admin123".to_string());
        let hash = hash_password(&pw).map_err(|(_, m)| m)?;
        sqlx::query(
            "INSERT INTO app_user (branch_id, username, password_hash, role) \
             VALUES (1, 'owner', $1, 'owner') ON CONFLICT (username) DO NOTHING",
        )
        .bind(&hash)
        .execute(db)
        .await?;
        println!("Bootstrapped 'owner' user (password: BOOTSTRAP_OWNER_PASSWORD or 'admin123').");
    }
    Ok(())
}

#[derive(Deserialize)]
struct LoginReq {
    username: String,
    password: String,
}

/// True if the username is currently locked out (too many recent failures).
fn login_locked(s: &AppState, user: &str) -> bool {
    let mut m = s.login_attempts.lock().expect("lock");
    match m.get(user) {
        Some(a) if a.first.elapsed() < LOGIN_WINDOW => a.count >= LOGIN_MAX_ATTEMPTS,
        Some(_) => {
            m.remove(user); // window expired
            false
        }
        None => false,
    }
}

fn record_login_failure(s: &AppState, user: &str) {
    let mut m = s.login_attempts.lock().expect("lock");
    let e = m.entry(user.to_string()).or_insert(LoginAttempt {
        count: 0,
        first: Instant::now(),
    });
    if e.first.elapsed() >= LOGIN_WINDOW {
        e.count = 0;
        e.first = Instant::now();
    }
    e.count += 1;
}

fn clear_login_failures(s: &AppState, user: &str) {
    s.login_attempts.lock().expect("lock").remove(user);
}

async fn login(
    State(s): State<AppState>,
    Json(req): Json<LoginReq>,
) -> Result<Json<Value>, ApiError> {
    if login_locked(&s, &req.username) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many failed login attempts; try again in a few minutes".to_string(),
        ));
    }

    let row: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT id, password_hash, role FROM app_user WHERE username = $1 AND active",
    )
    .bind(&req.username)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?;

    let (user_id, hash, role) = match row {
        Some(r) => r,
        None => {
            record_login_failure(&s, &req.username);
            return Err((
                StatusCode::UNAUTHORIZED,
                "invalid username or password".to_string(),
            ));
        }
    };
    if !verify_password(&req.password, &hash) {
        record_login_failure(&s, &req.username);
        return Err((
            StatusCode::UNAUTHORIZED,
            "invalid username or password".to_string(),
        ));
    }
    clear_login_failures(&s, &req.username);

    let token = new_token();
    sqlx::query(
        "INSERT INTO session (token, user_id, expires_at) \
         VALUES ($1, $2, now() + interval '12 hours')",
    )
    .bind(&token)
    .bind(user_id)
    .execute(&s.db)
    .await
    .map_err(internal)?;

    Ok(Json(
        json!({ "token": token, "role": role, "expires_in_hours": 12 }),
    ))
}

#[derive(Deserialize)]
struct NewUser {
    username: String,
    password: String,
    role: String,
    branch_id: Option<i64>,
}

/// Create a user (requires `user.manage`).
async fn create_user(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewUser>,
) -> Result<Json<Value>, ApiError> {
    auth.require("user.manage")?;
    if !matches!(n.role.as_str(), "owner" | "manager" | "cashier" | "accountant") {
        return Err((
            StatusCode::BAD_REQUEST,
            "role must be owner|manager|cashier|accountant".to_string(),
        ));
    }
    let hash = hash_password(&n.password)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO app_user (branch_id, username, password_hash, role) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(n.branch_id.unwrap_or(s.default_branch))
    .bind(&n.username)
    .bind(&hash)
    .bind(&n.role)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(
        json!({ "id": id, "username": n.username, "role": n.role }),
    ))
}

/// List all users (requires `user.manage`).
async fn list_users(
    State(s): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    auth.require("user.manage")?;
    let rows: Vec<(i64, String, String, bool, String)> = sqlx::query_as(
        "SELECT id, username, role, active, created_at::text FROM app_user ORDER BY \
         (role='owner') DESC, (role='manager') DESC, username",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|r| json!({ "id": r.0, "username": r.1, "role": r.2, "active": r.3, "created_at": r.4 }))
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
struct UpdateUser {
    role: Option<String>,
    active: Option<bool>,
}

/// Update a user's role / active status (requires `user.manage`).
/// Guards: you can't change your own account here, and the last active owner
/// can't be demoted or deactivated (prevents lock-out).
async fn update_user(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(u): Json<UpdateUser>,
) -> Result<Json<Value>, ApiError> {
    auth.require("user.manage")?;
    if id == auth.id {
        return Err((
            StatusCode::BAD_REQUEST,
            "You can't change your own role or status.".to_string(),
        ));
    }
    if let Some(r) = &u.role {
        if !matches!(r.as_str(), "owner" | "manager" | "cashier" | "accountant") {
            return Err((
                StatusCode::BAD_REQUEST,
                "role must be owner|manager|cashier|accountant".to_string(),
            ));
        }
    }
    let cur: Option<(String, bool)> =
        sqlx::query_as("SELECT role, active FROM app_user WHERE id = $1")
            .bind(id)
            .fetch_optional(&s.db)
            .await
            .map_err(internal)?;
    let (cur_role, _cur_active) =
        cur.ok_or((StatusCode::NOT_FOUND, "user not found".to_string()))?;

    // Prevent removing the last active owner.
    let losing_owner = cur_role == "owner"
        && (u.role.as_deref().map(|r| r != "owner").unwrap_or(false) || u.active == Some(false));
    if losing_owner {
        let other_owners: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM app_user WHERE role = 'owner' AND active AND id <> $1",
        )
        .bind(id)
        .fetch_one(&s.db)
        .await
        .map_err(internal)?;
        if other_owners == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                "Can't demote or deactivate the last active owner.".to_string(),
            ));
        }
    }

    sqlx::query("UPDATE app_user SET role = COALESCE($2, role), active = COALESCE($3, active) WHERE id = $1")
        .bind(id)
        .bind(u.role.as_deref())
        .bind(u.active)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    // Deactivating a user revokes their sessions immediately.
    if u.active == Some(false) {
        sqlx::query("DELETE FROM session WHERE user_id = $1")
            .bind(id)
            .execute(&s.db)
            .await
            .map_err(internal)?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ResetUserPw {
    password: String,
}

/// Reset another user's password (requires `user.manage`). Forces them to re-login.
async fn reset_user_password(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(r): Json<ResetUserPw>,
) -> Result<Json<Value>, ApiError> {
    auth.require("user.manage")?;
    if r.password.len() < 6 {
        return Err((
            StatusCode::BAD_REQUEST,
            "new password must be at least 6 characters".to_string(),
        ));
    }
    let hash = hash_password(&r.password)?;
    let n = sqlx::query("UPDATE app_user SET password_hash = $1 WHERE id = $2")
        .bind(&hash)
        .bind(id)
        .execute(&s.db)
        .await
        .map_err(internal)?
        .rows_affected();
    if n == 0 {
        return Err((StatusCode::NOT_FOUND, "user not found".to_string()));
    }
    // Force re-login with the new credentials.
    sqlx::query("DELETE FROM session WHERE user_id = $1")
        .bind(id)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

/// Permanently delete a user (requires `user.manage`). Guards: can't delete yourself
/// or the last active owner. Their sessions are removed first.
async fn delete_user(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    auth.require("user.manage")?;
    if id == auth.id {
        return Err((
            StatusCode::BAD_REQUEST,
            "You can't delete your own account.".to_string(),
        ));
    }
    let cur: Option<(String,)> = sqlx::query_as("SELECT role FROM app_user WHERE id = $1")
        .bind(id)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    let (cur_role,) = cur.ok_or((StatusCode::NOT_FOUND, "user not found".to_string()))?;
    if cur_role == "owner" {
        let other_owners: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM app_user WHERE role = 'owner' AND active AND id <> $1",
        )
        .bind(id)
        .fetch_one(&s.db)
        .await
        .map_err(internal)?;
        if other_owners == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                "Can't delete the last active owner.".to_string(),
            ));
        }
    }
    sqlx::query("DELETE FROM session WHERE user_id = $1")
        .bind(id)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    sqlx::query("DELETE FROM app_user WHERE id = $1")
        .bind(id)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

/// Log out — invalidate the current session token.
async fn logout(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    sqlx::query("DELETE FROM session WHERE token = $1")
        .bind(&auth.token)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "logged_out": true })))
}

/// Current authenticated user.
async fn me(auth: AuthUser) -> Json<Value> {
    Json(json!({ "id": auth.id, "username": auth.username, "role": auth.role }))
}

#[derive(Deserialize)]
struct ChangePwReq {
    old_password: String,
    new_password: String,
}

/// Change the current user's password (verifies the old one first; revokes other sessions).
async fn change_password(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(req): Json<ChangePwReq>,
) -> Result<Json<Value>, ApiError> {
    if req.new_password.len() < 6 {
        return Err((
            StatusCode::BAD_REQUEST,
            "new password must be at least 6 characters".to_string(),
        ));
    }
    let current_hash: String =
        sqlx::query_scalar("SELECT password_hash FROM app_user WHERE id = $1")
            .bind(auth.id)
            .fetch_one(&s.db)
            .await
            .map_err(internal)?;
    if !verify_password(&req.old_password, &current_hash) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "old password is incorrect".to_string(),
        ));
    }
    let new_hash = hash_password(&req.new_password)?;
    sqlx::query("UPDATE app_user SET password_hash = $1 WHERE id = $2")
        .bind(&new_hash)
        .bind(auth.id)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    // Revoke all other sessions; keep the current one.
    sqlx::query("DELETE FROM session WHERE user_id = $1 AND token <> $2")
        .bind(auth.id)
        .bind(&auth.token)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "password_changed": true })))
}

// ---- Cash & PAN compliance (India, Sec 269ST) + customers ----

/// Enforce statutory cash/identity rules at billing. Protects the jeweller (penalties are
/// severe). The system does NOT help circumvent these.
async fn enforce_cash_pan(
    tx: &mut Transaction<'_, Postgres>,
    grand_total: Decimal,
    customer_id: Option<i64>,
    cash_paid: Decimal,
) -> Result<(), ApiError> {
    let two_lakh = Decimal::from(200_000);
    let five_lakh = Decimal::from(500_000);

    // PAN required once the bill reaches the threshold.
    if grand_total >= two_lakh {
        let pan: Option<String> = match customer_id {
            Some(cid) => sqlx::query_scalar("SELECT pan FROM customer WHERE id = $1")
                .bind(cid)
                .fetch_optional(&mut **tx)
                .await
                .map_err(internal)?
                .flatten(),
            None => None,
        };
        if !pan.map(|p| valid_pan(p.trim())).unwrap_or(false) {
            return Err((
                StatusCode::BAD_REQUEST,
                "a customer with a valid PAN is required for a bill of ₹2,00,000 or more"
                    .to_string(),
            ));
        }
    }

    // Sec 269ST: cash of ₹2,00,000 or more is prohibited.
    if cash_paid >= two_lakh {
        return Err((
            StatusCode::BAD_REQUEST,
            "cash of ₹2,00,000 or more is not allowed (Income Tax Sec. 269ST); use card / UPI / bank / cheque"
                .to_string(),
        ));
    }

    // Above ₹5,00,000: must be fully non-cash.
    if grand_total >= five_lakh && cash_paid > Decimal::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "bills of ₹5,00,000 or more must be settled fully by non-cash tender".to_string(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct NewCustomer {
    name: String,
    phone: Option<String>,
    pan: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct CustomerRow {
    id: i64,
    name: String,
    phone: Option<String>,
    pan: Option<String>,
}

async fn list_customers(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Vec<CustomerRow>>, ApiError> {
    let rows =
        sqlx::query_as::<_, CustomerRow>("SELECT id, name, phone, pan FROM customer ORDER BY id")
            .fetch_all(&s.db)
            .await
            .map_err(internal)?;
    Ok(Json(rows))
}

async fn create_customer(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewCustomer>,
) -> Result<Json<Value>, ApiError> {
    auth.require("customer.manage")?;
    if let Some(pan) = n.pan.as_deref() {
        if !valid_pan(pan.trim()) {
            return Err((
                StatusCode::BAD_REQUEST,
                "invalid PAN format (expected AAAAA9999A)".to_string(),
            ));
        }
    }
    let mut tx = s.db.begin().await.map_err(internal)?;

    // Unified model: every customer is also a Party (role 'customer'), so it shows on the
    // Parties screen with one shared ledger / KYC profile.
    let party_id: i64 = sqlx::query_scalar(
        "INSERT INTO party (branch_id, display_name, party_kind, phone, pan, gst_registration_type) \
         VALUES ($1, $2, 'individual', $3, $4, 'consumer') RETURNING id",
    )
    .bind(s.default_branch)
    .bind(&n.name)
    .bind(n.phone.as_deref())
    .bind(n.pan.as_deref())
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query("INSERT INTO party_role (party_id, role) VALUES ($1, 'customer') ON CONFLICT DO NOTHING")
        .bind(party_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO customer (branch_id, name, phone, pan, party_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(&n.name)
    .bind(n.phone.as_deref())
    .bind(n.pan.as_deref())
    .bind(party_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": id, "party_id": party_id, "name": n.name })))
}

// ---- Reports (owner/manager: require `report.view`) ----

#[derive(Deserialize)]
struct RangeParams {
    from: Option<String>, // YYYY-MM-DD inclusive
    to: Option<String>,   // YYYY-MM-DD inclusive
}

#[derive(Serialize, sqlx::FromRow)]
struct SalesSummary {
    bills: i64,
    gross: Decimal,
    tax: Decimal,
    old_gold: Decimal,
    net_received: Decimal,
}

async fn report_sales(
    State(s): State<AppState>,
    auth: AuthUser,
    Query(q): Query<RangeParams>,
) -> Result<Json<SalesSummary>, ApiError> {
    auth.require("report.view")?;
    let row: SalesSummary = sqlx::query_as(
        "SELECT count(*) AS bills, \
                COALESCE(sum(grand_total), 0) AS gross, \
                COALESCE(sum(tax_total), 0) AS tax, \
                COALESCE(sum(old_gold_value), 0) AS old_gold, \
                COALESCE(sum(amount_payable), 0) AS net_received \
         FROM invoice \
         WHERE status = 'final' \
           AND ($1::date IS NULL OR created_at::date >= $1::date) \
           AND ($2::date IS NULL OR created_at::date <= $2::date)",
    )
    .bind(q.from.as_deref())
    .bind(q.to.as_deref())
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(row))
}

#[derive(Serialize, sqlx::FromRow)]
struct StockRow {
    metal: String,
    purity: String,
    pieces: i64,
    net_weight: Decimal,
    cost_value: Decimal,
}

async fn report_stock(
    State(s): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<StockRow>>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, StockRow>(
        "SELECT mt.name AS metal, p.label AS purity, count(*) AS pieces, \
                COALESCE(sum(i.net_weight), 0) AS net_weight, \
                COALESCE(sum(i.cost_value), 0) AS cost_value \
         FROM item i \
         JOIN metal_type mt ON mt.id = i.metal_type_id \
         JOIN purity p ON p.id = i.purity_id \
         WHERE i.ownership_state = 'in_stock' \
         GROUP BY mt.name, p.label \
         UNION ALL \
         SELECT mt.name AS metal, COALESCE(p.label, '') || ' · scrap' AS purity, count(*) AS pieces, \
                COALESCE(sum(ogl.gross_weight), 0) AS net_weight, \
                COALESCE(sum(ogl.value), 0) AS cost_value \
         FROM old_gold_lot ogl \
         JOIN metal_type mt ON mt.id = ogl.metal_type_id \
         LEFT JOIN purity p ON p.id = ogl.purity_id \
         WHERE ogl.status = 'in_scrap' \
         GROUP BY mt.name, p.label \
         ORDER BY metal, purity",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

/// Metal account / reconciliation — fine-metal in / out / balance per metal, plus the
/// refined pool, drawn from old_gold_lot + melt_batch + smith_job.
async fn report_metal_account(State(s): State<AppState>, auth: AuthUser) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let metals = sqlx::query_as::<_, (i64, String)>("SELECT id, name FROM metal_type ORDER BY id")
        .fetch_all(&s.db)
        .await
        .map_err(internal)?;
    let og = sqlx::query_as::<_, (i64, Decimal, Decimal, Decimal)>(
        "SELECT metal_type_id, COALESCE(sum(fine_weight),0), \
            COALESCE(sum(fine_weight) FILTER (WHERE status='in_scrap'),0), \
            COALESCE(sum(gross_weight) FILTER (WHERE status='in_scrap'),0) \
         FROM old_gold_lot GROUP BY metal_type_id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let melt = sqlx::query_as::<_, (i64, Decimal, Decimal)>(
        "SELECT metal_type_id, COALESCE(sum(fine_recovered),0), COALESCE(sum(loss_weight),0) \
         FROM melt_batch GROUP BY metal_type_id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let sj = sqlx::query_as::<_, (i64, Decimal, Decimal, Decimal, Decimal)>(
        "SELECT metal_type_id, COALESCE(sum(issued_fine_weight),0), \
            COALESCE(sum(issued_fine_weight) FILTER (WHERE source='refined'),0), \
            COALESCE(sum(received_fine),0), COALESCE(sum(wastage_weight),0) \
         FROM smith_job WHERE status IN ('issued','received','settled') GROUP BY metal_type_id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    let z = Decimal::ZERO;
    let out: Vec<Value> = metals
        .iter()
        .map(|(mid, name)| {
            let o = og.iter().find(|x| x.0 == *mid);
            let m = melt.iter().find(|x| x.0 == *mid);
            let j = sj.iter().find(|x| x.0 == *mid);
            let scrap_in = o.map(|x| x.1).unwrap_or(z);
            let onhand_fine = o.map(|x| x.2).unwrap_or(z);
            let onhand_gross = o.map(|x| x.3).unwrap_or(z);
            let recovered = m.map(|x| x.1).unwrap_or(z);
            let loss = m.map(|x| x.2).unwrap_or(z);
            let issued = j.map(|x| x.1).unwrap_or(z);
            let refined_issued = j.map(|x| x.2).unwrap_or(z);
            let returned = j.map(|x| x.3).unwrap_or(z);
            let wastage = j.map(|x| x.4).unwrap_or(z);
            json!({
                "metal": name,
                "scrap_taken_in_fine": scrap_in.to_string(),
                "scrap_on_hand_fine": onhand_fine.to_string(),
                "scrap_on_hand_gross": onhand_gross.to_string(),
                "melted_recovered_fine": recovered.to_string(),
                "melt_loss": loss.to_string(),
                "refined_pool_fine": (recovered - refined_issued).to_string(),
                "issued_to_smith_fine": issued.to_string(),
                "received_from_smith_fine": returned.to_string(),
                "smith_holding_fine": (issued - returned).to_string(),
                "wastage_fine": wastage.to_string(),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

#[derive(Serialize, sqlx::FromRow)]
struct GstSummary {
    taxable: Decimal,
    cgst: Decimal,
    sgst: Decimal,
    igst: Decimal,
}

async fn report_payment_modes(
    State(s): State<AppState>,
    auth: AuthUser,
    Query(q): Query<RangeParams>,
) -> Result<Json<Value>, ApiError> {
    auth.require("report.view")?;
    let rows = sqlx::query_as::<_, (String, i64, Decimal)>(
        "SELECT t.mode, count(*) AS cnt, COALESCE(sum(t.amount), 0) AS total \
         FROM invoice_tender t JOIN invoice i ON i.id = t.invoice_id \
         WHERE ($1::date IS NULL OR i.created_at::date >= $1::date) \
           AND ($2::date IS NULL OR i.created_at::date <= $2::date) \
         GROUP BY t.mode ORDER BY t.mode",
    )
    .bind(q.from.as_deref())
    .bind(q.to.as_deref())
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|(mode, cnt, total)| json!({ "mode": mode, "count": cnt, "total": total.to_string() }))
        .collect();
    Ok(Json(json!(out)))
}

async fn report_gst(
    State(s): State<AppState>,
    auth: AuthUser,
    Query(q): Query<RangeParams>,
) -> Result<Json<GstSummary>, ApiError> {
    auth.require("report.view")?;
    let row: GstSummary = sqlx::query_as(
        "SELECT COALESCE(sum(il.taxable_value), 0) AS taxable, \
                COALESCE(sum((il.breakdown_json->>'cgst')::numeric), 0) AS cgst, \
                COALESCE(sum((il.breakdown_json->>'sgst')::numeric), 0) AS sgst, \
                COALESCE(sum((il.breakdown_json->>'igst')::numeric), 0) AS igst \
         FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id \
         WHERE i.status = 'final' \
           AND ($1::date IS NULL OR i.created_at::date >= $1::date) \
           AND ($2::date IS NULL OR i.created_at::date <= $2::date)",
    )
    .bind(q.from.as_deref())
    .bind(q.to.as_deref())
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(row))
}

#[derive(Deserialize)]
struct LedgerParams {
    limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct LedgerRow {
    id: i64,
    occurred_at: String,
    subject_type: String,
    subject_id: i64,
    event_type: String,
    amount_delta: Option<Decimal>,
    ref_doc_type: Option<String>,
    ref_doc_id: Option<i64>,
}

async fn report_ledger(
    State(s): State<AppState>,
    auth: AuthUser,
    Query(q): Query<LedgerParams>,
) -> Result<Json<Vec<LedgerRow>>, ApiError> {
    auth.require("report.view")?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<_, LedgerRow>(
        "SELECT id, occurred_at::text AS occurred_at, subject_type, subject_id, event_type, \
                amount_delta, ref_doc_type, ref_doc_id \
         FROM ledger_event ORDER BY id DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

// ---- Unit tests for pure logic (no DB) ----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fy_compaction() {
        assert_eq!(compact_fy("2026-27"), "2627");
        assert_eq!(compact_fy("2027-28"), "2728");
        assert_eq!(compact_fy("2030-31"), "3031");
    }

    #[test]
    fn default_prefixes() {
        assert_eq!(default_prefix("invoice", "2026-27"), "INV-2627-");
        assert_eq!(default_prefix("credit_note", "2026-27"), "CRN-2627-");
        assert_eq!(default_prefix("purchase_bill", "2026-27"), "PUR-2627-");
        assert_eq!(default_prefix("debit_note", "2026-27"), "DBN-2627-");
    }

    #[test]
    fn rbac_matrix() {
        assert!(has_permission("owner", "user.manage"));
        assert!(has_permission("owner", "anything"));
        assert!(has_permission("manager", "rate.edit"));
        assert!(has_permission("manager", "report.view"));
        assert!(!has_permission("manager", "user.manage"));
        assert!(has_permission("cashier", "sale.create"));
        assert!(has_permission("cashier", "customer.manage"));
        assert!(!has_permission("cashier", "rate.edit"));
        assert!(!has_permission("cashier", "report.view"));
        assert!(!has_permission("unknown", "sale.create"));
    }

    #[test]
    fn pan_validation() {
        assert!(valid_pan("ABCDE1234F"));
        assert!(!valid_pan("ABCDE1234")); // too short
        assert!(!valid_pan("abcde1234f")); // lowercase
        assert!(!valid_pan("ABCD12345F")); // wrong layout
        assert!(!valid_pan("ABCDE12345")); // last must be a letter
    }

    #[test]
    fn password_roundtrip() {
        let h = hash_password("secret123").unwrap();
        assert!(verify_password("secret123", &h));
        assert!(!verify_password("wrong", &h));
    }

    #[test]
    fn tokens_are_unique_and_sized() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}

// ---- HTTP + DB integration tests ----
// These exercise the real router against a real PostgreSQL via tower `oneshot`.
// Requires TEST_DATABASE_URL pointing at a DEDICATED, disposable database; if unset, the
// test is skipped (so unit-only `cargo test` still passes without a DB).

#[cfg(test)]
mod itest {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt; // for `oneshot`

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            builder = builder.header(AUTHORIZATION, format!("Bearer {t}"));
        }
        let req = match body {
            Some(b) => builder
                .header("content-type", "application/json")
                .body(Body::from(b.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, v)
    }

    #[tokio::test]
    async fn full_retail_flow() {
        let Ok(url) = env::var("TEST_DATABASE_URL") else {
            eprintln!("skipping integration test: TEST_DATABASE_URL not set");
            return;
        };
        let db = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!("../../db/migrations")
            .run(&db)
            .await
            .unwrap();
        bootstrap_owner(&db).await.unwrap();
        let app = build_router(AppState::new(db, 1));

        // unique suffix so reruns don't collide
        let uniq = new_token();
        let sku = format!("IT-{}", &uniq[..8]);

        // login (bootstrapped owner / admin123)
        let (st, v) = call(
            &app,
            "POST",
            "/auth/login",
            None,
            Some(json!({"username":"owner","password":"admin123"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "owner login should succeed: {v}");
        let token = v["token"].as_str().unwrap().to_string();
        let tok = Some(token.as_str());

        // no token -> 401
        let (st, _) = call(&app, "GET", "/items", None, None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        // set a 22K rate (gold=1, 22K=2 from reference seed)
        let (st, _) = call(
            &app,
            "POST",
            "/rates",
            tok,
            Some(json!({"metal_type_id":1,"purity_id":2,"buy_rate":"13000","sell_rate":"13240"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // create an item
        let (st, v) = call(
            &app,
            "POST",
            "/items",
            tok,
            Some(json!({
            "branch_id":1,"sku":sku,"metal_type_id":1,"purity_id":2,
            "gross_weight":"8.000","net_weight":"8.000","stone_weight":"0"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "create item: {v}");
        let item_id = v["id"].as_i64().unwrap();

        // sell -> 200
        let (st, sale) = call(
            &app,
            "POST",
            &format!("/items/{item_id}/sell"),
            tok,
            Some(json!({"making_per_gram":"600"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "first sale should succeed: {sale}");
        assert_eq!(sale["grand_total"].as_str().unwrap(), "114042");
        assert!(sale["document_no"].as_str().unwrap().starts_with("INV-"));
        let invoice_id = sale["invoice_id"].as_i64().unwrap();

        // sell again -> 409 (double-sale guard)
        let (st, _) = call(
            &app,
            "POST",
            &format!("/items/{item_id}/sell"),
            tok,
            Some(json!({"making_per_gram":"600"})),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT, "second sale must be rejected");

        // return -> 200 (credit note); item goes back to stock
        let (st, cn) = call(
            &app,
            "POST",
            &format!("/invoices/{invoice_id}/return"),
            tok,
            Some(json!({"reason":"return"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "return should succeed: {cn}");
        assert!(cn["document_no"].as_str().unwrap().starts_with("CRN-"));

        // high-value cash without PAN -> 400 (Sec 269ST / PAN)
        let big_sku = format!("BIG-{}", &uniq[..8]);
        let (_st, bi) = call(
            &app,
            "POST",
            "/items",
            tok,
            Some(json!({
            "branch_id":1,"sku":big_sku,"metal_type_id":1,"purity_id":2,
            "gross_weight":"20.000","net_weight":"20.000","stone_weight":"0"})),
        )
        .await;
        let big_id = bi["id"].as_i64().unwrap();
        let (st, _) = call(
            &app,
            "POST",
            &format!("/items/{big_id}/sell"),
            tok,
            Some(json!({"making_per_gram":"500","payment_mode":"cash"})),
        )
        .await;
        assert_eq!(
            st,
            StatusCode::BAD_REQUEST,
            "cash high-value without PAN must be blocked"
        );
    }

    /// Shared setup: connect, migrate, bootstrap, log in owner. None if TEST_DATABASE_URL unset.
    async fn app_and_token() -> Option<(Router, String)> {
        let url = env::var("TEST_DATABASE_URL").ok()?;
        let db = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!("../../db/migrations")
            .run(&db)
            .await
            .unwrap();
        bootstrap_owner(&db).await.unwrap();
        let app = build_router(AppState::new(db, 1));
        let (st, v) = call(
            &app,
            "POST",
            "/auth/login",
            None,
            Some(json!({"username":"owner","password":"admin123"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "owner login: {v}");
        let token = v["token"].as_str().unwrap().to_string();
        Some((app, token))
    }

    async fn set_22k_rate(app: &Router, tok: Option<&str>) {
        let (st, _) = call(
            app,
            "POST",
            "/rates",
            tok,
            Some(json!({"metal_type_id":1,"purity_id":2,"buy_rate":"13000","sell_rate":"13240"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
    }

    #[tokio::test]
    async fn auth_lockout_after_5_failures() {
        let Some((app, _t)) = app_and_token().await else {
            return;
        };
        for _ in 0..5 {
            let (st, _) = call(
                &app,
                "POST",
                "/auth/login",
                None,
                Some(json!({"username":"owner","password":"wrong"})),
            )
            .await;
            assert_eq!(st, StatusCode::UNAUTHORIZED);
        }
        let (st, _) = call(
            &app,
            "POST",
            "/auth/login",
            None,
            Some(json!({"username":"owner","password":"wrong"})),
        )
        .await;
        assert_eq!(
            st,
            StatusCode::TOO_MANY_REQUESTS,
            "6th attempt must be rate-limited"
        );
    }

    #[tokio::test]
    async fn purchase_then_sale() {
        let Some((app, token)) = app_and_token().await else {
            return;
        };
        let tok = Some(token.as_str());
        let uniq = new_token();
        set_22k_rate(&app, tok).await;

        let (st, sup) = call(
            &app,
            "POST",
            "/suppliers",
            tok,
            Some(json!({"name":"Test Supplier"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let sid = sup["id"].as_i64().unwrap();

        let sku = format!("PUR-{}", &uniq[..8]);
        let (st, pb) = call(
            &app,
            "POST",
            "/purchases",
            tok,
            Some(json!({"supplier_id":sid,"lines":[
                {"sku":sku,"metal_type_id":1,"purity_id":2,
                 "gross_weight":"5.000","net_weight":"5.000","cost_value":"60000"}]})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "purchase: {pb}");
        assert!(pb["document_no"].as_str().unwrap().starts_with("PUR-"));
        let item_id = pb["items_received"][0].as_i64().unwrap();

        let (st, sale) = call(
            &app,
            "POST",
            &format!("/items/{item_id}/sell"),
            tok,
            Some(json!({"making_per_gram":"500"})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "sale of purchased item: {sale}");
    }

    #[tokio::test]
    async fn scheme_value_pay_and_redeem() {
        let Some((app, token)) = app_and_token().await else {
            return;
        };
        let tok = Some(token.as_str());
        let uniq = new_token();
        set_22k_rate(&app, tok).await;

        let (st, sc) = call(
            &app,
            "POST",
            "/schemes",
            tok,
            Some(json!({"monthly_amount":"10000","installments_required":2})),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let scid = sc["scheme_id"].as_i64().unwrap();

        call(
            &app,
            "POST",
            &format!("/schemes/{scid}/pay"),
            tok,
            Some(json!({})),
        )
        .await;
        let (st, p2) = call(
            &app,
            "POST",
            &format!("/schemes/{scid}/pay"),
            tok,
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(p2["status"].as_str().unwrap(), "matured");

        // over-cap installment blocked
        let (st, _) = call(
            &app,
            "POST",
            &format!("/schemes/{scid}/pay"),
            tok,
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);

        // redeem on a sale: maturity value = 2*10000 + 1*10000 bonus = 30000
        let sku = format!("SR-{}", &uniq[..8]);
        let (_st, it) = call(
            &app,
            "POST",
            "/items",
            tok,
            Some(
                json!({"branch_id":1,"sku":sku,"metal_type_id":1,"purity_id":2,
                "gross_weight":"8.000","net_weight":"8.000"}),
            ),
        )
        .await;
        let iid = it["id"].as_i64().unwrap();
        let (st, sale) = call(
            &app,
            "POST",
            &format!("/items/{iid}/sell"),
            tok,
            Some(json!({"making_per_gram":"600","redeem_scheme_id":scid})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "sale with redemption: {sale}");
        assert_eq!(sale["scheme_credit"].as_str().unwrap(), "30000.00");
    }

    #[tokio::test]
    async fn approval_out_then_return() {
        let Some((app, token)) = app_and_token().await else {
            return;
        };
        let tok = Some(token.as_str());
        let uniq = new_token();
        set_22k_rate(&app, tok).await;

        let sku = format!("AP-{}", &uniq[..8]);
        let (_st, it) = call(
            &app,
            "POST",
            "/items",
            tok,
            Some(
                json!({"branch_id":1,"sku":sku,"metal_type_id":1,"purity_id":2,
                "gross_weight":"6.000","net_weight":"6.000"}),
            ),
        )
        .await;
        let iid = it["id"].as_i64().unwrap();

        let (st, ao) = call(
            &app,
            "POST",
            &format!("/items/{iid}/approval-out"),
            tok,
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "approval-out: {ao}");
        assert!(ao["slip_no"].as_str().unwrap().starts_with("APP-"));
        let aid = ao["approval_id"].as_i64().unwrap();

        // can't send the same item out again
        let (st, _) = call(
            &app,
            "POST",
            &format!("/items/{iid}/approval-out"),
            tok,
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT);

        // return it
        let (st, _) = call(
            &app,
            "POST",
            &format!("/approvals/{aid}/return"),
            tok,
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
    }
}

// ---- On-Approval (take-home trial) ----

#[derive(Deserialize)]
struct ApprovalOutReq {
    customer_id: Option<i64>,
    due_back_at: Option<String>, // YYYY-MM-DD
    series_code: Option<String>,
}

/// Send an item out on approval (take-home trial). NOT a sale: no invoice, no GST. The item
/// leaves stock as `on_approval_out`; a tracking slip number is allocated.
async fn approval_out(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ApprovalOutReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("approval.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;

    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT ownership_state, branch_id FROM item WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    let (state, branch_id) = match row {
        None => return Err((StatusCode::NOT_FOUND, format!("item {id} not found"))),
        Some((st, _)) if st != "in_stock" => {
            return Err((
                StatusCode::CONFLICT,
                format!("item {id} is '{st}', cannot send on approval"),
            ))
        }
        Some((st, b)) => (st, b),
    };
    let _ = state;

    let series = req.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let fy = current_fy();
    let (_no, slip_no) = allocate_doc_no(&mut tx, "approval_slip", &fy, series).await?;

    let approval_id: i64 = sqlx::query_scalar(
        "INSERT INTO approval_out (branch_id, item_id, customer_id, slip_no, due_back_at, status) \
         VALUES ($1, $2, $3, $4, $5::date, 'out') RETURNING id",
    )
    .bind(branch_id)
    .bind(id)
    .bind(req.customer_id)
    .bind(&slip_no)
    .bind(req.due_back_at.as_deref())
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    sqlx::query("UPDATE item SET ownership_state = 'on_approval_out' WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
            before_json, after_json, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'item', $2, 'approval_out', $3, $4, 'approval_slip', $5)",
    )
    .bind(branch_id)
    .bind(id)
    .bind(json!({"ownership_state": "in_stock"}))
    .bind(json!({"ownership_state": "on_approval_out", "no_gst": true}))
    .bind(approval_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "approval_id": approval_id,
        "slip_no": slip_no,
        "item_id": id,
        "status": "out",
        "note": "take-home trial — not a sale, no GST",
    })))
}

/// Return an item that was out on approval — back to stock.
async fn approval_return(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(approval_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    auth.require("approval.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;

    let row: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT item_id, branch_id, status FROM approval_out WHERE id = $1 FOR UPDATE",
    )
    .bind(approval_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (item_id, branch_id) = match row {
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                format!("approval {approval_id} not found"),
            ))
        }
        Some((_, _, st)) if st != "out" => {
            return Err((
                StatusCode::CONFLICT,
                format!("approval {approval_id} is '{st}', not open"),
            ))
        }
        Some((item_id, branch_id, _)) => (item_id, branch_id),
    };

    sqlx::query("UPDATE approval_out SET status = 'returned' WHERE id = $1")
        .bind(approval_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE item SET ownership_state = 'in_stock' WHERE id = $1")
        .bind(item_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
            before_json, after_json, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'item', $2, 'approval_returned', $3, $4, 'approval_slip', $5)",
    )
    .bind(branch_id)
    .bind(item_id)
    .bind(json!({"ownership_state": "on_approval_out"}))
    .bind(json!({"ownership_state": "in_stock"}))
    .bind(approval_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(
        json!({ "approval_id": approval_id, "item_id": item_id, "status": "returned" }),
    ))
}

#[derive(Serialize, sqlx::FromRow)]
struct ApprovalRow {
    id: i64,
    item_id: i64,
    sku: String,
    slip_no: Option<String>,
    customer_id: Option<i64>,
    due_back_at: Option<String>,
}

/// List open approvals (items currently out on trial).
async fn list_approvals(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Vec<ApprovalRow>>, ApiError> {
    let rows = sqlx::query_as::<_, ApprovalRow>(
        "SELECT a.id, a.item_id, i.sku, a.slip_no, a.customer_id, a.due_back_at::text AS due_back_at \
         FROM approval_out a JOIN item i ON i.id = a.item_id \
         WHERE a.status = 'out' ORDER BY a.id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

// ---- Sale or Return (B2B) ----

#[derive(Deserialize)]
struct SorOutReq {
    customer_id: Option<i64>,
    due_back_at: Option<String>,
    series_code: Option<String>,
}

/// Send an item out on Sale or Return to a retailer. Title stays with us; NOT a sale until
/// invoiced. Item state -> sale_or_return_out; a delivery-note number is allocated.
async fn sor_out(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<SorOutReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sor.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;

    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT ownership_state, branch_id FROM item WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    let branch_id = match row {
        None => return Err((StatusCode::NOT_FOUND, format!("item {id} not found"))),
        Some((st, _)) if st != "in_stock" => {
            return Err((
                StatusCode::CONFLICT,
                format!("item {id} is '{st}', cannot send on sale-or-return"),
            ))
        }
        Some((_, b)) => b,
    };

    let series = req.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let fy = current_fy();
    let (_no, doc_no) = allocate_doc_no(&mut tx, "sale_or_return", &fy, series).await?;

    let sor_id: i64 = sqlx::query_scalar(
        "INSERT INTO sale_or_return_out (branch_id, item_id, customer_id, doc_no, due_back_at, status) \
         VALUES ($1, $2, $3, $4, $5::date, 'out') RETURNING id",
    )
    .bind(branch_id)
    .bind(id)
    .bind(req.customer_id)
    .bind(&doc_no)
    .bind(req.due_back_at.as_deref())
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;

    sqlx::query("UPDATE item SET ownership_state = 'sale_or_return_out' WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
            before_json, after_json, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'item', $2, 'sor_out', $3, $4, 'sale_or_return', $5)",
    )
    .bind(branch_id)
    .bind(id)
    .bind(json!({"ownership_state": "in_stock"}))
    .bind(json!({"ownership_state": "sale_or_return_out", "no_gst_until_invoiced": true}))
    .bind(sor_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "sor_id": sor_id,
        "doc_no": doc_no,
        "item_id": id,
        "status": "out",
        "note": "sale-or-return — title retained, not a sale until invoiced",
    })))
}

/// Return an item that was out on sale-or-return — back to stock.
async fn sor_return(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(sor_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    auth.require("sor.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;

    let row: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT item_id, branch_id, status FROM sale_or_return_out WHERE id = $1 FOR UPDATE",
    )
    .bind(sor_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let (item_id, branch_id) = match row {
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                format!("sale-or-return {sor_id} not found"),
            ))
        }
        Some((_, _, st)) if st != "out" => {
            return Err((
                StatusCode::CONFLICT,
                format!("sale-or-return {sor_id} is '{st}', not open"),
            ))
        }
        Some((item_id, branch_id, _)) => (item_id, branch_id),
    };

    sqlx::query("UPDATE sale_or_return_out SET status = 'returned' WHERE id = $1")
        .bind(sor_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE item SET ownership_state = 'in_stock' WHERE id = $1")
        .bind(item_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
            before_json, after_json, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'item', $2, 'sor_returned', $3, $4, 'sale_or_return', $5)",
    )
    .bind(branch_id)
    .bind(item_id)
    .bind(json!({"ownership_state": "sale_or_return_out"}))
    .bind(json!({"ownership_state": "in_stock"}))
    .bind(sor_id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(
        json!({ "sor_id": sor_id, "item_id": item_id, "status": "returned" }),
    ))
}

#[derive(Serialize, sqlx::FromRow)]
struct SorRow {
    id: i64,
    item_id: i64,
    sku: String,
    doc_no: Option<String>,
    customer_id: Option<i64>,
    due_back_at: Option<String>,
}

/// List open sale-or-return consignments (goods out, not yet invoiced or returned).
async fn list_sor(
    State(s): State<AppState>,
    _auth: AuthUser,
) -> Result<Json<Vec<SorRow>>, ApiError> {
    let rows = sqlx::query_as::<_, SorRow>(
        "SELECT a.id, a.item_id, i.sku, a.doc_no, a.customer_id, a.due_back_at::text AS due_back_at \
         FROM sale_or_return_out a JOIN item i ON i.id = a.item_id \
         WHERE a.status = 'out' ORDER BY a.id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

// ---- Gold savings schemes (11+1) ----

#[derive(Deserialize)]
struct NewScheme {
    customer_id: Option<i64>,
    monthly_amount: Decimal,
    installments_required: Option<i32>, // <= 11
    bonus_installments: Option<i32>,
    series_code: Option<String>,
    /// "value" (11+1 cash) or "gram" (rate-averaging accumulation).
    scheme_type: Option<String>,
    metal_type_id: Option<i64>, // required for gram schemes
    purity_id: Option<i64>,     // required for gram schemes
}

async fn create_scheme(
    State(s): State<AppState>,
    auth: AuthUser,
    Json(n): Json<NewScheme>,
) -> Result<Json<Value>, ApiError> {
    auth.require("scheme.manage")?;
    if n.monthly_amount <= Decimal::ZERO {
        return Err((
            StatusCode::BAD_REQUEST,
            "monthly_amount must be positive".to_string(),
        ));
    }
    let required = n.installments_required.unwrap_or(11);
    if !(1..=11).contains(&required) {
        return Err((
            StatusCode::BAD_REQUEST,
            "installments_required must be 1..=11 (regulatory cap for gold schemes)".to_string(),
        ));
    }
    let scheme_type = n.scheme_type.as_deref().unwrap_or("value");
    if !matches!(scheme_type, "value" | "gram") {
        return Err((
            StatusCode::BAD_REQUEST,
            "scheme_type must be 'value' or 'gram'".to_string(),
        ));
    }
    if scheme_type == "gram" && (n.metal_type_id.is_none() || n.purity_id.is_none()) {
        return Err((
            StatusCode::BAD_REQUEST,
            "gram schemes require metal_type_id and purity_id".to_string(),
        ));
    }
    // Default bonus: 1 for value (the 11+1), 0 for gram (benefit is rate averaging).
    let bonus = n
        .bonus_installments
        .unwrap_or(if scheme_type == "gram" { 0 } else { 1 });
    let mut tx = s.db.begin().await.map_err(internal)?;
    let series = n.series_code.as_deref().unwrap_or(SERIES_DEFAULT);
    let fy = current_fy();
    let (_no, scheme_no) = allocate_doc_no(&mut tx, "scheme", &fy, series).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO scheme (branch_id, customer_id, scheme_no, monthly_amount, \
            installments_required, bonus_installments, scheme_type, metal_type_id, purity_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(s.default_branch)
    .bind(n.customer_id)
    .bind(&scheme_no)
    .bind(n.monthly_amount)
    .bind(required)
    .bind(bonus)
    .bind(scheme_type)
    .bind(n.metal_type_id)
    .bind(n.purity_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "scheme_id": id, "scheme_no": scheme_no, "scheme_type": scheme_type,
        "monthly_amount": n.monthly_amount.to_string(),
        "installments_required": required, "bonus_installments": bonus, "status": "active",
    })))
}

/// Scheme detail: head + installment history (for receipts / passbook).
async fn get_scheme(
    State(s): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let head: Option<(Option<String>, Option<i64>, Option<String>, String, Decimal, i32, i32, Decimal, Decimal, String, Option<Decimal>, Option<Decimal>, String, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT s.scheme_no, s.customer_id, c.name, s.scheme_type, s.monthly_amount, \
                s.installments_required, s.bonus_installments, s.total_paid, s.total_grams, s.status, \
                s.maturity_value, s.average_rate, s.start_date::text, mt.name, p.label \
             FROM scheme s LEFT JOIN customer c ON c.id = s.customer_id \
             LEFT JOIN metal_type mt ON mt.id = s.metal_type_id \
             LEFT JOIN purity p ON p.id = s.purity_id WHERE s.id = $1",
        )
        .bind(id)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    let h = head.ok_or((StatusCode::NOT_FOUND, format!("scheme {id} not found")))?;

    let insts = sqlx::query_as::<_, (i32, Decimal, Option<String>, String, Option<Decimal>, Option<Decimal>, Option<String>)>(
        "SELECT seq, amount, payment_mode, paid_at::text, rate_used, grams, reference \
         FROM scheme_installment WHERE scheme_id = $1 ORDER BY seq",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    Ok(Json(json!({
        "id": id,
        "scheme_no": h.0, "customer_id": h.1, "customer_name": h.2, "scheme_type": h.3,
        "monthly_amount": h.4.to_string(), "installments_required": h.5, "bonus_installments": h.6,
        "total_paid": h.7.to_string(), "total_grams": h.8.to_string(), "status": h.9,
        "maturity_value": h.10.map(|v| v.to_string()), "average_rate": h.11.map(|v| v.to_string()),
        "start_date": h.12, "metal": h.13, "purity": h.14,
        "installments": insts.iter().map(|(seq, amt, mode, at, rate, grams, reference)| json!({
            "seq": seq, "amount": amt.to_string(), "payment_mode": mode, "paid_at": at,
            "rate_used": rate.map(|v| v.to_string()), "grams": grams.map(|v| v.to_string()),
            "reference": reference,
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct SchemePayReq {
    amount: Option<Decimal>,
    payment_mode: Option<String>,
    reference: Option<String>,
}

#[derive(sqlx::FromRow)]
struct SchemeState {
    status: String,
    monthly_amount: Decimal,
    installments_required: i32,
    bonus_installments: i32,
    total_paid: Decimal,
    branch_id: i64,
    paid_count: i64,
    expired: bool,
    scheme_type: String,
    metal_type_id: Option<i64>,
    purity_id: Option<i64>,
    total_grams: Decimal,
}

/// Record a monthly installment. Enforces: scheme active, ≤ 11 installments, and within the
/// 11-month collection window. The 11th installment auto-matures the scheme.
async fn scheme_pay(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<SchemePayReq>,
) -> Result<Json<Value>, ApiError> {
    auth.require("scheme.manage")?;
    assert_not_locked(&s.db, &today_ist()).await?;
    let mut tx = s.db.begin().await.map_err(internal)?;

    let sc: Option<SchemeState> = sqlx::query_as(
        "SELECT status, monthly_amount, installments_required, bonus_installments, total_paid, \
                branch_id, scheme_type, metal_type_id, purity_id, total_grams, \
                (SELECT count(*) FROM scheme_installment WHERE scheme_id = scheme.id) AS paid_count, \
                (CURRENT_DATE > start_date + INTERVAL '11 months') AS expired \
         FROM scheme WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let sc = sc.ok_or((StatusCode::NOT_FOUND, format!("scheme {id} not found")))?;

    if sc.status != "active" {
        return Err((
            StatusCode::CONFLICT,
            format!("scheme {id} is '{}' — collection not allowed", sc.status),
        ));
    }
    if sc.paid_count >= sc.installments_required as i64 {
        return Err((
            StatusCode::CONFLICT,
            "all installments already collected — scheme is matured".to_string(),
        ));
    }
    if sc.expired {
        return Err((
            StatusCode::CONFLICT,
            "collection window (11 months) has closed for this scheme".to_string(),
        ));
    }

    let amount = req.amount.unwrap_or(sc.monthly_amount);
    let seq = (sc.paid_count + 1) as i32;
    let mode = req.payment_mode.as_deref().unwrap_or("cash");

    // Gram schemes: convert this installment to gold weight at today's rate (rate averaging).
    let (rate_used, grams) = if sc.scheme_type == "gram" {
        let rate: Decimal = sqlx::query_scalar(
            "SELECT sell_rate FROM metal_rate WHERE metal_type_id = $1 AND purity_id = $2 \
             ORDER BY effective_from DESC LIMIT 1",
        )
        .bind(sc.metal_type_id)
        .bind(sc.purity_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::BAD_REQUEST,
            "no rate set for this scheme's metal/purity".to_string(),
        ))?;
        (Some(rate), Some(core_engine::round_weight(amount / rate)))
    } else {
        (None, None)
    };

    sqlx::query(
        "INSERT INTO scheme_installment (scheme_id, seq, amount, payment_mode, rate_used, grams, reference) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(seq)
    .bind(amount)
    .bind(mode)
    .bind(rate_used)
    .bind(grams)
    .bind(req.reference.as_deref())
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    let new_total = sc.total_paid + amount;
    let new_grams = sc.total_grams + grams.unwrap_or(Decimal::ZERO);
    let matured = seq >= sc.installments_required;
    // Value scheme: maturity_value = total + bonus. Gram scheme: average rate = total/grams.
    let maturity_value = if matured && sc.scheme_type == "value" {
        Some(new_total + sc.monthly_amount * Decimal::from(sc.bonus_installments))
    } else {
        None
    };
    let average_rate = if matured && sc.scheme_type == "gram" && new_grams > Decimal::ZERO {
        Some(core_engine::round_money(new_total / new_grams))
    } else {
        None
    };

    if matured {
        sqlx::query(
            "UPDATE scheme SET total_paid = $1, total_grams = $2, status = 'matured', \
                matured_at = now(), maturity_value = $3, average_rate = $4 WHERE id = $5",
        )
        .bind(new_total)
        .bind(new_grams)
        .bind(maturity_value)
        .bind(average_rate)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    } else {
        sqlx::query("UPDATE scheme SET total_paid = $1, total_grams = $2 WHERE id = $3")
            .bind(new_total)
            .bind(new_grams)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }

    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
            after_json, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'scheme', $2, 'scheme_installment', $3, $4, 'scheme', $2)",
    )
    .bind(sc.branch_id)
    .bind(id)
    .bind(json!({"seq": seq, "mode": mode}))
    .bind(amount)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;

    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({
        "scheme_id": id, "installment": seq, "amount": amount.to_string(),
        "total_paid": new_total.to_string(),
        "scheme_type": sc.scheme_type,
        "rate_used": rate_used.map(|v| v.to_string()),
        "grams_this_installment": grams.map(|v| v.to_string()),
        "total_grams": new_grams.to_string(),
        "status": if matured { "matured" } else { "active" },
        "maturity_value": maturity_value.map(|v| v.to_string()),
        "average_rate": average_rate.map(|v| v.to_string()),
    })))
}

#[derive(sqlx::FromRow)]
struct SchemeCloseRow {
    status: String,
    branch_id: i64,
    maturity_value: Option<Decimal>,
    scheme_type: String,
    total_grams: Decimal,
    total_paid: Decimal,
    average_rate: Option<Decimal>,
}

/// Close (redeem) a scheme. A **matured** scheme redeems at maturity value (with bonus);
/// an **active** scheme can be closed **early** (pre-mature) — redeeming only what was paid
/// so far, with no bonus. Already closed/cancelled schemes cannot be closed again.
async fn scheme_close(
    State(s): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    auth.require("scheme.manage")?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let row: Option<SchemeCloseRow> = sqlx::query_as(
        "SELECT status, branch_id, maturity_value, scheme_type, total_grams, total_paid, average_rate \
         FROM scheme WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let SchemeCloseRow {
        status,
        branch_id,
        maturity_value,
        scheme_type,
        total_grams,
        total_paid,
        average_rate,
    } = row.ok_or((StatusCode::NOT_FOUND, format!("scheme {id} not found")))?;
    if status != "matured" && status != "active" {
        return Err((
            StatusCode::CONFLICT,
            format!("scheme {id} is '{status}' — cannot close"),
        ));
    }
    let premature = status == "active";
    // Value scheme: matured = total + bonus; early = only what was paid (no bonus).
    let value = if premature {
        total_paid
    } else {
        maturity_value.unwrap_or(total_paid)
    };
    // Gram scheme: average rate over the accumulated grams.
    let avg = average_rate.or_else(|| {
        if total_grams > Decimal::ZERO {
            Some(round_money(total_paid / total_grams))
        } else {
            None
        }
    });
    sqlx::query("UPDATE scheme SET status = 'closed', closed_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO ledger_event (branch_id, subject_type, subject_id, event_type, \
            after_json, amount_delta, ref_doc_type, ref_doc_id) \
         VALUES ($1, 'scheme', $2, 'scheme_closed', $3, $4, 'scheme', $2)",
    )
    .bind(branch_id)
    .bind(id)
    .bind(json!({"redeemed": true, "scheme_type": scheme_type, "early_closure": premature}))
    .bind(if scheme_type == "value" { value } else { total_paid })
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    if scheme_type == "gram" {
        Ok(Json(json!({
            "scheme_id": id, "status": "closed", "scheme_type": "gram", "early_closure": premature,
            "redeemable_grams": total_grams.to_string(),
            "average_rate": avg.map(|v| v.to_string()),
            "note": if premature { "early closure — redeem the grams accumulated so far (no bonus)" } else { "customer redeems the accumulated grams; gold billed at the average rate, making extra" },
        })))
    } else {
        Ok(Json(json!({
            "scheme_id": id, "status": "closed", "scheme_type": "value", "early_closure": premature,
            "redeemable_value": value.to_string(),
            "note": if premature { "early closure — refund/redeem the amount paid so far (bonus not applicable)" } else { "apply this value toward a jewellery purchase at the current rate" },
        })))
    }
}

#[derive(Serialize, sqlx::FromRow)]
struct SchemeRow {
    id: i64,
    scheme_no: Option<String>,
    customer_id: Option<i64>,
    monthly_amount: Decimal,
    installments_required: i32,
    status: String,
    total_paid: Decimal,
    maturity_value: Option<Decimal>,
}

/// List schemes. Optional `?status=matured` to find matured-but-unclosed schemes to chase.
async fn list_schemes(
    State(s): State<AppState>,
    auth: AuthUser,
    Query(q): Query<StatusFilter>,
) -> Result<Json<Vec<SchemeRow>>, ApiError> {
    auth.require("scheme.manage")?;
    let rows = sqlx::query_as::<_, SchemeRow>(
        "SELECT id, scheme_no, customer_id, monthly_amount, installments_required, status, \
                total_paid, maturity_value \
         FROM scheme WHERE ($1::text IS NULL OR status = $1) ORDER BY id",
    )
    .bind(q.status.as_deref())
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct StatusFilter {
    status: Option<String>,
}
