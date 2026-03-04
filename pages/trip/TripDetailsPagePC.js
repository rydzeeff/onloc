import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import styles from '../../styles/trip-details.pc.module.css';
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

function AlertIconWithCount({ count = 0, className }) {
  const n = Number(count || 0);
  const label = n > 99 ? '99+' : String(n);
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a5 5 0 0 0-5 5v2.4c0 .7-.2 1.4-.6 2l-1.1 1.7c-.5.8 0 1.9.9 1.9h11.6c.9 0 1.4-1.1.9-1.9l-1.1-1.7a3.7 3.7 0 0 1-.6-2V8a5 5 0 0 0-5-5Z" fill={n > 0 ? '#ef4444' : 'none'} stroke={n > 0 ? '#ef4444' : 'currentColor'} strokeWidth="2"/>
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      {n > 0 ? <text x="12" y="11.5" textAnchor="middle" fontSize={label.length>=3?'6':'8'} fontWeight="700" fill="#fff">{label}</text> : null}
    </svg>
  );
}

function MsgIconWithCount({ count = 0 }) {
  const n = Number(count || 0);
  const label = n > 99 ? '99+' : String(n);

  return (
    <svg
      style={{ width: '100%', height: '100%', display: 'block', transform: 'scale(1.7)' }}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M21 12c0 4.418-4.03 8-9 8a10.6 10.6 0 0 1-3.61-.62L3 21l1.78-4.12A7.62 7.62 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z"
        fill={n > 0 ? '#ef4444' : 'none'}
        stroke={n > 0 ? '#ef4444' : '#9ca3af'}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {n > 0 ? (
        <text
          x="11.5"
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


export default function TripDetailsPagePC() {
  const router = useRouter();
  const { from: fromParamRaw } = router.query || {};
  const openedFromParticipants = String(fromParamRaw || '')
    .toLowerCase()
    .includes('participant');

  const { setProcessing } = useAuth();
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
    // questionModalOpen, // отключено по задаче
    // newMessage,
    infoMenuOpen,
    infoSection,
    unreadMessages,
    mapRef,
    infoButtonRef,
    statusMap,
    genderMap,
    imageUrls,
    formatDateRange,
    joinedCount,
    possibleCount,
    isUserConfirmed,
    setQuestionModalOpen,
    setNewMessage,
    showTemporaryMessage,
    handleJoinTrip,
    handleSendQuestion,
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
  } = useTripDetails();

  const unreadAlerts = useTripAlertsCount(user?.id);

  // --- Локальные "оверрайды": добираем поля, которых нет в RPC, и корректируем организатора ---
  const [tripExtras, setTripExtras] = useState({
    refund_policy: null,
    timezone: null,
    is_company_trip: null,
  });
  const [companyOverride, setCompanyOverride] = useState(null);
  const [companyReviewsOverride, setCompanyReviewsOverride] = useState([]);

  // ▼ Новое: состояние модального окна с полным описанием
  const [isDescOpen, setIsDescOpen] = useState(false);

  // ▼ Новое: состояние модального окна «Подтвердить присоединение»
  const [isJoinConfirmOpen, setIsJoinConfirmOpen] = useState(false);
  const [joining, setJoining] = useState(false);

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
  }, [trip?.id]);

  // при открытии модала организатора проверяем реальный флаг и при необходимости подтягиваем компанию
  useEffect(() => {
    let mounted = true;
    async function ensureCompanyOrganizer() {
      if (!organizerModalOpen || !trip?.id || !trip?.creator_id) return;

      // реальный признак "поездка от компании"
      const isCompany =
        toBool(trip?.is_company_trip) || toBool(tripExtras?.is_company_trip);

      if (!isCompany) return; // тогда и не лезем за компанией

      // если уже есть компания (в хуке или в оверрайде) — ничего не делаем
      if (companyOverride || organizerData?.type === 'company') return;

      // подтягиваем компанию + отзывы
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

      // доберём названия поездок
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
  }, [organizerModalOpen, trip?.id, trip?.creator_id, tripExtras?.is_company_trip, organizerData?.type]);

  const downloadDocumentWithLoading = async (fileName) => {
    const { setProcessing } = useAuth();
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
      (typeof raw === 'string' && (() => { try { return JSON.parse(raw)?.timezone; } catch { return null; } })()) ||
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
    if (typeof fullH === 'number')
      lines.push(`Полный возврат: до ${fullH} ч до начала — 100%.`);
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
    isCompanyDisplay ? (companyOverride || (organizerData?.type === 'company' ? organizerData : null)) : null;

  const reviewsData =
    isCompanyDisplay
      ? (companyReviewsOverride.length ? companyReviewsOverride : organizerReviews)
      : organizerReviews;

  // ОКВЭДы: поддерживаем массив или строку; строка "[]" тоже даёт пустой список
  const okvedList = useMemo(() => {
    const src = companyData?.okveds ?? companyData?.okved ?? companyData?.okved_codes;
    if (!src) return [];
    if (Array.isArray(src)) return src.filter(Boolean).map(String);
    if (typeof src === 'string') {
      const trimmed = src.trim();
      if (trimmed === '[]') return [];
      return trimmed.split(/[;,|\n]+/).map(s => s.trim()).filter(Boolean);
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
                Эта поездка {st === 'started'
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

  const leisureTypeMap = { tourism: 'Туризм', fishing: 'Рыбалка', hunting: 'Охота' };
  const difficultyMap = { easy: 'Легко', medium: 'Средне', hard: 'Сложно' };

  // ▼ Удобный превью-текст для карточки (без дерганья макета)
  const description = trip.description || '';
  const preview = description.length > 160 ? `${description.slice(0, 160)}…` : description;

  // ▼ Открыть модалку подтверждения
  const onJoinClick = () => setIsJoinConfirmOpen(true);

  // ▼ Подтвердить «Да»
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

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <img src="/logo.png" alt="Onloc Logo" className={styles.logo} />
        <div className={styles.authButtons}>
<div className={styles.messagesWrapper}>
  <button
    type="button"
    className={styles.messageIcon}
    onClick={handleMessagesClick}
    aria-label="Сообщения"
    title="Сообщения"
    style={{ border: "none" }}
  >
    <MsgIconWithCount count={unreadMessages} />
  </button>

  <AlertsBell
    user={user}
    count={unreadAlerts}
    buttonClassName={styles.messageIcon}
    iconClassName={styles.bellIcon}
  />
</div>

<ShareButton
  title={trip?.title ? `Поездка: ${trip.title}` : 'Поездка'}
  text="Посмотри эту поездку на Onloc"
  buttonClassName={styles.messageIcon}
  onBeforeOpen={() => {
    if (infoMenuOpen) toggleInfoMenu();
  }}
/>


          <div className={styles.infoWrapper} ref={infoButtonRef}>
            <button onClick={toggleInfoMenu} className={styles.button}>Информация</button>
            {infoMenuOpen && (
              <div className={styles.infoDropdown}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button onClick={() => handleInfoSection('contacts')} className={styles.infoOption}>Контакты</button>
                <button onClick={() => handleInfoSection('documents')} className={styles.infoOption}>Документы</button>
              </div>
            )}

            {infoSection === 'contacts' && (
              <div className={styles.companyCard}>
                <h3>Карточка предприятия</h3>
                <p><strong>ИП Рудзеев А.Н.</strong></p>
                <p><strong>Полное официальное наименование:</strong> Индивидуальный предприниматель Рудзеев А.Н.</p>
                <p><strong>Сокращенное наименование:</strong> ИП Рудзеев А.Н.</p>
                <p><strong>ИНН:</strong> 452001776346</p>
                <p><strong>ОГРНИП:</strong> 313890108500020</p>
                <p><strong>Юридический адрес:</strong> 629003, ЯНАО, г. Салехард, Обдорская, д. 71</p>
                <p><strong>Фактический адрес:</strong> 629002, ЯНАО, г. Салехард, ул. Глазкова, д. 12</p>
                <p><strong>Почтовый адрес:</strong> 629008, ЯНАО, г. Салехард, ул. Матросова, 2, а/я 27/2</p>
                <p><strong>Телефон:</strong> 8 (34922) 99-3-44</p>
                <p><strong>Номер расчетного счета:</strong> 40802810967450041197</p>
                <p><strong>Наименование банка:</strong> ЗАПАДНО-СИБИРСКИЙ БАНК ПАО "СБЕРБАНК РОССИИ"</p>
                <p><strong>Корр. счёт:</strong> 30101810800000000651</p>
                <p><strong>КПП:</strong> 890101001</p>
                <p><strong>БИК:</strong> 047102651</p>
                <p><strong>e-mail:</strong> info@itc89.ru, info@gkkot.ru</p>
              </div>
            )}

            {infoSection === 'documents' && (
              <div className={styles.documentsCard}>
                <h3>Документы</h3>
                <button onClick={() => downloadDocumentWithLoading('tbank_contract.pdf')} className={styles.documentLink}>Договор Т-банк</button>
                <button onClick={() => downloadDocumentWithLoading('platform_contract.pdf')} className={styles.documentLink}>Договор Площадка</button>
              </div>
            )}
          </div>

          {user !== undefined ? (
            user
              ? <Link href={{ pathname: '/dashboard', query: { section: 'myTrips' } }} className={styles.button}>Личный кабинет</Link>
              : <Link href="/auth" className={styles.button}>Авторизоваться</Link>
          ) : null}
        </div>
      </header>

      {message && <div className={styles.toast}>{message}</div>}

      <div className={styles.mainContent}>
        {/* Левая колонка с галереей */}
        <div className={styles.leftPanel}>
          <div className={styles.imageGalleryContainer}>
            {imageUrls.length > 0 && (
              <div className={styles.mainImageContainer}>
                <img
                  src={imageUrls[mainImageIndex]}
                  alt={`${trip.title} main photo`}
                  className={styles.mainImage}
                  style={{ opacity: fade ? 1 : 0 }}
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
                    onClick={() => handleChangeMainImage(index)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Правая колонка */}
        <div className={styles.rightPanel}>
          <h1 className={styles.tripTitle}>{trip.title}</h1>

          {/* одна плоскость: слева цена/дата/описание, справа возврат */}
          <div className={styles.headerInfo}>
            <div className={`${styles.infoCard} ${styles.headerInfoLeft}`}>
              <p className={styles.price}>Цена: <span className={styles.highlight}>{trip.price} ₽</span></p>
              <p className={styles.date}>Дата: <span className={styles.highlight}>{formatDateRange}</span></p>

              {/* ▼ Превью описания + кнопка открытия модалки */}
              <div style={{ marginTop: 8 }}>
                <p className={styles.description} title={description}>
                  Описание: {preview}
                </p>
                {description && description.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setIsDescOpen(true)}
                    className={styles.button}
                    style={{ marginTop: 6 }}
                  >
                    Показать всё
                  </button>
                )}
              </div>
            </div>

            <div className={`${styles.infoCard} ${styles.refundCard} ${styles.headerInfoRight}`}>
              <div className={styles.refundHeader}>
                <h3 className={styles.refundTitle}>Возврат</h3>
                <span
                  className={[
                    styles.refundBadge,
                    refundInfo.variant === 'standard'
                      ? styles.badgeStandard
                      : refundInfo.variant === 'custom'
                      ? styles.badgeCustom
                      : styles.badgeNone,
                  ].join(' ')}
                >
                  {refundInfo.tag}
                </span>
              </div>
              <ul className={styles.refundList}>
                {refundInfo.lines.map((line, i) => (
                  <li key={i} className={styles.refundRow}>{line}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className={styles.buttonGroup}>
            {/* Было: onClick={handleJoinTripWithLoading} */}
            <button className={styles.actionButton} onClick={onJoinClick}>Присоединиться</button>
            {/* <button className={styles.actionButton} onClick={() => setQuestionModalOpen(true)}>Задать вопрос</button> */}
            <button className={styles.actionButton} onClick={openParticipantsModal}>Участники: {joinedCount} / {possibleCount}</button>
            <button className={styles.actionButton} onClick={openOrganizerModal}>Организатор</button>
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

          <div id="map" className={`${styles.mapContainer} tripDetailsMapContainer`}></div>



          <div className={styles.infoRow}>
            <div className={styles.infoTile}>
              <p>Тип отдыха: <span className={styles.highlight}>{leisureTypeMap[trip.leisure_type] || trip.leisure_type}</span></p>
            </div>
            <div className={styles.infoTile}>
              <p>Возраст: <span className={styles.highlight}>{trip.age_from} – {trip.age_to}</span></p>
            </div>
            <div className={styles.infoTile}>
              <p>Сложность: <span className={styles.highlight}>{difficultyMap[trip.difficulty] || trip.difficulty}</span></p>
            </div>
            <div className={styles.infoTile}>
              <p>Алкоголь: <span className={styles.highlight}>{trip.alcohol_allowed ? 'Да' : 'Нет'}</span></p>
            </div>
          </div>
        </div>
      </div>

      {/* Модал «Описание» — окно с полным текстом; закрывается крестиком/кнопкой */}
      {isDescOpen && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setIsDescOpen(false)}
          style={{ backdropFilter: 'blur(2px)', animation: 'fadeIn .12s ease-out' }}
        >
          <div
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 720, width: 'calc(100% - 24px)', transformOrigin: 'bottom center', animation: 'popIn .12s ease-out' }}
          >
            <div className={styles.modalHeader} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
              <h2 className={styles.modalTitle} style={{ margin: 0 }}>Полное описание</h2>
            </div>

            <div className={styles.modalBody} style={{ marginTop: 8, maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {description}
            </div>

            <div className={styles.modalActions} style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button className={styles.button} onClick={() => setIsDescOpen(false)}>Закрыть</button>
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
            style={{ maxWidth: 440, width: 'calc(100% - 24px)', transformOrigin: 'bottom center', animation: 'popIn .12s ease-out' }}
          >
            <h2 className={styles.modalTitle} style={{ marginTop: 0 }}>
              Присоединиться к поездке?
            </h2>
            <div className={styles.modalBody} style={{ marginTop: 8 }}>
              После подтверждения вы появитесь в списке участников. Продолжить?
            </div>
            <div
  className={styles.modalActions}
  style={{
    marginTop: 12,
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  }}
>
  {/* Кнопка "Да" — зелёная, первая */}
  <button
    className={styles.button}
    onClick={confirmJoin}
    disabled={joining}
    style={{
      backgroundColor: '#25D366', // WhatsApp green
      color: '#fff',
      border: 'none',
    }}
  >
    {joining ? 'Присоединяем…' : 'Да'}
  </button>

  {/* Кнопка "Нет" — обычная, вторая */}
  <button
    className={styles.button}
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
        <div className={styles.modalBackdrop}>
          <div className={styles.modalContent}>
            <h2>Участники</h2>
            {participants.length === 0 ? (
              <table className={styles.participantsTable}>
                <thead>
                  <tr>
                    <th>Аватар</th>
                    <th>ФИО</th>
                    <th>Возраст</th>
                    <th>Пол</th>
                    <th>Рейтинг</th>
                    <th>Статус</th>
                    <th>Дата присоединения</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td colSpan="7">Нет участников</td></tr>
                </tbody>
              </table>
            ) : (
              <table className={styles.participantsTable}>
                <thead>
                  <tr>
                    <th>Аватар</th>
                    <th>ФИО</th>
                    <th>Возраст</th>
                    <th>Пол</th>
                    <th>Рейтинг</th>
                    <th>Статус</th>
                    <th>Дата присоединения</th>
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p) => (
                    <tr key={p.id}>
                      <td><img src={p.avatar_url || DEFAULT_AVATAR} alt={`${getFullName(p)}'s avatar`} className={styles.avatar} /></td>
                      <td>{getFullName(p)}</td>
                      <td>{calculateAge(p.birth_date)}</td>
                      <td>{genderMap[p.gender?.toLowerCase()] || 'Не указан'}</td>
                      <td>{p.average_rating?.toFixed(1) || '0.0'}</td>
                      <td>{statusMap[p.status.toLowerCase()] || p.status}</td>
                      <td>{p.joined_at ? new Date(p.joined_at).toLocaleString('ru', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Не указано'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className={styles.modalActions} style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button className={styles.button} onClick={closeParticipantsModal}>Закрыть</button>
            </div>
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
                    <img src={companyData.avatar_url} alt="Company avatar" className={styles.organizerAvatar} />
                  ) : (
                    <div className={styles.avatarPlaceholder}>🏢</div>
                  )}
                  <div>
                    <h3>{companyData?.name || 'Название компании не указано'}</h3>
                    {/* Удалено: строка про статус/верификацию */}
                    <p><strong>Средний рейтинг:</strong> {companyData?.averageRating || '0.0'} ⭐</p>
                  </div>
                </div>
                <div className={styles.organizerDetails}>
                  <p><strong>ИНН:</strong> {companyData?.inn || '—'}</p>
                  <p><strong>КПП:</strong> {companyData?.kpp || '—'}</p>
                  <p><strong>ОГРН:</strong> {companyData?.ogrn || '—'}</p>
                  <p><strong>Руководитель:</strong> {companyData?.leader || '—'}</p>
                  <p><strong>Юридический адрес:</strong> {companyData?.legal_address || '—'}</p>
                  <p><strong>Телефон:</strong> {companyData?.phone || '—'}</p>

                  {/* ОКВЭД */}
                  <div className={styles.okvedBlock} style={{ marginTop: 8 }}>
                    <p><strong>ОКВЭД:</strong></p>
                    {okvedList.length ? (
                      <ul className={styles.refundList} style={{ marginTop: 4 }}>
                        {okvedList.map((code, i) => (
                          <li key={i} className={styles.refundRow}>{code}</li>
                        ))}
                      </ul>
                    ) : (
                      <p style={{ marginTop: 4 }}>
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
                    <img src={organizerData.avatar_url} alt="Organizer avatar" className={`${styles.organizerAvatar} ${styles.avatarHover}`} />
                  ) : (
                    <div className={`${styles.avatarPlaceholder} ${styles.avatarHover}`}>👤</div>
                  )}
                  <div>
                    <h3>{getFullName(organizerData)}</h3>
                    <p className={styles.status}>Пол: {genderMap[organizerData?.gender?.toLowerCase()] || 'Не указан'}</p>
                    <p><strong>Средний рейтинг:</strong> {organizerData?.averageRating || '0.0'} ⭐</p>
                  </div>
                </div>
                <div className={styles.organizerDetails}>
                  <p><strong>Возраст:</strong> {calculateAge(organizerData?.birth_date)}</p>
                  <p><strong>Местоположение:</strong> {organizerData?.location || 'Не указано'}</p>
                  <p><strong>О себе:</strong> {organizerData?.about || 'Не указано'}</p>
                  {isUserConfirmed && organizerData?.phone && (
                    <p><strong>Телефон:</strong> {organizerData.phone}</p>
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
                      <p><strong>Поездка:</strong> {review.trip_title}</p>
                      <p><strong>Рейтинг:</strong> {review.rating} ⭐</p>
                    </div>
                    <p className={styles.reviewText}>{review.text || 'Нет текста отзыва'}</p>
                    <p className={styles.reviewDate}>
                      {new Date(review.created_at).toLocaleString('ru', {
                        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
                      })}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.noReviews}>Нет отзывов об этом организаторе.</p>
            )}

            <div className={styles.modalActions} style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button className={styles.button} onClick={closeOrganizerModal}>Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {/* Модал «Задать вопрос» временно отключён
      {questionModalOpen && (...)}
      */}
    </div>
  );
}
