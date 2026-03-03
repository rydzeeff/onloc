import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import styles from '../../styles/trip-details.mobile.module.css';
import { useTripDetails } from '../../lib/useTripDetails';
import { useAuth } from '../_app';
import { supabase } from '../../lib/supabaseClient';
import ShareButton from '../../components/ShareButton';
import { useTripAlertsCount } from '../../lib/useTripAlertsCount';
import AlertsBell from '../../components/AlertsBell';

const FROM_MARKER_ICON = '/custom-marker.png';
const TO_MARKER_ICON = '/marker-icon.png';
const DEFAULT_AVATAR = '/avatar-default.svg';

function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 't' || v === 'T';
}

function InfoIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 10.5v6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" />
    </svg>
  );
}

function UserIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20 21a8 8 0 0 0-16 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

function KeyIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7.5 14.5a4.5 4.5 0 1 1 3.9-6.7L21 7v4l-2 2v2h-2v2h-3l-2.6-2.6a4.48 4.48 0 0 1-3.9 2.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="7.5" cy="14.5" r="0.8" fill="currentColor" />
    </svg>
  );
}

function MsgIconWithCount({ count = 0, className }) {
  const n = Number(count || 0);
  const label = n > 99 ? '99+' : String(n);

  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21 12c0 4.418-4.03 8-9 8a10.6 10.6 0 0 1-3.61-.62L3 21l1.78-4.12A7.62 7.62 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z"
        fill={n > 0 ? '#ef4444' : 'none'}
        stroke={n > 0 ? '#ef4444' : '#9ca3af'}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {n > 0 ? (
        <text
          x="12"
          y="13"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={label.length >= 3 ? '7' : '9'}
          fontWeight="700"
          fill="#ffffff"
        >
          {label}
        </text>
      ) : null}
    </svg>
  );
}


export default function TripDetailsPageMobile({ tripId }) {
  const { setProcessing } = useAuth();
  const router = useRouter();
  const { id = tripId, from: fromParamRaw } = router.query || {};
  const openedFromParticipants = String(fromParamRaw || '').toLowerCase().includes('participant');

  const {
    user,
    trip,
    participants,
    message,
    modalOpen,
    organizerModalOpen,
    organizerData,
    organizerReviews,
    mainImageIndex,
    fade,

    // questionModalOpen, // отключено по задаче (как в PC)
    // newMessage,

    infoMenuOpen,
    infoSection,
    unreadMessages,
    infoButtonRef,
    statusMap,
    genderMap,
    imageUrls,
    formatDateRange,
    joinedCount,
    possibleCount,
    isUserConfirmed,

    // setQuestionModalOpen,
    // setNewMessage,

    handleJoinTrip,
    // handleSendQuestion,

    openParticipantsModal,
    closeParticipantsModal,
    openOrganizerModal,
    closeOrganizerModal,
    handleChangeMainImage,
    toggleInfoMenu,
    handleInfoSection,
    downloadDocument,
    handleMessagesClick,
    calculateAge,
    getFullName,
  } = useTripDetails({ tripId: id });

  const unreadAlerts = useTripAlertsCount(user?.id);

  const leisureTypeMap = {
    tourism: 'Туризм',
    fishing: 'Рыбалка',
    hunting: 'Охота',
  };

  // ✅ Каноническая ссылка для шеринга: в мобильной версии детальная часто открывается поверх /trips
  // и URL не меняется, поэтому собираем ссылку вручную по id.
const shareUrl = useMemo(() => {
  if (typeof window === 'undefined') return '';
  const origin = window.location.origin;
  const tid = trip?.id || id || tripId;
  const current = window.location.href;

  // если уже на /trip/<id> — отдаем текущую
  if (tid && current.includes(`/trip/${String(tid)}`)) return current;

  if (!tid) return current;

  // ✅ правильная каноническая ссылка
  return `${origin}/trip/${encodeURIComponent(String(tid))}`;
}, [trip?.id, id, tripId]);

  const difficultyMap = {
    easy: 'Легко',
    medium: 'Средне',
    hard: 'Сложно',
  };

  // --- Локальные "оверрайды": добираем поля, которых нет в RPC, и корректируем организатора ---
  const [tripExtras, setTripExtras] = useState({
    refund_policy: null,
    timezone: null,
    is_company_trip: null,
  });
  const [companyOverride, setCompanyOverride] = useState(null);
  const [companyReviewsOverride, setCompanyReviewsOverride] = useState([]);

  // ▼ Новое: модалка с полным описанием
  const [isDescOpen, setIsDescOpen] = useState(false);

  // ▼ Новое: модалка «Подтвердить присоединение»
  const [isJoinConfirmOpen, setIsJoinConfirmOpen] = useState(false);
  const [joining, setJoining] = useState(false);

// ▼ Инфо-модалки (как в trips)
const [activeInfoModal, setActiveInfoModal] = useState(null);

const openInfoModal = (type) => {
  // закрываем dropdown (если открыт)
  if (infoMenuOpen) toggleInfoMenu();
  setActiveInfoModal(type); // "contacts" | "documents"
};

const closeInfoModal = () => setActiveInfoModal(null);


// ▼ Фото: полноэкранный просмотр + свайп
const [photoViewerOpen, setPhotoViewerOpen] = useState(false);
const [photoViewerIndex, setPhotoViewerIndex] = useState(0);
const touchStartXRef = useRef(null);

const imagesCount = imageUrls?.length || 0;

const openPhotoViewer = (index = 0) => {
  const safeIndex = Math.max(0, Math.min(index, (imageUrls?.length || 1) - 1));
  setPhotoViewerIndex(safeIndex);
  setPhotoViewerOpen(true);
};

const closePhotoViewer = () => setPhotoViewerOpen(false);

const goNextPhoto = () => {
  setPhotoViewerIndex((prev) => {
    const n = imageUrls?.length || 1;
    if (n <= 1) return 0;
    return (prev + 1) % n; // зацикливание
  });
};

const goPrevPhoto = () => {
  setPhotoViewerIndex((prev) => {
    const n = imageUrls?.length || 1;
    if (n <= 1) return 0;
    return (prev - 1 + n) % n; // зацикливание
  });
};

const onViewerTouchStart = (e) => {
  touchStartXRef.current = e.touches?.[0]?.clientX ?? null;
};

const onViewerTouchEnd = (e) => {
  const startX = touchStartXRef.current;
  if (startX == null) return;

  const endX = e.changedTouches?.[0]?.clientX ?? startX;
  const dx = endX - startX;

  // порог свайпа
  if (Math.abs(dx) < 35) return;

  if (dx < 0) goNextPhoto();
  else goPrevPhoto();

  touchStartXRef.current = null;
};

// блокируем прокрутку фона, когда открыт просмотр
useEffect(() => {
  if (!photoViewerOpen) return;
  const prev = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    document.body.style.overflow = prev;
  };
}, [photoViewerOpen]);

