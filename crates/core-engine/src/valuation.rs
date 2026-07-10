//! Valuation: the single source of truth for a priced bill line.
//!
//! India default rate basis: `metal_value = per_gram_rate(metal, purity) * net_weight`
//! (the rate already encodes purity). Discount is applied BEFORE GST.

use rust_decimal::Decimal;

use crate::money::{round_money, round_to_rupee};
use crate::rules::{Charge, StonePrice};

/// Place of supply determines CGST+SGST (intra-state) vs IGST (inter-state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Supply {
    Intra,
    Inter,
}

/// Inputs to value a single bill line.
#[derive(Clone, Debug)]
pub struct LineInput {
    /// Purity-specific per-gram rate (India default basis).
    pub metal_rate_per_gram: Decimal,
    /// Net metal weight in grams.
    pub net_weight: Decimal,
    pub making: Option<Charge>,
    pub wastage: Option<Charge>,
    pub stones: Vec<StonePrice>,
    /// Discount (applied to taxable value, before GST).
    pub discount: Decimal,
    /// GST rate as a fraction, e.g. `dec!(0.03)` for 3%.
    pub gst_rate: Decimal,
    pub supply: Supply,
}

/// The fully computed, frozen price breakdown for a line/bill.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct PriceBreakdown {
    pub metal_value: Decimal,
    pub making: Decimal,
    pub wastage: Decimal,
    pub stone_value: Decimal,
    pub discount: Decimal,
    pub taxable_value: Decimal,
    pub cgst: Decimal,
    pub sgst: Decimal,
    pub igst: Decimal,
    pub tax_total: Decimal,
    pub round_off: Decimal,
    pub grand_total: Decimal,
}

/// Split GST off a taxable value. The total is computed from the full rate first,
/// then halved for CGST/SGST so the parts always sum to the total exactly.
fn split_tax(
    taxable: Decimal,
    gst_rate: Decimal,
    supply: Supply,
) -> (Decimal, Decimal, Decimal, Decimal) {
    let tax_total = round_money(taxable * gst_rate);
    match supply {
        Supply::Intra => {
            let two = Decimal::from(2);
            let cgst = round_money(tax_total / two);
            let sgst = tax_total - cgst; // absorbs any 0.01 rounding remainder
            (cgst, sgst, Decimal::ZERO, tax_total)
        }
        Supply::Inter => (Decimal::ZERO, Decimal::ZERO, tax_total, tax_total),
    }
}

/// Assemble a breakdown from already-computed components (normal billing path).
#[allow(clippy::too_many_arguments)]
fn assemble(
    metal_value: Decimal,
    making: Decimal,
    wastage: Decimal,
    stone_value: Decimal,
    discount: Decimal,
    gst_rate: Decimal,
    supply: Supply,
) -> PriceBreakdown {
    let taxable_value = metal_value + making + wastage + stone_value - discount;
    let (cgst, sgst, igst, tax_total) = split_tax(taxable_value, gst_rate, supply);
    let pre = taxable_value + tax_total;
    let grand_total = round_to_rupee(pre);
    let round_off = grand_total - pre;
    PriceBreakdown {
        metal_value,
        making,
        wastage,
        stone_value,
        discount,
        taxable_value,
        cgst,
        sgst,
        igst,
        tax_total,
        round_off,
        grand_total,
    }
}

/// Value a bill line (India default per-gram-per-karat basis).
pub fn value_line(input: &LineInput) -> PriceBreakdown {
    let metal_value = round_money(input.metal_rate_per_gram * input.net_weight);
    let making = input
        .making
        .as_ref()
        .map(|c| c.evaluate(input.net_weight, metal_value))
        .unwrap_or(Decimal::ZERO);
    let wastage = input
        .wastage
        .as_ref()
        .map(|c| c.evaluate(input.net_weight, metal_value))
        .unwrap_or(Decimal::ZERO);
    let stone_value = round_money(input.stones.iter().map(StonePrice::value).sum());
    let discount = round_money(input.discount);
    assemble(
        metal_value,
        making,
        wastage,
        stone_value,
        discount,
        input.gst_rate,
        input.supply,
    )
}

/// Target-total adjustment (reverse round-off, decision D7).
///
/// Holds metal/stone/wastage fixed and back-solves the making charge so the grand total
/// equals `target` exactly. Returns `Err` if the target is below the fixed floor
/// (making would be negative).
pub fn solve_for_target(
    metal_value: Decimal,
    wastage: Decimal,
    stone_value: Decimal,
    target: Decimal,
    gst_rate: Decimal,
    supply: Supply,
) -> Result<PriceBreakdown, String> {
    let fixed = metal_value + wastage + stone_value;
    let target_taxable = round_money(target / (Decimal::ONE + gst_rate));
    let making = target_taxable - fixed;
    if making.is_sign_negative() {
        return Err(format!(
            "target {target} is below the minimum achievable (fixed components = {fixed})"
        ));
    }
    let making = round_money(making);
    let taxable_value = metal_value + making + wastage + stone_value;
    let (cgst, sgst, igst, tax_total) = split_tax(taxable_value, gst_rate, supply);
    let pre = taxable_value + tax_total;
    // Force the printed grand total to the exact target; residual lands in round_off.
    let grand_total = target;
    let round_off = grand_total - pre;
    Ok(PriceBreakdown {
        metal_value,
        making,
        wastage,
        stone_value,
        discount: Decimal::ZERO,
        taxable_value,
        cgst,
        sgst,
        igst,
        tax_total,
        round_off,
        grand_total,
    })
}

/// Old-gold settlement: net fine weight, exchange value, and amount payable.
/// GST is charged on the FULL new value (passed in as `new_grand_total`); the old gold
/// only reduces the amount payable (decision D8). No GST/RCM on the old gold itself.
pub fn old_gold_amount_payable(new_grand_total: Decimal, exchange_value: Decimal) -> Decimal {
    new_grand_total - exchange_value
}
