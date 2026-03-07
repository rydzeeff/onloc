// pages/TripParticipantsPagePC.js
import { useRouter } from 'next/router';
import { useState, useEffect, useRef, useMemo } from 'react';
import styles from '../styles/trip-participants.pc.module.css';
import { useTripParticipants } from '../lib/useTripParticipants';
import { platformSettings } from '../lib/platformSettings';

// Вынесенные части
import ParticipantsTable from '../components/trip-participants/ParticipantsTable';
import ParticipantsModals from '../components/trip-participants/ParticipantsModals';
import { useTripPayments } from '../lib/useTripPayments';

// Единый клиент Supabase из lib (чтобы не было Multiple GoTrueClient)
import { supabase } from '../lib/supabaseClient';

const TripParticipantsPagePC = ({ tripId }) => {
  const router = useRouter();
  const tripIdFromQuery =
    typeof router?.query?.tripId === 'string' ? router.query.tripId : undefined;
  const effectiveTripId = tripId || tripIdFromQuery;

  const {
    trip,
    participants,
    message,
    actionDropdown,
    reviewModal,
    reviewText,
    rating,
    user,
    confirmModal,
    individualReviews,
    bulkReviewSent,
    participantReviewSent,
    evidenceFile,
    participantId,
    participantStatus,
    isLoading,
    isCancelPending,
    refundProgress,
    totalRefunds,
    setActionDropdown,
    setReviewModal,
    setReviewText,
    setRating,
    setConfirmModal,
    setEvidenceFile,
    setMessage,
    setIsCancelPending,
    handleAccept,
    handleReject,
    handleExclude, // готовит confirm
    confirmExclude, // реальное исключение
    handlePay,
    handleStartTrip,
    handleCancelTrip,
    confirmCancelTrip,
    handleLeaveTrip, // открывает confirm для покидания
    confirmLeaveTrip, // выполняет покидание
    handleFinishTrip,
    handleSubmitReview,
    handleConfirmPresence,
    approveAndPayout,
    handleOpenDispute,
    handleUploadEvidence,
    calculateAge,
    getFullName,
    // флаг окна чек-ина (между "Начать поездку" и реальным стартом)
    isCheckinOpen,
  } = useTripParticipants(effectiveTripId);

  // Оплата и модалка политики возврата
  const {
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
    // ─ новые флаги/действия оплаты ─
    payLocked,
    payTooltip,
    allowRetry,
    isCheckingStatus,
    refreshPaymentLock,
  } = useTripPayments({
    trip,
    user,
    participantId,
    participantStatus,
    handlePay,
    supabase,
    setMessage,
  });

  // Состояния для окна спора (переносим модалку в ParticipantsModals)
  const [disputeReason, setDisputeReason] = useState('');
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [selectedDisputeParticipantId, setSelectedDisputeParticipantId] = useState(null);

  const [bulkReviewOpening, setBulkReviewOpening] = useState(false);
  const [isOpeningDispute, setIsOpeningDispute] = useState(false);

  // --- Глобальная блокировка UI ---
  const [uiBusy, setUiBusy] = useState(false);

  // Универсальная обёртка: гарантирует блокировку кликов на время async-операции
  const withLock = (fn) => async (...args) => {
    setUiBusy(true);
    try {
      return await fn?.(...args);
    } finally {
      setUiBusy(false);
    }
  };

  // Единый флаг занятости для всей страницы
  const globalBusy = useMemo(
    () => Boolean(isLoading || isCancelPending || uiBusy),
    [isLoading, isCancelPending, uiBusy]
  );

  const [tablePainted, setTablePainted] = useState(false);

  // === GRACE LOADER для таблицы: 2.5s или до появления участников (что раньше) ===
  // если данных ещё нет — ждём (grace); если данные есть — ждём реальный paint таблицы
  const hasRows = (participants?.length || 0) > 0;

  // если сменился набор данных на пустой/другой — снова ждём фактический paint
  useEffect(() => {
    if (!hasRows) setTablePainted(false);
  }, [hasRows]);

  // Лоадер:
  // - пока нет первого ответа (participants === null)
  // - либо строки уже есть, но браузер ещё не дорисовал таблицу
  const participantsLoading = participants === null || (hasRows && !tablePainted);

  // Позиционирование popup ошибок по центру экрана
  const scrollPositionRef = useRef(0);
  const [errorPopupPosition, setErrorPopupPosition] = useState({
    top: '0px',
    left: '50%',
    transform: 'translateX(-50%)',
  });

  // На первый ре-рендер гасим старое сообщение
  useEffect(() => {
    if (effectiveTripId && typeof setMessage === 'function') setMessage('');
  }, [effectiveTripId, setMessage]);

  // Проверка статуса отмены
  useEffect(() => {
    if (
      message &&
      message.includes('Ошибка отмены поездки') &&
      trip?.status === 'canceled'
    ) {
      setMessage('Поездка успешно отменена');
      setIsCancelPending(false);
      router.push('/refund-result?status=success');
    } else if (isCancelPending && trip?.status === 'canceled') {
      setMessage('Поездка успешно отменена');
      setIsCancelPending(false);
      router.push('/refund-result?status=success');
    }
  }, [
    message,
    trip?.status,
    isCancelPending,
    router,
    setMessage,
    setIsCancelPending,
  ]);

  // Центрирование popup ошибок
  useEffect(() => {
    const content =
      document.querySelector(`.${styles.sectionContent}`) || document.body;
    if (!content) return;

    const updatePositions = () => {
      const viewportHeight = window.innerHeight;
      const errorPopupHeight = 100;
      const scrollTop = content.scrollTop || window.scrollY;
      scrollPositionRef.current = scrollTop;

      const errorTopPosition = scrollTop + (viewportHeight - errorPopupHeight) / 2;
      setErrorPopupPosition({
        top: `${errorTopPosition}px`,
        left: '50%',
        transform: 'translateX(-50%)',
      });
    };

    content.addEventListener('scroll', updatePositions);
    window.addEventListener('scroll', updatePositions);
    window.addEventListener('resize', updatePositions);
    updatePositions();

    return () => {
      content.removeEventListener('scroll', updatePositions);
      window.removeEventListener('scroll', updatePositions);
      window.removeEventListener('resize', updatePositions);
    };
  }, [message, styles.sectionContent]);

  // Авто-закрытие popup ошибок
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message, setMessage]);

  useEffect(() => {
    if (!trip?.id || !user?.id) return;

    const chan = supabase
      .channel(`public:payments:trip_id=eq.${trip.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'payments',
          filter: `trip_id=eq.${trip.id}`,
        },
        async () => {
          // как только появилась/изменилась запись по оплате — перечитать openPayment
          await refreshPaymentLock();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
    };
  }, [trip?.id, user?.id, refreshPaymentLock]);

  // Запрет прокрутки body, пока активен оверлей (без зависимости от CSS)
  useEffect(() => {
    const prev = document.body.style.overflow;
    if (globalBusy) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = prev || '';
    }
    return () => {
      document.body.style.overflow = prev || '';
    };
  }, [globalBusy]);

  if (!trip || !user) {
    return <div>Загрузка...</div>;
  }

  const isCreator = trip.creator_id === user.id;
  const tripStatus = String(trip?.status || '').toLowerCase();

const showCheckinHint = tripStatus === 'active_checkin';

  const showFooterActive = isCreator && tripStatus === 'active';
  const showFooterCanceling =
    isCreator && (tripStatus === 'canceling' || tripStatus === 'cancel_failed');
  const showFooterCheckin = isCreator && tripStatus === 'active_checkin';

  const currentParticipant = (participants || []).find((p) => p.user_id === user.id);

  // Считаем активных участников (ожидание/подтверждён/оплачен)
  const activeStatuses = new Set(['waiting', 'confirmed', 'paid']);
  const activeParticipantsCount = (participants || []).filter((p) =>
    activeStatuses.has((p.status || '').toLowerCase())
  ).length;

  // Ограничение банка по сроку холда (N дней до старта)
  const canPayNowByDate = () => {
    const minWindow = Number(platformSettings.paymentOpenWindowDays ?? 0);
    const startDate = trip?.start_date ? new Date(trip.start_date) : null;
    if (!startDate || !Number.isFinite(minWindow) || minWindow <= 0) return true; // подстраховка

    const daysUntilTrip = Math.ceil((startDate.getTime() - Date.now()) / 86400000);
    return daysUntilTrip <= minWindow;
  };

  // Сообщение для ранней оплаты
  const buildPayTooEarlyMessage = () => {
    const minWindow = Number(platformSettings.paymentOpenWindowDays ?? 0);
    const startDate = trip?.start_date ? new Date(trip.start_date) : null;
    const daysUntilTrip = startDate
      ? Math.ceil((startDate.getTime() - Date.now()) / 86400000)
      : 0;
    const waitDays = Math.max(daysUntilTrip - minWindow, 0);

    return `Оплата недоступна: по условиям банка удержание средств возможно не более ${minWindow} дней до начала поездки. До старта — ${daysUntilTrip} дн. Оплатить можно через ${waitDays} дн.`;
  };

  const isFinishedOrArchived = ['finished', 'archived'].includes(
    (trip?.status || '').toLowerCase()
  );

  // пока статус массового отзыва неизвестен — считаем, что идёт "review loading"
  const reviewsLoading = bulkReviewSent === undefined || bulkReviewSent === null;

  // итоговый флаг "запрещаем клик"
  const disableBulkButton =
    !isFinishedOrArchived || // кнопка только в finished/archived
    reviewsLoading || // пока не знаем, был ли массовый отзыв
    bulkReviewSent === true || // уже отправляли — нельзя
    globalBusy || // глобальный busy
    participantsLoading || // участники ещё грузятся
    bulkReviewOpening; // защита от двойного клика

  // класс для кнопки
  const bulkButtonClass = disableBulkButton ? styles.disabledButton : styles.actionButton;

  // текст на кнопке
  const bulkButtonText = reviewsLoading
    ? 'Проверяю…'
    : bulkReviewOpening
    ? 'Открываю…'
    : 'Оставить отзыв всем';

  // всплывающая подсказка
  const bulkButtonTitle = reviewsLoading
    ? 'Проверяю статус отзывов…'
    : bulkReviewSent
    ? 'Отзыв уже отправлен всем участникам'
    : participantsLoading
    ? 'Дождитесь загрузки участников'
    : individualReviews && individualReviews.size > 0
    ? `Личные отзывы уже оставлены ${individualReviews.size} участникам. Массовый отзыв будет отправлен всем, кроме них.`
    : 'Оставить отзыв всем участникам';

  // Переход в просмотр поездки (с возвратом)
  const handleOpenView = () => {
    const returnTo = `/dashboard?section=participants&tripId=${trip.id}`;
    router.push(
      `/view/${trip.id}?from=participants&returnTo=${encodeURIComponent(returnTo)}`
    );
  };

  // Коллбеки для таблицы (обёрнуты в withLock, чтобы мгновенно включать оверлей)
  const onAccept = withLock((id) => handleAccept?.(id));
  const onReject = withLock((id) => handleReject?.(id));
  const onExclude = (id) => handleExclude?.(id); // только открывает confirm — без сетевых запросов

  const onPayClickLocked = withLock(async () => {
    // проверка даты (банк N дней)
    if (!canPayNowByDate()) {
      setMessage(buildPayTooEarlyMessage());
      return;
    }
    await handlePayClick?.();
    // после Init сервер проставляет locked_until — подтянем
    await refreshPaymentLock?.();
  });

  const confirmPayLocked = withLock(() => confirmPay?.());
  const onConfirmPresence = withLock((id) => handleConfirmPresence?.(id));

  // «Открыть спор» (модалка из строки участника)
  const onOpenDispute = (id) => {
    setSelectedDisputeParticipantId(id || null);
    setDisputeReason('');
    setEvidenceFile(null);
    setShowDisputeModal(true);
  };

  // ✅ Разделяем сценарии: организатор ↔ участник
  const onOpenReview = (p) => {
    if (isCreator) {
      // Организатор оценивает конкретного участника
      setReviewModal?.({
        open: true,
        organizerId: null,
        participantId: p?.id,
        isBulk: false,
      });
    } else {
      // Участник оценивает организатора
      setReviewModal?.({
        open: true,
        organizerId: trip?.creator_id,
        participantId: null,
        isBulk: false,
      });
    }
  };

  const onApproveAndPayout = (id) =>
    setConfirmModal?.({
      open: true,
      action: 'approve-and-payout',
      participantId: id,
      confirmMessage:
        'Одобрение поездки подтверждает, что поездка выполнена, и средства будут перечислены организатору. Если не одобрить сейчас, выплата произойдёт автоматически через 12 часов после завершения поездки.',
    });

  // Колбэк выхода — дергаем открытие confirm внутри хука
  const onLeave = (participantId) => handleLeaveTrip?.(participantId);

  const containerClassName = `${styles.sectionContent} ${
    globalBusy ? `${styles.blockAll || ''} ${styles.dimmed || ''}` : ''
  }`;

  return (
    <div className={containerClassName}>
      <div className={styles.backButtonContainer}>
        <button
          className={styles.backButton}
          onClick={() => router.push('/dashboard?section=myTrips')}
          disabled={globalBusy}
        >
          Назад
        </button>

        <button
          className={styles.actionButton}
          onClick={handleOpenView}
          disabled={globalBusy}
        >
          Просмотр
        </button>
      </div>

      <h2>Участники поездки: {trip.title}</h2>

      {/* Таблица */}
      <div
        style={participantsLoading ? { opacity: 0.72, pointerEvents: 'none' } : undefined}
      >
        <ParticipantsTable
          participants={participants}
          trip={trip}
          isCreator={!!isCreator}
          currentUserId={user?.id || null}
          actionDropdown={actionDropdown}
          setActionDropdown={setActionDropdown}
          isLoading={globalBusy}
          individualReviews={individualReviews}
          bulkReviewSent={bulkReviewSent}
          participantReviewSent={participantReviewSent}
          onAccept={onAccept}
          onReject={onReject}
          onExclude={onExclude}
          onPayClick={onPayClickLocked}
          onConfirmPresence={onConfirmPresence}
          onOpenDispute={onOpenDispute}
          onOpenReview={onOpenReview}
          onApproveAndPayout={onApproveAndPayout}
          onLeave={onLeave}
          getFullName={getFullName}
          calculateAge={calculateAge}
          isCheckinOpen={isCheckinOpen}
          /* 👇 крутилка загрузки участников */
          participantsLoading={participantsLoading}
          onFirstPaint={() => setTablePainted(true)}
          /* 👇 флаги оплаты из хука */
          payLocked={payLocked}
          payTooltip={payTooltip}
          allowRetry={allowRetry}
          isCheckingStatus={isCheckingStatus}
        />
      </div>

      {/* Подсказка для участника, где искать кнопку выхода */}
      {!isCreator && (trip.status === 'active' || trip.status === 'created') && (
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
          Чтобы выйти из поездки и оформить возврат (если он доступен), нажмите «Покинуть
          поездку» в своей строке таблицы.
        </div>
      )}

      {/* Футер действий страницы */}
      <div className={styles.tableFooter}>
        {/* ===== Организатор + ACTIVE: показываем все три кнопки ===== */}
        {showFooterActive && (
          <>
            {(participants || []).filter((p) => (p.status || '').toLowerCase() === 'paid')
              .length > 0 ? (
              <button
                className={styles.acceptButton}
                onClick={() =>
                  setConfirmModal({
                    open: true,
                    action: 'start-trip',
                    participantId: null,
                    confirmMessage: 'Вы точно хотите начать поездку?',
                  })
                }
                disabled={globalBusy || isCancelPending}
              >
                Начать поездку
              </button>
            ) : (
              <p className={styles.errorMessage}>
                Начать поездку невозможно, т.к. нет участников со статусом оплачено. Можно
                только отменить поездку.
              </p>
            )}

            <button
              className={styles.actionButton}
              onClick={() => {
                if (activeParticipantsCount > 0) {
                  setMessage(
                    'Редактирование недоступно: в поездке уже есть участники. Исключите участников, затем попробуйте снова.'
                  );
                  return;
                }
                router.push(
                  {
                    pathname: '/dashboard',
                    query: {
                      section: 'edit-trip',
                      tripId: trip.id,
                      returnTo: 'participants',
                    },
                  },
                  undefined,
                  { shallow: true }
                );
              }}
              disabled={globalBusy || isCancelPending}
              title={
                activeParticipantsCount > 0
                  ? 'Редактирование запрещено: есть участники'
                  : 'Редактировать поездку'
              }
            >
              Редактировать
            </button>

            <button
              className={styles.cancelButton}
              onClick={handleCancelTrip}
              disabled={globalBusy || isCancelPending}
            >
              {globalBusy ? 'Обработка...' : 'Отмена поездки'}
            </button>
          </>
        )}

        {/* ===== Организатор + ACTIVE_CHECKIN: показываем только "Отмена поездки" ===== */}
        {showFooterCheckin && (
          <button
            className={styles.cancelButton}
            onClick={handleCancelTrip}
            disabled={globalBusy || isCancelPending}
          >
            {globalBusy ? 'Обработка...' : 'Отмена поездки'}
          </button>
        )}

        {/* Организатор + CANCELING */}
        {showFooterCanceling && (
          <button
            className={styles.cancelButton}
            onClick={handleCancelTrip} // повторный запуск
            disabled={globalBusy || isCancelPending} // блокируем только пока реально идёт работа
            title={isCancelPending ? 'Отмена уже запущена…' : 'Повторить отмену'}
          >
            {isCancelPending ? 'Отмена поездки (в процессе…)' : 'Повторить отмену'}
          </button>
        )}

        {/* Остальные ветки — без изменений */}
        {isCreator && trip.status === 'started' && (
          <button
            className={styles.actionButton}
            onClick={withLock(handleFinishTrip)}
            disabled={globalBusy}
          >
            Завершить поездку
          </button>
        )}

        {isCreator && isFinishedOrArchived && (
          <button
            className={bulkButtonClass}
            title={bulkButtonTitle}
            disabled={disableBulkButton}
            onClick={() => {
              if (disableBulkButton) return;
              setBulkReviewOpening(true);
              setReviewModal({ open: true, organizerId: null, participantId: null, isBulk: true });
              setTimeout(() => setBulkReviewOpening(false), 0);
            }}
          >
            {bulkButtonText}
          </button>
        )}

        {isCancelPending && (
          <p className={styles.cancelProgress}>
            Происходит возврат средств участникам: {refundProgress} из {totalRefunds}
          </p>
        )}
      </div>

{showCheckinHint && (
  <p className={styles.errorMessage} style={{ marginTop: 10, marginBottom: 0 }}>
    Чтобы поездка началась, участники должны подтвердить присутствие у себя в приложении.
  </p>
)}

      {/* Все модалки (оплата/политика возврата, отзывы, подтверждения, спор) теперь в ParticipantsModals */}
      <ParticipantsModals
        /* ===== Оплата / Политика возврата ===== */
        showRefundPolicy={showRefundPolicy}
        setShowRefundPolicy={setShowRefundPolicy}
        savedCards={savedCards}
        isLoadingCards={isLoadingCards}
        selectedCardId={selectedCardId}
        setSelectedCardId={setSelectedCardId}
        saveCard={saveCard}
        setSaveCard={setSaveCard}
        confirmPay={confirmPayLocked}
        renderRefundPolicy={renderRefundPolicy}
        formatCardLabel={formatCardLabel}
        /* флаги оплаты для консистентности с таблицей */
        payLocked={!!payLocked}
        payTooltip={payTooltip || ''}
        allowRetry={!!allowRetry}
        /* ===== Отзывы ===== */
        reviewModal={reviewModal}
        setReviewModal={setReviewModal}
        reviewText={reviewText}
        setReviewText={setReviewText}
        rating={rating}
        setRating={setRating}
        handleSubmitReview={handleSubmitReview}
        /* ===== Универсальная confirm-модалка ===== */
        confirmModal={confirmModal}
        setConfirmModal={setConfirmModal}
        confirmLeaveTrip={confirmLeaveTrip}
        confirmCancelTrip={confirmCancelTrip}
        confirmExclude={confirmExclude}
        approveAndPayout={approveAndPayout}
        confirmStartTrip={withLock(handleStartTrip)}
        /* ===== Спор ===== */
        showDisputeModal={showDisputeModal}
        setShowDisputeModal={setShowDisputeModal}
        selectedDisputeParticipantId={selectedDisputeParticipantId}
        setSelectedDisputeParticipantId={setSelectedDisputeParticipantId}
        disputeReason={disputeReason}
        setDisputeReason={setDisputeReason}
        evidenceFile={evidenceFile}
        setEvidenceFile={setEvidenceFile}
        isOpeningDispute={isOpeningDispute}
        setIsOpeningDispute={setIsOpeningDispute}
        handleOpenDispute={handleOpenDispute}
        handleUploadEvidence={handleUploadEvidence}
        /* Общие */
        isLoading={globalBusy}
        setMessage={setMessage}
      />

      {/* Попап ошибок */}
      {message && (
        <div
          className={styles.errorPopup}
          style={{
            ...errorPopupPosition,
            position: 'fixed',
            zIndex: 1000,
            backgroundColor: 'white',
            padding: '10px',
            border: '1px solid red',
            borderRadius: '10px',
          }}
        >
          <p style={{ color: '#ff3b30', fontWeight: 500 }}>{message}</p>
        </div>
      )}

      {/* Глобальный оверлей-блокировка */}
      <div
        className={`${styles.pageOverlay || ''} ${
          globalBusy ? styles.pageOverlayVisible || '' : ''
        }`}
        aria-hidden={!globalBusy}
        aria-busy={globalBusy}
      >
        <div className={styles.pageOverlaySpinner || ''} />
      </div>
    </div>
  );
};

export default TripParticipantsPagePC;
