import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { fetchUnreadTripAlertsCount } from './tripAlerts';

export function useTripAlertsCount(userId) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId) {
      setCount(0);
      return;
    }

    let mounted = true;

    const refresh = async () => {
      try {
        const next = await fetchUnreadTripAlertsCount({ userId, client: supabase });
        if (mounted) setCount(next);
      } catch (e) {
        console.error('[useTripAlertsCount] refresh failed:', e?.message || e);
      }
    };

    refresh();

    const channel = supabase
      .channel(`public:trip_alerts:user_id=eq.${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trip_alerts', filter: `user_id=eq.${userId}` },
        refresh
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return count;
}
