// features/messages/desktop/ChatList.jsx
import React from "react";
import ParticipantsCollapse from "./ParticipantsCollapse";
import { getOrganizerId, getOtherParticipantId } from "../utils/chatUtils";

export default function ChatList({
  filteredChats = [],
  tripsMap,
  profilesMap,
  unreadCount = {},
  currentChat,
  selectedListChatId,
  expandedChats,
  dmUnreadByTrip = {},
  dmHighlightMap = {},
  setDmHighlightMap,
  myUserId,
  onOpenChat,
  onToggleExpand,
  styles,

  // NEW
  titleMaxChars,
  footerUnreadMode = "badge", // "badge" | "dot"
  chevronSize = 20,
}) {
  const truncate = (s, n) => {
    const str = String(s || "");
    if (!n || n <= 0) return str;
    return str.length > n ? str.slice(0, n) + "…" : str;
  };

  const findTripGroupChatId = (tripId) => {
    if (!tripId) return null;

    const pick = (filteredChats || []).find((c) => {
      if (c.trip_id !== tripId) return false;
      if (!c.is_group) return false;

      // основной признак
      if (c.chat_type === "trip_group") return true;

      // если тип не проставлен, но это явно "Чат поездки" — пускаем только если это НЕ диспут/поддержка/редактирование
      const t = String(c._titleString || c.title || "").toLowerCase();
      const looksLikeTripChat = t.includes("чат поездки");
      const looksLikeDispute = !!c.moderator_id || t.includes("диспут");
      const looksLikeSupport =
        !!c.support_close_requested_at || !!c.support_close_confirmed || t.includes("поддерж");
      const looksLikeCompanyEdit = t.includes("реквиз") || t.includes("компани");

      return looksLikeTripChat && !looksLikeDispute && !looksLikeSupport && !looksLikeCompanyEdit;
    });

    return pick?.id || null;
  };


  return (
    <div className={styles.chatList}>
      {filteredChats.length > 0 ? (
        filteredChats.map((chat, idx) => {
          const trip = chat.trip_id ? tripsMap[chat.trip_id] || {} : {};
          const isGroup = chat.is_group;
const isPrivate = chat.chat_type === "trip_private";

// 👇 определяем "реальный" тип даже если chat_type = archived
const titleLower = String(chat._titleString || chat.title || "").toLowerCase();

const effectiveType =
  chat.chat_type !== "archived"
    ? chat.chat_type
    : (chat.moderator_id || titleLower.includes("диспут"))
    ? "dispute"
    : (chat.support_close_requested_at ||
       chat.support_close_confirmed ||
       titleLower.includes("поддерж"))
    ? "support"
    : (titleLower.includes("реквиз") || titleLower.includes("компани"))
    ? "company_edit"
    : "archived";

const isSupport = effectiveType === "support" || effectiveType === "company_edit";
const isDispute = effectiveType === "dispute";
const isArchivedSupportLike = chat.chat_type === "archived" && !chat.is_group && !chat.trip_id;

          let thumb = "/default-travel-image.png";
          if (isGroup && trip.image_urls?.[0]) {
            thumb = trip.image_urls[0];
          } else if (isPrivate) {
            const otherId = getOtherParticipantId(chat, myUserId);
            const other = otherId ? profilesMap[otherId] : null;
            thumb = other?.avatar_url || "/avatar-default.svg";
          } else if (isSupport || isDispute) {
            thumb = "/default-travel-image.png";
          }

          const isExpanded = expandedChats.has(chat.id);
          const organizerId = getOrganizerId(chat, tripsMap);

          const dmUnreadMap = dmUnreadByTrip[chat.trip_id] || {};
          const dmUnreadSum = Object.values(dmUnreadMap).reduce((a, b) => a + b, 0);

          const participantsProfiles = (chat.participantsUserIds || [])
            .map((id) => profilesMap[id])
            .filter(Boolean)
            .sort((a, b) => {
              if (a.user_id === organizerId) return -1;
              if (b.user_id === organizerId) return 1;
              const an = `${a.last_name || ""} ${a.first_name || ""}`.trim().toLowerCase();
              const bn = `${b.last_name || ""} ${b.first_name || ""}`.trim().toLowerCase();
              return an.localeCompare(bn, "ru");
            });

          const isActive = selectedListChatId
            ? selectedListChatId === chat.id
            : currentChat && currentChat.id === chat.id;

          const unread = unreadCount?.[chat.id] || 0;

          return (
            <div key={chat.id} style={idx === 0 ? { marginTop: 4 } : undefined}>
              <div
                className={`${styles.chatItem} ${
                  unread > 0 ? styles.unreadChat : ""
                } ${isActive ? styles.activeChat : ""} ${isExpanded ? styles.chatItemOpen : ""}`}
                style={{ position: "relative" }}
              >
                <div className={styles.chatItemContent} onClick={() => onOpenChat(chat)}>
                  <img src={thumb} alt="Thumb" className={styles.chatImage} />

                  <div className={styles.chatInfo} style={{ position: "relative" }}>
                    <div className={styles.chatTitleWrapper}>
                      <span className={styles.chatTitle} data-full-title={chat._titleString}>
                        {truncate(chat._titleString, titleMaxChars)}
                      </span>
                    </div>

                    <div className={styles.chatUserInfo}>
                      {isSupport || isArchivedSupportLike
                        ? "Чат поддержки"
                        : isDispute
                        ? "Диспут"
                        : `Участников: ${chat.participantsUserIds?.length || 0}`}
                    </div>
                  </div>
                </div>

                {/* ✅ (3) Бейдж непрочитанных для группового чата — справа, отступ ~4мм */}
                {unread > 0 && (
                  <span
                    className={styles.unreadBadge}
                    style={{
                      position: "absolute",
                      top: 10,
                      right: 16, // ~4мм
                      zIndex: 5,
                    }}
                    title="Непрочитанные сообщения"
                  >
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}

                {/* ✅ (1)(2) Нижняя полоса «Состав»: слово по центру, стрелка снизу, точка справа от слова */}
                {isGroup && (
                  <div
  className={styles.footerToggle}
  role="button"
  onClick={(e) => {
    e.stopPropagation();
    onToggleExpand(chat.id, chat.trip_id);
  }}
  title="Состав участников"
>
  <div
    style={{
      width: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 1,                // ✅ меньше пустоты между “Состав” и галкой
      lineHeight: 1,
    }}
  >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, lineHeight: 1 }}>
                        <span className={styles.toggleLabel} style={{ textAlign: "center" }}>
                          Состав
                        </span>

                        {/* ✅ точка прямо справа от “Состав” */}
                        {dmUnreadSum > 0 && footerUnreadMode === "dot" && (
                          <span
                            title="Есть непрочитанные"
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: "#ef4444",
                              display: "inline-block",
                            }}
                          />
                        )}

                        {/* если вдруг захочешь цифру вместо точки */}
                        {dmUnreadSum > 0 && footerUnreadMode !== "dot" && (
                          <span className={styles.unreadBadge} style={{ marginLeft: 4 }}>
                            {dmUnreadSum}
                          </span>
                        )}
                      </div>

                      <svg
                        width={chevronSize}
                        height={chevronSize}
                        viewBox="0 0 24 24"
                        style={{
                          transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                          transition: "transform 0.15s ease",
                          opacity: 0.9,
                        }}
                        aria-hidden="true"
                      >
                        <path
                          d="M6 9l6 6 6-6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  </div>
                )}
              </div>

              {isGroup && (
                <ParticipantsCollapse
                  isExpanded={isExpanded}
                  participantsProfiles={participantsProfiles}
                  organizerId={organizerId}
                  dmHighlightUserId={dmHighlightMap[chat.id]}
                  dmUnreadMap={dmUnreadMap}
                  myUserId={myUserId}
                  onOpenPrivate={(userId) => {
  setDmHighlightMap({ [chat.id]: userId });
  onToggleExpand(chat.id, chat.trip_id, true);

  const tripGroupChatId = findTripGroupChatId(chat.trip_id) || chat.id;
  onOpenChat({
    __openDm: { tripId: chat.trip_id, userId, groupChatId: tripGroupChatId },
  });
}}
                  styles={styles}
                  chatType={effectiveType}
                  moderatorId={chat.moderator_id}
                />
              )}
            </div>
          );
        })
      ) : (
        <div className={styles.noChatSelected}>Нет чатов для отображения</div>
      )}
    </div>
  );
}
