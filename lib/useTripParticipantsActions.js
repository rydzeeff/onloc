// lib/useTripParticipantsActions.js

import { platformSettings } from './platformSettings'; // комиссии площадки и банка
import { calculateNetAmountAfterFees } from './tbankFees';
import { notifications } from '../pages/_app';
import { createTripAlert } from './tripAlerts';

// Функции управления участниками
export const useTripParticipantsActions = ({
  memoizedTripId,
  trip,
  participants,
  setParticipants,
  setMessage,
  setActionDropdown,
  user,
  setConfirmModal,
  getUserFullName,
  sendMessage,
  getChatId,            // оставлено для совместимости
  calculateRefund,
  supabase,
}) => {
  // Вспомогательная: загрузить участников с рейтингами
  async function fetchParticipants() {
    try {
      const { data: participantsData, error: participantsError } = await supabase
        .rpc('get_trip_participants_with_details', { trip_uuid: memoizedTripId });

      if (participantsError) {
        console.error('Ошибка Supabase при загрузке участников:', participantsError);
        setParticipants([]);
        setMessage('Ошибка загрузки участников');
        return;
      }

      // Посчитаем средний рейтинг (как было)
      const updatedParticipants = await Promise.all(
        (participantsData || []).map(async (participant) => {
          const { data: reviewsData } = await supabase
            .from('reviews')
            .select('rating')
            .eq('organizer_id', participant.user_id);
          const { data: companyReviewsData } = await supabase
            .from('company_reviews')
            .select('rating')
            .eq('organizer_id', participant.user_id);

          const allRatings = [
            ...(reviewsData || []).map(r => r.rating),
            ...(companyReviewsData || []).map(r => r.rating),
          ];
          const averageRating = allRatings.length > 0
            ? allRatings.reduce((s, r) => s + r, 0) / allRatings.length
            : 0;

          return { ...participant, average_rating: averageRating };
        })
      );

      // 🔁 Фолбэк: если RPC не вернул confirmed_start / approved_trip — дочитаем из trip_participants
      const sample = updatedParticipants?.[0] || {};
      let mergedWithFlags = updatedParticipants;

      if (!Object.prototype.hasOwnProperty.call(sample, 'confirmed_start')
          || !Object.prototype.hasOwnProperty.call(sample, 'approved_trip')) {
        const { data: flagsRows, error: flagsErr } = await supabase
          .from('trip_participants')
          .select('id, confirmed_start, approved_trip')
          .eq('trip_id', memoizedTripId);
        if (flagsErr) {
          console.warn('Не удалось получить флаги присутствия/одобрения (fallback):', flagsErr);
        } else {
          const byId = Object.fromEntries((flagsRows || []).map(r => [
            r.id,
            { confirmed_start: !!r.confirmed_start, approved_trip: r.approved_trip }
          ]));
          mergedWithFlags = (updatedParticipants || []).map(p => ({
            ...p,
            ...(byId[p.id] || {}),
          }));
        }
      }

      // 🧭 Догружаем открытые споры: has_open_dispute
      let finalParticipants = mergedWithFlags;
      try {
        const { data: disputesRows, error: disputesErr } = await supabase
          .from('disputes')
          .select('initiator_id, status')
          .eq('trip_id', memoizedTripId);

        if (!disputesErr && disputesRows) {
          const CLOSED = new Set(['closed','resolved','rejected','cancelled','canceled']);
          const openSet = new Set(
            disputesRows
              .filter(d => !CLOSED.has(String(d.status || '').toLowerCase()))
              .map(d => d.initiator_id)
          );
          finalParticipants = (mergedWithFlags || []).map(p => ({
            ...p,
            has_open_dispute: openSet.has(p.user_id),
          }));
        }
      } catch (e) {
        console.warn('Не удалось определить открытые споры:', e);
      }

      const hiddenStatuses = new Set(['rejected', 'left']);
      const visibleParticipants = (finalParticipants || []).filter((p) => {
        const status = String(p?.status || '').toLowerCase();
        return !hiddenStatuses.has(status);
      });

      setParticipants(visibleParticipants);
    } catch (error) {
      console.error('Ошибка при загрузке участников:', error);
      setParticipants([]);
      setMessage('Ошибка загрузки участников');
    }
  }

  // ==============================
  // Принятие / отклонение / исключение / выход
  // ==============================

  async function handleAccept(participantId) {
    try {
      const participant = participants.find(p => p.id === participantId);
      if (!participant) return setMessage('Участник не найден');

      const { data: acceptedParticipants, error } = await supabase
        .from('trip_participants')
        .select('id')
        .eq('trip_id', memoizedTripId)
        .in('status', ['confirmed', 'paid']);
      if (error) {
        console.error('Ошибка проверки участников:', error);
        return setMessage('Ошибка проверки количества участников');
      }

      const acceptedCount = acceptedParticipants.length;
      const maxParticipants = trip?.participants;
      if (acceptedCount >= maxParticipants) {
        setMessage(`Принятых участников достаточно: ${acceptedCount} из ${maxParticipants}`);
        setActionDropdown({ open: false, participantId: null, buttonRef: null });
        return;
      }

      const { error: updateError } = await supabase
        .from('trip_participants')
        .update({ status: 'confirmed' })
        .eq('id', participantId);
      if (updateError) throw updateError;

      try {
        await createTripAlert({
          userId: participant.user_id,
          tripId: memoizedTripId,
          type: 'trip_request_accepted',
          title: 'Заявка подтверждена',
          body: `Ваша заявка на поездку «${trip?.title || ''}» подтверждена. Оплатите ${trip?.price} ₽ через форму оплаты.`,
          actorUserId: trip?.creator_id || null,
          metadata: { tripTitle: trip?.title || null, price: trip?.price || null },
          client: supabase,
        });
      } catch (notifyErr) {
        console.error('Ошибка отправки уведомления:', notifyErr);
        setMessage('Пользователь подтверждён, но уведомление отправить не удалось');
      }

      setMessage('Пользователь подтверждён');
      await fetchParticipants();
      setActionDropdown({ open: false, participantId: null, buttonRef: null });
    } catch (error) {
      console.error('Ошибка при принятии участника:', error);
      setMessage('Ошибка подтверждения пользователя');
    }
  }

async function handleReject(participantId) {
  try {
    const participant = participants.find(p => p.id === participantId);
    if (!participant) return setMessage('Участник не найден');

    const { error } = await supabase
      .from('trip_participants')
      .update({ status: 'rejected' })
      .eq('id', participantId);
    if (error) throw error;

    // 1) уведомление (см. Фикс №3 — sendMessage научим "тихо" отправлять)
    try {
      await createTripAlert({
        userId: participant.user_id,
        tripId: memoizedTripId,
        type: 'trip_request_rejected',
        title: 'Заявка отклонена',
        body: `Вас не приняли в поездку «${trip?.title || ''}».`,
        actorUserId: trip?.creator_id || null,
        metadata: { tripTitle: trip?.title || null },
        client: supabase,
      });
    } catch (notifyErr) {
      console.error('reject: notify failed:', notifyErr);
    }

    // 2) погасить "висящие" непрочитанные ЛС организатора с этим участником
    await markPrivateChatsWithParticipantRead(participant.user_id);

await markTripPrivateChatsReadGlobally();

    // 3) для участника: отметить прочитанным и удалить из всех чатов поездки
    await markTripChatsReadForUser(participant.user_id);
    await removeParticipantFromTripChats(participant.user_id);

    setMessage('Пользователь отклонён');
    await fetchParticipants();
    setActionDropdown({ open: false, participantId: null, buttonRef: null });
  } catch (error) {
    console.error('Ошибка при отклонении участника:', error);
    setMessage('Ошибка отклонения пользователя');
  }
}


  // Подтверждение исключения — модалка (Да/Нет всегда)
  async function handleExclude(participantId) {
  try {
    // ✅ Берём участника из БД, а не из кэша
    const { data: fresh, error } = await supabase
      .from('trip_participants')
      .select('id, user_id, status')
      .eq('id', participantId)
      .maybeSingle();

    if (error) {
      console.error('handleExclude: ошибка получения участника из БД', error);
      return setMessage('Не удалось получить данные участника. Попробуйте ещё раз.');
    }
    if (!fresh) return setMessage('Участник не найден');

    const fullName = await getUserFullName(fresh.user_id);
    const isPaid = (fresh.status || '').toLowerCase() === 'paid';

    const confirmMessage = isPaid
      ? `Участник ${fullName} совершил оплату. При исключении ему будут возвращены средства в полном объёме. Продолжить?`
      : `Участник ${fullName} не совершал оплату. При исключении возврата не будет. Продолжить?`;

    setConfirmModal({ open: true, action: 'exclude', participantId, confirmMessage });
  } catch (error) {
    console.error('Ошибка при инициации исключения участника:', error);
    setMessage('Ошибка исключения пользователя');
  }
}


  // ВСПОМОГАТЕЛЬНАЯ: собрать id чатов поездки
  async function getTripChatIds() {
    const { data: tripChats, error: tripChatsErr } = await supabase
      .from('chats')
      .select('id')
      .eq('trip_id', memoizedTripId)
      .in('chat_type', ['trip_group', 'trip_private', 'archived']);
    if (tripChatsErr) throw tripChatsErr;
    return (tripChats || []).map(c => c.id);
  }

  // ВСПОМОГАТЕЛЬНАЯ: прочитать все сообщения этих чатов для КОНКРЕТНОГО user
  // (ставим отметки в chat_message_reads + обнуляем локальные счётчики notifications,
  //  но НЕ трогаем глобальный chat_messages.read — чтобы не сбивать непрочитанное у организатора)
  async function markTripChatsReadForUser(participantUserId) {
    try {
      const chatIds = await getTripChatIds();
      if (!chatIds.length) return;

      const batchSize = 1000;
      let from = 0;

      while (true) {
        const to = from + batchSize - 1;

        const { data: msgs, error: msgsErr, count } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact' })
          .in('chat_id', chatIds)
          .order('id', { ascending: true })
          .range(from, to);

        if (msgsErr) throw msgsErr;

        const ids = (msgs || []).map((m) => m.id);
        if (!ids.length) break;

        const rows = ids.map((id) => ({ message_id: id, user_id: participantUserId }));
        const chunkSize = 1000;

        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const { error: upErr } = await supabase
            .from('chat_message_reads')
            .upsert(chunk, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
          if (upErr) throw upErr;
        }

        from = to + 1;
        if (count !== null && from >= count) break;
      }

      // 3) Сброс локальных счётчиков непрочитанного только в ТЕКУЩЕМ клиенте
      if (typeof notifications?.setUnreadCount === 'function') {
        chatIds.forEach((id) => notifications.setUnreadCount(id, 0));
      }
    } catch (e) {
      console.error('Не удалось проставить прочтение сообщений по поездке:', e);
    }
  }

  // ВСПОМОГАТЕЛЬНАЯ: удалить участника из всех чатов поездки
  async function removeParticipantFromTripChats(participantUserId) {
    try {
      const chatIds = await getTripChatIds();
      if (!chatIds.length) return;
      const { error: delErr } = await supabase
        .from('chat_participants')
        .delete()
        .in('chat_id', chatIds)
        .eq('user_id', participantUserId);
      if (delErr) throw delErr;
    } catch (e) {
      console.error('Не удалось удалить участника из чатов поездки:', e);
    }
  }

// ВСПОМОГАТЕЛЬНАЯ: погасить "висящие" непрочитанные ЛС организатора
// с конкретным участником по этой поездке.
//
// ✅ Если действие делает участник (self-leave) — нельзя писать read за организатора из клиента (RLS),
//    поэтому используем RPC security definer.
// ✅ Если действие делает организатор — можно upsert-ить напрямую в chat_message_reads.
async function markPrivateChatsWithParticipantRead(participantUserId) {
  try {
    const organizerId = trip?.creator_id;
    const actingUserId = user?.id;

    if (!organizerId || !participantUserId) return;

    // 1) self-leave / действие НЕ от лица организатора -> RPC
    if (actingUserId && actingUserId !== organizerId) {
      const { error } = await supabase.rpc('mark_leaver_msgs_read_for_organizer', {
        p_trip_id: memoizedTripId,
        p_leaver_id: participantUserId,
      });
      if (error) throw error;
      return;
    }

    // 2) действие от лица организатора -> можно напрямую upsert reads "для себя"
    const { data: dmChats, error: dmErr } = await supabase
      .from('chats')
      .select('id')
      .eq('trip_id', memoizedTripId)
      .in('chat_type', ['trip_private', 'archived'])
      .eq('is_group', false);

    if (dmErr) throw dmErr;

    const chatIds = (dmChats || []).map((c) => c.id);
    if (!chatIds.length) return;

    const { data: msgs, error: msgsErr } = await supabase
      .from('chat_messages')
      .select('id, chat_id')
      .in('chat_id', chatIds)
      .eq('user_id', participantUserId);

    if (msgsErr) throw msgsErr;

    const nowIso = new Date().toISOString();

    const rows = (msgs || []).map((m) => ({
      message_id: m.id,
      user_id: organizerId,
      chat_id: m.chat_id,      // ✅ под твою схему + индексы
      read_at: nowIso,         // ✅ NOT NULL
    }));

    if (!rows.length) return;

    const { error: upErr } = await supabase
      .from('chat_message_reads')
      .upsert(rows, { onConflict: 'message_id,user_id' });

    if (upErr) throw upErr;
  } catch (e) {
    console.error('Не удалось погасить непрочитанные у организатора по ЛС:', e);
  }
}


// ВСПОМОГАТЕЛЬНАЯ: жёстко погасить непрочитанное в ЛС по поездке (глобально)
// Это нужно, если где-то unread считается по chat_messages.read,
// а не по chat_message_reads.
// ВСПОМОГАТЕЛЬНАЯ: пометить прочитанным ВСЕ сообщения в ЛС поездки
// ✅ Теперь через chat_message_reads, без chat_messages.read
async function markTripPrivateChatsReadGlobally() {
  try {
    const me = user?.id;
    if (!me) return;

    const { data: dmChats, error: dmErr } = await supabase
      .from('chats')
      .select('id')
      .eq('trip_id', memoizedTripId)
      .in('chat_type', ['trip_private', 'archived'])
      .eq('is_group', false);

    if (dmErr) throw dmErr;

    const chatIds = (dmChats || []).map((c) => c.id);
    if (!chatIds.length) return;

    const batchSize = 1000;
    let from = 0;

    while (true) {
      const to = from + batchSize - 1;

      const { data: msgs, error: msgsErr, count } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact' })
        .in('chat_id', chatIds)
        .order('id', { ascending: true })
        .range(from, to);

      if (msgsErr) throw msgsErr;

      const ids = (msgs || []).map((m) => m.id);
      if (!ids.length) break;

      const rows = ids.map((id) => ({ message_id: id, user_id: me }));

      const { error: upErr } = await supabase
        .from('chat_message_reads')
        .upsert(rows, { onConflict: 'message_id,user_id', ignoreDuplicates: true });

      if (upErr) throw upErr;

      from = to + 1;
      if (count !== null && from >= count) break;
    }
  } catch (e) {
    console.error('Не удалось отметить прочитанными ЛС по поездке:', e);
  }
}



  // Подтверждение исключения (вкл. возврат при paid) + очистка непрочитанных + удаление из чатов
  async function confirmExclude(participantId) {
  try {
    // ✅ Снова берём участника из БД, чтобы не зависеть от кэша
    const { data: fresh, error: freshErr } = await supabase
      .from('trip_participants')
      .select('id, user_id, status')
      .eq('id', participantId)
      .maybeSingle();

    if (freshErr) {
      console.error('confirmExclude: ошибка получения участника из БД', freshErr);
      return setMessage('Не удалось получить актуальные данные участника.');
    }
    if (!fresh) return setMessage('Участник не найден');

    const participant = fresh;
    let isPaid = (participant.status || '').toLowerCase() === 'paid';

    // 🔍 Доп.проверка по payments: вдруг статус ещё не успели проставить, но платёж уже есть
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('payment_id, amount, created_at')
      .eq('participant_id', participant.user_id)
      .eq('trip_id', memoizedTripId)
      .eq('status', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (paymentError) throw paymentError;

    if (payment?.payment_id) {
      isPaid = true;
      // Полный возврат при исключении
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          paymentId: payment.payment_id,
          amount: payment.amount,
          tripId: memoizedTripId,
          participantId: participant.user_id,
          reason: 'organizer_exclude',
          notes: `exclude by organizer; trip=${memoizedTripId}; participant=${participant.user_id}`,
        }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      const data = await response.json();
      if (!data?.ok) throw new Error(data?.error || 'Ошибка возврата');
    }

    // помечаем все сообщения прочитанными
    await markTripChatsReadForUser(participant.user_id);

// исключаем
const { error } = await supabase
  .from('trip_participants')
  .update({ status: 'rejected' })
  .eq('id', participantId);
if (error) throw error;

// сообщение участнику (ТИХО, без непрочитанного)
const text = isPaid
  ? `Вы были исключены из поездки "${trip?.title}". Средства возвращены в полном объёме.`
  : `Вы были исключены из поездки "${trip?.title}".`;

try {
  await createTripAlert({
    userId: participant.user_id,
    tripId: memoizedTripId,
    type: isPaid ? 'trip_excluded_with_refund' : 'trip_excluded',
    title: 'Вы исключены из поездки',
    body: text,
    actorUserId: trip?.creator_id || null,
    metadata: { tripTitle: trip?.title || null, refunded: !!isPaid },
    client: supabase,
  });
} catch (e) {
  console.error('exclude: notify failed:', e);
}

// гасим "висящие" непрочитанные ЛС организатора с этим участником
await markPrivateChatsWithParticipantRead(participant.user_id);

await markTripPrivateChatsReadGlobally();

// ВАЖНО: sendMessage мог создать/реанимировать trip_private и снова вставить chat_participants,
// поэтому финальная зачистка должна быть ПОСЛЕ уведомления:
await markTripChatsReadForUser(participant.user_id);
await removeParticipantFromTripChats(participant.user_id);

setMessage(isPaid ? 'Участник был исключён, средства возвращены' : 'Участник был исключён');
await fetchParticipants();
setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
  } catch (error) {
    console.error('Ошибка при подтверждении исключения участника:', error);
    setMessage(`Ошибка исключения участника: ${error.message}`);
    setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
  }
}


  // ==============================
  // Одобрение поездки участником и выплата организатору (п.3) — с учётом комиссий
  // ==============================
  async function approveAndPayout(participantId) {
    try {
      if (!trip || !memoizedTripId) return setMessage('Поездка не найдена');
      if ((trip.status || '').toLowerCase() !== 'finished') {
        return setMessage('Одобрение доступно только после завершения поездки.');
      }

      const row = participants.find(p => p.id === participantId);
      if (!row) return setMessage('Участник не найден');

      // 🔒 Доп. защита: одобрить поездку можно только за СЕБЯ (в своей строке)
      if (!user?.id || row.user_id !== user.id) {
        return setMessage('Можно одобрить поездку только в своей строке участника.');
      }

      if ((row.status || '').toLowerCase() !== 'paid') {
        return setMessage('Только оплаченные участники могут одобрить поездку.');
      }
      if (row.approved_trip === true) {
        return setMessage('Вы уже одобрили поездку.');
      }

      // 1) подтверждённый платёж участника (gross)
      const { data: payment, error: payErr } = await supabase
   .from('payments')
   .select('id, amount, payment_id, participant_id, created_at')
   .eq('trip_id', memoizedTripId)
   .eq('participant_id', row.user_id)
   .eq('status', 'confirmed')
   .eq('payment_type', 'participant_payment')
   .order('created_at', { ascending: false })
   .limit(1)
   .maybeSingle();
      if (payErr || !payment) {
        console.error('Платёж участника не найден:', payErr?.message);
        return setMessage('Подтверждённый платёж участника не найден.');
      }

      const grossAmount = Number(payment.amount || 0);
      if (!(grossAmount > 0)) {
        return setMessage('Некорректная сумма выплаты.');
      }

      // 2) deal_id и реквизиты организатора
      if (!trip.deal_id) {
        return setMessage('Отсутствует deal_id сделки (нельзя выполнить выплату).');
      }

      const { data: organizerProfile, error: orgErr } = await supabase
        .from('profiles')
        .select('user_id, phone, tbank_phone')
        .eq('user_id', trip.creator_id)
        .single();
      if (orgErr || !organizerProfile) {
        console.error('Профиль организатора не найден:', orgErr?.message);
        return setMessage('Профиль организатора не найден.');
      }

      let recipientId = organizerProfile.tbank_phone || organizerProfile.phone || '';
      recipientId = (recipientId || '').trim();
      if (/^79\d{9}$/.test(recipientId)) recipientId = `+${recipientId}`;
      if (!/^\+7\d{10}$/.test(recipientId)) {
        return setMessage('У организатора отсутствует корректный номер для выплаты (+7XXXXXXXXXX).');
      }

      // 3) учёт комиссий: комиссия площадки + комиссии Т-Банка по договору (с минимумами)
      const platformPercent = Number.isFinite(Number(trip?.platform_fee))
        ? Number(trip.platform_fee)
        : Number(platformSettings?.platformFeePercent || 0);
      const tbankCardPercent = Number.isFinite(Number(trip?.tbank_fee))
        ? Number(trip.tbank_fee)
        : Number(platformSettings?.tbankFeePercent || 0);
      const { netAmount } = calculateNetAmountAfterFees(grossAmount, platformPercent, {
        cardFeePercent: tbankCardPercent,
        cardFeeMinRub: platformSettings.tbankCardFeeMinRub,
        payoutFeePercent: platformSettings.tbankPayoutFeePercent,
        payoutFeeMinRub: platformSettings.tbankPayoutFeeMinRub,
      });
      if (!(netAmount > 0)) {
        return setMessage('Сумма к выплате после комиссий не положительная.');
      }

      // 4) вызов payout API — передаём gross и net (на случай, если серверу нужен gross для учёта)
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const resp = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/payout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          tripId: memoizedTripId,
          dealId: trip.deal_id,
          recipientId,
          participantId,     // id строки trip_participants
          grossAmount,       // сумма платежа участника
          netAmount,         // сумма к выплате организатору (после комиссий)
          fees: {
            platformPercent,
            tbankPercent: `${tbankCardPercent}% + ${platformSettings.tbankPayoutFeePercent}% (с минимумами)`,
          },
          finalPayout: true, // сервер может закрыть сделку, если это последняя выплата
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errorText}`);
      }
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || 'Ошибка выплаты');
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

      // Поп-ап (toast): просьба оставить отзыв
      setMessage('Поездка одобрена ✅. Выплата организатору произведена. Пожалуйста, оставьте отзыв об организаторе — это важно для качества сервиса.');

      // Доп. уведомление организатору (без падения UX при ошибке)
      try {
        await createTripAlert({
          userId: trip.creator_id,
          tripId: memoizedTripId,
          type: 'trip_participant_approved',
          title: 'Поездка одобрена участником',
          body: `Участник одобрил поездку «${trip.title || ''}». Выплата ${netAmount} ₽ переведена.`,
          actorUserId: user?.id || null,
          metadata: { tripTitle: trip?.title || null, netAmount },
          client: supabase,
        });
      } catch (_) {}

      window.dispatchEvent(new CustomEvent('tripUpdated', { detail: { tripId: memoizedTripId } }));
    } catch (e) {
      console.error('approveAndPayout error:', e);
      setMessage(`Не удалось выполнить выплату: ${e.message}`);
      setConfirmModal({ open: false, action: null, participantId: null, confirmMessage: '' });
    }
  }

  // ==============================
  // Покидание поездки участником
  // ==============================
 async function handleLeaveTrip(participantId) {
  try {
    const participant = participants.find(p => p.id === participantId);
    if (!participant) return setMessage('Участник не найден');
    if (!trip) return setMessage('Ошибка: Данные поездки не загружены');

    // 0) PRE-CHECK как у кнопки оплаты: check-order перед выходом
try {
  const { data: lastPay, error: lastPayErr } = await supabase
    .from('payments')
    .select('id, order_id, status, is_authorized, is_confirmed, created_at')
    .eq('trip_id', memoizedTripId)
    .eq('participant_id', participant.user_id)
    .eq('payment_type', 'participant_payment')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastPayErr) {
    console.warn('leave: pre-check payments read error:', lastPayErr);
  }

  // ✅ Если платёж уже подтверждён в нашей БД — выход НЕ блокируем.
  const locallyConfirmed =
    lastPay?.status === 'confirmed' || lastPay?.is_confirmed === true;

  if (!locallyConfirmed && lastPay?.order_id) {
    const resp = await fetch('/api/tbank/check-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: lastPay.order_id }),
    });

    const json = await resp.json().catch(() => ({}));
    const bankStatus = String(json?.bank?.status || '').toUpperCase();
    const uiReason = String(json?.ui?.reason || '');

    // Блокируем только "проверяется/завис"
    const checkingStatuses = new Set(['PAY_CHECKING', 'AUTHORIZING', 'AUTHORIZED']);

    // Плюс — блокируем кейс "банк уже CONFIRMED, но у нас ещё не подтвердилось" (ждём вебхук)
    const bankConfirmedButNotLocal =
      bankStatus === 'CONFIRMED' && !locallyConfirmed;

    const checkingReasons = new Set([
      'bank_pay_checking',
      'wait_webhook',
      'webhook_missing_after_10m',
    ]);

    const bankProblem =
      (bankStatus && checkingStatuses.has(bankStatus)) ||
      bankConfirmedButNotLocal ||
      (uiReason && checkingReasons.has(uiReason));

    if (bankProblem) {
      setMessage(
        'Оплата заблокирована, проблема на стороне банка. ' +
          'Если хотите ускорить процесс восстановления оплаты, напишите в тех. поддержку: ' +
          'раздел «Сообщение», вкладка «Поддержка».'
      );
      return; // ⛔ НЕ открываем модалку выхода
    }
  }
} catch (e) {
  console.warn('leave: pre-check check-order failed:', e);
  // если сеть упала — не блокируем выход, идём дальше стандартно
}

    const { refundMessage } = await calculateRefund(trip, participantId);
    if (!refundMessage) return setMessage('Ошибка расчёта возврата');

    const confirmMessage = `${refundMessage} Вы уверены, что хотите покинуть поездку?`;
    setConfirmModal({ open: true, action: 'leave', participantId, confirmMessage });
  } catch (error) {
    console.error('Ошибка при инициации покидания поездки:', error);
    setMessage('Ошибка покидания поездки');
  }
}


       async function confirmLeaveTrip(participantId) {
    try {
      // 0) Берём участника из БД, а не из кэша
      const { data: fresh, error: freshErr } = await supabase
        .from('trip_participants')
        .select('id, user_id, status')
        .eq('id', participantId)
        .maybeSingle();

      if (freshErr) {
        console.error('confirmLeaveTrip: ошибка получения участника из БД', freshErr);
        return setMessage('Не удалось получить актуальные данные участника. Попробуйте ещё раз.');
      }
      if (!fresh) {
        return setMessage('Участник не найден');
      }

      const participant = fresh;

      // 1) Считаем возможный возврат по правилам (независимо от статуса в кэше)
      const { refundAmount } = await calculateRefund(trip, participantId);

      if (refundAmount > 0) {
        // Ищем подтверждённый платёж участника по этой поездке
        const { data: payment, error: paymentError } = await supabase
          .from('payments')
          .select('payment_id, amount, created_at')
          .eq('participant_id', participant.user_id)
          .eq('trip_id', memoizedTripId)
          .eq('status', 'confirmed')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (paymentError) throw paymentError;

        if (payment?.payment_id) {
          const session = await supabase.auth.getSession();
          const token = session.data.session?.access_token;

          const response = await fetch(
            `${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/cancel`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                paymentId: payment.payment_id,
                amount: refundAmount,
                tripId: memoizedTripId,
                participantId: participant.user_id,
                reason: 'self_leave', // важно для бэка
                notes: `self leave; refund per policy; trip=${memoizedTripId}; participant=${participant.user_id}`,
              }),
            }
          );

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
          }

          const data = await response.json();
          if (!data?.ok) {
            throw new Error(data?.error || 'Ошибка возврата');
          }
        } else {
          console.log(
            'self-leave: подтверждённый платёж не найден, возврат не выполняется'
          );
        }
      } else {
        console.log(
          'self-leave: refundAmount=0, возврат не положен по правилам'
        );
      }

      // 2) Помечаем участника как rejected в trip_participants
      const { error: updErr } = await supabase
        .from('trip_participants')
        .update({ status: 'rejected' })
        .eq('id', participantId);
      if (updErr) throw updErr;

      // 3) Оповещение организатору о выходе участника из поездки
      const fullName = await getUserFullName(user?.id);
      try {
        await createTripAlert({
          userId: trip?.creator_id,
          tripId: memoizedTripId,
          type: 'trip_participant_left',
          title: 'Участник покинул поездку',
          body: `Пользователь ${fullName} покинул поездку "${trip?.title || ''}"`,
          actorUserId: user?.id || null,
          metadata: { tripTitle: trip?.title || null },
          client: supabase,
        });
      } catch (msgErr) {
        console.error('Ошибка отправки оповещения о выходе из поездки:', msgErr);
      }

      // 4) Сбросить "висящие" непрочитанные ЛС организатора именно с ЭТИМ участником
      await markPrivateChatsWithParticipantRead(participant.user_id);

      // 5) Для самого участника — отметить все сообщения поездки прочитанными
      //    и убрать его из chat_participants
      await markTripChatsReadForUser(participant.user_id);
      await removeParticipantFromTripChats(participant.user_id);

      // 6) UI / обновление
      setMessage(
        'Вы покинули поездку. Возврат (если он полагается по правилам) инициирован.'
      );
      await fetchParticipants();

      setConfirmModal({
        open: false,
        action: null,
        participantId: null,
        confirmMessage: '',
      });

      window.dispatchEvent(
        new CustomEvent('tripUpdated', { detail: { tripId: memoizedTripId } })
      );
    } catch (error) {
      console.error('Ошибка при подтверждении покидания поездки:', error);
      setMessage(`Ошибка покидания поездки: ${error.message}`);
      setConfirmModal({
        open: false,
        action: null,
        participantId: null,
        confirmMessage: '',
      });
    }
  }



  return {
    fetchParticipants,
    handleAccept,
    handleReject,
    handleExclude,
    confirmExclude,
    approveAndPayout,     // <= с учётом комиссий + установка approved_trip + тост + закрытие модалки
    handleLeaveTrip,
    confirmLeaveTrip,
  };
};
