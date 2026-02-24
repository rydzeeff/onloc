// /lib/useTripPayments.js
// UI-хук оплаты: инкапсулирует клиентский стейт и побочные эффекты,
// БЕЗ бизнес-логики платёжки (её делает handlePay из useTripParticipantsTrip).
// Добавлены безопасные фолбэки, автопроверка статуса оплаты и развернутые логи.
//
// Автопуллинг:
//  - включается, если есть «открытый» платёж (status='pending' ИЛИ is_authorized=true && is_confirmed=false)
//  - первые 10 минут: тик раз в 60 секунд; далее — раз в 10 минут
//  - на каждом тике: сначала читаем БД → если не подтверждено — зовём /api/tbank/check-order

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ---- DEBUG LOG HELPER ----
const PAYLOG_NS = '[useTripPayments]';
const paylog = (...args) => {
  // eslint-disable-next-line no-console
  console.log(PAYLOG_NS, ...args);
  try {
    // Храним простую ленту событий в окне для быстрой диагностики
    // window.__payLog: [ [timestamp, ...args], ... ]
    window.__payLog = window.__payLog || [];
    window.__payLog.push([Date.now(), ...args]);
  } catch {}
};

/**
 * @param {Object} params
 * @param {Object|null} params.trip
 * @param {Object|null} params.user
 * @param {string|null} params.participantId
 * @param {string|null} params.participantStatus
 * @param {Function} params.handlePay // из useTripParticipantsTrip
 * @param {Object} params.supabase
 * @param {Function} [params.setMessage]
 */
export function useTripPayments({
  trip,
  user,
  participantId,
  participantStatus,
  handlePay,
  supabase,
  setMessage,
}) {
  const [showRefundPolicy, setShowRefundPolicy] = useState(false);

  // Сохранённые платежные карты (scope='payment')
  const [savedCards, setSavedCards] = useState([]);
  const [isLoadingCards, setIsLoadingCards] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState(''); // '' = новая карта
  const [saveCard, setSaveCard] = useState(true);

  // ----------- состояние автопроверки «открытого» платежа -----------
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [openPayment, setOpenPayment] = useState(null); // { id, order_id, created_at, locked_until, is_authorized, is_confirmed, status }
  const [payLocked, setPayLocked] = useState(false);
  const [payTooltip, setPayTooltip] = useState('');
  const [allowRetry, setAllowRetry] = useState(false);
  const pollTimerRef = useRef(null);
const lastMsgRef = useRef('');
const [uiBlock, setUiBlock] = useState(null); // null — ответа банка ещё не было
 const bankTouchedRef = useRef(false);
  // ---------- helpers ----------
  const formatCardLabel = useCallback((c) => {
    const last4 = c?.last_four_digits ? `•••• ${c.last_four_digits}` : 'Сохранённая карта';
    const exp = c?.expiry_date ? `, до ${c.expiry_date}` : '';
    const primary = c?.is_primary ? ' — основная' : '';
    return `${last4}${exp}${primary}`;
  }, []);

  const renderRefundPolicy = useCallback(() => {
    try {
      if (!trip?.refund_policy) return 'Стандартная политика: 100% возврат за 1 час до начала';
      const { type, full_refunded_hours, partial_refunded_hours, partial_refunded_percent } = trip.refund_policy || {};
      if (type === 'standard') return 'Стандартная политика: 100% возврат за 1 час до начала';
      return `Кастомная политика: 100% возврат за ${full_refunded_hours} часов, ${partial_refunded_percent}% возврат за ${partial_refunded_hours} часов`;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[useTripPayments] renderRefundPolicy error:', e);
      return 'Ошибка отображения политики';
    }
  }, [trip?.refund_policy]);

  // Универсальный загрузчик карт с безопасными фолбэками
  const reloadSavedCardsFromDB = useCallback(async () => {
    try {
      if (!user?.id) return { list: [], primaryCardId: '' };

      await supabase.auth.getSession();

      // 1) Пробуем с фильтром card_scope = 'payment'
      let query = supabase
        .from('user_cards')
        .select('id, card_id, last_four_digits, expiry_date, is_primary, created_at, card_scope')
        .eq('user_id', user.id)
        .eq('card_scope', 'payment')
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: false });

      let { data, error } = await query;

      // 2) Если колонка card_scope отсутствует или БД ругнулась — повторяем без фильтра
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[useTripPayments] card_scope filter failed, retry without scope:', error.message || error);
        const retry = await supabase
          .from('user_cards')
          .select('id, card_id, last_four_digits, expiry_date, is_primary, created_at')
          .eq('user_id', user.id)
          .order('is_primary', { ascending: false })
          .order('created_at', { ascending: false });

        data = retry.data;
        error = retry.error;
      }

      if (error) {
        // eslint-disable-next-line no-console
        console.error('[useTripPayments] load saved cards error:', error);
        return { list: [], primaryCardId: '' };
      }

      const list = Array.isArray(data) ? data : [];
      const primary = list.find((c) => c.is_primary);
      return { list, primaryCardId: primary ? primary.card_id : '' };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[useTripPayments] reloadSavedCardsFromDB exception:', e);
      return { list: [], primaryCardId: '' };
    }
  }, [supabase, user?.id]);

