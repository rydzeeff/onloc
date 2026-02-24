// features/messages/desktop/MessageComposer.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

function fmtTime(sec) {
  const s = Math.max(0, sec | 0);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function preferMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const isIOS =
    typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent || "");

  // на iOS лучше mp4, если поддерживается
  if (isIOS && MediaRecorder.isTypeSupported?.("audio/mp4")) return "audio/mp4";

  if (MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported?.("audio/webm")) return "audio/webm";
  if (MediaRecorder.isTypeSupported?.("audio/mp4")) return "audio/mp4";
  return "";
}

function getClientX(e) {
  if (!e) return null;
  if (typeof e.clientX === "number") return e.clientX;
  if (e.touches?.[0]) return e.touches[0].clientX;
  if (e.changedTouches?.[0]) return e.changedTouches[0].clientX;
  return null;
}

export default function MessageComposer({
  isUploading,
  pendingFiles,
  onPickFiles,
  removePending,
  sendWithMessage,
  currentChat,
  myUserId,
  onMessageSent,
  styles,
}) {
  const [newMessage, setNewMessage] = useState("");
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);

  // voice UI
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  // swipe-cancel UI
  const [dragX, setDragX] = useState(0); // отрицательное = влево
  const [isSwipeCancel, setIsSwipeCancel] = useState(false);

  // voice internals (refs чтобы не ловить stale state)
  const isRecordingRef = useRef(false);
  const cancelRef = useRef(false); // true => не отправлять (отмена)
  const chunksRef = useRef([]);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);

  // чтобы на отпускание мы точно ловили “наш” палец/мышь
  const activePointerIdRef = useRef(null);

  // swipe refs
  const startXRef = useRef(null);
  const moveRafRef = useRef(null);

