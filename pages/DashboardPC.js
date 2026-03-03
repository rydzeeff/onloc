import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import pcStyles from '../styles/dashboard.pc.module.css';
import MessagesPage from './messages';
import AlertsBell from '../components/AlertsBell';
import CreateTrip from './trips/create-trip';
import EditTrip from './trips/edit-trip';
import TripParticipantsPage from './participants';
import SettingsPagePC from './SettingsPagePC';
import MyTripsSection from './MyTripsSection';
import { notifications } from './_app';
import { useTripAlertsCount } from '../lib/useTripAlertsCount';

export default function DashboardPC({ initialSection, user, supabase, loading, router, initialTrips = [], initialTripId = null }) {
  const [activeSection, setActiveSection] = useState(initialSection || 'myTrips');
  const [trips, setTrips] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [selectedTripId, setSelectedTripId] = useState(initialTripId || null);
  const [avatarUrl, setAvatarUrl] = useState('/avatar-default.svg');
  const [triggerAnimation, setTriggerAnimation] = useState(false);
  const [exitingSection, setExitingSection] = useState(null);

  const fetchTrips = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.rpc('get_user_trips', { user_uuid: user.id });
    if (data) {
      const formattedTrips = data.map(trip => ({
        ...trip,
        trip_participants: trip.participant_status ? [{ status: trip.participant_status, user_id: trip.participant_user_id }] : [],
      }));
      setTrips(formattedTrips);
    }
  }, [user, supabase]);

  const fetchAvatar = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from('profiles').select('avatar_url').eq('user_id', user.id).single();
    if (data?.avatar_url) setAvatarUrl(data.avatar_url);
  }, [user, supabase]);

  // ⬇️ Обновлено: подтягиваем отзывы и из reviews, и из company_reviews
  const fetchReviews = useCallback(async () => {
    if (!user) return;

    const [r1, r2] = await Promise.all([
      supabase
        .from('reviews')
        .select(
          'id, organizer_id, reviewer_id, rating, text, created_at, trip_id, ' +
          'trips:trip_id(title), reviewer:reviewer_id(first_name, last_name)'
        )
        .eq('organizer_id', user.id),
      supabase
        .from('company_reviews')
        .select(
          'id, organizer_id, reviewer_id, rating, text, created_at, trip_id, ' +
          'trips:trip_id(title), reviewer:reviewer_id(first_name, last_name)'
        )
        .eq('organizer_id', user.id),
    ]);

    const rowsReviews = Array.isArray(r1?.data)
      ? r1.data.map(r => ({ ...r, _source: 'reviews', _key: `r-${r.id}` }))
      : [];

    const rowsCompany = Array.isArray(r2?.data)
      ? r2.data.map(r => ({ ...r, _source: 'company_reviews', _key: `c-${r.id}` }))
      : [];

    const merged = [...rowsReviews, ...rowsCompany].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    setReviews(merged);
  }, [user, supabase]);

  useEffect(() => {
    if (!user || loading) return;
    const fetchInitialData = async () => {
      try {
        await Promise.all([fetchTrips(), fetchAvatar(), fetchReviews()]);
      } catch (error) {
        console.error('Error fetching initial data:', error);
      }
    };
    setTrips(initialTrips); // мгновенно отрисуем SSR набор
    if (initialSection === 'participants' && initialTripId && !selectedTripId) {
      setSelectedTripId(initialTripId);
    }
    fetchInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, loading]);

  useEffect(() => {
    const urlTripId = typeof router.query?.tripId === 'string' ? router.query.tripId : null;
    if (urlTripId && urlTripId !== selectedTripId) {
      setSelectedTripId(urlTripId);
    }
    const urlSection = router.query?.section;
    if (urlSection === 'participants' && activeSection !== 'participants') {
      setExitingSection(activeSection);
      setTimeout(() => {
        setActiveSection('participants');
        setTriggerAnimation(true);
        setExitingSection(null);
      }, 300);
    }
  }, [router.query?.tripId, router.query?.section, activeSection, selectedTripId]);

  useEffect(() => {
    const { section } = router.query;
    if (section && section !== activeSection) {
      setExitingSection(activeSection);
      setTimeout(() => {
        setActiveSection(section);
        setTriggerAnimation(true);
        setExitingSection(null);
      }, 300);
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const { section } = router.query;
        if (section && section !== activeSection) {
          setExitingSection(activeSection);
          setTimeout(() => {
            setActiveSection(section);
            setTriggerAnimation(true);
            setExitingSection(null);
          }, 300);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [router.query.section, activeSection]);

  useEffect(() => {
    if (triggerAnimation) {
      const timer = setTimeout(() => setTriggerAnimation(false), 300);
      return () => clearTimeout(timer);
    }
  }, [triggerAnimation]);

  const handleLogout = useCallback(async () => {
    await supabase.auth.signOut();
    router.push('/auth');
  }, [router, supabase]);

  const handleTripClick = useCallback((tripId) => {
    setSelectedTripId(tripId);
    setExitingSection(activeSection);
    setTimeout(() => {
      setActiveSection('participants');
      setTriggerAnimation(true);
      setExitingSection(null);
    }, 300);
    router.push(
      { pathname: '/dashboard', query: { section: 'participants', tripId } },
      undefined,
      { shallow: true }
    );
  }, [activeSection, router]);

  const handleSectionChange = useCallback((section) => {
    if (section === activeSection) return;

    setExitingSection(activeSection);
    setTimeout(() => {
      setActiveSection(section);
      if (section !== 'participants') {
        // setSelectedTripId(null);
      }
      setTriggerAnimation(true);
      setExitingSection(null);
    }, 300);

    const q = section === 'participants'
      ? { section, tripId: selectedTripId || (typeof router.query?.tripId === 'string' ? router.query.tripId : undefined) }
      : { section };

    router.push({ pathname: '/dashboard', query: q }, undefined, { shallow: true })
      .catch((error) => console.error('router.push failed:', error));
  }, [activeSection, router, selectedTripId]);

  const totalUnread = notifications.getTotalUnread();
  const unreadAlerts = useTripAlertsCount(user?.id);

  useEffect(() => {
    console.log('DashboardPC rendered', {
      user: user?.id,
      loading,
      activeSection,
      selectedTripId,
      urlTripId: router.query?.tripId,
    });
  }, [activeSection, loading, selectedTripId, user, router.query?.tripId]);

  const effectiveTripId = selectedTripId || (typeof router.query?.tripId === 'string' ? router.query.tripId : null);

  return (
    <div className={pcStyles.container}>
      <header className={pcStyles.header}>
        <img src="/logo.png" alt="Onloc Logo" className={pcStyles.logo} />
        <div className={pcStyles.authButtons}>
          <AlertsBell
            user={user}
            count={unreadAlerts}
            buttonClassName={pcStyles.notificationIconButton}
            iconClassName={pcStyles.notificationBellIcon}
            scale={2}
          />
          <button className={pcStyles.button}>Информация</button>
          <Link href="/trips" className={`${pcStyles.button} ${pcStyles.mapButton}`}>На карту</Link>
        </div>
      </header>
      <div className={pcStyles.main}>
        <div className={pcStyles.sidebar}>
          {[
            { id: 'myTrips', label: 'Мои поездки' },
            { id: 'create-trip', label: 'Создать' },
            { id: 'messages', label: 'Сообщения', unread: totalUnread },
            { id: 'settings', label: 'Настройки' },
            { id: 'reviews', label: 'Отзывы' },
          ].map(item => (
            <button
              key={item.id}
              className={`${activeSection === item.id ? pcStyles.activeMenuItem : pcStyles.menuItem} ${item.unread > 0 && activeSection !== item.id ? pcStyles.unreadMenuItem : ''}`}
              onClick={() => handleSectionChange(item.id)}
              onMouseDown={() => console.log(`Button ${item.id} clicked`)}
            >
              <span>{item.label}</span>
              {item.unread > 0 && activeSection !== item.id && <span className={pcStyles.unreadIndicator}>{item.unread}</span>}
            </button>
          ))}
          <button className={pcStyles.menuItem} onClick={handleLogout}>Выход</button>
        </div>
        <div className={pcStyles.content}>
          {activeSection === 'myTrips' && (
            <MyTripsSection trips={trips} user={user} onTripClick={handleTripClick} />
          )}

          {activeSection === 'create-trip' && (
            <CreateTrip toLocation={router.query.to_location} />
          )}

          {activeSection === 'messages' && (
            <MessagesPage user={user} triggerAnimation={triggerAnimation} />
          )}

          {activeSection === 'alerts' && (
            <AlertsPage user={user} />
          )}

          {activeSection === 'settings' && (
            <SettingsPagePC avatarUrl={avatarUrl} setAvatarUrl={setAvatarUrl} />
          )}

          {activeSection === 'reviews' && (
            <div className={pcStyles.sectionContent}>
              <div className={`${pcStyles.tabContent} ${exitingSection === 'reviews' ? pcStyles.exiting : ''}`}>
                <h2>Мои отзывы</h2>
                <div className={pcStyles.averageRating}>
                  Общий рейтинг:{' '}
                  <span className={pcStyles.ratingValue}>
                    {reviews.length ? (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(1) : 0}
                  </span>
                </div>
                <div className={pcStyles.reviewsGrid}>
                  {reviews.length ? reviews.map(review => (
                    <div key={review._key || review.id} className={pcStyles.reviewCard}>
                      <div className={pcStyles.reviewHeader}>
                        <span className={pcStyles.reviewerName}>
                          {review.reviewer?.first_name} {review.reviewer?.last_name}
                        </span>
                        <span className={pcStyles.ratingStars}>
                          {'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}
                        </span>
                      </div>
                      <p className={pcStyles.reviewTrip}>Поездка: {review.trips?.title}</p>
                      <p className={pcStyles.reviewText}>{review.text}</p>
                      <p className={pcStyles.reviewDate}>{new Date(review.created_at).toLocaleDateString('ru')}</p>
                    </div>
                  )) : <p>У вас пока нет отзывов.</p>}
                </div>
              </div>
            </div>
          )}

{activeSection === 'edit-trip' && effectiveTripId && (
  <EditTrip
    tripId={effectiveTripId}
    returnTo={
      (typeof router.query?.returnTo === 'string' ? router.query.returnTo : null) ||
      'participants'
    }
  />
)}

          {activeSection === 'participants' && effectiveTripId && (
            <TripParticipantsPage tripId={effectiveTripId} />
          )}
        </div>
      </div>
    </div>
  );
}