useEffect(() => {
   if (!setMessage) return;
   // до первого ответа банка — НИЧЕГО не показываем (даже если локально payLocked=true)
   if (!bankTouchedRef.current) return;

   // если банк сказал «можно ретраить» или «не блокирую» — убираем подсказку
   if (allowRetry || uiBlock === false) {
     if (lastMsgRef.current) {
       setMessage('');
      lastMsgRef.current = '';
     }
     return;
   }

   // банк сказал «блок» — показываем ТОЛЬКО payTooltip (без дефолта)
const next = (payTooltip && String(payTooltip).trim()) ? payTooltip : '';
if (!next) return; // если tooltip пустой — ничего не показываем и ничего не подставляем

if (next !== lastMsgRef.current) {
  setMessage(next);
  lastMsgRef.current = next;
}
 }, [allowRetry, uiBlock, payTooltip, setMessage]);

// Подгрузка сохранённых карт при открытии модалки
  useEffect(() => {
    const load = async () => {
      if (!showRefundPolicy || !user?.id) return;
      setIsLoadingCards(true);
      try {
        const { list, primaryCardId } = await reloadSavedCardsFromDB();
        setSavedCards(list);
        setSelectedCardId(primaryCardId || '');
        setSaveCard(primaryCardId ? false : true);
      } finally {
        setIsLoadingCards(false);
      }
    };
    load();
  }, [showRefundPolicy, user?.id, reloadSavedCardsFromDB]);

  // ---------- OPEN PAYMENT: чтение БД ----------
  const fetchOpenPaymentOnce = useCallback(async () => {
    if (!trip?.id || !user?.id) return null;

    paylog('fetchOpenPaymentOnce:start', { tripId: trip?.id, userId: user?.id });

    const { data, error } = await supabase
      .from('payments')
      .select('id, order_id, created_at, locked_until, is_authorized, is_confirmed, status')
      .eq('trip_id', trip.id)
      .eq('participant_id', user.id) // ВАЖНО: тут user.id, а не trip_participants.id
      .or('status.eq.pending,and(is_authorized.is.true,is_confirmed.is.false)')
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      // eslint-disable-next-line no-console
      console.error('[useTripPayments] fetchOpenPaymentOnce error:', error);
      paylog('fetchOpenPaymentOnce:error', error);
      return null;
    }
    const result = data?.[0] || null;
    paylog('fetchOpenPaymentOnce:result', result);
    return result;
  }, [supabase, trip?.id, user?.id]);

  const computeUiFromLocal = useCallback((payment) => {
    paylog('computeUiFromLocal:input', payment);

    if (!payment) {
      // Нет открытого платежа — не блокируем, ретраи решаются извне
      setPayLocked(false);
      setPayTooltip('');
      setAllowRetry(false);
      paylog('computeUiFromLocal:decision', { payLocked: false, allowRetry: false, reason: 'no_open_payment' });
      return { within10m: false, untilMs: 0 };
    }
    const untilMs = payment.locked_until
      ? new Date(payment.locked_until).getTime()
      : (new Date(payment.created_at).getTime() + 10 * 60 * 1000);
    const now = Date.now();
    const within10m = now < untilMs;

    // Если локально уже подтвержден — всё, блоки снимаем
    if (payment.is_confirmed) {
      setPayLocked(false);
      setPayTooltip('');
      setAllowRetry(false);
      paylog('computeUiFromLocal:decision', { payLocked: false, allowRetry: false, reason: 'already_confirmed' });
      return { within10m, untilMs };
    }

    // Локально есть «открытый» платёж — базовый блок включаем, дальше уточнит check-order
    setPayLocked(true);
    if (within10m) {
      const leftSec = Math.max(0, Math.floor((untilMs - now) / 1000));
      const mm = String(Math.floor(leftSec / 60)).padStart(2, '0');
      const ss = String(leftSec % 60).padStart(2, '0');
      setPayTooltip(`Проверяем платёж… Осталось ${mm}:${ss}`);
    } else {
      setPayTooltip('Похоже, уведомление не пришло. Напишите в «Поддержка».');
    }
    paylog('computeUiFromLocal:decision', { payLocked: true, allowRetry: false, within10m });
    return { within10m, untilMs };
  }, []);

  // Ручное обновление openPayment из БД (например, после успешного Init или ручного «проверить статус»)
  const refreshPaymentLock = useCallback(async () => {
    const p = await fetchOpenPaymentOnce();
    setOpenPayment(p);
    computeUiFromLocal(p);
  }, [fetchOpenPaymentOnce, computeUiFromLocal]);

  // ---------- CHECK-ORDER тик ----------
  const tickCheckOrder = useCallback(async () => {
    if (!openPayment?.order_id) {
      // Нет открытого платежа — останавливаем опрос
      paylog('tickCheckOrder:skip', 'no openPayment.order_id');
      setIsCheckingStatus(false);
      setPayLocked(false);
      setPayTooltip('');
      setAllowRetry(false);
      return;
    }

    paylog('tickCheckOrder:begin', { orderId: openPayment.order_id });

    // 1) Сначала читаем БД — вдруг уже подтвердилось
    const freshLocal = await fetchOpenPaymentOnce();
    setOpenPayment(freshLocal);

    if (!freshLocal) {
      // локально закрыт — снимаем блок, прекращаем опрос
      paylog('tickCheckOrder:stop', 'freshLocal=null (closed)');
      setIsCheckingStatus(false);
      setPayLocked(false);
      setPayTooltip('');
      setAllowRetry(false);
      return;
    }
    if (freshLocal.is_confirmed) {
      paylog('tickCheckOrder:stop', 'freshLocal.is_confirmed=true');
      setIsCheckingStatus(false);
      setPayLocked(false);
      setPayTooltip('');
      setAllowRetry(false);
      return;
    }

    // 2) Если всё ещё «открытый» — зовём банк
    try {
      const resp = await fetch('/api/tbank/check-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: freshLocal.order_id }),
      });
      const json = await resp.json().catch(() => ({}));

      // Решения UI с учётом ответа агрегатора
      const ui = json?.ui || {};
      // block: true  → держим кнопку серой, tooltip из ui.tooltip
      // allowRetry: true → разрешаем повторный Init (без второй открытой записи!)
      if (typeof ui.block === 'boolean') setPayLocked(ui.block);
      if (typeof ui.allowRetry === 'boolean') setAllowRetry(ui.allowRetry);
      if (typeof ui.tooltip === 'string') {
  const t = String(ui.tooltip || '').trim();

  if (t) {
    setPayTooltip(ui.tooltip); // есть текст — обновляем
  } else {
    // пустым tooltip НЕ затираем информативное сообщение
    // очищаем только если банк явно снял блок / разрешил повтор
    if (ui.block === false || ui.allowRetry === true) {
      setPayTooltip('');
    }
  }
}

// зафиксируем, что банк ответил, и его «истинный» блок
bankTouchedRef.current = true;
if (typeof ui.block === 'boolean') setUiBlock(ui.block);

paylog('tickCheckOrder:check-order:resp', {
  http: resp.status,
  bank: json?.bank?.status,
  local: json?.local,
  ui: json?.ui,
});

      paylog('tickCheckOrder:check-order:resp', {
        http: resp.status,
        bank: json?.bank?.status,
        local: json?.local,
        ui: json?.ui,
      });

      // Если банк сказал AUTH/CONF и мы ждём вебхук — блок останется true.
      // Если банк «не знает / NEW / негатив» — allowRetry=true, блок=false.
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[useTripPayments] check-order call failed:', e);
      paylog('tickCheckOrder:check-order:error', String(e));
      // На сетевых ошибках — не меняем текущее состояние, подождём следующий тик
    }
  }, [openPayment?.order_id, fetchOpenPaymentOnce]);

  // ---------- Планировщик опроса ----------
  const scheduleNextTick = useCallback((within10m) => {
    const nextMs = within10m ? 60 * 1000 : 10 * 60 * 1000; // 60с первые 10мин, затем раз в 10мин
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    paylog('scheduleNextTick', { within10m, nextMs });
    pollTimerRef.current = setTimeout(() => {
      tickCheckOrder();
    }, nextMs);
  }, [tickCheckOrder]);

  // Старт/рестарт опроса при смене trip/user
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (!trip?.id || !user?.id) return;

      paylog('bootstrap:start', { tripId: trip?.id, userId: user?.id });

      const p = await fetchOpenPaymentOnce();
      if (cancelled) return;

      setOpenPayment(p);
      paylog('bootstrap:openPayment', p);
      const { within10m } = computeUiFromLocal(p);

      // Есть «открытый» платёж → запускаем опрос
      if (p && !p.is_confirmed) {
        setIsCheckingStatus(true);
        // первый тик — сразу
        tickCheckOrder().finally(() => {
          // спланировать следующий
          scheduleNextTick(within10m);
        });
      } else {
        setIsCheckingStatus(false);
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [trip?.id, user?.id, fetchOpenPaymentOnce, computeUiFromLocal, tickCheckOrder, scheduleNextTick]);

  // Перепланировка интервала после каждого тика: читаем локальные флаги/время
  useEffect(() => {
    if (!isCheckingStatus) return;
    // Определим, мы внутри 10 минут или уже после
    let within10m = false;
    if (openPayment) {
      const untilMs = openPayment.locked_until
        ? new Date(openPayment.locked_until).getTime()
        : (new Date(openPayment.created_at).getTime() + 10 * 60 * 1000);
      within10m = Date.now() < untilMs;
    }
    scheduleNextTick(within10m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCheckingStatus, payLocked, allowRetry, openPayment?.locked_until, openPayment?.created_at]);

  // ---------- действия ----------
  // Синхронизация карт: сначала пытаемся payment-роут, иначе fallback
  const syncPaymentCardsSafe = useCallback(async (accessToken) => {
    const doFetch = async (url) => {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
        });
        let json = null;
        try { json = await resp.json(); } catch {}
        // eslint-disable-next-line no-console
        console.log('[useTripPayments] sync result:', url, resp.status, json || 'no-json');
        return { ok: resp.ok, status: resp.status, json };
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[useTripPayments] sync fetch error:', url, e);
        return { ok: false, status: 0, json: null };
      }
    };

    // 1) Пытаемся «новый» роут
    let res = await doFetch('/api/tbank/sync-cards-payment');
    if (res.ok) return res;

    // 2) Если 404 или сеть/другая ошибка — пробуем общий старый роут
    if (!res.ok && (res.status === 404 || res.status === 0)) {
      const fallback = await doFetch('/api/tbank/sync-cards');
      return fallback;
    }
    return res;
  }, []);

