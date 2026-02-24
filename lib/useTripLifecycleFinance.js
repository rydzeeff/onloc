// /lib/useTripLifecycleFinance.js
import crypto from 'crypto';

/**
 * Группа функций: жизненный цикл поездки + финансы (оплата и выплаты).
 * Никаких React-хуков внутри — это фабрика, получающая контекст из useTripParticipants (supabase, стейты и т.д.).
 */
export function useTripLifecycleFinance(ctx) {
  const {
    memoizedTripId,
    trip,
    setTrip,
    participants,
    setMessage,
    setConfirmModal,
    user,
    sendMessage,
    fetchParticipants,
    supabase,
  } = ctx;

  // ========================== Загрузка данных о поездке ==========================
  async function fetchTrip() {
    try {
      console.log('Запрос поездки:', { tripId: memoizedTripId });
      const { data: tripData, error: tripError } = await supabase
        .from('trips')
        .select(`
          id, creator_id, price, title, deal_id, status, participants, date, time, refund_policy, dispute_period_ends_at, start_date, is_company_trip,
          profiles:creator_id (phone)
        `)
        .eq('id', memoizedTripId)
        .single();
      if (tripError) {
        console.error('Ошибка Supabase при загрузке поездки:', { error: tripError.message, tripId: memoizedTripId });
        setMessage('Ошибка загрузки поездки');
        throw tripError;
      }
      setTrip({ ...tripData, phone: tripData?.profiles?.phone });
      console.log('Поездка загружена:', { tripId: memoizedTripId, phone: tripData?.profiles?.phone, deal_id: tripData?.deal_id });
    } catch (error) {
      console.error('Ошибка при загрузке поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка загрузки поездки');
    }
  }

  // ============================== Инициация оплаты ==============================
  // opts = { selectedCardId, saveCard, customerKey, defaultCard }  // defaultCard: 'none' | '<CardId>'
  async function handlePay(participantRowId, opts = {}) {
    try {
      console.log('=== Инициация оплаты:', { participantRowId, tripId: memoizedTripId, opts });
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      if (!accessToken) {
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      if (!participantRowId) {
        setMessage('Ошибка: ID участника не определён');
        return;
      }
      const participant = participants.find(p => p.id === participantRowId);
      if (!participant) {
        setMessage('Участник не найден');
        return;
      }
      if (participant.status !== 'confirmed') {
        setMessage('Оплата доступна только для подтверждённых участников');
        return;
      }

 // Если по поездке ещё нет deal_id, но уже есть ОТКРЫТЫЕ платежи (любой участник),
// проверяем КАЖДЫЙ у банка и, если хоть один в блокирующем статусе — запрещаем новую оплату.
if (!trip?.deal_id) {
  try {
    const { data: openPayments, error: openPaymentsError } = await supabase
      .from('payments')
      .select('id, order_id, status, is_authorized, is_confirmed, created_at')
      .eq('trip_id', memoizedTripId)
      .eq('payment_type', 'participant_payment')
      .or('status.eq.pending,and(is_authorized.is.true,is_confirmed.is.false)')
      .order('created_at', { ascending: false })
      .limit(10); // с запасом, но их обычно 1–2

    if (openPaymentsError) {
      console.error('Ошибка проверки открытых платежей перед инициацией:', openPaymentsError);
    } else {
      const blockingStatuses = new Set([
        'PAY_CHECKING',
        'AUTHORIZING',
        'AUTHORIZED',
        'CONFIRMED',
      ]);

      const blockingReasons = new Set([
        'bank_pay_checking',
        'wait_webhook',
        'webhook_missing_after_10m',
      ]);

      const list = Array.isArray(openPayments) ? openPayments : [];

      for (const pay of list) {
        if (!pay?.order_id) continue;

        try {
          const checkResp = await fetch(
            `${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/check-order`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId: pay.order_id }),
            }
          );

          const checkJson = await checkResp.json().catch(() => null);
          const bankStatus = (checkJson?.bank?.status || '').toUpperCase();
          const uiReason = checkJson?.ui?.reason || '';

          console.log('[handlePay][pre-check] payment', {
            paymentId: pay.id,
            orderId: pay.order_id,
            bankStatus,
            uiReason,
          });

          if (blockingStatuses.has(bankStatus) || blockingReasons.has(uiReason)) {
            setMessage(
              'Оплата заблокирована, проблема на стороне банка. ' +
              'Если хотите ускорить процесс восстановления оплаты, напишите в тех. поддержку: ' +
              'раздел «Сообщение», вкладка «Поддержка».'
            );
            return;
          }
        } catch (e) {
          console.error(
            'Ошибка вызова /api/tbank/check-order перед инициацией платежа (один из списка):',
            { error: e, paymentId: pay.id, orderId: pay.order_id }
          );
          // На сетевой ошибке по одному платежу — просто идём дальше, остальные тоже проверим
        }
      }
    }
  } catch (e) {
    console.error('Неожиданная ошибка проверки открытых платежей перед инициацией:', e);
  }
}



      // Генерируем orderId на фронте (создание/реюз записи делает БЭК)
      const rawOrderId = `${memoizedTripId}-${participantRowId}-${Date.now()}`;
      const orderId = crypto.createHash('sha256').update(rawOrderId).digest('hex').slice(0, 50);

      const notificationUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/payment-notification`;
      const successUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/payment-result?status=success&orderId=${orderId}`;
      const failUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/payment-result?status=fail&orderId=${orderId}`;

      const selectedCardId = opts?.selectedCardId ?? null;   // string | null
      const saveCard = !!opts?.saveCard;

      // customerKey передаём ТОЛЬКО если явно пришёл
      const customerKey =
        typeof opts?.customerKey === 'string' && opts.customerKey.trim() !== ''
          ? opts.customerKey
          : undefined;

      // 'none' | '<CardId>' | undefined (передаём как defaultCardId для бэка)
      const defaultCard =
        typeof opts?.defaultCard === 'string' ? opts.defaultCard : undefined;

      // Весь жизненный цикл записи в payments (создать/реюзнуть/залочить) — ТОЛЬКО на бэке
      const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/init-payment`, {
        method: 'POST',
        headers: {
          'Content-Type' : 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          tripId: memoizedTripId,
          participantId: participant.user_id,
          amount: trip?.price,
          orderId,
          dealId: trip?.deal_id || null, // бэкенд фактически не использует; финальный deal_id закрепится по вебхуку
          notificationUrl,
          successUrl,
          failUrl,
          selectedCardId,
          saveCard,
          ...(customerKey ? { customerKey } : {}),
          ...(defaultCard !== undefined ? { defaultCardId: defaultCard } : {}), // ВАЖНО: ключ ожидаемый бэком
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }

      const data = await response.json();
      if (data.success) {
        // Обновим deal_id локально, если он впервые пришёл из банка (для «живого» UI)
        if (data.dealId && !trip?.deal_id) {
          const { data: updatedTrip, error: tripUpdateError } = await supabase
            .from('trips')
            .select('deal_id')
            .eq('id', memoizedTripId)
            .single();
          if (tripUpdateError) {
            console.error('Ошибка проверки deal_id в trips:', { error: tripUpdateError.message });
            // не фатально для редиректа
          }
          setTrip((prev) => ({ ...prev, deal_id: updatedTrip?.deal_id || data.dealId }));
        }
        // Редирект в Т-Банк
        window.location.href = data.paymentUrl;
      } else {
        setMessage(`Ошибка инициации платежа: ${data.details || data.error || 'Неизвестная ошибка'}`);
        throw new Error(data.details || data.error || 'Ошибка инициации платежа');
      }
    } catch (error) {
      console.error('Ошибка обработки платежа:', { error: error.message, tripId: memoizedTripId });
      setMessage(`Ошибка обработки платежа: ${error.message}`);
    }
  }

 // ================================ Начало поездки ================================
