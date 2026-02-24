import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from './_app';
import DashboardPC from './DashboardPC';
import DashboardMobile from './DashboardMobile';

export default function Dashboard({ initialSection, initialTrips, initialTripId }) {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [isMobile, setIsMobile] = useState(null);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  if (loading || isMobile === null) return <div>Loading...</div>;
  if (!user) {
    router.push('/auth');
    return null;
  }

  return isMobile ? (
    <DashboardMobile
      initialSection={initialSection}
      user={user}
      supabase={supabase}
      loading={loading}
      router={router}
      initialTrips={initialTrips}
      initialTripId={initialTripId}
    />
  ) : (
    <DashboardPC
      initialSection={initialSection}
      user={user}
      supabase={supabase}
      loading={loading}
      router={router}
      initialTrips={initialTrips}
      initialTripId={initialTripId}
    />
  );
}

export async function getServerSideProps(context) {
  const { section, tripId } = context.query;
  let initialTrips = [];

  // Загрузка поездок для авторизованного пользователя (если токен есть на сервере)
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (user) {
    const { data, error } = await supabase.rpc('get_user_trips', { user_uuid: user.id });
    if (!error && data) {
      initialTrips = data.map(trip => ({
        ...trip,
        trip_participants: trip.participant_status ? [{ status: trip.participant_status, user_id: trip.participant_user_id }] : [],
      }));
    }
  }

  return {
    props: {
      initialSection: section || 'myTrips',
      initialTrips,
      initialTripId: typeof tripId === 'string' ? tripId : null,
    },
  };
}
