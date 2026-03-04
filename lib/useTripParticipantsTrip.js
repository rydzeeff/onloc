import crypto from 'crypto';
import { createTripAlert } from './tripAlerts';

// Функции управления поездкой и платежами
export const useTripParticipantsTrip = ({
  memoizedTripId,
  trip,
  setTrip,
  participants,
  setMessage,
  setConfirmModal,
  user,
  setParticipantReviewSent,
  setIndividualReviews,
  individualReviews,
  setBulkReviewSent,
  setReviewModal,
  reviewText,
  rating,
  evidenceFile,
  sendMessage,
  getUserFullName,
  fetchParticipants,
  supabase,
}) => {
  async function notifyTripAlert({ userId, type, title, body, actorUserId = null, metadata = {} }) {
    if (!userId) return;
    await createTripAlert({
      userId,
      tripId: memoizedTripId,
      type,
      title,
      body,
      actorUserId,
      metadata,
      client: supabase,
    });
  }

  // ============== ВСПОМОГАТЕЛЬНОЕ: поиск/создание чата-диспута ==============
  async function ensureDisputeChat({ tripId, initiatorId, respondentId, disputeId, reasonText }) {
    // 1) Ищем существующие чаты-диспуты по этой поездке, где есть оба участника
    const { data: disputeChats } = await supabase
      .from('chats')
      .select('id')
      .eq('trip_id', tripId)
      .eq('chat_type', 'dispute');

    let existingChatId = null;
    if (Array.isArray(disputeChats) && disputeChats.length) {
      const chatIds = disputeChats.map(c => c.id);
      const { data: parts } = await supabase
        .from('chat_participants')
        .select('chat_id, user_id')
        .in('chat_id', chatIds);

      if (Array.isArray(parts) && parts.length) {
        const byChat = parts.reduce((acc, r) => {
          (acc[r.chat_id] ||= new Set()).add(r.user_id);
          return acc;
        }, {});
        for (const chatId of chatIds) {
          const set = byChat[chatId] || new Set();
          if (set.has(initiatorId) && set.has(respondentId)) {
            existingChatId = chatId;
            break;
          }
        }
      }
    }

    // 2) Если чат найден — вернём его
    if (existingChatId) return existingChatId;

    // 3) Иначе создаём новый чат-диспут
    const title = `Диспут по поездке: ${trip?.title || ''}`;
    const { data: newChat, error: chatErr } = await supabase
      .from('chats')
      .insert({
        title,
        trip_id: tripId,
        chat_type: 'dispute',
        is_group: true,
        moderator_id: null, // админ присоединится в админке
        support_close_requested_at: null,
        support_close_confirmed: null,
      })
      .select('id')
      .single();
    if (chatErr) throw chatErr;

    const chatId = newChat.id;

    // 4) Добавляем участников (инициатор и организатор)
    const partsInsert = [
      { chat_id: chatId, user_id: initiatorId },
      { chat_id: chatId, user_id: respondentId },
    ];
    const { error: cpErr } = await supabase.from('chat_participants').insert(partsInsert);
    if (cpErr) throw cpErr;

    // 5) Первое сообщение с причиной спора — от инициатора
    if (reasonText && reasonText.trim()) {
      const { error: msgErr } = await supabase.from('chat_messages').insert({
        chat_id: chatId,
        user_id: initiatorId,
        content: `Открыт спор: ${reasonText.trim()}`,
        created_at: new Date().toISOString(),
        read: false,
      });
      if (msgErr) throw msgErr;
    }

    return chatId;
  }

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
      setTrip({ ...tripData, phone: tripData.profiles?.phone });
      console.log('Поездка загружена:', { tripId: memoizedTripId, phone: tripData.profiles?.phone, deal_id: tripData.deal_id });
    } catch (error) {
      console.error('Ошибка при загрузке поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка загрузки поездки');
    }
  }

  // ========================== Сообщение организатору ==========================
  async function handleSendMessage() {
    try {
      console.log('Отправка сообщения организатору:', { tripId: memoizedTripId });
      await sendMessage(trip?.creator_id, reviewText);
      setMessage('Сообщение отправлено');
      setReviewModal({ open: false, organizerId: null });
      // setReviewText('') — предполагается в родительском хоке/компоненте
      console.log('Сообщение отправлено успешно');
    } catch (error) {
      console.error('Ошибка отправки сообщения:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка отправки сообщения');
    }
  }

  // ============================== Инициация оплаты ==============================
  // opts = { selectedCardId, saveCard, customerKey }
  async function handlePay(participantId, opts = {}) {
    try {
      console.log('=== Инициация оплаты:', { participantId, tripId: memoizedTripId, opts });

      // 1) Авторизация/валидации
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      console.log('Токен авторизации:', { hasToken: !!accessToken });
      if (!accessToken) {
        console.error('Токен авторизации отсутствует');
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      if (!participantId) {
        console.error('participantId отсутствует:', { tripId: memoizedTripId });
        setMessage('Ошибка: ID участника не определён');
        return;
      }
      const participant = participants.find(p => p.id === participantId);
      if (!participant) {
        console.warn('Участник не найден:', { participantId });
        setMessage('Участник не найден');
        return;
      }
      if (String(participant.status || '').toLowerCase() !== 'confirmed') {
        console.warn('Недопустимый статус участника для оплаты:', { participantId, status: participant.status });
        setMessage('Оплата доступна только для подтверждённых участников');
        return;
      }
      if (!trip?.price || Number(trip.price) <= 0) {
        console.warn('Некорректная цена поездки:', { price: trip?.price });
        setMessage('Ошибка: цена поездки не установлена');
        return;
      }

      // 2) orderId
      const rawOrderId = `${memoizedTripId}-${participantId}-${Date.now()}`;
      const orderId = crypto.createHash('sha256').update(rawOrderId).digest('hex').slice(0, 50);
      console.log('Сгенерирован OrderId:', { orderId, length: orderId.length });

      // 3) Проверка дублей — безопасно
      const { data: existingPayment, error: existingPaymentError } = await supabase
        .from('payments')
        .select('id')
        .eq('order_id', orderId)
        .maybeSingle(); // ← заменено с .single() на .maybeSingle()

      if (existingPaymentError) {
        console.error('Ошибка проверки существующего платежа:', { error: existingPaymentError.message });
        throw existingPaymentError;
      }
      if (existingPayment) {
        console.error('Платёж с таким order_id уже существует:', { orderId });
        setMessage('Ошибка: Платёж с таким идентификатором уже существует');
        return;
      }

      // 4) Предварительная запись о платеже
      const { error: paymentError } = await supabase
        .from('payments')
        .insert({
          trip_id: memoizedTripId,
          participant_id: participant.user_id,
          amount: Number(trip?.price),
          status: 'pending',
          order_id: orderId,
          payment_type: 'participant_payment',
          deal_id: trip?.deal_id || null,
          created_at: new Date().toISOString(),
        });
      if (paymentError) {
        console.error('Ошибка сохранения предварительной записи платежа:', { error: paymentError.message });
        throw paymentError;
      }
      console.log('Предварительная запись платежа сохранена:', { orderId, deal_id: trip?.deal_id });

      // 5) URL'ы для API
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
      const notificationUrl = `${baseUrl}/api/tbank/payment-notification`;
      const successUrl = `${baseUrl}/payment-result?status=success&orderId=${orderId}`;
      const failUrl = `${baseUrl}/payment-result?status=fail&orderId=${orderId}`;
      console.log('URLs для Tinkoff:', { notificationUrl, successUrl, failUrl });

      // Параметры выбора карты
      const selectedCardId = opts?.selectedCardId || null;
      const saveCard = !!opts?.saveCard;
      const customerKey = (opts?.customerKey || user?.id || '').toString();

      // 6) Инициация платёжной сессии
      const response = await fetch(`${baseUrl}/api/tbank/init-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          tripId: memoizedTripId,
          participantId: participant.user_id,
          amount: Number(trip?.price),
          orderId,
          dealId: trip?.deal_id || null,
          notificationUrl,
          successUrl,
          failUrl,
          selectedCardId,
          saveCard,
          customerKey,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error('init-payment HTTP error:', { status: response.status, data });
        setMessage(data?.error || 'Ошибка инициации оплаты');
        return;
      }

      if (data.success) {
        // если прилетел новый dealId — аккуратно обновим локальный стейт
        if (data.dealId && !trip?.deal_id) {
          const { data: updatedTrip, error: tripUpdateError } = await supabase
            .from('trips')
            .select('deal_id')
            .eq('id', memoizedTripId)
            .maybeSingle();
          if (tripUpdateError) {
            console.error('Ошибка проверки deal_id в trips:', { error: tripUpdateError.message });
          } else {
            setTrip((prev) => ({ ...prev, deal_id: updatedTrip?.deal_id || data.dealId }));
          }
        }

        const paymentUrl = data?.paymentUrl || data?.redirectUrl;
        if (!paymentUrl) {
          console.error('paymentUrl не получен от init-payment:', data);
          setMessage('Ошибка: ссылка на оплату не получена');
          return;
        }
        console.log('Платёж инициирован, переход:', { paymentUrl });
        window.location.href = paymentUrl;
      } else {
        console.error('Ошибка инициации платежа:', { error: data.error, details: data.details });
        setMessage(`Ошибка инициации платежа: ${data.details || data.error || 'Неизвестная ошибка'}`);
      }
    } catch (error) {
      console.error('Ошибка обработки платежа:', { error: error.message, participantId, tripId: memoizedTripId });
      setMessage(`Ошибка обработки платежа: ${error.message}`);
    }
  }

  // ================================ Начало поездки ================================
  async function handleStartTrip() {
    try {
      console.log('Инициация начала поездки:', { tripId: memoizedTripId });
      const confirmedParticipants = participants.filter(p => p.status === 'confirmed' || p.status === 'paid');
      if (confirmedParticipants.length === 0) {
        setMessage('Начать поездку невозможно, т.к. нет участников. Можно только отменить поездку.');
        console.warn('Нет подтверждённых участников');
        return;
      }

      const paidParticipants = participants.filter(p => p.status === 'paid');
      if (paidParticipants.length === 0) {
        setMessage('Начать поездку невозможно, т.к. нет участников со статусом оплачено. Можно только отменить поездку.');
        console.warn('Нет оплаченных участников');
        return;
      }

      const startDateTime = new Date(trip?.date);
      if (trip?.time) {
        const [hours, minutes] = trip.time.split(':');
        startDateTime.setHours(hours, minutes);
      }
      const formattedDateTime = startDateTime.toLocaleString('ru', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      if (!window.confirm(`Вы хотите начать поездку до ${formattedDateTime} начала поездки? Если вы нажмёте да, участники должны подтвердить своё присутствие.`)) {
        console.log('Начало поездки отменено пользователем');
        return;
      }

      const unpaidParticipants = participants.filter(p => p.status !== 'paid' && p.status !== 'rejected');
      if (unpaidParticipants.length > 0) {
        console.log('Исключение неоплаченных участников:', { count: unpaidParticipants.length });
        for (const participant of unpaidParticipants) {
          const { error } = await supabase
            .from('trip_participants')
            .update({ status: 'rejected' })
            .eq('id', participant.id);
          if (error) {
            console.error('Ошибка исключения участника:', { error: error.message });
            throw error;
          }
          await notifyTripAlert({
            userId: participant.user_id,
            type: 'trip_auto_excluded_unpaid',
            title: 'Вы исключены из поездки',
            body: `Вы исключены из поездки «${trip?.title || ''}» за неоплату. Отзыв невозможен.`,
            actorUserId: trip?.creator_id || null,
            metadata: { tripTitle: trip?.title || null },
          });
        }
      }

      const { error } = await supabase.from('trips').update({ status: 'started' }).eq('id', memoizedTripId);
      if (error) {
        console.error('Ошибка начала поездки:', { error: error.message });
        throw error;
      }
      setMessage('Поездка начата! Участники уведомлены о необходимости подтвердить присутствие.');
      for (const participant of paidParticipants) {
        await notifyTripAlert({
          userId: participant.user_id,
          type: 'trip_started_checkin_required',
          title: 'Поездка началась',
          body: `Поездка «${trip?.title || ''}» началась! Подтвердите своё присутствие в приложении.`,
          actorUserId: trip?.creator_id || null,
          metadata: { tripTitle: trip?.title || null },
        });
      }

      await fetchParticipants();
      setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
      console.log('Поездка начата успешно');
    } catch (error) {
      console.error('Ошибка при начале поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка начала поездки');
    }
  }

  // ================================ Отмена поездки ================================
  async function handleCancelTrip() {
    try {
      console.log('Инициация отмены поездки:', { tripId: memoizedTripId });
      const paidParticipants = participants.filter(p => p.status === 'paid');
      const confirmMessage = paidParticipants.length > 0
        ? `Вы собираетесь отменить поездку "${trip?.title}". Всем участникам с оплаченным статусом будут возвращены средства в полном объёме. Вы уверены, что хотите продолжить?`
        : `Вы собираетесь отменить поездку "${trip?.title}". Вы уверены, что хотите продолжить?`;
      setConfirmModal({ open: true, action: 'cancel', participantId: null, confirmMessage });
      console.log('Показ модального окна для отмены поездки:', { confirmMessage });
    } catch (error) {
      console.error('Ошибка при инициации отмены поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка отмены поездки');
    }
  }

  async function confirmCancelTrip() {
    try {
      console.log('Подтверждение отмены поездки:', { tripId: memoizedTripId });
      const paidParticipants = participants.filter(p => p.status === 'paid');

      for (const participant of paidParticipants) {
        const { data: payment, error: paymentError } = await supabase
          .from('payments')
          .select('payment_id, amount')
          .eq('participant_id', participant.user_id)
          .eq('trip_id', memoizedTripId)
          .eq('status', 'confirmed')
          .single();
        if (paymentError) {
          console.error('Ошибка получения платежа:', { error: paymentError.message, participantId: participant.user_id });
          throw paymentError;
        }

        if (payment?.payment_id) {
          console.log('Инициация возврата:', { paymentId: payment.payment_id, participantId: participant.user_id });
          const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/cancel`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
            },
            body: JSON.stringify({
              paymentId: payment.payment_id,
              amount: payment.amount,
              tripId: memoizedTripId,
              participantId: participant.user_id,
            }),
          });
          if (!response.ok) {
            const errorText = await response.text();
            console.error('Ошибка HTTP при возврате:', { status: response.status, errorText });
            throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
          }
          const data = await response.json();
          if (!data.success) {
            console.error('Ошибка возврата:', { error: data.error, details: data.details });
            throw new Error(data.error || 'Ошибка возврата');
          }
          console.log('Возврат выполнен:', { paymentId: payment.payment_id, newStatus: data.status, newAmount: data.newAmount });
        }
      }

      const { error } = await supabase
        .from('trips')
        .update({ status: 'canceled' })
        .eq('id', memoizedTripId);
      if (error) {
        console.error('Ошибка отмены поездки:', { error: error.message });
        throw error;
      }

      const { error: participantsError } = await supabase
        .from('trip_participants')
        .update({ status: 'rejected' })
        .eq('trip_id', memoizedTripId)
        .in('status', ['waiting', 'confirmed', 'paid']);
      if (participantsError) {
        console.error('Ошибка обновления статуса участников:', { error: participantsError.message });
        throw participantsError;
      }

      setMessage('Поездка отменена, средства возвращены оплаченным участникам');
      await fetchParticipants();

      const confirmedParticipants = participants.filter(p => p.status === 'confirmed' || p.status === 'paid');
      for (const participant of confirmedParticipants) {
        await notifyTripAlert({
          userId: participant.user_id,
          type: 'trip_canceled_refunded',
          title: 'Поездка отменена',
          body: `Поездка «${trip?.title || ''}» была отменена. Средства возвращены в полном объёме.`,
          actorUserId: trip?.creator_id || null,
          metadata: { tripTitle: trip?.title || null },
        });
      }
      setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
      console.log('Поездка отменена успешно');
    } catch (error) {
      console.error('Ошибка при подтверждении отмены поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage(`Ошибка отмены поездки: ${error.message}`);
      setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
    }
  }

  // ================================ Редактирование/завершение ================================
  async function handleEditTrip(router) {
    try {
      console.log('Редактирование поездки:', { tripId: memoizedTripId });
      const hasActive = participants.some((p) => p.status === 'confirmed' || p.status === 'waiting' || p.status === 'paid');
      if (hasActive) {
        setMessage('Есть присоединённые к поездке');
        console.warn('Редактирование невозможно, есть активные участники');
        return;
      }
      router.push(`/trips/edit/${memoizedTripId}`);
      console.log('Переход к редактированию поездки');
    } catch (error) {
      console.error('Ошибка при редактировании поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка редактирования поездки');
    }
  }

  async function handleFinishTrip() {
    try {
      console.log('Завершение поездки:', { tripId: memoizedTripId });
      if (trip?.status !== 'started') {
        setMessage('Поездку можно завершить только после начала');
        console.warn('Поездка не начата:', { status: trip?.status });
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
      if (error) {
        console.error('Ошибка завершения поездки:', { error: error.message });
        throw error;
      }
      setMessage('Поездка завершена');
      await fetchParticipants();

      const confirmedParticipants = participants.filter(p => p.status === 'confirmed' || p.status === 'paid');
      for (const participant of confirmedParticipants) {
        await notifyTripAlert({
          userId: participant.user_id,
          type: 'trip_finished',
          title: 'Поездка завершена',
          body: `Поездка «${trip?.title || ''}» завершена. Одобрите поездку или откройте спор (12 часов).`,
          actorUserId: trip?.creator_id || null,
          metadata: { tripTitle: trip?.title || null },
        });
      }
      console.log('Поездка завершена успешно');
    } catch (error) {
      console.error('Ошибка при завершении поездки:', { error: error.message, tripId: memoizedTripId });
      setMessage('Ошибка завершения поездки');
    }
  }

  // ================================ Выплата организатору ================================
  async function handlePayoutOrganizer() {
    try {
      console.log('Инициация выплаты организатору:', { tripId: memoizedTripId });
      if (trip?.status !== 'finished') {
        setMessage('Выплата доступна только после завершения поездки');
        console.warn('Поездка не завершена:', { status: trip?.status });
        return;
      }

      const now = new Date();
      const disputePeriodEnds = trip?.dispute_period_ends_at ? new Date(trip.dispute_period_ends_at) : null;
      // Если период споров ещё идёт — запрещаем выплату при наличии открытых споров
      if (!disputePeriodEnds || now < disputePeriodEnds) {
        const { data: disputes, error } = await supabase
          .from('disputes')
          .select('id, status')
          .eq('trip_id', memoizedTripId)
          .in('status', ['awaiting_moderator', 'in_progress']);
        if (error) {
          console.error('Ошибка проверки споров:', { error: error.message });
          throw error;
        }
        if ((disputes || []).length > 0) {
          setMessage('Нельзя выплатить организатору: есть открытые споры');
          console.warn('Есть открытые споры:', { disputeCount: disputes.length });
          return;
        }
      }

      const { data: payments, error: paymentError } = await supabase
        .from('payments')
        .select('amount')
        .eq('trip_id', memoizedTripId)
        .eq('status', 'confirmed')
        .eq('payment_type', 'participant_payment');
      if (paymentError) {
        console.error('Ошибка получения платежей:', { error: paymentError.message });
        throw paymentError;
      }

      const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0);
      if (totalAmount <= 0) {
        setMessage('Нет средств для выплаты');
        console.warn('Нет средств для выплаты:', { totalAmount });
        return;
      }

      console.log('Инициация выплаты:', { totalAmount, dealId: trip?.deal_id });
      if (!trip?.deal_id) {
        console.error('deal_id отсутствует для поездки:', { tripId: memoizedTripId });
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
        if (insertError) {
          console.error('Ошибка записи выплаты:', { error: insertError.message });
          throw insertError;
        }

        setMessage('Выплата организатору выполнена');
        const confirmedParticipants = participants.filter(p => p.status === 'confirmed' || p.status === 'paid');
        for (const participant of confirmedParticipants) {
          await notifyTripAlert({
            userId: participant.user_id,
            type: 'trip_organizer_payout',
            title: 'Выплата организатору выполнена',
            body: `Организатор получил выплату за поездку «${trip?.title || ''}».`,
            actorUserId: trip?.creator_id || null,
            metadata: { tripTitle: trip?.title || null },
          });
        }
        console.log('Выплата организатору выполнена:', { totalAmount, dealId: trip?.deal_id });
      } else {
        console.error('Ошибка выплаты:', { error: data.error });
        throw new Error(data.error || 'Ошибка выплаты');
      }
    } catch (error) {
      console.error('Ошибка при выплате организатору:', { error: error.message, tripId: memoizedTripId });
      setMessage(`Ошибка выплаты организатору: ${error.message}`);
    }
  }

  // ================================ Отзывы ================================
  async function handleSubmitReview(participantId, isBulk) {
    try {
      console.log('=== Отправка отзыва:', { participantId, isBulk, tripId: memoizedTripId, rating, reviewTextLength: reviewText.length });
      if (!user) {
        console.warn('Пользователь не авторизован');
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      if (!reviewText || rating === 0) {
        console.warn('Отзыв неполный');
        setMessage('Введите текст отзыва и оценку');
        return;
      }

      const reviewTable = trip.is_company_trip ? 'company_reviews' : 'reviews';
      console.log('Таблица отзывов:', { reviewTable });

      if (isBulk) {
        const allParticipants = participants.filter(p => p.status !== 'rejected' && !individualReviews.has(p.user_id));
        console.log('Участники для bulk отзыва:', { count: allParticipants.length });
        if (allParticipants.length === 0) {
          console.warn('Нет участников для отзыва');
          setMessage('Отзыв уже оставлен вами для данной поездки.');
          return;
        }
        for (const p of allParticipants) {
          const { error } = await supabase
            .from(reviewTable)
            .insert({
              trip_id: memoizedTripId,
              reviewer_id: user.id,
              organizer_id: p.user_id,
              rating,
              text: reviewText,
              created_at: new Date().toISOString(),
            });
          if (error) {
            console.error('Ошибка вставки отзыва для:', { user_id: p.user_id, error: error.message });
            throw error;
          }
          setIndividualReviews(prev => new Set([...prev, p.user_id]));
          console.log('Добавлен отзыв для:', { user_id: p.user_id });
        }
        setBulkReviewSent(true);
        setMessage('Отзывы отправлены всем участникам');
        console.log('Bulk отзыв отправлен, bulkReviewSent: true, individualReviews size:', individualReviews.size + allParticipants.length);
      } else if (trip.creator_id === user.id) { // isCreator
        const targetUserId = participants.find(p => p.id === participantId)?.user_id;
        if (!targetUserId) {
          console.warn('Целевой user_id не найден');
          setMessage('Участник не найден');
          return;
        }
        if (individualReviews.has(targetUserId)) {
          console.warn('Отзыв уже оставлен для этого участника');
          setMessage('Отзыв уже оставлен вами для данной поездки.');
          return;
        }
        const { error } = await supabase
          .from(reviewTable)
          .insert({
            trip_id: memoizedTripId,
            reviewer_id: user.id,
            organizer_id: targetUserId,
            rating,
            text: reviewText,
            created_at: new Date().toISOString(),
          });
        if (error) {
          console.error('Ошибка вставки индивидуального отзыва:', { error: error.message });
          throw error;
        }
        setIndividualReviews(prev => new Set([...prev, targetUserId]));
        const allParticipants = participants.filter(p => p.status !== 'rejected');
        if (individualReviews.size + 1 >= allParticipants.length) {
          setBulkReviewSent(true);
          console.log('Все участники имеют отзывы после individual, bulkReviewSent: true');
        }
        setMessage('Отзыв отправлен');
        console.log('Individual отзыв отправлен для:', { targetUserId });
      } else { // Участник
        // participantReviewSent берётся из внешнего состояния — оставляю как в исходнике
        if (participantReviewSent) {
          console.warn('Отзыв уже оставлен участником');
          setMessage('Отзыв уже оставлен вами для данной поездки.');
          return;
        }
        const { error } = await supabase
          .from(reviewTable)
          .insert({
            trip_id: memoizedTripId,
            reviewer_id: user.id,
            organizer_id: trip.creator_id,
            rating,
            text: reviewText,
            created_at: new Date().toISOString(),
          });
        if (error) {
          console.error('Ошибка вставки отзыва участника:', { error: error.message });
          throw error;
        }
        setParticipantReviewSent(true);
        setMessage('Отзыв отправлен');
        console.log('Отзыв участника отправлен, participantReviewSent: true');
      }
      fetchParticipants(); // Обновить UI
    } catch (error) {
      console.error('Ошибка при отправке отзыва:', { error: error.message, participantId, isBulk });
      setMessage('Ошибка отправки отзыва');
    }
  }

  // ================================ Присутствие ================================
  async function handleConfirmPresence(participantId) {
    try {
      console.log('Подтверждение присутствия:', { participantId, tripId: memoizedTripId });
      if (!user) {
        console.warn('Пользователь не авторизован:', { userId: user?.id });
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }

      const { error } = await supabase
        .from('trip_participants')
        .update({ confirmed_start: true })
        .eq('id', participantId);
      if (error) {
        console.error('Ошибка подтверждения присутствия:', { error: error.message });
        throw error;
      }
      setMessage('Присутствие подтверждено');
      await fetchParticipants();
      const fullName = await getUserFullName(user.id);
      await notifyTripAlert({
        userId: trip?.creator_id,
        type: 'trip_presence_confirmed',
        title: 'Участник подтвердил присутствие',
        body: `Участник ${fullName} подтвердил присутствие в поездке «${trip?.title || ''}».`,
        actorUserId: user?.id || null,
        metadata: { tripTitle: trip?.title || null },
      });
      console.log('Присутствие подтверждено');
    } catch (error) {
      console.error('Ошибка при подтверждении присутствия:', { error: error.message, participantId });
      setMessage('Ошибка подтверждения присутствия');
    }
  }

  // ================================ Одобрение ================================
  async function handleApproveTrip(participantId, approved) {
    try {
      console.log('Обновление статуса одобрения:', { participantId, approved, tripId: memoizedTripId });
      if (!user) {
        console.warn('Пользователь не авторизован:', { userId: user?.id });
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }

      const { error } = await supabase
        .from('trip_participants')
        .update({ approved_trip: approved })
        .eq('id', participantId);
      if (error) {
        console.error('Ошибка обновления статуса:', { error: error.message });
        throw error;
      }
      setMessage(approved ? 'Поездка одобрена' : 'Поездка не одобрена');
      await fetchParticipants();
      const fullName = await getUserFullName(user.id);
      await notifyTripAlert({
        userId: trip?.creator_id,
        type: approved ? 'trip_approved_by_participant' : 'trip_not_approved_by_participant',
        title: approved ? 'Поездка одобрена участником' : 'Поездка не одобрена участником',
        body: `Участник ${fullName} ${approved ? 'одобрил' : 'не одобрил'} поездку «${trip?.title || ''}».`,
        actorUserId: user?.id || null,
        metadata: { tripTitle: trip?.title || null, approved: !!approved },
      });
      console.log('Статус одобрения обновлён:', { approved });
    } catch (error) {
      console.error('Ошибка при одобрении поездки:', { error: error.message, participantId });
      setMessage('Ошибка обновления статуса поездки');
    }
  }

  // ================================ СПОР: открыть ================================
  async function handleOpenDispute(participantId, disputeReason) {
    try {
      console.log('Открытие спора:', { participantId, disputeReason, tripId: memoizedTripId });
      if (!user) {
        console.warn('Пользователь не авторизован:', { userId: user?.id });
        setMessage('Ошибка: Необходимо авторизоваться для открытия спора');
        return;
      }
      const participant = participants.find(p => p.id === participantId);
      if (!participant) {
        console.warn('Участник не найден:', { participantId });
        setMessage('Участник не найден');
        return;
      }

      // Проверяем, не существует ли уже спор для этого участника по этой поездке
      const { data: existingDispute, error: disputeError } = await supabase
        .from('disputes')
        .select('id, status')
        .eq('trip_id', memoizedTripId)
        .eq('initiator_id', participant.user_id)
        .single();
      if (disputeError && disputeError.code !== 'PGRST116') {
        console.error('Ошибка проверки спора:', { error: disputeError.message });
        throw disputeError;
      }
      if (existingDispute) {
        setMessage('Спор уже открыт');
        console.warn('Спор уже существует:', { disputeId: existingDispute.id });
        return existingDispute.id;
      }

      // Создаём запись спора со статусом, валидным по CHECK: awaiting_moderator
      const { data: dispute, error: insertError } = await supabase
        .from('disputes')
        .insert([
          {
            trip_id: memoizedTripId,
            initiator_id: participant.user_id,
            respondent_id: trip?.creator_id,
            reason: disputeReason,
            status: 'awaiting_moderator',
            created_at: new Date().toISOString(),
          },
        ])
        .select('id')
        .single();
      if (insertError) {
        console.error('Ошибка создания спора:', { error: insertError.message });
        throw insertError;
      }

      // Создаём/находим групповой чат-диспут и добавляем первое сообщение-претензию
      const chatId = await ensureDisputeChat({
        tripId: memoizedTripId,
        initiatorId: participant.user_id,
        respondentId: trip?.creator_id,
        disputeId: dispute.id,
        reasonText: disputeReason,
      });

      await notifyTripAlert({
        userId: trip?.creator_id,
        type: 'trip_dispute_opened',
        title: 'Открыт спор по поездке',
        body: `Участник ${await getUserFullName(participant.user_id)} открыл спор по поездке «${trip?.title || ''}». Проверьте вкладку «Поддержка».`,
        actorUserId: participant.user_id,
        metadata: { tripTitle: trip?.title || null, disputeId: dispute.id },
      });

      setMessage('Спор открыт. Чат доступен во вкладке «Поддержка».');
      console.log('Спор открыт и чат создан:', { disputeId: dispute.id, chatId });
      return dispute.id;
    } catch (error) {
      console.error('Ошибка при открытии спора:', { error: error.message, participantId });
      setMessage('Ошибка открытия спора');
    }
  }

  // ================================ СПОР: загрузка доказательства ================================
  async function handleUploadEvidence(disputeId, fileArg) {
    try {
      console.log('Загрузка доказательства:', { disputeId, tripId: memoizedTripId });
      if (!user) {
        console.warn('Пользователь не авторизован:', { userId: user?.id });
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      const file = fileArg || evidenceFile;
      if (!file || !disputeId) {
        console.warn('Отсутствует файл или ID спора:', { hasFile: !!file, disputeId });
        setMessage('Выберите файл и спор');
        return;
      }

      const fileExt = file.name.split('.').pop();
      const fileName = `${crypto.randomUUID()}.${fileExt}`;
      const filePath = `disputes/${disputeId}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('evidence')
        .upload(filePath, file);
      if (uploadError) {
        console.error('Ошибка загрузки доказательства:', { error: uploadError.message });
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from('evidence')
        .getPublicUrl(filePath);

      const { error: insertError } = await supabase
        .from('dispute_evidences')
        .insert([
          {
            dispute_id: disputeId,
            file_url: publicUrlData.publicUrl,
            uploaded_by: user.id,
            created_at: new Date().toISOString(),
          },
        ]);
      if (insertError) {
        console.error('Ошибка записи доказательства:', { error: insertError.message });
        throw insertError;
      }

      setMessage('Доказательство загружено');
      // Дополнительно можно вставить системное сообщение в чат-диспут (опционально)
      console.log('Доказательство загружено:', { filePath });
    } catch (error) {
      console.error('Ошибка при загрузке доказательства:', { error: error.message, disputeId });
      setMessage('Ошибка загрузки доказательства');
    }
  }

  // ================================ Одобрение + выплата ================================
  async function approveAndPayout(participantId) {
    try {
      console.log('approveAndPayout:', { participantId, tripId: memoizedTripId });
      if (!user) {
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      if (!participantId) {
        setMessage('Ошибка: ID участника не определён');
        return;
      }
      if (trip?.status?.toLowerCase() !== 'finished') {
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
          participantId,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data?.error || 'Ошибка выплаты');
      }

      setMessage('Одобрено. Выплата организатору инициирована.');
      await fetchParticipants(); // обновим approved/payout-флаги
    } catch (error) {
      console.error('approveAndPayout error:', error);
      setMessage(`Ошибка: ${error.message}`);
    }
  }

  return {
    fetchTrip,
    handleSendMessage,
    handlePay,               // ← поддерживает opts
    handleStartTrip,
    handleCancelTrip,
    confirmCancelTrip,
    handleEditTrip,
    handleFinishTrip,
    handlePayoutOrganizer,
    handleSubmitReview,
    handleConfirmPresence,
    handleApproveTrip,
    handleOpenDispute,
    handleUploadEvidence,
    approveAndPayout,
  };
};
