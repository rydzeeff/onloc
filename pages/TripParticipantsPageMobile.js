// pages/TripParticipantsPageMobile.js
import { useRouter } from "next/router";
import { useState, useEffect, useRef, useMemo } from "react";
import styles from "../styles/trip-participants.mobile.module.css";
import { useTripParticipants } from "../lib/useTripParticipants";
import { platformSettings } from "../lib/platformSettings";

// Вынесенные части
import ParticipantsTable from "../components/trip-participants/ParticipantsTable";
import ParticipantsModals from "../components/trip-participants/ParticipantsModals";
import { useTripPayments } from "../lib/useTripPayments";

// Единый клиент Supabase из lib (чтобы не было Multiple GoTrueClient)
import { supabase } from "../lib/supabaseClient";

const TripParticipantsPageMobile = ({ tripId }) => {
  const router = useRouter();

  const tripIdFromQuery =
    typeof router?.query?.tripId === "string" ? router.query.tripId : undefined;
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

  // При смене поездки сбрасываем всплывающие сообщения (как в PC)
  useEffect(() => {
    setMessage?.(null);
  }, [effectiveTripId, setMessage]);

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
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [selectedDisputeParticipantId, setSelectedDisputeParticipantId] =
    useState(null);
  const [disputeReason, setDisputeReason] = useState("");
  const [isOpeningDispute, setIsOpeningDispute] = useState(false);

  // Лок UI для анти-даблкликов / оверлея
  const [uiBusy, setUiBusy] = useState(false);
  const [bulkReviewOpening, setBulkReviewOpening] = useState(false);

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

  // Блокируем прокрутку страницы во время критичных операций/модалок (как в PC)
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const shouldLock = Boolean(
      globalBusy ||
        showRefundPolicy ||
        !!reviewModal?.open ||
        !!confirmModal?.open ||
        !!showDisputeModal
    );
    if (shouldLock) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [
    globalBusy,
    showRefundPolicy,
    reviewModal?.open,
    confirmModal?.open,
    showDisputeModal,
  ]);

  const [tablePainted, setTablePainted] = useState(false);

  // Сворачиваем верхние кнопки действий (чтобы дать больше места таблице)
  const [actionsCollapsed, setActionsCollapsed] = useState(false);

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
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
  });

  // Авто-сброс сообщения об ошибке через 5 секунд
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(t);
  }, [message, setMessage]);

  // Если отмена завершилась (Realtime обновил trip.status)
  useEffect(() => {
    const cancelErrorButActuallyCanceled =
      !!message &&
      String(message).includes("Ошибка отмены поездки") &&
      trip?.status === "canceled";
    if (
      cancelErrorButActuallyCanceled ||
      (isCancelPending && trip?.status === "canceled")
    ) {
      setMessage("Поездка успешно отменена");
      setIsCancelPending(false);
      router.push("/refund-result?status=success");
    }
  }, [
    isCancelPending,
    trip?.status,
    message,
    setMessage,
    setIsCancelPending,
    router,
  ]);

  // Центрирование popup ошибок
  // ⚠️ Важно: слушатели scroll/resize нужны только когда реально показан popup.
  // Иначе при открытии клавиатуры (resize) будет лишний setState → ре-рендер → сброс фокуса в textarea на мобилке.
  useEffect(() => {
    if (!message) return;

    const content =
      document.querySelector(`.${styles.sectionContent}`) || document.body;
    if (!content) return;

    const updatePositions = () => {
      const viewportHeight = window.innerHeight;
      const errorPopupHeight = 100;
      const scrollTop = content.scrollTop || window.scrollY;

      scrollPositionRef.current = scrollTop;

      setErrorPopupPosition({
        top: `${scrollTop + viewportHeight / 2 - errorPopupHeight / 2}px`,
        left: "50%",
        transform: "translateX(-50%)",
      });
    };

    updatePositions();
    content.addEventListener("scroll", updatePositions);
    window.addEventListener("resize", updatePositions);

    return () => {
      content.removeEventListener("scroll", updatePositions);
      window.removeEventListener("resize", updatePositions);
    };
  }, [message, styles.sectionContent]);

  // Обновление статуса оплаты при изменениях payments
  useEffect(() => {
    if (!trip?.id || !user?.id) return;

    const channel = supabase
      .channel(`payments_trip_${trip.id}_mobile_${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "payments",
          filter: `trip_id=eq.${trip.id}`,
        },
        async () => {
          // триггерим рефреш локов/подсказок оплаты
          await refreshPaymentLock?.();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [trip?.id, user?.id, refreshPaymentLock]);

  // Определяем автора/организатора
  const isCreator = useMemo(() => {
    return Boolean(trip?.creator_id && user?.id && trip.creator_id === user.id);
  }, [trip?.creator_id, user?.id]);

  // Просмотр карточки поездки (как в PC, с returnTo)
  const handleOpenView = () => {
    if (!trip?.id) return;
    const returnTo = `/dashboard?section=participants&tripId=${trip.id}`;
    router.push(
      `/view/${trip.id}?from=participants&returnTo=${encodeURIComponent(returnTo)}`
    );
  };

  // Ограничение банка по сроку холда (N дней до старта)
  const canPayNowByDate = () => {
    const minWindow = Number(platformSettings.paymentOpenWindowDays ?? 0);
    const startDate = trip?.start_date ? new Date(trip.start_date) : null;
    if (!startDate || !Number.isFinite(minWindow) || minWindow <= 0) return true; // подстраховка
    const daysUntilTrip = Math.ceil(
      (startDate.getTime() - Date.now()) / 86400000
    );
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
    return `Оплата недоступна: по условиям банка удержание средств возможно не более ${minWindow} дней до начала поездки.\nДо старта — ${daysUntilTrip} дн. Оплатить можно через ${waitDays} дн.`;
  };

  // ---- Обёртки для действий (все под глобальным lock) ----
  const onAccept = withLock((id) => handleAccept?.(id));
  const onReject = withLock((id) => handleReject?.(id));
  const onExclude = withLock((id) => handleExclude?.(id));

  const onPayClickLocked = withLock(async (pId) => {
    // проверка даты (банк N дней)
    if (!canPayNowByDate()) {
      setMessage(buildPayTooEarlyMessage());
      return;
    }
    // если глобальный лок оплаты — не открываем модалку
    if (payLocked) {
      setMessage(payTooltip || "Оплата временно недоступна. Попробуйте позже.");
      return;
    }
    await handlePayClick?.(pId);
    // после Init сервер проставляет locked_until — подтянем
    await refreshPaymentLock?.();
  });

  const confirmPayLocked = withLock(() => confirmPay?.());
  const onConfirmPresence = withLock((id) => handleConfirmPresence?.(id));

  // «Открыть спор» (модалка из строки участника)
  const onOpenDispute = (id) => {
    setSelectedDisputeParticipantId(id || null);
    setDisputeReason("");
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

  const onApproveAndPayout = (pOrId) => {
    const pid = typeof pOrId === "string" ? pOrId : pOrId?.id;
    if (!pid) {
      setMessage?.("Не удалось определить участника для выплаты.");
      return;
    }
    setConfirmModal?.({
      open: true,
      action: "approve-and-payout",
      participantId: pid,
      confirmMessage:
        "Одобрение поездки подтверждает, что поездка выполнена, и средства будут перечислены организатору. Если не одобрить сейчас, выплата произойдёт автоматически через 12 часов после завершения поездки.",
    });
  };

  // Колбэк выхода — дергаем открытие confirm внутри хука
  const onLeave = (pId) => handleLeaveTrip?.(pId);

  // Кнопка "Оставить отзыв всем" (организатор) — с защитой от двойного клика
  const openBulkReview = () => {
    if (disableBulkButton) return;
    setBulkReviewOpening(true);
    setReviewModal?.({
      open: true,
      organizerId: null,
      participantId: null,
      isBulk: true,
    });
    // снимаем флаг сразу после открытия, чтобы не блокировать UI надолго
    setTimeout(() => setBulkReviewOpening(false), 0);
  };

  // Флаги футера / условий (как в PC)
  const tripStatus = (trip?.status || "").toLowerCase();
  const showCheckinHint = tripStatus === 'active_checkin';
  const currentParticipant = (participants || []).find(
    (p) => p.user_id === user?.id
  );

  // Считаем активных участников (ожидание/подтверждён/оплачен)
  const activeStatuses = new Set(["waiting", "confirmed", "paid"]);
  const activeParticipantsCount = (participants || []).filter((p) =>
    activeStatuses.has((p.status || "").toLowerCase())
  ).length;

  const paidCount = (participants || []).filter(
    (p) => (p.status || "").toLowerCase() === "paid"
  ).length;

  const showFooterActive = isCreator && tripStatus === "active";
  const showFooterCanceling =
    isCreator && (tripStatus === "canceling" || tripStatus === "cancel_failed");
  const showFooterCheckin = isCreator && tripStatus === "active_checkin";
  const showFooterStarted = isCreator && tripStatus === "started";
  const isFinishedOrArchived = ["finished", "archived"].includes(tripStatus);

  // пока статус массового отзыва неизвестен — считаем, что идёт "review loading"
  const reviewsLoading = bulkReviewSent === undefined || bulkReviewSent === null;

  const disableBulkButton =
    !isFinishedOrArchived ||
    reviewsLoading ||
    bulkReviewSent === true ||
    globalBusy ||
    participantsLoading ||
    bulkReviewOpening;

  const bulkButtonClass = disableBulkButton
    ? styles.disabledButton || styles.actionButton
    : `${styles.actionButton} ${styles.acceptButton}`;

  const bulkButtonText = reviewsLoading
    ? "Проверяю…"
    : bulkReviewOpening
    ? "Открываю…"
    : "Оставить отзыв всем";

  const bulkButtonTitle = reviewsLoading
    ? "Проверяю статус отзывов…"
    : bulkReviewSent === true
    ? "Массовый отзыв уже отправлен"
    : individualReviews && individualReviews.size
    ? `Личные отзывы уже оставлены ${individualReviews.size} участникам. Массовый отзыв будет отправлен всем, кроме них.`
    : "Оставить отзыв всем участникам";

  const containerClassName = `${styles.sectionContent} ${
    globalBusy ? `${styles.blockAll || ""} ${styles.dimmed || ""}` : ""
  }`;

  // ===== Верхние действия (и для организатора, и для участника) =====
  const topActions = [];
  let topInfoText = "";

  const makeAction = (key, { label, onClick, disabled, className, title }) => ({
    key,
    label,
    onClick,
    disabled: !!disabled,
    className,
    title,
  });

  // ---- Организатор ----
  if (isCreator) {
    if (showFooterActive) {
      if (paidCount > 0) {
        topActions.push(
          makeAction("start", {
            label: "Начать поездку",
            className: `${styles.actionButton} ${styles.acceptButton} ${styles.topActionBtn}`,
            disabled: globalBusy,
            onClick: () =>
              setConfirmModal?.({
                open: true,
                action: "start-trip",
                participantId: null,
                confirmMessage:
                  "Если начать поездку заранее, всем участникам нужно будет подтвердить присутствие в приложении. Иначе поездка автоматически начнётся в запланированное время.",
              }),
          })
        );
      } else {
        topInfoText =
          'Начать поездку невозможно, т.к. нет участников со статусом «Оплачено». Можно только отменить поездку.';
      }

      topActions.push(
        makeAction("edit", {
          label: "Редактировать",
          className: `${styles.actionButton} ${styles.topActionBtn}`,
          disabled: globalBusy || isCancelPending,
          title:
            activeParticipantsCount > 0
              ? "Редактирование запрещено: есть участники"
              : "Редактировать поездку",
          onClick: () => {
            if (activeParticipantsCount > 0) {
              setMessage(
                "Редактирование недоступно: в поездке уже есть участники. Исключите участников, затем попробуйте снова."
              );
              return;
            }
            router.push(
              {
                pathname: "/dashboard",
                query: {
                  section: "edit-trip",
                  tripId: trip.id,
                  returnTo: "participants",
                },
              },
              undefined,
              { shallow: true }
            );
          },
        })
      );

      topActions.push(
        makeAction("cancel", {
          label: globalBusy ? "Обработка…" : "Отмена поездки",
          className: `${styles.cancelButton} ${styles.topActionBtn}`,
          disabled: globalBusy || isCancelPending,
          onClick: () => handleCancelTrip?.(),
        })
      );
    }

    if (showFooterCheckin) {
      topActions.push(
        makeAction("cancel-checkin", {
          label: globalBusy ? "Обработка…" : "Отмена поездки",
          className: `${styles.cancelButton} ${styles.topActionBtn}`,
          disabled: globalBusy || isCancelPending,
          onClick: () => handleCancelTrip?.(),
        })
      );
    }

    if (showFooterCanceling) {
      topActions.push(
        makeAction("cancel-retry", {
          label: isCancelPending
            ? "Отмена поездки (в процессе…)"
            : "Повторить отмену",
          className: `${styles.cancelButton} ${styles.topActionBtn}`,
          disabled: globalBusy || isCancelPending,
          title: isCancelPending ? "Отмена уже запущена…" : "Повторить отмену",
          onClick: () => handleCancelTrip?.(),
        })
      );
    }

    if (showFooterStarted) {
      topActions.push(
        makeAction("finish", {
          label: "Завершить поездку",
          className: `${styles.actionButton} ${styles.acceptButton} ${styles.topActionBtn}`,
          disabled: globalBusy,
          onClick: withLock(() => handleFinishTrip?.()),
        })
      );
    }

    if (isFinishedOrArchived) {
      topActions.push(
        makeAction("bulk-review", {
          label: bulkButtonText,
          className: `${bulkButtonClass} ${styles.topActionBtn}`,
          disabled: disableBulkButton,
          title: bulkButtonTitle,
          onClick: openBulkReview,
        })
      );
    }
  }

  // ---- Участник ----
  const canLeaveParticipant = (p) => {
    if (!p) return false;
    const ps = (p.status || "").toLowerCase();
    const eligibleStatus = ps === "waiting" || ps === "confirmed" || ps === "paid";
    const tripOk = ![
      "started",
      "finished",
      "canceled",
      "archived",
      "canceling",
    ].includes(tripStatus);
    return eligibleStatus && tripOk;
  };

  const canOpenDisputeSelf = (p) => {
    if (!p) return false;
    return !isCreator && p.user_id === user?.id && tripStatus === "finished";
  };

  if (!isCreator && currentParticipant) {
    const ps = (currentParticipant.status || "").toLowerCase();

    // 1) Активная поездка / до старта
    if (["created", "active", "active_checkin"].includes(tripStatus)) {
      // Оплата
      if (ps === "confirmed") {
        const payDisabled =
          globalBusy ||
          participantsLoading ||
          (!canPayNowByDate() ? true : false) ||
          (!!payLocked && !allowRetry);

        const payTitle = !canPayNowByDate()
          ? buildPayTooEarlyMessage()
          : payLocked && !allowRetry
          ? payTooltip || "Проверяем платёж…"
          : "";

        topActions.push(
          makeAction("pay", {
            label: allowRetry ? "Повторная оплата" : "Оплатить",
            className: `${payDisabled ? styles.disabledButton : styles.payButton} ${
              styles.topActionBtn
            }`,
            disabled: payDisabled,
            title: payTitle,
            onClick: () => onPayClickLocked?.(currentParticipant.id),
          })
        );
      }

      // Чек-ин: подтвердить присутствие
      if (ps === "paid" && isCheckinOpen) {
        topActions.push(
          makeAction("presence", {
            label: currentParticipant.confirmed_start
              ? "Присутствие подтверждено"
              : "Подтвердить присутствие",
            className: `${styles.actionButton} ${styles.topActionBtn}`,
            disabled: globalBusy || !!currentParticipant.confirmed_start,
            title: currentParticipant.confirmed_start
              ? "Присутствие уже подтверждено"
              : "",
            onClick: () => onConfirmPresence?.(currentParticipant.id),
          })
        );
      }

      // Покинуть поездку (как в PC: если платёж завис/проверяется — скрываем)
      if (!(payLocked && !allowRetry) && canLeaveParticipant(currentParticipant)) {
        topActions.push(
          makeAction("leave", {
            label: "Покинуть поездку",
            className: `${styles.cancelButton} ${styles.topActionBtn}`,
            disabled: globalBusy,
            onClick: () => onLeave?.(currentParticipant.id),
          })
        );
      }
    }

    // 2) Поездка отменена — можно оставить отзыв организатору (как было)
    if (tripStatus === "canceled") {
      topActions.push(
        makeAction("review-canceled", {
          label: participantReviewSent ? "Отзыв отправлен" : "Оставить отзыв",
          className: `${participantReviewSent ? styles.disabledButton : styles.actionButton} ${
            styles.topActionBtn
          }`,
          disabled: globalBusy || participantReviewSent,
          title: participantReviewSent
            ? "Вы уже оставили отзыв организатору"
            : "Поездка отменена — вы можете оставить отзыв организатору",
          onClick: () => {
            if (!participantReviewSent) onOpenReview?.(currentParticipant);
          },
        })
      );
    }

    // 3) Завершена / архив — одобрение/спор/отзыв
    if (isFinishedOrArchived) {
      if (currentParticipant.has_open_dispute) {
        topActions.push(
          makeAction("approve-disabled", {
            label: "Одобрить",
            className: `${styles.disabledButton} ${styles.topActionBtn}`,
            disabled: true,
            title:
              "Открыт спор, смотрите чат в сообщениях, вкладка «Поддержка».",
          })
        );
        topActions.push(
          makeAction("dispute-disabled", {
            label: "Открыть спор",
            className: `${styles.disabledButton} ${styles.topActionBtn}`,
            disabled: true,
            title:
              "Открыт спор, смотрите чат в сообщениях, вкладка «Поддержка».",
          })
        );
      } else if (currentParticipant.approved_trip !== true) {
        topActions.push(
          makeAction("approve", {
            label: "Одобрить",
            className: `${styles.acceptButton} ${styles.topActionBtn}`,
            disabled: globalBusy || ps !== "paid",
            title: ps !== "paid" ? "Доступно только после оплаты" : "",
            onClick: () => onApproveAndPayout?.(currentParticipant.id),
          })
        );

        if (canOpenDisputeSelf(currentParticipant)) {
          topActions.push(
            makeAction("dispute", {
              label: "Открыть спор",
              className: `${styles.rejectButton} ${styles.topActionBtn}`,
              disabled: globalBusy,
              onClick: () => onOpenDispute?.(currentParticipant.id),
            })
          );
        }
      }

      // Отзыв (всегда можно, если ещё не отправлен)
      topActions.push(
        makeAction("review-finished", {
          label: participantReviewSent ? "Отзыв отправлен" : "Оставить отзыв",
          className: `${participantReviewSent ? styles.disabledButton : styles.actionButton} ${
            styles.topActionBtn
          }`,
          disabled: globalBusy || participantReviewSent,
          title: participantReviewSent ? "Вы уже оставили отзыв" : "Расскажите, как всё прошло",
          onClick: () => {
            if (!participantReviewSent) onOpenReview?.(currentParticipant);
          },
        })
      );
    }
  }

  const hasHeaderActions = topActions.length > 0;

  return (
    <div className={containerClassName}>
      <div className={styles.headerBar}>
        <button
          className={styles.backButton}
          onClick={() => router.push("/dashboard?section=myTrips")}
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

      <h2>Участники поездки: {trip?.title}</h2>

      {hasHeaderActions && (
        <>
          <div className={styles.headerDivider} />

          {actionsCollapsed ? (
            <div className={styles.actionsBarCollapsed}>
              <button
                type="button"
                className={styles.actionsToggleFull}
                onClick={() => setActionsCollapsed(false)}
                disabled={globalBusy}
              >
                Действия ▾
              </button>
            </div>
          ) : (
            <div className={styles.actionsWrap}>
              <div className={styles.actionsHeaderRow}>
                <div className={styles.actionsTitle}>Действия</div>
                <button
                  type="button"
                  className={styles.actionsToggle}
                  onClick={() => setActionsCollapsed(true)}
                  disabled={globalBusy}
                  aria-label="Свернуть действия"
                >
                  ▴
                </button>
              </div>

              <div className={styles.actionsList}>
                {topActions.map((a) => (
                  <button
                    key={a.key}
                    className={a.className}
                    onClick={a.onClick}
                    disabled={a.disabled}
                    title={a.title || ""}
                  >
                    {a.label}
                  </button>
                ))}
              </div>

              {!!topInfoText && (
                <div className={styles.actionsHint}>{topInfoText}</div>
              )}

{showCheckinHint && (
  <div className={styles.actionsHint} style={{ color: '#ff3b30', fontWeight: 600 }}>
    Чтобы поездка началась, участники должны подтвердить присутствие у себя в приложении.
  </div>
)}

            </div>
          )}

          <div className={styles.headerDivider} />
        </>
      )}

      <div
        style={
          participantsLoading ? { opacity: 0.72, pointerEvents: "none" } : undefined
        }
      >
        <ParticipantsTable
          uiStyles={styles}
          participants={participants}
          currentUserId={user?.id}
          isLoading={globalBusy}
          individualReviews={individualReviews}
          bulkReviewSent={bulkReviewSent}
          participantReviewSent={participantReviewSent}
          trip={trip}
          isCreator={!!isCreator}
          actionDropdown={actionDropdown}
          setActionDropdown={setActionDropdown}
          confirmModal={confirmModal}
          setConfirmModal={setConfirmModal}
          setMessage={setMessage}
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
          participantsLoading={participantsLoading}
          onFirstPaint={() => setTablePainted(true)}
          payLocked={!!payLocked}
          payTooltip={payTooltip || ""}
          allowRetry={!!allowRetry}
          isCheckingStatus={!!isCheckingStatus}
          hideSelfActionsInTable={true}
        />
      </div>

      {/* Прогресс возвратов при canceling */}
      {refundProgress && (
        <div className={styles.cancelProgress}>
          Возвраты: {refundProgress.done}/{refundProgress.total} (всего:{" "}
          {totalRefunds || 0})
        </div>
      )}

      {/* Модалки (оплата, отзывы, подтверждения, спор) */}
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
        payTooltip={payTooltip || ""}
        allowRetry={!!allowRetry}
        /* ===== Отзывы ===== */
        reviewModal={reviewModal}
        setReviewModal={setReviewModal}
        reviewText={reviewText}
        setReviewText={setReviewText}
        rating={rating}
        setRating={setRating}
        handleSubmitReview={handleSubmitReview}
        /* ===== ConfirmModal (исключение/отмена/старт/выплата/выход) ===== */
        confirmModal={confirmModal}
        setConfirmModal={setConfirmModal}
        confirmExclude={confirmExclude}
        confirmCancelTrip={confirmCancelTrip}
        confirmLeaveTrip={confirmLeaveTrip}
        uiStyles={styles}
        confirmStartTrip={withLock(handleStartTrip)}
        approveAndPayout={approveAndPayout}
        /* ===== Dispute ===== */
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
            ...errorPopupPosition, // ✅ важно: именно spread
          }}
        >
          <p className={styles.errorPopupText}>{message}</p>
        </div>
      )}

      {/* Глобальный оверлей-блокировка */}
      <div
        className={`${styles.pageOverlay || ""} ${
          globalBusy ? styles.pageOverlayVisible || "" : ""
        }`}
        aria-hidden={!globalBusy}
        aria-busy={globalBusy}
      >
        <div className={styles.pageOverlaySpinner || ""} />
      </div>
    </div>
  );
};

export default TripParticipantsPageMobile;
