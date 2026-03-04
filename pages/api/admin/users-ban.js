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
    const actorId = userData?.user?.id;
    if (userErr || !actorId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: access, error: accErr } = await adminClient
      .from('user_admin_access')
      .select('is_admin, users')
      .eq('user_id', actorId)
      .maybeSingle();

    if (accErr) return res.status(500).json({ error: accErr.message });
    const canModerateUsers = !!(access?.is_admin || access?.users);
    if (!canModerateUsers) {
      return res.status(403).json({ error: 'Forbidden: users permission required' });
    }

    const targetUserId = String(req.body?.targetUserId || '').trim();
    const isBanned = !!req.body?.isBanned;
    const reason = String(req.body?.reason || '').trim();

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId is required' });
    }
    if (targetUserId === actorId) {
      return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });
    }
    if (isBanned && !reason) {
      return res.status(400).json({ error: 'reason is required for ban' });
    }

    const payload = {
      is_banned: isBanned,
      ban_reason: isBanned ? reason : null,
      banned_at: isBanned ? new Date().toISOString() : null,
    };

    const { error: updErr } = await adminClient
      .from('profiles')
      .update(payload)
      .eq('user_id', targetUserId);

    if (updErr) return res.status(500).json({ error: updErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Unexpected error' });
  }
}
