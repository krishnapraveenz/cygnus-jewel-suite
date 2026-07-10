//! Golden tests — the worked examples A–F from
//! `docs/02-architecture/valuation-engine-spec.md`.
//!
//! Each is an `inputs -> exact breakdown` assertion. These must reproduce on every machine.

use core_engine::units::net_fine_weight;
use core_engine::valuation::{
    old_gold_amount_payable, solve_for_target, value_line, LineInput, Supply,
};
use core_engine::{Charge, StonePrice};
use rust_decimal_macros::dec;

/// A. Gold ring, 22K, net 8.000 g @ ₹13,240/g, making ₹600/g, no stone, GST 3% intra.
#[test]
fn example_a_gold_ring_per_gram_making() {
    let b = value_line(&LineInput {
        metal_rate_per_gram: dec!(13240),
        net_weight: dec!(8.000),
        making: Some(Charge::PerGram(dec!(600))),
        wastage: None,
        stones: vec![],
        discount: dec!(0),
        gst_rate: dec!(0.03),
        supply: Supply::Intra,
    });
    assert_eq!(b.metal_value, dec!(105920.00));
    assert_eq!(b.making, dec!(4800.00));
    assert_eq!(b.taxable_value, dec!(110720.00));
    assert_eq!(b.tax_total, dec!(3321.60));
    assert_eq!(b.cgst, dec!(1660.80));
    assert_eq!(b.sgst, dec!(1660.80));
    assert_eq!(b.grand_total, dec!(114042));
    assert_eq!(b.round_off, dec!(0.40));
}

/// B. 18K diamond pendant, net gold 3.500 g @ ₹10,750/g, making 12%,
/// 1 diamond 0.30 ct @ ₹90,000/ct, GST 3%.
#[test]
fn example_b_diamond_pendant_percent_making() {
    let b = value_line(&LineInput {
        metal_rate_per_gram: dec!(10750),
        net_weight: dec!(3.500),
        making: Some(Charge::Percent(dec!(12))),
        wastage: None,
        stones: vec![StonePrice::PerCarat {
            rate: dec!(90000),
            carats: dec!(0.30),
        }],
        discount: dec!(0),
        gst_rate: dec!(0.03),
        supply: Supply::Intra,
    });
    assert_eq!(b.metal_value, dec!(37625.00));
    assert_eq!(b.making, dec!(4515.00));
    assert_eq!(b.stone_value, dec!(27000.00));
    assert_eq!(b.taxable_value, dec!(69140.00));
    assert_eq!(b.tax_total, dec!(2074.20));
    assert_eq!(b.grand_total, dec!(71214));
    assert_eq!(b.round_off, dec!(-0.20));
}

/// C. Silver article, 925, net 60.000 g @ ₹222/g, making ₹15/g, GST 3%.
#[test]
fn example_c_silver_article() {
    let b = value_line(&LineInput {
        metal_rate_per_gram: dec!(222),
        net_weight: dec!(60.000),
        making: Some(Charge::PerGram(dec!(15))),
        wastage: None,
        stones: vec![],
        discount: dec!(0),
        gst_rate: dec!(0.03),
        supply: Supply::Intra,
    });
    assert_eq!(b.metal_value, dec!(13320.00));
    assert_eq!(b.making, dec!(900.00));
    assert_eq!(b.taxable_value, dec!(14220.00));
    assert_eq!(b.tax_total, dec!(426.60));
    assert_eq!(b.grand_total, dec!(14647));
    assert_eq!(b.round_off, dec!(0.40));
}

