import { useState, useEffect, useCallback } from 'react';
import pcStyles from '../styles/dashboard.pc.module.css';
import { supabase } from '../lib/supabaseClient';

const DEFAULT_TRIP_IMG_PC = "/def/fotoPC.jpg";

function pickTripCoverUrl(trip) {
  // trip.image_urls может быть массивом или строкой JSON (на всякий случай)
  let urls = trip?.image_urls;

  if (typeof urls === "string") {
    try {
      urls = JSON.parse(urls);
    } catch (_) {
      urls = null;
    }
  }

  const first = Array.isArray(urls) ? urls[0] : null;
  return first || DEFAULT_TRIP_IMG_PC;
}


const MyTripsSection = ({ trips: _trips, user, onTripClick }) => {
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

  useEffect(() => {
    fetchTrips();
  }, [fetchTrips]);

  useEffect(() => {
    const handleTripUpdate = () => fetchTrips();
    window.addEventListener('tripUpdated', handleTripUpdate);
    return () => window.removeEventListener('tripUpdated', handleTripUpdate);
  }, [fetchTrips]);

  // Проверка участия пользователя
  const isMyTrip = (trip) =>
    trip.creator_id === user.id ||
    (trip.trip_participants?.some((p) => p.user_id === user.id && p.status !== 'rejected') ?? false);

  // Нормализация статусов
  const isUpcomingStatus = (status) => {
    const s = (status || '').toLowerCase();
    return s === 'active' || s === 'active_checkin' || s === 'canceling';
  };

  // ✅ Добавлено: теперь "finished" считается активным
  const isActiveStatus = (status) => {
    const s = (status || '').toLowerCase();
    return s === 'started' || s === 'finished';
  };

  // ✅ Убрали finished из архива
  const isArchiveStatus = (status) => {
    const s = (status || '').toLowerCase();
    return s === 'canceled' || s === 'archived';
  };

  return (
    <div className={pcStyles.sectionContent}>
      <div className={pcStyles.tabs}>
        <button
          className={activeTab === 'upcoming' ? pcStyles.activeTab : pcStyles.tab}
          onClick={() => setActiveTab('upcoming')}
        >
          Предстоящие
        </button>
        <button
          className={activeTab === 'active' ? pcStyles.activeTab : pcStyles.tab}
          onClick={() => setActiveTab('active')}
        >
          Активные
        </button>
        <button
          className={activeTab === 'archive' ? pcStyles.activeTab : pcStyles.tab}
          onClick={() => setActiveTab('archive')}
        >
          Архив
        </button>
      </div>

      {loadingTrips ? (
        <div className={pcStyles.tripGrid}>
          <p style={{ opacity: 0.7 }}>Загрузка поездок…</p>
        </div>
      ) : (
        <>
          {activeTab === 'upcoming' && (
            <div className={pcStyles.tripGrid}>
              {tripList
                .filter((trip) => isMyTrip(trip) && isUpcomingStatus(trip.status))
                .map((trip) => (
                  <div
                    key={trip.id}
                    className={pcStyles.tripCard}
                    onClick={() => onTripClick(trip.id)}
                  >
                    <div className={pcStyles.tripImageContainer}>
                     <img
  src={pickTripCoverUrl(trip)}
  alt={trip.title}
  className={pcStyles.tripImage}
  loading="lazy"
  onError={(e) => {
    // чтобы не зациклить onError
    if (e.currentTarget.dataset.fallback === "1") return;
    e.currentTarget.dataset.fallback = "1";
    e.currentTarget.src = DEFAULT_TRIP_IMG_PC;
  }}
/>

                      <span className={pcStyles.tripRole}>
                        {trip.creator_id === user.id ? 'Как организатор' : 'Участник'}
                      </span>
                    </div>
                    <div className={pcStyles.tripInfo}>
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
            <div className={pcStyles.tripGrid}>
              {tripList
                .filter((trip) => isMyTrip(trip) && isActiveStatus(trip.status))
                .map((trip) => (
                  <div
                    key={trip.id}
                    className={pcStyles.tripCard}
                    onClick={() => onTripClick(trip.id)}
                  >
                    <div className={pcStyles.tripImageContainer}>
                      <img
  src={pickTripCoverUrl(trip)}
  alt={trip.title}
  className={pcStyles.tripImage}
  loading="lazy"
  onError={(e) => {
    // чтобы не зациклить onError
    if (e.currentTarget.dataset.fallback === "1") return;
    e.currentTarget.dataset.fallback = "1";
    e.currentTarget.src = DEFAULT_TRIP_IMG_PC;
  }}
/>

                      <span className={pcStyles.tripRole}>
                        {trip.creator_id === user.id ? 'Как организатор' : 'Участник'}
                      </span>
                    </div>
                    <div className={pcStyles.tripInfo}>
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
            <div className={pcStyles.tripGrid}>
              {tripList
                .filter((trip) => isMyTrip(trip) && isArchiveStatus(trip.status))
                .map((trip) => (
                  <div
                    key={trip.id}
                    className={pcStyles.tripCard}
                    onClick={() => onTripClick(trip.id)}
                  >
                    <div className={pcStyles.tripImageContainer}>
                      <img
  src={pickTripCoverUrl(trip)}
  alt={trip.title}
  className={pcStyles.tripImage}
  loading="lazy"
  onError={(e) => {
    // чтобы не зациклить onError
    if (e.currentTarget.dataset.fallback === "1") return;
    e.currentTarget.dataset.fallback = "1";
    e.currentTarget.src = DEFAULT_TRIP_IMG_PC;
  }}
/>

                      <span className={pcStyles.tripRole}>
                        {trip.creator_id === user.id ? 'Как организатор' : 'Участник'}
                      </span>
                    </div>
                    <div className={pcStyles.tripInfo}>
                      <h3 title={trip.title}>
                        {trip.title.length > 20 ? trip.title.slice(0, 17) + '...' : trip.title}
                      </h3>
                      <p>Начало: {new Date(trip.date).toLocaleDateString('ru')}</p>
                      <p>Конец: {new Date(trip.arrival_date).toLocaleDateString('ru')}</p>
                      <p>Цена: {trip.price} ₽</p>
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

export default MyTripsSection;
