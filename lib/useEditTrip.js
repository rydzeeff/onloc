// /lib/useEditTrip.js
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { supabase } from './supabaseClient';
import imageCompression from 'browser-image-compression';
import { useAuth } from '../pages/_app';
import { platformSettings } from './platformSettings';
import { calculateNetAmountAfterFees } from './tbankFees';
import { checkImageWithVkNsfw } from './vkcloud/nsfwClient'; // NSFW VK Cloud

// ——— helpers ———
const sanitizeFileName = (fileName) => {
  return String(fileName || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_.]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
};

// Парсим PostGIS point из разных форматов (на всякий)
// ВАЖНО: для Yandex Maps используем [lat, lon]
// Приводим геометрию к [lat, lon] (как ожидает Yandex Maps)
const parsePointToLatLon = (point) => {
  if (!point) return null;

  // 1) Если уже массив: чаще всего это [lon, lat] (как в useTripDetails.pickLatLng)
  if (Array.isArray(point) && point.length >= 2) {
    const lon = Number(point[0]);
    const lat = Number(point[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
    return null;
  }

  // 2) Объект (GeoJSON / PostgREST)
  if (typeof point === 'object') {
    // GeoJSON: { type:'Point', coordinates:[lon,lat] } или просто { coordinates:[lon,lat] }
    const coords = point?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
    }

    // Иногда может прилетать как { x: lon, y: lat } (postgres point)
    if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
      return [Number(point.y), Number(point.x)];
    }

    // На всякий: { lat, lon } / { latitude, longitude }
    if (Number.isFinite(point?.lat) && Number.isFinite(point?.lon)) {
      return [Number(point.lat), Number(point.lon)];
    }
    if (Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude)) {
      return [Number(point.latitude), Number(point.longitude)];
    }

    return null;
  }

  // 3) Строка
  const s = String(point).trim();
  if (!s) return null;

  // 3.1) JSON-строка
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return parsePointToLatLon(JSON.parse(s));
    } catch (e) {
      // ignore
    }
  }

  // 3.2) WKT: POINT(lon lat)
  let m = s.match(/POINT\s*\(\s*([-.\d]+)\s+([-.\d]+)\s*\)/i);
  if (m) {
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
  }

  // 3.3) postgres point: "(lon,lat)"
  m = s.match(/^\(\s*([-.\d]+)\s*,\s*([-.\d]+)\s*\)$/);
  if (m) {
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
  }

  return null;
};

// Сдвигаем UTC дату в локальную по timezone вида UTC+3 / UTC-5 (как у тебя в CreateTrip)
const shiftUtcToLocalDateStringByTimezone = (utcDate, timezone) => {
  try {
    if (!utcDate || !timezone) return null;
    const match = String(timezone).match(/UTC([+-])(\d+)/);
    if (!match) return null;
    const sign = match[1] === '+' ? 1 : -1;
    const offsetHours = parseInt(match[2]) * sign;
    const d = new Date(utcDate);
    if (Number.isNaN(d.getTime())) return null;
    const shifted = new Date(d.getTime() + offsetHours * 60 * 60 * 1000);
    return shifted.toISOString().split('T')[0];
  } catch {
    return null;
  }
};

