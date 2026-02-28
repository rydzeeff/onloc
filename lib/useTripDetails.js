import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import { supabase } from './supabaseClient';
import { useAuth } from '../pages/_app';
import { notifications } from '../pages/_app';

const FROM_MARKER_ICON = '/custom-marker.png';
const TO_MARKER_ICON = '/marker-icon.png';
const DEFAULT_AVATAR = '/avatar-default.svg';

/**
 * ✅ Фикс «Открыть в Картах» (mapOpenBlock):
 * Иногда Яндекс добавляет этот блок после инициализации.
 * suppressMapOpenBlock должно скрывать его, но на практике (особенно при SPA-переходах)
 * блок может “всплывать” снова. Поэтому дополнительно:
 *  - выставляем опцию через options.set
 *  - и на всякий случай прячем DOM-элемент по селектору.
 */
function forceHideMapOpenBlock(map) {
  try {
    // 1) Самый надежный вариант — set(key, value)
    map?.options?.set?.("suppressMapOpenBlock", true);
  } catch {}

  // 2) DOM-фолбэк: у класса есть версия (ymaps-2-1-xx), поэтому ищем по подстроке
  try {
    const root = map?.container?.getElement?.();
    if (!root) return;

const nodes = root.querySelectorAll(
  '[class*="map-open-block"], [class*="mapOpenBlock"], [class*="gotoymaps"], [class*="gototech"], [class*="map-copyrights-promo"]'
);
    nodes.forEach((el) => {
      el.style.display = "none";
      el.style.visibility = "hidden";
      el.style.pointerEvents = "none";
    });
  } catch {}
}


