export function buildInitPaymentPayload(tripId: string, participantId: string, amount: number) {
  const orderId = `mobile_${tripId}_${Date.now()}`;
  return {
    tripId,
    participantId,
    amount,
    orderId,
    notificationUrl: '/api/tbank/payment-notification',
    successUrl: '/payment-result?status=success',
    failUrl: '/payment-result?status=fail'
  };
}
