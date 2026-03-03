import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '../lib/supabaseClient';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import FiltersMobile from '../components/FiltersMobile';
import { notifications, useAuth } from './_app';
import mobileStyles from '../styles/trips.mobile.module.css';
import { useTripAlertsCount } from '../lib/useTripAlertsCount';
import AlertsBell from '../components/AlertsBell';

const YMaps = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.YMaps), { ssr: false });
const Map = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Map), { ssr: false });
const Placemark = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Placemark), { ssr: false });
const Clusterer = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Clusterer), { ssr: false });

// ✅ дефолтное фото для поездок без фото (лежит в public)
const DEFAULT_TRIP_IMAGE = "/def/fotoMB.jpg";

function truncateTitle(value, max = 21) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}


function MsgIconWithCount({ count = 0 }) {
  const n = Number(count || 0);
  const label = n > 99 ? "99+" : String(n);

  return (
    <svg className={mobileStyles.topNavIcon} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21 12c0 4.418-4.03 8-9 8a10.6 10.6 0 0 1-3.61-.62L3 21l1.78-4.12A7.62 7.62 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z"
        fill={n > 0 ? "#ef4444" : "none"}
        stroke={n > 0 ? "#ef4444" : "#9ca3af"}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {n > 0 ? (
        <text
          x="12"
          y="13"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={label.length >= 3 ? "7" : "9"}
          fontWeight="700"
          fill="#ffffff"
        >
          {label}
        </text>
      ) : null}
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg className={mobileStyles.topNavIcon} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 10.5v6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg className={mobileStyles.topNavIcon} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20 21a8 8 0 0 0-16 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg
      className={mobileStyles.topNavIcon}
      viewBox="3 7 18 10"
      aria-hidden="true"
      fill="none"
    >
      {/* кольцо */}
      <circle
        cx="8"
        cy="12"
        r="3"
        stroke="currentColor"
        strokeWidth="2"
      />

      {/* стержень ключа */}
      <path
        d="M11 12h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* зубцы */}
      <path
        d="M17 12v2M20 12v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}





function getTripCoverUrl(trip) {
  const v = trip?.image_urls;

  // если image_urls уже массив
  if (Array.isArray(v)) return v[0] || DEFAULT_TRIP_IMAGE;

  // если вдруг пришло строкой (иногда бывает JSON строка)
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return DEFAULT_TRIP_IMAGE;

    if (s.startsWith("[")) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr) && arr[0]) return arr[0];
      } catch {}
    }

    // если вдруг сразу url строкой
    if (s.startsWith("http") || s.startsWith("/")) return s;

    return DEFAULT_TRIP_IMAGE;
  }

  return DEFAULT_TRIP_IMAGE;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getSafeContextMenuPos(menu, menuW = 320, menuH = 160, pad = 12) {
  if (!menu || typeof window === "undefined") return { left: menu?.x ?? 0, top: menu?.y ?? 0 };

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // меню показываем над точкой: translate(-50%, -100%)
  const left = clamp(menu.x, pad + menuW / 2, vw - pad - menuW / 2);
  const top = clamp(menu.y, pad + menuH, vh - pad);

  return { left, top };
}


export default function TripsPageMobile({ user: propUser, geolocation: propGeolocation }) {
  const { setProcessing, user, loading, geolocation } = useAuth();
  const router = useRouter();

  const [trips, setTrips] = useState([]);
  const [filteredTrips, setFilteredTrips] = useState([]);

  const [mapBounds, setMapBounds] = useState(null);
  const [userMarker, setUserMarker] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  const mapRef = useRef(null);
  const [initialMapCenter] = useState([55.751244, 37.618423]);
  const [currentMapCenter, setCurrentMapCenter] = useState(initialMapCenter);
  const [currentZoom, setCurrentZoom] = useState(6);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [tripsLoaded, setTripsLoaded] = useState(false);

const LONGPRESS_HINT_KEY = "seen_longpress_create_trip_hint_v1";
const [showLongPressHint, setShowLongPressHint] = useState(false);

  // marker highlight (оставляем как было)
  const [selectedTripId, setSelectedTripId] = useState(null);

  // NEW: открыта/закрыта нижняя “полоска/лист” со списком поездок
  const [isTripsSheetOpen, setIsTripsSheetOpen] = useState(false);

const [infoMenuOpen, setInfoMenuOpen] = useState(false);
const [activeInfoModal, setActiveInfoModal] = useState(null);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const unreadAlerts = useTripAlertsCount(user?.id);

  const infoButtonRef = useRef(null);
  const mobileTripsRef = useRef(null);
  const tripsContentRef = useRef(null);
  const mapClickHandlerRef = useRef(null);
  const tripsDragRef = useRef(null);

useEffect(() => {
  if (!isTripsSheetOpen || !selectedTripId) return;

  const el = tripsContentRef.current;
  if (!el) return;

  // после перерендера мягко уводим скролл в начало,
  // чтобы выбранная (она теперь сверху) была видна
  requestAnimationFrame(() => {
    el.scrollTo({ top: 0, behavior: "smooth" });
  });
}, [isTripsSheetOpen, selectedTripId]);

useEffect(() => {
  const onDocPointerDown = (e) => {
    if (!infoMenuOpen) return;

    const root = infoButtonRef.current;
    if (!root) return;

    const path = e.composedPath ? e.composedPath() : [];
    const clickedInside = root.contains(e.target) || (path && path.includes(root));

    if (clickedInside) return;

    setInfoMenuOpen(false);
  };

  document.addEventListener("pointerdown", onDocPointerDown, true);
  return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
}, [infoMenuOpen]);


const tripsRtChannelRef = useRef(null);
const tripsRtDebounceRef = useRef(null);

  // SPEED: защита от повторной загрузки (как в PC)
  const fetchInFlightRef = useRef(false);

// ✅ СТАВИМ ВЫШЕ filters useState
const today = useMemo(() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}, []);

