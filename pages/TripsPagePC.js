import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '../lib/supabaseClient';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import FiltersPC from '../components/FiltersPC';
import { notifications, useAuth } from './_app';
import pcStyles from '../styles/trips.pc.module.css';

const YMaps = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.YMaps), { ssr: false });
const Map = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Map), { ssr: false });
const Placemark = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Placemark), { ssr: false });
const Clusterer = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Clusterer), { ssr: false });

// Фолбэк-картинка для поездок без фото (ПК)
const DEFAULT_TRIP_IMAGE = '/def/fotoPC.jpg';

// ✅ Якорь маркера в "кончик снизу по центру"
// Координата метки = нижний центр картинки (tip of marker)
const TRIP_MARKER_SIZE = [33, 50];
const TRIP_MARKER_OFFSET = [
  -Math.round(TRIP_MARKER_SIZE[0] / 2),
  -TRIP_MARKER_SIZE[1],
];

// Если /placemark.png такого же размера — можно использовать те же
const USER_MARKER_SIZE = [33, 50];
const USER_MARKER_OFFSET = [
  -Math.round(USER_MARKER_SIZE[0] / 2),
  -USER_MARKER_SIZE[1],
];


function MsgIconWithCount({ count = 0 }) {
  const n = Number(count || 0);
  const label = n > 99 ? '99+' : String(n);

  return (
    <svg
      style={{ width: '100%', height: '100%', display: 'block', transform: 'scale(1.7)' }}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M21 12c0 4.418-4.03 8-9 8a10.6 10.6 0 0 1-3.61-.62L3 21l1.78-4.12A7.62 7.62 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z"
        fill={n > 0 ? '#ef4444' : 'none'}
        stroke={n > 0 ? '#ef4444' : '#9ca3af'}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {n > 0 ? (
        <text
          x="11.5"
          y="13"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={label.length >= 3 ? '7' : '9'}
          fontWeight="700"
          fill="#ffffff"
        >
          {label}
        </text>
      ) : null}
    </svg>
  );
}

function normalizeImageUrls(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    const s = value.trim();
    // JSON-массив строк
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
      } catch {}
    }
    // одиночная ссылка строкой
    if (s) return [s];
  }
  return [];
}

function getTripCoverUrl(trip) {
  const urls = normalizeImageUrls(trip?.image_urls);
  return urls[0] || DEFAULT_TRIP_IMAGE;
}

