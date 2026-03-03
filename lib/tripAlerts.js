import { supabase } from './supabaseClient';

export async function createTripAlert({
  userId,
  tripId = null,
  type,
  title,
  body,
  actorUserId = null,
  metadata = {},
  client = supabase,
}) {
  if (!userId || !type || !title || !body) return;

  const { error } = await client.from('trip_alerts').insert({
    user_id: userId,
    trip_id: tripId,
    type,
    title,
    body,
    actor_user_id: actorUserId,
    metadata,
  });

  if (error) throw error;
}

export async function fetchUnreadTripAlertsCount({ userId, client = supabase }) {
  if (!userId) return 0;

  const { count, error } = await client
    .from('trip_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) throw error;
  return count || 0;
}

export async function markTripAlertsRead({ userId, tripId = null, client = supabase }) {
  if (!userId) return;
  let query = client
    .from('trip_alerts')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (tripId) query = query.eq('trip_id', tripId);

  const { error } = await query;
  if (error) throw error;
}
