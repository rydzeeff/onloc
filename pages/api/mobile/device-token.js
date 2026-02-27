import { createClient } from '@supabase/supabase-js';

function getClient(req) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const authHeader = req.headers.authorization;
  const options = authHeader
    ? { global: { headers: { Authorization: authHeader } } }
    : undefined;

  if (serviceKey) return createClient(url, serviceKey, options);
  return createClient(url, anon, options);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = getClient(req);
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { token, platform } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const { error } = await supabase.from('device_tokens').upsert(
      {
        user_id: user.id,
        token,
        platform: platform || 'unknown',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' }
    );

    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[api/mobile/device-token] error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}
