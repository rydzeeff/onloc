// hooks/useChatAttachments.js
// Лёгкий хук для вложений без ffmpeg (видео грузим как есть; изображения — ужимаем на клиенте).
// Создаёт запись в chat_messages, заливает файлы в storage и добавляет строки в chat_message_files.
//
// ✅ Оптимизации скорости/UX:
// 1) Подпись signed_url — кешируется и делается параллельно (Promise.all), а не последовательно.
// 2) Upload файлов — параллельно с ограничением конкуренции (по умолчанию 3), чтобы не ждать по одному.
// 3) Сжатие изображений — выполняется параллельно (внутри лимита), чтобы не блокировать долго.
// 4) Опционально: можно пропустить подпись после upload (если подписываешь позже в messages hook).
//    Сейчас оставил поведение как у тебя: возвращаем savedFiles уже с signed_url.

import { useCallback, useRef, useState } from "react";

function uuid4() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function sanitizeName(name = "") {
  return String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Сжатие изображения до maxDim — JPEG quality
async function compressImageIfNeeded(file, { maxDim = 1600, quality = 0.8 } = {}) {
  try {
    if (!file || !file.type?.startsWith?.("image/")) return file;
    if (typeof window === "undefined") return file;

    const url = URL.createObjectURL(file);
    const img = document.createElement("img");

    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const maxSide = Math.max(w, h);

    if (maxSide <= maxDim) {
      URL.revokeObjectURL(url);
      return file;
    }

    const scale = maxDim / maxSide;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return file;
    }

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);

    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!blob) return file;

    return new File([blob], String(file.name || "image").replace(/\.\w+$/, ".jpg"), {
      type: "image/jpeg",
    });
  } catch {
    return file;
  }
}

// простенький лимитер конкуренции
async function mapLimit(items, limit, mapper) {
  const arr = Array.from(items || []);
  if (!arr.length) return [];
  const out = new Array(arr.length);

  let idx = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (idx < arr.length) {
      const my = idx++;
      out[my] = await mapper(arr[my], my);
    }
  });

  await Promise.all(workers);
  return out;
}

