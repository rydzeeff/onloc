// features/messages/components/ReadReceipts.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Отрисовывает:
 *  - до 5 аватарок прочитавших + "+N"
 *  - по клику — поповер со списком "Прочитали / Не прочитали"
 *
 * props:
 *  - message: { id, user_id, chat_message_reads?: [{ user_id, read_at }], ... }
 *  - participantsUserIds?: string[]  // полный список участников чата
 *  - profilesMap?: { [user_id]: { first_name, last_name, avatar_url, phone? } }
 *  - myId?: string
 *  - onAvatarClick?: (userId) => void
 *  - onStartDm?: (userId) => void     // открыть ЛС (опционально)
 *  - onCall?: (userId) => void        // звонок (опционально)
 *  - align?: "left" | "right"         // выравнивание поповера, по умолчанию "right"
 */
export default function ReadReceipts({
  message,
  participantsUserIds = [],
  profilesMap = null,
  myId = null,
  onAvatarClick,
  onStartDm,
  onCall,
  align = "right",
}) {
  const containerRef = useRef(null);
  const [open, setOpen] = useState(false);

  // читатели (включая автора сообщения — исключим ниже)
  const rawReaders = Array.isArray(message?.chat_message_reads) ? message.chat_message_reads : [];
  const readersSet = useMemo(() => new Set(rawReaders.map((r) => r.user_id)), [rawReaders]);

  // все участники, которых имеет смысл учитывать (без автора сообщения)
  const audience = useMemo(() => {
    const set = new Set(participantsUserIds);
    set.delete?.(message.user_id);
    // на некоторых ранних экранах нет списка участников — тогда fallback по читателям
    if (set.size === 0 && rawReaders.length) {
      return Array.from(readersSet).filter((uid) => uid !== message.user_id);
    }
    return Array.from(set);
  }, [participantsUserIds, message.user_id, rawReaders, readersSet]);

  const readers = useMemo(
    () => audience.filter((uid) => readersSet.has(uid)),
    [audience, readersSet]
  );
  const nonReaders = useMemo(
    () => audience.filter((uid) => !readersSet.has(uid)),
    [audience, readersSet]
  );

  const topReaders = readers.slice(0, 5);
  const restCount = Math.max(0, readers.length - topReaders.length);

  // Закрытие по клику вне
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const getName = (uid) => {
    const p = profilesMap?.[uid];
    const full = `${p?.first_name || ""} ${p?.last_name || ""}`.trim();
    return full || uid;
  };

  const getAvatar = (uid) => profilesMap?.[uid]?.avatar_url || "/default-avatar.png";

  const Badge = ({ children, title, onClick }) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="ml-1 text-[11px] px-1 py-[1px] rounded-full bg-neutral-200 text-neutral-700 hover:bg-neutral-300 transition"
    >
      {children}
    </button>
  );

  const ActionBtn = ({ label, onClick }) => (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] px-2 py-1 rounded-md bg-neutral-100 hover:bg-neutral-200 text-neutral-800 transition"
    >
      {label}
    </button>
  );

  // Если некого показывать — ничего не рисуем
  if (audience.length === 0 || readers.length === 0) return null;

  return (
    <div ref={containerRef} className="mt-1 flex items-center justify-end gap-1 select-none">
      {/* inline аватары (до 5) */}
      {topReaders.map((uid) => {
        const title = getName(uid);
        const src = getAvatar(uid);
        return (
          <img
            key={`${message.id}:reader:${uid}`}
            src={src}
            alt={title}
            title={title}
            className="w-4 h-4 rounded-full border border-white shadow-sm cursor-pointer"
            onClick={() => onAvatarClick?.(uid)}
          />
        );
      })}

      {/* +N — кликабельный бейдж */}
      {restCount > 0 && (
        <Badge title={`Показать всех (${readers.length})`} onClick={() => setOpen((v) => !v)}>
          +{restCount}
        </Badge>
      )}
      {/* Если читателей ≤ 5 — тоже даём возможность раскрыть полный список по клику на любую аватарку */}
      {restCount === 0 && readers.length > 0 && (
        <Badge title="Показать всех" onClick={() => setOpen((v) => !v)}>
          {readers.length}
        </Badge>
      )}

      {/* Поповер */}
      {open && (
        <div
          className={`absolute z-50 mt-6 w-72 rounded-2xl shadow-xl border border-neutral-200 bg-white p-3 ${
            align === "left" ? "left-0" : "right-0"
          }`}
        >
          <div className="text-[12px] text-neutral-500 mb-2">
            Сообщение #{message.id}
          </div>

          {/* Блок "Прочитали" */}
          <div>
            <div className="text-[12px] font-medium text-neutral-700 mb-1">
              Прочитали <span className="text-neutral-400">({readers.length})</span>
            </div>
            <ul className="max-h-44 overflow-y-auto pr-1 space-y-1">
              {readers.map((uid) => (
                <li key={`read:${uid}`} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <img
                      src={getAvatar(uid)}
                      alt={getName(uid)}
                      className="w-6 h-6 rounded-full border border-neutral-200"
                    />
                    <div className="text-[13px] text-neutral-800 truncate max-w-[9.5rem]" title={getName(uid)}>
                      {getName(uid)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {onStartDm && <ActionBtn label="ЛС" onClick={() => onStartDm(uid)} />}
                    {onCall && <ActionBtn label="Позвонить" onClick={() => onCall(uid)} />}
                  </div>
                </li>
              ))}
              {readers.length === 0 && (
                <li className="text-[12px] text-neutral-500 py-1">Пока пусто</li>
              )}
            </ul>
          </div>

          {/* Разделитель */}
          <div className="my-2 h-px bg-neutral-200" />

          {/* Блок "Не прочитали" */}
          <div>
            <div className="text-[12px] font-medium text-neutral-700 mb-1">
              Не прочитали <span className="text-neutral-400">({nonReaders.length})</span>
            </div>
            <ul className="max-h-44 overflow-y-auto pr-1 space-y-1">
              {nonReaders.map((uid) => (
                <li key={`unread:${uid}`} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <img
                      src={getAvatar(uid)}
                      alt={getName(uid)}
                      className="w-6 h-6 rounded-full border border-neutral-200 opacity-60"
                    />
                    <div className="text-[13px] text-neutral-700 truncate max-w-[9.5rem]" title={getName(uid)}>
                      {getName(uid)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {onStartDm && <ActionBtn label="ЛС" onClick={() => onStartDm(uid)} />}
                    {onCall && <ActionBtn label="Позвонить" onClick={() => onCall(uid)} />}
                  </div>
                </li>
              ))}
              {nonReaders.length === 0 && (
                <li className="text-[12px] text-neutral-500 py-1">Все прочитали</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
