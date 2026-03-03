import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { supabase } from './supabaseClient';
import imageCompression from 'browser-image-compression';
import { useAuth } from '../pages/_app';
import { platformSettings } from './platformSettings';
import { calculateNetAmountAfterFees } from './tbankFees';
import { checkImageWithVkNsfw } from './vkcloud/nsfwClient'; // ⬅️ NSFW-проверка VK Cloud (+ логи)

// ——— helpers ———
const sanitizeFileName = (fileName) => {
  return String(fileName || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_.]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
};

export const useCreateTrip = (toLocation) => {
  const router = useRouter();
  const { user, geolocation, session } = useAuth();

  const [isReady, setIsReady] = useState(false);
  const [timezone, setTimezone] = useState(null);
  const [showTimezoneInput, setShowTimezoneInput] = useState(false);
  const [timezoneError, setTimezoneError] = useState(null);
  const [companyVerificationStatus, setCompanyVerificationStatus] = useState(null);
  const [showPopup, setShowPopup] = useState(false);
  const [refundError, setRefundError] = useState(null);
  const [timeError, setTimeError] = useState(null);
  const [loading, setLoading] = useState(false);

  // NEW: статусы платёжных реквизитов
  const [hasValidCard, setHasValidCard] = useState(false);
  const [hasCompanyOk, setHasCompanyOk] = useState(false);
  const [initialModeDecided, setInitialModeDecided] = useState(false);

  // NEW: индикация проверки NSFW
  const [nsfwChecking, setNsfwChecking] = useState(false);
  const [nsfwProgress, setNsfwProgress] = useState({ done: 0, total: 0 });

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
    toLocation: toLocation || null,
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
  });

  const [previewUrls, setPreviewUrls] = useState([]);
  const [isLocationFromOpen, setIsLocationFromOpen] = useState(false);
  const [isLocationToOpen, setIsLocationToOpen] = useState(false);
  const [fromCoordinates, setFromCoordinates] = useState(null);
  const [toCoordinates, setToCoordinates] = useState(toLocation ? JSON.parse(toLocation).coordinates : null);
  const [fromAddress, setFromAddress] = useState('');
  const [toAddress, setToAddress] = useState('');
  const [mainImageIndex, setMainImageIndex] = useState(0);
  const [fromMapCenter, setFromMapCenter] = useState([55.751244, 37.618423]);
  const [toMapCenter, setToMapCenter] = useState([55.751244, 37.618423]);

  const todayLocal = new Date();
  const today = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}-${String(todayLocal.getDate()).padStart(2, '0')}`;

  const calculateFees = (price) => {
    const priceNum = parseFloat(price) || 0;
    return calculateNetAmountAfterFees(priceNum, platformSettings.platformFeePercent, {
      cardFeePercent: platformSettings.tbankFeePercent,
      cardFeeMinRub: platformSettings.tbankCardFeeMinRub,
      payoutFeePercent: platformSettings.tbankPayoutFeePercent,
      payoutFeeMinRub: platformSettings.tbankPayoutFeeMinRub,
    });
  };
useEffect(() => {
  setTripData(prev => ({ ...prev, fromAddress }));
}, [fromAddress]);

useEffect(() => {
  setTripData(prev => ({ ...prev, toAddress }));
}, [toAddress]);

  useEffect(() => {
    const restoreRepeatedTrip = async () => {
      if (!router.isReady || router.query?.repeat !== '1' || typeof window === 'undefined') return;

      const raw = window.sessionStorage.getItem('repeatTripDraft');
    if (!raw) {
      const nextQuery = { ...router.query };
      delete nextQuery.repeat;
      router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true });
      return;
    }

    try {
      const draft = JSON.parse(raw);

      setTripData((prev) => ({
        ...prev,
        title: draft?.title || '',
        description: draft?.description || '',
        date: null,
        time: '',
        arrivalDate: null,
        arrivalTime: '',
        price: draft?.price ?? '',
        difficulty: draft?.difficulty || 'easy',
        ageFrom: draft?.ageFrom ?? 18,
        ageTo: draft?.ageTo ?? 60,
        participants: draft?.participants ?? 1,
        leisureType: draft?.leisureType || 'tourism',
        alcoholAllowed: Boolean(draft?.alcoholAllowed),
        fromLocation: draft?.fromLocation || null,
        toLocation: draft?.toLocation || null,
        fromAddress: draft?.fromAddress || '',
        toAddress: draft?.toAddress || '',
      }));

      const parseLocationToLatLon = (locationValue) => {
        if (!locationValue) return null;

        if (typeof locationValue === 'string') {
          const match = locationValue.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/i);
          if (!match) return null;
          const lon = Number(match[1]);
          const lat = Number(match[2]);
          return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
        }

        if (Array.isArray(locationValue?.coordinates) && locationValue.coordinates.length >= 2) {
          const lon = Number(locationValue.coordinates[0]);
          const lat = Number(locationValue.coordinates[1]);
          return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
        }

        return null;
      };

      const fromCoords = parseLocationToLatLon(draft?.fromLocation);
      const toCoords = parseLocationToLatLon(draft?.toLocation);

      if (Array.isArray(fromCoords)) {
        setFromCoordinates(fromCoords);
        setFromMapCenter(fromCoords);
      }

      if (Array.isArray(toCoords)) {
        setToCoordinates(toCoords);
        setToMapCenter(toCoords);
      }

      const imageUrls = Array.isArray(draft?.imageUrls) ? draft.imageUrls.filter(Boolean).slice(0, 4) : [];

      if (imageUrls.length) {
        const loadedImages = await Promise.all(imageUrls.map(async (url, index) => {
          try {
            const response = await fetch(url);
            if (!response.ok) return null;

            const blob = await response.blob();
            const extMatch = (blob.type || '').match(/image\/(\w+)/);
            const extension = extMatch ? extMatch[1] : 'jpg';
            const fileName = `repeat-${index + 1}.${extension}`;
            return new File([blob], fileName, { type: blob.type || 'image/jpeg' });
          } catch {
            return null;
          }
        }));

        const safeImages = loadedImages.filter(Boolean);
        setTripData((prev) => ({ ...prev, images: safeImages }));
        setPreviewUrls(imageUrls.slice(0, safeImages.length));
        setMainImageIndex(safeImages.length ? 0 : -1);
      }

      setFromAddress(draft?.fromAddress || '');
      setToAddress(draft?.toAddress || '');
      } catch (error) {
        console.error('Ошибка восстановления повтора поездки:', error);
      } finally {
      window.sessionStorage.removeItem('repeatTripDraft');
      const nextQuery = { ...router.query };
      delete nextQuery.repeat;
        router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true });
      }
    };

    restoreRepeatedTrip();
  }, [router.isReady, router.pathname, router.query, router]);
  // Инициализация карт и центров карт
  useEffect(() => {
    const setInitialMapCenters = async () => {
      if (toLocation) {
        try {
          const parsedLocation = JSON.parse(toLocation);
          if (parsedLocation.type === 'Point' && Array.isArray(parsedLocation.coordinates)) {
            setTripData(prev => ({ ...prev, toLocation }));
            setToCoordinates(parsedLocation.coordinates);
            setToMapCenter([parsedLocation.coordinates[0], parsedLocation.coordinates[1]]);
            getAddress(parsedLocation.coordinates, setToAddress);
          }
        } catch {
          setTimeError('Ошибка обработки координат. Проверьте данные.');
          setTimeout(() => setTimeError(null), 6000);
        }
      } else {
        if (geolocation) {
          const coords = [geolocation.lat, geolocation.lon];
          setToMapCenter(coords);
        } else {
          setToMapCenterFromProfile();
        }
      }

      if (geolocation) {
        const coords = [geolocation.lat, geolocation.lon];
        setFromMapCenter(coords);
      } else {
        setFromMapCenterFromProfile();
      }
    };

    setInitialMapCenters();
  }, [toLocation, geolocation]);

  // NEW: загрузка статусов «карта/компания» и выбор режима по умолчанию
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

// — синхронизируем выплатные карты (payout) перед проверкой
if (session?.access_token) {
  try {
    await fetch('/api/tbank/sync-cards', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (e) {
    console.warn('[create-trip] payout cards sync failed (non-fatal):', e);
    // не падаем — просто проверим то, что есть в БД
  }
}


      // — карты пользователя
const { data: cards, error: cardsErr } = await supabase
  .from('user_cards')
  .select('is_primary, expiry_date, card_scope')
  .eq('user_id', user.id)
  .eq('card_scope', 'payout');

const hasValid =
  !cardsErr &&
  Array.isArray(cards) &&
  cards.some(c => c?.is_primary && !isCardExpired(c?.expiry_date));

      if (!cancelled) setHasValidCard(Boolean(hasValid));

      // — активная компания с T-Банк и платёжным счётом
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

      // — режим по умолчанию (1 раз)
      if (!cancelled && !initialModeDecided) {
        if (!hasValid && companyOk) {
          setTripData(prev => ({ ...prev, isCompanyTrip: true }));
        } else {
          // если есть карта (неважно, есть ли компания) — стартуем как физ.лицо
          setTripData(prev => ({ ...prev, isCompanyTrip: false }));
        }
        setInitialModeDecided(true);
      }

      // после первой инициализации показываем UI
      if (!cancelled) setIsReady(true);
    };
    run();
    return () => { cancelled = true; };
  }, [user?.id, session?.access_token, initialModeDecided]);

  // Проверка компании (если выбрано «от компании»)
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

  const getAddress = (coords, setAddress) => {
  if (!coords || !coords.length) return;

  const doGeocode = () => {
    try {
      if (!window.ymaps || typeof window.ymaps.geocode !== 'function') {
        console.warn('[getAddress] ymaps.geocode not available');
        return;
      }

      window.ymaps.geocode(coords).then((res) => {
        const firstGeoObject = res.geoObjects.get(0);
        const addr = firstGeoObject ? firstGeoObject.getAddressLine() : 'Адрес не найден';
        setAddress(addr);
      }).catch((err) => {
        console.error('[getAddress] geocode error:', err);
        setAddress('Ошибка получения адреса');
      });
    } catch (e) {
      console.error('[getAddress] unexpected error:', e);
      setAddress('Ошибка получения адреса');
    }
  };

  // Если ymaps уже есть — сразу ждём готовности и геокодим
  if (window.ymaps && typeof window.ymaps.ready === 'function') {
    window.ymaps.ready(doGeocode);
    return;
  }

  // Если ymaps ещё нет — ждём появления (до ~9 секунд)
  let attempts = 0;
  const maxAttempts = 30;       // 30 раз
  const intervalMs = 300;       // каждые 300 мс

  const timerId = setInterval(() => {
    attempts += 1;

    if (window.ymaps && typeof window.ymaps.ready === 'function') {
      clearInterval(timerId);
      window.ymaps.ready(doGeocode);
      return;
    }

    if (attempts >= maxAttempts) {
      clearInterval(timerId);
      console.error('[getAddress] ymaps not loaded in time');
      setAddress('Ошибка загрузки карт');
    }
  }, intervalMs);
};

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
      // NEW: защита переключателя
      const wantCompany = value === 'true';
      if (!wantCompany && !hasValidCard) {
        setTimeError('Чтобы создать поездку как физ. лицо, привяжите карту в «Настройки → Мои карты».');
        setTimeout(() => setTimeError(null), 6000);
        setTripData(prev => ({ ...prev, isCompanyTrip: true }));
        return;
      }
      if (wantCompany && !hasCompanyOk) {
        setTimeError('Чтобы создать поездку от лица компании, зарегистрируйте компанию в разделе (Настройки → Компании).');
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

    // Попытка GeoNames
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

    // Резерв: TimeZoneDB
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

  // NEW: мягкий ретрай клиентской NSFW-проверки
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

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files || []);
    const maxImages = 4;
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

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

    if (tripData.images.length + filteredValidFiles.length > maxImages) {
      setTimeError(`Максимальное количество фотографий — ${maxImages}. Вы выбрали ${filteredValidFiles.length}, а уже загружено ${tripData.images.length}.`);
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
        console.debug('[NSFW][create-trip] checking file:', f?.name, f?.type, f?.size);
        const r = await checkWithRetry(f, 3);
        nsfwResults.push({ name: f?.name || 'image.jpg', ...r });
        if (r?.allowed) safeFiles.push(f);
        else console.warn('[NSFW][create-trip] rejected by NSFW:', f?.name, r);
      } catch (err) {
        console.error('[NSFW][create-trip] error for file:', f?.name, err);
        nsfwResults.push({ name: f?.name || 'image.jpg', allowed: false, error: err?.message || 'NSFW check failed' });
      } finally {
        setNsfwProgress((p) => ({ done: Math.min(p.done + 1, finalFiles.length), total: finalFiles.length }));
      }
      await new Promise(res => setTimeout(res, 50));
    }

    setNsfwChecking(false);

    const denied = nsfwResults.filter(x => !x.allowed);
    if (denied.length) {
      setTimeError(`Фото: ${denied.map(x => x.name).join(', ')}, содержит запрещённый контент "18+", повторите или загрузите другое фото.`);
      setTimeout(() => setTimeError(null), 8000);
    }
    if (!safeFiles.length) return;

    const newImages = [...tripData.images, ...safeFiles];
    const newPreviewUrls = [
      ...previewUrls,
      ...safeFiles.map(file => { try { return URL.createObjectURL(file); } catch { return null; } }).filter(Boolean)
    ];

    setTripData({ ...tripData, images: newImages });
    setPreviewUrls(newPreviewUrls);
    if (newImages.length === 1) setMainImageIndex(0);
  };

  const handleRemoveImage = (index) => {
    const newImages = tripData.images.filter((_, i) => i !== index);
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

  // 1) sync payout cards перед проверкой
  if (session?.access_token) {
    try {
      await fetch('/api/tbank/sync-cards', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (e) {
      console.warn('[create-trip][submit] payout cards sync failed (non-fatal):', e);
    }
  }

  // 2) читаем актуальные payout карты из Supabase
  const { data: cards, error: cardsErr } = await supabase
    .from('user_cards')
    .select('is_primary, expiry_date, card_scope')
    .eq('user_id', user.id)
    .eq('card_scope', 'payout');

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

    let finalTimezone = timezone;
    // Определение/выбор timezone
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

    // Геометрия
    let fromLocation = null;
    if (fromCoordinates) {
      fromLocation = `POINT(${fromCoordinates[1]} ${fromCoordinates[0]})`;
    }

    let toLocationPoint = null;
    if (toCoordinates) {
      toLocationPoint = `POINT(${toCoordinates[1]} ${toCoordinates[0]})`;
    }

    // Конвертация времени в UTC
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

    // Загрузка фото
    const currentDate = new Date();
    const day = String(currentDate.getDate()).padStart(2, '0');
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const year = currentDate.getFullYear();
    const folderName = `trips/${day}-${month}-${year}`;

    const imageUrls = [];
    for (let i = 0; i < tripData.images.length; i++) {
      const image = tripData.images[i];
      const sanitizedName = sanitizeFileName(image.name);
      const filePath = `${folderName}/${Date.now()}_${i}_${sanitizedName}`;

      const { data, error } = await supabase.storage
        .from('photos')
        .upload(filePath, image, { upsert: true });

      if (error) {
        setTimeError(`Ошибка загрузки изображения ${image.name}: ${error.message}`);
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
      status: 'active',
      creator_id: user.id,
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
      platform_fee: platformSettings.platformFeePercent,
      tbank_fee: platformSettings.tbankFeePercent,
      // Можем оставить нетто-снимок в рублях для удобства:
      net_amount: tripData.netAmount,
      deal_id: null,
    };

    const { error } = await supabase
      .from('trips')
      .insert([tripPayload]);

    if (error) {
      setTimeError('Ошибка при сохранении поездки: ' + error.message);
      setTimeout(() => setTimeError(null), 6000);
    } else {
      setTimeError('Поездка успешно создана!');
      setTimeout(() => setTimeError(null), 6000);
      setTripData({
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
      });
      setFromCoordinates(null);
      setToCoordinates(null);
      setFromAddress('');
      setToAddress('');
      setPreviewUrls([]);
      setMainImageIndex(0);
      setTimezone(null);
      setShowTimezoneInput(false);
      setTimezoneError(null);
      setCompanyVerificationStatus(null);
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
    // NEW: наружу — статусы для UI
    hasValidCard,
    hasCompanyOk,
    // NEW: индикация NSFW
    nsfwChecking,
    nsfwProgress,
  };
};
