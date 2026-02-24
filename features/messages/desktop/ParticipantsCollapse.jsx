import React from "react";

export default function ParticipantsCollapse({
  isExpanded,
  participantsProfiles = [],
  organizerId,
  dmHighlightUserId,      // id участника, выделенного для ЛС
  dmUnreadMap = {},       // { [userId]: number }
  myUserId,               // ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ (обязателен)
  onOpenPrivate,          // (userId) => void
  styles,
  // для диспутов:
  chatType,               // 'trip_group' | 'support' | 'dispute' | ...
  moderatorId,            // uuid модератора спора (для dispute)
}) {
  const isDispute = chatType === "dispute";
const isNoPmChat = ["dispute", "support", "company_edit"].includes(chatType);
  return (
    <div className={`${styles.participantsCollapse} ${isExpanded ? styles.open : ""}`}>
      <div className={styles.participantsInner}>
        {participantsProfiles.map((p) => {
          const isHighlighted = dmHighlightUserId === p.user_id;
          const dmUnread = dmUnreadMap[p.user_id] || 0;
          const isMe = p.user_id === myUserId;

          // Имя: для модератора диспута показываем «Администрация сайта»
          const baseName = `${p.last_name || ""} ${p.first_name || ""}`.trim();
          const isAdminModerator = isDispute && moderatorId && p.user_id === moderatorId;
          const displayName = isAdminModerator ? "Администрация сайта" : baseName;

          // Роль: Организатор / Администратор (для модератора диспута) / Участник
          const roleLabel =
            p.user_id === organizerId
              ? "Организатор"
              : isAdminModerator
              ? "Администратор"
              : "Участник";

          return (
            <div
              key={p.user_id}
              className={`${styles.participantRow} ${isHighlighted ? styles.highlightedParticipant : ""}`}
            >
              <img src={p.avatar_url || "/avatar-default.svg"} alt="" className={styles.participantAvatar} />
              <div className={styles.participantMain}>
                <div className={styles.participantName}>{displayName}</div>
                <div
                  className={`${styles.roleBadge} ${
                    p.user_id === organizerId ? styles.roleOrganizer : styles.roleMember
                  }`}
                >
                  {roleLabel}
                </div>
              </div>

              {/* В диспутах ЛС запрещены — скрываем кнопку */}
              {!isMe && !isNoPmChat && (
<button
  type="button"
  onClick={() => onOpenPrivate(p.user_id)}
  title="Личное сообщение"
  aria-label="Личное сообщение"
  style={{
    marginLeft: "auto",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#fff",
    cursor: "pointer",
    width: 44,
    height: 32,
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "0 0 auto",
  }}
>
  {(() => {
    const n = dmUnread || 0;
    const label = n > 99 ? "99+" : String(n);

    return (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M21 12c0 4.418-4.03 8-9 8a10.6 10.6 0 0 1-3.61-.62L3 21l1.78-4.12A7.62 7.62 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z"
          fill={n > 0 ? "#ef4444" : "none"}
          stroke={n > 0 ? "#ef4444" : "#9ca3af"}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {n > 0 ? (
          <text
            x="12"
            y="13"
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={label.length >= 3 ? "7" : "9"}
            fontWeight="700"
            fill="#ffffff"
          >
            {label}
          </text>
        ) : null}
      </svg>
    );
  })()}
</button>

              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
