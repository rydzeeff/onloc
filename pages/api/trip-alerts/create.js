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
  const adminClient = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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
    const requesterId = userData?.user?.id;
    if (userErr || !requesterId) return res.status(401).json({ error: 'Unauthorized' });

    const {
      userId,
      tripId = null,
      type,
      title,
      body,
      actorUserId = null,
      metadata = {},
    } = req.body || {};

    if (!userId || !type || !title || !body) {
      return res.status(400).json({ error: 'userId, type, title, body are required' });
    }

    const normalizedActorId = actorUserId || requesterId;

    if (normalizedActorId !== requesterId) {
      return res.status(403).json({ error: 'actor_user_id must match requester' });
    }

    const isSelfAlert = userId === requesterId;

    if (!isSelfAlert) {
      if (!tripId) {
        return res.status(403).json({ error: 'Cross-user alerts require tripId' });
      }

      const { data: trip, error: tripErr } = await adminClient
        .from('trips')
        .select('id, creator_id')
        .eq('id', tripId)
        .maybeSingle();
      if (tripErr) return res.status(500).json({ error: tripErr.message });
      if (!trip) return res.status(404).json({ error: 'Trip not found' });

      const { data: links, error: linksErr } = await adminClient
        .from('trip_participants')
        .select('user_id')
        .eq('trip_id', tripId)
        .in('user_id', [requesterId, userId]);
      if (linksErr) return res.status(500).json({ error: linksErr.message });

      const linkedUsers = new Set((links || []).map((r) => r.user_id));

      const requesterInTrip = requesterId === trip.creator_id || linkedUsers.has(requesterId);
      const recipientInTrip = userId === trip.creator_id || linkedUsers.has(userId);

      if (!requesterInTrip || !recipientInTrip) {
        return res.status(403).json({ error: 'Cross-user alerts are allowed only within the same trip' });
      }
    }

    const payload = {
      user_id: userId,
      trip_id: tripId,
      type,
      title,
      body,
      actor_user_id: normalizedActorId,
      metadata,
    };

    const { error: insErr } = await adminClient.from('trip_alerts').insert(payload);
    if (insErr) return res.status(500).json({ error: insErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Unexpected error' });
  }
}
