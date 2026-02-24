/**
 * LMSR cost function: C(q) = b * ln(∑ e^(q_i/b)).
 * Trade cost for buying x of outcome k: cost = C(q') - C(q), q'_k = q_k + x.
 * Uses decimal.js for numerical precision.
 */

import Decimal from "decimal.js";

/**
 * Cost function C(q) = b * ln(∑_i e^(q_i/b)).
 * q: array of outstanding shares per outcome (same unit as b).
 * b: liquidity parameter (positive).
 */
export function costFunction(q: Decimal[], b: Decimal): Decimal {
  if (b.lte(0)) {
    throw new Error("LMSR bParameter must be positive");
  }
  let sum = new Decimal(0);
  for (let i = 0; i < q.length; i++) {
    sum = sum.plus(Decimal.exp(q[i].div(b)));
  }
  if (sum.lte(0)) {
    throw new Error("LMSR sum of exponentials must be positive");
  }
  return b.times(Decimal.ln(sum));
}

/**
 * Cost to buy `quantity` shares of outcome `outcomeIndex` given current supplies `q`.
 * cost = C(q') - C(q) where q'[outcomeIndex] = q[outcomeIndex] + quantity.
 */
export function costToBuy(
  q: Decimal[],
  outcomeIndex: number,
  quantity: Decimal,
  b: Decimal
): Decimal {
  if (outcomeIndex < 0 || outcomeIndex >= q.length) {
    throw new Error("LMSR outcomeIndex out of range");
  }
  const qPrime = q.map((qi, i) => (i === outcomeIndex ? qi.plus(quantity) : qi));
  const cBefore = costFunction(q, b);
  const cAfter = costFunction(qPrime, b);
  return cAfter.minus(cBefore);
}

/**
 * Convert cost in outcome-token units (e.g. 18 decimals) to USDC units (e.g. 6 decimals).
 * costUsdc = round(costOutcomeWei * 10^usdcDecimals / 10^outcomeTokenDecimals).
 */
export function costToUsdcUnits(
  costOutcomeWei: Decimal,
  outcomeTokenDecimals: number,
  usdcDecimals: number
): bigint {
  const divisor = new Decimal(10).pow(outcomeTokenDecimals);
  const multiplier = new Decimal(10).pow(usdcDecimals);
  const usdc = costOutcomeWei.times(multiplier).div(divisor);
  return BigInt(usdc.round(0, Decimal.ROUND_CEIL).toString());
}
