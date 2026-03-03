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

    const playAlertSound = () => {
      try {
        const audio = new Audio('/sounds/alert.mp3');
        audio.volume = 0.8;
        audio.play().catch(() => {});
        if (navigator?.vibrate) navigator.vibrate(60);
      } catch {}
    };

    const channel = supabase
      .channel(`public:trip_alerts:user_id=eq.${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trip_alerts', filter: `user_id=eq.${userId}` },
        (payload) => {
          if (payload?.eventType === 'INSERT' && payload?.new && payload.new.is_read === false) {
            playAlertSound();
          }
          refresh();
        }
      )
      .subscribe();

    const poll = setInterval(refresh, 15000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      mounted = false;
      clearInterval(poll);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return count;
}
