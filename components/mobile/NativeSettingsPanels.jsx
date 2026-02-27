import mobileStyles from '../../styles/settings.mobile.module.css';

export function NativeSettingsMenuRows({ nativeInfo, setView }) {
  return (
    <>
      <button type="button" className={mobileStyles.menuRow} onClick={() => setView('notifications')}>
        <div className={mobileStyles.menuRowLeft}>
          <div className={mobileStyles.menuRowTitle}>Уведомления</div>
          <div className={mobileStyles.menuRowHint}>{nativeInfo.pushStatus}</div>
        </div>
        <div className={mobileStyles.menuChevron} aria-hidden="true">›</div>
      </button>

      <button type="button" className={mobileStyles.menuRow} onClick={() => setView('permissions')}>
        <div className={mobileStyles.menuRowLeft}>
          <div className={mobileStyles.menuRowTitle}>Разрешения</div>
          <div className={mobileStyles.menuRowHint}>{nativeInfo.geolocationStatus}</div>
        </div>
        <div className={mobileStyles.menuChevron} aria-hidden="true">›</div>
      </button>
    </>
  );
}

export function PermissionsView({ nativeInfo, setView, onRequestGeolocation }) {
  return (
    <div className={mobileStyles.subPage}>
      <div className={mobileStyles.subHeader}>
        <button type="button" className={mobileStyles.backButton} onClick={() => setView('menu')}>
          Назад
        </button>
        <div className={mobileStyles.subTitle}>Разрешения</div>
        <div className={mobileStyles.subHeaderSpacer} />
      </div>
      <div className={mobileStyles.form}>
        <div className={mobileStyles.section}>
          <p>Платформа: {nativeInfo.isNative ? 'native' : 'web'}</p>
          <p>Геолокация: {nativeInfo.geolocationStatus}</p>
          <button type="button" className={mobileStyles.saveButton} onClick={onRequestGeolocation}>
            Запросить геолокацию
          </button>
        </div>
      </div>
    </div>
  );
}

export function NotificationsView({ nativeInfo, setView, onEnablePush }) {
  return (
    <div className={mobileStyles.subPage}>
      <div className={mobileStyles.subHeader}>
        <button type="button" className={mobileStyles.backButton} onClick={() => setView('menu')}>
          Назад
        </button>
        <div className={mobileStyles.subTitle}>Уведомления</div>
        <div className={mobileStyles.subHeaderSpacer} />
      </div>
      <div className={mobileStyles.form}>
        <div className={mobileStyles.section}>
          <p>Статус push: {nativeInfo.pushStatus}</p>
          <button type="button" className={mobileStyles.saveButton} onClick={onEnablePush}>
            Подключить push
          </button>
          <p className={mobileStyles.menuRowHint}>
            Для доставки уведомлений требуется настройка FCM/APNs на backend.
          </p>
        </div>
      </div>
    </div>
  );
}
