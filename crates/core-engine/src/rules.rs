//! Making/wastage charge rules and multi-unit stone pricing.

use rust_decimal::Decimal;
use rust_decimal_macros::dec;

use crate::money::round_money;

/// A making or wastage charge.
#[derive(Clone, Debug, PartialEq)]
pub enum Charge {
    /// Rate per gram of net metal weight.
    PerGram(Decimal),
    /// Percent of metal value (e.g. `dec!(12)` = 12%).
    Percent(Decimal),
    /// Flat amount (also used for piece-rate).
    Flat(Decimal),
}

impl Charge {
    /// Evaluate the charge (rounded to money precision).
    pub fn evaluate(&self, net_weight: Decimal, metal_value: Decimal) -> Decimal {
        let raw = match self {
            Charge::PerGram(rate) => *rate * net_weight,
            Charge::Percent(pct) => metal_value * *pct / dec!(100),
            Charge::Flat(amount) => *amount,
        };
        round_money(raw)
    }
}

/// A stone priced in its own unit (carat / gram / piece / ratti).
#[derive(Clone, Debug, PartialEq)]
pub enum StonePrice {
    PerCarat { rate: Decimal, carats: Decimal },
    PerGram { rate: Decimal, grams: Decimal },
    PerPiece { rate: Decimal, pieces: Decimal },
    PerRatti { rate: Decimal, ratti: Decimal },
}

impl StonePrice {
    /// Value of the stone(s) (rounded to money precision).
    pub fn value(&self) -> Decimal {
        let raw = match self {
            StonePrice::PerCarat { rate, carats } => *rate * *carats,
            StonePrice::PerGram { rate, grams } => *rate * *grams,
            StonePrice::PerPiece { rate, pieces } => *rate * *pieces,
            StonePrice::PerRatti { rate, ratti } => *rate * *ratti,
        };
        round_money(raw)
    }
}