const twoWeeksLater = useMemo(() => {
  const d = new Date(today);
  d.setDate(d.getDate() + 14);
  d.setHours(23, 59, 59, 999);
  return d;
}, [today]);

  const [filters, setFilters] = useState({
    priceFrom: '',
    priceTo: '',
    leisureType: '',
    difficulty: '',
    age: '',
    dateFrom: today,
    dateTo: twoWeeksLater,
  });

const mapLoadedRef = useRef(false);
const mapBoundsRef = useRef(null);
const filtersRef = useRef(filters);
const fetchTripsRef = useRef(null);

useEffect(() => { mapLoadedRef.current = mapLoaded; }, [mapLoaded]);
useEffect(() => { mapBoundsRef.current = mapBounds; }, [mapBounds]);
useEffect(() => { filtersRef.current = filters; }, [filters]);

  const [localGeolocation, setLocalGeolocation] = useState(null);

  const [message, setMessage] = useState('');

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

  const tripsCount = filteredTrips?.length || 0;

  const tripsWord = useMemo(() => {
    return (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return 'поездка';
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'поездки';
      return 'поездок';
    };
  }, []);

  // Если лист открыт, а поездок по факту не осталось — закрываем
  useEffect(() => {
    if (isTripsSheetOpen && tripsCount === 0) {
      setIsTripsSheetOpen(false);
      setSelectedTripId(null);
    }
  }, [isTripsSheetOpen, tripsCount]);

  useEffect(() => {
  if (typeof window === "undefined") return;

  // ✅ Если есть фокус на поездке (пришли с детальной по кнопке "На карту") —
  // НЕ спрашиваем геолокацию и не меняем центр, иначе она перебьёт marker-focus.
  const hasFocusTrip =
    !!sessionStorage.getItem("focusTripId") ||
    !!sessionStorage.getItem("focusTripCoords") ||
    sessionStorage.getItem("forceFocusTrip") === "1";

  if (hasFocusTrip) return;

  // --- дальше твоя логика как была ---
  if (!user && !localGeolocation && navigator.geolocation) {
    setProcessing(true);
    const timeout = 10000;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // ✅ на всякий случай ещё раз проверим (если вдруг фокус появился)
        const stillHasFocus =
          !!sessionStorage.getItem("focusTripId") ||
          !!sessionStorage.getItem("focusTripCoords") ||
          sessionStorage.getItem("forceFocusTrip") === "1";
        if (stillHasFocus) {
          setProcessing(false);
          return;
        }

        const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setLocalGeolocation(coords);
        setCurrentMapCenter([coords.lat, coords.lon]);
        setCurrentZoom(6);
        localStorage.setItem("mapCenter", JSON.stringify([coords.lat, coords.lon]));
        localStorage.setItem("mapZoom", "6");
        setProcessing(false);
      },
      (err) => {
        console.warn("Geolocation denied or failed:", err);
        setLocalGeolocation(null);
        setCurrentMapCenter(initialMapCenter);
        setProcessing(false);
      },
      { timeout }
    );
  } else if (geolocation) {
    setLocalGeolocation(geolocation);
    setCurrentMapCenter([geolocation.lat, geolocation.lon]);
  }
}, [user, geolocation, localGeolocation, setProcessing]);



  useEffect(() => {
    const handleBeforeUnload = () => {
      console.log('Перезагрузка или закрытие страницы: очищаем localStorage');
      localStorage.removeItem('mapCenter');
      localStorage.removeItem('mapZoom');
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    console.time('mapCenterSetupMobile');

  // ✅ Если пришли из детальной по прямой ссылке (share),
  // то у пользователя может не быть сохранённого движения карты.
  // В этом случае форсируем центр по маркеру поездки.
  const forceFocus = sessionStorage.getItem('forceFocusTrip') === '1';
  const focusCoordsStr = sessionStorage.getItem('focusTripCoords');

  if (forceFocus && focusCoordsStr) {
    try {
      const coords = JSON.parse(focusCoordsStr); // [lat, lon]
      const zoom = 6;

      localStorage.setItem('mapCenter', JSON.stringify(coords));
      localStorage.setItem('mapZoom', String(zoom));

      setCurrentMapCenter(coords);
      setCurrentZoom(zoom);

      if (mapRef.current && mapLoaded) {
        mapRef.current.setCenter(coords, zoom);
        setMapBounds(mapRef.current.getBounds());
        if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filtersRef.current);
      }

      console.log('[mapCenterSetupMobile] Forced center from focusTripCoords:', coords);
      console.timeEnd('mapCenterSetupMobile');
      return;
    } catch (e) {
      console.warn('[mapCenterSetupMobile] Failed to parse focusTripCoords:', e);
    }
  }


    const savedCenter = localStorage.getItem('mapCenter');
    const savedZoom = localStorage.getItem('mapZoom');

    // 1) Если уже есть сохранённый центр — ВСЕГДА используем его (как в PC).
    if (savedCenter && savedZoom) {
      try {
        const center = JSON.parse(savedCenter);
        const zoom = parseInt(savedZoom, 10);
        setCurrentMapCenter(center);
        setCurrentZoom(Number.isFinite(zoom) ? zoom : 10);
        console.log('[mapCenterSetupMobile] Using saved map center and zoom:', { center, zoom });
      } catch (e) {
        console.warn('[mapCenterSetupMobile] Failed to parse saved map center/zoom:', e);
        localStorage.removeItem('mapCenter');
        localStorage.removeItem('mapZoom');
      }
      console.timeEnd('mapCenterSetupMobile');
      return;
    }

    // 2) Если сохранённого центра нет, но есть геолокация — центрируем по ней.
    const effectiveGeolocation = geolocation || propGeolocation || localGeolocation;
    if (effectiveGeolocation) {
      const newCenter = [effectiveGeolocation.lat, effectiveGeolocation.lon];
      setCurrentMapCenter(newCenter);
      setCurrentZoom(6);
      localStorage.setItem('mapCenter', JSON.stringify(newCenter));
      localStorage.setItem('mapZoom', '6');

      if (mapRef.current && mapLoaded) {
        mapRef.current.setCenter(newCenter, 6);
        setMapBounds(mapRef.current.getBounds());
        if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filters);
      }

      console.log('[mapCenterSetupMobile] Set map center from geolocation:', newCenter);
      console.timeEnd('mapCenterSetupMobile');
      return;
    }

    // 3) Ни сохранённого центра, ни гео — идём в профиль/дефолт.
    if (user && !loading) {
      void setMapCenterFromProfileWithRetry().finally(() => {
        console.timeEnd('mapCenterSetupMobile');
      });
      return;
    }

    setCurrentMapCenter(initialMapCenter);
    setCurrentZoom(12);
    localStorage.setItem('mapCenter', JSON.stringify(initialMapCenter));
    localStorage.setItem('mapZoom', '6');

    if (mapRef.current && mapLoaded) {
      mapRef.current.setCenter(initialMapCenter, 6);
      setMapBounds(mapRef.current.getBounds());
      if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filters);
    }

    console.log('[mapCenterSetupMobile] Set default map center:', initialMapCenter);
    console.timeEnd('mapCenterSetupMobile');
  }, [user, loading, geolocation, propGeolocation, localGeolocation, mapLoaded, tripsLoaded]);



  async function setMapCenterFromProfileWithRetry(retries = 3, delay = 1000) {
    if (!user) {
      console.log('Нет пользователя, центрируем по Москве');
      setCurrentMapCenter(initialMapCenter);
      setCurrentZoom(10);
      localStorage.setItem('mapCenter', JSON.stringify(initialMapCenter));
      localStorage.setItem('mapZoom', '10');
      if (mapRef.current && mapLoaded) {
        mapRef.current.setCenter(initialMapCenter, 10);
        setMapBounds(mapRef.current.getBounds());
        if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filters);
      }
      return;
    }

    setProcessing(true);
    for (let attempt = 1; attempt <= retries; attempt++) {
      console.log(`Попытка ${attempt} запроса координат из профиля для user_id:`, user.id);
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('geo_lat, geo_lon')
          .eq('user_id', user.id)
          .single();

        if (error) throw error;

        const coords = data?.geo_lat && data?.geo_lon
          ? [parseFloat(data.geo_lat), parseFloat(data.geo_lon)]
          : initialMapCenter;

        console.log('Координаты из профиля:', coords);
        setCurrentMapCenter(coords);
        setCurrentZoom(10);
        localStorage.setItem('mapCenter', JSON.stringify(coords));
        localStorage.setItem('mapZoom', '10');

        if (mapRef.current && mapLoaded) {
          mapRef.current.setCenter(coords, 10);
          setMapBounds(mapRef.current.getBounds());
          if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filters);
        }
        setProcessing(false);
        return;
      } catch (error) {
        console.error(`Ошибка получения координат из профиля (попытка ${attempt}):`, error);
        if (attempt === retries) {
          console.log('Все попытки исчерпаны, центрируем по Москве');
          setCurrentMapCenter(initialMapCenter);
          setCurrentZoom(10);
          localStorage.setItem('mapCenter', JSON.stringify(initialMapCenter));
          localStorage.setItem('mapZoom', '10');
          setProcessing(false);
          if (mapRef.current && mapLoaded) {
            mapRef.current.setCenter(initialMapCenter, 10);
            setMapBounds(mapRef.current.getBounds());
            if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filters);
          }
        } else {
          console.log(`Ожидаем ${delay}мс перед следующей попыткой`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }



  useEffect(() => {
    const updateUnread = () => {
      const totalUnread = notifications.getTotalUnread();
      setUnreadMessages(totalUnread);
    };
    notifications.addListener(updateUnread);
    return () => notifications.removeListener(updateUnread);
  }, []);

  useEffect(() => {
    if (loading) return;
    fetchTrips();
  }, [user, loading]);

useEffect(() => {
  // чистим прошлый канал (на всякий)
if (tripsRtChannelRef.current) {
  try { supabase.removeChannel(tripsRtChannelRef.current); } catch {}
  tripsRtChannelRef.current = null;
}

  const scheduleRefresh = (reason) => {
    // ✅ если страница не активна — можно не дёргать (по желанию)
    // if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    if (tripsRtDebounceRef.current) clearTimeout(tripsRtDebounceRef.current);

tripsRtDebounceRef.current = setTimeout(() => {
  console.log('[rt] refresh', {
    mapLoaded: mapLoadedRef.current,
    bounds: mapRef.current?.getBounds?.() || mapBoundsRef.current,
    filters: filtersRef.current,
  });
  fetchTripsRef.current?.({ silent: true, reason });
}, 450);

  };

  // ✅ отдельный realtime-канал под trips+participants
  const ch = supabase
    .channel('trips_map_live')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'trips' },
      (payload) => {
        // если вставили active — точно refresh; если нет — всё равно refresh (на случай смены статуса логикой)
        const newTrip = payload.new;
if (newTrip?.status === 'active') {
  // просто перезагрузим, но можно и умнее (ниже дам вариант)
  scheduleRefresh('trips_insert');
}
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'trips' },
      () => scheduleRefresh('trips_update')
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'trips' },
      () => scheduleRefresh('trips_delete')
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'trip_participants' },
      () => scheduleRefresh('tp_insert')
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'trip_participants' },
      () => scheduleRefresh('tp_update')
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'trip_participants' },
      () => scheduleRefresh('tp_delete')
    )
    .subscribe();

  tripsRtChannelRef.current = ch;

  return () => {
    if (tripsRtDebounceRef.current) clearTimeout(tripsRtDebounceRef.current);
    tripsRtDebounceRef.current = null;

    try { supabase.removeChannel(ch); } catch {}
    tripsRtChannelRef.current = null;
  };
  // важно: fetchTrips используется внутри эффекта, но он объявлен как function ниже — это ок.
}, []); 


  useEffect(() => {
    if (tripsLoaded && mapLoaded && mapRef.current) {
      const bounds = mapRef.current.getBounds();
      setMapBounds(bounds);
      applyFiltersWithBounds(trips, bounds, filters);
    }
  }, [tripsLoaded, mapLoaded]);

  // Свайп вниз по открытому листу — закрывает (как раньше, но теперь по isTripsSheetOpen)
