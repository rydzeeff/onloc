import { useState, useRef, useEffect } from 'react';
import styles from '../styles/avatar-editor.mobile.module.css';

const AvatarEditorMobile = ({
  user,
  avatarUrl,
  updateAvatarUrl,
  supabase,
  type = 'individual', // 'individual' | 'company'
  canEditAvatar = true,
}) => {
  const [step, setStep] = useState('view'); // 'view' | 'crop' | 'uploading'
  const [selectedImage, setSelectedImage] = useState(null); // blob url
  const [message, setMessage] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const fileInputRef = useRef(null);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const overlayRef = useRef(null);
  const saveButtonRef = useRef(null);
  const cancelButtonRef = useRef(null);

  const [crop, setCrop] = useState({
    x: 0,
    y: 0,
    scale: 1,
    startX: 0,
    startY: 0,
    distance: 0,
  });

  // Помогает понимать “ждём ли мы результат выбора”
  const pendingPickRef = useRef(false);
  const pickWatchIntervalRef = useRef(null);
  const pickWatchTimeoutRef = useRef(null);
  const debugEnabledRef = useRef(false);

  const readDebugEnabled = () => {
    if (typeof window === 'undefined') return false;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('avatarDebug') === '1') return true;
      if (params.get('avatarDebug') === '0') return false;
      return window.localStorage?.getItem('onloc_avatar_debug') === '1';
    } catch (_) {
      return false;
    }
  };

  const persistDebugEntry = (entry) => {
    if (typeof window === 'undefined') return;
    try {
      const key = 'onloc_avatar_debug_logs';
      const raw = window.localStorage?.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      const next = [...list, entry].slice(-250);
      window.localStorage?.setItem(key, JSON.stringify(next));
      window.__onlocAvatarDebugLogs = next;
    } catch (_) {}
  };

  const logDebug = (event, payload = {}, level = 'log') => {
    if (!debugEnabledRef.current) return;

    const entry = {
      ts: new Date().toISOString(),
      event,
      payload,
      level,
    };

    const logger =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logger('[AvatarDebug]', event, payload);
    persistDebugEntry(entry);
  };

  const toast = (text, ms = 3000) => {
    setMessage(text);
    if (text) setTimeout(() => setMessage(null), ms);
  };

  const galleryAccept = '.jpg,.jpeg,.png,.webp,.bmp,.gif';

  useEffect(() => {
    debugEnabledRef.current = readDebugEnabled();

    if (typeof window === 'undefined') return;

    if (debugEnabledRef.current) {
      logDebug('debug_enabled', {
        userAgent: window.navigator?.userAgent,
        href: window.location?.href,
      });
    }

    window.onlocAvatarDebugDump = () => {
      try {
        const logs = JSON.parse(window.localStorage?.getItem('onloc_avatar_debug_logs') || '[]');
        console.log('[AvatarDebug][dump]', logs);
        return logs;
      } catch (_) {
        return [];
      }
    };

    window.onlocAvatarDebugClear = () => {
      try {
        window.localStorage?.removeItem('onloc_avatar_debug_logs');
        window.__onlocAvatarDebugLogs = [];
      } catch (_) {}
    };

    const onWindowError = (event) => {
      logDebug(
        'window_error',
        {
          message: event?.message,
          filename: event?.filename,
          lineno: event?.lineno,
          colno: event?.colno,
        },
        'error'
      );
    };

    const onUnhandledRejection = (event) => {
      logDebug('unhandled_rejection', { reason: String(event?.reason || '') }, 'error');
    };

    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Освобождаем blob-url, чтобы не текла память
  useEffect(() => {
    return () => {
      if (selectedImage && typeof selectedImage === 'string' && selectedImage.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(selectedImage);
        } catch (_) {}
      }
    };
  }, [selectedImage]);

  const processPickedFile = (file, inputEl) => {
    if (!file) return false;

    // если раньше был blob-url — освобождаем
    if (selectedImage && typeof selectedImage === 'string' && selectedImage.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(selectedImage);
      } catch (_) {}
    }

    logDebug('process_picked_file', {
      fileName: file?.name,
      fileType: file?.type,
      fileSize: file?.size,
    });

    const url = URL.createObjectURL(file);
    setSelectedImage(url);
    setStep('crop');

    // ВАЖНО: очищаем value ПОСЛЕ обработки, чтобы следующий выбор того же файла сработал,
    // но при этом не ломаем камеру (на некоторых Android очистка ДО выбора мешает).
    if (inputEl) {
      setTimeout(() => {
        try {
          inputEl.value = '';
        } catch (_) {}
      }, 0);
    }

    pendingPickRef.current = false;
    return true;
  };

  const tryPickFromInput = () => {
    const input = fileInputRef.current;
    const file = input?.files?.[0];
    if (file) return processPickedFile(file, input);
    return false;
  };

  const clearPickWatch = (reason = 'manual') => {
    logDebug('pick_watch_clear', { reason });

    if (pickWatchIntervalRef.current) {
      clearInterval(pickWatchIntervalRef.current);
      pickWatchIntervalRef.current = null;
    }
    if (pickWatchTimeoutRef.current) {
      clearTimeout(pickWatchTimeoutRef.current);
      pickWatchTimeoutRef.current = null;
    }
  };

  const startPickWatch = () => {
    clearPickWatch('restart');
    logDebug('pick_watch_start');

    pickWatchIntervalRef.current = setInterval(() => {
      if (!pendingPickRef.current) {
        clearPickWatch('pending_false');
        return;
      }

      if (tryPickFromInput()) {
        clearPickWatch('file_detected');
      }
    }, 250);

    pickWatchTimeoutRef.current = setTimeout(() => {
      clearPickWatch('timeout');
    }, 15000);
  };

  const handleImageSelect = (e) => {
    const input = e?.currentTarget || e?.target;
    const file = input?.files?.[0];

    logDebug('input_event', {
      eventType: e?.type,
      filesLength: input?.files?.length || 0,
      hasFile: Boolean(file),
    });
    if (!file) {
      logDebug('input_event_without_file', { eventType: e?.type }, 'warn');
      startPickWatch();
      return;
    }

    const isImageByMime = String(file.type || '').startsWith('image/');
    const isImageByName = /\.(jpe?g|png|webp|bmp|gif)$/i.test(String(file.name || ''));

    if (!isImageByMime && !isImageByName) {
      logDebug(
        'invalid_file_type',
        { fileName: file?.name, fileType: file?.type, fileSize: file?.size },
        'warn'
      );
      toast('Выберите файл изображения из галереи');
      try {
        input.value = '';
      } catch (_) {}
      pendingPickRef.current = false;
      clearPickWatch();
      return;
    }

    processPickedFile(file, input);
  };

  /**
   * Android / Яндекс / WebView:
   * после камеры/редактора `change` может не прилететь, а files появиться позже.
   * Поэтому делаем "длинную серию" проверок + pageshow.
   */
  useEffect(() => {
    const burstTry = () => {
      if (step !== 'view' && step !== 'crop') return;
      logDebug('burst_try', { step, visibility: document.visibilityState });

      // серия попыток — на реальных устройствах files может появиться через 1–3 сек
      [0, 80, 200, 450, 900, 1600, 2500, 4000].forEach((ms) => {
        setTimeout(() => {
          // если мы в режиме ожидания выбора (или просто вернулись с камеры) — пробуем
          if (pendingPickRef.current || document.visibilityState === 'visible') {
            tryPickFromInput();
          }
        }, ms);
      });
    };

    const onFocus = () => burstTry();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') burstTry();
    };
    const onPageShow = () => burstTry(); // важно для некоторых браузеров

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      clearPickWatch('effect_cleanup');
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Рисуем кроп
  useEffect(() => {
    if (step !== 'crop' || !selectedImage) return;

    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const canvasSize = Math.min(window.innerWidth, window.innerHeight) * 0.9;
      canvas.width = canvasSize;
      canvas.height = canvasSize;

      const imgW = img.naturalWidth || img.width;
      const imgH = img.naturalHeight || img.height;
      if (!imgW || !imgH) return;

      const imgAspect = imgW / imgH;
      let drawWidth, drawHeight;

      if (imgAspect > 1) {
        drawWidth = canvasSize * crop.scale;
        drawHeight = drawWidth / imgAspect;
      } else {
        drawHeight = canvasSize * crop.scale;
        drawWidth = drawHeight * imgAspect;
      }

      const offsetX = (canvasSize - drawWidth) / 2 + crop.x;
      const offsetY = (canvasSize - drawHeight) / 2 + crop.y;

      ctx.clearRect(0, 0, canvasSize, canvasSize);
      ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

      // круглая маска
      ctx.globalCompositeOperation = 'destination-in';
      ctx.beginPath();
      ctx.arc(canvasSize / 2, canvasSize / 2, canvasSize / 2 - 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      // обводка
      ctx.beginPath();
      ctx.arc(canvasSize / 2, canvasSize / 2, canvasSize / 2 - 10, 0, Math.PI * 2);
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 4;
      ctx.stroke();
    };

    img.onload = draw;
    if (img.complete) draw();
  }, [step, selectedImage, crop]);

  // Touch-управление кропом
  useEffect(() => {
    if (step !== 'crop') return;

    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    const saveButton = saveButtonRef.current;
    const cancelButton = cancelButtonRef.current;

    if (!overlay || !canvas || !saveButton || !cancelButton) return;

    const handleOverlayTouchStart = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleOverlayTouchMove = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleCanvasTouchStart = (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.touches.length === 1) {
        const touch = e.touches[0];
        setCrop((prev) => ({ ...prev, startX: touch.clientX, startY: touch.clientY }));
      } else if (e.touches.length === 2) {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const distance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        setCrop((prev) => ({ ...prev, distance }));
      }
    };

    const handleCanvasTouchMove = (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.touches.length === 1) {
        const touch = e.touches[0];
        setCrop((prev) => ({
          ...prev,
          x: prev.x + (touch.clientX - prev.startX),
          y: prev.y + (touch.clientY - prev.startY),
          startX: touch.clientX,
          startY: touch.clientY,
        }));
      } else if (e.touches.length === 2) {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const newDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

        setCrop((prev) => {
          const base = prev.distance || newDistance;
          const nextScale = prev.scale * (newDistance / base);
          return {
            ...prev,
            scale: Math.max(1, Math.min(3, nextScale)),
            distance: newDistance,
          };
        });
      }
    };

    const handleSaveClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSaveCrop();
    };

    const handleCancelClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
    };

    overlay.addEventListener('touchstart', handleOverlayTouchStart, { passive: false });
    overlay.addEventListener('touchmove', handleOverlayTouchMove, { passive: false });
    canvas.addEventListener('touchstart', handleCanvasTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleCanvasTouchMove, { passive: false });
    saveButton.addEventListener('touchstart', handleSaveClick, { passive: false });
    cancelButton.addEventListener('touchstart', handleCancelClick, { passive: false });

    return () => {
      overlay.removeEventListener('touchstart', handleOverlayTouchStart);
      overlay.removeEventListener('touchmove', handleOverlayTouchMove);
      canvas.removeEventListener('touchstart', handleCanvasTouchStart);
      canvas.removeEventListener('touchmove', handleCanvasTouchMove);
      saveButton.removeEventListener('touchstart', handleSaveClick);
      cancelButton.removeEventListener('touchstart', handleCancelClick);
      // reset pinch distance for next time
      setCrop((prev) => ({ ...prev, distance: 0 }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const handleSaveCrop = async () => {
    logDebug('save_crop_start', { type });
    setStep('uploading');
    setIsLoading(true);

    if (!supabase || !user?.id) {
      logDebug('save_crop_no_session', { hasSupabase: Boolean(supabase), userId: user?.id }, 'error');
      toast('Нет активной сессии. Перезайдите в аккаунт.');
      setStep('view');
      setIsLoading(false);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      logDebug('save_crop_no_canvas', {}, 'error');
      toast('Ошибка: нет данных изображения.');
      setStep('view');
      setIsLoading(false);
      return;
    }

    const cropSize = canvas.width - 20;
    const croppedCanvas = document.createElement('canvas');
    const croppedCtx = croppedCanvas.getContext('2d');

    if (!croppedCtx) {
      logDebug('save_crop_no_context', {}, 'error');
      toast('Ошибка подготовки изображения.');
      setStep('view');
      setIsLoading(false);
      return;
    }

    croppedCanvas.width = cropSize;
    croppedCanvas.height = cropSize;

    croppedCtx.drawImage(canvas, 10, 10, cropSize, cropSize, 0, 0, cropSize, cropSize);

    const blob = await new Promise((resolve) => croppedCanvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) {
      logDebug('save_crop_blob_failed', {}, 'error');
      toast('Ошибка: не удалось создать файл изображения.');
      setStep('view');
      setIsLoading(false);
      return;
    }

    const file = new File([blob], `avatar-${Date.now()}.jpg`, { type: 'image/jpeg' });

    const bucket = type === 'individual' ? 'avatars' : 'avatar-company';
    const uploadPath = `${user.id}/avatar-${Date.now()}.jpg`;

    const { data: existingFiles } = await supabase.storage.from(bucket).list(user.id);
    if (existingFiles?.length) {
      await supabase.storage.from(bucket).remove(existingFiles.map((f) => `${user.id}/${f.name}`));
    }

    const { error: uploadError } = await supabase.storage.from(bucket).upload(uploadPath, file, { upsert: true });
    if (uploadError) {
      logDebug('upload_error', { message: uploadError?.message, bucket, uploadPath }, 'error');
      toast('Ошибка загрузки аватара');
      setStep('view');
      setIsLoading(false);
      return;
    }

    const { publicUrl } = supabase.storage.from(bucket).getPublicUrl(uploadPath).data;

    let updateError = null;

    if (type === 'individual') {
      const res = await supabase
        .from('profiles')
        .upsert({ user_id: user.id, avatar_url: publicUrl }, { onConflict: 'user_id' });
      updateError = res.error;
    } else {
      const { data: activeCompany, error: fetchErr } = await supabase
        .from('mycompany')
        .select('company_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchErr) {
        updateError = fetchErr;
      } else if (!activeCompany?.company_id) {
        updateError = new Error('Сначала сохраните организацию (вкладка «Компании»), затем загрузите аватар.');
      } else {
        const upd = await supabase
          .from('mycompany')
          .update({ avatar_url: publicUrl })
          .eq('company_id', activeCompany.company_id);
        updateError = upd.error;
      }
    }

    if (updateError) {
      logDebug('profile_update_error', { message: updateError?.message, type }, 'error');
      toast(updateError?.message ? `Ошибка сохранения аватара: ${updateError.message}` : 'Ошибка сохранения аватара');
    } else {
      logDebug('avatar_update_success', { publicUrl, type });
      updateAvatarUrl?.(publicUrl);
      toast('Аватар успешно обновлён');
      setStep('view');
      setSelectedImage(null);
    }

    setIsLoading(false);
  };

  const handleCancel = () => {
    logDebug('crop_cancel');
    setStep('view');
    setSelectedImage(null);
    pendingPickRef.current = false;
  };

  return (
    <div className={styles.avatarWrapper}>
      {step === 'view' && (
        <div
          className={styles.avatarContainer}
          onClick={(e) => {
            if (!canEditAvatar) {
              e.preventDefault();
              e.stopPropagation();
              toast(
                type === 'company'
                  ? 'Сначала сохраните организацию, затем загрузите аватар.'
                  : 'Недоступно'
              );
            }
          }}
        >
          <img
            src={avatarUrl}
            alt={`Аватар ${type === 'individual' ? 'пользователя' : 'компании'}`}
          />
          <span className={styles.editIcon}>✎</span>

          {/* ВАЖНО: это реальный input поверх аватара — самый стабильный вариант для Android камеры */}
          <input
            ref={fileInputRef}
            type="file"
            // Не используем image/*, чтобы не провоцировать системный сценарий "Снять фото".
            // На части браузеров это снижает шанс показа камеры и оставляет выбор готового файла.
            accept={galleryAccept}
            className={styles.fileOverlay}
            onPointerDown={(e) => {
              // фиксируем ожидание результата выбора
              if (!canEditAvatar) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              pendingPickRef.current = true;
              logDebug('input_pointer_down');
              startPickWatch();
            }}
            onClick={(e) => {
              if (!canEditAvatar) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              // НИЧЕГО НЕ СБРАСЫВАЕМ ЗДЕСЬ — это как раз может ломать камеру на Android
              pendingPickRef.current = true;
              logDebug('input_click');
              startPickWatch();
            }}
            onChange={handleImageSelect}
            onInput={handleImageSelect} // страховка для Android/WebView
          />
        </div>
      )}

      {step === 'crop' && (
        <div ref={overlayRef} className={styles.cropOverlay}>
          <canvas ref={canvasRef} className={styles.cropCanvas} />
          <img ref={imgRef} src={selectedImage} alt="" style={{ display: 'none' }} />
          <div className={styles.cropControls}>
            <button ref={saveButtonRef} disabled={isLoading}>
              Сохранить
            </button>
            <button ref={cancelButtonRef} disabled={isLoading}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {step === 'uploading' && (
        <div className={styles.loadingOverlay}>
          <div className={styles.spinner}></div>
          <p>Загрузка...</p>
        </div>
      )}

      {message && <div className={styles.toast}>{message}</div>}
    </div>
  );
};

export default AvatarEditorMobile;