export default function TripsPagePC({ user, geolocation }) {
  const { setProcessing } = useAuth();
  const router = useRouter();
  const [trips, setTrips] = useState([]);
  const [filteredTrips, setFilteredTrips] = useState([]);
  const [mapBounds, setMapBounds] = useState(null);
  const [userMarker, setUserMarker] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const mapRef = useRef(null);
  const [initialMapCenter] = useState([55.751244, 37.618423]);
  const [currentMapCenter, setCurrentMapCenter] = useState(() => {
    const savedCenter = localStorage.getItem('mapCenter');
    return savedCenter ? JSON.parse(savedCenter) : initialMapCenter;
  });
  const [currentZoom, setCurrentZoom] = useState(() => {
    const savedZoom = localStorage.getItem('mapZoom');
    return savedZoom ? parseInt(savedZoom) : 6;
  });
  const [mapLoaded, setMapLoaded] = useState(false);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [infoMenuOpen, setInfoMenuOpen] = useState(false);
  const [infoSection, setInfoSection] = useState(null);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const infoButtonRef = useRef(null);
  const tripsListRef = useRef(null);

  // SPEED: защита от повторной загрузки
  const fetchInFlightRef = useRef(false);

  // Realtime (обновление trips/participants на карте и в списке)
  const tripsRtChannelRef = useRef(null);
  const tripsRtDebounceRef = useRef(null);
  const fetchTripsRef = useRef(null);

  // refs для логов/актуальных значений (как в mobile)
  const mapLoadedRef = useRef(false);
  const mapBoundsRef = useRef(null);
  const filtersRef = useRef(null);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const twoWeeksLater = new Date(today);
  twoWeeksLater.setDate(today.getDate() + 14);
  twoWeeksLater.setHours(23, 59, 59, 999);

  const [filters, setFilters] = useState({
    priceFrom: '',
    priceTo: '',
    leisureType: '',
    difficulty: '',
    age: '',
    dateFrom: today,
    dateTo: twoWeeksLater,
  });
  const [message, setMessage] = useState('');

  // поддерживаем "живые" значения в ref (нужно для realtime/кликов вне)
  useEffect(() => { mapLoadedRef.current = mapLoaded; }, [mapLoaded]);
  useEffect(() => { mapBoundsRef.current = mapBounds; }, [mapBounds]);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  const leisureTypeLabels = {
    tourism: 'Туризм',
    fishing: 'Рыбалка',
    hunting: 'Охота',
  };

  const difficultyLabels = {
    easy: 'Легко',
    medium: 'Средне',
    hard: 'Сложно',
  };

  useEffect(() => {
    const handleBeforeUnload = () => {
      localStorage.removeItem('mapCenter');
      localStorage.removeItem('mapZoom');
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    console.time('mapCenterSetup');
    const savedCenter = localStorage.getItem('mapCenter');
    const savedZoom = localStorage.getItem('mapZoom');

    // 1) Если уже есть сохранённый центр — ВСЕГДА используем его.
    if (savedCenter && savedZoom) {
      const center = JSON.parse(savedCenter);
      const zoom = parseInt(savedZoom, 10);
      setCurrentMapCenter(center);
      setCurrentZoom(zoom);
      console.log('[mapCenterSetup] Using saved map center and zoom:', { center, zoom });
      console.timeEnd('mapCenterSetup');
      return;
    }

    // 2) Если сохранённого центра нет, но есть геолокация из _app — центрируем по ней
    if (geolocation) {
      const newCenter = [geolocation.lat, geolocation.lon];
      setCurrentMapCenter(newCenter);
      setCurrentZoom(6);
      localStorage.setItem('mapCenter', JSON.stringify(newCenter));
      localStorage.setItem('mapZoom', '6');

      if (mapRef.current) {
        mapRef.current.setCenter(newCenter, 6);
        setMapBounds(mapRef.current.getBounds());
        if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filtersRef.current || filters);
      }
      console.log('[mapCenterSetup] Set map center from geolocation:', newCenter);
    } else {
      // 3) Ни сохранённого центра, ни гео — идём в профиль/дефолт
      setMapCenterFromProfile();
    }

    console.timeEnd('mapCenterSetup');
  }, [user, geolocation]); // зависимости можно оставить как у тебя

  useEffect(() => {
    console.time('unreadMessagesSetup');
    const updateUnread = () => {
      const totalUnread = notifications.getTotalUnread();
      setUnreadMessages(totalUnread);
      console.log('[unreadMessagesSetup] Updated unread messages:', totalUnread);
    };
    notifications.addListener(updateUnread);
    console.timeEnd('unreadMessagesSetup');
    return () => notifications.removeListener(updateUnread);
  }, []);

  useEffect(() => {
    fetchTrips();
  }, [user]);

  useEffect(() => {
    if (tripsLoaded && mapLoaded && mapRef.current) {
      const bounds = mapRef.current.getBounds();
      setMapBounds(bounds);
      applyFiltersWithBounds(trips, bounds, filtersRef.current || filters);
      console.log('[applyFiltersOnLoad] Applied filters with bounds:', bounds);
    }
  }, [tripsLoaded, mapLoaded]);

  async function fetchTrips(opts = {}) {
    // SPEED: защита от повторного вызова
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;

    const { silent = false, reason } = opts || {};
    if (reason) console.log('[fetchTrips] reason:', reason);

    console.time('fetchTrips');
    if (!silent) setProcessing(true);
    try {
      console.log('[fetchTrips] Fetching active trips via RPC');
      const { data, error } = await supabase.rpc('get_active_trips_geojson');
      if (error) {
        console.error('[fetchTrips] Error fetching trips:', error.message);
        if (!silent) setMessage('Ошибка загрузки поездок');
        setTripsLoaded(true);
        setMapLoaded(true);
        return;
      }

      if (!data || data.length === 0) {
        if (!silent) setMessage('Нет активных поездок');
        setTripsLoaded(true);
        setMapLoaded(true);
        console.log('[fetchTrips] No active trips found');
      } else {
        console.log('[fetchTrips] Retrieved trips:', data.length);
        const activeTrips = await Promise.all(data.map(async (trip) => {
          console.time(`fetchParticipants_${trip.id}`);

          // считаем ТОЛЬКО статусы, которые занимают место
          // (требование: paid + waiting)
          const { count, error: countError } = await supabase
            .from('trip_participants')
            // head:true => не тянем строки, только COUNT
            .select('*', { count: 'exact', head: true })
            .eq('trip_id', trip.id)
            .in('status', ['paid', 'waiting']);

          if (countError) {
            console.error(`[fetchParticipants_${trip.id}] Count error:`, countError);
            console.timeEnd(`fetchParticipants_${trip.id}`);
            return null; // или можешь вернуть trip, если хочешь не падать из-за счётчика
          }

          console.timeEnd(`fetchParticipants_${trip.id}`);
          console.log(`[fetchParticipants_${trip.id}] Participants (paid|waiting) count:`, count);

          // показываем поездку на карте, если есть свободные места
          return count < (trip.participants || 8) ? trip : null;
        })).then(results => results.filter(Boolean));

        setTrips(activeTrips);
        setTripsLoaded(true);

        // ✅ Сразу пересчитываем filteredTrips по текущим фильтрам, без ожидания движения карты
        try {
          const b = mapRef.current?.getBounds?.() || mapBoundsRef.current;
          if (b) {
            applyFiltersWithBounds(activeTrips, b, filtersRef.current || filters);
          } else {
            setFilteredTrips(activeTrips);
          }
        } catch {}

        console.log('[fetchTrips] Active trips loaded:', activeTrips.length);
      }
    } catch (err) {
      console.error('[fetchTrips] Exception:', err.message);
      if (!silent) setMessage('Ошибка загрузки поездок');
      setTripsLoaded(true);
      setMapLoaded(true);
    } finally {
      if (!silent) setProcessing(false);
      console.timeEnd('fetchTrips');
      fetchInFlightRef.current = false;
    }
  }

  // держим актуальную ссылку на fetchTrips (нужно для realtime)
  fetchTripsRef.current = fetchTrips;

  // ✅ Realtime-синхронизация trips + trip_participants (как в mobile)
  useEffect(() => {
    // чистим прошлый канал (на всякий)
    if (tripsRtChannelRef.current) {
      try { supabase.removeChannel(tripsRtChannelRef.current); } catch {}
      tripsRtChannelRef.current = null;
    }

    const scheduleRefresh = (reason) => {
      if (tripsRtDebounceRef.current) clearTimeout(tripsRtDebounceRef.current);

      tripsRtDebounceRef.current = setTimeout(() => {
        console.log('[rt:pc] refresh', {
          mapLoaded: mapLoadedRef.current,
          bounds: mapRef.current?.getBounds?.() || mapBoundsRef.current,
          filters: filtersRef.current,
          reason,
        });
        fetchTripsRef.current?.({ silent: true, reason });
      }, 450);
    };

    const ch = supabase
      .channel('trips_map_live_pc')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trips' }, (payload) => {
        const newTrip = payload?.new;
        // если прилетела активная — точно обновим; иначе тоже обновим (на случай смены статуса логикой)
        if (!newTrip || newTrip.status === 'active') scheduleRefresh('trips_insert');
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips' }, () => scheduleRefresh('trips_update'))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'trips' }, () => scheduleRefresh('trips_delete'))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_participants' }, () => scheduleRefresh('tp_insert'))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trip_participants' }, () => scheduleRefresh('tp_update'))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'trip_participants' }, () => scheduleRefresh('tp_delete'))
      .subscribe((status) => console.log('[rt:pc] channel status:', status));

    tripsRtChannelRef.current = ch;

    return () => {
      try {
        if (tripsRtDebounceRef.current) clearTimeout(tripsRtDebounceRef.current);
        tripsRtDebounceRef.current = null;
      } catch {}
      try { supabase.removeChannel(ch); } catch {}
      tripsRtChannelRef.current = null;
    };
  }, []);

  async function setMapCenterFromProfile() {
    console.time('setMapCenterFromProfile');
    if (user) {
      setProcessing(true);
      try {
        const { data } = await supabase.from('profiles').select('geo_lat, geo_lon').eq('user_id', user.id).single();
        const coords = data?.geo_lat && data?.geo_lon
          ? [parseFloat(data.geo_lat), parseFloat(data.geo_lon)]
          : initialMapCenter;
        setCurrentMapCenter(coords);
        localStorage.setItem('mapCenter', JSON.stringify(coords));
        if (mapRef.current) {
          mapRef.current.setCenter(coords, 6);
          setMapBounds(mapRef.current.getBounds());
          if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filtersRef.current || filters);
        }
        console.log('[setMapCenterFromProfile] Set map center from profile:', coords);
      } catch (err) {
        console.error('[setMapCenterFromProfile] Error:', err.message);
        setCurrentMapCenter(initialMapCenter);
      } finally {
        setProcessing(false);
        console.timeEnd('setMapCenterFromProfile');
      }
    } else {
      setCurrentMapCenter(initialMapCenter);
      localStorage.setItem('mapCenter', JSON.stringify(initialMapCenter));
      if (mapRef.current) {
        mapRef.current.setCenter(initialMapCenter, 10);
        setMapBounds(mapRef.current.getBounds());
        if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filtersRef.current || filters);
      }
      console.log('[setMapCenterFromProfile] Set default map center:', initialMapCenter);
      console.timeEnd('setMapCenterFromProfile');
    }
  }

  function applyFiltersWithBounds(tripsData, bounds, filtersArg) {
    const f = filtersArg || filtersRef.current || filters;
    const mapOk = mapLoadedRef.current || mapLoaded;
    if (!tripsData?.length || !mapOk || !bounds) return;

    console.time('applyFiltersWithBounds');

    // Нормализуем даты фильтра (включительно)
    const filterDateFrom = f?.dateFrom ? new Date(f.dateFrom) : new Date(today);
    filterDateFrom.setHours(0, 0, 0, 0);

    const filterDateTo = f?.dateTo ? new Date(f.dateTo) : new Date(twoWeeksLater);
    filterDateTo.setHours(23, 59, 59, 999);

    let result = tripsData.filter((trip) => {
      const price = Number.parseInt(trip?.price, 10);
      const ageFrom = Number.parseInt(trip?.age_from, 10);
      const ageTo = Number.parseInt(trip?.age_to, 10);

      const tripDate = new Date(trip?.date);
      const tripArrival = new Date(trip?.arrival_date || trip?.date);

      const passesFilters = (
        (!f?.priceFrom || price >= Number(f.priceFrom)) &&
        (!f?.priceTo || price <= Number(f.priceTo)) &&
        (!f?.leisureType || trip?.leisure_type === f.leisureType) &&
        (!f?.difficulty || trip?.difficulty === f.difficulty) &&
        (!f?.age || (Number(f.age) >= ageFrom && Number(f.age) <= ageTo)) &&
        (!filterDateTo || (tripDate >= filterDateFrom && tripArrival <= filterDateTo))
      );

      return passesFilters;
    });

    // Ограничиваем по видимой области карты
    result = result.filter((trip) => {
      try {
        const geoJson = typeof trip?.to_location === 'string' ? JSON.parse(trip.to_location) : trip?.to_location;
        const coords = geoJson?.coordinates ? [geoJson.coordinates[1], geoJson.coordinates[0]] : null;
        return coords && isWithinBounds(coords, bounds);
      } catch {
        return false;
      }
    });

    setFilteredTrips(result);
    console.log('[applyFiltersWithBounds] Filtered trips:', result.length);
    console.timeEnd('applyFiltersWithBounds');
  }

  function isWithinBounds(coords, bounds) {
    const [[minLat, minLon], [maxLat, maxLon]] = bounds;
    return coords[0] >= minLat && coords[0] <= maxLat && coords[1] >= minLon && coords[1] <= maxLon;
  }

  const handleMapChange = (e) => {
    console.time('handleMapChange');
    const newBounds = e.get('newBounds');
    setMapBounds(newBounds);
    if (tripsLoaded) applyFiltersWithBounds(trips, newBounds, filtersRef.current || filters);
    if (mapRef.current) {
      const newCenter = mapRef.current.getCenter();
      const newZoom = mapRef.current.getZoom();
      setCurrentMapCenter(newCenter);
      setCurrentZoom(newZoom);
      localStorage.setItem('mapCenter', JSON.stringify(newCenter));
      localStorage.setItem('mapZoom', newZoom.toString());
      console.log('[handleMapChange] Updated map center and zoom:', { center: newCenter, zoom: newZoom });
    }
    setContextMenu(null);
    setUserMarker(null);
    console.timeEnd('handleMapChange');
  };

  const handleMapClick = () => {
    setUserMarker(null);
    setContextMenu(null);
    console.log('[handleMapClick] Map clicked, cleared markers and menu');
  };

  const handleMapContextMenu = (e) => {
    const coords = e.get('coords');
    const pagePixels = e.get('pagePixels');
    setUserMarker(coords);
    setContextMenu({
      x: pagePixels[0],
      y: pagePixels[1],
      lat: coords[0],
      lon: coords[1],
    });
    console.log('[handleMapContextMenu] Context menu opened at:', coords);
  };

  const handleContextMenuAction = (answer) => {
    console.log('[handleContextMenuAction] Action:', answer);
    if (answer === 'yes' && user) {
      const toLocation = JSON.stringify({
        type: 'Point',
        coordinates: [contextMenu.lat, contextMenu.lon]
      });
      window.open(`/dashboard?section=create-trip&to_location=${encodeURIComponent(toLocation)}`, '_blank');
    } else if (answer === 'yes') {
      setMessage('Нужно авторизоваться');
      setTimeout(() => setMessage(''), 4000);
    }
    setContextMenu(null);
    setUserMarker(null);
  };

  const handleTripClick = (tripId) => {
    console.log('[handleTripClick] Trip clicked:', tripId);
    window.open(`/trip/${tripId}`, '_blank');
  };

  const handlePlacemarkClick = (tripId) => {
    console.log('[handlePlacemarkClick] Placemark clicked:', tripId);
    setSelectedTripId(tripId === selectedTripId ? null : tripId);
  };

  const handleMapLoad = () => {
    console.time('handleMapLoad');
    setMapLoaded(true);
    if (mapRef.current) {
      setMapBounds(mapRef.current.getBounds());
      if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filtersRef.current || filters);
    }
    console.log('[handleMapLoad] Map loaded');
    console.timeEnd('handleMapLoad');
  };

  const toggleInfoMenu = () => {
    // ✅ при открытии меню “Информация” всегда закрываем открытую карточку (Контакты/Документы)
    setInfoSection(null);
    setInfoMenuOpen((v) => !v);
  };

  const handleInfoSection = (section) => {
    console.log('[handleInfoSection] Section selected:', section);
    // Закрываем дропдаун, чтобы не было ощущения "двух модалок"
    setInfoMenuOpen(false);
    // Тогглим карточку: повторный клик по тому же пункту закрывает
    setInfoSection((prev) => (prev === section ? null : section));
  };

  // Закрываем выпадающее меню "Информация" при клике вне блока (как в mobile)
  useEffect(() => {
    if (!infoMenuOpen && !infoSection) return;

    const onPointerDown = (e) => {
      const wrapper = infoButtonRef.current;
      if (!wrapper) return;

      const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
      const inside = path.includes(wrapper) || wrapper.contains(e.target);

      if (!inside) {
        setInfoMenuOpen(false);
        setInfoSection(null);
      }
    };

    // capture=true — чтобы отлавливать раньше внутренних stopPropagation
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [infoMenuOpen, infoSection]);

  const downloadDocument = async (fileName) => {
    console.time('downloadDocument');
    setProcessing(true);
    try {
      const { data, error } = await supabase.storage.from('document').download(fileName);
      if (error) throw error;
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      console.log('[downloadDocument] Document downloaded:', fileName);
    } catch (error) {
      console.error('[downloadDocument] Error downloading document:', error.message);
      setMessage('Ошибка загрузки документа');
      setTimeout(() => setMessage(''), 4000);
    } finally {
      setProcessing(false);
      console.timeEnd('downloadDocument');
    }
  };

  const handleMessagesClick = () => {
    console.log('[handleMessagesClick] Navigating to messages');
    router.push('/dashboard?section=messages');
  };

  const applyFilter = (field, nextFilters) => {
    console.time('applyFilter');

    const f = nextFilters || filtersRef.current || filters;

    if (field === 'date') {
      if (!f?.dateFrom || !f?.dateTo) {
        console.timeEnd('applyFilter');
        return;
      }

      const df = new Date(f.dateFrom);
      df.setHours(0, 0, 0, 0);

      const dt = new Date(f.dateTo);
      dt.setHours(23, 59, 59, 999);

      // если дата по умолчанию — не дёргаем лишний раз
      if (df.getTime() === today.getTime() && dt.getTime() === twoWeeksLater.getTime()) {
        console.timeEnd('applyFilter');
        return;
      }
    }

    const currentBounds = mapRef.current?.getBounds?.() || mapBoundsRef.current;
    if (currentBounds) {
      applyFiltersWithBounds(trips, currentBounds, f);
    }

    console.timeEnd('applyFilter');
  };

  const removeFilter = (field) => {
    console.time('removeFilter');
    const newFilters = { ...filters };
    if (field === 'date') {
      newFilters.dateFrom = today;
      newFilters.dateTo = twoWeeksLater;
    } else if (field === 'price') {
      newFilters.priceFrom = '';
      newFilters.priceTo = '';
    } else {
      newFilters[field] = '';
    }
    setFilters(newFilters);
    if (mapRef.current) {
      const currentBounds = mapRef.current.getBounds();
      applyFiltersWithBounds(trips, currentBounds, newFilters);
    }
    console.timeEnd('removeFilter');
  };

  console.log('[TripsPagePC] Render states:', {
    tripsLoaded,
    mapLoaded,
    filteredTrips: filteredTrips.length,
    currentMapCenter,
    currentZoom,
    user: !!user,
    geolocation: geolocation,
  });

  return (
    <div className={pcStyles.container}>
      <header className={pcStyles.header}>
        <img src="/logo.png" alt="Onloc Logo" className={pcStyles.logo} />
        <div className={pcStyles.authButtons}>
          <div className={pcStyles.messagesWrapper}>
            <button
              type="button"
              className={pcStyles.messageIcon}
              onClick={handleMessagesClick}
              aria-label="Сообщения"
              title="Сообщения"
              style={{ border: "none" }}
            >
              <MsgIconWithCount count={unreadMessages} />
            </button>
          </div>
          <div className={pcStyles.infoWrapper} ref={infoButtonRef}>
            <button onClick={toggleInfoMenu} className={pcStyles.button}>
              Информация
            </button>
            {infoMenuOpen && (
              <div
                className={pcStyles.infoDropdown}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button onClick={() => handleInfoSection('contacts')} className={pcStyles.infoOption}>
                  Контакты
                </button>
                <button onClick={() => handleInfoSection('documents')} className={pcStyles.infoOption}>
                  Документы
                </button>
              </div>
            )}
            {infoSection === 'contacts' && (
              <div className={pcStyles.companyCard}>
                <h3>Карточка предприятия</h3>
              </div>
            )}
            {infoSection === 'documents' && (
              <div className={pcStyles.documentsCard}>
                <h3>Документы</h3>
                <button onClick={() => downloadDocument('tbank_contract.pdf')} className={pcStyles.documentLink}>
                  Договор Т-банк
                </button>
                <button onClick={() => downloadDocument('platform_contract.pdf')} className={pcStyles.documentLink}>
                  Договор Площадка
                </button>
              </div>
            )}
          </div>
          {user ? (
            <Link href={{ pathname: '/dashboard', query: { section: 'myTrips' } }} className={pcStyles.button}>
              Личный кабинет
            </Link>
          ) : (
            <Link href="/auth" className={pcStyles.button}>
              Авторизоваться
            </Link>
          )}
        </div>
      </header>

      <div className={pcStyles.main}>
        <div className={`${pcStyles.mapContainer} tripsMapContainer`}>
          <YMaps>
            <Map
              instanceRef={mapRef}
              state={{ center: currentMapCenter, zoom: currentZoom, controls: [] }}
              width="100%"
              height="100%"
              onBoundsChange={handleMapChange}
              onClick={handleMapClick}
              onContextmenu={handleMapContextMenu}
              onLoad={handleMapLoad}
              options={{
                suppressMapOpenBlock: true,
                suppressYandexSearch: true,
                suppressTraffic: true,
              }}
            >
              <Clusterer
                options={{
                  preset: 'islands#invertedVioletClusterIcons',
                  groupByCoordinates: false,
                }}
              >
                {filteredTrips.map(trip => {
                  const geoJson = typeof trip.to_location === 'string' ? JSON.parse(trip.to_location) : trip.to_location;
                  const coords = geoJson?.coordinates ? [geoJson.coordinates[1], geoJson.coordinates[0]] : null;
                  if (!coords) return null;
                  return (
                    <Placemark
                      key={trip.id}
                      geometry={coords}
                      properties={{
                        hintContent: trip.title,
                        balloonContent: `${trip.title}<br>${trip.description}<br>Цена: ${trip.price} ₽`
                      }}
                      options={{
                        iconLayout: 'default#image',
                        iconImageHref: selectedTripId === trip.id ? '/marker-icon.png' : '/custom-marker.png',
  iconImageSize: TRIP_MARKER_SIZE,
  iconImageOffset: TRIP_MARKER_OFFSET,
                      }}
                      onClick={() => handlePlacemarkClick(trip.id)}
                    />
                  );
                })}
                {userMarker && (
                  <Placemark
                    geometry={userMarker}
                    properties={{ hintContent: 'Новое место' }}
                    options={{
                      iconLayout: 'default#image',
                      iconImageHref: '/placemark.png',
  iconImageSize: TRIP_MARKER_SIZE,
  iconImageOffset: TRIP_MARKER_OFFSET,
                    }}
                  />
                )}
              </Clusterer>
            </Map>
          </YMaps>

          <FiltersPC
            filters={filters}
            setFilters={setFilters}
            applyFilter={applyFilter}
            removeFilter={removeFilter}
            leisureTypeLabels={leisureTypeLabels}
            difficultyLabels={difficultyLabels}
            today={today}
            twoWeeksLater={twoWeeksLater}
            setSelectedTripId={setSelectedTripId}
          />
        </div>

        <div className={pcStyles.tripsList} ref={tripsListRef}>
          {filteredTrips.length === 0 ? (
            <p className={pcStyles.noTrips}>Нет доступных поездок</p>
          ) : (
            filteredTrips.map(trip => {
              const startDateTime = new Date(trip.date);
              if (trip.time) {
                const [hours, minutes] = trip.time.split(':');
                startDateTime.setHours(parseInt(hours), parseInt(minutes));
              }

              const endDateTime = trip.arrival_date ? new Date(trip.arrival_date) : new Date(trip.date);
              if (trip.arrival_time) {
                const [hours, minutes] = trip.arrival_time.split(':');
                endDateTime.setHours(parseInt(hours), parseInt(minutes));
              }

              return (
                <Link
                  href={`/trip/${trip.id}`}
                  key={trip.id}
                  className={`${pcStyles.tripCard} ${selectedTripId === trip.id ? pcStyles.selectedTrip : ''}`}
                  onClick={(e) => {
                    e.preventDefault();
                    handleTripClick(trip.id);
                  }}
                >
                  <div className={pcStyles.imageContainer}>
                    <img
                      src={getTripCoverUrl(trip)}
                      alt="Trip"
                      className={pcStyles.tripImage}
                      onError={(e) => {
                        const el = e.currentTarget;
                        try {
                          if (el?.src && el.src.includes(DEFAULT_TRIP_IMAGE)) return;
                          el.src = DEFAULT_TRIP_IMAGE;
                        } catch {}
                      }}
                    />
                  </div>
                  <div className={pcStyles.tripInfo}>
                    <h3 title={trip.title}>
                      {trip.title?.length > 20 ? `${trip.title.slice(0, 17)}...` : trip.title}
                    </h3>
                    <p title={trip.description}>
                      {trip.description?.length > 60 ? `${trip.description.slice(0, 57)}...` : trip.description}
                    </p>
                    <div className={pcStyles.tripDetails}>
                      <span className={pcStyles.tripDate}>
                        {startDateTime.toLocaleString('ru', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className={pcStyles.tripDate}>
                        {endDateTime.toLocaleString('ru', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className={pcStyles.tripPrice}>{trip.price} ₽</span>
                    </div>
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </div>

      {message && <div className={pcStyles.toast}>{message}</div>}

      {contextMenu && (
        <div className={pcStyles.contextMenu} style={{ top: contextMenu.y + 25, left: contextMenu.x - 150 }}>
          <p>Создать поездку в эту локацию?</p>
          <div className={pcStyles.contextButtons}>
            <button onClick={() => handleContextMenuAction('yes')} className={pcStyles.contextButton}>Да</button>
            <button onClick={() => handleContextMenuAction('no')} className={pcStyles.contextButton}>Нет</button>
          </div>
        </div>
      )}

      <style jsx global>{`
        /* ===== Yandex Map: оставить только "Условия" и "Яндекс карты" ===== */
        .tripsMapContainer [class*="map-open-block"],
        .tripsMapContainer [class*="mapOpenBlock"] {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }

        /* промо/предложения Яндекса (часто показывает "В карты" или промо-ссылки) */
        .tripsMapContainer [class*="map-copyrights-promo"],
        .tripsMapContainer [class*="map-copyrights-feedback"] {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }

        /* на всякий случай убираем стандартные контролы (зум/гео и т.п.), если они всё же появляются */
        .tripsMapContainer [class*="ymaps-2-1-"][class*="controls__control"],
        .tripsMapContainer [class*="ymaps-2-1-"][class*="searchbox"],
        .tripsMapContainer [class*="ymaps-2-1-"][class*="traffic"],
        .tripsMapContainer [class*="ymaps-2-1-"][class*="route-panel"] {
          display: none !important;
        }
      `}</style>
    </div>
  );
}