/// E. Gold bangle, 22K, gross 16 g incl. 2 g stone @ ₹450/g, net 14 g @ ₹13,085/g,
/// making 10%, making-discount ₹1,000, GST 3%.
#[test]
fn example_e_bangle_with_discount_before_gst() {
    let net_weight = dec!(16.000) - dec!(2.000); // gross - stone weight
    let b = value_line(&LineInput {
        metal_rate_per_gram: dec!(13085),
        net_weight,
        making: Some(Charge::Percent(dec!(10))),
        wastage: None,
        stones: vec![StonePrice::PerGram {
            rate: dec!(450),
            grams: dec!(2.000),
        }],
        discount: dec!(1000),
        gst_rate: dec!(0.03),
        supply: Supply::Intra,
    });
    assert_eq!(b.metal_value, dec!(183190.00));
    assert_eq!(b.making, dec!(18319.00));
    assert_eq!(b.stone_value, dec!(900.00));
    assert_eq!(b.discount, dec!(1000.00));
    assert_eq!(b.taxable_value, dec!(201409.00));
    assert_eq!(b.tax_total, dec!(6042.27));
    assert_eq!(b.cgst, dec!(3021.14));
    assert_eq!(b.sgst, dec!(3021.13));
    assert_eq!(b.grand_total, dec!(207451));
    assert_eq!(b.round_off, dec!(-0.27));
}

/// F. Target-total on example E — agree exactly ₹2,05,000.
#[test]
fn example_f_target_total() {
    let metal_value = dec!(183190.00);
    let stone_value = dec!(900.00);
    let b = solve_for_target(
        metal_value,
        dec!(0),
        stone_value,
        dec!(205000),
        dec!(0.03),
        Supply::Intra,
    )
    .expect("target must be achievable");
    assert_eq!(b.making, dec!(14939.13));
    assert_eq!(b.taxable_value, dec!(199029.13));
    assert_eq!(b.tax_total, dec!(5970.87));
    assert_eq!(b.grand_total, dec!(205000));
    assert_eq!(b.round_off, dec!(0.00));
}

/// F-guard. A target below the fixed floor must be rejected.
#[test]
fn target_below_floor_is_rejected() {
    let r = solve_for_target(
        dec!(183190),
        dec!(0),
        dec!(900),
        dec!(150000),
        dec!(0.03),
        Supply::Intra,
    );
    assert!(r.is_err());
}

/// G. Sale + old gold exchange: GST on full new value; old gold is value/cash (no GST).
/// 18K? No — 22K net 11.500 g @ ₹13,240, making 10%; old gold 10 g @916 buy ₹13,000.
#[test]
fn example_g_sale_with_old_gold() {
    let b = value_line(&LineInput {
        metal_rate_per_gram: dec!(13240),
        net_weight: dec!(11.500),
        making: Some(Charge::Percent(dec!(10))),
        wastage: None,
        stones: vec![],
        discount: dec!(0),
        gst_rate: dec!(0.03),
        supply: Supply::Intra,
    });
    assert_eq!(b.metal_value, dec!(152260.00));
    assert_eq!(b.taxable_value, dec!(167486.00));
    assert_eq!(b.tax_total, dec!(5024.58));
    assert_eq!(b.grand_total, dec!(172511));

    let net_fine = net_fine_weight(dec!(10.000), dec!(916));
    let exchange = core_engine::round_money(dec!(13000) * net_fine);
    assert_eq!(exchange, dec!(119080.00));
    // Old gold reduces amount payable only — no GST applied to it.
    assert_eq!(
        old_gold_amount_payable(b.grand_total, exchange),
        dec!(53431.00)
    );
}

/// D. Old gold exchange against bill A: full-value GST on the new item; old gold only
/// reduces the amount payable (no GST/RCM on old gold).
#[test]
fn example_d_old_gold_settlement() {
    // New item = bill A grand total.
    let new_grand_total = dec!(114042);
    // Old gold: gross 10 g, 22K (fineness 916) -> 9.160 g fine; buy rate ₹13,000/g.
    let net_fine = net_fine_weight(dec!(10.000), dec!(916));
    assert_eq!(net_fine, dec!(9.160));
    let exchange_value = core_engine::round_money(dec!(13000) * net_fine);
    assert_eq!(exchange_value, dec!(119080.00));
    let payable = old_gold_amount_payable(new_grand_total, exchange_value);
    assert_eq!(payable, dec!(-5038.00)); // negative => paid out to customer
}
