const TBANK_CARD_FEE_PERCENT = 3;
const TBANK_CARD_FEE_MIN_RUB = 3.49;
const TBANK_PAYOUT_FEE_PERCENT = 1;
const TBANK_PAYOUT_FEE_MIN_RUB = 50;

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const floor2 = (value) => Math.floor(Number(value) * 100) / 100;

const normalizeRules = (rules = {}) => ({
  cardFeePercent: Math.max(0, Number(rules.cardFeePercent ?? TBANK_CARD_FEE_PERCENT) || TBANK_CARD_FEE_PERCENT),
  cardFeeMinRub: Math.max(0, Number(rules.cardFeeMinRub ?? TBANK_CARD_FEE_MIN_RUB) || TBANK_CARD_FEE_MIN_RUB),
  payoutFeePercent: Math.max(0, Number(rules.payoutFeePercent ?? TBANK_PAYOUT_FEE_PERCENT) || TBANK_PAYOUT_FEE_PERCENT),
  payoutFeeMinRub: Math.max(0, Number(rules.payoutFeeMinRub ?? TBANK_PAYOUT_FEE_MIN_RUB) || TBANK_PAYOUT_FEE_MIN_RUB),
});

export function calculateTbankCardFee(amountRub, rules = {}) {
  const cfg = normalizeRules(rules);
  const amount = Math.max(0, Number(amountRub) || 0);
  return round2(Math.max(amount * (cfg.cardFeePercent / 100), cfg.cardFeeMinRub));
}

export function calculateTbankPayoutFee(payoutAmountRub, rules = {}) {
  const cfg = normalizeRules(rules);
  const payout = Math.max(0, Number(payoutAmountRub) || 0);
  return round2(Math.max(payout * (cfg.payoutFeePercent / 100), cfg.payoutFeeMinRub));
}

export function calculateTbankTotalFeeForEqualPaymentAndPayout(amountRub, rules = {}) {
  const amount = Math.max(0, Number(amountRub) || 0);
  return round2(calculateTbankCardFee(amount, rules) + calculateTbankPayoutFee(amount, rules));
}

export function calculateNetAmountAfterFees(grossAmountRub, platformFeePercent = 0, rules = {}) {
  const cfg = normalizeRules(rules);
  const gross = Math.max(0, Number(grossAmountRub) || 0);
  const platformFee = gross * (Math.max(0, Number(platformFeePercent) || 0) / 100);
  const cardFee = calculateTbankCardFee(gross, cfg);

  const payoutPercentRatio = cfg.payoutFeePercent / 100;
  const minPayoutThreshold = payoutPercentRatio > 0 ? cfg.payoutFeeMinRub / payoutPercentRatio : Number.POSITIVE_INFINITY;
  const netWhenMinPayoutFee = floor2(gross - platformFee - cardFee - cfg.payoutFeeMinRub);

  if (payoutPercentRatio <= 0 || netWhenMinPayoutFee <= 0 || netWhenMinPayoutFee < minPayoutThreshold) {
    const payoutFee = calculateTbankPayoutFee(netWhenMinPayoutFee, cfg);
    return {
      platformFee: round2(platformFee),
      tbankCardFee: cardFee,
      tbankPayoutFee: payoutFee,
      tbankFee: round2(cardFee + payoutFee),
      netAmount: netWhenMinPayoutFee,
    };
  }

  const netWithPercentPayoutFee = floor2((gross - platformFee - cardFee) / (1 + payoutPercentRatio));
  const payoutFee = calculateTbankPayoutFee(netWithPercentPayoutFee, cfg);

  return {
    platformFee: round2(platformFee),
    tbankCardFee: cardFee,
    tbankPayoutFee: payoutFee,
    tbankFee: round2(cardFee + payoutFee),
    netAmount: netWithPercentPayoutFee,
  };
}

export const tbankFeeConfig = {
  cardFeePercent: TBANK_CARD_FEE_PERCENT,
  cardFeeMinRub: TBANK_CARD_FEE_MIN_RUB,
  payoutFeePercent: TBANK_PAYOUT_FEE_PERCENT,
  payoutFeeMinRub: TBANK_PAYOUT_FEE_MIN_RUB,
};
