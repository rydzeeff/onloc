// /pages/trip-view/TripViewPageMobile.js
// Мобильная страница "просмотра" поездки (аналог TripViewPagePC):
// - только кнопка "Назад" + просмотр деталей поездки
// - НЕТ: присоединения, списка участников, инфо-меню/документов/контактов, кнопки чата
// - ЕСТЬ: галерея, описание (полное в модалке), блок "Возврат", карта, характеристики, модалка "Организатор" (+ОКВЭД)

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import styles from '../../styles/trip-details.mobile.module.css';
import { useTripDetails } from '../../lib/useTripDetails';
import { supabase } from '../../lib/supabaseClient';

const FROM_MARKER_ICON = '/custom-marker.png';
const TO_MARKER_ICON = '/marker-icon.png';
const DEFAULT_AVATAR = '/avatar-default.svg';

function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 't' || v === 'T';
}

export default function TripViewPageMobile({ tripId }) {
  const router = useRouter();
  const { id = tripId } = router.query || {};

  const {
    trip,
    message,
    organizerModalOpen,
    organizerData,
    organizerReviews,
    mainImageIndex,
    fade,
    imageUrls,
    formatDateRange,
    openOrganizerModal,
    closeOrganizerModal,
    handleChangeMainImage,
    calculateAge,
    getFullName,
    genderMap,
    isUserConfirmed,
  } = useTripDetails({ tripId: id });

  const leisureTypeMap = {
    tourism: 'Туризм',
    fishing: 'Рыбалка',
    hunting: 'Охота',
  };

  const difficultyMap = {
    easy: 'Легко',
    medium: 'Средне',
    hard: 'Сложно',
  };

  // === Навигация "Назад" (как в TripViewPagePC) ===
  const handleGoBack = () => {
    const { returnTo } = router.query || {};
    if (typeof returnTo === 'string' && returnTo) {
      router.push(returnTo);
      return;
    }

    if (typeof window !== 'undefined') {
      const sameOriginRef =
        document.referrer && document.referrer.startsWith(window.location.origin);
      if (sameOriginRef) {
        router.back();
        return;
      }
    }

    router.push('/dashboard?section=myTrips');
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') handleGoBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === Добираем поля из trips (refund_policy / timezone / is_company_trip) ===
  const [tripExtras, setTripExtras] = useState({
    refund_policy: null,
    timezone: null,
    is_company_trip: null,
  });
  const [companyOverride, setCompanyOverride] = useState(null);
  const [companyReviewsOverride, setCompanyReviewsOverride] = useState([]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id]);

  // === При открытии модала — подтянуть карточку компании и отзывы (если поездка от компании) ===
  useEffect(() => {
    let mounted = true;

    async function ensureCompanyOrganizer() {
      if (!organizerModalOpen || !trip?.id || !trip?.creator_id) return;

      const isCompany = toBool(trip?.is_company_trip) || toBool(tripExtras?.is_company_trip);
      if (!isCompany) return;

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
      if (revErr) console.warn('company_reviews load error:', revErr.message);

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
  }, [organizerModalOpen, trip?.id, trip?.creator_id, tripExtras?.is_company_trip, organizerData?.type, companyOverride]);

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

  // ---- ДАННЫЕ ДЛЯ МОДАЛКИ ОРГАНИЗАТОРА (до ранних return) ----
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

  // === Полное описание: модалка ===
  const [isDescOpen, setIsDescOpen] = useState(false);

  // === Ранний выход (после всех хуков) ===
  if (!trip) return null;

  const description = trip.description || '';
  const preview = description.length > 160 ? `${description.slice(0, 160)}…` : description;

  return (
    <div className={styles.container}>
      {/* В режиме "просмотр" — только topbar с "Назад" */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          background: '#ffffff',
          borderBottom: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          padding: '10px 15px',
          paddingTop: 'calc(10px + env(safe-area-inset-top))',
        }}
      >
        <button
          type="button"
          onClick={handleGoBack}
          style={{
            appearance: 'none',
            border: 'none',
            background: '#25D366',
            color: '#fff',
            padding: '10px 14px',
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          ← Назад
        </button>
      </div>

      {message && <div className={styles.toast}>{message}</div>}

      <div className={styles.mainContent}>
        <div className={styles.imageSection}>
          {imageUrls?.length > 0 && (
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
            {(imageUrls || []).map((url, index) => (
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

              {description && (
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

          {/* В "просмотре" оставляем только "Организатор" */}
          <div className={styles.buttonGroup}>
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

          {/* Карта (инициализацию делает хук useTripDetails) */}
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

      {/* Модал «Полное описание» */}
      {isDescOpen && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setIsDescOpen(false)}
          style={{ backdropFilter: 'blur(2px)', animation: 'fadeIn .12s ease-out' }}
        >
          <div
            className={styles.modalContent}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'calc(100% - 24px)',
              maxWidth: 680,
              transformOrigin: 'bottom center',
              animation: 'popIn .12s ease-out',
            }}
          >
            <h2 className={styles.modalTitle} style={{ marginTop: 0 }}>
              Полное описание
            </h2>

            <div
              style={{
                marginTop: 8,
                maxHeight: '60vh',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
              }}
            >
              {description}
            </div>

            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button className={styles.closeButton} onClick={() => setIsDescOpen(false)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модал «Организатор» (как в PC-view: закрытие по клику на фон) */}
      {organizerModalOpen && (organizerData || companyOverride) && (
        <div className={styles.modalBackdrop} onClick={closeOrganizerModal}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
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
    </div>
  );
}

// Подгрузка Яндекс.Карт (как в остальных страницах)
if (typeof window !== 'undefined' && !window.ymaps) {
  const apiKey = process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY;
  const script = document.createElement('script');
  script.src = `https://api-maps.yandex.ru/2.1/?lang=ru_RU&apikey=${apiKey}`;
  script.async = true;
  document.body.appendChild(script);
}
