import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';
import { useTripParticipantsCore } from './useTripParticipantsCore';
import { useTripParticipantsActions } from './useTripParticipantsActions';
import { useTripLifecycleFinance } from './useTripLifecycleFinance';
import { useTripDisputesReviews } from './useTripDisputesReviews';
import { createTripAlert } from './tripAlerts';

export const useTripParticipants = (tripId) => {
  const core = useTripParticipantsCore(tripId, supabase);

  const actions = useTripParticipantsActions({
    memoizedTripId: core.memoizedTripId,
    trip: core.trip,
    participants: core.participants,
    setParticipants: core.setParticipants,
    setMessage: core.setMessage,
    setActionDropdown: core.setActionDropdown,
    user: core.user,
    setConfirmModal: core.setConfirmModal,
    getUserFullName: core.getUserFullName,
    sendMessage: core.sendMessage,
    getChatId: core.getChatId,
    calculateRefund: core.calculateRefund,
    supabase,
  });

  const _tripCtx = {
    memoizedTripId: core.memoizedTripId,
    trip: core.trip,
    setTrip: core.setTrip,
    participants: core.participants,
    setMessage: core.setMessage,
    setConfirmModal: core.setConfirmModal,
    user: core.user,
    setParticipantReviewSent: core.setParticipantReviewSent,
    setIndividualReviews: core.setIndividualReviews,
    individualReviews: core.individualReviews,
    setBulkReviewSent: core.setBulkReviewSent,
    setReviewModal: core.setReviewModal,
    reviewText: core.reviewText,
    rating: core.rating,
    evidenceFile: core.evidenceFile,
    sendMessage: core.sendMessage,
    getUserFullName: core.getUserFullName,
    fetchParticipants: actions.fetchParticipants,
    removeParticipantFromTripChats,
    supabase,
  };

  const _lf = useTripLifecycleFinance(_tripCtx);
  const _dr = useTripDisputesReviews(_tripCtx);
  const tripManagement = { ..._lf, ..._dr };

  const [isReviewsLoaded, setIsReviewsLoaded] = useState(false);

  // === helpers: время чек-ина ===
  const plannedStartTs = useMemo(() => {
    if (!core.trip?.start_date) return null;
    try {
      return new Date(core.trip.start_date).getTime(); // timestamptz → UTC
    } catch {
      return null;
    }
  }, [core.trip?.start_date]);

  const isBeforePlannedStart = useMemo(() => {
    if (!plannedStartTs) return false;
    return Date.now() < plannedStartTs;
  }, [plannedStartTs]);

  const isCheckinOpen = useMemo(() => {
    return (core.trip?.status || '').toLowerCase() === 'active_checkin';
  }, [core.trip?.status]);

  /**
   * Вспомогательная: id всех чатов этой поездки (только групповые/приватные по поездке)
   */
  async function getTripChatIds() {
    const { data, error } = await supabase
      .from('chats')
      .select('id')
      .eq('trip_id', core.memoizedTripId)
      .in('chat_type', ['trip_group', 'trip_private']);
    if (error) throw error;
    return (data || []).map((c) => c.id);
  }

  /**
   * Вспомогательная: удалить пользователя из всех чатов этой поездки
   */
  async function removeParticipantFromTripChats(userId) {
    const chatIds = await getTripChatIds();
    if (!chatIds.length) return;
    const { error } = await supabase
      .from('chat_participants')
      .delete()
      .in('chat_id', chatIds)
      .eq('user_id', userId);
    if (error) throw error;
  }

 // === п.2: логика чек-ина + автоисключение неоплаченных при старте ===
async function handleStartTrip() {
  try {
    const status = (core.trip?.status || '').toLowerCase();
    if (status !== 'active') {
      core.setMessage('Начать поездку можно только из статуса «Активна».');
      return;
    }

    // ✅ 1. Берём актуальных участников прямо из БД, а не из кэша
    const { data: freshParticipants, error: freshErr } = await supabase
      .from('trip_participants')
      .select('id, user_id, status')
      .eq('trip_id', core.memoizedTripId);

    if (freshErr) {
      console.error('handleStartTrip: ошибка загрузки участников из БД', {
        tripId: core.memoizedTripId,
        error: freshErr.message,
      });
      core.setMessage('Не удалось загрузить актуальные данные участников. Попробуйте ещё раз.');
      return;
    }

    const participants = freshParticipants || [];

    const paid = participants.filter(
      (p) => (p.status || '').toLowerCase() === 'paid'
    );
    if (paid.length === 0) {
      core.setMessage('Нет участников со статусом «Оплачено». Начать поездку нельзя.');
      return;
    }

    // 2) Сразу исключаем всех, кто не оплатил: confirmed и waiting (по АКТУАЛЬНЫМ данным)
    const toExclude = participants.filter((p) => {
      const st = (p.status || '').toLowerCase();
      return st === 'confirmed' || st === 'waiting';
    });

    for (const p of toExclude) {
      try {
        // статус участника → rejected
        const { error: upErr } = await supabase
          .from('trip_participants')
          .update({ status: 'rejected' })
          .eq('id', p.id);
        if (upErr) throw upErr;

        // удалить из чатов поездки
        await removeParticipantFromTripChats(p.user_id);

        // уведомление участнику
        await createTripAlert({
          userId: p.user_id,
          tripId: core.memoizedTripId,
          type: 'trip_auto_excluded_unpaid',
          title: 'Вы исключены из поездки',
          body: `Вы исключены из поездки «${core.trip?.title || ''}» из-за отсутствия оплаты к моменту старта.`,
          actorUserId: core.trip?.creator_id || null,
          metadata: { tripTitle: core.trip?.title || null },
          client: supabase,
        });
      } catch (e) {
        // не валим общий процесс — логируем и идём дальше
        console.error('Автоисключение (start) не удалось для участника', p.id, e);
      }
    }

    // 3) Переключаем поездку в фазу чек-ина
    const { error: tripErr } = await supabase
      .from('trips')
      .update({ status: 'active_checkin' })
      .eq('id', core.memoizedTripId);
    if (tripErr) throw tripErr;

    core.setTrip((prev) => ({ ...prev, status: 'active_checkin' }));

    // 4) Обновим участников в состоянии (чтобы таблица соответствовала БД)
    await actions.fetchParticipants();

    core.setMessage('Поездка переведена в режим чек-ина. Неоплаченные участники исключены.');
  } catch (e) {
    console.error('Ошибка handleStartTrip:', e);
    core.setMessage('Не удалось начать поездку. Попробуйте ещё раз.');
  }
}

  async function handleConfirmPresence(participantId) {
    try {
      if ((core.trip?.status || '').toLowerCase() !== 'active_checkin') {
        core.setMessage('Подтверждение присутствия доступно только до начала поездки.');
        return;
      }
      if (!isBeforePlannedStart) {
        core.setMessage('Время отправления наступило. Подтверждение присутствия закрыто.');
        return;
      }

      const row = (core.participants || []).find((p) => p.id === participantId);
      if (!row) {
        core.setMessage('Участник не найден.');
        return;
      }
      if ((row.status || '').toLowerCase() !== 'paid') {
        core.setMessage('Подтверждать присутствие могут только участники со статусом «Оплачено».');
        return;
      }
      if (row.confirmed_start) {
        core.setMessage('Присутствие уже подтверждено.');
        return;
      }

      // 1) ставим confirmed_start в БД
      const { error: upErr } = await supabase
        .from('trip_participants')
        .update({ confirmed_start: true })
        .eq('id', participantId);
      if (upErr) throw upErr;

      // 2) обновляем список участников
      await actions.fetchParticipants();

      // 3) ЛС организатору: "я подтвердил(а) присутствие" — ТОЛЬКО если участник подтверждает себя
      try {
        const isSelf = row.user_id && core.user?.id && row.user_id === core.user.id;
        const organizerId = core.trip?.creator_id;
        const title = core.trip?.title || '';

        if (isSelf && organizerId) {
          await createTripAlert({
            userId: organizerId,
            tripId: core.memoizedTripId,
            type: 'trip_presence_confirmed',
            title: 'Участник подтвердил присутствие',
            body: `Участник подтвердил присутствие по поездке «${title || ''}».`,
            actorUserId: core.user?.id || null,
            metadata: { tripTitle: title || null },
            client: supabase,
          }).catch((e) => {
            console.error('[useTripParticipants] не удалось создать оповещение о подтверждении присутствия:', e?.message || e);
          });
        }
      } catch (e) {
        console.error('handleConfirmPresence DM error:', e);
      }

      // 4) проверяем, все ли оплаченные подтвердили
      const { data: paidRows, error: paidErr } = await supabase
        .from('trip_participants')
        .select('id, confirmed_start')
        .eq('trip_id', core.memoizedTripId)
        .eq('status', 'paid');
      if (paidErr) throw paidErr;

      const allConfirmed =
        (paidRows || []).length > 0 && (paidRows || []).every((r) => !!r.confirmed_start);

if (allConfirmed) {
        const { error: stErr } = await supabase
          .from('trips')
          .update({ status: 'started' })
          .eq('id', core.memoizedTripId);
        if (stErr) throw stErr;

        core.setTrip((prev) => ({ ...prev, status: 'started' }));
        core.setMessage('Все участники подтвердили присутствие. Поездка началась.');

        // 🔔 Сообщение всем участникам поездки: пытаемся написать в общий чат trip_group
        try {
          const { data: groupChat, error: groupErr } = await supabase
            .from('chats')
            .select('id')
            .eq('trip_id', core.memoizedTripId)
            .eq('chat_type', 'trip_group')
            .maybeSingle();

          const text = `Все участники подтвердили присутствие. Поездка «${core.trip?.title}» началась.`;

          if (!groupErr && groupChat?.id) {
            // Пишем в общий чат поездки — увидят все, кто там состоит
            await createTripAlert({
              userId: core.trip.creator_id,
              tripId: core.memoizedTripId,
              type: 'trip_all_confirmed_started',
              title: 'Поездка началась',
              body: text,
              actorUserId: core.user?.id || null,
              metadata: { tripTitle: core.trip?.title || null },
              client: supabase,
            });
          } else if (core.trip?.creator_id) {
            // Фолбэк: если нет групповго чата, хотя бы ЛС организатору
            await createTripAlert({
              userId: core.trip.creator_id,
              tripId: core.memoizedTripId,
              type: 'trip_all_confirmed_started',
              title: 'Поездка началась',
              body: text,
              actorUserId: core.user?.id || null,
              metadata: { tripTitle: core.trip?.title || null },
              client: supabase,
            }).catch(() => {});
          }
        } catch (e) {
          console.error(
            'Ошибка отправки группового сообщения о старте поездки:',
            e?.message || e
          );
        }
      } else {
        core.setMessage('Присутствие подтверждено.');
      }
    } catch (e) {
      console.error('handleConfirmPresence error:', e);
      core.setMessage('Не удалось подтвердить присутствие.');
    }
  }


  useEffect(() => {
    if (!core.memoizedTripId) {
      core.setMessage('Ошибка: ID поездки не указан');
      return;
    }

    const fetchData = async () => {
      try {
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError) {
          core.setMessage('Ошибка авторизации');
          throw userError;
        }
        if (!user) {
          core.setMessage('Необходимо авторизоваться');
          return;
        }
        core.setUser(user);

        await tripManagement.fetchTrip();

        const { data: tripData } = await supabase
          .from('trips')
          .select('creator_id')
          .eq('id', core.memoizedTripId)
          .single();
        core.setIsCreator(tripData?.creator_id === user.id);

        if (tripData?.creator_id === user.id) {
          core.setParticipantId(null);
          core.setParticipantStatus(null);
        } else {
          const { data: participantData, error: participantError } = await supabase
            .from('trip_participants')
            .select('id, status')
            .eq('trip_id', core.memoizedTripId)
            .eq('user_id', user.id)
            .maybeSingle();

          if (participantError) {
            core.setMessage('Вы не зарегистрированы как участник этой поездки');
            throw participantError;
          }

          if (participantData) {
            core.setParticipantId(participantData.id);
            core.setParticipantStatus(participantData.status);
          } else {
            core.setParticipantId(null);
            core.setParticipantStatus(null);
          }
        }

        await actions.fetchParticipants();
      } catch (error) {
        console.error('Ошибка в fetchData:', { error: error.message, tripId: core.memoizedTripId });
        core.setMessage('Ошибка загрузки данных');
      }
    };

    fetchData();

 async function refreshSelfParticipant() {
  try {
    if (!core.memoizedTripId) return;

    // Берём актуального пользователя прямо из auth, а не из core.user из замыкания
    const {
      data: { user: currentUser },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !currentUser) {
      console.error('refreshSelfParticipant auth error:', authErr);
      return;
    }

    // если текущий пользователь — организатор, он не участник
    const { data: tripRow, error: tripErr } = await supabase
      .from('trips')
      .select('creator_id')
      .eq('id', core.memoizedTripId)
      .single();

    if (!tripErr && tripRow?.creator_id === currentUser.id) {
      core.setParticipantId(null);
      core.setParticipantStatus(null);
      core.setIsCreator(true);
      return;
    }

    // актуальный статус участника
    const { data: participantData, error: participantError } = await supabase
      .from('trip_participants')
      .select('id, status')
      .eq('trip_id', core.memoizedTripId)
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (participantError) {
      console.error('refreshSelfParticipant error:', participantError);
      return;
    }

    if (participantData) {
      core.setParticipantId(participantData.id);
      core.setParticipantStatus(participantData.status);
    } else {
      core.setParticipantId(null);
      core.setParticipantStatus(null);
    }
  } catch (e) {
    console.error('refreshSelfParticipant fatal:', e);
  }
}

 const participantSubscription = supabase
      .channel(`public:trip_participants:trip_id=eq.${core.memoizedTripId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trip_participants',
          filter: `trip_id=eq.${core.memoizedTripId}`,
        },
        async () => {
          // 1) обновляем таблицу участников
          await actions.fetchParticipants();
          // 2) обновляем персональный статус текущего пользователя
          await refreshSelfParticipant();
        }
      )
      .subscribe();

    const tripSubscription = supabase
  .channel(`public:trips:id=eq.${core.memoizedTripId}`)
  .on(
    'postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${core.memoizedTripId}` },
    (payload) => {
      core.setTrip((prev) => ({
        ...prev,
        ...payload.new, // <- подтягиваем ВСЕ актуальные поля
      }));
    }
  )
  .subscribe();

const disputesSubscription = supabase
  .channel(`public:disputes:trip_id=eq.${core.memoizedTripId}`)
  .on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'disputes', filter: `trip_id=eq.${core.memoizedTripId}` },
    () => {
      // перечитаем участников, чтобы пересчитать has_open_dispute
      actions.fetchParticipants();
    }
  )
  .subscribe();

    const reviewSubscription = supabase
      .channel(`public:reviews:trip_id=eq.${core.memoizedTripId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reviews', filter: `trip_id=eq.${core.memoizedTripId}` },
        () => fetchData()
      )
      .subscribe();

    const companyReviewSubscription = supabase
      .channel(`public:company_reviews:trip_id=eq.${core.memoizedTripId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'company_reviews', filter: `trip_id=eq.${core.memoizedTripId}` },
        () => fetchData()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(participantSubscription);
      supabase.removeChannel(tripSubscription);
      supabase.removeChannel(reviewSubscription);
      supabase.removeChannel(companyReviewSubscription);
      supabase.removeChannel(disputesSubscription); // <- новый
    };
  }, [core.memoizedTripId]);

  // Проверка существующих отзывов (как было)
  useEffect(() => {
    if (!core.trip || !core.user || !core.participants || !core.memoizedTripId) return;
    core.setBulkReviewSent(null);
    setIsReviewsLoaded(false);

    const checkReviews = async () => {
      try {
        if (core.isCreator) {
          const { data: reviews, error: reviewsError } = await supabase
            .from('reviews')
            .select('organizer_id')
            .eq('trip_id', core.memoizedTripId)
            .eq('reviewer_id', core.user.id);
          if (reviewsError) throw reviewsError;

          const { data: companyReviews, error: companyReviewsError } = await supabase
            .from('company_reviews')
            .select('organizer_id')
            .eq('trip_id', core.memoizedTripId)
            .eq('reviewer_id', core.user.id);
          if (companyReviewsError) throw companyReviewsError;

          const reviewedParticipants = new Set([
            ...(reviews || []).map((r) => r.organizer_id),
            ...(companyReviews || []).map((r) => r.organizer_id),
          ]);
          core.setIndividualReviews(reviewedParticipants);

          const allParticipants = core.participants.filter((p) => p.status !== 'rejected');
          if (allParticipants.length > 0 && reviewedParticipants.size >= allParticipants.length) {
            core.setBulkReviewSent(true);
          } else {
            core.setBulkReviewSent(false);
          }
        } else {
          const { data: participantReviews, error: reviewsError } = await supabase
            .from('reviews')
            .select('*')
            .eq('trip_id', core.memoizedTripId)
            .eq('reviewer_id', core.user.id)
            .eq('organizer_id', core.trip.creator_id);
          if (reviewsError) throw reviewsError;

          const { data: companyParticipantReviews, error: companyReviewsError } = await supabase
            .from('company_reviews')
            .select('*')
            .eq('trip_id', core.memoizedTripId)
            .eq('reviewer_id', core.user.id)
            .eq('organizer_id', core.trip.creator_id);
          if (companyReviewsError) throw companyReviewsError;

          const hasReviews =
            (participantReviews?.length || 0) > 0 ||
            (companyParticipantReviews?.length || 0) > 0;
          core.setParticipantReviewSent(hasReviews);
        }

        setIsReviewsLoaded(true);
      } catch (error) {
        console.error('Ошибка при проверке отзывов:', error);
        setIsReviewsLoaded(true);
      }
    };

    checkReviews();
  }, [core.trip, core.user, core.participants, core.memoizedTripId, core.isCreator]);

  // Возвращаем: новые функции поверх tripManagement
  return {
    ...core,
    ...actions,
    ...tripManagement,
    isReviewsLoaded,
    isCheckinOpen,
    handleStartTrip,         // обновлено: автоисключение неоплаченных + чек-ин
    handleConfirmPresence,   // подтверждение присутствия
  };
};
