import React from "react";

function ArchiveIcon({ size = 28, color = "currentColor" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      <path d="M4 7h16" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M6 7v13h12V7" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <path d="M10 11h4" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M6 7l1-3h10l1 3" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export default function ChatTabsAndSearch({
  activeTab,
  setActiveTab,
  search,
  setSearch,
  tabCounts,
  unreadByTab = { active: 0, support: 0, archived: 0 },
  styles,
  commonStyles,
}) {
  const supUnread = unreadByTab.support || 0;
  const actUnread = unreadByTab.active || 0;
  const arcUnread = unreadByTab.archived || 0;

  const tabStyles = {
    wrap: {
      display: "flex",
      gap: 8,
      padding: "10px 12px",
      borderBottom: "1px solid #e5e7eb",
      background: "#fff",

      width: "100%",
      boxSizing: "border-box",

      flexWrap: "nowrap",      // ✅ ширина позволяет — переносим, а не скроллим
      overflowX: "hidden",   // ✅ убираем нижний скроллбар
      overflowY: "hidden",

      // на всякий случай, если браузер всё же рисует полосу
      scrollbarWidth: "none", // Firefox
      msOverflowStyle: "none", // IE/Edge legacy
    },

    btn: (isActive) => ({
      cursor: "pointer",
      border: "1px solid " + (isActive ? "#3b82f6" : "#e5e7eb"),
      background: isActive ? "#eff6ff" : "#fff",
      color: isActive ? "#1d4ed8" : "#111827",
      borderRadius: 10,

      padding: "8px 12px",
      fontSize: 14,
      fontWeight: 700,
      lineHeight: "18px",

      userSelect: "none",
      display: "inline-flex",
      alignItems: "center",
      gap: 8,

      flex: "0 0 auto",
      whiteSpace: "nowrap",
      boxSizing: "border-box",
      position: "relative",
    }),

    // ✅ Бейдж через flex, чтобы цифра всегда была по центру
    badge: {
      position: "absolute",
      top: -7,
      right: -7,
      minWidth: 18,
      height: 18,
      padding: "0 6px",
      borderRadius: 999,
      background: "#ef4444",
      color: "#fff",
      fontSize: 11,
      fontWeight: 800,
      border: "2px solid #fff",
      boxSizing: "border-box",

      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      lineHeight: 1, // ✅ не даём text baseline утянуть вниз
    },

    // Архивные: плитка-иконка
    archiveBtn: (isActive) => ({
      cursor: "pointer",
      border: "1px solid " + (isActive ? "#3b82f6" : "#e5e7eb"),
      background: isActive ? "#eff6ff" : "#fff",
      color: isActive ? "#1d4ed8" : "#111827",
      borderRadius: 10,

      padding: 0,
      userSelect: "none",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flex: "0 0 auto",
      boxSizing: "border-box",
      position: "relative",

      width: 48,
      height: 38,
    }),

    archiveInner: {
      position: "relative",
      width: 30,
      height: 30,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
    },

    // ✅ Чёрная цифра внутри иконки (без кружка)
    archiveUnreadText: {
      position: "absolute",
      left: "50%",
      top: "52%",
      transform: "translate(-60%, -50%) translateY(3px)",
      fontSize: 11,
      fontWeight: 900,
      lineHeight: 1,
      color: "#111827", // ✅ чёрный
      pointerEvents: "none",
    },
  };

  // скрыть webkit-скроллбар (если вдруг появится)
  // (inline-стиль для ::-webkit-scrollbar невозможен, но у нас overflowX hidden, этого достаточно)

  const renderBadge = (n, title = "Непрочитанные") => {
    if (!n || n <= 0) return null;
    return (
      <span style={tabStyles.badge} title={title}>
        {n > 99 ? "99+" : n}
      </span>
    );
  };

  const renderArchiveInsideUnread = (n) => {
    if (!n || n <= 0) return null;
    const label = n > 99 ? "99+" : String(n);
    return <span style={tabStyles.archiveUnreadText}>{label}</span>;
  };

  return (
    <>
      <div style={tabStyles.wrap}>
        <button
          type="button"
          style={tabStyles.btn(activeTab === "active")}
          onClick={() => setActiveTab("active")}
        >
          <span>Активные{tabCounts.active ? ` (${tabCounts.active})` : ""}</span>
          {renderBadge(actUnread, "Есть непрочитанные")}
        </button>

        <button
          type="button"
          style={tabStyles.btn(activeTab === "support")}
          onClick={() => setActiveTab("support")}
        >
          <span>Поддержка{tabCounts.support ? ` (${tabCounts.support})` : ""}</span>
          {renderBadge(supUnread, "Есть новые сообщения")}
        </button>

        <button
          type="button"
          style={tabStyles.archiveBtn(activeTab === "archived")}
          onClick={() => setActiveTab("archived")}
          title="Архивные чаты"
          aria-label="Архивные чаты"
        >
          <span style={tabStyles.archiveInner}>
            {/* ✅ при непрочитанных красим иконку */}
            <ArchiveIcon size={30} color={arcUnread > 0 ? "#ef4444" : "currentColor"} />
            {/* ✅ и пишем чёрное число внутри */}
            {renderArchiveInsideUnread(arcUnread)}
          </span>
        </button>
      </div>

      <div className={commonStyles.searchBar}>
        <div className={commonStyles.searchWrap}>
          <span className={commonStyles.searchIcon} />
          <input
            type="text"
            placeholder="Поиск по чатам"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${commonStyles.searchInput} ${commonStyles.searchInputWithIcon}`}
          />
        </div>
      </div>
    </>
  );
}