// если список фото поменялся — держим индекс в диапазоне
useEffect(() => {
  if (!photoViewerOpen) return;
  const n = imageUrls?.length || 1;
  if (photoViewerIndex > n - 1) setPhotoViewerIndex(0);
}, [photoViewerOpen, photoViewerIndex, imageUrls]);


  // добираем refund_policy / timezone / is_company_trip если их не дал RPC
  useEffect(() => {
    let mounted = true;

    async function ensureTripExtras() {
      if (!trip?.id) return;

      const haveRefund = !!trip?.refund_policy || !!tripExtras.refund_policy;
      const haveTZ = !!trip?.timezone || !!tripExtras.timezone;
      const haveFlag =
        typeof trip?.is_company_trip === 'boolean' || tripExtras.is_company_trip !== null;

      if (haveRefund && haveTZ && haveFlag) return;

      const { data, error } = await supabase
        .from('trips')
        .select('refund_policy, timezone, is_company_trip')
        .eq('id', trip.id)
        .maybeSingle();

      if (!mounted) return;
      if (error) {
        console.warn('trips extras load error:', error.message);
        return;
      }

      if (data) {
        setTripExtras((prev) => ({
          refund_policy: data.refund_policy ?? prev.refund_policy,
          timezone: data.timezone ?? prev.timezone,
          is_company_trip:
            typeof data.is_company_trip === 'boolean'
              ? data.is_company_trip
              : toBool(data.is_company_trip),
        }));
      }
    }

    ensureTripExtras();
    return () => {
      mounted = false;
    };
  }, [trip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // при открытии модала организатора проверяем реальный флаг и при необходимости подтягиваем компанию
  useEffect(() => {
    let mounted = true;

    async function ensureCompanyOrganizer() {
      if (!organizerModalOpen || !trip?.id || !trip?.creator_id) return;

      const isCompany = toBool(trip?.is_company_trip) || toBool(tripExtras?.is_company_trip);
      if (!isCompany) return;

      // если уже есть компания (в хуке или в оверрайде) — ничего не делаем
      if (companyOverride || organizerData?.type === 'company') return;

      const { data: company, error: companyErr } = await supabase
        .from('mycompany')
        .select('*')
        .eq('user_id', trip.creator_id)
        .maybeSingle();

      if (!mounted) return;
      if (companyErr) {
        console.warn('mycompany load error:', companyErr.message);
        return;
      }

      const { data: reviews, error: revErr } = await supabase
        .from('company_reviews')
        .select('rating, text, trip_id, created_at')
        .eq('organizer_id', trip.creator_id);

      if (!mounted) return;
      if (revErr) {
        console.warn('company_reviews load error:', revErr.message);
      }

      const withTitles = await Promise.all(
        (reviews || []).map(async (r) => {
          const { data: t } = await supabase
            .from('trips')
            .select('title')
            .eq('id', r.trip_id)
            .maybeSingle();
          return { ...r, trip_title: t?.title || 'Поездка' };
        })
      );

      const avg =
        reviews && reviews.length
          ? (reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length).toFixed(1)
          : '0.0';

      setCompanyOverride({ type: 'company', ...company, averageRating: avg });
      setCompanyReviewsOverride(withTitles);
    }

    ensureCompanyOrganizer();
    return () => {
      mounted = false;
    };
  }, [
    organizerModalOpen,
    trip?.id,
    trip?.creator_id,
    tripExtras?.is_company_trip,
    organizerData?.type,
    companyOverride,
  ]);

  const downloadDocumentWithLoading = async (fileName) => {
    setProcessing(true);
    try {
      await downloadDocument(fileName);
    } finally {
      setProcessing(false);
    }
  };

  const handleJoinTripWithLoading = async () => {
    setProcessing(true);
    try {
      await handleJoinTrip();
    } finally {
      setProcessing(false);
    }
  };

  // ---------- Текст/бейдж для "Возврат" ----------
  const refundInfo = useMemo(() => {
    const raw = tripExtras.refund_policy ?? trip?.refund_policy;
    const tz =
      (typeof raw === 'object' && raw?.timezone) ||
      (typeof raw === 'string' &&
        (() => {
          try {
            return JSON.parse(raw)?.timezone;
          } catch {
            return null;
          }
        })()) ||
      tripExtras.timezone ||
      trip?.timezone ||
      'UTC';

    if (!raw) {
      return {
        tag: 'Не задан',
        variant: 'none',
        lines: ['Условия возврата не указаны.'],
      };
    }

    let policy = raw;
    if (typeof raw === 'string') {
      try {
        policy = JSON.parse(raw);
      } catch {
        policy = {};
      }
    }

    const type = (policy?.type || 'custom').toLowerCase();
    const fullH = policy?.full_refunded_hours;
    const partH = policy?.partial_refunded_hours;
    const partPct = policy?.partial_refunded_percent;

    if (type === 'standard') {
      return {
        tag: 'Стандартный',
        variant: 'standard',
        lines: [
          'Стандартный возврат: за 1 час и ранее до начала — вернём 100% суммы.',
          'Менее чем за 1 час до начала — возврат не предусмотрен.',
          `Часовой пояс расчётов: ${tz}.`,
        ],
      };
    }

    const lines = [];
    if (typeof fullH === 'number') lines.push(`Полный возврат: до ${fullH} ч до начала — 100%.`);
    if (typeof partPct === 'number' && typeof partH === 'number')
      lines.push(`Частичный возврат: ${partPct}% не позднее чем за ${partH} ч до начала.`);
    lines.push(`Часовой пояс расчётов: ${tz}.`);

    return {
      tag: 'Кастомный',
      variant: 'custom',
      lines: lines.length ? lines : ['Условия кастомного возврата не заданы.'],
    };
  }, [trip?.refund_policy, tripExtras.refund_policy, tripExtras.timezone, trip?.timezone]);

  // ---- ВЫЧИСЛЕНИЯ ДЛЯ МОДАЛКИ ОРГАНИЗАТОРА (до ранних return, чтобы не нарушать порядок хуков) ----
  const isCompanyDisplay =
    toBool(tripExtras?.is_company_trip) ||
    toBool(trip?.is_company_trip) ||
    organizerData?.type === 'company' ||
    !!companyOverride;

  const companyData =
    isCompanyDisplay
      ? companyOverride || (organizerData?.type === 'company' ? organizerData : null)
      : null;

  const reviewsData = isCompanyDisplay
    ? companyReviewsOverride.length
      ? companyReviewsOverride
      : organizerReviews
    : organizerReviews;

  const okvedList = useMemo(() => {
    const src = companyData?.okveds ?? companyData?.okved ?? companyData?.okved_codes;
    if (!src) return [];
    if (Array.isArray(src)) return src.filter(Boolean).map(String);
    if (typeof src === 'string') {
      const trimmed = src.trim();
      if (trimmed === '[]') return [];
      return trimmed
        .split(/[;,|\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }, [companyData]);

  // --------- Блокирующий рендер для не-active статусов (если НЕ из участников) ---------
  if (trip) {
    const st = (trip.status || '').toLowerCase();
    if (!openedFromParticipants && st && st !== 'active') {
      const human = statusMap[st] || trip.status || 'недоступна';
      return (
        <div className={styles.container}>
          {message && <div className={styles.toast}>{message}</div>}
          <div className={styles.modalBackdrop}>
            <div className={styles.modalContent}>
              <h2 className={styles.modalTitle}>Поездка недоступна</h2>
              <p>
                Эта поездка{' '}
                {st === 'started'
                  ? 'уже началась.'
                  : st === 'finished'
                  ? 'уже завершена.'
                  : st === 'canceled'
                  ? 'отменена.'
                  : 'недоступна.'}
              </p>
              <p style={{ marginTop: 8 }}>Статус: {human}</p>
              <button
                className={styles.closeButton}
                onClick={() => router.replace('/dashboard?section=myTrips')}
              >
                Вернуться
              </button>
            </div>
          </div>
        </div>
      );
    }
  }

  if (!trip) return null;

  const description = trip.description || '';
  const preview = description.length > 160 ? `${description.slice(0, 160)}…` : description;

  const onJoinClick = () => setIsJoinConfirmOpen(true);

  const confirmJoin = async () => {
    if (joining) return;
    setJoining(true);
    try {
      await handleJoinTripWithLoading();
      setIsJoinConfirmOpen(false);
    } finally {
      setJoining(false);
    }
  };

const handleBackToTrips = () => {
  const tid = trip?.id || id || tripId;

  // ✅ определяем: пришли из /trips или открыли по прямой ссылке
  const cameFromTrips =
    typeof window !== 'undefined' && sessionStorage.getItem('navFromTrips') === '1';

  // navFromTrips нужен только один раз
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem('navFromTrips');
  }

  // ✅ сохраняем данные для центрирования карты на /trips
  if (typeof window !== 'undefined' && tid) {
    sessionStorage.setItem('focusTripId', String(tid));
    sessionStorage.setItem('forceFocusTrip', cameFromTrips ? '0' : '1');

    // пробуем сохранить координаты поездки, чтобы /trips мог центрироваться сразу
    try {
      const raw = trip?.to_location;
      const geoJson = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const coords =
        geoJson?.coordinates ? [geoJson.coordinates[1], geoJson.coordinates[0]] : null; // [lat, lon]
      if (coords) {
        sessionStorage.setItem('focusTripCoords', JSON.stringify(coords));
      }
    } catch {}
  }

  // ✅ если пришли с карты — возвращаемся ровно туда
  if (cameFromTrips && typeof window !== 'undefined' && window.history.length > 1) {
    router.back();
    return;
  }

  // ✅ если открыли по ссылке — отправляем на карту
  router.push('/trips');
};


  return (
    <div className={styles.container}>
<header className={styles.header}>
  {/* слева: кнопка "На карту" */}
  <div className={styles.headerLeft}>
    <button
      type="button"
      onClick={() => {
        if (infoMenuOpen) toggleInfoMenu();
        closeInfoModal();
        handleBackToTrips();
      }}
      className={styles.backToMapBtn}
      aria-label="На карту"
      title="На карту"
    >
      <span className={styles.backIconWrap} aria-hidden="true">
        {/* более “дорогая” стрелка: шеврон + линия */}
        <svg className={styles.backIcon} viewBox="0 0 24 24" fill="none">
          <path
            d="M10 6L4 12L10 18"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4 12H20"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </svg>
      </span>

      <span className={styles.backLabel}>На карту</span>
    </button>
  </div>

  {/* справа: твои иконки */}
  <div className={styles.authButtons}>
    {/* Сообщения */}
    <button
      type="button"
      onClick={() => {
        if (infoMenuOpen) toggleInfoMenu();
        closeInfoModal();
        handleMessagesClick();
      }}
      className={`${styles.topIconButton} ${unreadMessages > 0 ? styles.topIconUnread : ""}`}
      aria-label="Сообщения"
      title="Сообщения"
    >
      <span className={styles.topIconWrap}>
        <MsgIconWithCount count={unreadMessages} className={styles.topNavIcon} />
      </span>
    </button>

    <AlertsBell
      user={user}
      count={unreadAlerts}
      buttonClassName={`${styles.topIconButton} ${unreadAlerts > 0 ? styles.topIconUnread : ""}`}
      iconWrapClassName={styles.topIconWrap}
      iconClassName={styles.topNavIcon}
      mobileEdgeToEdge
      onBeforeOpen={() => {
        if (infoMenuOpen) toggleInfoMenu();
        closeInfoModal();
      }}
    />

    {/* Информация */}
    <div className={styles.infoWrapper} ref={infoButtonRef}>
      <button
        type="button"
        onClick={() => {
          closeInfoModal();
          toggleInfoMenu();
        }}
        className={`${styles.topIconButton} ${infoMenuOpen ? styles.topIconActive : ""}`}
        aria-label="Информация"
        title="Информация"
      >
        <span className={styles.topIconWrap}>
          <InfoIcon className={styles.topNavIcon} />
        </span>
      </button>

      {infoMenuOpen && (
        <div className={styles.infoDropdown}>
          <button
            type="button"
            className={styles.infoOption}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openInfoModal("contacts");
            }}
          >
            Контакты
          </button>

          <button
            type="button"
            className={styles.infoOption}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openInfoModal("documents");
            }}
          >
            Документы
          </button>
        </div>
      )}
    </div>

    {/* Поделиться */}
    <ShareButton
      title={trip?.title ? `Поездка: ${trip.title}` : "Поездка"}
      text="Посмотри эту поездку на Onloc"
      url={shareUrl}
      buttonClassName={styles.topIconButton}
      wrapClassName={styles.topIconWrap}
      iconClassName={styles.topNavIcon}
      onBeforeOpen={() => {
        if (infoMenuOpen) toggleInfoMenu();
        closeInfoModal();
      }}
    />

    {/* Личный кабинет / Вход */}
    {user !== undefined ? (
      user ? (
        <Link
          href={{ pathname: "/dashboard", query: { section: "myTrips" } }}
          className={styles.topIconButton}
          aria-label="Личный кабинет"
          title="Личный кабинет"
          onClick={() => {
            if (infoMenuOpen) toggleInfoMenu();
            closeInfoModal();
          }}
        >
          <span className={styles.topIconWrap}>
            <UserIcon className={styles.topNavIcon} />
          </span>
        </Link>
      ) : (
        <Link
          href="/auth"
          className={styles.topIconButton}
          aria-label="Войти"
          title="Войти"
          onClick={() => {
            if (infoMenuOpen) toggleInfoMenu();
            closeInfoModal();
          }}
        >
          <span className={styles.topIconWrap}>
            <KeyIcon className={styles.topNavIcon} />
          </span>
        </Link>
      )
    ) : null}
  </div>
</header>


      {message && <div className={styles.toast}>{message}</div>}

{activeInfoModal && (
  <div
    className={styles.infoModalOverlay}
    onClick={closeInfoModal}
    role="dialog"
    aria-modal="true"
  >
    <div className={styles.infoModalCard} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={styles.infoModalClose} onClick={closeInfoModal}>
        ×
      </button>

      <div className={styles.infoModalTitle}>
        {activeInfoModal === "contacts" ? "Контакты" : "Документы"}
      </div>

      {activeInfoModal === "contacts" && (
        <div className={styles.companyCard}>
          <h3>Контакты</h3>
          <p><strong>Наименование:</strong> ИП Рудзеев А.А.</p>
          <p><strong>ИНН:</strong> 890406173302</p>
          <p><strong>ОГРНИП:</strong> 321890100018240</p>
          <p><strong>Адрес:</strong> ЯНАО, г. Новый Уренгой</p>
          <p><strong>e-mail:</strong> info@itc89.ru, info@gkkot.ru</p>
        </div>
      )}

      {activeInfoModal === "documents" && (
        <div className={styles.documentsCard}>
          <h3>Документы</h3>
          <button
            onClick={() => downloadDocumentWithLoading("tbank_contract.pdf")}
            className={styles.documentLink}
          >
            Договор Т-банк
          </button>
          <button
            onClick={() => downloadDocumentWithLoading("platform_contract.pdf")}
            className={styles.documentLink}
          >
            Договор Площадка
          </button>
        </div>
      )}
    </div>
  </div>
)}


      <div className={styles.mainContent}>
        <div className={styles.imageSection}>
          {imageUrls.length > 0 && (
            <div className={styles.mainImageContainer}>
              <img
  src={imageUrls[mainImageIndex]}
  alt={`${trip.title} main photo`}
  className={styles.mainImage}
  style={{ opacity: fade ? 1 : 0 }}
  onClick={() => openPhotoViewer(mainImageIndex)}
/>

            </div>
          )}

          <div className={styles.thumbnailGrid}>
            {imageUrls.map((url, index) => (
              <div key={index} className={styles.thumbnailWrapper}>
                <img
                  src={url}
                  alt={`${trip.title} thumbnail ${index}`}
                  className={styles.thumbnail}
                  onClick={() => {
  handleChangeMainImage(index);
  openPhotoViewer(index);
}}
                />
              </div>
            ))}
          </div>
        </div>

        <div className={styles.infoSection}>
          <h1 className={styles.tripTitle}>{trip.title}</h1>

          {/* Цена/дата/описание */}
          <div className={styles.infoCard}>
            <p className={styles.price}>
              Цена: <span className={styles.highlight}>{trip.price} ₽</span>
            </p>
            <p className={styles.date}>
              Дата: <span className={styles.highlight}>{formatDateRange}</span>
            </p>

            <div style={{ marginTop: 8 }}>
              <p className={styles.description} title={description}>
                Описание: {preview}
              </p>

              {description && description.length > 0 && (
                <button
                  type="button"
                  onClick={() => setIsDescOpen(true)}
                  className={styles.button}
                  style={{ marginTop: 6, width: '100%' }}
                >
                  Показать всё
                </button>
              )}
            </div>
          </div>

          {/* Возврат */}
          <div className={styles.infoCard} style={{ marginTop: 10 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16 }}>Возврат</h3>
              <span
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  background:
                    refundInfo.variant === 'standard'
                      ? 'rgba(76,175,80,0.15)'
                      : refundInfo.variant === 'custom'
                      ? 'rgba(255,152,0,0.15)'
                      : 'rgba(0,0,0,0.08)',
                }}
              >
                {refundInfo.tag}
              </span>
            </div>

            <ul style={{ marginTop: 10, paddingLeft: 18, marginBottom: 0, lineHeight: 1.35 }}>
              {refundInfo.lines.map((line, i) => (
                <li key={i} style={{ marginBottom: 6 }}>
                  {line}
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.buttonGroup}>
<button className={`${styles.actionButton} ${styles.joinButton}`} onClick={onJoinClick}>
  Присоединиться
</button>
            {/* Как в PC: «Задать вопрос» временно отключено */}
            <button className={styles.actionButton} onClick={openParticipantsModal}>
              Участники: {joinedCount} / {possibleCount}
            </button>
            <button className={styles.actionButton} onClick={openOrganizerModal}>
              Организатор
            </button>
          </div>

          <div className={styles.mapLegend}>
            <div className={styles.legendItem}>
              <span>Откуда:</span>
              <img src={FROM_MARKER_ICON} alt="From marker" className={styles.markerIcon} />
            </div>
            <div className={styles.legendItem}>
              <span>Куда:</span>
              <img src={TO_MARKER_ICON} alt="To marker" className={styles.markerIcon} />
            </div>
          </div>

          <div id="map" className={styles.mapContainer}></div>

          <div className={styles.infoRow}>
            <div className={styles.infoTile}>
              <p>
                Тип отдыха:{' '}
                <span className={styles.highlight}>
                  {leisureTypeMap[trip.leisure_type] || trip.leisure_type}
                </span>
              </p>
            </div>
            <div className={styles.infoTile}>
              <p>
                Возраст: <span className={styles.highlight}>{trip.age_from} – {trip.age_to}</span>
              </p>
            </div>
            <div className={styles.infoTile}>
              <p>
                Сложность:{' '}
                <span className={styles.highlight}>
                  {difficultyMap[trip.difficulty] || trip.difficulty}
                </span>
              </p>
            </div>
            <div className={styles.infoTile}>
              <p>
                Алкоголь:{' '}
                <span className={styles.highlight}>{trip.alcohol_allowed ? 'Да' : 'Нет'}</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Модал «Описание» — окно с полным текстом */}
      {/* Модал «Описание» — удобный вертикальный скролл внутри */}
{isDescOpen && (
  <div
    className={styles.modalBackdrop}
    onClick={() => setIsDescOpen(false)}
    style={{ backdropFilter: 'blur(2px)', animation: 'fadeIn .12s ease-out' }}
  >
    <div
      className={`${styles.modalContent} ${styles.descModalContent}`}
      onClick={(e) => e.stopPropagation()}
      style={{
        width: 'calc(100% - 24px)',
        maxWidth: 680,
        transformOrigin: 'bottom center',
        animation: 'popIn .12s ease-out',
      }}
    >
      <div className={styles.descModalHeader}>
        <h2 className={styles.modalTitle} style={{ margin: 0 }}>
          Полное описание
        </h2>

        <button
          type="button"
          className={styles.descModalX}
          onClick={() => setIsDescOpen(false)}
          aria-label="Закрыть"
        >
          ✕
        </button>
      </div>

      <div className={styles.descModalBody}>
        {description}
      </div>

      <div className={styles.descModalFooter}>
        <button
          type="button"
          className={styles.descModalClose}
          onClick={() => setIsDescOpen(false)}
        >
          Закрыть
        </button>
      </div>
    </div>
  </div>
)}


      {/* Модал «Подтвердить присоединение» */}
      {isJoinConfirmOpen && (
        <div
          className={styles.modalBackdrop}
          onClick={() => !joining && setIsJoinConfirmOpen(false)}
          style={{ backdropFilter: 'blur(2px)', animation: 'fadeIn .12s ease-out' }}
        >
          <div
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'calc(100% - 24px)',
              maxWidth: 440,
              transformOrigin: 'bottom center',
              animation: 'popIn .12s ease-out',
            }}
          >
            <h2 className={styles.modalTitle} style={{ marginTop: 0 }}>
              Присоединиться к поездке?
            </h2>
            <div style={{ marginTop: 8 }}>
              После подтверждения вы появитесь в списке участников. Продолжить?
            </div>

<div className={styles.joinConfirmActions}>
  <button
    className={`${styles.actionButton} ${styles.joinConfirmYes}`}
    onClick={confirmJoin}
    disabled={joining}
  >
    {joining ? 'Присоединяем…' : 'Да'}
  </button>

  <button
    className={`${styles.actionButton} ${styles.joinConfirmNo}`}
    onClick={() => setIsJoinConfirmOpen(false)}
    disabled={joining}
  >
    Нет
  </button>
</div>
          </div>
        </div>
      )}

      {/* Модал «Участники» */}
      {modalOpen && (
        <div
          className={styles.modalBackdrop}
          onClick={closeParticipantsModal}
          style={{ backdropFilter: 'blur(2px)', animation: 'fadeIn .12s ease-out' }}
        >
          <div
            className={`${styles.modalContent} ${styles.participantsModalContent}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Список участников"
            style={{
              width: 'calc(100% - 24px)',
              maxWidth: 680,
              transformOrigin: 'bottom center',
              animation: 'popIn .12s ease-out',
            }}
          >
            <div className={styles.descModalHeader}>
              <h2 className={styles.modalTitle} style={{ margin: 0 }}>
                Участники
              </h2>
              <button
                type="button"
                className={styles.descModalX}
                onClick={closeParticipantsModal}
                aria-label="Закрыть список участников"
              >
                ✕
              </button>
            </div>

            <div className={styles.participantsModalBody}>
              {participants.length === 0 ? (
                <div className={styles.noParticipants}>Нет участников</div>
              ) : (
                <div className={styles.participantsList}>
                  {participants.map((p) => (
                    <div key={p.id} className={styles.participantCard}>
                      <img
                        src={p.avatar_url || DEFAULT_AVATAR}
                        alt={`${getFullName(p)}'s avatar`}
                        className={styles.avatar}
                      />
                      <div className={styles.participantInfo}>
                        <p>
                          <strong>ФИО:</strong> {getFullName(p)}
                        </p>
                        <p>
                          <strong>Возраст:</strong> {calculateAge(p.birth_date)}
                        </p>
                        <p>
                          <strong>Пол:</strong> {genderMap[p.gender?.toLowerCase()] || 'Не указан'}
                        </p>
                        <p>
                          <strong>Рейтинг:</strong> {p.average_rating?.toFixed(1) || '0.0'}
                        </p>
                        <p>
                          <strong>Статус:</strong>{' '}
                          {statusMap[(p.status || '').toLowerCase()] || p.status}
                        </p>
                        <p>
                          <strong>Дата:</strong>{' '}
                          {p.joined_at
                            ? new Date(p.joined_at).toLocaleString('ru', {
                                day: '2-digit',
                                month: '2-digit',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : 'Не указано'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.descModalFooter}>
              <button type="button" className={styles.descModalClose} onClick={closeParticipantsModal}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

{photoViewerOpen && (
  <div className={styles.photoViewerBackdrop} onClick={closePhotoViewer}>
    <div
      className={styles.photoViewerInner}
      onClick={(e) => e.stopPropagation()}
      onTouchStart={onViewerTouchStart}
      onTouchEnd={onViewerTouchEnd}
    >
      <img
        src={imageUrls[photoViewerIndex]}
        alt="Фото поездки"
        className={styles.photoViewerImage}
        draggable={false}
      />

      <button className={styles.photoViewerClose} onClick={closePhotoViewer} aria-label="Закрыть">
        ✕
      </button>

      {/* стрелки можно показать только если фото > 1, но свайп работает всегда */}
      {imagesCount > 1 && (
        <>
          <button
            className={styles.photoViewerPrev}
            onClick={(e) => {
              e.stopPropagation();
              goPrevPhoto();
            }}
            aria-label="Предыдущее фото"
          >
            ‹
          </button>
          <button
            className={styles.photoViewerNext}
            onClick={(e) => {
              e.stopPropagation();
              goNextPhoto();
            }}
            aria-label="Следующее фото"
          >
            ›
          </button>
          <div className={styles.photoViewerCounter}>
            {photoViewerIndex + 1}/{imagesCount}
          </div>
        </>
      )}
    </div>
  </div>
)}

      {/* Модал «Организатор» — если поездка от компании, всегда показываем карточку компании */}
      {organizerModalOpen && (organizerData || companyOverride) && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modalContent}>
            <h2 className={styles.modalTitle}>
              {isCompanyDisplay ? 'Компания-организатор' : 'Физическое лицо'}
            </h2>

            {isCompanyDisplay ? (
              <div className={styles.organizerCard}>
                <div className={styles.organizerHeader}>
                  {companyData?.avatar_url ? (
                    <img
                      src={companyData.avatar_url}
                      alt="Company avatar"
                      className={styles.organizerAvatar}
                    />
                  ) : (
                    <div className={styles.avatarPlaceholder}>🏢</div>
                  )}
                  <div>
                    <h3>{companyData?.name || 'Название компании не указано'}</h3>
                    <p>
                      <strong>Средний рейтинг:</strong> {companyData?.averageRating || '0.0'} ⭐
                    </p>
                  </div>
                </div>

                <div className={styles.organizerDetails}>
                  <p>
                    <strong>ИНН:</strong> {companyData?.inn || '—'}
                  </p>
                  <p>
                    <strong>КПП:</strong> {companyData?.kpp || '—'}
                  </p>
                  <p>
                    <strong>ОГРН:</strong> {companyData?.ogrn || '—'}
                  </p>
                  <p>
                    <strong>Руководитель:</strong> {companyData?.leader || '—'}
                  </p>
                  <p>
                    <strong>Юридический адрес:</strong> {companyData?.legal_address || '—'}
                  </p>
                  <p>
                    <strong>Телефон:</strong> {companyData?.phone || '—'}
                  </p>

                  <div style={{ marginTop: 8 }}>
                    <p style={{ marginBottom: 6 }}>
                      <strong>ОКВЭД:</strong>
                    </p>
                    {okvedList.length ? (
                      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.35 }}>
                        {okvedList.map((code, i) => (
                          <li key={i} style={{ marginBottom: 6 }}>
                            {code}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p style={{ margin: 0 }}>
                        ОКВЭДы отсутствуют — сведения о туристической деятельности не указаны.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className={styles.organizerCard}>
                <div className={styles.organizerHeader}>
                  {organizerData?.avatar_url ? (
                    <img
                      src={organizerData.avatar_url}
                      alt="Organizer avatar"
                      className={`${styles.organizerAvatar} ${styles.avatarHover}`}
                    />
                  ) : (
                    <div className={`${styles.avatarPlaceholder} ${styles.avatarHover}`}>👤</div>
                  )}
                  <div>
                    <h3>{getFullName(organizerData)}</h3>
                    <p className={styles.status}>
                      Пол: {genderMap[organizerData?.gender?.toLowerCase()] || 'Не указан'}
                    </p>
                    <p>
                      <strong>Средний рейтинг:</strong> {organizerData?.averageRating || '0.0'} ⭐
                    </p>
                  </div>
                </div>

                <div className={styles.organizerDetails}>
                  <p>
                    <strong>Возраст:</strong> {calculateAge(organizerData?.birth_date)}
                  </p>
                  <p>
                    <strong>Местоположение:</strong> {organizerData?.location || 'Не указано'}
                  </p>
                  <p>
                    <strong>О себе:</strong> {organizerData?.about || 'Не указано'}
                  </p>
                  {isUserConfirmed && organizerData?.phone && (
                    <p>
                      <strong>Телефон:</strong> {organizerData.phone}
                    </p>
                  )}
                </div>
              </div>
            )}

            <h3 className={styles.reviewsTitle}>Отзывы об организаторе</h3>
            {reviewsData?.length > 0 ? (
              <div className={styles.reviewsList}>
                {reviewsData.map((review, index) => (
                  <div key={index} className={styles.reviewCard}>
                    <div className={styles.reviewHeader}>
                      <p>
                        <strong>Поездка:</strong> {review.trip_title}
                      </p>
                      <p>
                        <strong>Рейтинг:</strong> {review.rating} ⭐
                      </p>
                    </div>
                    <p className={styles.reviewText}>{review.text || 'Нет текста отзыва'}</p>
                    <p className={styles.reviewDate}>
                      {new Date(review.created_at).toLocaleString('ru', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.noReviews}>Нет отзывов об этом организаторе.</p>
            )}

            <button className={styles.closeButton} onClick={closeOrganizerModal}>
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Модал «Задать вопрос» временно отключён (как в PC)
      {questionModalOpen && (...)}
      */}
    </div>
  );
}