useEffect(() => {
if (!isTripsSheetOpen || !mobileTripsRef.current || !tripsDragRef.current) return;

const sheetEl = mobileTripsRef.current;
const dragEl = tripsDragRef.current;

  let startY = 0;
  let lastY = 0;
  let dragging = false;

  const CLOSE_THRESHOLD = 100;      // сколько нужно протянуть вниз для закрытия
  const DRAG_START = 10;            // мёртвая зона
  const DAMPING = 0.75;             // плавность (чем меньше — тем “тяжелее”)

  const onStart = (e) => {
    startY = e.touches[0].clientY;
    lastY = startY;
    dragging = false;

    // на старте сбросим переход, чтобы не было дерганья
    sheetEl.style.transition = 'none';
  };



  const onMove = (e) => {
  lastY = e.touches[0].clientY;
  const diff = lastY - startY;

  if (diff <= DRAG_START) return;

  dragging = true;
  e.preventDefault();

  const y = (diff - DRAG_START) * DAMPING;
  sheetEl.style.transform = `translateY(${Math.max(0, y)}px)`;
};

const onEnd = () => {
  const diff = lastY - startY;

  // возвращаем transition (или можно просто очистить)
  sheetEl.style.transition = '';

  if (dragging && diff > CLOSE_THRESHOLD) {
    // ✅ очищаем inline transform, чтобы CSS-класс sheetClosed анимировал закрытие
    sheetEl.style.transform = '';
    setIsTripsSheetOpen(false);
    setSelectedTripId(null);
    dragging = false;
    return;
  }

  // ✅ не закрыли — просто отпускаем и возвращаемся в sheetOpen (класс сам удержит)
  sheetEl.style.transform = '';
  dragging = false;
};

  dragEl.addEventListener('touchstart', onStart, { passive: true });
  dragEl.addEventListener('touchmove', onMove, { passive: false });
  dragEl.addEventListener('touchend', onEnd, { passive: true });

  return () => {
    dragEl.removeEventListener('touchstart', onStart);
    dragEl.removeEventListener('touchmove', onMove);
    dragEl.removeEventListener('touchend', onEnd);
  };
}, [isTripsSheetOpen]);

