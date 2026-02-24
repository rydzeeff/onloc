// supabase/functions/support-close-cron/index.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const now = new Date();
  const { data: chats } = await supabase
    .from('chats')
    .select('id, support_close_requested_at')
    .eq('chat_type', 'support')
    .is('support_close_confirmed', null)
    .not('support_close_requested_at', 'is', null);

  for (const c of chats || []) {
    const reqAt = new Date(c.support_close_requested_at as string);
    const hours = (now.getTime() - reqAt.getTime()) / 36e5;

    if (hours >= 24) {
      await supabase.from('chats').update({ chat_type: 'archived' }).eq('id', c.id);
      await supabase.from('chat_messages').insert({
        chat_id: c.id,
        user_id: '00000000-0000-0000-0000-000000000000', // системный
        content: '[SYSTEM] Чат автоматически архивирован: нет ответа от пользователя в течение 24 часов.',
        created_at: new Date().toISOString(),
        read: false,
      });
      continue;
    }

    // Простая схема напоминаний: около 6ч и 18ч
    if (hours >= 18 || hours >= 6) {
      await supabase.from('chat_messages').insert({
        chat_id: c.id,
        user_id: '00000000-0000-0000-0000-000000000000',
        content: '[CLOSE_PROMPT] Напоминание. Закрыть чат? Ответьте «Да» или «Нет».',
        created_at: new Date().toISOString(),
        read: false,
      });
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
});
