//! # core-engine
//!
//! Cygnus Jewel Suite's shared, fixed-point valuation engine. Compiled into both the
//! desktop app and the backend so pricing/weight/tax math is identical everywhere.
//!
//! Two rules hold everywhere:
//! 1. Fixed-point decimal math (`rust_decimal`) — never floating point.
//! 2. Deterministic rounding policy (see [`money`]).
//!
//! See `docs/02-architecture/valuation-engine-spec.md`.

pub mod money;
pub mod rules;
pub mod units;
pub mod valuation;

pub use money::{round_money, round_to_rupee, round_weight};
pub use rules::{Charge, StonePrice};
pub use units::{
    carat_to_grams, grams_to_carat, karat_to_fineness, net_fine_weight, ratti_to_grams,
};
pub use valuation::{
    old_gold_amount_payable, solve_for_target, value_line, LineInput, PriceBreakdown, Supply,
};
