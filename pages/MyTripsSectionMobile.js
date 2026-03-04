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

  const handleRepeatTrip = async (event, trip) => {
    event.stopPropagation();

    let tripForRepeat = trip;
    if (trip?.id) {
      try {
        const { data: geoRows } = await supabase.rpc('get_trip_details_geojson', {
          trip_id: trip.id,
        });

        const fullTrip = Array.isArray(geoRows) ? geoRows[0] : geoRows;

        if (fullTrip) {
          tripForRepeat = { ...trip, ...fullTrip };
          console.log('[repeatTrip][mobile] rpc geo loaded', {
            tripId: trip.id,
            from_location_type: typeof fullTrip?.from_location,
            to_location_type: typeof fullTrip?.to_location,
            from_address: fullTrip?.from_address || '',
            to_address: fullTrip?.to_address || '',
          });
        } else {
          console.warn('[repeatTrip][mobile] rpc returned empty payload', { tripId: trip.id });
        }
      } catch (error) {
        console.error('Ошибка загрузки геоданных поездки для повтора:', error);
      }
    }

    const imageUrls = Array.isArray(tripForRepeat?.image_urls)
      ? tripForRepeat.image_urls.filter(Boolean)
      : [];

    const repeatPayload = {
      title: tripForRepeat?.title || '',
      description: tripForRepeat?.description || '',
      price: tripForRepeat?.price ?? '',
      difficulty: tripForRepeat?.difficulty || 'easy',
      ageFrom: tripForRepeat?.age_from ?? 18,
      ageTo: tripForRepeat?.age_to ?? 60,
      participants: tripForRepeat?.participants ?? 1,
      leisureType: tripForRepeat?.leisure_type || 'tourism',
      alcoholAllowed: Boolean(tripForRepeat?.alcohol_allowed),
      fromLocation: tripForRepeat?.from_location || null,
      toLocation: tripForRepeat?.to_location || null,
      fromAddress: tripForRepeat?.from_address || '',
      toAddress: tripForRepeat?.to_address || '',
      imageUrls,
    };

    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('repeatTripDraft', JSON.stringify(repeatPayload));
      console.log('[repeatTrip][mobile] draft saved', {
        tripId: trip?.id,
        hasFromLocation: Boolean(repeatPayload.fromLocation),
        hasToLocation: Boolean(repeatPayload.toLocation),
        fromAddress: repeatPayload.fromAddress,
        toAddress: repeatPayload.toAddress,
      });
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