const handlePayClick = useCallback(async () => {
  try {
    // --- 1) Предварительная проверка «сломанных» платежей по поездке БЕЗ deal_id ---
    if (trip && !trip.deal_id) {
      try {
        const { data: problemPayment, error: problemError } = await supabase
          .from('payments')
          .select('id, order_id, is_authorized, is_confirmed, status, created_at')
          .eq('trip_id', trip.id)
          .eq('payment_type', 'participant_payment')
          .eq('is_authorized', false)
          .eq('is_confirmed', false)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (problemError) {
          // eslint-disable-next-line no-console
          console.error('[useTripPayments] problemPayment pre-check error:', problemError);
        } else if (problemPayment && problemPayment.order_id) {
          try {
            const resp = await fetch('/api/tbank/check-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId: problemPayment.order_id }),
            });

            const json = await resp.json().catch(() => ({}));
            const bankStatusRaw = json?.bank?.status || '';
            const bankStatus = String(bankStatusRaw || '').toUpperCase();
            const uiReason = json?.ui?.reason || '';

            paylog('handlePayClick:pre-check', {
              orderId: problemPayment.order_id,
              bankStatus,
              uiReason,
            });

            // Блокируем ТОЛЬКО по этим статусам:
const problemStatuses = new Set([
  'PAY_CHECKING',
  'AUTHORIZING',
  'AUTHORIZED',
  'CONFIRMED',
]);

            // Дополнительно по твоей системе ui.reason (как спец-флагов)
            const problemReasons = new Set([
              'bank_pay_checking',
              'wait_webhook',
              'webhook_missing_after_10m',
            ]);

            const bankProblem =
              (bankStatus && problemStatuses.has(bankStatus)) ||
              (uiReason && problemReasons.has(uiReason));

            if (bankProblem) {
              const msg =
                'Оплата заблокирована, проблема на стороне банка. ' +
                'Если хотите ускорить процесс восстановления оплаты, напишите в тех. поддержку: ' +
                'раздел «Сообщение», вкладка «Поддержка».';

              // Блокируем кнопку и показываем подсказку
              setPayLocked(true);
              setPayTooltip(msg);
              setAllowRetry(false);
              bankTouchedRef.current = true;
              setUiBlock(true);
              setMessage?.(msg);

              // ЖЁСТКО блокируем открытие модалки и запуск новой оплаты
              return;
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[useTripPayments] /api/tbank/check-order pre-check failed:', e);
            // На сетевой ошибке — не блокируем, продолжаем стандартный сценарий
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[useTripPayments] unexpected pre-check error:', e);
      }
    }

    // --- 2) Обычный сценарий: подгружаем карты и открываем модалку ---
    setIsLoadingCards(true);

    const { data: sess } = await supabase.auth.getSession();
    const accessToken = sess?.session?.access_token || '';

    await syncPaymentCardsSafe(accessToken);

   const { list, primaryCardId } = await reloadSavedCardsFromDB();
setSavedCards(list);

// ✅ выбираем основную, а если её нет — первую (самую свежую, т.к. сортировка уже есть)
const initialCardId = primaryCardId || (list?.[0]?.card_id ?? '');

setSelectedCardId(initialCardId);

// чекбокс "сохранить" нужен только когда выбрана "Новая карта"
setSaveCard(initialCardId ? false : true);

    setShowRefundPolicy(true);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[useTripPayments] handlePayClick error:', e);
    if (setMessage) {
      setMessage('Ошибка при подготовке оплаты. Попробуйте позже или обратитесь в поддержку.');
    }
  } finally {
    setIsLoadingCards(false);
  }
}, [
  trip,
  supabase,
  reloadSavedCardsFromDB,
  syncPaymentCardsSafe,
  setMessage,
]);


  const confirmPay = useCallback(async () => {
    try {
      if (!trip || !user?.id || !participantId) {
        setMessage?.('Ошибка: вы не зарегистрированы как участник этой поездки');
        setShowRefundPolicy(false);
        return;
      }
      if (String(participantStatus || '').toLowerCase() !== 'confirmed') {
        setMessage?.('Оплата доступна только для подтверждённых участников');
        setShowRefundPolicy(false);
        return;
      }

      const isSavedCard = !!selectedCardId;
      const willSaveNew = !selectedCardId && !!saveCard;

      // customerKey НУЖЕН, если: сохранённая карта ИЛИ новая+сохранить
      const maybeCustomerKey = (isSavedCard || willSaveNew) ? String(user.id) : undefined;

      // DefaultCard: cardId для сохранённой, 'none' для новой
      const defaultCard = isSavedCard ? String(selectedCardId) : 'none';

      await handlePay(participantId, {
        selectedCardId: isSavedCard ? String(selectedCardId) : null,
        saveCard: willSaveNew,
        customerKey: maybeCustomerKey, // undefined если новая и «не сохранять»
        defaultCard,                   // 'none' | '<CardId>'
      });

      // После успешного Init сервер ставит locked_until — подтянем из БД и запустим пуллинг
      await refreshPaymentLock();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[useTripPayments] confirmPay error:', e);
      setMessage?.('Ошибка при инициации оплаты');
    } finally {
      setShowRefundPolicy(false);
    }
  }, [
    trip,
    user?.id,
    participantId,
    participantStatus,
    selectedCardId,
    saveCard,
    handlePay,
    setMessage,
    refreshPaymentLock,
  ]);

  // Вычислим финальный признак «кнопку оплаты блокировать?»
// станет (не блокируем, если allowRetry = true)
const payButtonDisabled = useMemo(() => {
  return (!!payLocked || isCheckingStatus === true) && !allowRetry;
}, [payLocked, isCheckingStatus, allowRetry]);

  return {
    // существующие
    showRefundPolicy,
    setShowRefundPolicy,
    savedCards,
    isLoadingCards,
    selectedCardId,
    setSelectedCardId,
    saveCard,
    setSaveCard,
    handlePayClick,
    confirmPay,
    renderRefundPolicy,
    formatCardLabel,

    // новое для UI
    payLocked: payButtonDisabled,
    payTooltip,
    allowRetry,
    isCheckingStatus,
    refreshPaymentLock,
  };
}

export default useTripPayments;