useEffect(() => {
  if (typeof window === "undefined") return;
  if (!mapLoaded) return;

  try {
    if (localStorage.getItem(LONGPRESS_HINT_KEY) === "1") return;
  } catch {}

  if (isTripsSheetOpen) return;

  const t = setTimeout(() => setShowLongPressHint(true), 1200);
  return () => clearTimeout(t);
}, [mapLoaded, isTripsSheetOpen]);


  async function fetchTrips(opts = {}) {
  const { silent = false, reason = 'manual' } = opts;

  // SPEED: защита от повторного вызова (как в PC)
  if (fetchInFlightRef.current) return;
  fetchInFlightRef.current = true;

  if (!silent) setProcessing(true);

  try {
    const { data, error } = await supabase.rpc('get_active_trips_geojson');
    if (error) {
      console.error('Error fetching trips:', error);
      setMessage('Ошибка загрузки поездок');
      setTripsLoaded(true);
      setMapLoaded(true);
      return;
    }

    if (!data || data.length === 0) {
      setMessage('Нет активных поездок');
      setTripsLoaded(true);
      setMapLoaded(true);
      return;
    }

    const activeTrips = await Promise.all(
      data.map(async (trip) => {
        const { count, error: countError } = await supabase
          .from('trip_participants')
          .select('*', { count: 'exact', head: true })
          .eq('trip_id', trip.id)
          .in('status', ['paid', 'waiting']);

        if (countError) {
          console.error('[fetchTrips] Count error for trip:', trip.id, countError);
          return null;
        }

        return count < (trip.participants || 8) ? trip : null;
      })
    ).then((results) => results.filter(Boolean));

    setTrips(activeTrips);
    setTripsLoaded(true);

    // ✅ сразу пересчитываем список по текущим bounds + фильтрам
    try {
      const bounds = mapRef.current?.getBounds?.() || mapBoundsRef.current;
      if (bounds) {
        applyFiltersWithBounds(activeTrips, bounds, filtersRef.current);
      } else {
        setFilteredTrips(activeTrips);
      }
    } catch {
      setFilteredTrips(activeTrips);
    }
  } catch (err) {
    console.error('[fetchTrips] Exception:', err);
    setMessage('Ошибка загрузки поездок');
    setTripsLoaded(true);
    setMapLoaded(true);
  } finally {
    if (!silent) setProcessing(false);
    fetchInFlightRef.current = false;
  }
}


