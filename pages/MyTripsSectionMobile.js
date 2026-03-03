// MyTripsSectionMobile.js
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import mobileStyles from '../styles/dashboard.mobile.module.css';
import { supabase } from '../lib/supabaseClient';

const DEFAULT_TRIP_IMG_MB = "/def/fotoMB.jpg";

function pickTripCoverUrl(trip) {
  let urls = trip?.image_urls;

  if (typeof urls === "string") {
    try {
      urls = JSON.parse(urls);
    } catch (_) {
      urls = null;
    }
  }

  const first = Array.isArray(urls) ? urls[0] : null;
  return first || DEFAULT_TRIP_IMG_MB;
}


const MyTripsSectionMobile = ({ trips: _trips, user, onTripClick }) => {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('upcoming');

  // Чтобы не мелькали старые данные из пропса trips — стартуем с пустого списка
  const [tripList, setTripList] = useState([]);

  // Флаг загрузки (пока не подтянули актуальные статусы из БД — показываем "Загрузка")
  const [loadingTrips, setLoadingTrips] = useState(true);

  // Функция для загрузки поездок
  const fetchTrips = useCallback(async () => {
    if (!user?.id) return;

    setLoadingTrips(true);
    try {
      const { data, error } = await supabase.rpc('get_user_trips', { user_uuid: user.id });
      if (error) throw error;

      // Форматируем данные, добавляя trip_participants
      const formattedTrips = (data || []).map((trip) => ({
        ...trip,
        trip_participants: trip.participant_status
          ? [{ status: trip.participant_status, user_id: trip.participant_user_id }]
          : [],
      }));

      setTripList(formattedTrips || []);
    } catch (error) {
      console.error('Ошибка загрузки поездок:', error);
      setTripList([]);
    } finally {
      setLoadingTrips(false);
    }
  }, [user?.id]);

  // Загрузка поездок при монтировании
  useEffect(() => {
    fetchTrips();
  }, [fetchTrips]);

  // Подписка на событие обновления поездок
  useEffect(() => {
    const handleTripUpdate = () => fetchTrips();
    window.addEventListener('tripUpdated', handleTripUpdate);
    return () => window.removeEventListener('tripUpdated', handleTripUpdate);
  }, [fetchTrips]);

  // Проверка участия пользователя (как в PC)
  const isMyTrip = (trip) =>
    trip.creator_id === user.id ||
    (trip.trip_participants?.some((p) => p.user_id === user.id && p.status !== 'rejected') ?? false);

  // Нормализация статусов (как в PC)
  const isUpcomingStatus = (status) => {
    const s = (status || '').toLowerCase();
    return s === 'active' || s === 'active_checkin' || s === 'canceling';
  };

  // ✅ finished считается активным (как в PC)
  const isActiveStatus = (status) => {
    const s = (status || '').toLowerCase();
    return s === 'started' || s === 'finished';
  };

  // ✅ finished убран из архива (как в PC)
  const isArchiveStatus = (status) => {
    const s = (status || '').toLowerCase();
    return s === 'canceled' || s === 'archived';
  };

  const handleRepeatTrip = (event, trip) => {
    event.stopPropagation();

    const imageUrls = Array.isArray(trip?.image_urls)
      ? trip.image_urls.filter(Boolean)
      : [];

    const repeatPayload = {
      title: trip?.title || '',
      description: trip?.description || '',
      price: trip?.price ?? '',
      difficulty: trip?.difficulty || 'easy',
      ageFrom: trip?.age_from ?? 18,
      ageTo: trip?.age_to ?? 60,
      participants: trip?.participants ?? 1,
      leisureType: trip?.leisure_type || 'tourism',
      alcoholAllowed: Boolean(trip?.alcohol_allowed),
      fromLocation: trip?.from_location || null,
      toLocation: trip?.to_location || null,
      fromAddress: trip?.from_address || '',
      toAddress: trip?.to_address || '',
      imageUrls,
    };

    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('repeatTripDraft', JSON.stringify(repeatPayload));
    }

    router.push({ pathname: '/dashboard', query: { section: 'create-trip', repeat: '1' } }, undefined, { shallow: true });
  };

  return (
    <div className={mobileStyles.fullPage}>
      <div className={mobileStyles.tabs}>
        <button
          className={activeTab === 'upcoming' ? mobileStyles.activeTab : mobileStyles.tab}
          onClick={() => setActiveTab('upcoming')}
        >
          Предстоящие
        </button>
        <button
          className={activeTab === 'active' ? mobileStyles.activeTab : mobileStyles.tab}
          onClick={() => setActiveTab('active')}
        >
          Активные
        </button>
        <button
          className={activeTab === 'archive' ? mobileStyles.activeTab : mobileStyles.tab}
          onClick={() => setActiveTab('archive')}
        >
          Архив
        </button>
      </div>

      {loadingTrips ? (
        <div className={mobileStyles.tripGrid}>
          <p style={{ opacity: 0.7 }}>Загрузка поездок…</p>
        </div>
      ) : (
        <>
          {activeTab === 'upcoming' && (
            <div className={mobileStyles.tripGrid}>
              {tripList
                .filter((trip) => isMyTrip(trip) && isUpcomingStatus(trip.status))
                .map((trip) => (
                  <div
                    key={trip.id}
                    className={mobileStyles.tripCard}
                    onClick={() => onTripClick(trip.id)}
                  >
                    <div className={mobileStyles.tripImageContainer}>
                      <img
  src={pickTripCoverUrl(trip)}
  alt={trip.title}
  className={mobileStyles.tripImage}
  loading="lazy"
  onError={(e) => {
    if (e.currentTarget.dataset.fallback === "1") return;
    e.currentTarget.dataset.fallback = "1";
    e.currentTarget.src = DEFAULT_TRIP_IMG_MB;
  }}
/>

                      <span className={mobileStyles.tripRole}>
                        {trip.creator_id === user.id ? 'Как организатор' : 'Участник'}
                      </span>
                    </div>

                    <div className={mobileStyles.tripInfo}>
                      <h3 title={trip.title}>
                        {trip.title.length > 20 ? trip.title.slice(0, 17) + '...' : trip.title}
                      </h3>
                      <p>Начало: {new Date(trip.date).toLocaleDateString('ru')}</p>
                      <p>Конец: {new Date(trip.arrival_date).toLocaleDateString('ru')}</p>
                      <p>Цена: {trip.price} ₽</p>

                      {(trip.status || '').toLowerCase() === 'active_checkin' && (
                        <p style={{ opacity: 0.8 }}>Статус: Подтверждение присутствия</p>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}

          {activeTab === 'active' && (
            <div className={mobileStyles.tripGrid}>
              {tripList
                .filter((trip) => isMyTrip(trip) && isActiveStatus(trip.status))
                .map((trip) => (
                  <div
                    key={trip.id}
                    className={mobileStyles.tripCard}
                    onClick={() => onTripClick(trip.id)}
                  >
                    <div className={mobileStyles.tripImageContainer}>
                      <img
  src={pickTripCoverUrl(trip)}
  alt={trip.title}
  className={mobileStyles.tripImage}
  loading="lazy"
  onError={(e) => {
    if (e.currentTarget.dataset.fallback === "1") return;
    e.currentTarget.dataset.fallback = "1";
    e.currentTarget.src = DEFAULT_TRIP_IMG_MB;
  }}
/>

                      <span className={mobileStyles.tripRole}>
                        {trip.creator_id === user.id ? 'Как организатор' : 'Участник'}
                      </span>
                    </div>

                    <div className={mobileStyles.tripInfo}>
                      <h3 title={trip.title}>
                        {trip.title.length > 20 ? trip.title.slice(0, 17) + '...' : trip.title}
                      </h3>
                      <p>Начало: {new Date(trip.date).toLocaleDateString('ru')}</p>
                      <p>Конец: {new Date(trip.arrival_date).toLocaleDateString('ru')}</p>
                      <p>Цена: {trip.price} ₽</p>

                      {(trip.status || '').toLowerCase() === 'finished' && (
                        <p style={{ opacity: 0.8 }}>Статус: Завершена</p>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}

          {activeTab === 'archive' && (
            <div className={mobileStyles.tripGrid}>
              {tripList
                .filter((trip) => isMyTrip(trip) && isArchiveStatus(trip.status))
                .map((trip) => (
                  <div
                    key={trip.id}
                    className={mobileStyles.tripCard}
                    onClick={() => onTripClick(trip.id)}
                  >
                    <div className={mobileStyles.tripImageContainer}>
                      <img
  src={pickTripCoverUrl(trip)}
  alt={trip.title}
  className={mobileStyles.tripImage}
  loading="lazy"
  onError={(e) => {
    if (e.currentTarget.dataset.fallback === "1") return;
    e.currentTarget.dataset.fallback = "1";
    e.currentTarget.src = DEFAULT_TRIP_IMG_MB;
  }}
/>

                      <span className={mobileStyles.tripRole}>
                        {trip.creator_id === user.id ? 'Как организатор' : 'Участник'}
                      </span>
                    </div>

                    <div className={mobileStyles.tripInfo}>
                      <h3 title={trip.title}>
                        {trip.title.length > 20 ? trip.title.slice(0, 17) + '...' : trip.title}
                      </h3>
                      <p>Начало: {new Date(trip.date).toLocaleDateString('ru')}</p>
                      <p>Конец: {new Date(trip.arrival_date).toLocaleDateString('ru')}</p>
                      <p>Цена: {trip.price} ₽</p>
                      <button
                        type="button"
                        className={mobileStyles.repeatTripButton}
                        onClick={(event) => handleRepeatTrip(event, trip)}
                      >
                        Повторить
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default MyTripsSectionMobile;
