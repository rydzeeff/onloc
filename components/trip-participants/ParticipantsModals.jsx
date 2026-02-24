// /components/trip-participants/ParticipantsModals.jsx
// Единый компонент модалок (PC + Mobile):
// - На мобилке: если uiStyles содержит actionSheetBackdrop/actionSheet — будет bottom-sheet.
// - На PC: используем modalBackdrop/modalContent.

import React, { useMemo, useState } from "react";
import pcStyles from "../../styles/trip-participants.pc.module.css";

/**
 * ✅ КРИТИЧЕСКИЙ ФИКС ФОКУСА:
 * Sheet ВЫНЕСЕН наружу, чтобы его "тип" был стабильным между рендерами.
 * Если объявлять Sheet внутри ParticipantsModals — при каждом setState (ввод в textarea)
 * React будет размонтировать/монтировать модалку заново, и фокус будет пропадать после каждой буквы.
 */
function Sheet({ open, title, onClose, children, styles, busy }) {
  if (!open) return null;

  const BackdropClass = styles.actionSheetBackdrop || styles.modalBackdrop;
  const SheetClass = styles.actionSheet || styles.modalContent;

  const headerClass = styles.sheetHeader || "";
  const titleClass = styles.sheetTitle || styles.modalTitle || "";
  const closeClass = styles.sheetClose || styles.closeButton || "";
  const bodyClass = styles.sheetBody || "";

  return (
    <div
      className={BackdropClass}
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (busy) return;
        onClose?.();
      }}
    >
      <div className={SheetClass} onClick={(e) => e.stopPropagation()}>
        <div
          className={headerClass}
          style={
            headerClass
              ? undefined
              : {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 12,
                }
          }
        >
          <div
            className={titleClass}
            style={
              titleClass
                ? undefined
                : { fontSize: 16, fontWeight: 700, color: "#0f172a" }
            }
          >
            {title}
          </div>

          <button
            type="button"
            className={closeClass}
            onClick={() => {
              if (busy) return;
              onClose?.();
            }}
            disabled={busy}
            aria-label="Закрыть"
            style={
              closeClass
                ? undefined
                : {
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    border: "1px solid #e2e8f0",
                    background: "#fff",
                    cursor: "pointer",
                    fontSize: 18,
                    lineHeight: 1,
                  }
            }
          >
            ✕
          </button>
        </div>

        <div
          className={bodyClass}
          style={
            bodyClass
              ? undefined
              : {
                  maxHeight: "70vh",
                  overflow: "auto",
                  paddingBottom: "env(safe-area-inset-bottom)",
                }
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default function ParticipantsModals({
  // ===== Оплата / Политика возврата =====
  showRefundPolicy,
  setShowRefundPolicy,
  savedCards,
  isLoadingCards,
  selectedCardId,
  setSelectedCardId,
  saveCard,
  setSaveCard,
  confirmPay,
  renderRefundPolicy,
  formatCardLabel,

  // UX оплаты
  payLocked = false,
  payTooltip = "",
  allowRetry = false,

  // ===== Отзывы =====
  reviewModal,
  setReviewModal,
  reviewText,
  setReviewText,
  rating,
  setRating,
  handleSubmitReview,

  // ===== Confirm-модалка =====
  confirmModal, // { open, action, participantId, confirmMessage? }
  setConfirmModal,
  confirmLeaveTrip,
  confirmCancelTrip,
  confirmExclude,
  approveAndPayout,
  confirmStartTrip,
  handleStartTrip,

  // ===== Спор (dispute) =====
  showDisputeModal,
  setShowDisputeModal,
  selectedDisputeParticipantId,
  setSelectedDisputeParticipantId,
  disputeReason,
  setDisputeReason,
  evidenceFile,
  setEvidenceFile,
  isOpeningDispute,
  setIsOpeningDispute,
  handleOpenDispute,
  handleUploadEvidence,

  // ===== UI Styles (optional) =====
  uiStyles,

  // Общие
  isLoading,
  setMessage,
}) {
  const styles = uiStyles || pcStyles;

  // ✅ мобилка только если реально есть sheet-классы (а не просто передали пустой объект)
  const isMobileUI = !!(uiStyles?.actionSheetBackdrop || uiStyles?.actionSheet);

  const [confirmProcessing, setConfirmProcessing] = useState(false);
  const busy = !!(isLoading || confirmProcessing || isOpeningDispute);

  // ====== классы кнопок (чтобы не было "маленьких/квадратных") ======
  const BTN_PRIMARY =
    styles.sheetItemPrimary || styles.acceptButton || styles.actionButton;
  const BTN_DANGER =
    styles.sheetItemDanger || styles.rejectButton || styles.closeButton;
  const BTN_NEUTRAL =
    styles.sheetCancel || styles.actionButton || styles.closeButton;
  const BTN_BLUE = styles.sheetItemBlue || styles.actionButton;

  // ====== confirm text ======
  const confirmText = useMemo(() => {
    if (confirmModal?.confirmMessage) return confirmModal.confirmMessage;
    switch (confirmModal?.action) {
      case "leave":
        return "Покинуть поездку? Будет применена политика возврата.";
      case "cancel":
        return "Отменить поездку и оформить возвраты участникам?";
      case "exclude":
        return "Исключить участника из поездки?";
      case "approve-and-payout":
        return "Принять участника и выполнить выплату организатору?";
      case "start-trip":
        return "Вы точно хотите начать поездку?";
      default:
        return "Подтвердить действие?";
    }
  }, [confirmModal]);

  const closeConfirm = () => setConfirmModal?.({ open: false });

  const handleConfirmYes = async () => {
    if (!confirmModal?.action) {
      closeConfirm();
      return;
    }

    setConfirmProcessing(true);
    try {
      switch (confirmModal.action) {
        case "leave":
          await confirmLeaveTrip?.(confirmModal.participantId);
          break;
        case "cancel":
          await confirmCancelTrip?.();
          break;
        case "exclude":
          await confirmExclude?.(confirmModal.participantId);
          break;
        case "approve-and-payout":
          await approveAndPayout?.(confirmModal.participantId);
          break;
        case "start-trip":
          await (confirmStartTrip || handleStartTrip)?.();
          break;
        default:
          break;
      }
    } catch (e) {
      console.error("Ошибка confirm action:", e);
      setMessage?.(e?.message || "Не удалось выполнить действие. Попробуйте ещё раз.");
    } finally {
      setConfirmProcessing(false);
      closeConfirm();
    }
  };

  // Для модалки "Принять/Отклонить": отклонение = исключить (по твоему смыслу)
  const handleDecline = async () => {
    const pid = confirmModal?.participantId;
    if (!pid) {
      closeConfirm();
      return;
    }

    setConfirmProcessing(true);
    try {
      await confirmExclude?.(pid);
    } catch (e) {
      console.error("Ошибка decline:", e);
      setMessage?.(e?.message || "Не удалось отклонить. Попробуйте ещё раз.");
    } finally {
      setConfirmProcessing(false);
      closeConfirm();
    }
  };

  const closeReview = () =>
    setReviewModal?.({ open: false, organizerId: null, participantId: null, isBulk: false });

  const closeDispute = () => {
    setShowDisputeModal?.(false);
    setDisputeReason?.("");
    setEvidenceFile?.(null);
    setSelectedDisputeParticipantId?.(null);
  };

  const handleSendDispute = async () => {
    try {
      if (!disputeReason) {
        setMessage?.("Укажите причину спора");
        return;
      }
      setIsOpeningDispute?.(true);
      const disputeId = await handleOpenDispute?.(
        selectedDisputeParticipantId,
        disputeReason
      );
      if (disputeId && evidenceFile) {
        await handleUploadEvidence?.(disputeId, evidenceFile);
      }
      closeDispute();
      setMessage?.("Спор открыт. Чат доступен во вкладке «Поддержка».");
    } catch (err) {
      console.error("Ошибка при создании спора:", err);
      setMessage?.("Не удалось открыть спор. Попробуйте ещё раз.");
    } finally {
      setIsOpeningDispute?.(false);
    }
  };

  const hasSavedCards = (savedCards || []).length > 0;

  return (
    <>
      {/* ====== Оплата / политика возврата ====== */}
      <Sheet
        open={!!showRefundPolicy}
        title="Оплата"
        onClose={() => setShowRefundPolicy?.(false)}
        styles={styles}
        busy={busy}
      >
        <div className={styles.sheetNote || ""} style={{ marginBottom: 10 }}>
          Сначала ознакомьтесь с политикой возврата, затем выберите способ оплаты.
        </div>

        <div className={styles.policyWrapper || ""}>{renderRefundPolicy?.()}</div>

        {payLocked && !allowRetry && (
          <div className={styles.sheetNote || ""} style={{ marginTop: 10 }}>
            {payTooltip || "Проверяем платёж…"}
          </div>
        )}

        <div className={styles.sheetTitle || styles.modalTitle || ""} style={{ marginTop: 12 }}>
          Способ оплаты
        </div>

        <div className={styles.cardsList || ""}>
          {isLoadingCards ? (
            <div style={{ opacity: 0.7 }}>Загрузка карт…</div>
          ) : !hasSavedCards ? (
            <>
              <div style={{ opacity: 0.7, marginBottom: 8 }}>Сохранённых карт нет</div>

              {/* выпадающий список всё равно показываем (там будет только "Новая карта") */}
              <select
                className={styles.cardSelect || ""}
                value={selectedCardId || ""}
                onChange={(e) => setSelectedCardId?.(e.target.value)}
                disabled={busy}
              >
                <option value="">Новая карта</option>
              </select>
            </>
          ) : (
            <>
              <select
                className={styles.cardSelect || ""}
                value={selectedCardId || ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setSelectedCardId?.(v);
                  // если выбрали сохранённую — "сохранить карту" смысла не имеет
                  if (v) setSaveCard?.(false);
                }}
                disabled={busy}
              >
                {(savedCards || []).map((c) => (
                  <option key={c.card_id} value={c.card_id}>
                    {formatCardLabel?.(c)}
                  </option>
                ))}

                {/* в конец — вариант оплаты новой картой */}
                <option value="">Новая карта</option>
              </select>

              {!!selectedCardId && (
                <div className={styles.mutedHint || ""} style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                  Выбрана сохранённая карта. Чтобы оплатить другой — выберите «Новая карта».
                </div>
              )}
            </>
          )}
        </div>

        <label className={styles.checkboxRow || ""} style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={!!saveCard && !selectedCardId}
            disabled={!!selectedCardId}
            onChange={(e) => setSaveCard?.(e.target.checked)}
          />
          <span>Сохранить карту для будущих платежей</span>
        </label>

        <div className={styles.sheetButtons || styles.modalButtons || ""}>
          <button
            className={BTN_PRIMARY}
            onClick={() => confirmPay?.()}
            disabled={busy || (payLocked && !allowRetry)}
            title={payLocked && !allowRetry ? payTooltip || "Проверяем платёж…" : ""}
          >
            {allowRetry ? "Повторить оплату" : "Оплатить"}
          </button>

          <button className={BTN_NEUTRAL} onClick={() => setShowRefundPolicy?.(false)} disabled={busy}>
            Закрыть
          </button>
        </div>
      </Sheet>

      {/* ====== Отзыв ====== */}
      <Sheet
        open={!!reviewModal?.open}
        title={
          reviewModal?.organizerId
            ? "Отзыв об организаторе"
            : reviewModal?.isBulk
            ? "Отзыв всем участникам"
            : "Отзыв участнику"
        }
        onClose={closeReview}
        styles={styles}
        busy={busy}
      >
        <div className={styles.ratingRow || ""}>
          <span className={styles.ratingLabel || ""}>Оценка:</span>

          <div className={styles.ratingButtons || ""}>
            {[1, 2, 3, 4, 5].map((v) => {
              const active = v <= (rating || 0);
              const cls = styles.ratingBtn
                ? `${styles.ratingBtn} ${active ? styles.ratingBtnActive || "" : ""}`
                : active
                ? BTN_PRIMARY
                : BTN_NEUTRAL;

              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setRating?.(v)}
                  className={cls}
                  disabled={busy}
                  style={styles.ratingBtn ? undefined : { width: 44, height: 44, padding: 0 }}
                >
                  {v}
                </button>
              );
            })}
          </div>
        </div>

        <textarea
          className={styles.reviewTextArea || ""}
          placeholder={
            reviewModal?.organizerId
              ? "Поделитесь впечатлениями о поездке и работе организатора"
              : reviewModal?.isBulk
              ? "Общий отзыв для всех участников (кроме тех, кому уже оставлен личный отзыв)"
              : "Опишите впечатления о совместной поездке этого участника"
          }
          value={reviewText || ""}
          onChange={(e) => setReviewText?.(e.target.value)}
          disabled={busy}
          style={{ marginTop: 12 }}
        />

        <div className={styles.sheetButtons || styles.modalButtons || ""}>
          <button
            className={BTN_PRIMARY}
            onClick={() => handleSubmitReview?.(reviewModal?.participantId ?? null, !!reviewModal?.isBulk)}
            disabled={busy || !rating}
            title={!rating ? "Пожалуйста, поставьте оценку" : ""}
          >
            Отправить
          </button>

          <button className={BTN_NEUTRAL} onClick={closeReview} disabled={busy}>
            Отмена
          </button>
        </div>
      </Sheet>

      {/* ====== Confirm: ВСЕГДА как sheet (в т.ч. Принять/Отклонить) ====== */}
      <Sheet
        open={!!confirmModal?.open}
        title="Подтверждение"
        onClose={closeConfirm}
        styles={styles}
        busy={busy}
      >
        <div className={styles.sheetNote || styles.modalText || ""}>{confirmText}</div>

        <div className={styles.sheetButtons || styles.modalButtons || ""}>
          {/* Принять/Отклонить */}
          {confirmModal?.action === "approve-and-payout" ? (
            isMobileUI ? (
              // ✅ MOBILE: как "Исключить" (визуально): primary + neutral, порядок как в exclude
              <>
                <button className={BTN_PRIMARY} onClick={handleConfirmYes} disabled={busy}>
                  {confirmProcessing ? "Выполняю…" : "Принять"}
                </button>

                <button className={BTN_BLUE} onClick={handleDecline} disabled={busy}>
                  Отклонить
                </button>
              </>
            ) : (
              // ✅ PC: оставить как было
              <>
                <button className={BTN_PRIMARY} onClick={handleConfirmYes} disabled={busy}>
                  {confirmProcessing ? "Выполняю…" : "Принять"}
                </button>

                <button className={BTN_DANGER} onClick={handleDecline} disabled={busy}>
                  Отклонить
                </button>
              </>
            )
          ) : // Деструктивные: Да красная, Нет зелёная
          ["leave", "cancel", "exclude"].includes(confirmModal?.action) ? (
            <>
              <button className={BTN_DANGER} onClick={handleConfirmYes} disabled={busy}>
                {confirmProcessing ? "Выполняю…" : "Да"}
              </button>

<button
  className={styles.acceptButton || BTN_PRIMARY}
  onClick={closeConfirm}
  disabled={busy}
>
  Нет
</button>
            </>
          ) : (
            // Нейтральные/позитивные: Да зелёная, Нет нейтральная
            <>
              <button className={BTN_PRIMARY} onClick={handleConfirmYes} disabled={busy}>
                {confirmProcessing ? "Выполняю…" : "Да"}
              </button>

              <button className={BTN_NEUTRAL} onClick={closeConfirm} disabled={busy}>
                Нет
              </button>
            </>
          )}
        </div>
      </Sheet>

      {/* ====== Dispute ====== */}
      <Sheet
        open={!!showDisputeModal}
        title="Открыть спор"
        onClose={closeDispute}
        styles={styles}
        busy={busy}
      >
        <textarea
          value={disputeReason || ""}
          onChange={(e) => setDisputeReason?.(e.target.value)}
          placeholder="Опишите причину спора"
          className={styles.reviewTextArea || ""}
          disabled={busy}
        />

        <input
          type="file"
          accept="image/*,video/mp4,application/pdf,text/plain"
          onChange={(e) => setEvidenceFile?.(e.target.files?.[0] || null)}
          className={styles.fileInput || ""}
          disabled={busy}
          style={{ marginTop: 10 }}
        />

        {evidenceFile && (
          <div className={styles.sheetNote || ""} style={{ marginTop: 8 }}>
            Файл: {evidenceFile.name}
          </div>
        )}

        <div className={styles.sheetButtons || styles.modalButtons || ""}>
          <button className={BTN_PRIMARY} onClick={handleSendDispute} disabled={busy}>
            {isOpeningDispute ? "Отправка…" : "Отправить"}
          </button>

          <button className={BTN_NEUTRAL} onClick={closeDispute} disabled={busy}>
            Отмена
          </button>
        </div>
      </Sheet>
    </>
  );
}