useEffect(() => {
  fetchTripsRef.current = fetchTrips;
}, [fetchTrips]);

  function applyFiltersWithBounds(tripsData, bounds, filtersArg = filters) {
    if (!tripsData?.length || !bounds) return;

    const f = filtersArg || {};
    let result = tripsData.filter((trip) => {
      const price = parseInt(trip.price);
      const ageFrom = parseInt(trip.age_from);
      const ageTo = parseInt(trip.age_to);
      const tripDate = new Date(trip.date);
      const tripArrival = new Date(trip.arrival_date || trip.date);

      const filterDateFrom = f.dateFrom ? new Date(f.dateFrom) : today;
      filterDateFrom.setHours(0, 0, 0, 0);

      const filterDateTo = f.dateTo ? new Date(f.dateTo) : twoWeeksLater;
      if (filterDateTo) filterDateTo.setHours(23, 59, 59, 999);

      const passesFilters =
        (!f.priceFrom || price >= f.priceFrom) &&
        (!f.priceTo || price <= f.priceTo) &&
        (!f.leisureType || trip.leisure_type === f.leisureType) &&
        (!f.difficulty || trip.difficulty === f.difficulty) &&
        (!f.age || (f.age >= ageFrom && f.age <= ageTo)) &&
        (!filterDateTo || (tripDate >= filterDateFrom && tripArrival <= filterDateTo));

      return passesFilters;
    });

    // фильтр по области видимости карты
    result = result.filter((trip) => {
      const geoJson = typeof trip.to_location === 'string' ? JSON.parse(trip.to_location) : trip.to_location;
      const coords = geoJson?.coordinates ? [geoJson.coordinates[1], geoJson.coordinates[0]] : null;
      return coords && isWithinBounds(coords, bounds);
    });

    setFilteredTrips(result);
  }

  function isWithinBounds(coords, bounds) {
    const [[minLat, minLon], [maxLat, maxLon]] = bounds;
    return coords[0] >= minLat && coords[0] <= maxLat && coords[1] >= minLon && coords[1] <= maxLon;
  }

useEffect(() => {
  if (typeof window === 'undefined') return;

  const focusId = sessionStorage.getItem('focusTripId');
  if (!focusId) return;

  if (!mapLoaded || !mapRef.current || !tripsLoaded) return;

  // подсветим маркер
  setSelectedTripId(Number(focusId));

  // если нет focusTripCoords (например, не передали) — попробуем взять из trips
  let coords = null;
  const t = (trips || []).find(x => String(x.id) === String(focusId));
  if (t) {
    try {
      const geoJson = typeof t.to_location === 'string' ? JSON.parse(t.to_location) : t.to_location;
      coords = geoJson?.coordinates ? [geoJson.coordinates[1], geoJson.coordinates[0]] : null;
    } catch {}
  }

  const force = sessionStorage.getItem('forceFocusTrip') === '1';

  if (coords && force) {
    // ✅ если пришли по share-ссылке — центрируем всегда
    const z = Math.max(mapRef.current.getZoom?.() ?? currentZoom ?? 10, 12);
    mapRef.current.setCenter(coords, z);
  }

  // очистим одноразовые ключи
  sessionStorage.removeItem('focusTripId');
  sessionStorage.removeItem('forceFocusTrip');
  sessionStorage.removeItem('focusTripCoords');
}, [mapLoaded, tripsLoaded, trips, currentZoom]);

