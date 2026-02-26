import { supabase } from './supabase';

export async function fetchTripsForUser(userId: string) {
  const { data, error } = await supabase.rpc('get_user_trips', { user_uuid: userId });
  if (error) throw error;
  return data ?? [];
}

export async function fetchTripDetails(tripId: string) {
  const { data, error } = await supabase.rpc('get_trip_details_geojson', { trip_id: tripId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function fetchTripParticipants(tripId: string) {
  const { data, error } = await supabase.rpc('get_trip_participants_with_details', { trip_uuid: tripId });
  if (error) throw error;
  return data ?? [];
}

export async function joinTrip(tripId: string, userId: string) {
  const { error } = await supabase.from('trip_participants').upsert(
    { trip_id: tripId, user_id: userId, status: 'waiting', joined_at: new Date().toISOString() },
    { onConflict: 'trip_id,user_id' }
  );
  if (error) throw error;
}

export async function leaveTrip(tripId: string, userId: string) {
  const { error } = await supabase
    .from('trip_participants')
    .update({ status: 'rejected' })
    .eq('trip_id', tripId)
    .eq('user_id', userId);
  if (error) throw error;
}