export const useTripDetails = ({ tripId } = {}) => {
  const router = useRouter();
  const { id: queryId, from: fromParamRaw } = router.query;
  const effectiveId = tripId || queryId;

  // Признак, что страницу открыли из таблицы участников (кнопка «Просмотр»).
  // Делаем распознавание "participants" без жёсткого равенства (на случай разных значений).
  const openedFromParticipants = (fromParamRaw || '')
    .toString()
    .toLowerCase()
    .includes('participant');

  const { user, setProcessing } = useAuth();
  const [trip, setTrip] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [message, setMessage] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [organizerModalOpen, setOrganizerModalOpen] = useState(false);
  const [organizerData, setOrganizerData] = useState(null);
  const [organizerReviews, setOrganizerReviews] = useState([]);
  const [mainImageIndex, setMainImageIndex] = useState(0);
  const [fade, setFade] = useState(true);
  const [questionModalOpen, setQuestionModalOpen] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [infoMenuOpen, setInfoMenuOpen] = useState(false);
  const [infoSection, setInfoSection] = useState(null);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const mapRef = useRef(null);
  const infoButtonRef = useRef(null);

  const statusMap = {
    waiting: 'Ожидает',
    confirmed: 'Подтверждён',
    rejected: 'Отклонён',
    started: 'Поездка начата',
    canceled: 'Поездка отменена',
    finished: 'Завершена',
    active: 'Активна',
    paid: 'Оплачено',
  };

  const genderMap = {
    male: 'Мужской',
    female: 'Женский',
    man: 'Мужской',
  };

   // Первичная загрузка поездки + участников
  // (только при смене id, без привязки к cacheBuster)
  useEffect(() => {
    if (!effectiveId) return;

    setProcessing(true);
    Promise.all([fetchTrip(), fetchParticipants()])
      .finally(() => setProcessing(false));
  }, [effectiveId, setProcessing]);


  useEffect(() => {
    let cancelled = false;

    const waitForMapConstructors = (maxAttempts = 40, intervalMs = 100) =>
      new Promise((resolve, reject) => {
        let attempts = 0;
        const tick = () => {
          if (window.ymaps?.Map && window.ymaps?.Placemark && window.ymaps?.util?.bounds) {
            resolve(true);
            return;
          }
          attempts += 1;
          if (attempts >= maxAttempts) {
            reject(new Error('Yandex Maps constructors are not ready in time'));
            return;
          }
          setTimeout(tick, intervalMs);
        };
        tick();
      });

    const ensureYandexMapsReady = async () => {
      if (typeof window === 'undefined') return false;

      const waitCurrentInstance = () =>
        new Promise((resolve, reject) => {
          if (!window.ymaps?.ready) {
            reject(new Error('window.ymaps.ready is unavailable'));
            return;
          }
          window.ymaps.ready(async () => {
            try {
              await waitForMapConstructors();
              resolve(true);
            } catch (e) {
              reject(e);
            }
          });
        });

      if (window.ymaps?.ready) {
        return waitCurrentInstance();
      }

      const apiKey = process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY;
      if (!apiKey) {
        console.warn('[trip-details] NEXT_PUBLIC_YANDEX_MAPS_API_KEY is missing');
        return false;
      }

      const scriptSelector = 'script[src*="api-maps.yandex.ru/2.1/"]';
      const globalPromiseKey = '__onlocYmapsLoadPromise';

      if (!window[globalPromiseKey]) {
        window[globalPromiseKey] = new Promise((resolve, reject) => {
          const handleReady = async () => {
            try {
              await waitCurrentInstance();
              resolve(true);
            } catch (e) {
              reject(e);
            }
          };

          const existingScript = document.querySelector(scriptSelector);
          if (existingScript) {
            if (window.ymaps?.ready) {
              handleReady();
              return;
            }
            existingScript.addEventListener('load', handleReady, { once: true });
            existingScript.addEventListener(
              'error',
              () => reject(new Error('Failed to load Yandex Maps API script')),
              { once: true }
            );
            return;
          }

          const script = document.createElement('script');
          script.src = `https://api-maps.yandex.ru/2.1/?lang=ru_RU&apikey=${apiKey}`;
          script.async = true;
          script.onload = handleReady;
          script.onerror = () => reject(new Error('Failed to load Yandex Maps API script'));
          document.body.appendChild(script);
        }).finally(() => {
          window[globalPromiseKey] = null;
        });
      }

      return window[globalPromiseKey];
    };

    if (!trip || mapRef.current) return;

    ensureYandexMapsReady()
      .then((ready) => {
        if (!cancelled && ready && !mapRef.current) {
          initMap();
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('[trip-details] Yandex Maps init failed:', error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [trip]);

// ✅ Чистим карту при уходе со страницы/смене поездки,
// чтобы не оставались хвосты DOM и “служебные блоки” Яндекса.
useEffect(() => {
  return () => {
    if (mapRef.current) {
      try { mapRef.current.destroy(); } catch {}
      mapRef.current = null;
    }
  };
}, [effectiveId]);

  useEffect(() => {
    const updateUnread = () => {
      const totalUnread = notifications.getTotalUnread();
      setUnreadMessages(totalUnread);
    };
    notifications.addListener(updateUnread);
    return () => notifications.removeListener(updateUnread);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        infoMenuOpen &&
        infoButtonRef.current &&
        !infoButtonRef.current.contains(e.target) &&
        !e.target.closest('.companyCard') &&
        !e.target.closest('.documentsCard')
      ) {
        setInfoMenuOpen(false);
        setInfoSection(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [infoMenuOpen]);

  // ——— MAIN LOAD ———
  async function fetchTrip() {
    try {
      // 1) Пробуем штатный RPC (используется в обычном детальном просмотре)
      const { data, error } = await supabase.rpc('get_trip_details_geojson', { trip_id: effectiveId });
      if (error) throw new Error(`Ошибка загрузки поездки: ${error.message}`);

      if (data && data.length > 0) {
        const tripData = normalizeTripImages(data[0]);
        setTrip(tripData);
        await fetchOrganizerData(tripData);
        return;
      }

      // 2) Если пришли «из участников», даём fallback на прямой select по trips (без фильтра по статусу)
      if (openedFromParticipants) {
        const { data: t2, error: err2 } = await supabase
          .from('trips')
          .select(`
            id, title, description, date, time, arrival_date, arrival_time, price, difficulty,
            age_from, age_to, participants, creator_id, status, created_at,
            from_location, to_location, leisure_type, image_urls,
            is_company_trip, alcohol_allowed, from_address, to_address,
            timezone, refund_policy, start_date, deal_id,
            platform_fee, tbank_fee, net_amount, dispute_period_ends_at
          `)
          .eq('id', effectiveId)
          .maybeSingle();

        if (err2 || !t2) throw new Error('Поездка не найдена');

        const tripData = normalizeTripImages(t2);
        setTrip(tripData);
        await fetchOrganizerData(tripData);
        return;
      }

      // 3) Обычный сценарий — не нашли
      throw new Error('Поездка не найдена');
    } catch (error) {
      console.error('Ошибка загрузки поездки:', error);
      showTemporaryMessage(error.message || 'Ошибка загрузки данных');
    }
  }

  function normalizeTripImages(t) {
    const processedImageUrls = Array.isArray(t.image_urls)
      ? t.image_urls
      : (typeof t.image_urls === 'object' && t.image_urls !== null
          ? Object.values(t.image_urls)
          : []);
    return { ...t, image_urls: processedImageUrls };
  }

  async function fetchParticipants() {
    try {
      const { data, error } = await supabase
        .rpc('get_trip_participants_with_details', { trip_uuid: effectiveId });
      if (!error) {
        setParticipants(data || []);
      } else {
        setParticipants([]);
      }
    } catch (error) {
      console.error('Ошибка загрузки участников:', error);
      showTemporaryMessage(error.message || 'Ошибка загрузки данных');
    }
  }

// --- Realtime-подписка на участников поездки ---
useEffect(() => {
  if (!effectiveId) return;

  const channel = supabase
    .channel(`trip_participants_${effectiveId}`)
    .on(
      'postgres_changes',
      {
        event: '*',            // INSERT / UPDATE / DELETE
        schema: 'public',
        table: 'trip_participants',
        filter: `trip_id=eq.${effectiveId}`,
      },
      (payload) => {
        console.log('[tripDetails][realtime] trip_participants change:', payload);
        // просто обновляем участников, без перезагрузки страницы
        fetchParticipants();
      }
    )
    .subscribe();

  return () => {
    try {
      supabase.removeChannel(channel);
    } catch (err) {
      console.error('[tripDetails][realtime] removeChannel error:', err?.message);
    }
  };
}, [effectiveId]);


  async function fetchOrganizerData(tripData) {
    try {
      const { is_company_trip, creator_id } = tripData;
      if (is_company_trip) {
        const { data: companyData, error: companyError } = await supabase
          .from('mycompany')
          .select('*')
          .eq('user_id', creator_id)
          .single();
        if (companyError) throw new Error(`Ошибка загрузки данных компании: ${companyError.message}`);

        const { data: reviewsData, error: reviewsError } = await supabase
          .from('company_reviews')
          .select('rating, text, trip_id, created_at')
          .eq('organizer_id', creator_id);
        if (reviewsError) throw new Error(`Ошибка загрузки отзывов о компании: ${reviewsError.message}`);

        const averageRating = reviewsData.length > 0
          ? reviewsData.reduce((sum, review) => sum + review.rating, 0) / reviewsData.length
          : 0;

        setOrganizerData({ type: 'company', ...companyData, averageRating: averageRating.toFixed(1) });

        const reviewsWithTripTitles = await Promise.all(
          reviewsData.map(async (review) => {
            const { data: tripDataInner, error: tripError } = await supabase
              .from('trips')
              .select('title')
              .eq('id', review.trip_id)
              .single();
            return { ...review, trip_title: tripError ? 'Неизвестная поездка' : tripDataInner.title };
          })
        );
        setOrganizerReviews(reviewsWithTripTitles);
      } else {
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('user_id', creator_id)
          .single();
        if (profileError) throw new Error(`Ошибка загрузки данных профиля: ${profileError.message}`);

        const { data: reviewsData, error: reviewsError } = await supabase
          .from('reviews')
          .select('rating, text, trip_id, created_at')
          .eq('organizer_id', creator_id);
        if (reviewsError) throw new Error(`Ошибка загрузки отзывов о физическом лице: ${reviewsError.message}`);

        const averageRating = reviewsData.length > 0
          ? reviewsData.reduce((sum, review) => sum + review.rating, 0) / reviewsData.length
          : 0;

        setOrganizerData({ type: 'individual', ...profileData, averageRating: averageRating.toFixed(1) });

        const reviewsWithTripTitles = await Promise.all(
          reviewsData.map(async (review) => {
            const { data: tripDataInner, error: tripError } = await supabase
              .from('trips')
              .select('title')
              .eq('id', review.trip_id)
              .single();
            return { ...review, trip_title: tripError ? 'Неизвестная поездка' : tripDataInner.title };
          })
        );
        setOrganizerReviews(reviewsWithTripTitles);
      }
    } catch (error) {
      console.error('Ошибка загрузки данных организатора:', error);
      showTemporaryMessage(error.message || 'Ошибка загрузки данных организатора');
    }
  }

  function showTemporaryMessage(msg) {
    setMessage(msg);
    setTimeout(() => setMessage(''), 4000);
  }

  // ——— Guard: действия только когда поездка активна ———
  const isActive = useMemo(() => (trip?.status || '').toLowerCase() === 'active', [trip?.status]);

  function ensureActiveOrToast() {
    if (!isActive) {
      const ru =
        (trip?.status && (statusMap[trip.status.toLowerCase()] || trip.status)) ||
        'недоступна';
      showTemporaryMessage(`Действие недоступно: поездка ${ru}. Набор закрыт.`);
      return false;
    }
    return true;
  }

  /**
   * Присоединение к поездке
   */
  // ВСТАВЬ СЮДА вместо старой версии
async function handleJoinTrip() {
  // 1) Статус поездки
  if (!ensureActiveOrToast()) return;

  // 2) Авторизация
  if (!user) {
    showTemporaryMessage('Нужно авторизироваться');
    return;
  }

  // 3) Организатор не может присоединиться к своей поездке
  if (trip && trip.creator_id === user.id) {
    showTemporaryMessage('Нельзя присоединиться к своей поездке');
    return;
  }

  // 4) Уже присоединён?
  const participant = participants.find((p) => p.user_id === user.id);
  if (participant && ['waiting', 'confirmed', 'paid'].includes(participant.status)) {
    showTemporaryMessage('Вы уже присоединились к этой поездке');
    return;
  }

  // 5) Без браузерного confirm — выполняем сразу
  try {
    // 5.1) Создать/обновить участие
    if (participant && participant.status === 'rejected') {
      const { error: updateError } = await supabase
        .from('trip_participants')
        .update({ status: 'waiting', joined_at: new Date() })
        .eq('trip_id', trip.id)
        .eq('user_id', user.id);
      if (updateError) throw new Error('Ошибка при повторном присоединении');
    } else {
      const { error: joinError } = await supabase
        .from('trip_participants')
        .insert([{
          trip_id: trip.id,
          user_id: user.id,
          status: 'waiting',
          joined_at: new Date(),
        }]);
      if (joinError) throw new Error('Ошибка при отправке заявки');
    }

    // 5.2) Создать групповой чат при первом присоединении
    await ensureTripGroupChatOnFirstJoin(trip.id, trip.title, trip.creator_id, user.id);

    // 5.3) Уведомить организатора в личном чате
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('first_name, last_name, patronymic')
      .eq('user_id', user.id)
      .single();

    const fullName = userProfile
      ? [userProfile.last_name, userProfile.first_name, userProfile.patronymic].filter(Boolean).join(' ') || 'Неизвестный пользователь'
      : 'Неизвестный пользователь';

    await sendMessageToOrganizerPrivateChat(
      trip.creator_id,
      `Пользователь ${fullName} присоединился к поездке`
    );

    showTemporaryMessage('Заявка отправлена, организатор уведомлен');

    // 5.4) Обновить список участников/кэш
  // просто обновляем участников на этой странице
    await fetchParticipants();

    // сигнал для других страниц/списков, если они слушают tripUpdated
    window.dispatchEvent(new CustomEvent('tripUpdated', { detail: { tripId: trip.id } }));

  } catch (error) {
    console.error('Ошибка при присоединении:', error);
    showTemporaryMessage(error.message || 'Ошибка при присоединении');
  }
}


  async function ensureTripGroupChatOnFirstJoin(tripId, tripTitle, organizerId, joinedUserId) {
    const { data: groupChat } = await supabase
      .from('chats')
      .select('id')
      .eq('trip_id', tripId)
      .eq('chat_type', 'trip_group')
      .maybeSingle();

    let chatId = groupChat?.id;

    if (!chatId) {
      const { data: created, error: createErr } = await supabase
        .from('chats')
        .insert([{
          trip_id: tripId,
          chat_type: 'trip_group',
          is_group: true,
          title: `Чат поездки: ${tripTitle || 'Без названия'}`,
        }])
        .select('id')
        .single();
      if (createErr) {
        console.error('Не удалось создать групповой чат поездки:', createErr);
        return;
      }
      chatId = created.id;

      if (organizerId) {
        await supabase
          .from('chat_participants')
          .upsert([{ chat_id: chatId, user_id: organizerId }], { onConflict: 'chat_id,user_id' });
      }
    }

    if (joinedUserId) {
      await supabase
        .from('chat_participants')
        .upsert([{ chat_id: chatId, user_id: joinedUserId }], { onConflict: 'chat_id,user_id' });
    }
  }

  async function handleSendQuestion() {
    if (!user) {
      showTemporaryMessage('Нужно авторизироваться');
      return;
    }

    if (trip && trip.creator_id === user.id) {
      showTemporaryMessage('Организатор не может отправить сообщение сам себе');
      return;
    }

    if (!newMessage.trim()) {
      showTemporaryMessage('Введите сообщение');
      return;
    }

    try {
      await sendMessageToOrganizerPrivateChat(trip.creator_id, newMessage);
      showTemporaryMessage('Вопрос успешно отправлен организатору');
      setQuestionModalOpen(false);
      setNewMessage('');
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error);
      showTemporaryMessage('Ошибка при отправке вопроса');
    }
  }

  async function sendMessageToOrganizerPrivateChat(recipientId, content) {
    if (!user?.id || !recipientId || !trip?.id) {
      throw new Error('Недостаточно данных для создания личного чата');
    }

    const { data: myPrivates } = await supabase
      .from('chat_participants')
      .select('chat_id, chats!inner(id, trip_id, chat_type)')
      .eq('user_id', user.id)
      .eq('chats.trip_id', trip.id)
      .eq('chats.chat_type', 'trip_private');

    const myChatIds = (myPrivates || []).map((x) => x.chat_id).filter(Boolean);

    let targetChatId = null;
    if (myChatIds.length) {
      const { data: theirInMy } = await supabase
        .from('chat_participants')
        .select('chat_id')
        .eq('user_id', recipientId)
        .in('chat_id', myChatIds);

      if (theirInMy?.length) {
        targetChatId = theirInMy[0].chat_id;
      }
    }

    if (!targetChatId) {
      const { data: created, error: createErr } = await supabase
        .from('chats')
        .insert([{
          trip_id: trip.id,
          chat_type: 'trip_private',
          is_group: false,
          title: null,
        }])
        .select('id')
        .single();
      if (createErr) throw new Error(`Не удалось создать личный чат: ${createErr.message}`);
      targetChatId = created.id;

      const { error: addErr } = await supabase
        .from('chat_participants')
        .insert([
          { chat_id: targetChatId, user_id: user.id },
          { chat_id: targetChatId, user_id: recipientId },
        ]);
      if (addErr) throw new Error(`Не удалось добавить участников в личный чат: ${addErr.message}`);
    }

    const { error: msgErr } = await supabase
      .from('chat_messages')
      .insert([{ chat_id: targetChatId, user_id: user.id, content, read: false }]);
    if (msgErr) throw new Error(`Не удалось отправить сообщение: ${msgErr.message}`);

    notifications.incrementUnreadCount(targetChatId);
  }

  // Модалки «Участники» / «Организатор» теперь уважают статус
  const openParticipantsModal = () => {
    if (!ensureActiveOrToast()) return;
    setModalOpen(true);
    // Подтягиваем актуальный список участников, но без глобальной перезагрузки
    fetchParticipants();
  };

  const closeParticipantsModal = () => setModalOpen(false);

const openOrganizerModal = () => {
  // Если открыто через "Просмотр" из страницы участников — позволяем всегда
  if (openedFromParticipants) {
    setOrganizerModalOpen(true);
    return;
  }
  // Иначе — только для active
  if (!ensureActiveOrToast()) return;
  setOrganizerModalOpen(true);
};
  const closeOrganizerModal = () => setOrganizerModalOpen(false);

  const handleChangeMainImage = (index) => {
    setFade(false);
    setTimeout(() => {
      setMainImageIndex(index);
      setFade(true);
    }, 500);
  };

  const toggleInfoMenu = () => {
    setInfoMenuOpen(!infoMenuOpen);
    if (infoMenuOpen) setInfoSection(null);
  };

  const handleInfoSection = (section) => setInfoSection(section);

  const downloadDocument = async (fileName) => {
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
      console.error('Ошибка загрузки документа:', error);
      showTemporaryMessage('Ошибка при загрузке документа');
    }
  };

  const handleMessagesClick = () => router.push('/dashboard?section=messages');

const DEFAULT_TRIP_IMAGE = '/def/fotoMB.jpg';

const imageUrls = useMemo(() => {
  const raw = trip?.image_urls;

  let arr = [];
  if (!raw) arr = [];
  else if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed && typeof parsed === 'object') arr = Object.values(parsed);
    } catch {
      arr = [];
    }
  } else if (typeof raw === 'object') {
    arr = Object.values(raw || {});
  }

  arr = (arr || []).filter(Boolean);

  // Даже если нет фото — всегда 1 картинка (дефолтная)
  if (arr.length === 0) return [DEFAULT_TRIP_IMAGE];
  return arr;
}, [trip]);


  const formatDateRange = useMemo(() => {
    const formatDateTime = (date, time) => {
      if (!date) return '';
      const d = new Date(date);
      const formattedDate = d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const formattedTime = time ? ` ${time}` : '';
      return `${formattedDate}${formattedTime}`;
    };
    const start = formatDateTime(trip?.date, trip?.time);
    const end = formatDateTime(trip?.arrival_date, trip?.arrival_time);
    return `${start} - ${end}`;
  }, [trip?.date, trip?.time, trip?.arrival_date, trip?.arrival_time]);

  const joinedCount = useMemo(
    () => participants.filter((p) => p.status !== 'rejected').length,
    [participants]
  );

  // ВАЖНО: максимум мест берём из trips.participants, а не из несуществующего participants_count
  const possibleCount = trip?.participants ?? 8;

  const isUserConfirmed = useMemo(() => {
    return user && participants.some(p => p.user_id === user.id && p.status === 'confirmed');
  }, [user, participants]);

  function calculateAge(birthDate) {
    if (!birthDate) return 'Не указан';
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
    return age > 0 ? `${age} лет` : 'Не указано';
  }

  function getFullName(participant) {
    const parts = [participant.last_name, participant.first_name, participant.patronymic].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : 'Не указано';
  }

  function initMap() {
    if (!trip) return;

    // Универсальный парсер координат
    const pickLatLng = (geom) => {
      if (!geom) return null;
      // GeoJSON { type: 'Point', coordinates: [lon, lat] }
      if (geom.coordinates && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
        return [geom.coordinates[1], geom.coordinates[0]];
      }
      // Массив [lon, lat] (подстрахуемся)
      if (Array.isArray(geom) && geom.length >= 2) {
        return [geom[1], geom[0]];
      }
      return null;
    };

    const fromCoords = pickLatLng(trip.from_location);
    const toCoords   = pickLatLng(trip.to_location);
    if (!fromCoords || !toCoords || !window?.ymaps) return;

mapRef.current = new window.ymaps.Map(
  'map',
  {
    center: fromCoords,
    zoom: 8,
    controls: [], // ✅ как на Trips
  },
  {
    suppressMapOpenBlock: true,
  }
);


// ✅ если Яндекс дорисует блоки позже (SPA/перемещения карты)



    mapRef.current.options.set({
suppressMapOpenBlock: true,
      suppressYandexSearch: true,
      suppressTraffic: true,
      suppressContextMenu: true,
    });

forceHideMapOpenBlock(mapRef.current);
setTimeout(() => forceHideMapOpenBlock(mapRef.current), 0);
setTimeout(() => forceHideMapOpenBlock(mapRef.current), 200);

try {
  mapRef.current.events.add('boundschange', () => forceHideMapOpenBlock(mapRef.current));
  mapRef.current.events.add('actionend', () => forceHideMapOpenBlock(mapRef.current));
} catch {}

    mapRef.current.behaviors.disable(['rightMouseButtonMagnifier', 'contextMenu']);
    mapRef.current.events.add('contextmenu', (e) => e.preventDefault());

const ICON_SIZE = [25, 40];
const ICON_OFFSET = [-Math.round(ICON_SIZE[0] / 2), -ICON_SIZE[1]]; // [-13, -40]

const baseMarkerOptions = {
  iconLayout: 'default#image',
  iconImageSize: ICON_SIZE,
  iconImageOffset: ICON_OFFSET,
  iconImageShape: {
    type: 'Rectangle',
    coordinates: [
      ICON_OFFSET,
      [ICON_OFFSET[0] + ICON_SIZE[0], ICON_OFFSET[1] + ICON_SIZE[1]],
    ],
  },
  cursor: 'pointer',
  openBalloonOnClick: true,
  hideIconOnBalloonOpen: false,
};



const fromPlacemark = new window.ymaps.Placemark(
  fromCoords,
  {
    hintContent: 'Откуда',
    balloonContent: trip.from_address || 'Адрес отправления не указан',
  },
  {
    ...baseMarkerOptions,
    iconImageHref: FROM_MARKER_ICON,
  }
);

const toPlacemark = new window.ymaps.Placemark(
  toCoords,
  {
    hintContent: 'Куда',
    balloonContent: trip.to_address || 'Адрес прибытия не указан',
  },
  {
    ...baseMarkerOptions,
    iconImageHref: TO_MARKER_ICON,
  }
);



// включаем стандартное поведение клика по метке
fromPlacemark.options.set({
  openBalloonOnClick: true,
  cursor: 'pointer',
});
toPlacemark.options.set({
  openBalloonOnClick: true,
  cursor: 'pointer',
});

// на всякий случай: если стандартный клик не сработает, дублируем через events.click
fromPlacemark.events.add('click', (e) => {
  try { e.stopPropagation(); } catch {}
  fromPlacemark.balloon.open();
});

toPlacemark.events.add('click', (e) => {
  try { e.stopPropagation(); } catch {}
  toPlacemark.balloon.open();
});


mapRef.current.geoObjects.add(fromPlacemark);
mapRef.current.geoObjects.add(toPlacemark);

const bounds = window.ymaps.util.bounds.fromPoints([fromCoords, toCoords]);

mapRef.current.setBounds(bounds, {
  checkZoomRange: true,
  zoomMargin: [80, 40, 40, 40], // top, right, bottom, left
  duration: 0,
});
  }

  return {
    user,
    trip,
    participants,
    message,
    modalOpen,
    organizerModalOpen,
    organizerData,
    organizerReviews,
    mainImageIndex,
    fade,
    questionModalOpen,
    newMessage,
    infoMenuOpen,
    infoSection,
    unreadMessages,
    mapRef,
    infoButtonRef,
    statusMap,
    genderMap,
    imageUrls,
    formatDateRange,
    joinedCount,
    possibleCount,
    isUserConfirmed,
    setModalOpen,
    setOrganizerModalOpen,
    setQuestionModalOpen,
    setNewMessage,
    setInfoMenuOpen,
    fetchTrip,
    fetchParticipants,
    showTemporaryMessage,
    handleJoinTrip,
    handleSendQuestion,
    openParticipantsModal,
    closeParticipantsModal,
    openOrganizerModal,
    closeOrganizerModal,
    handleChangeMainImage,
    toggleInfoMenu,
    handleInfoSection,
    downloadDocument,
    handleMessagesClick,
    calculateAge,
    getFullName,
    initMap,
  };
};