const markLongPressHintSeen = () => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LONGPRESS_HINT_KEY, "1");
  } catch {}
  setShowLongPressHint(false);
};

  const handleMapChange = (e) => {
    setMapBounds(e.get('newBounds'));
    if (tripsLoaded) applyFiltersWithBounds(trips, e.get('newBounds'), filtersRef.current);

    if (mapRef.current) {
      const newCenter = mapRef.current.getCenter();
      const newZoom = mapRef.current.getZoom();
      setCurrentMapCenter(newCenter);
      setCurrentZoom(newZoom);
      localStorage.setItem('mapCenter', JSON.stringify(newCenter));
      localStorage.setItem('mapZoom', newZoom.toString());
    }

    setContextMenu(null);
    setUserMarker(null);
  };

  const handleMapClick = () => {
    setUserMarker(null);
    setContextMenu(null);

    // как раньше — тап по карте закрывает низ
    setSelectedTripId(null);
    setIsTripsSheetOpen(false);

    if (mapClickHandlerRef.current) {
      mapClickHandlerRef.current();
    }
  };

 const handleMapContextMenu = (e) => {
  markLongPressHintSeen();

  const coords = e.get("coords");
  const pagePixels = e.get("pagePixels");
  setUserMarker(coords);
  setContextMenu({
    x: pagePixels[0],
    y: pagePixels[1],
    lat: coords[0],
    lon: coords[1],
  });
};


  const handleContextMenuAction = (answer) => {
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

const handleTripClick = (tripId, tripObj = null) => {
  // ✅ помечаем, что в деталку ушли с /trips
  if (typeof window !== 'undefined') {
    sessionStorage.setItem('navFromTrips', '1');
  }

  // закрываем лист/выделение
  setSelectedTripId(null);
  setIsTripsSheetOpen(false);
  setInfoMenuOpen(false);

  // ✅ реальный переход, чтобы URL стал /trip/<id>
  router.push(`/trip/${tripId}`);
};


  // Тап по метке — открывает лист, метку подсвечивает, второй тап по той же метке закрывает
  const handlePlacemarkClick = (tripId) => {
    setSelectedTripId((prev) => {
      const next = prev === tripId ? null : tripId;
      setIsTripsSheetOpen(Boolean(next)); // если выбрали метку — открываем лист, если сняли — закрываем
      return next;
    });
  };

const handleClusterClick = (e) => {
  try {
    const target = e.get('target');
    if (!target) return false;

    // ✅ стопаем, чтобы не сработал клик по карте
    const domEvent = e.get('domEvent');
    domEvent?.stopPropagation?.();
    domEvent?.preventDefault?.();

    // кластер = объект у которого есть getGeoObjects()
    const isCluster = typeof target.getGeoObjects === 'function';
    if (!isCluster) return false;

    const bounds = target.getBounds?.();
    if (!bounds || !mapRef.current) return true;

    // ✅ зум так, чтобы влезли все поездки в этом кластере
    mapRef.current.setBounds(bounds, {
      checkZoomRange: true,
      zoomMargin: 60,
    });

    // (опционально) ограничим слишком сильный зум
    const MAX_ZOOM = 15;
    setTimeout(() => {
      try {
        const z = mapRef.current.getZoom();
        if (typeof z === 'number' && z > MAX_ZOOM) mapRef.current.setZoom(MAX_ZOOM);
      } catch {}
    }, 0);

    return true;
  } catch {
    return false;
  }
};




  const handleMapLoad = () => {
    setMapLoaded(true);
    if (mapRef.current) {
      console.log('Карта загружена, применяем центр:', currentMapCenter);
      mapRef.current.setCenter(currentMapCenter, currentZoom);
      setMapBounds(mapRef.current.getBounds());
      if (tripsLoaded) applyFiltersWithBounds(trips, mapRef.current.getBounds(), filters);
    }
  };

const toggleInfoMenu = () => {
  setInfoMenuOpen((v) => !v);
};

const openInfoModal = (type) => {
  setInfoMenuOpen(false);      // ✅ сразу сворачиваем окно “Информация”
  setActiveInfoModal(type);    // ✅ открываем модалку
};

const closeInfoModal = () => {
  setActiveInfoModal(null);
};


  const downloadDocument = async (fileName) => {
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
    } catch (error) {
      console.error('Error downloading document:', error);
      setMessage('Ошибка загрузки документа');
      setTimeout(() => setMessage(''), 4000);
    } finally {
      setProcessing(false);
    }
  };

  const handleMessagesClick = () => {
    router.push('/dashboard?section=messages');
  };

  const handleAlertsClick = () => {
    router.push('/dashboard?section=alerts');
  };

  const applyFilter = (field, nextFilters) => {
  // Берём либо "новые фильтры", либо актуальные из ref (самое надёжное),
  // либо fallback на filters из стейта
  const f = nextFilters || filtersRef.current || filters;

  if (field === 'date') {
    if (!f.dateFrom || !f.dateTo) return;
    if (
      f.dateFrom.getTime() === today.getTime() &&
      f.dateTo.getTime() === twoWeeksLater.getTime()
    ) {
      return;
    }
  }

  if (mapRef.current) {
    const currentBounds = mapRef.current.getBounds();
    applyFiltersWithBounds(trips, currentBounds, f);
  }
};


  const removeFilter = (field) => {
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
  };


  const openTripsSheet = () => {
    if (tripsCount > 0) {
      setIsTripsSheetOpen(true);
      setSelectedTripId(null); // открываем общий список “как по меткам”, без выбора одной
    }
  };

  const closeTripsSheet = () => {
    setIsTripsSheetOpen(false);
    setSelectedTripId(null);
  };

  return (
  <div className={mobileStyles.container}>
   <header className={mobileStyles.header}>
  {/* LEFT: logo */}
  <div className={mobileStyles.headerLeft}>
    <img src="/logo.png" alt="Onloc Logo" className={mobileStyles.logo} />
  </div>

  {/* RIGHT: icons */}
  <div className={mobileStyles.authButtons}>
    {/* Сообщения */}
    <button
      type="button"
      onClick={() => {
        if (isTripsSheetOpen) closeTripsSheet();
        setInfoMenuOpen(false);
        handleMessagesClick();
      }}
      className={`${mobileStyles.topIconButton} ${unreadMessages > 0 ? mobileStyles.topIconUnread : ""}`}
      aria-label="Сообщения"
      title="Сообщения"
    >
      <span className={mobileStyles.topIconWrap}>
        <MsgIconWithCount count={unreadMessages} />
      </span>
    </button>

    <AlertsBell
      user={user}
      count={unreadAlerts}
      buttonClassName={`${mobileStyles.topIconButton} ${unreadAlerts > 0 ? mobileStyles.topIconUnread : ""}`}
      iconWrapClassName={mobileStyles.topIconWrap}
      iconClassName={mobileStyles.topNavIcon}
      mobileEdgeToEdge
      onBeforeOpen={() => {
        if (isTripsSheetOpen) closeTripsSheet();
        setInfoMenuOpen(false);
      }}
    />

    {/* Инфо */}
    <div className={mobileStyles.infoWrapper} ref={infoButtonRef}>
      <button
        type="button"
        onClick={() => {
          if (isTripsSheetOpen) closeTripsSheet();
          toggleInfoMenu();
        }}
        className={`${mobileStyles.topIconButton} ${infoMenuOpen ? mobileStyles.topIconActive : ""}`}
        aria-label="Информация"
        title="Информация"
      >
        <span className={mobileStyles.topIconWrap}>
          <InfoIcon />
        </span>
      </button>

      {infoMenuOpen && (
        <div className={mobileStyles.infoDropdown}>
          <button
            type="button"
            className={mobileStyles.infoOption}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openInfoModal("contacts");
            }}
          >
            Контакты
          </button>

          <button
            type="button"
            className={mobileStyles.infoOption}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openInfoModal("documents");
            }}
          >
            Документы
          </button>
        </div>
      )}
    </div>

    {/* Кабинет / Войти */}
    {user ? (
      <Link
        href={{ pathname: "/dashboard", query: { section: "myTrips" } }}
        className={mobileStyles.topIconButton}
        aria-label="Личный кабинет"
        title="Личный кабинет"
        onClick={() => {
          if (isTripsSheetOpen) closeTripsSheet();
          setInfoMenuOpen(false);
        }}
      >
        <span className={mobileStyles.topIconWrap}>
          <UserIcon />
        </span>
      </Link>
    ) : (
      <Link
        href="/auth"
        className={mobileStyles.topIconButton}
        aria-label="Войти"
        title="Войти"
        onClick={() => {
          if (isTripsSheetOpen) closeTripsSheet();
          setInfoMenuOpen(false);
        }}
      >
        <span className={mobileStyles.topIconWrap}>
          <KeyIcon />
        </span>
      </Link>
    )}
  </div>
