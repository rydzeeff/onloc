import { createClient } from '@supabase/supabase-js';

function getClients(authHeader) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anon || !service) {
    throw new Error('Supabase env is not configured');
  }

  const userClient = createClient(url, anon, {
    global: { headers: authHeader ? { Authorization: authHeader } : {} },
  });

  const adminClient = createClient(url, service);
  return { userClient, adminClient };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { userClient, adminClient } = getClients(authHeader);

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    const userId = userData?.user?.id;
    if (userErr || !userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: access, error: accErr } = await adminClient
      .from('user_admin_access')
      .select('is_admin, news')
      .eq('user_id', userId)
      .maybeSingle();

    if (accErr) return res.status(500).json({ error: accErr.message });
    const canBroadcast = !!(access?.is_admin || access?.news);
    if (!canBroadcast) {
      return res.status(403).json({ error: 'Forbidden: news permission required' });
    }

    const title = String(req.body?.title || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!title || !body) return res.status(400).json({ error: 'title/body are required' });

    const { data: profiles, error: profilesErr } = await adminClient
      .from('profiles')
      .select('user_id')
      .not('user_id', 'is', null);

    if (profilesErr) return res.status(500).json({ error: profilesErr.message });

    const recipients = (profiles || []).map((r) => r.user_id).filter(Boolean);
    if (!recipients.length) return res.status(200).json({ inserted: 0 });

    let inserted = 0;
    const CHUNK = 500;

    for (let i = 0; i < recipients.length; i += CHUNK) {
      const chunk = recipients.slice(i, i + CHUNK);
      const rows = chunk.map((uid) => ({
        user_id: uid,
        trip_id: null,
        actor_user_id: userId,
        type: 'system_broadcast',
        title,
        body,
        metadata: { source: 'admin_broadcast' },
      }));

      const { error: insErr, count } = await adminClient
        .from('trip_alerts')
        .insert(rows, { count: 'exact' });

      if (insErr) return res.status(500).json({ error: insErr.message, inserted });
      inserted += count || rows.length;
    }

    return res.status(200).json({ inserted });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Unexpected error' });
  }
}