export const useEditTrip = (tripId) => {
  const router = useRouter();
  const { user, geolocation } = useAuth();

  const [isReady, setIsReady] = useState(false);

  // timezone логика такая же как в CreateTrip
  const [timezone, setTimezone] = useState(null);
  const [showTimezoneInput, setShowTimezoneInput] = useState(false);
  const [timezoneError, setTimezoneError] = useState(null);

  // попапы/ошибки такие же как в CreateTrip
  const [companyVerificationStatus, setCompanyVerificationStatus] = useState(null);
  const [showPopup, setShowPopup] = useState(false);
  const [refundError, setRefundError] = useState(null);
  const [timeError, setTimeError] = useState(null);
  const [loading, setLoading] = useState(false);

  // статусы платёжных реквизитов (как в CreateTrip)
  const [hasValidCard, setHasValidCard] = useState(false);
  const [hasCompanyOk, setHasCompanyOk] = useState(false);

  // NSFW прогресс (как в CreateTrip)
  const [nsfwChecking, setNsfwChecking] = useState(false);
  const [nsfwProgress, setNsfwProgress] = useState({ done: 0, total: 0 });

  const [tripLoaded, setTripLoaded] = useState(false);

  const commonTimezones = [
    'UTC-12','UTC-11','UTC-10','UTC-9','UTC-8','UTC-7','UTC-6','UTC-5',
    'UTC-4','UTC-3','UTC-2','UTC-1','UTC+0','UTC+1','UTC+2','UTC+3',
    'UTC+4','UTC+5','UTC+6','UTC+7','UTC+8','UTC+9','UTC+10','UTC+11',
    'UTC+12','UTC+13','UTC+14',
  ];

  // helper — просрочена ли карта по формату MMYY или MM/YY
  const isCardExpired = (expiry_text) => {
    if (!expiry_text) return false;
    const s = String(expiry_text).trim();
    let mm = null, yy = null;
    if (/^\d{4}$/.test(s)) { mm = s.slice(0, 2); yy = s.slice(2, 4); }
    else if (/^\d{2}\/\d{2}$/.test(s)) { [mm, yy] = s.split('/'); }
    if (!mm || !yy) return false;
    const lastDay = new Date(Number('20' + yy), Number(mm), 0);
    const now = new Date();
    return lastDay < new Date(now.getFullYear(), now.getMonth(), 1);
  };

  // ВАЖНО: в EditTrip images храним как "микс":
  //  - { type: 'existing', url }
  //  - { type: 'new', file }
  const [tripData, setTripData] = useState({
    title: '',
    description: '',
    date: null,
    time: '',
    arrivalDate: null,
    arrivalTime: '',
    price: '',
    difficulty: 'easy',
    ageFrom: 18,
    ageTo: 60,
    fromLocation: null,
    toLocation: null,
    images: [],
    participants: 1,
    leisureType: 'tourism',
    isCompanyTrip: false,
    alcoholAllowed: false,
    fromAddress: '',
    toAddress: '',
    refund_policy_type: false,
    refund_policy: {
      type: 'standard',
      full_refunded_hours: 1,
      partial_refunded_hours: '',
      partial_refunded_percent: '',
      timezone: null,
    },
    platformFee: 0,
    tbankFee: 0,
    netAmount: 0,
    platformFeePercentSnapshot: platformSettings.platformFeePercent,
    tbankCardFeePercentSnapshot: platformSettings.tbankFeePercent,
  });

  const [previewUrls, setPreviewUrls] = useState([]);
  const [isLocationFromOpen, setIsLocationFromOpen] = useState(false);
  const [isLocationToOpen, setIsLocationToOpen] = useState(false);
  const [fromCoordinates, setFromCoordinates] = useState(null);
  const [toCoordinates, setToCoordinates] = useState(null);
  const [fromAddress, setFromAddress] = useState('');
  const [toAddress, setToAddress] = useState('');
  const [mainImageIndex, setMainImageIndex] = useState(0);
  const [fromMapCenter, setFromMapCenter] = useState([55.751244, 37.618423]);
  const [toMapCenter, setToMapCenter] = useState([55.751244, 37.618423]);

  const todayLocal = new Date();
  const today = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}-${String(todayLocal.getDate()).padStart(2, '0')}`;

  const calculateFees = (price) => {
    const priceNum = parseFloat(price) || 0;
    return calculateNetAmountAfterFees(priceNum, tripData.platformFeePercentSnapshot, {
      cardFeePercent: tripData.tbankCardFeePercentSnapshot,
      cardFeeMinRub: platformSettings.tbankCardFeeMinRub,
      payoutFeePercent: platformSettings.tbankPayoutFeePercent,
      payoutFeeMinRub: platformSettings.tbankPayoutFeeMinRub,
    });
  };

  // ——— статусы «карта/компания» (как в CreateTrip) ———
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!user?.id) {
        if (!cancelled) {
          setHasValidCard(false);
          setHasCompanyOk(false);
        }
        return;
      }

      // карты пользователя
      const { data: cards, error: cardsErr } = await supabase
        .from('user_cards')
        .select('is_primary, expiry_date')
        .eq('user_id', user.id);

      const hasValid =
        !cardsErr &&
        Array.isArray(cards) &&
        cards.some(c => c?.is_primary ? !isCardExpired(c?.expiry_date) : !isCardExpired(c?.expiry_date));

      if (!cancelled) setHasValidCard(Boolean(hasValid));

      // активная компания с T-Банк и платёжным счётом
      let comp = null;
      try {
        const { data } = await supabase
          .from('mycompany')
          .select('is_active, tbank_registered, tbank_shop_code, payment_account, account')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .single();
        comp = data || null;
      } catch {
        comp = null;
      }
      const companyOk = !!(comp && comp.tbank_registered && comp.tbank_shop_code && (comp.payment_account || comp.account));
      if (!cancelled) setHasCompanyOk(companyOk);
    };

    run();
    return () => { cancelled = true; };
  }, [user?.id]);

  // ——— загрузка поездки из БД по tripId ———
  // ✅ ФИКС: координаты берём через RPC get_trip_details_geojson(), т.к. из trips они могут прилетать EWKB/hex
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!user?.id) return;
      if (!tripId) return;

      setLoading(true);

      // 1) Координаты/адреса/базовые поля — через RPC (GeoJSON)
      const { data: geoRows, error: geoErr } = await supabase.rpc('get_trip_details_geojson', {
        trip_id: tripId,
      });

      const geo = Array.isArray(geoRows) ? geoRows[0] : geoRows;

      // 2) Остальные поля — из trips (timezone, refund_policy, arrival_date timestamptz и т.д.)
      const { data: extra, error: extraErr } = await supabase
        .from('trips')
        .select(`
          id,
          creator_id,
          start_date,
          arrival_date,
          timezone,
          refund_policy,
          is_company_trip,
          alcohol_allowed,
          platform_fee,
          tbank_fee,
          net_amount,
          status
        `)
        .eq('id', tripId)
        .single();

      if (cancelled) return;

      if (geoErr || !geo) {
        setTimeError('Не удалось загрузить поездку (get_trip_details_geojson): ' + (geoErr?.message || 'not found'));
        setTimeout(() => setTimeError(null), 8000);
        setLoading(false);
        setTripLoaded(true);
        return;
      }

      if (extraErr) {
        // не роняем экран, но логируем
        console.warn('[useEditTrip] extra trips load error:', extraErr);
      }

      // безопасность: только создатель
      const creatorId = extra?.creator_id || geo.creator_id;
      if (creatorId && creatorId !== user.id) {
        setTimeError('Редактирование запрещено: вы не являетесь создателем этой поездки.');
        setTimeout(() => setTimeError(null), 8000);
        setLoading(false);
        setTripLoaded(true);
        return;
      }

      const tz = extra?.timezone || null;
      setTimezone(tz);

      // coords (GeoJSON coords = [lon,lat] -> YMaps [lat,lon])
      const fromCoords = parsePointToLatLon(geo.from_location);
      const toCoords = parsePointToLatLon(geo.to_location);

      // даты
      const startDateObj = geo.date ? new Date(geo.date) : null;

      // arrival_date: берём timestamptz из trips, чтобы корректно сдвигать по timezone (как было у тебя)
      let arrivalDateObj = null;
      if (extra?.arrival_date) {
        const localArrDateStr =
          shiftUtcToLocalDateStringByTimezone(extra.arrival_date, tz) ||
          new Date(extra.arrival_date).toISOString().split('T')[0];
        arrivalDateObj = new Date(localArrDateStr);
      } else if (geo.arrival_date) {
        // fallback если extra не пришёл
        arrivalDateObj = new Date(geo.arrival_date);
      }

      // fees
      const fees = calculateNetAmountAfterFees(geo.price, Number.isFinite(Number(geo.platform_fee)) ? Number(geo.platform_fee) : platformSettings.platformFeePercent, {
        cardFeePercent: Number.isFinite(Number(geo.tbank_fee)) ? Number(geo.tbank_fee) : platformSettings.tbankFeePercent,
        cardFeeMinRub: platformSettings.tbankCardFeeMinRub,
        payoutFeePercent: platformSettings.tbankPayoutFeePercent,
        payoutFeeMinRub: platformSettings.tbankPayoutFeeMinRub,
      });

      // refund policy
      const rp = extra?.refund_policy || null;
      const rpType = (rp?.type || 'standard') === 'custom';
      const fullH = rp?.full_refunded_hours ?? 1;
      const partH = rp?.partial_refunded_hours ?? '';
      const partP = rp?.partial_refunded_percent ?? '';

      const loadedImageUrls = Array.isArray(geo.image_urls) ? geo.image_urls.filter(Boolean) : [];
      const imagesMixed = loadedImageUrls.map((url) => ({ type: 'existing', url }));

      setTripData((prev) => ({
        ...prev,
        title: geo.title || '',
        description: geo.description || '',
        date: startDateObj,
        time: geo.time || '',
        arrivalDate: arrivalDateObj,
        arrivalTime: geo.arrival_time || '',
        price: geo.price != null ? String(geo.price) : '',
        difficulty: geo.difficulty || 'easy',
        ageFrom: geo.age_from != null ? Number(geo.age_from) : 18,
        ageTo: geo.age_to != null ? Number(geo.age_to) : 60,

        // ВАЖНО: для БД мы всё равно используем fromCoordinates/toCoordinates,
        // но пусть значения будут корректны (POINT(lon lat))
        fromLocation: fromCoords ? `POINT(${fromCoords[1]} ${fromCoords[0]})` : null,
        toLocation: toCoords ? `POINT(${toCoords[1]} ${toCoords[0]})` : null,

        images: imagesMixed,
        participants: geo.participants != null ? Number(geo.participants) : 1,
        leisureType: geo.leisure_type || 'tourism',

        isCompanyTrip: Boolean(extra?.is_company_trip),
        alcoholAllowed: Boolean(extra?.alcohol_allowed),

        fromAddress: geo.from_address || '',
        toAddress: geo.to_address || '',

        refund_policy_type: rpType,
        refund_policy: {
          type: rpType ? 'custom' : 'standard',
          full_refunded_hours: fullH,
          partial_refunded_hours: rpType ? partH : '',
          partial_refunded_percent: rpType ? partP : '',
          timezone: tz,
        },

        platformFee: fees.platformFee,
        tbankFee: fees.tbankFee,
        netAmount: typeof extra?.net_amount === 'number' ? extra.net_amount : fees.netAmount,
        platformFeePercentSnapshot: Number.isFinite(Number(geo.platform_fee)) ? Number(geo.platform_fee) : platformSettings.platformFeePercent,
        tbankCardFeePercentSnapshot: Number.isFinite(Number(geo.tbank_fee)) ? Number(geo.tbank_fee) : platformSettings.tbankFeePercent,
      }));

      setPreviewUrls(loadedImageUrls);
      setMainImageIndex(loadedImageUrls.length ? 0 : -1);

      // ✅ вот это теперь не будет null (если координаты есть в trips)
      setFromCoordinates(fromCoords);
      setToCoordinates(toCoords);

      setFromAddress(geo.from_address || '');
      setToAddress(geo.to_address || '');

      // центры карт
      if (fromCoords) setFromMapCenter([fromCoords[0], fromCoords[1]]);
      else if (geolocation) setFromMapCenter([geolocation.lat, geolocation.lon]);

      if (toCoords) setToMapCenter([toCoords[0], toCoords[1]]);
      else if (geolocation) setToMapCenter([geolocation.lat, geolocation.lon]);

      setTripLoaded(true);
      setLoading(false);
    };

    load();
    return () => { cancelled = true; };
  }, [user?.id, tripId, geolocation?.lat, geolocation?.lon]);

  // Когда и статусы подтянули, и поездку загрузили — можно рендерить UI
  useEffect(() => {
    if (tripLoaded) setIsReady(true);
  }, [tripLoaded]);

  // Проверка компании (если выбрано «от компании») — логика как в CreateTrip
  useEffect(() => {
    const checkCompanyVerification = async () => {
      if (user && tripData.isCompanyTrip) {
        const { data, error } = await supabase
          .from('mycompany')
          .select('tbank_registered, tbank_shop_code, payment_account, account')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .single();

        if (error && error.code !== 'PGRST116') {
          setCompanyVerificationStatus('error');
          setShowPopup(true);
          setTimeout(() => setShowPopup(false), 6000);
        } else if (data && data.tbank_registered && data.tbank_shop_code && (data.payment_account || data.account)) {
          setCompanyVerificationStatus('verified');
        } else {
          setCompanyVerificationStatus('not_verified');
          // если компания не ок — откатываем на физ.лицо
          setTripData(prev => ({ ...prev, isCompanyTrip: false }));
          setShowPopup(true);
          setTimeout(() => setShowPopup(false), 6000);
        }
      }
    };
    checkCompanyVerification();
  }, [tripData.isCompanyTrip, user]);

  const setFromMapCenterFromProfile = async () => {
    if (user) {
      const { data, error } = await supabase
        .from('profiles')
        .select('geo_lat, geo_lon')
        .eq('user_id', user.id)
        .single();

      if (error || !data || !data.geo_lat || !data.geo_lon) {
        setFromMapCenter([55.751244, 37.618423]);
      } else {
        const coords = [parseFloat(data.geo_lat), parseFloat(data.geo_lon)];
        setFromMapCenter(coords);
      }
    } else {
      setFromMapCenter([55.751244, 37.618423]);
    }
  };

  const setToMapCenterFromProfile = async () => {
    if (user) {
      const { data, error } = await supabase
        .from('profiles')
        .select('geo_lat, geo_lon')
        .eq('user_id', user.id)
        .single();

      if (error || !data || !data.geo_lat || !data.geo_lon) {
        setToMapCenter([55.751244, 37.618423]);
      } else {
        const coords = [parseFloat(data.geo_lat), parseFloat(data.geo_lon)];
        setToMapCenter(coords);
      }
    } else {
      setToMapCenter([55.751244, 37.618423]);
    }
  };

  // если координат нет (редко), пробуем выставить центр по профилю
  useEffect(() => {
    if (!fromCoordinates && !geolocation && user?.id) setFromMapCenterFromProfile();
    if (!toCoordinates && !geolocation && user?.id) setToMapCenterFromProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const getAddress = (coords, setAddress) => {
    if (coords && window.ymaps && typeof window.ymaps.geocode === 'function') {
      window.ymaps.ready(() => {
        window.ymaps.geocode(coords).then((res) => {
          const firstGeoObject = res.geoObjects.get(0);
          const addr = firstGeoObject ? firstGeoObject.getAddressLine() : 'Адрес не найден';
          setAddress(addr);
        }).catch(() => {
          setAddress('Ошибка получения адреса');
        });
      });
    }
  };

  // ——— те же handleChange/валидации что и в CreateTrip (бережно) ———
  const handleChange = (e) => {
    const { name, value } = e.target;

    if (name === 'date') {
      const newDate = value ? new Date(value) : null;
      setTripData(prev => {
        const updatedData = { ...prev, date: newDate };
        if (updatedData.arrivalDate && newDate && updatedData.arrivalDate.getTime() < newDate.getTime()) {
          const newArrivalDate = new Date(newDate);
          let newArrivalTime = updatedData.arrivalTime;
          if (updatedData.time) {
            const [departHours, departMinutes] = updatedData.time.split(':').map(Number);
            const newArriveHours = departHours + 1;
            newArrivalTime = `${newArriveHours.toString().padStart(2, '0')}:${departMinutes.toString().padStart(2, '0')}`;
            setTimeError('Дата прибытия обновлена до даты отправления, время приезда установлено на +1 час.');
            setTimeout(() => setTimeError(null), 6000);
          } else {
            newArrivalTime = '';
          }
          return {
            ...updatedData,
            arrivalDate: newArrivalDate,
            arrivalTime: newArrivalTime,
          };
        }
        return updatedData;
      });
    } else if (name === 'arrivalDate') {
      const newArrivalDate = value ? new Date(value) : null;
      if (newArrivalDate && tripData.date && newArrivalDate.getTime() < tripData.date.getTime()) {
        setTimeError('Дата приезда не может быть меньше даты отправления.');
        setTimeout(() => setTimeError(null), 6000);
        return;
      }
      setTripData(prev => {
        const updatedData = { ...prev, [name]: newArrivalDate };
        if (
          updatedData.date &&
          newArrivalDate &&
          updatedData.date.toDateString() === newArrivalDate.toDateString() &&
          updatedData.time &&
          updatedData.arrivalTime
        ) {
          const [departHours, departMinutes] = updatedData.time.split(':').map(Number);
          const [arriveHours, arriveMinutes] = updatedData.arrivalTime.split(':').map(Number);
          const departTotalMinutes = departHours * 60 + departMinutes;
          const arriveTotalMinutes = arriveHours * 60 + arriveMinutes;
          const minArriveTotalMinutes = departTotalMinutes + 60;

          if (arriveTotalMinutes < minArriveTotalMinutes) {
            const newArriveHours = departHours + 1;
            const newArriveTime = `${newArriveHours.toString().padStart(2, '0')}:${departMinutes.toString().padStart(2, '0')}`;
            setTimeError('Время приезда должно быть как минимум на 1 час позже времени отправления при одинаковых датах.');
            setTimeout(() => setTimeError(null), 6000);
            updatedData.arrivalTime = newArriveTime;
          }
        }
        return updatedData;
      });
    } else if (name === 'time') {
      setTripData(prev => {
        const updatedData = { ...prev, [name]: value };
        if (
          updatedData.date &&
          updatedData.arrivalDate &&
          updatedData.date.toDateString() === updatedData.arrivalDate.toDateString() &&
          updatedData.arrivalTime
        ) {
          const [departHours, departMinutes] = value.split(':').map(Number);
          const [arriveHours, arriveMinutes] = updatedData.arrivalTime.split(':').map(Number);
          const departTotalMinutes = departHours * 60 + departMinutes;
          const arriveTotalMinutes = arriveHours * 60 + arriveMinutes;
          const minArriveTotalMinutes = departTotalMinutes + 60;

          if (arriveTotalMinutes < minArriveTotalMinutes) {
            const newArriveHours = departHours + 1;
            const newArriveTime = `${newArriveHours.toString().padStart(2, '0')}:${departMinutes.toString().padStart(2, '0')}`;
            setTimeError('Время приезда должно быть как минимум на 1 час позже времени отправления при одинаковых датах.');
            setTimeout(() => setTimeError(null), 6000);
            updatedData.arrivalTime = newArriveTime;
          }
        }
        return updatedData;
      });
    } else if (name === 'arrivalTime') {
      const [departHours, departMinutes] = tripData.time ? tripData.time.split(':').map(Number) : [0, 0];
      const [arriveHours, arriveMinutes] = value.split(':').map(Number);
      const departTotalMinutes = departHours * 60 + departMinutes;
      const arriveTotalMinutes = arriveHours * 60 + arriveMinutes;
      const minArriveTotalMinutes = departTotalMinutes + 60;

      if (
        tripData.date &&
        tripData.arrivalDate &&
        tripData.time &&
        tripData.date.toDateString() === tripData.arrivalDate.toDateString() &&
        arriveTotalMinutes < minArriveTotalMinutes
      ) {
        const newArriveHours = departHours + 1;
        const newArriveTime = `${newArriveHours.toString().padStart(2, '0')}:${departMinutes.toString().padStart(2, '0')}`;
        setTimeError('Время приезда должно быть как минимум на 1 час позже времени отправления при одинаковых датах.');
        setTimeout(() => setTimeError(null), 6000);
        setTripData({ ...tripData, [name]: newArriveTime });
        return;
      }
      setTripData({ ...tripData, [name]: value });
    } else if (name === 'price') {
      const fees = calculateFees(value);
      setTripData(prev => ({
        ...prev,
        [name]: value,
        platformFee: fees.platformFee,
        tbankFee: fees.tbankFee,
        netAmount: fees.netAmount,
      }));
    } else if (name === 'isCompanyTrip') {
      // защита переключателя (как в CreateTrip)
      const wantCompany = value === 'true';
      if (!wantCompany && !hasValidCard) {
        setTimeError('Чтобы сохранить поездку как физ. лицо, привяжите карту в «Настройки → Мои карты».');
        setTimeout(() => setTimeError(null), 6000);
        setTripData(prev => ({ ...prev, isCompanyTrip: true }));
        return;
      }
      if (wantCompany && !hasCompanyOk) {
        setTimeError('Чтобы сохранить поездку от лица компании, зарегистрируйте компанию в разделе (Настройки → Компании).');
        setTimeout(() => setTimeError(null), 6000);
        setTripData(prev => ({ ...prev, isCompanyTrip: false }));
        return;
      }
      setTripData(prev => ({ ...prev, isCompanyTrip: wantCompany }));
    } else if (name === 'alcoholAllowed') {
      setTripData({ ...tripData, [name]: value === 'true' });
    } else if (name === 'refund_policy_type') {
      const isCustom = value === 'true';
      setTripData(prev => ({
        ...prev,
        refund_policy_type: isCustom,
        refund_policy: {
          ...prev.refund_policy,
          type: isCustom ? 'custom' : 'standard',
          full_refunded_hours: isCustom ? prev.refund_policy.full_refunded_hours : 1,
          partial_refunded_hours: isCustom ? prev.refund_policy.partial_refunded_hours : '',
          partial_refunded_percent: isCustom ? prev.refund_policy.partial_refunded_percent : '',
          timezone: timezone || prev.refund_policy.timezone,
        },
      }));
    } else if (name === 'refund_policy.full_refunded_hours') {
      const newFullHours = value === '' ? '' : parseInt(value);
      setTripData(prev => {
        let newPartialHours = prev.refund_policy.partial_refunded_hours;
        if (newFullHours !== '' && newPartialHours !== '' && newFullHours <= parseInt(newPartialHours)) {
          newPartialHours = Math.max(0, newFullHours - 1);
          setRefundError('Срок полного возврата должен быть больше срока частичного. Срок частичного возврата уменьшен.');
          setTimeout(() => setRefundError(null), 6000);
        }
        return {
          ...prev,
          refund_policy: {
            ...prev.refund_policy,
            full_refunded_hours: newFullHours === '' ? '' : Math.max(1, newFullHours),
            partial_refunded_hours: newPartialHours,
            timezone: timezone || prev.refund_policy.timezone,
          },
        };
      });
    } else if (name === 'refund_policy.partial_refunded_hours') {
      const newPartialHours = value === '' ? '' : parseInt(value);
      setTripData(prev => {
        let newFullHours = prev.refund_policy.full_refunded_hours;
        if (newPartialHours !== '' && newFullHours !== '' && parseInt(newPartialHours) >= parseInt(newFullHours)) {
          newFullHours = parseInt(newPartialHours) + 1;
          setRefundError('Срок частичного возврата не может быть равен или больше срока полного. Срок полного возврата увеличен.');
          setTimeout(() => setRefundError(null), 6000);
        }
        return {
          ...prev,
          refund_policy: {
            ...prev.refund_policy,
            partial_refunded_hours: newPartialHours,
            full_refunded_hours: newFullHours,
            timezone: timezone || prev.refund_policy.timezone,
          },
        };
      });
    } else if (name === 'refund_policy.partial_refunded_percent') {
      const newPercent = value === '' ? '' : parseInt(value);
      setTripData(prev => ({
        ...prev,
        refund_policy: {
          ...prev.refund_policy,
          partial_refunded_percent: newPercent,
          timezone: timezone || prev.refund_policy.timezone,
        },
      }));
    } else if (name === 'ageFrom') {
      const newAgeFrom = parseInt(value) || 18;
      setTripData(prev => {
        let newAgeTo = prev.ageTo;
        if (newAgeFrom > prev.ageTo) {
          newAgeTo = newAgeFrom;
          setTimeError('Возраст "От" не может быть больше возраста "До". Возраст "До" обновлён.');
          setTimeout(() => setTimeError(null), 6000);
        }
        return { ...prev, ageFrom: newAgeFrom, ageTo: newAgeTo };
      });
    } else if (name === 'ageTo') {
      const newAgeTo = parseInt(value) || 60;
      setTripData(prev => {
        let newAgeFrom = prev.ageFrom;
        if (newAgeTo < prev.ageFrom) {
          newAgeFrom = newAgeTo;
          setTimeError('Возраст "До" не может быть меньше возраста "От". Возраст "От" обновлён.');
          setTimeout(() => setTimeError(null), 6000);
        }
        return { ...prev, ageFrom: newAgeFrom, ageTo: newAgeTo };
      });
    } else {
      setTripData({ ...tripData, [name]: value });
    }
  };

  const fetchTimezone = async (lat, lng) => {
    const maxAttempts = 3;

    // GeoNames
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const username = process.env.NEXT_PUBLIC_GEONAMES_USERNAME;
        if (!username) throw new Error('Имя пользователя GeoNames не настроено в переменных окружения');
        const url = `https://secure.geonames.org/timezoneJSON?lat=${lat}&lng=${lng}&username=${username}`;
        const response = await fetch(url);
        if (response.status === 401) throw new Error('Ошибка авторизации GeoNames. Проверьте имя пользователя и активацию веб-сервисов.');
        const data = await response.json();

        if (data.timezoneId && data.rawOffset !== undefined) {
          const offsetHours = data.rawOffset;
          return `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`;
        }
      } catch (error) {
        setTimezoneError(`Ошибка GeoNames (попытка ${attempt}): ${error.message}`);
        setTimeout(() => setTimezoneError(null), 6000);
      }
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // TimeZoneDB fallback
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const apiKey = process.env.NEXT_PUBLIC_TIMEZONEDB_API_KEY;
        if (!apiKey) throw new Error('Ключ API TimeZoneDB не настроен в переменных окружения');
        const url = `https://api.timezonedb.com/v2.1/get-time-zone?key=${apiKey}&format=json&by=position&lat=${lat}&lng=${lng}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'OK') {
          const offsetHours = data.gmtOffset / 3600;
          return `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`;
        }
      } catch (error) {
        setTimezoneError(`Ошибка TimeZoneDB (попытка ${attempt}): ${error.message}`);
        setTimeout(() => setTimezoneError(null), 6000);
      }
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return null;
  };

  // мягкий ретрай NSFW-проверки (как в CreateTrip)
  const checkWithRetry = async (file, tries = 3) => {
    let last = null;
    for (let i = 1; i <= tries; i++) {
      try {
        const r = await checkImageWithVkNsfw(file);
        last = r;
        if (r && !r.skipped) return r;
      } catch (e) {
        last = { allowed: false, error: e?.message || 'nsfw failed' };
      }
      await new Promise(res => setTimeout(res, 300 * i));
    }
    return last;
  };

  // В EditTrip добавляем ТОЛЬКО новые фото, существующие уже в previewUrls
  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files || []);
    const maxImages = 4;
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

    const currentCount = Array.isArray(tripData.images) ? tripData.images.length : 0;

    const validFiles = await Promise.all(files.map(async (file) => {
      try {
        let fileType = file.type;
        let fileName = file.name || `image_${Date.now()}.jpg`;

        if (!fileType || fileType === 'application/octet-stream') {
          const extension = fileName.split('.').pop().toLowerCase();
          const extensionToMime = {
            'jpg': 'image/jpeg','jpeg': 'image/jpeg','png': 'image/png',
            'webp': 'image/webp','heic': 'image/heic','heif': 'image/heif',
          };
          fileType = extensionToMime[extension] || 'image/jpeg';
        }
        if (!validTypes.includes(fileType)) return null;

        const blob = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(new Blob([reader.result], { type: fileType }));
          reader.onerror = () => reject(new Error(`Ошибка чтения файла ${fileName}`));
          reader.readAsArrayBuffer(file);
        });

        return new File([blob], fileName, { type: fileType });
      } catch {
        return null;
      }
    }));

    const filteredValidFiles = validFiles.filter(Boolean);
    if (filteredValidFiles.length !== files.length) {
      setTimeError('Некоторые файлы не поддерживаются. Допустимы JPEG, PNG, WebP, HEIC, HEIF.');
      setTimeout(() => setTimeError(null), 6000);
    }
    if (!filteredValidFiles.length) {
      setTimeError('Не удалось обработать выбранные файлы. Попробуйте другие изображения.');
      setTimeout(() => setTimeError(null), 6000);
      return;
    }

    if (currentCount + filteredValidFiles.length > maxImages) {
      setTimeError(`Максимальное количество фотографий — ${maxImages}. Вы выбрали ${filteredValidFiles.length}, а уже загружено ${currentCount}.`);
      setTimeout(() => setTimeError(null), 6000);
      return;
    }

    const compressedFiles = await Promise.all(filteredValidFiles.map(async (file) => {
      try {
        if (!file || !file.size || !file.type) return null;
        if (file.type === 'image/heic' || file.type === 'image/heif') return file;

        if (file.size > 5 * 1024 * 1024) {
          const compressed = await imageCompression(file, { maxSizeMB: 5, useWebWorker: true, initialQuality: 0.8 });
          return compressed;
        }
        return file;
      } catch {
        return file;
      }
    }));

    const finalFiles = compressedFiles.filter(Boolean);
    if (!finalFiles.length) {
      setTimeError('Не удалось обработать изображения. Попробуйте другие файлы.');
      setTimeout(() => setTimeError(null), 6000);
      return;
    }

    // === NSFW VK Cloud (индикация + прогресс + ретраи) ===
    setNsfwChecking(true);
    setNsfwProgress({ done: 0, total: finalFiles.length });

    const nsfwResults = [];
    const safeFiles = [];
    for (let i = 0; i < finalFiles.length; i++) {
      const f = finalFiles[i];
      try {
        console.debug('[NSFW][edit-trip] checking file:', f?.name, f?.type, f?.size);
        const r = await checkWithRetry(f, 3);
        nsfwResults.push({ name: f?.name || 'image.jpg', ...r });
        if (r?.allowed) safeFiles.push(f);
        else console.warn('[NSFW][edit-trip] rejected by NSFW:', f?.name, r);
      } catch (err) {
        console.error('[NSFW][edit-trip] error for file:', f?.name, err);
        nsfwResults.push({ name: f?.name || 'image.jpg', allowed: false, error: err?.message || 'NSFW check failed' });
      } finally {
        setNsfwProgress((p) => ({ done: Math.min(p.done + 1, finalFiles.length), total: finalFiles.length }));
      }
      await new Promise(res => setTimeout(res, 50));
    }

    setNsfwChecking(false);

    const denied = nsfwResults.filter(x => !x.allowed);
    if (denied.length) {
      setTimeError(`Некоторые изображения отклонены проверкой 18+: ${denied.map(x => x.name).join(', ')}`);
      setTimeout(() => setTimeError(null), 8000);
    }
    if (!safeFiles.length) return;

    const safeMixed = safeFiles.map((file) => ({ type: 'new', file }));

    const newImages = [...(tripData.images || []), ...safeMixed];
    const newPreviewUrls = [
      ...previewUrls,
      ...safeFiles.map(file => { try { return URL.createObjectURL(file); } catch { return null; } }).filter(Boolean)
    ];

    setTripData({ ...tripData, images: newImages });
    setPreviewUrls(newPreviewUrls);
    if (newImages.length === 1) setMainImageIndex(0);
  };

  const handleRemoveImage = (index) => {
    const images = Array.isArray(tripData.images) ? tripData.images : [];
    const removed = images[index];

    // если удаляем new — можно ревокнуть objectURL
    const removedPreview = previewUrls[index];
    if (removed?.type === 'new' && removedPreview && typeof removedPreview === 'string') {
      try { URL.revokeObjectURL(removedPreview); } catch {}
    }

    const newImages = images.filter((_, i) => i !== index);
    const newPreviewUrls = previewUrls.filter((_, i) => i !== index);

    setTripData({ ...tripData, images: newImages });
    setPreviewUrls(newPreviewUrls);

    if (index === mainImageIndex) {
      setMainImageIndex(newImages.length > 0 ? 0 : -1);
    } else if (mainImageIndex > index) {
      setMainImageIndex(mainImageIndex - 1);
    }
  };

  const handleSetMainImage = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    setMainImageIndex(index);
  };

  const handleImageUpload = () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.onchange = handleFileChange;
    fileInput.click();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    if (!tripId) {
      setTimeError('Не найден tripId для редактирования.');
      setTimeout(() => setTimeError(null), 6000);
      setLoading(false);
      return;
    }

    // Дата/время отправления
    if (!tripData.date || !tripData.time) {
      setTimeError('Пожалуйста, укажите дату и время отправления.');
      setTimeout(() => setTimeError(null), 6000);
      setLoading(false);
      return;
    }

    // Дата/время приезда
    if (!tripData.arrivalDate || !tripData.arrivalTime) {
      setTimeError('Пожалуйста, укажите дату и время приезда.');
      setTimeout(() => setTimeError(null), 6000);
      setLoading(false);
      return;
    }

    // Координаты
    if (!fromCoordinates || !toCoordinates) {
      setTimeError('Пожалуйста, укажите место отправления и место прибытия на карте.');
      setTimeout(() => setTimeError(null), 6000);
      setLoading(false);
      return;
    }

    // Пользователь
    if (!user) {
      setTimeError('Не удалось определить пользователя. Пожалуйста, войдите в систему.');
      setTimeout(() => setTimeError(null), 6000);
      setLoading(false);
      return;
    }

    // Проверка компании при флаге "поездка от лица компании"
    if (tripData.isCompanyTrip) {
      const { data, error } = await supabase
        .from('mycompany')
        .select('tbank_registered, tbank_shop_code, payment_account, account')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single();

      if (error && error.code !== 'PGRST116') {
        setCompanyVerificationStatus('error');
        setShowPopup(true);
        setTimeout(() => setShowPopup(false), 6000);
        setLoading(false);
        return;
      }
      if (!data || !data.tbank_registered || !data.tbank_shop_code || !(data.payment_account || data.account)) {
        setCompanyVerificationStatus('not_verified');
        setTripData(prev => ({ ...prev, isCompanyTrip: false }));
        setShowPopup(true);
        setTimeout(() => setShowPopup(false), 6000);
        setLoading(false);
        return;
      }
    }

    // Доп. проверка карт — ТОЛЬКО если поездка от физ. лица
    if (!tripData.isCompanyTrip) {
      const { data: cards, error: cardsErr } = await supabase
        .from('user_cards')
        .select('is_primary, expiry_date')
        .eq('user_id', user.id);

      const hasPrimaryValid =
        !cardsErr &&
        Array.isArray(cards) &&
        cards.some(c => c?.is_primary && !isCardExpired(c?.expiry_date));

      if (!hasPrimaryValid) {
        setCompanyVerificationStatus('cards_required');
        setShowPopup(true);
        setTimeout(() => setShowPopup(false), 6000);
        setLoading(false);
        return;
      }
    }

    // Валидации цены/кол-ва
    if (tripData.price < 0 || tripData.price > 1000000) {
      setTimeError('Цена должна быть от 0 до 1,000,000 рублей.');
      setTimeout(() => setTimeError(null), 6000);
      setLoading(false);
      return;
    }

    if (tripData.netAmount < 0) {
      setTimeError('Итоговая сумма после комиссий не может быть отрицательной.');
      setTimeout(() => setTimeError(null), 6000);
      setLoading(false);
      return;
    }

    if (tripData.participants < 1) {
      setTimeError('Количество участников должно быть не менее 1.');
      setTimeout(() => setTimeError(null), 6000);
      setLoading(false);
      return;
    }

    if (tripData.refund_policy.type === 'custom') {
      const fullHours = parseInt(tripData.refund_policy.full_refunded_hours);
      const partialHours = parseInt(tripData.refund_policy.partial_refunded_hours);
      const partialPercent = parseInt(tripData.refund_policy.partial_refunded_percent);

      if (fullHours < partialHours) {
        setRefundError('Полный возврат должен быть возможен дольше, чем частичный.');
        setTimeout(() => setRefundError(null), 6000);
        setLoading(false);
        return;
      }
      if (partialPercent < 0 || partialPercent > 100) {
        setRefundError('Процент частичного возврата должен быть от 0 до 100.');
        setTimeout(() => setRefundError(null), 6000);
        setLoading(false);
        return;
      }
      if (fullHours < 1) {
        setRefundError('Полный возврат должен быть возможен как минимум за 1 час.');
        setTimeout(() => setRefundError(null), 6000);
        setLoading(false);
        return;
      }
    }

    // Контроль +1 час при одинаковых датах
    if (
      tripData.date && tripData.arrivalDate && tripData.time && tripData.arrivalTime &&
      tripData.date.toDateString() === tripData.arrivalDate.toDateString()
    ) {
      const [departHours, departMinutes] = tripData.time.split(':').map(Number);
      const [arriveHours, arriveMinutes] = tripData.arrivalTime.split(':').map(Number);
      const departTotalMinutes = departHours * 60 + departMinutes;
      const arriveTotalMinutes = arriveHours * 60 + arriveMinutes;
      const minArriveTotalMinutes = departTotalMinutes + 60;

      if (arriveTotalMinutes < minArriveTotalMinutes) {
        const newArriveHours = departHours + 1;
        const newArriveTime = `${newArriveHours.toString().padStart(2, '0')}:${departMinutes.toString().padStart(2, '0')}`;
        setTimeError('Время приезда должно быть как минимум на 1 час позже времени отправления при одинаковых датах.');
        setTimeout(() => setTimeError(null), 6000);
        setTripData(prev => ({ ...prev, arrivalTime: newArriveTime }));
        setLoading(false);
        return;
      }
    }

    // timezone: при редактировании обычно уже есть, но если нет — повторяем поведение CreateTrip
    let finalTimezone = timezone;

    if (!showTimezoneInput && !timezone && fromCoordinates) {
      const fetchedTimezone = await fetchTimezone(fromCoordinates[0], fromCoordinates[1]);
      if (fetchedTimezone) {
        setTimezone(fetchedTimezone);
        finalTimezone = fetchedTimezone;
      } else {
        setTimezoneError('Не удалось определить часовой пояс по координатам. Выберите часовой пояс вручную.');
        setShowTimezoneInput(true);
        setLoading(false);
        return;
      }
    }

    if (!finalTimezone) {
      setTimeError('Часовой пояс не определён. Выберите часовой пояс.');
      setTimeout(() => setTimeError(null), 6000);
      setShowTimezoneInput(true);
      setLoading(false);
      return;
    }

// ✅ Блокировка редактирования, если уже есть участники (кроме rejected)
try {
  const { count, error: cntErr } = await supabase
    .from('trip_participants')
    .select('id', { count: 'exact', head: true })
    .eq('trip_id', tripId)
    .neq('status', 'rejected');

  if (cntErr) {
    console.warn('[useEditTrip] participants count error:', cntErr);
    setTimeError('Не удалось проверить участников. Попробуйте позже.');
    setTimeout(() => setTimeError(null), 7000);
    setLoading(false);
    return;
  }

  if ((count || 0) > 0) {
    setTimeError(
      'Изменение поездки недоступно, потому что в поездке уже есть участники. ' +
      'Исключите участников и попробуйте снова. '
    );
    setTimeout(() => setTimeError(null), 9000);
    setLoading(false);
    return;
  }
} catch (e) {
  console.warn('[useEditTrip] participants check exception:', e);
  setTimeError('Не удалось проверить участников. Попробуйте позже.');
  setTimeout(() => setTimeError(null), 7000);
  setLoading(false);
  return;
}


    // Геометрия
    let fromLocation = null;
    if (fromCoordinates) {
      fromLocation = `POINT(${fromCoordinates[1]} ${fromCoordinates[0]})`;
    }

    let toLocationPoint = null;
    if (toCoordinates) {
      toLocationPoint = `POINT(${toCoordinates[1]} ${toCoordinates[0]})`;
    }

    // Конвертация времени в UTC (как в CreateTrip)
    const convertToUTC = (date, time, timezone) => {
      if (!date || !time || !timezone) return null;
      const match = timezone.match(/UTC([+-])(\d+)/);
      if (!match) return null;
      const sign = match[1] === '+' ? 1 : -1;
      const offsetHours = parseInt(match[2]) * sign;
      const localDateTimeStr = `${date.toISOString().split('T')[0]}T${time}:00Z`;
      const tempDate = new Date(localDateTimeStr);
      const utcDateTime = new Date(tempDate.getTime() - offsetHours * 60 * 60 * 1000);
      return utcDateTime;
    };

    const startDate = convertToUTC(tripData.date, tripData.time, finalTimezone);
    const arrivalDate = convertToUTC(tripData.arrivalDate, tripData.arrivalTime, finalTimezone);

    // === Фото: сохраняем existing url + загружаем новые ===
    const images = Array.isArray(tripData.images) ? tripData.images : [];

    const currentDate = new Date();
    const day = String(currentDate.getDate()).padStart(2, '0');
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const year = currentDate.getFullYear();
    const folderName = `trips/${day}-${month}-${year}`;

    const imageUrls = [];

    for (let i = 0; i < images.length; i++) {
      const item = images[i];

      // существующее
      if (item?.type === 'existing' && item?.url) {
        imageUrls.push(item.url);
        continue;
      }

      // новое
      const file = item?.type === 'new' ? item?.file : null;
      if (!file) continue;

      const sanitizedName = sanitizeFileName(file.name);
      const filePath = `${folderName}/${Date.now()}_${i}_${sanitizedName}`;

      const { error: upErr } = await supabase.storage
        .from('photos')
        .upload(filePath, file, { upsert: true });

      if (upErr) {
        setTimeError(`Ошибка загрузки изображения ${file.name}: ${upErr.message}`);
        setTimeout(() => setTimeError(null), 6000);
        setLoading(false);
        return;
      }

      const { data: publicUrlData } = supabase.storage
        .from('photos')
        .getPublicUrl(filePath);

      if (!publicUrlData.publicUrl) {
        setTimeError(`Не удалось получить URL для изображения ${sanitizedName}`);
        setTimeout(() => setTimeError(null), 6000);
        setLoading(false);
        return;
      }

      imageUrls.push(publicUrlData.publicUrl);
    }

    // главное фото — переносим в начало
    if (mainImageIndex >= 0 && imageUrls.length > mainImageIndex) {
      const mainUrl = imageUrls.splice(mainImageIndex, 1)[0];
      imageUrls.unshift(mainUrl);
    }

    const tripPayload = {
      title: tripData.title,
      description: tripData.description,
      start_date: startDate,
      date: tripData.date ? tripData.date.toISOString().split('T')[0] : null,
      time: tripData.time || null,
      arrival_date: arrivalDate,
      arrival_time: tripData.arrivalTime || null,
      price: parseFloat(tripData.price),
      difficulty: tripData.difficulty,
      age_from: parseInt(tripData.ageFrom),
      age_to: parseInt(tripData.ageTo),
      from_location: fromLocation,
      to_location: toLocationPoint,
      image_urls: imageUrls,
      participants: parseInt(tripData.participants),
      leisure_type: tripData.leisureType,
      is_company_trip: tripData.isCompanyTrip,
      alcohol_allowed: tripData.alcoholAllowed,
      from_address: fromAddress,
      to_address: toAddress,
      timezone: finalTimezone,
      refund_policy: {
        ...tripData.refund_policy,
        full_refunded_hours: parseInt(tripData.refund_policy.full_refunded_hours) || 1,
        partial_refunded_hours: parseInt(tripData.refund_policy.partial_refunded_hours) || 0,
        partial_refunded_percent: parseInt(tripData.refund_policy.partial_refunded_percent) || 0,
        timezone: finalTimezone,
      },
      // В БД сохраняем ПРОЦЕНТЫ, а не суммы:
      platform_fee: tripData.platformFeePercentSnapshot,
      tbank_fee: tripData.tbankCardFeePercentSnapshot,
      // Снимок нетто
      net_amount: tripData.netAmount,
    };

    const { error: updErr } = await supabase
      .from('trips')
      .update(tripPayload)
      .eq('id', tripId)
      .eq('creator_id', user.id);

    if (updErr) {
      setTimeError('Ошибка при сохранении изменений: ' + updErr.message);
      setTimeout(() => setTimeError(null), 8000);
    } else {
      setTimeError('Изменения успешно сохранены!');
      setTimeout(() => setTimeError(null), 6000);

      // ВАЖНО: не сбрасываем форму (редактирование), просто обновляем previewUrls из актуального порядка
      setPreviewUrls(imageUrls);
      setMainImageIndex(imageUrls.length ? 0 : -1);

      // и синхронизируем images -> existing (чтобы повторное сохранение не перезаливало файлы)
      setTripData((prev) => ({
        ...prev,
        images: imageUrls.map((url) => ({ type: 'existing', url })),
      }));
    }

    setLoading(false);
  };

  const handleTimezoneChange = (e) => {
    const newTimezone = e.target.value;
    setTimezone(newTimezone);
    setTripData(prev => ({
      ...prev,
      refund_policy: {
        ...prev.refund_policy,
        timezone: newTimezone,
      },
    }));
    setTimezoneError(null);
  };

  const handleTimezoneSubmit = (e) => {
    e.preventDefault();
    if (timezone) {
      handleSubmit(e);
    } else {
      setTimeError('Пожалуйста, выберите часовой пояс.');
      setTimeout(() => setTimeError(null), 6000);
    }
  };

  const openLocationFrom = () => {
    if (fromCoordinates) setFromMapCenter([fromCoordinates[0], fromCoordinates[1]]);
    else if (geolocation) setFromMapCenter([geolocation.lat, geolocation.lon]);
    setIsLocationFromOpen(true);
  };

  const openLocationTo = () => {
    if (toCoordinates) setToMapCenter([toCoordinates[0], toCoordinates[1]]);
    else if (geolocation) setToMapCenter([geolocation.lat, geolocation.lon]);
    setIsLocationToOpen(true);
  };

  const closeLocationFrom = () => setIsLocationFromOpen(false);
  const closeLocationTo = () => setIsLocationToOpen(false);

  const handleLocationFromOk = () => {
    getAddress(fromCoordinates, setFromAddress);
    setTripData(prev => ({ ...prev, fromAddress }));
    setIsLocationFromOpen(false);
  };

  const handleLocationToOk = () => {
    if (toCoordinates) {
      const geoJson = JSON.stringify({ type: 'Point', coordinates: toCoordinates });
      getAddress(toCoordinates, setToAddress);
      setTripData(prev => ({ ...prev, toLocation: geoJson, toAddress }));
    }
    setIsLocationToOpen(false);
  };

  const fromMapDefaultState = { center: fromMapCenter, zoom: 10 };
  const toMapDefaultState = { center: toMapCenter, zoom: 10 };
  const minArrivalDate = tripData.date ? tripData.date.toISOString().split('T')[0] : today;

  return {
    isReady,
    tripData,
    previewUrls,
    isLocationFromOpen,
    isLocationToOpen,
    loading,
    fromCoordinates,
    toCoordinates,
    fromAddress,
    toAddress,
    mainImageIndex,
    fromMapCenter,
    toMapCenter,
    companyVerificationStatus,
    showPopup,
    today,
    minArrivalDate,
    fromMapDefaultState,
    toMapDefaultState,
    setTripData,
    setPreviewUrls,
    setFromCoordinates,
    setToCoordinates,
    setMainImageIndex,
    handleChange,
    handleFileChange,
    handleRemoveImage,
    handleSetMainImage,
    handleSubmit,
    handleImageUpload,
    openLocationFrom,
    openLocationTo,
    closeLocationFrom,
    closeLocationTo,
    handleLocationFromOk,
    handleLocationToOk,
    timezone,
    showTimezoneInput,
    timezoneError,
    handleTimezoneChange,
    handleTimezoneSubmit,
    commonTimezones,
    refundError,
    timeError,
    hasValidCard,
    hasCompanyOk,
    nsfwChecking,
    nsfwProgress,
  };
};
