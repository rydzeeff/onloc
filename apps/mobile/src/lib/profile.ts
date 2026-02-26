import { supabase } from './supabase';

export async function getProfile(userId: string) {
  const { data, error } = await supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertProfile(userId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from('profiles').upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });
  if (error) throw error;
}
