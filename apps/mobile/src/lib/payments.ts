import * as WebBrowser from 'expo-web-browser';
import { apiPost } from './http';

export async function initPayment(payload: Record<string, unknown>) {
  return apiPost<{ paymentUrl: string; paymentId: string; orderId: string }>('/api/tbank/init-payment', payload);
}

export async function openPaymentUrl(url: string) {
  return WebBrowser.openBrowserAsync(url);
}

export async function getPaymentState(paymentId: string) {
  return apiPost<{ status: string; Success?: boolean; paymentStatus?: string }>('/api/tbank/get-state', { paymentId });
}
