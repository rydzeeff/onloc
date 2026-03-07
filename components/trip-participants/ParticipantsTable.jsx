// /components/trip-participants/ParticipantsTable.jsx
import React, { memo, useEffect, useRef } from 'react';
import pcStyles from '../../styles/trip-participants.pc.module.css';
import { platformSettings } from '../../lib/platformSettings';

function ParticipantsTable({
  uiStyles,
  participants,
  trip,
  isCreator,
  currentUserId,

  actionDropdown,
  setActionDropdown,

  isLoading,
  individualReviews,
  bulkReviewSent,

  onAccept,
  onReject,
  onExclude,
  onPayClick,
  onConfirmPresence,
  onOpenDispute,
  onOpenReview,
  onApproveAndPayout,
  onLeave, // колбэк выхода участника из поездки

  getFullName,
  calculateAge,

  // окно чек-ина активно (из хука)
  isCheckinOpen,

  // 👇 индикатор загрузки списка участников
  participantsLoading = false,

  // 👇 участник уже отправил отзыв (чтобы заблокировать кнопку в UI)
  participantReviewSent = false,
  onFirstPaint,
  payLocked = false,
  payTooltip = '',
  allowRetry = false,
  isCheckingStatus = false,

  // ✅ НОВОЕ: скрыть действия участника (самого себя) внутри таблицы
  // (так как ты переносишь их в верхний блок "Действия" на мобилке)
  hideSelfActionsInTable = false,
}) {
  const styles = uiStyles || pcStyles;

const dropdownRef = useRef(null);

const isMobileUI = !!(uiStyles?.actionSheetBackdrop || uiStyles?.actionSheet);

const BTN_PRIMARY = styles.sheetItemPrimary || styles.acceptButton || styles.actionButton;
const BTN_BLUE = styles.sheetItemBlue || styles.actionButton;

  const statusTranslations = {
    waiting: 'Ожидает',
    confirmed: 'Подтверждён',
    rejected: 'Отклонён',
    started: 'Поездка начата',
    canceled: 'Поездка отменена',
    finished: 'Завершена',
    active: 'Активна',
    paid: 'Оплачено',
    pending: 'Ожидает',
    active_checkin: 'Подтверждение присутствия',
  };

  const genderTranslations = {
    male: 'Мужской',
    female: 'Женский',
    man: 'Мужской',
  };

  // Сообщаем родителю после фактической отрисовки строк
  useEffect(() => {
    if ((participants?.length ?? 0) > 0 && typeof onFirstPaint === 'function') {
      // два rAF — гарантируем, что DOM уже вставлен и отрисован браузером
      requestAnimationFrame(() =>
        requestAnimationFrame(() => onFirstPaint())
      );
    }
  }, [participants, onFirstPaint]);

useEffect(() => {
  if (!actionDropdown?.open) return;
  if (isMobileUI) return; // важно: это только для ПК-дропдауна

  const onMouseDown = (e) => {
    const menu = dropdownRef.current;
    const btn = actionDropdown?.buttonRef;

    // клик по кнопке-открывателю — не закрываем
    if (btn && (btn === e.target || btn.contains(e.target))) return;

    // клик внутри меню — не закрываем
    if (menu && menu.contains(e.target)) return;

    // клик вне — закрываем
    setActionDropdown?.({ open: false, participantId: null, buttonRef: null });
  };

  document.addEventListener('mousedown', onMouseDown, true);
  return () => document.removeEventListener('mousedown', onMouseDown, true);
}, [actionDropdown?.open, actionDropdown?.buttonRef, isMobileUI, setActionDropdown]);


  // Спор доступен только участнику (не организатору), только в своей строке и только когда поездка завершена
  const canOpenDisputeFor = (p) => {
    const ts = (trip?.status || '').toLowerCase();
    return !isCreator && p.user_id === currentUserId && ts === 'finished';
  };

  // Можно ли покинуть поездку (кнопка в таблице, только для самого участника)
  const canLeaveFor = (p) => {
    if (isCreator) return false;
    const isSelf = p.user_id === currentUserId;
    if (!isSelf) return false;
    const ps = (p.status || '').toLowerCase();
    const ts = (trip?.status || '').toLowerCase();
    const eligibleStatus = ps === 'waiting' || ps === 'confirmed' || ps === 'paid';
    const tripOk = !['started', 'finished', 'canceled', 'archived', 'canceling'].includes(ts);
    return eligibleStatus && tripOk;
  };

  // ——— Лоадер (крутилка) для области таблицы ———
  const Loader = () => (
    <div className={styles.loaderWrapper}>
      <div className={styles.spinner} />
      <div className={styles.loaderText}>Загружаем участников…</div>
    </div>
  );

  return (
    <div className={styles.participantsTable}>
      <div className={styles.tableHeader}>
        <span>Аватар</span>
        <span>ФИО</span>
        <span>Возраст</span>
        <span>Пол</span>
        <span>Рейтинг</span>
        <span>Статус</span>
        <span>Присутствие</span>
        <span>Одобрено</span>
        <span>Дата</span>
        <span>Действия</span>
      </div>

      {/* 🔄 Сперва отображаем индикатор загрузки */}
      {participantsLoading ? (
        <Loader />
      ) : (participants?.length ?? 0) === 0 ? (
        <div className={styles.tableRow}>
          <span style={{ gridColumn: '1 / -1', opacity: 0.8 }}>Участники отсутствуют</span>
        </div>
      ) : (
        participants.map((p) => {
          const isSelf = p.user_id === currentUserId;
          const fullName = getFullName?.(p) || 'Без имени';
          const avatar = p.avatar_url || '/avatar-default.svg';
          const rating = (p.average_rating ?? 0).toFixed(1);
          const statusLabel = statusTranslations[p.status?.toLowerCase()] || p.status;
          const joined = p.joined_at ? new Date(p.joined_at).toLocaleString('ru') : '';

          // дата старта
          const startDate = trip?.start_date ? new Date(trip.start_date) : null;
          const daysUntilTrip = startDate ? Math.ceil((startDate.getTime() - Date.now()) / 86400000) : 0;

          // окно банка (N дней)
          const minWindow = Number(platformSettings.paymentOpenWindowDays ?? 0);

          // можно ли платить по дате: только если поездка начнётся не позже, чем через N дней
          const payAllowedByDate = daysUntilTrip <= minWindow;

          // текст-подсказка (если рано платить)
          const payTooEarlyHint =
            !payAllowedByDate
              ? `По условиям банка мы можем удерживать средства не более ${minWindow} дн. 
До начала поездки — ${daysUntilTrip} дн., поэтому оплатить можно не раньше чем через ${Math.max(daysUntilTrip - minWindow, 0)} дн.`
              : '';

          return (
            <div key={p.id} className={styles.tableRow}>
              {/* Аватар */}
              <span>
                <img
                  src={avatar}
                  alt={`${fullName} avatar`}
                  className={styles.avatar}
                  onError={(e) => {
                    e.target.src = '/avatar-default.svg';
                  }}
                />
              </span>

              {/* ФИО */}
              <span>{fullName}</span>

              {/* Возраст */}
              <span>{calculateAge?.(p.birth_date)}</span>

              {/* Пол */}
              <span>{genderTranslations[p.gender?.toLowerCase()] || 'Не указан'}</span>

              {/* Рейтинг */}
              <span>{rating}</span>

              {/* Статус */}
              <span>{statusLabel}</span>

              {/* Присутствие */}
              <span>{p.confirmed_start ? 'Да' : 'Нет'}</span>

              {/* Одобрено */}
              <span>{p.approved_trip == null ? 'Не указано' : p.approved_trip ? 'Да' : 'Нет'}</span>

              {/* Дата */}
              <span>{joined}</span>

              {/* Действия */}
              <span
                className={styles.actionButtons}
                style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}
              >
                {/* Организатор: заявка => дропдаун Принять/Отклонить */}
                {isCreator && p.status?.toLowerCase() === 'waiting' && (
                  <div className={styles.dropdownWrapper}>
                    <button
  className={styles.actionButton}
  onClick={(e) => {
    if (isMobileUI) {
      // ✅ мобилка: без привязки к кнопке, будем показывать модалку/sheet
      setActionDropdown?.({ open: true, participantId: p.id });
    } else {
      // ✅ ПК: оставить старое поведение (dropdown возле кнопки)
      setActionDropdown?.({ open: true, participantId: p.id, buttonRef: e.currentTarget });
    }
  }}
  disabled={isLoading}
>
  Принять/Отклонить
</button>
                  </div>
                )}

                {/* Организатор: исключить подтверждённого/оплаченного до завершения поездки */}
                {isCreator &&
                  (p.status?.toLowerCase() === 'confirmed' || p.status?.toLowerCase() === 'paid') &&
                  // После старта скрываем «Исключить», если сейчас не окно check-in
                  (!((trip?.status || '').toLowerCase() === 'started') || isCheckinOpen) &&
                  !['finished', 'canceled', 'archived', 'canceling', 'cancel_failed'].includes(
                    (trip?.status || '').toLowerCase()
                  ) && (
                    <button className={styles.cancelButton} onClick={() => onExclude?.(p.id)} disabled={isLoading}>
                      Исключить
                    </button>
                  )}

                {/* Организатор: после завершения — отзывы участникам */}
                {isCreator &&
                  ['finished', 'archived'].includes((trip?.status || '').toLowerCase()) &&
                  p.status?.toLowerCase() !== 'rejected' && (
                    <button
                      className={
                        individualReviews?.has?.(p.user_id) || bulkReviewSent
                          ? styles.disabledButton
                          : styles.acceptButton
                      }
                      onClick={() => {
                        if (!individualReviews?.has?.(p.user_id) && !bulkReviewSent) onOpenReview?.(p);
                      }}
                      disabled={individualReviews?.has?.(p.user_id) || bulkReviewSent || isLoading}
                      title={individualReviews?.has?.(p.user_id) || bulkReviewSent ? 'Участнику оставлен отзыв' : ''}
                    >
                      Оставить отзыв
                    </button>
                  )}

                {/* ✅ Участник: действия в таблице (теперь можно полностью скрыть для мобилки) */}
                {!isCreator && isSelf && !hideSelfActionsInTable && (
                  <>
                    {/* Оплатить — для подтверждённых */}
                    {p.status?.toLowerCase() === 'confirmed' &&
                      (() => {
                        // payLocked уже включает isCheckingStatus внутри useTripPayments
                        const payDisabled = isLoading || !payAllowedByDate || (!!payLocked && !allowRetry);
                        const title =
                          isLoading
                            ? ''
                            : payLocked && !allowRetry
                              ? (payTooltip || 'Проверяем платёж…')
                              : (payTooEarlyHint || '');

                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <button
                              className={payDisabled ? styles.disabledButton : styles.payButton}
                              onClick={() => onPayClick?.(p.id)}
                              disabled={payDisabled}
                              title={title}
                              aria-disabled={payDisabled}
                            >
                              {allowRetry ? 'Повторить оплату' : 'Оплатить'}
                            </button>

                            {payLocked && !allowRetry && (
                              <span className={styles.mutedHint} style={{ fontSize: 12, opacity: 0.75 }}>
                                {payTooltip || 'Проверяем платёж…'}
                              </span>
                            )}
                          </div>
                        );
                      })()}

                    {/* Подтвердить присутствие — ТОЛЬКО в чек-ине */}
                    {p.status?.toLowerCase() === 'paid' && isCheckinOpen && (
                      <button
                        className={styles.actionButton}
                        onClick={() => onConfirmPresence?.(p.id)}
                        disabled={p.confirmed_start || isLoading}
                        title={p.confirmed_start ? 'Присутствие уже подтверждено' : ''}
                      >
                        Подтвердить присутствие
                      </button>
                    )}

                    {/* Покинуть поездку */}
                    {!(payLocked && !allowRetry) && canLeaveFor(p) && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          className={styles.cancelButton}
                          onClick={() => onLeave?.(p.id)}
                          disabled={isLoading}
                          title={isLoading ? '' : 'Покинуть поездку'}
                          aria-disabled={isLoading}
                        >
                          Покинуть поездку
                        </button>
                      </div>
                    )}

                    {/* Участник: поездка отменена — можно оставить отзыв организатору */}
                    {!isCreator && isSelf && (trip?.status || '').toLowerCase() === 'canceled' && (
                      <button
                        className={participantReviewSent ? styles.disabledButton : styles.actionButton}
                        onClick={() => {
                          if (!participantReviewSent) onOpenReview?.(p);
                        }}
                        disabled={isLoading || participantReviewSent}
                        title={
                          participantReviewSent
                            ? 'Вы уже оставили отзыв организатору'
                            : 'Поездка отменена — вы можете оставить отзыв организатору'
                        }
                      >
                        Оставить отзыв
                      </button>
                    )}

                    {/* После завершения */}
                    {['finished', 'archived'].includes((trip?.status || '').toLowerCase()) && (
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {p.approved_trip === true ? (
                          <button
                            className={participantReviewSent ? styles.disabledButton : styles.actionButton}
                            onClick={() => {
                              if (!participantReviewSent) onOpenReview?.(p);
                            }}
                            disabled={isLoading || participantReviewSent}
                            title={participantReviewSent ? 'Вы уже оставили отзыв' : 'Расскажите, как всё прошло'}
                          >
                            Оставить отзыв
                          </button>
                        ) : p.has_open_dispute ? (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                              className={styles.disabledButton}
                              disabled
                              title='Открыт спор, смотрите чат в сообщениях, вкладка "Поддержка".'
                            >
                              Одобрить
                            </button>
                            <button
                              className={styles.disabledButton}
                              disabled
                              title='Открыт спор, смотрите чат в сообщениях, вкладка "Поддержка".'
                            >
                              Открыть спор
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                              className={styles.acceptButton}
                              onClick={() => onApproveAndPayout?.(p.id)}
                              disabled={(p.status || '').toLowerCase() !== 'paid' || isLoading}
                              title={(p.status || '').toLowerCase() !== 'paid' ? 'Доступно только после оплаты' : ''}
                            >
                              Одобрить
                            </button>

                            {canOpenDisputeFor(p) && (
                              <button
                                className={styles.rejectButton}
                                onClick={() => onOpenDispute?.(p.id)}
                                disabled={isLoading}
                              >
                                Открыть спор
                              </button>
                            )}

                            <button
                              className={participantReviewSent ? styles.disabledButton : styles.actionButton}
                              onClick={() => {
                                if (!participantReviewSent) onOpenReview?.(p);
                              }}
                              disabled={isLoading || participantReviewSent}
                              title={participantReviewSent ? 'Вы уже оставили отзыв' : 'Расскажите, как всё прошло'}
                            >
                              Оставить отзыв
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* ✅ если скрыли действия участника в таблице — покажем тире, чтобы колонка не выглядела сломанной */}
                {!isCreator && isSelf && hideSelfActionsInTable && (
                  <span style={{ opacity: 0.6 }}>—</span>
                )}
              </span>
            </div>
          );
        })
      )}

{/* Принять/Отклонить: ПК = dropdown, Mobile = sheet с затемнением */}
{actionDropdown?.open && !isLoading && (
  isMobileUI ? (
    <div
      className={styles.actionSheetBackdrop || styles.modalBackdrop}
      role="dialog"
      aria-modal="true"
      onClick={() => setActionDropdown?.({ open: false })}
    >
      <div
        className={styles.actionSheet || styles.modalContent}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.sheetHeader || ''} style={!styles.sheetHeader ? {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        } : undefined}>
          <div className={styles.sheetTitle || styles.modalTitle || ''}>
            Подтверждение
          </div>

          <button
            type="button"
            className={styles.sheetClose || styles.closeButton || ''}
            onClick={() => setActionDropdown?.({ open: false })}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>

        <div className={styles.sheetNote || styles.modalText || ''} style={{ marginBottom: 12 }}>
          Принять или отклонить участника?
        </div>

        <div className={styles.sheetButtons || styles.modalButtons || ''}>
          <button
  className={BTN_PRIMARY}
  onClick={() => {
    onAccept?.(actionDropdown.participantId);
    setActionDropdown?.({ open: false, participantId: null, buttonRef: null });
  }}
>
  Принять
</button>

<button
  className={BTN_BLUE}
  onClick={() => {
    onReject?.(actionDropdown.participantId);
    setActionDropdown?.({ open: false, participantId: null, buttonRef: null });
  }}
>
  Отклонить
</button>
        </div>
      </div>
    </div>
  ) : (
    // ✅ ПК — оставляем старое
<div
  ref={dropdownRef}
  className={styles.dropdownMenu}
  style={{
    position: 'absolute',
    top: actionDropdown.buttonRef?.getBoundingClientRect().bottom + window.scrollY + 5,
    left: actionDropdown.buttonRef?.getBoundingClientRect().left + window.scrollX,
  }}
>
  <button
    className={styles.acceptButton}
    onClick={() => {
      onAccept?.(actionDropdown.participantId);
      setActionDropdown?.({ open: false, participantId: null, buttonRef: null });
    }}
    disabled={isLoading}
  >
    Принять
  </button>

  <button
    className={styles.rejectButton}
    onClick={() => {
      onReject?.(actionDropdown.participantId);
      setActionDropdown?.({ open: false, participantId: null, buttonRef: null });
    }}
    disabled={isLoading}
  >
    Отклонить
  </button>
</div>

  )
)}

    </div>
  );
}

export default memo(ParticipantsTable);