</header>



      <div className={mobileStyles.main}>
            <div className={mobileStyles.mapContainer}>
  {showLongPressHint && (
    <div className={mobileStyles.coachmark}>
      <div className={mobileStyles.coachmarkCard} role="status" aria-live="polite">
        <div className={mobileStyles.coachmarkText}>
          Нажмите и удерживайте точку на карте, чтобы создать поездку
        </div>
        <div className={mobileStyles.coachmarkActions}>
          <button
            type="button"
            className={mobileStyles.coachmarkBtn}
            onClick={markLongPressHintSeen}
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  )}

  <YMaps>

                <Map
  instanceRef={mapRef}
  state={{ center: currentMapCenter, zoom: currentZoom }}
  width="100%"
  height="100%"
  onBoundsChange={handleMapChange}
  onClick={handleMapClick}
  onContextmenu={handleMapContextMenu}
  onLoad={handleMapLoad}
  controls={[]}
  options={{
    suppressMapOpenBlock: true,
    suppressYandexSearch: true,
    suppressTraffic: true,
    suppressObsoleteBrowserNotifier: true,
  }}
>
<Clusterer
  options={{
    preset: 'islands#invertedVioletClusterIcons',
    groupByCoordinates: false,
    clusterDisableClickZoom: true,
  }}
  onClick={handleClusterClick}
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
          iconImageSize: [25, 40],
          iconImageOffset: [-12, -40],
        }}
        onClick={() => handlePlacemarkClick(trip.id)}
      />
    );
  })}
</Clusterer>

{/* ✅ userMarker ВСЕГДА поверх кластеров */}
{userMarker && (
  <Placemark
    geometry={userMarker}
    properties={{ hintContent: 'Выбранная точка' }}
    options={{
      iconLayout: 'default#image',
      iconImageHref: '/placemark.png',
      iconImageSize: [28, 44],
      iconImageOffset: [-14, -44],
      zIndex: 999999,
    }}
  />
)}

                </Map>
              </YMaps>

              <div>
  <FiltersMobile
    filters={filters}
    setFilters={setFilters}
    applyFilter={applyFilter}
    removeFilter={removeFilter}
    leisureTypeLabels={leisureTypeLabels}
    difficultyLabels={difficultyLabels}
    today={today}
    twoWeeksLater={twoWeeksLater}
    setSelectedTripId={setSelectedTripId}
    onMapClick={mapClickHandlerRef}
    onFilterOpen={closeTripsSheet}
  />