async function handleStartTrip() {
  try {
    console.log('Инициация начала поездки (с рефетчем):', { tripId: memoizedTripId });

    // 1) Берём свежие данные ДО любых расчётов (исключаем гонки со старыми стейтами)
    await fetchParticipants();

    // 2) Читаем "истину" прямо из БД (ещё надёжнее, чем полагаться на setState)
    const { data: freshRows, error: freshErr } = await supabase
      .from('trip_participants')
      .select('id, user_id, status')
      .eq('trip_id', memoizedTripId);

    if (freshErr) throw freshErr;

    const rows = Array.isArray(freshRows) ? freshRows : [];
    const paid = rows.filter(p => (p.status || '').toLowerCase() === 'paid');
    if (rows.length === 0) {
      setMessage('Начать поездку невозможно, т.к. нет участников. Можно только отменить поездку.');
      return;
    }
    if (paid.length === 0) {
      setMessage('Начать поездку невозможно, т.к. нет участников со статусом "оплачено". Можно только отменить поездку.');
      return;
    }

    // 3) Время для подтверждения — как и раньше
    const startDateTime = new Date(trip?.date);
    if (trip?.time) {
      const [hours, minutes] = String(trip.time).split(':');
      startDateTime.setHours(Number(hours) || 0, Number(minutes) || 0);
    }
    const formattedDateTime = startDateTime.toLocaleString('ru', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    if (!window.confirm(`Вы хотите начать поездку до ${formattedDateTime} начала поездки? Если вы нажмёте «Да», участники должны подтвердить своё присутствие.`)) {
      return;
    }

    // 4) Кого исключаем: все, кто НЕ paid и НЕ rejected — по ФАКТУ свежей БД
    const toCancel = rows.filter(p => {
      const st = (p.status || '').toLowerCase();
      return st !== 'paid' && st !== 'rejected';
    });

if (toCancel.length) {
  const ids = toCancel.map(p => p.id);

  // 4.1) Не оплативших помечаем как rejected (а не canceled)
  const { error: updErr } = await supabase
    .from('trip_participants')
    .update({ status: 'rejected' })
    .in('id', ids);
  if (updErr) throw updErr;

  // список исключённых пользователей
  const excludedUserIds = toCancel.map((p) => p.user_id).filter(Boolean);

  // ✅ 4.2) ВАЖНО: чтобы у rejected НЕ было непрочитанных по чатам этой поездки
  // Вставляем СРАЗУ после апдейта статуса и ДО любых cleanup/chat_participants delete
  for (const uid of excludedUserIds) {
    try {
      await supabase.rpc('mark_trip_msgs_read_for_user', {
        p_trip_id: memoizedTripId,
        p_user_id: uid,
      });
    } catch (e) {
      console.warn('handleStartTrip: mark_trip_msgs_read_for_user failed:', e);
    }
  }

  // ⛔ НЕ отправляем им ЛС (иначе появится новое непрочитанное у rejected)
  // Если хочешь уведомление — пиши в общий чат поездки (trip_group), но не в ЛС.
}


    // 5) Переводим поездку в started
    const { error: tripErr } = await supabase
      .from('trips')
      .update({ status: 'started' })
      .eq('id', memoizedTripId);
    if (tripErr) throw tripErr;

    setMessage('Поездка начата! Участники уведомлены о необходимости подтвердить присутствие.');

    // Уведомляем только реальных оплаченных (из свежей БД)
    for (const p of paid) {
      await sendMessage(
        p.user_id,
        `Поездка "${trip?.title}" началась! Пожалуйста, подтвердите своё присутствие в приложении.`
      );
    }

    // 6) Финальный рефетч, чтобы UI у организатора 1:1 совпал с БД
    await fetchParticipants();
    setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
  } catch (error) {
    console.error('Ошибка при начале поездки:', { error: error.message, tripId: memoizedTripId });
    setMessage('Ошибка начала поездки');
  }
}

  // ================================ Отмена поездки ================================
  async function handleCancelTrip() {
    try {
      const paidParticipants = participants.filter(p => p.status === 'paid');
      const confirmMessage = paidParticipants.length > 0
        ? `Вы собираетесь отменить поездку "${trip?.title}". Всем участникам с оплаченным статусом будут возвращены средства в полном объёме. Вы уверены, что хотите продолжить?`
        : `Вы собираетесь отменить поездку "${trip?.title}". Вы уверены, что хотите продолжить?`;
      setConfirmModal({ open: true, action: 'cancel', participantId: null, confirmMessage });
    } catch (error) {
      console.error('Ошибка при инициации отмены поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка отмены поездки');
    }
  }

  async function confirmCancelTrip() {
  try {
    const session = await supabase.auth.getSession();
    const accessToken = session.data.session?.access_token;
    if (!accessToken) {
      setMessage('Ошибка: Необходимо авторизоваться');
      return;
    }

    const resp = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/canceltrip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ tripId: memoizedTripId }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error || 'Ошибка запуска отмены поездки');

    setMessage('Отмена поездки запущена…');
    setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });

    setTimeout(async () => {
      await fetchTrip();
      await fetchParticipants();
    }, 2000);
  } catch (error) {
    console.error('Ошибка при подтверждении отмены поездки:', { error: error.message, tripId: memoizedTripId });
    setMessage(`Ошибка отмены поездки: ${error.message}`);
    setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
  }
}


  // ================================ Редактирование/завершение ================================
  async function handleEditTrip(router) {
    try {
      const hasActive = participants.some((p) => p.status === 'confirmed' || p.status === 'waiting' || p.status === 'paid');
      if (hasActive) {
        setMessage('Есть присоединённые к поездке');
        return;
      }
      router.push(`/trips/edit/${memoizedTripId}`);
    } catch (error) {
      console.error('Ошибка при редактировании поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка редактирования поездки');
    }
  }

  async function handleFinishTrip() {
    try {
      if (trip?.status !== 'started') {
        setMessage('Поездку можно завершить только после начала');
        return;
      }

      const disputePeriodEnds = new Date();
      disputePeriodEnds.setHours(disputePeriodEnds.getHours() + 12);

      const { error } = await supabase
        .from('trips')
        .update({
          status: 'finished',
          dispute_period_ends_at: disputePeriodEnds.toISOString(),
        })
        .eq('id', memoizedTripId);
      if (error) throw error;

      setMessage('Поездка завершена');
      await fetchParticipants();

      const confirmedParticipants = participants.filter(p => p.status === 'confirmed' || p.status === 'paid');
      for (const p of confirmedParticipants) {
        await sendMessage(p.user_id, `Поездка "${trip?.title}" завершена. Одобрите или откройте спор (12ч).`);
      }
    } catch (error) {
      console.error('Ошибка при завершении поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка завершения поездки');
    }
  }

  // ================================ Выплата организатору ================================
  async function handlePayoutOrganizer() {
    try {
      if (trip?.status !== 'finished') {
        setMessage('Выплата доступна только после завершения поездки');
        return;
      }

      const now = new Date();
      const disputePeriodEnds = trip?.dispute_period_ends_at
        ? new Date(trip.dispute_period_ends_at)
        : now;
      if (now < disputePeriodEnds) {
        setMessage('Нельзя выплачивать до окончания окна споров');
        return;
      }

      // Считаем сумму — сумма всех подтверждённых платежей (confirmed) по поездке
      const { data: payments, error: paymentsError } = await supabase
        .from('payments')
        .select('amount')
        .eq('trip_id', memoizedTripId)
        .eq('status', 'confirmed')
        .eq('payment_type', 'participant_payment');
      if (paymentsError) throw paymentsError;

      const totalAmount = (payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      if (!trip?.deal_id) {
        setMessage('Ошибка: отсутствует deal_id для выплаты');
        return;
      }

      const orderId = crypto.createHash('sha256').update(`${memoizedTripId}-payout-${Date.now()}`).digest('hex').slice(0, 50);
      const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/payout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
        },
        body: JSON.stringify({
          tripId: memoizedTripId,
          amount: totalAmount,
          dealId: trip?.deal_id,
          recipientId: `+${trip?.phone}`,
          orderId,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      if (data.success) {
        const { error: insertError } = await supabase
          .from('payments')
          .insert({
            trip_id: memoizedTripId,
            participant_id: trip?.creator_id,
            amount: totalAmount,
            status: 'confirmed',
            payment_id: data.paymentId,
            payment_type: 'organizer_payout',
            deal_id: trip?.deal_id,
            order_id: orderId,
            created_at: new Date().toISOString(),
          });
        if (insertError) throw insertError;

        setMessage('Выплата организатору выполнена');
        const confirmedParticipants = participants.filter(p => p.status === 'confirmed' || p.status === 'paid');
        for (const p of confirmedParticipants) {
          await sendMessage(p.user_id, `Организатор получил выплату за поездку "${trip?.title}"`);
        }
      } else {
        throw new Error(data.error || 'Ошибка выплаты');
      }
    } catch (error) {
      console.error('Ошибка при выплате организатору:', { error: error.message, tripId: memoizedTripId });
      setMessage(`Ошибка выплаты организатору: ${error.message}`);
    }
  }

  // ================================ Одобрение + выплата ================================
  async function approveAndPayout(participantId) {
    try {
      if (!user) {
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      if (!participantId) {
        setMessage('Ошибка: ID участника не определён');
        return;
      }
      if (String(trip?.status || '').toLowerCase() !== 'finished') {
        setMessage('Одобрить можно только после завершения поездки');
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }

      const resp = await fetch('/api/tbank/payout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: 'participant-approval',
          tripId: memoizedTripId,
          participantId, // это id строки trip_participants
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.success) {
        throw new Error(data?.error || 'Ошибка выплаты');
      }

      // ✅ помечаем «одобрено» сразу, чтобы UI мгновенно спрятал кнопки
      await supabase
        .from('trip_participants')
        .update({ approved_trip: true })
        .eq('id', participantId);

      // Обновим таблицу участников
      await fetchParticipants();

      // Закрываем модалку подтверждения
      setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });

      // Показать всплывающее уведомление (toast) — это ваш существующий механизм pop-up
      setMessage('Поездка одобрена ✅. Выплата организатору произведена. Пожалуйста, оставьте отзыв об организаторе — это важно для качества сервиса.');

    } catch (error) {
      console.error('approveAndPayout error:', error);
      setMessage(`Ошибка: ${error.message}`);
      // на всякий — закрыть модалку, чтобы не залипала
      setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
    }
  }

  return {
    fetchTrip,
    handlePay,
    handleStartTrip,
    handleCancelTrip,
    confirmCancelTrip,
    handleEditTrip,
    handleFinishTrip,
    handlePayoutOrganizer,
    approveAndPayout,
  };
}
