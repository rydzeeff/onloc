import { useEffect, useMemo, useState } from 'react';
import styles from './ShareButton.module.css';

function ShareIcon({ className }) {
  const fallbackStyle = className ? undefined : { width: 22, height: 22, display: 'block' };
  return (
    <svg className={className} style={fallbackStyle} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M16 6a3 3 0 1 0-2.83-4H13a3 3 0 0 0 .17 1L8.9 7.2a3 3 0 1 0 0 4.6l4.27 4.2A3 3 0 1 0 14 14.1l-4.27-4.2a3.02 3.02 0 0 0 0-1.8L14 3.9A3 3 0 0 0 16 6Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M8 7a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3V7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M16 4H8a3 3 0 0 0-3 3v9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function VkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12.3 17.9h1.2s.36-.04.55-.25c.17-.19.17-.55.17-.55s-.02-1.68.76-1.93c.77-.25 1.76 1.62 2.8 2.34.8.56 1.41.44 1.41.44l2.83-.04s1.48-.1.78-1.25c-.06-.1-.4-.86-2.06-2.39-1.74-1.6-1.51-1.34.6-4.1 1.29-1.68 1.8-2.7 1.64-3.14-.15-.42-1.08-.31-1.08-.31l-3.2.02s-.24-.03-.41.08c-.17.12-.29.38-.29.38s-.5 1.33-1.17 2.46c-1.41 2.38-1.97 2.51-2.2 2.36-.55-.36-.41-1.45-.41-2.23 0-2.42.36-3.43-.71-3.69-.35-.09-.61-.15-1.5-.16-1.14-.02-2.11 0-2.65.26-.36.18-.64.58-.47.61.21.03.68.13.93.48.33.47.32 1.52.32 1.52s.19 2.84-.45 3.19c-.44.24-1.04-.25-2.34-2.4-.67-1.11-1.17-2.34-1.17-2.34s-.1-.24-.28-.37c-.22-.15-.52-.2-.52-.2l-3.05.02s-.46.01-.63.21c-.15.18-.01.56-.01.56s2.39 5.59 5.1 8.39c2.48 2.55 5.3 2.38 5.3 2.38Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TgIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21.9 4.6c.2-.8-.5-1.4-1.2-1.1L2.3 10.8c-.9.4-.8 1.7.1 2l4.9 1.5 1.9 5.9c.3 1 1.6 1.2 2.2.4l2.8-3.4 5.2 3.8c.8.6 1.9.1 2.1-.9l2.4-15.5ZM8.4 13.6l9.7-6.1c.2-.1.5.2.3.4l-7.8 7.5-.3 3.9-1.6-5.2c-.1-.2 0-.4.2-.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

async function copyToClipboard(text) {
  if (!text) return false;

  // 1) Modern Clipboard API (requires secure context and user gesture)
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // continue with fallbacks
  }

  // 2) execCommand fallback (works in many WebViews)
  const tryExecCopy = (el) => {
    try {
      el.focus();
      el.select?.();
      // iOS/WebView often needs explicit range
      el.setSelectionRange?.(0, String(el.value || '').length);
      return document.execCommand('copy');
    } catch {
      return false;
    }
  };

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    const ok = tryExecCopy(ta);
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    // continue
  }

  try {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.top = '0';
    input.style.left = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    document.body.appendChild(input);
    const ok = tryExecCopy(input);
    document.body.removeChild(input);
    if (ok) return true;
  } catch {
    // continue
  }

  // 3) Last resort: prompt with text (user can copy manually)
  try {
    // eslint-disable-next-line no-alert
    window.prompt('Скопируйте ссылку:', text);
    return false;
  } catch {
    return false;
  }
}

/**
 * Современная кнопка "Поделиться":
 * - Копировать ссылку
 * - VK
 * - Telegram
 */
export default function ShareButton({
  title = 'Поделиться',
  text,
  url,
  buttonClassName,
  wrapClassName,
  iconClassName,
  buttonStyle,
  onBeforeOpen,
}) {
  const [open, setOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState(url || '');
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (url) {
      setShareUrl(url);
      return;
    }
    if (typeof window !== 'undefined') {
      setShareUrl(window.location.href);
    }
  }, [url]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const shareText = text || title;

  const vkHref = useMemo(() => {
    const u = encodeURIComponent(shareUrl || '');
    const t = encodeURIComponent(title || '');
    return `https://vk.com/share.php?url=${u}&title=${t}`;
  }, [shareUrl, title]);

  const tgHref = useMemo(() => {
    const u = encodeURIComponent(shareUrl || '');
    const t = encodeURIComponent(shareText || '');
    return `https://t.me/share/url?url=${u}&text=${t}`;
  }, [shareUrl, shareText]);

  const onOpen = () => {
    onBeforeOpen?.();
    setOpen(true);
  };

  const handleCopy = async () => {
    if (!shareUrl) {
      setToast('Ссылка ещё не готова');
      return;
    }
    const ok = await copyToClipboard(shareUrl);
    setToast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать');
    if (ok) setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        onClick={onOpen}
        aria-label="Поделиться"
        title="Поделиться"
        style={
          buttonClassName
            ? { border: 'none', ...buttonStyle }
            : { border: 'none', background: 'transparent', ...buttonStyle }
        }
      >
        {wrapClassName ? (
          <span className={wrapClassName}>
            <ShareIcon className={iconClassName || ''} />
          </span>
        ) : (
          <ShareIcon className={iconClassName || ''} />
        )}
      </button>

      {open && (
        <div
          className={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-label="Поделиться"
          onClick={() => setOpen(false)}
        >
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.header}>
              <h3 className={styles.title}>Поделиться</h3>
              <button
                type="button"
                className={styles.close}
                onClick={() => setOpen(false)}
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>

            <div className={styles.content}>
              <div className={styles.grid}>
                <button type="button" className={styles.item} onClick={handleCopy}>
                  <span className={styles.icon}>
                    <CopyIcon />
                  </span>
                  <span className={styles.label}>
                    <span className={styles.labelTitle}>Скопировать</span>
                    <span className={styles.labelSub}>ссылку</span>
                  </span>
                </button>

                <a
                  className={styles.item}
                  href={vkHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.icon}>
                    <VkIcon />
                  </span>
                  <span className={styles.label}>
                    <span className={styles.labelTitle}>VK</span>
                    <span className={styles.labelSub}>поделиться</span>
                  </span>
                </a>

                <a
                  className={styles.item}
                  href={tgHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.icon}>
                    <TgIcon />
                  </span>
                  <span className={styles.label}>
                    <span className={styles.labelTitle}>Telegram</span>
                    <span className={styles.labelSub}>поделиться</span>
                  </span>
                </a>
              </div>

              <div className={styles.footerHint}>
                {shareUrl ? (
                  <>
                    Ссылка: <b>{shareUrl}</b>
                  </>
                ) : (
                  <>Ссылка ещё не готова.</>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </>
  );
}
