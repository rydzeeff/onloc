import { buildInitPaymentPayload } from '../lib/paymentPayload';

test('builds stable payment payload fields', () => {
  const payload = buildInitPaymentPayload('trip', 'part', 1000);
  expect(payload.tripId).toBe('trip');
  expect(payload.participantId).toBe('part');
  expect(payload.notificationUrl).toBe('/api/tbank/payment-notification');
});
