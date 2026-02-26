import { z } from 'zod';
import { apiPost } from './http';
import { supabase } from './supabase';

const customAuthSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  redirect: z.string().optional(),
  callNumber: z.string().optional(),
  qrCodeUrl: z.string().optional(),
  callId: z.string().optional()
});

export async function customAuth(payload: Record<string, unknown>) {
  const result = await apiPost('/api/custom-auth', payload);
  return customAuthSchema.parse(result);
}

export async function applySession(access_token?: string, refresh_token?: string) {
  if (!access_token || !refresh_token) return;
  await supabase.auth.setSession({ access_token, refresh_token });
}
