// pages/DashboardMobile.js
// Мобильный дашборд (таббар + секции). Иконки таббара — SVG (inactive/active).
// Выход перенесён в SettingsPageMobile (в таббаре кнопки "Выход" больше нет).

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import mobileStyles from '../styles/dashboard.mobile.module.css';
import EditTripMobile from './trips/EditTripMobile';
import MessagesPage from './messages';
import AlertsBell from '../components/AlertsBell';
import CreateTrip from './trips/create-trip';
import TripParticipantsPage from './participants';
import SettingsPageMobile from './SettingsPageMobile';
import MyTripsSectionMobile from './MyTripsSectionMobile';
import { notifications } from './_app';
import { useTripAlertsCount } from '../lib/useTripAlertsCount';

export default function DashboardMobile({
  initialSection,
  user,
  supabase,
  loading,
  router,
  initialTrips = [],
  initialTripId = null,
}) {
  const [activeSection, setActiveSection] = useState(initialSection || 'myTrips');
  const [trips, setTrips] = useState(initialTrips);
  const [reviews, setReviews] = useState([]);
  const [selectedTripId, setSelectedTripId] = useState(initialTripId || null);
  const [avatarUrl, setAvatarUrl] = useState('/avatar-default.svg');
  const [triggerAnimation, setTriggerAnimation] = useState(false);

  // Для сообщений: когда открыт чат — прячем таббар (как у тебя было)
  const [hideSidebar, setHideSidebar] = useState(false);
  const [isChatTransitioning, setIsChatTransitioning] = useState(false);

  const mainContentRef = useRef(null);

  const fetchTrips = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase.rpc('get_user_trips', { user_uuid: user.id });
      if (error) throw error;

      const formattedTrips = (data || []).map((trip) => ({
        ...trip,
        trip_participants: trip.participant_status
          ? [{ status: trip.participant_status, user_id: trip.participant_user_id }]
          : [],
      }));

      setTrips(formattedTrips);
    } catch (e) {
      console.error('[DashboardMobile][fetchTrips] error:', e);
    }
  }, [user?.id, supabase]);

  const fetchAvatar = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('avatar_url')
        .eq('user_id', user.id)
        .single();
      if (error) throw error;

      if (data?.avatar_url) setAvatarUrl(data.avatar_url);
    } catch (e) {
      console.error('[DashboardMobile][fetchAvatar] error:', e);
    }
  }, [user?.id, supabase]);

  const fetchReviews = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase
        .from('reviews')
        .select(
          'id, organizer_id, reviewer_id, rating, text, created_at, trip_id, trips:trip_id(title), reviewer:reviewer_id(first_name, last_name)'
        )
        .eq('organizer_id', user.id);

      if (error) throw error;
      if (data) setReviews(data);
    } catch (e) {
      console.error('[DashboardMobile][fetchReviews] error:', e);
    }
  }, [user?.id, supabase]);

  useEffect(() => {
    if (!user?.id || loading) return;

    // Мгновенно отрисуем SSR-набор (если передали)
    setTrips(initialTrips);

    const fetchInitialData = async () => {
      try {
        await Promise.all([fetchTrips(), fetchAvatar(), fetchReviews()]);
      } catch (error) {
        console.error('[DashboardMobile] Error fetching initial data:', error);
      }
    };

    fetchInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, loading]);

  // Слежение за URL: если появился/изменился ?tripId — синхронизируем local state
  // + если пришли на participants из URL — убедимся, что секция выставлена
  useEffect(() => {
  const urlTripId = typeof router.query?.tripId === 'string' ? router.query.tripId : null;
  if (urlTripId && urlTripId !== selectedTripId) setSelectedTripId(urlTripId);

  const urlSection = router.query?.section;
  if (urlSection === 'participants' && activeSection !== 'participants') {
    setActiveSection('participants');
    setTriggerAnimation(true);
  }

  if (urlSection === 'edit-trip' && activeSection !== 'edit-trip') {
    setActiveSection('edit-trip');
    setTriggerAnimation(true);
  }
}, [router.query?.tripId, router.query?.section, activeSection, selectedTripId]);

  // Синхронизация секции из URL + поддержка возврата на вкладку браузера
  useEffect(() => {
    const applySectionFromUrl = () => {
      const { section } = router.query;
      if (section && section !== activeSection) {
        setActiveSection(section);
        setTriggerAnimation(true);
      }
    };

    applySectionFromUrl();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') applySectionFromUrl();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [router.query, router.query.section, activeSection]);

  // ✅ FIX: если browser-back переключил секцию с messages на другую,
  // а чат был открыт — таббар мог остаться скрытым. Принудительно показываем.
  useEffect(() => {
    const sec = typeof router.query?.section === "string" ? router.query.section : (initialSection || "myTrips");
    if (sec !== "messages") {
      setHideSidebar(false);
      setIsChatTransitioning(false);
    }
  }, [router.query?.section, initialSection]);


  // Сброс triggerAnimation, чтобы не “залипало”
  useEffect(() => {
    if (!triggerAnimation) return;
    const timer = setTimeout(() => setTriggerAnimation(false), 300);
    return () => clearTimeout(timer);
  }, [triggerAnimation]);

  useEffect(() => {
    console.log('DashboardMobile rendered', {
      user: user?.id,
      loading,
      activeSection,
      selectedTripId,
      urlTripId: router.query?.tripId,
    });
  }, [activeSection, loading, selectedTripId, user?.id, router.query?.tripId]);

  // Клик по карточке: ставим tripId в стейт и в URL (section+tripId)
  const handleTripClick = useCallback(
    (tripId) => {
      setSelectedTripId(tripId);
      setActiveSection('participants');
      setTriggerAnimation(true);

      router
        .push({ pathname: '/dashboard', query: { section: 'participants', tripId } }, undefined, { shallow: true })
        .catch((error) => console.error('[DashboardMobile] router.push failed:', error));
    },
    [router]
  );

  // Переключение секций: если идём в participants — не забываем про tripId
  const handleSectionChange = useCallback(
    (section) => {
      if (section === activeSection) return;

      setActiveSection(section);
      setTriggerAnimation(true);
      setHideSidebar(false);

      const urlTripId = typeof router.query?.tripId === 'string' ? router.query.tripId : undefined;
      const needsTripId = section === 'participants' || section === 'edit-trip';
const q = needsTripId
  ? { section, tripId: selectedTripId || urlTripId }
  : { section };

      router
        .push({ pathname: '/dashboard', query: q }, undefined, { shallow: true })
        .catch((error) => console.error('[DashboardMobile] router.push failed:', error));
    },
    [activeSection, router, selectedTripId]
  );

  const handleChatOpen = useCallback((isOpen) => {
    setIsChatTransitioning(true);
    setHideSidebar(isOpen);
    setTimeout(() => setIsChatTransitioning(false), 300);
  }, []);

  const totalUnread = notifications.getTotalUnread();
  const unreadAlerts = useTripAlertsCount(user?.id);

  // tripId и из стейта, и из URL — чтобы переживать F5
  const effectiveTripId =
    selectedTripId || (typeof router.query?.tripId === 'string' ? router.query.tripId : null);

  const navItems = [
    {
      id: 'myTrips',
      label: 'Мои поездки',
      icon: '/icons/nav/mytrips.svg',
      iconActive: '/icons/nav/mytrips-active.svg',
    },
    {
      id: 'create-trip',
      label: 'Создать',
      icon: '/icons/nav/create.svg',
      iconActive: '/icons/nav/create-active.svg',
    },
    {
      id: 'messages',
      label: 'Сообщения',
      icon: '/icons/nav/messages.svg',
      iconActive: '/icons/nav/messages-active.svg',
      unread: totalUnread,
    },
    {
      id: 'settings',
      label: 'Настройки',
      icon: '/icons/nav/settings.svg',
      iconActive: '/icons/nav/settings-active.svg',
    },
    {
      id: 'reviews',
      label: 'Отзывы',
      icon: '/icons/nav/reviews.svg',
      iconActive: '/icons/nav/reviews-active.svg',
    },
  ];

  return (
    <div className={mobileStyles.container}>
      <header className={mobileStyles.header}>
        <img src="/logo.png" alt="Onloc Logo" className={mobileStyles.logo} />
        <div className={mobileStyles.authButtons}>
          <AlertsBell
            user={user}
            count={unreadAlerts}
            buttonClassName={mobileStyles.button}
          />
          <button className={mobileStyles.button} type="button">
            Информация
          </button>
          <Link href="/trips" className={`${mobileStyles.button} ${mobileStyles.mapButton}`}>
            На карту
          </Link>
        </div>
      </header>

      <div className={mobileStyles.mainContent} ref={mainContentRef}>
        <div className={mobileStyles.content}>
          {activeSection === 'myTrips' && (
            <MyTripsSectionMobile trips={trips} user={user} onTripClick={handleTripClick} />
          )}

          {activeSection === 'create-trip' && (
            <CreateTrip toLocation={router.query.to_location} mainContentRef={mainContentRef} />
          )}

          {activeSection === 'messages' && (
            <MessagesPage
              user={user}
              triggerAnimation={triggerAnimation}
              onChatOpen={handleChatOpen}
              hideSidebar={hideSidebar}
            />
          )}

          {activeSection === 'settings' && (
            <SettingsPageMobile
              user={user}
              supabase={supabase}
              avatarUrl={avatarUrl}
              setAvatarUrl={setAvatarUrl}
            />
          )}

          {activeSection === 'reviews' && (
            <div className={mobileStyles.fullPage}>
              <h2>Мои отзывы</h2>
              <div className={mobileStyles.averageRating}>
                Общий рейтинг:{' '}
                <span className={mobileStyles.ratingValue}>
                  {reviews.length
                    ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
                    : 0}
                </span>
              </div>

              <div className={mobileStyles.reviewsGrid}>
                {reviews.length ? (
                  reviews.map((review) => (
                    <div key={review.id} className={mobileStyles.reviewCard}>
                      <div className={mobileStyles.reviewHeader}>
                        <span className={mobileStyles.reviewerName}>
                          {review.reviewer?.first_name} {review.reviewer?.last_name}
                        </span>
                        <span className={mobileStyles.ratingStars}>
                          {'★'.repeat(review.rating)}
                          {'☆'.repeat(5 - review.rating)}
                        </span>
                      </div>
                      <p className={mobileStyles.reviewTrip}>Поездка: {review.trips?.title}</p>
                      <p className={mobileStyles.reviewText}>{review.text}</p>
                      <p className={mobileStyles.reviewDate}>
                        {new Date(review.created_at).toLocaleDateString('ru')}
                      </p>
                    </div>
                  ))
                ) : (
                  <p>У вас пока нет отзывов.</p>
                )}
              </div>
            </div>
          )}

{activeSection === 'edit-trip' && effectiveTripId && (
  <EditTripMobile tripId={effectiveTripId} mainContentRef={mainContentRef} />
)}

          {activeSection === 'participants' && effectiveTripId && (
            <TripParticipantsPage tripId={effectiveTripId} />
          )}
        </div>
      </div>

      <div
        className={`${mobileStyles.sidebar} ${hideSidebar ? mobileStyles.hidden : ''} ${
          isChatTransitioning ? mobileStyles.transitioning : ''
        }`}
      >
        {navItems.map((item) => {
          const isActive = activeSection === item.id;
          const iconSrc = isActive ? item.iconActive : item.icon;

          return (
            <button
              key={item.id}
              type="button"
              className={`${isActive ? mobileStyles.activeMenuItem : mobileStyles.menuItem} ${
                item.unread > 0 && !isActive ? mobileStyles.unreadMenuItem : ''
              }`}
              onClick={() => handleSectionChange(item.id)}
            >
              <span className={mobileStyles.icon} aria-hidden="true">
                <img className={mobileStyles.navIcon} src={iconSrc} alt="" />
              </span>

              <span className={mobileStyles.menuLabel}>{item.label}</span>

              {item.unread > 0 && !isActive && (
                <span className={mobileStyles.unreadIndicator}>{item.unread}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