const focusInput = useCallback(() => {
  requestAnimationFrame(() => {
    const el = inputRef.current;
    if (!el) return;
    if (typeof document !== "undefined" && document.activeElement === el) return; // ✅ уже в фокусе
    el.focus?.();
  });
}, []);

  const canSend = useMemo(() => {
    const hasText = !!newMessage.trim();
    const hasFiles = (pendingFiles?.length || 0) > 0;
    return hasText || hasFiles;
  }, [newMessage, pendingFiles]);

  async function handleSend() {
    if (!currentChat || !myUserId) return;

    const hasText = !!newMessage.trim();
    const hasFiles = (pendingFiles?.length || 0) > 0;
    if (!hasText && !hasFiles) return;

    const result = await sendWithMessage({
      chatId: currentChat.id,
      tripId: currentChat.trip_id,
      userId: myUserId,
      text: newMessage || "",
    });

    if (!result) {
      focusInput();
      return;
    }

    onMessageSent?.(result);
    setNewMessage("");
    focusInput();
  }

  const stopRecordingSend = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    try {
      if (rec.state !== "inactive") rec.stop();
    } catch {
      // cleanup вызовется позже
    }
  }, []);

  // ---- глобальные обработчики (stable) ----
  const onGlobalPointerUp = useCallback(
    (e) => {
      if (!isRecordingRef.current) return;

      // если пришёл pointerId — проверим что это наш
      if (
        typeof e?.pointerId === "number" &&
        activePointerIdRef.current != null &&
        e.pointerId !== activePointerIdRef.current
      ) {
        return;
      }

      stopRecordingSend();
    },
    [stopRecordingSend]
  );

  const onGlobalMouseUp = useCallback(() => {
    if (!isRecordingRef.current) return;
    stopRecordingSend();
  }, [stopRecordingSend]);

  const onGlobalTouchEnd = useCallback(() => {
    if (!isRecordingRef.current) return;
    stopRecordingSend();
  }, [stopRecordingSend]);

  const onGlobalPointerMove = useCallback((e) => {
    if (!isRecordingRef.current) return;

    const x0 = startXRef.current;
    const x = getClientX(e);
    if (x0 == null || x == null) return;

    const dx = x - x0; // влево отрицательное

    if (moveRafRef.current) cancelAnimationFrame(moveRafRef.current);
    moveRafRef.current = requestAnimationFrame(() => {
      const limited = Math.max(-140, Math.min(0, dx)); // 0..-140
      setDragX(limited);

      const shouldCancel = limited <= -80; // порог “в корзину”
      if (shouldCancel !== cancelRef.current) {
        cancelRef.current = shouldCancel;
        setIsSwipeCancel(shouldCancel);

        // лёгкая вибрация при входе в зону отмены (если поддерживается)
        if (shouldCancel && typeof navigator !== "undefined" && navigator.vibrate) {
          try {
            navigator.vibrate(10);
          } catch {}
        }
      }
    });
  }, []);

  const cleanupRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRecSeconds(0);

    if (moveRafRef.current) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }

    const rec = recorderRef.current;
    recorderRef.current = null;

    const st = streamRef.current;
    streamRef.current = null;
    try {
      st?.getTracks?.().forEach((t) => t.stop());
    } catch {}

    chunksRef.current = [];
    cancelRef.current = false;
    isRecordingRef.current = false;

    activePointerIdRef.current = null;
    startXRef.current = null;

    setIsRecording(false);
    setDragX(0);
    setIsSwipeCancel(false);

    // снимаем ВСЕ обработчики
    window.removeEventListener("pointerup", onGlobalPointerUp, true);
    window.removeEventListener("pointercancel", onGlobalPointerUp, true);
    window.removeEventListener("pointermove", onGlobalPointerMove, true);

    window.removeEventListener("mouseup", onGlobalMouseUp, true);
    window.removeEventListener("mousemove", onGlobalPointerMove, true);

    window.removeEventListener("touchend", onGlobalTouchEnd, true);
    window.removeEventListener("touchcancel", onGlobalTouchEnd, true);
    window.removeEventListener("touchmove", onGlobalPointerMove, true);
  }, [onGlobalPointerUp, onGlobalMouseUp, onGlobalTouchEnd, onGlobalPointerMove]);

  const cancelRecording = useCallback(() => {
    cancelRef.current = true; // явно отменяем
    setIsSwipeCancel(true);
    stopRecordingSend();
  }, [stopRecordingSend]);

  const startRecording = useCallback(
    async (ev) => {
      if (isUploading || isRecordingRef.current) return;

      if (!navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        alert("Запись голосовых не поддерживается в вашем браузере.");
        return;
      }

      // swipe init
      startXRef.current = getClientX(ev);
      setDragX(0);
      setIsSwipeCancel(false);
      cancelRef.current = false;

      // pointer capture (если есть)
      if (ev && typeof ev.pointerId === "number") {
        activePointerIdRef.current = ev.pointerId;
        try {
          ev.currentTarget?.setPointerCapture?.(ev.pointerId);
        } catch {}
      } else {
        activePointerIdRef.current = null;
      }

      try {
        chunksRef.current = [];

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        const mimeType = preferMimeType();
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = rec;

        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };

        rec.onstop = async () => {
          const cancelled = !!cancelRef.current;

          const type = rec.mimeType || mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type });

          cleanupRecording();
          if (cancelled) return;

          const isMp4 = (type || "").includes("mp4");
          const ext = isMp4 ? "m4a" : "webm";
          const file = new File([blob], `voice-${Date.now()}.${ext}`, { type });

          const result = await sendWithMessage({
            chatId: currentChat.id,
            tripId: currentChat.trip_id,
            userId: myUserId,
            text: "",
            files: [file],
          });

          if (result) onMessageSent?.(result);
        };

        rec.start(200);

        // ✅ важно: ref ставим сразу
        isRecordingRef.current = true;
        setIsRecording(true);

        // таймер
        const startedAt = Date.now();
        timerRef.current = setInterval(() => {
          setRecSeconds(Math.floor((Date.now() - startedAt) / 1000));
        }, 250);

        // ✅ отпускание + движение (capture)
        window.addEventListener("pointerup", onGlobalPointerUp, true);
        window.addEventListener("pointercancel", onGlobalPointerUp, true);
        window.addEventListener("pointermove", onGlobalPointerMove, true);

        // fallback
        window.addEventListener("mouseup", onGlobalMouseUp, true);
        window.addEventListener("mousemove", onGlobalPointerMove, true);

        window.addEventListener("touchend", onGlobalTouchEnd, true);
        window.addEventListener("touchcancel", onGlobalTouchEnd, true);
        window.addEventListener("touchmove", onGlobalPointerMove, true);
      } catch (e) {
        console.error("Voice record error:", e);
        alert("Не удалось начать запись. Проверьте доступ к микрофону.");
        cleanupRecording();
      }
    },
    [
      isUploading,
      cleanupRecording,
      onGlobalPointerUp,
      onGlobalPointerMove,
      onGlobalMouseUp,
      onGlobalTouchEnd,
      sendWithMessage,
      currentChat,
      myUserId,
      onMessageSent,
      focusInput,
    ]
  );

  // если компонент размонтировали — подчистить запись
  useEffect(() => {
    return () => cleanupRecording();
  }, [cleanupRecording]);

  return (
    <>
      <div className={styles.chatInputRow}>
        {!isRecording ? (
          <input
            ref={inputRef}
            type="text"
            placeholder="Введите сообщение..."
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            className={styles.chatInput}
          />
        ) : (
          <div
            className={styles.chatInput}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "#fff",
              border: "1px solid #e2e8f0",
              transform: `translateX(${dragX}px)`,
              transition: "transform 0.06s linear",
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: isSwipeCancel ? "#111827" : "#ef4444",
                flex: "0 0 auto",
              }}
            />
            <span style={{ fontSize: 14, color: "#111827", fontWeight: 600 }}>
              {isSwipeCancel
                ? "🗑 Отпустите — отмена"
                : `Запись ${fmtTime(recSeconds)} · потяните влево для отмены`}
            </span>

            {/* запасной вариант отмены */}
            <button
              type="button"
              onClick={cancelRecording}
              title="Отменить"
              aria-label="Отменить"
              style={{
                marginLeft: "auto",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 18,
                lineHeight: 1,
                color: "#ef4444",
                padding: "2px 6px",
              }}
            >
              ✕
            </button>
          </div>
        )}

