//! Rounding & precision policy (decision D7).
//!
//! All money/weight math is fixed-point (`rust_decimal`) — never floating point.
//! Rounding mode is **half-up** (MidpointAwayFromZero), applied at fixed points.

use rust_decimal::{Decimal, RoundingStrategy};

/// Money is rounded to 2 decimal places.
pub const MONEY_DP: u32 = 2;
/// Weights (grams) and stone weights (carat/ratti) use 3 decimal places.
pub const WEIGHT_DP: u32 = 3;

const HALF_UP: RoundingStrategy = RoundingStrategy::MidpointAwayFromZero;

/// Round a money amount to 2 dp, half-up.
pub fn round_money(v: Decimal) -> Decimal {
    v.round_dp_with_strategy(MONEY_DP, HALF_UP)
}

/// Round a weight (gram/carat/ratti) to 3 dp, half-up.
pub fn round_weight(v: Decimal) -> Decimal {
    v.round_dp_with_strategy(WEIGHT_DP, HALF_UP)
}

/// Round a final payable to the nearest rupee (0 dp), half-up.
pub fn round_to_rupee(v: Decimal) -> Decimal {
    v.round_dp_with_strategy(0, HALF_UP)
}
