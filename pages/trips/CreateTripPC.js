import dynamic from 'next/dynamic';
import styles from '../../styles/create-trip.pc.module.css';
import pcStyles from '../../styles/dashboard.pc.module.css';
import { useCreateTrip } from '../../lib/useCreateTrip';
import { useRef, useEffect, useState } from 'react';
import { platformSettings } from '../../lib/platformSettings';
import { useAuth } from '../../pages/_app';

const YMaps = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.YMaps), { ssr: false });
const Map = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Map), { ssr: false });
const Placemark = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Placemark), { ssr: false });

export default function CreateTripPC({ toLocation }) {
  const {
    isReady,
    tripData,
    previewUrls,
    isLocationFromOpen,
    isLocationToOpen,
    loading,
    fromCoordinates,
    toCoordinates,
    fromAddress,
    toAddress,
    mainImageIndex,
    fromMapCenter,
    toMapCenter,
    companyVerificationStatus,
    showPopup,
    today,
    minArrivalDate,
    fromMapDefaultState,
    toMapDefaultState,
    handleChange,
    handleSubmit,
    handleFileChange,
    handleRemoveImage,
    handleSetMainImage,
    openLocationFrom,
    openLocationTo,
    closeLocationFrom,
    closeLocationTo,
    handleLocationFromOk,
    handleLocationToOk,
    handleImageUpload,
    setFromCoordinates,
    setToCoordinates,
    timezone,
    showTimezoneInput,
    timezoneError,
    handleTimezoneChange,
    handleTimezoneSubmit,
    commonTimezones,
    refundError,
    timeError,
    // NEW
    hasValidCard,
    hasCompanyOk,
    nsfwChecking,
    nsfwProgress,
  } = useCreateTrip(toLocation);

  const { user } = useAuth();

  // UI: позиционирование попапов/карты по центру видимой области
  const fromButtonRef = useRef(null);
  const toButtonRef = useRef(null);
  const scrollPositionRef = useRef(0);
  const mapRef = useRef(null);
  const [mapPosition, setMapPosition] = useState({ top: '0px', left: '50%', transform: 'translateX(-50%)' });
  const [errorPopupPosition, setErrorPopupPosition] = useState({ top: '0px', left: '50%', transform: 'translateX(-50%)' });
  const [isAddressLoading, setIsAddressLoading] = useState(false);
  const [isYmapsLoaded, setIsYmapsLoaded] = useState(false);

  useEffect(() => {
    const content = document.querySelector(`.${pcStyles.content}`);
    if (!content) return;

    const updatePositions = () => {
      const viewportHeight = window.innerHeight;
      const mapHeight = 400;
      const errorPopupHeight = 100;
      const scrollTop = content.scrollTop;
      scrollPositionRef.current = scrollTop;

      const mapTopPosition = scrollTop + (viewportHeight - mapHeight) / 2;
      setMapPosition({ top: `${mapTopPosition}px`, left: '50%', transform: 'translateX(-50%)' });

      const errorTopPosition = scrollTop + (viewportHeight - errorPopupHeight) / 2;
      setErrorPopupPosition({ top: `${errorTopPosition}px`, left: '50%', transform: 'translateX(-50%)' });
    };

    content.addEventListener('scroll', updatePositions);
    updatePositions();

    return () => {
      content.removeEventListener('scroll', updatePositions);
    };
  }, [isLocationFromOpen, isLocationToOpen, refundError, timeError]);

  useEffect(() => {
    const loadYmaps = async () => {
      if (!window.ymaps) {
        try {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `https://api-maps.yandex.ru/2.1/?apikey=${process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY}&lang=ru_RU`;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load Yandex Maps API'));
            document.head.appendChild(script);
            setTimeout(() => reject(new Error('Yandex Maps API load timeout')), 5000);
          });
        } catch (error) {
          console.error('Error loading Yandex Maps API:', error);
          setIsYmapsLoaded(false);
          return;
        }
      }
      window.ymaps.ready(() => {
        setIsYmapsLoaded(true);
      });
    };
    loadYmaps();
  }, []);

  const handleApplyFrom = async () => {
    setIsAddressLoading(true);
    if (!isYmapsLoaded) {
      try {
        await new Promise((resolve, reject) => {
          const checkYmaps = () => {
            if (window.ymaps && window.ymaps.ready) {
              window.ymaps.ready(resolve);
            } else {
              setTimeout(checkYmaps, 100);
            }
          };
          checkYmaps();
          setTimeout(() => reject(new Error('YMaps load timeout')), 5000);
        });
        setIsYmapsLoaded(true);
      } catch (error) {
        console.error('YMaps not loaded after timeout:', error);
        setIsAddressLoading(false);
        return;
      }
    }
    await handleLocationFromOk();
    setIsAddressLoading(false);
  };

  const handleApplyTo = async () => {
    setIsAddressLoading(true);
    if (!isYmapsLoaded) {
      try {
        await new Promise((resolve, reject) => {
          const checkYmaps = () => {
            if (window.ymaps && window.ymaps.ready) {
              window.ymaps.ready(resolve);
            } else {
              setTimeout(checkYmaps, 100);
            }
          };
          checkYmaps();
          setTimeout(() => reject(new Error('YMaps load timeout')), 5000);
        });
        setIsYmapsLoaded(true);
      } catch (error) {
        console.error('YMaps not loaded after timeout:', error);
        setIsAddressLoading(false);
        return;
      }
    }
    await handleLocationToOk();
    setIsAddressLoading(false);
  };

  if (!isReady) return null;

  // NEW: блокирующий оверлей — только если нет ни карты, ни подходящей компании
  const mustBindCard = !hasValidCard && !hasCompanyOk;

  return (
    <div className={styles.animatedWrapper}>
      <h1 className={styles.header}>Создать новую поездку</h1>
      <div className={styles.formWrapper}>
        <form onSubmit={showTimezoneInput ? handleTimezoneSubmit : handleSubmit} className={styles.form}>
          <div className={styles.section}>
            <h2>Основная информация</h2>
            <div className={styles.inputGroup}>
              <label>Название поездки</label>
              <input type="text" name="title" value={tripData.title} onChange={handleChange} required disabled={loading} />
            </div>
            <div className={styles.inputGroup}>
              <label>Описание</label>
              <textarea name="description" value={tripData.description} onChange={handleChange} required disabled={loading} />
            </div>
            <div className={styles.inputGroup}>
              <label>Поездка от лица компании?</label>
              <div className={styles.switchContainer}>
                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    name="isCompanyTrip"
                    checked={tripData.isCompanyTrip}
                    onChange={(e) => handleChange({ target: { name: 'isCompanyTrip', value: e.target.checked ? 'true' : 'false' } })}
                    disabled={loading} // не блокируем — пусть покажем понятную ошибку внутри handleChange
                  />
                  <span className={styles.slider}></span>
                </label>
                <span className={styles.switchLabel}>{tripData.isCompanyTrip ? 'Да' : 'Нет'}</span>
              </div>
              {!hasValidCard && hasCompanyOk && (
                <p className={styles.hint}>
                  У вас нет привязанной карты — по умолчанию поездка создаётся от лица компании.
                  Чтобы переключиться на физ. лицо, добавьте карту в «Настройки → Мои карты».
                </p>
              )}
            </div>
          </div>

          <div className={styles.section}>
            <h2>Даты и время</h2>
            <div className={styles.inputGroup}>
              <label>Дата отправления</label>
              <input
                type="date"
                name="date"
                value={tripData.date ? tripData.date.toISOString().split('T')[0] : ''}
                onChange={handleChange}
                min={today}
                required
                disabled={loading}
              />
            </div>
            <div className={styles.inputGroup}>
              <label>Время отправления</label>
              <input type="time" name="time" value={tripData.time} onChange={handleChange} required disabled={loading} />
            </div>
            <div className={styles.inputGroup}>
              <label>Дата приезда</label>
              <input
                type="date"
                name="arrivalDate"
                value={tripData.arrivalDate ? tripData.arrivalDate.toISOString().split('T')[0] : ''}
                onChange={handleChange}
                min={minArrivalDate}
                required
                disabled={loading}
              />
            </div>
            <div className={styles.inputGroup}>
              <label>Время приезда</label>
              <input type="time" name="arrivalTime" value={tripData.arrivalTime} onChange={handleChange} required disabled={loading} />
            </div>
          </div>

          <div className={styles.section}>
            <h2>Дополнительная информация</h2>
            <div className={styles.inputGroup}>
              <label>Цена <span className={styles.ruble}>₽</span></label>
              <div className={styles.inputWrapper}>
                <input type="number" name="price" value={tripData.price} onChange={handleChange} required disabled={loading} />
                {tripData.price > 0 && (
                  <div className={styles.feeCalculation}>
                    <h3>Расчёт выплат</h3>
                    <p>Цена поездки: {tripData.price} ₽ <span className={styles.hint}>(сумма, которую заплатят участники)</span></p>
                    <p>Комиссия площадки ({platformSettings.platformFeePercent}%): {tripData.platformFee.toFixed(2)} ₽</p>
                    <p>Комиссия Т-Банка ({platformSettings.tbankFeePercent}%): {tripData.tbankFee.toFixed(2)} ₽</p>
                    <p className={styles.netAmount}>
                      Итого на счёт: {tripData.netAmount.toFixed(2)} ₽ <span className={styles.hint}>(вы получите после комиссий)</span>
                    </p>
                  </div>
                )}
              </div>
            </div>
            <div className={styles.inputGroup}>
              <label>Сложность</label>
              <select name="difficulty" value={tripData.difficulty} onChange={handleChange} required disabled={loading}>
                <option value="easy">Легко</option>
                <option value="medium">Средне</option>
                <option value="hard">Сложно</option>
              </select>
            </div>
            <div className={`${styles.inputGroup} ${styles.ageRange}`}>
              <label>Возрастной диапазон</label>
              <div>
                <input
                  type="number"
                  name="ageFrom"
                  value={tripData.ageFrom}
                  onChange={handleChange}
                  placeholder="От"
                  required
                  disabled={loading}
                />
                <input
                  type="number"
                  name="ageTo"
                  value={tripData.ageTo}
                  onChange={handleChange}
                  placeholder="До"
                  required
                  disabled={loading}
                />
              </div>
            </div>
            <div className={styles.inputGroup}>
              <label>Количество участников</label>
              <input type="number" name="participants" value={tripData.participants} onChange={handleChange} required disabled={loading} />
            </div>
            <div className={styles.inputGroup}>
              <label>Тип отдыха</label>
              <select name="leisureType" value={tripData.leisureType} onChange={handleChange} required disabled={loading}>
                <option value="tourism">Туризм</option>
                <option value="fishing">Рыбалка</option>
                <option value="hunting">Охота</option>
              </select>
            </div>

<div className={styles.inputGroup}>
              <label>Разрешён алкоголь?</label>
              <div className={styles.switchContainer}>
                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    name="alcoholAllowed"
                    checked={tripData.alcoholAllowed}
                    onChange={(e) => handleChange({ target: { name: 'alcoholAllowed', value: e.target.checked ? 'true' : 'false' } })}
                    disabled={loading}
                  />
                  <span className={styles.slider}></span>
                </label>
                <span className={styles.switchLabel}>{tripData.alcoholAllowed ? 'Да' : 'Нет'}</span>
              </div>
            </div>

            <div className={styles.inputGroup}>
              <label>Свои условия отмены?</label>
              <div className={styles.switchContainer}>
                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    name="refund_policy_type"
                    checked={tripData.refund_policy_type}
                    onChange={(e) => handleChange({ target: { name: 'refund_policy_type', value: e.target.checked ? 'true' : 'false' } })}
                    disabled={loading}
                  />
                  <span className={styles.slider}></span>
                </label>
                <span className={styles.switchLabel}>{tripData.refund_policy_type ? 'Да' : 'Нет'}</span>
              </div>
              <p className={styles.hint}>Выберите, чтобы задать свои сроки и проценты возврата денег при отмене поездки участниками.</p>
              {!tripData.refund_policy_type && (
                <div className={styles.standardRefundInfo}>
                  При стандартных условиях полный возврат возможен за 1 час до начала поездки, после — возврат не предусмотрен.
                </div>
              )}
            </div>

            {tripData.refund_policy_type && (
              <>
                <div className={styles.inputGroup}>
                  <label>Срок полного возврата (часы)</label>
                  <input
                    type="number"
                    name="refund_policy.full_refunded_hours"
                    value={tripData.refund_policy.full_refunded_hours}
                    onChange={handleChange}
                    min="1"
                    required
                    disabled={loading}
                    placeholder="1"
                  />
                  <p className={styles.hint}>За сколько часов до начала поездки участники получат полный возврат.</p>
                </div>
                <div className={styles.inputGroup}>
                  <label>Срок частичного возврата (часы)</label>
                  <input
                    type="number"
                    name="refund_policy.partial_refunded_hours"
                    value={tripData.refund_policy.partial_refunded_hours}
                    onChange={handleChange}
                    min="0"
                    required
                    disabled={loading}
                    placeholder="0"
                  />
                  <p className={styles.hint}>За сколько часов до начала поездки участники получат частичный возврат.</p>
                </div>
                <div className={styles.inputGroup}>
                  <label>Процент частичного возврата</label>
                  <input
                    type="number"
                    name="refund_policy.partial_refunded_percent"
                    value={tripData.refund_policy.partial_refunded_percent}
                    onChange={handleChange}
                    min="0"
                    max="100"
                    required
                    disabled={loading}
                    placeholder="0"
                  />
                  <p className={styles.hint}>Процент от стоимости, который вернётся при частичной отмене.</p>
                </div>
              </>
            )}
          </div>

          <div className={styles.section}>
            <h2>Местоположение</h2>
            <div className={`${styles.inputGroup} ${styles.locationGroup}`}>
              <label>Место отправления</label>
              <div className={styles.locationInfo}>
                <button type="button" ref={fromButtonRef} onClick={openLocationFrom} disabled={loading || isAddressLoading}></button>
                {fromCoordinates && (
                  <div>
                    <input
                      type="text"
                      readOnly
                      value={`Координаты: ${fromCoordinates.join(', ')}`}
                      className={styles.addressField}
                    />
                    <input type="text" readOnly value={`Адрес: ${fromAddress}`} className={styles.addressField} />
                  </div>
                )}
              </div>
            </div>
            <div className={`${styles.inputGroup} ${styles.locationGroup}`}>
              <label>Место прибытия</label>
              <div className={styles.locationInfo}>
                <button type="button" ref={toButtonRef} onClick={openLocationTo} disabled={loading || isAddressLoading}></button>
                {toCoordinates && (
                  <div>
                    <input
                      type="text"
                      readOnly
                      value={`Координаты: ${toCoordinates.join(', ')}`}
                      className={styles.addressField}
                    />
                    <input type="text" readOnly value={`Адрес: ${toAddress}`} className={styles.addressField} />
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className={styles.section}>
            <h2>Фотографии (максимум 4)</h2>
            <div className={styles.imageUploadContainer} style={{ position: 'relative' }}>
              {previewUrls.length > 0 && (
                <div className={styles.mainImageContainer}>
                  <img
                    src={previewUrls[mainImageIndex]}
                    alt="Main preview"
                    className={styles.mainImage}
                  />
                  <div className={styles.mainImageCaption}>
                    Это главное фото
                  </div>
                </div>
              )}
              <div className={styles.thumbnailGrid}>
                {previewUrls.map((url, index) => (
                  <div key={index} className={styles.thumbnailWrapper}>
                    <img
                      src={url}
                      alt={`Thumbnail ${index}`}
                      className={styles.thumbnail}
                    />
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={(e) => { e.stopPropagation(); handleRemoveImage(index); }}
                      disabled={loading}
                    >
                      ✕
                    </button>
                    <button
                      type="button"
                      className={`${styles.starButton} ${mainImageIndex === index ? styles.filled : ''}`}
                      onClick={(e) => handleSetMainImage(e, index)}
                      disabled={loading}
                    >
                      ★
                    </button>
                  </div>
                ))}
                {previewUrls.length < 4 && (
                  <div className={styles.uploadPlaceholder} onClick={handleImageUpload} disabled={loading}>
                    <span>+</span>
                  </div>
                )}
              </div>

              {/* NEW: оверлей-индикатор проверки NSFW */}
              {nsfwChecking && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    background: 'rgba(15,23,42,0.55)',
                    backdropFilter: 'saturate(140%) blur(2px)',
                    borderRadius: 12,
                    zIndex: 10,
                  }}
                >
                  <div style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>
                    Проверяем фото&nbsp;{nsfwProgress.done}/{nsfwProgress.total}
                  </div>
                  <div
                    style={{
                      width: '80%',
                      maxWidth: 440,
                      height: 6,
                      borderRadius: 9999,
                      background: 'rgba(255,255,255,.25)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${nsfwProgress.total ? (nsfwProgress.done / nsfwProgress.total) * 100 : 0}%`,
                        transition: 'width .2s ease',
                      }}
                      className={styles.nsfwProgressBar}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {showTimezoneInput && (
            <div className={styles.section}>
              <h2>Часовой пояс</h2>
              <div className={styles.inputGroup}>
                <label>Часовой пояс места отправления</label>
                {timezoneError && <p style={{ color: '#ef4444' }}>{timezoneError}</p>}
                <select
                  value={timezone || ''}
                  onChange={handleTimezoneChange}
                  disabled={loading}
                  required
                >
                  {commonTimezones.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
              <button type="submit" className={styles.submitButton} disabled={loading}>
                {loading ? 'Создание...' : 'Сохранить и создать поездку'}
              </button>
            </div>
          )}
          {!showTimezoneInput && (
            <button type="submit" className={styles.submitButton} disabled={loading}>
              {loading ? 'Создание...' : 'Создать поездку'}
            </button>
          )}
        </form>

        {loading && (
          <div className={styles.loadingOverlay}>
            <div className={styles.loadingSpinner}></div>
            <p>Поездка создаётся...</p>
          </div>
        )}

        {(isLocationFromOpen || isLocationToOpen) && (
          <div className={styles.mapPopup} style={mapPosition}>
            <YMaps query={{ apikey: process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY }}>
              <Map
                state={isLocationFromOpen ? fromMapDefaultState : toMapDefaultState}
                width="100%"
                height="400px"
                instanceRef={(ref) => {
                  if (ref && !mapRef.current) {
                    mapRef.current = ref;
                  }
                }}
                onClick={(e) => {
                  const coords = e.get('coords');
                  if (isLocationFromOpen) {
                    setFromCoordinates(coords);
                  } else {
                    setToCoordinates(coords);
                  }
                }}
                options={{
                  suppressMapOpenBlock: true,
                  controls: [],
                  autoFitToViewport: 'none',
                }}
              >
                {(isLocationFromOpen ? fromCoordinates : toCoordinates) && (
                  <Placemark
                    geometry={isLocationFromOpen ? fromCoordinates : toCoordinates}
                    options={{ preset: 'islands#icon', draggable: false }}
                  />
                )}
              </Map>
            </YMaps>
            <div className={styles.mapButtons}>
              <button
                type="button"
                onClick={isLocationFromOpen ? closeLocationFrom : closeLocationTo}
                style={{ backgroundColor: '#ef4444' }}
              >
                Отменить
              </button>
              <button
                type="button"
                onClick={isLocationFromOpen ? handleApplyFrom : handleApplyTo}
                disabled={!isYmapsLoaded || isAddressLoading}
              >
                Применить
              </button>
            </div>
          </div>
        )}

        {showPopup && (
          <div className={styles.verificationPopup} style={errorPopupPosition}>
            <p style={{ color: '#ff3b30', fontWeight: 500 }}>
              {companyVerificationStatus === 'not_found'
                ? 'У вас нет созданной организации. Пожалуйста, создайте организацию.'
                : companyVerificationStatus === 'error'
                ? 'Ошибка проверки статуса компании.'
                : companyVerificationStatus === 'cards_required'
                ? 'Чтобы создать поездку как физ. лицо, привяжите банковскую карту (Настройки → Мои карты).'
                : 'Ваша компания не зарегистрирована в Т-Банке или не указан платёжный счёт. Проверьте настройки компании.'}
            </p>
          </div>
        )}

        {(refundError || timeError) && (
          <div className={styles.errorPopup} style={errorPopupPosition}>
            <p style={{ color: '#ff3b30', fontWeight: 500 }}>{refundError || timeError}</p>
          </div>
        )}

        {/* Блокирующий оверлей ТОЛЬКО если нет карты И нет подходящей компании */}
        {mustBindCard && (
          <div className={styles.loadingOverlay} style={{ zIndex: 2000 }}>
            <div className={styles.verificationPopup} style={errorPopupPosition}>
              <p style={{ color: '#1e293b', fontWeight: 500 }}>
                Чтобы создать поездку, привяжите банковскую карту (Настройки → «Мои карты»)
                или зарегистрируйте компанию (Настройки → «Компании»).
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
