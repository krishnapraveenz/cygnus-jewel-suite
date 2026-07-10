//! Exact unit conversions. Base metal unit = gram; stone unit = carat.

use rust_decimal::Decimal;
use rust_decimal_macros::dec;

use crate::money::round_weight;

/// 1 carat = 0.2 g.
pub fn carat_to_grams(carat: Decimal) -> Decimal {
    round_weight(carat * dec!(0.2))
}

/// Inverse of [`carat_to_grams`].
pub fn grams_to_carat(grams: Decimal) -> Decimal {
    round_weight(grams / dec!(0.2))
}

/// 1 ratti ≈ 0.182 g (configurable; traditional Indian gemstone unit).
pub fn ratti_to_grams(ratti: Decimal) -> Decimal {
    round_weight(ratti * dec!(0.182))
}

/// Karat -> fineness (parts per 1000). e.g. 22 -> 916.667 (store as needed).
pub fn karat_to_fineness(karat: Decimal) -> Decimal {
    karat / dec!(24) * dec!(1000)
}

/// Net fine (pure) metal weight from gross/net weight and fineness (per 1000).
/// Used for the pure-metal rate basis and for old-gold valuation.
pub fn net_fine_weight(weight: Decimal, fineness: Decimal) -> Decimal {
    round_weight(weight * fineness / dec!(1000))
}
