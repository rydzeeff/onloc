import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Создаём единственный экземпляр клиента
const supabase = createClient(supabaseUrl, supabaseKey);

export function getSupabaseWithToken(token) {
  // Возвращаем клиент с обновлённым токеном
  return createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export { supabase };