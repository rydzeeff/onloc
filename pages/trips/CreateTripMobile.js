import dynamic from 'next/dynamic';
import styles from '../../styles/create-trip.mobile.module.css';
import { useCreateTrip } from '../../lib/useCreateTrip';
import { useRef, useEffect, useState } from 'react';
import { platformSettings } from '../../lib/platformSettings';

const YMaps = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.YMaps), { ssr: false });
const Map = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Map), { ssr: false });
const Placemark = dynamic(() => import('@pbe/react-yandex-maps').then(mod => mod.Placemark), { ssr: false });

export default function CreateTripMobile({ toLocation, mainContentRef }) {
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
    setFromCoordinates,
    setToCoordinates,
    handleLocationFromOk,
    handleLocationToOk,
    timezone,
    showTimezoneInput,
    timezoneError,
    handleTimezoneChange,
    handleTimezoneSubmit,
    commonTimezones,
    refundError,
    timeError,
    // NEW (как в PC)
    hasValidCard,
    hasCompanyOk,
    nsfwChecking,
    nsfwProgress,
  } = useCreateTrip(toLocation);

  const fromButtonRef = useRef(null);
  const toButtonRef = useRef(null);
  const mapRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollPositionRef = useRef(0);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [isYmapsLoaded, setIsYmapsLoaded] = useState(false);
  const [isAddressLoading, setIsAddressLoading] = useState(false);
  const [errorPopupPosition, setErrorPopupPosition] = useState({ top: '20%', transform: 'translateX(-50%)' });

  useEffect(() => {
    if (!mainContentRef.current) {
      console.warn('Main content ref not found');
      return;
    }

    const updateScrollPosition = () => {
      if (!isLocationFromOpen && !isLocationToOpen) {
        scrollPositionRef.current = mainContentRef.current.scrollTop;
      }
    };

    const updatePopupPosition = () => {
      const viewportHeight = window.innerHeight;
      const errorPopupHeight = 100; // Примерная высота уведомления
      const scrollTop = mainContentRef.current.scrollTop;
      const errorTopPosition = scrollTop + (viewportHeight - errorPopupHeight) / 2;
      setErrorPopupPosition({ top: `${errorTopPosition}px` });
    };

    mainContentRef.current.addEventListener('scroll', updateScrollPosition);
    mainContentRef.current.addEventListener('scroll', updatePopupPosition);
    updatePopupPosition(); // Инициализация позиции

    if (!isLocationFromOpen && !isLocationToOpen) {
      requestAnimationFrame(() => {
        mainContentRef.current.scrollTop = scrollPositionRef.current;
      });
    }

    return () => {
      if (mainContentRef.current) {
        mainContentRef.current.removeEventListener('scroll', updateScrollPosition);
        mainContentRef.current.removeEventListener('scroll', updatePopupPosition);
      }
    };
  }, [isLocationFromOpen, isLocationToOpen, refundError, timeError, showPopup, mainContentRef]);

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

  const ensureYmapsReady = async () => {
    if (isYmapsLoaded) return true;
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
      return true;
    } catch (error) {
      console.error('YMaps not loaded after timeout:', error);
      return false;
    }
  };

  const handleApplyFrom = async () => {
    setIsAddressLoading(true);
    try {
      const ok = await ensureYmapsReady();
      if (!ok) return;
      await handleLocationFromOk();
    } finally {
      setIsAddressLoading(false);
    }
  };

  const handleApplyTo = async () => {
    setIsAddressLoading(true);
    try {
      const ok = await ensureYmapsReady();
      if (!ok) return;
      await handleLocationToOk();
    } finally {
      setIsAddressLoading(false);
    }
  };

  const handleApplyMap = async () => {
    if (isLocationFromOpen) return handleApplyFrom();
    if (isLocationToOpen) return handleApplyTo();
  };

  const handleCloseMap = () => {
    if (isLocationFromOpen) {
      closeLocationFrom();
    } else if (isLocationToOpen) {
      closeLocationTo();
    }
  };

  const handleImageClick = () => {
    if (!loading) {
      console.log('Image click triggered, opening file input');
      if (fileInputRef.current) {
        fileInputRef.current.click();
      } else {
        console.error('fileInputRef is not initialized');
      }
    } else {
      console.log('Image click blocked due to loading state');
    }
  };

  if (!isReady) {
    return null;
  }

  const mapState = isLocationFromOpen ? fromMapDefaultState : toMapDefaultState;
  const safeMapState = mapState || { center: [55.751244, 37.618423], zoom: 10 };
  const isMapVisible = isLocationFromOpen || isLocationToOpen;
  const mustBindCard = !hasValidCard && !hasCompanyOk;

  return (
    <div className={styles.animatedWrapper}>
      <h1 className={styles.header}>Создать новую поездку</h1>
      <div className={styles.formWrapper} style={{ display: isMapVisible ? 'none' : 'block' }}>
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
                    disabled={loading}
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
                    <p>Комиссия Т-Банка: {tripData.tbankFee.toFixed(2)} ₽</p>
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
        onChange={(e) =>
          handleChange({
            target: {
              name: 'alcoholAllowed',
              value: e.target.checked ? 'true' : 'false',
            },
          })
        }
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
                  <div className={styles.uploadPlaceholder} onClick={handleImageClick}>
                    {uploadProgress ? (
                      <span>{uploadProgress}%</span>
                    ) : (
                      <span>+</span>
                    )}
                  </div>
                )}
              </div>
<input
  type="file"
  ref={fileInputRef}
  accept="image/*"
  multiple
  onChange={(e) => {
    console.log('File input changed, processing files');
    setUploadProgress(0);
    handleFileChange(e).then(() => {
      console.log('File processing completed');
      setUploadProgress(null);
    }).catch((error) => {
      console.error('Error processing files:', error);
      setUploadProgress(null);
      // Ошибку показываем через логику useCreateTrip (timeError/refundError/showPopup).
    });
  }}
  style={{ display: 'none' }}
/>

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
                    Проверяем фото&nbsp;{(nsfwProgress && nsfwProgress.done) || 0}/{(nsfwProgress && nsfwProgress.total) || 0}
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
                        width: `${(nsfwProgress && nsfwProgress.total) ? (nsfwProgress.done / nsfwProgress.total) * 100 : 0}%`,
                        transition: 'width .2s ease',
                        background: 'rgba(255,255,255,.9)',
                      }}
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
                {timezoneError && <p className={styles.errorText}>{timezoneError}</p>}
                <select
                  value={timezone || ''}
                  onChange={handleTimezoneChange}
                  disabled={loading}
                  required
                  size="5"
                  className={styles.timezoneSelect}
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
      </div>
      {isMapVisible && (
        <div className={styles.mapFullScreen}>
          <div className={styles.mapHeader}>
            {isLocationFromOpen ? 'Выберите место отправления' : 'Выберите место прибытия'}
          </div>
          <div className={styles.mapContainer}>
            <YMaps query={{ apikey: process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY }}>
              <Map
                state={safeMapState}
                width="100%"
                height="100%"
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
          </div>
          <div className={styles.mapButtons}>
            <button
              type="button"
              onClick={handleCloseMap}
              className={styles.mapButton}
              style={{ backgroundColor: '#ef4444' }}
            >
              Отменить
            </button>
            <button
              type="button"
              onClick={handleApplyMap}
              className={styles.mapButton}
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
  );
}
