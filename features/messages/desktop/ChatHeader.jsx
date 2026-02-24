import React, { useMemo } from "react";
import { getOtherParticipantId } from "../utils/chatUtils";

/**
 * Header справа (PC) и в оверлее (Mobile).
 * - Для групповых чатов показывает кнопку "Участники" (toggle).
 * - Аватар: у групп — фото поездки, у ЛС — аватар собеседника, у поддержки — дефолт.
 */
export default function ChatHeader({
  currentChat,
  tripsMap,
  profilesMap,
  myUserId,
  titleString,
  participantsVisible,
  setParticipantsVisible,
  styles,
}) {
  const avatarSrc = useMemo(() => {
    if (!currentChat) return "/avatar-default.svg";

    // поддержка / редактирование компании / диспут — фикс-обложка
    if (
      currentChat.chat_type === "support" ||
      currentChat.chat_type === "company_edit" ||
      currentChat.chat_type === "dispute"
    ) {
      return "/default-travel-image.png";
    }

    // групповой чат: фото поездки (если есть)
    if (currentChat.is_group) {
      return currentChat?.trip_id
        ? tripsMap?.[currentChat.trip_id]?.image_urls?.[0] || "/default-travel-image.png"
        : "/default-travel-image.png";
    }

    // личный чат: аватар собеседника
    const otherId = getOtherParticipantId(currentChat, myUserId);
    const other = otherId ? profilesMap?.[otherId] : null;
    return other?.avatar_url || "/avatar-default.svg";
  }, [currentChat, tripsMap, profilesMap, myUserId]);

  const subtitle =
    currentChat?.chat_type === "support" || currentChat?.chat_type === "company_edit"
      ? "Чат с поддержкой"
      : currentChat?.chat_type === "dispute"
      ? "Диспут по поездке"
      : currentChat?.is_group
      ? "Групповой чат поездки"
      : "Личный чат";

  const participantsCount = Array.isArray(currentChat?.participantsUserIds)
    ? currentChat.participantsUserIds.length
    : null;

  return (
    <div
      className={styles.chatHeader}
      style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}
    >
      <img src={avatarSrc} alt="Avatar" className={styles.chatAvatar} />

      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={titleString}
        >
          {titleString}
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{subtitle}</div>
      </div>

      {currentChat?.is_group && typeof setParticipantsVisible === "function" && (
        <button
          type="button"
          onClick={() => setParticipantsVisible((v) => !v)}
          style={{
            marginLeft: "auto",
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            padding: "6px 10px",
            cursor: "pointer",
            background: "white",
            flex: "0 0 auto",
            whiteSpace: "nowrap",
          }}
          title="Показать / скрыть состав участников"
        >
          {participantsVisible
            ? "Скрыть участников"
            : `Участники${typeof participantsCount === "number" ? ` (${participantsCount})` : ""}`}
        </button>
      )}
    </div>
  );
}