export function useChatAttachments({ supabase, bucket = "trip_chat_files" }) {
  const [pendingFiles, setPendingFiles] = useState([]);
  const [isUploading, setIsUploading] = useState(false);

  const pendingRef = useRef([]);
  const signCacheRef = useRef(new Map()); // key -> { url, expiresAt }

  const onPickFiles = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const next = [...pendingRef.current, ...files];
    pendingRef.current = next;
    setPendingFiles(next);

    e.target.value = ""; // чтобы тот же файл можно было выбрать снова
  }, []);

  // ✅ NEW: программно добавить файлы в pending (например, voice)
  const addPendingFiles = useCallback((files = []) => {
    const arr = Array.from(files || []).filter(Boolean);
    if (!arr.length) return;

    const next = [...pendingRef.current, ...arr];
    pendingRef.current = next;
    setPendingFiles(next);
  }, []);

  const removePending = useCallback((idx) => {
    const next = pendingRef.current.slice();
    next.splice(idx, 1);
    pendingRef.current = next;
    setPendingFiles(next);
  }, []);

  // ✅ Кеш + защита от параллельных одинаковых запросов
  const inflightSignRef = useRef(new Map()); // key -> Promise<string|null>

  const signFileUrl = useCallback(
    async (b, path) => {
      const buck = b || bucket;
      const key = `${buck}:${path}`;

      const cached = signCacheRef.current.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.url;

      const inflight = inflightSignRef.current.get(key);
      if (inflight) return inflight;

      const p = (async () => {
        try {
          const { data, error } = await supabase.storage.from(buck).createSignedUrl(path, 60 * 60 * 8);
          if (error) return null;

          const url = data?.signedUrl || null;
          const ttlMs = (60 * 60 * 8 - 120) * 1000; // 8 часов - 2 минуты буфер
          signCacheRef.current.set(key, { url, expiresAt: Date.now() + ttlMs });

          return url;
        } catch {
          return null;
        } finally {
          inflightSignRef.current.delete(key);
        }
      })();

      inflightSignRef.current.set(key, p);
      return p;
    },
    [supabase, bucket]
  );

  /**
   * ✅ Быстрее:
   * - подписываем файлы параллельно (и кешируем)
   * - обрабатываем сообщения последовательно, но внутри — Promise.all
   */
  const preloadSignedUrlsForMessages = useCallback(
    async (msgs = []) => {
      const list = Array.from(msgs || []);
      if (!list.length) return [];

      // подписываем только то, что реально нужно
      return Promise.all(
        list.map(async (m) => {
          const files = Array.isArray(m.chat_message_files) ? m.chat_message_files : [];
          if (!files.length) return m;

          const enriched = await Promise.all(
            files.map(async (f) => {
              if (!f) return f;
              if (f?.signed_url) return f;
              const url = await signFileUrl(f.bucket, f.path);
              return { ...f, signed_url: url };
            })
          );

          return { ...m, chat_message_files: enriched };
        })
      );
    },
    [signFileUrl]
  );

  // ✅ uploadOne: compress (если image) -> upload -> insert row -> sign
  const uploadOne = useCallback(
    async (file, { tripId, chatId, messageId }) => {
      const isImage = file?.type?.startsWith?.("image/");
      const processed = isImage ? await compressImageIfNeeded(file) : file;

      const key = `${tripId || "no_trip"}/${chatId}/${messageId}/${uuid4()}-${sanitizeName(
        processed?.name || "file"
      )}`;

      const { error: upErr } = await supabase.storage.from(bucket).upload(key, processed, {
        contentType: processed?.type || "application/octet-stream",
        upsert: false,
      });
      if (upErr) throw upErr;

      const { data: row, error: rowErr } = await supabase
        .from("chat_message_files")
        .insert([
          {
            message_id: messageId,
            bucket,
            path: key,
            mime: processed?.type || null,
            size: processed?.size || null,
          },
        ])
        .select()
        .single();

      if (rowErr) throw rowErr;

      // подписываем сразу, но теперь это кеш/дедуп
      const signed_url = await signFileUrl(bucket, key);
      return { ...row, signed_url };
    },
    [supabase, bucket, signFileUrl]
  );

  /**
   * ✅ sendWithMessage ускорено:
   * - файлы грузим параллельно (concurrency 3)
   * - если файлов мало — почти мгновенно
   */
  const sendWithMessage = useCallback(
    async ({ chatId, tripId, userId, text, files: filesOverride }) => {
      if (isUploading) return null;

      try {
        setIsUploading(true);

        const filesToUpload = Array.isArray(filesOverride) ? filesOverride : pendingRef.current;
const list = Array.from(filesToUpload || []).filter(Boolean);

// ✅ фикс "0" для voice: если отправляем только аудио и text === "0" -> пишем пусто
const safeText = typeof text === "string" ? text : "";
const hasFiles = list.length > 0;
const isAudioOnly =
  hasFiles && list.every((f) => String(f?.type || "").startsWith("audio/"));

const contentToSave = isAudioOnly && safeText.trim() === "0" ? "" : safeText;

const { data: message, error: msgErr } = await supabase
  .from("chat_messages")
  .insert([{ chat_id: chatId, user_id: userId, content: contentToSave, read: false }])
  .select()
  .single();

if (msgErr || !message?.id) throw msgErr;

        // ✅ Параллельная загрузка (лимит 3). Если хочешь быстрее — поставь 4-5.
        const savedFiles = list.length
          ? await mapLimit(list, 3, (f) => uploadOne(f, { tripId, chatId, messageId: message.id }))
          : [];

        // чистим pending только если отправляли именно pending (а не override)
        if (!Array.isArray(filesOverride)) {
          pendingRef.current = [];
          setPendingFiles([]);
        }

        return { message, files: savedFiles };
      } catch (e) {
        console.error("Attachments: ошибка отправки:", e);
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [supabase, uploadOne, isUploading]
  );

  return {
    pendingFiles,
    isUploading,
    onPickFiles,
    addPendingFiles,
    removePending,
    sendWithMessage,
    signFileUrl,
    preloadSignedUrlsForMessages,
  };
}