<button
  type="button"
  className={styles.pmIconButton}
  onPointerDown={(e) => e.preventDefault()}  // ✅ не роняем фокус инпута
  onMouseDown={(e) => e.preventDefault()}
  onClick={() => fileInputRef.current?.click()}
  title="Прикрепить файлы"
  disabled={isUploading || isRecording}
>
          <img src="/skr.svg" alt="" style={{ width: 20, height: 20 }} />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => {
            onPickFiles?.(e);
            focusInput();
          }}
          style={{ display: "none" }}
          accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,audio/*"
        />

        {canSend ? (
          // SEND
          <button
  type="button"
  onPointerDown={(e) => e.preventDefault()}  // ✅ инпут остаётся в фокусе, клава не мигает
  onMouseDown={(e) => e.preventDefault()}
  onClick={handleSend}
  className={styles.sendButton}
  disabled={isUploading || isRecording}
            title={isUploading ? "Отправка..." : "Отправить"}
            aria-label={isUploading ? "Отправка..." : "Отправить"}
            style={{
              width: 40,
              height: 36,
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              flex: "0 0 auto",
            }}
          >
            {isUploading ? (
              <span style={{ fontSize: 12 }}>…</span>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M3 11.5L21 3l-8.5 18-2.5-7L3 11.5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <path
                  d="M21 3l-11 11"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        ) : (
          // MIC (hold)
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              startRecording(e);
            }}
            className={styles.sendButton}
            disabled={isUploading || isRecording}
            title="Зажмите для записи"
            aria-label="Зажмите для записи"
            style={{
              width: 40,
              height: 36,
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              flex: "0 0 auto",
              background: isRecording ? "#ef4444" : undefined,
              touchAction: "none",
              userSelect: "none",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M19 11a7 7 0 0 1-14 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M12 18v3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M8 21h8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>

      {!!pendingFiles?.length && (
        <div style={{ padding: "8px 20px", display: "flex", flexWrap: "wrap", gap: 8 }}>
          {pendingFiles.map((f, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "#f3f4f6",
                borderRadius: 8,
                padding: "4px 8px",
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  maxWidth: 220,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {f.name}
              </span>
              <button
                type="button"
                onClick={() => {
                  removePending?.(i);
                  focusInput();
                }}
                title="Убрать"
                style={{ border: "none", background: "transparent", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