</div>

            {/* ✅ Пункт 2: нижняя кликабельная “полоска” (когда лист закрыт) */}
            {!isTripsSheetOpen && tripsCount > 0 && (
              <div className={mobileStyles.tripsBottomBar} onClick={openTripsSheet} role="button">
                <div>
                  <div className={mobileStyles.tripsBottomBarText}>
                    На экране: {tripsCount} {tripsWord(tripsCount)}
                  </div>
                  <div className={mobileStyles.tripsBottomBarHint}>
                    Нажмите, чтобы открыть список
                  </div>
                </div>
                <div className={mobileStyles.tripsBottomBarArrow}>▲</div>
              </div>
            )}

            {/* ✅ Лист со списком поездок на карте */}
            <div
  className={`${mobileStyles.mobileTripsList} ${isTripsSheetOpen ? mobileStyles.sheetOpen : mobileStyles.sheetClosed}`}
  ref={mobileTripsRef}
  aria-hidden={!isTripsSheetOpen}
>
  {/* ✅ Зона зацепа: хедер + ~1см вниз */}
  <div className={mobileStyles.tripsDragArea} ref={tripsDragRef}>
    <div className={mobileStyles.tripsSheetHandle} onClick={closeTripsSheet} role="button">
      <div className={mobileStyles.tripsSheetHandleLeft}>
        <div className={mobileStyles.handlePill} />
        <div className={mobileStyles.tripsSheetTitle}>
          На экране: {tripsCount} {tripsWord(tripsCount)}
        </div>
      </div>
      <div className={mobileStyles.tripsSheetArrow}>▼</div>
    </div>

    {/* вот эта полоса и есть “+1см” */}
    <div className={mobileStyles.tripsDragZone} />
  </div>
                <div className={mobileStyles.mobileTripsContent} ref={tripsContentRef}>
                  {filteredTrips.length === 0 ? (
                    <p className={mobileStyles.noTrips}>Нет доступных поездок</p>
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
    className={`${mobileStyles.mobileTripCard} ${selectedTripId === trip.id ? mobileStyles.selectedTrip : ''}`}
    onClick={(e) => {
      e.preventDefault();
      handleTripClick(trip.id, trip);
    }}
  >
    <div className={mobileStyles.mobileImageContainer}>
      <img
        src={getTripCoverUrl(trip)}
        alt={trip.title}
        className={mobileStyles.mobileTripImage}
        loading="lazy"
        onError={(e) => {
          e.currentTarget.onerror = null;
          e.currentTarget.src = DEFAULT_TRIP_IMAGE;
        }}
      />
    </div>

    <div className={mobileStyles.mobileTripInfo}>
      <h3 className={mobileStyles.mobileTripTitle} title={trip.title}>
        {truncateTitle(trip.title, 21)}
      </h3>

      <p className={mobileStyles.mobileTripDetails}>
        {startDateTime.toLocaleDateString('ru-RU')}{" "}
        {startDateTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} –{" "}
        {endDateTime.toLocaleDateString('ru-RU')}{" "}
        {endDateTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
      </p>

      <p className={mobileStyles.mobileTripPrice}>Цена: {trip.price} ₽</p>
    </div>
  </Link>
);
                    })
                  )}
                </div>
              </div>

            {contextMenu && (() => {
  const pos = getSafeContextMenuPos(contextMenu);
  return (
    <div className={mobileStyles.contextMenu} style={{ left: pos.left, top: pos.top }}>
                <p>Создать поездку в эту локацию?</p>
<div className={mobileStyles.contextButtons}>
  <button
    type="button"
    className={mobileStyles.contextButton}
    onClick={() => handleContextMenuAction('yes')}
  >
    Да
  </button>

  <button
    type="button"
    className={mobileStyles.contextButton}
    onClick={() => handleContextMenuAction('no')}
  >
    Нет
  </button>
</div>

  </div>
  );
})()}

{activeInfoModal && (
  <div
    className={mobileStyles.infoModalOverlay}
    onClick={closeInfoModal}
    role="dialog"
    aria-modal="true"
  >
    <div
      className={mobileStyles.infoModalCard}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={mobileStyles.infoModalClose}
        onClick={closeInfoModal}
        aria-label="Закрыть"
        title="Закрыть"
      >
        ×
      </button>

      {activeInfoModal === "contacts" && (
        <>
          <div className={mobileStyles.infoModalTitle}>Контакты</div>
          <div className={mobileStyles.infoModalBody}>
            <div className={mobileStyles.companyCard}>
              <h3>Карточка предприятия</h3>
              <p>Поддержка: support@onloc.ru</p>
              <p>Телефон: +7 ...</p>
            </div>
          </div>
        </>
      )}

      {activeInfoModal === "documents" && (
        <>
          <div className={mobileStyles.infoModalTitle}>Документы</div>
          <div className={mobileStyles.infoModalBody}>
            <div className={mobileStyles.documentsCard}>
              <button
                type="button"
                onClick={() => downloadDocument("tbank_contract.pdf")}
                className={mobileStyles.documentLink}
              >
                Договор Т-банк
              </button>

              <button
                type="button"
                onClick={() => downloadDocument("platform_contract.pdf")}
                className={mobileStyles.documentLink}
              >
                Договор Площадка
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  </div>
)}



      {message && <div className={mobileStyles.message}>{message}</div>}
    </div>
  </div>
</div>
);
}
