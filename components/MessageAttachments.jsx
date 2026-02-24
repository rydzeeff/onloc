// components/MessageAttachments.jsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import commonStyles from "../styles/messages-common.module.css";

function fileNameFromPath(path = "") {
  try {
    const parts = path.split("/");
    return parts[parts.length - 1] || "file";
  } catch {
    return "file";
  }
}

/**
 * Рендер вложений:
 * - Картинки/видео — внутри сообщения (inline, с controls)
 * - Документы — кликабельной ссылкой по имени файла
 * - Под вложениями — мягкое уведомление об удалении через 5 дней после окончания поездки
 */
function VoiceMiniPlayer({ src }) {
  const audioRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(0);
  const [cur, setCur] = useState(0);

  const syncDuration = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const d = a.duration;
    if (Number.isFinite(d) && d > 0) {
      setDur(d);
      setReady(true);
    }
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    // сброс при смене src
    setReady(false);
    setPlaying(false);
    setCur(0);
    setDur(0);

    const onLoaded = () => syncDuration();
    const onDur = () => syncDuration();
    const onCanPlay = () => syncDuration();
    const onTime = () => setCur(a.currentTime || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);

    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("durationchange", onDur);
    a.addEventListener("canplay", onCanPlay);
    a.addEventListener("canplaythrough", onCanPlay);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);

    // ✅ “пинок” — браузер иногда не грузит metadata пока явно не попросишь
    try { a.load(); } catch {}

    const t = setTimeout(() => {
      // если всё ещё 0 — пробуем ещё раз
      if (!Number.isFinite(a.duration) || a.duration <= 0) {
        try { a.load(); } catch {}
      } else {
        syncDuration();
      }
    }, 350);

    return () => {
      clearTimeout(t);
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("durationchange", onDur);
      a.removeEventListener("canplay", onCanPlay);
      a.removeEventListener("canplaythrough", onCanPlay);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
    };
  }, [src, syncDuration]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;

    // если duration не подхватилась — попробуем подгрузить ещё раз перед play
    if ((!Number.isFinite(a.duration) || a.duration <= 0) && !ready) {
      try { a.load(); } catch {}
    }

    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !dur) return;
    const v = Number(e.target.value || 0);
    a.currentTime = (v / 1000) * dur;
  };

  const fmt = (t) => {
    const s = Math.max(0, Math.floor(t || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const progress = dur > 0 ? Math.min(1000, Math.max(0, (cur / dur) * 1000)) : 0;

 return (
  <div style={{ width: "100%" }}>
    {/* TOP: play + slider */}
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button
        type="button"
        onClick={toggle}
        disabled={!ready && !src}
        title={playing ? "Пауза" : "Воспроизвести"}
        aria-label={playing ? "Пауза" : "Воспроизвести"}
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          border: "1px solid #e2e8f0",
          background: "#fff",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 auto",
        }}
      >
        {playing ? (
          <span style={{ fontWeight: 900, fontSize: 14 }}>❚❚</span>
        ) : (
          <span style={{ fontWeight: 900, fontSize: 14, marginLeft: 2 }}>▶</span>
        )}
      </button>

      <input
        type="range"
        min={0}
        max={1000}
        value={progress}
        onChange={seek}
        disabled={!ready || dur === 0}
        style={{ flex: 1, minWidth: 120 }}
      />
    </div>

    {/* BOTTOM: time under slider */}
    <div
      style={{
        marginTop: 6,
        fontSize: 12,
        color: "#64748b",
        textAlign: "right",
        paddingRight: 2,
      }}
    >
      {fmt(cur)} / {fmt(dur)}
    </div>

    <audio ref={audioRef} src={src} preload="auto" crossOrigin="anonymous" />
  </div>
);
}

export default function MessageAttachments({ files = [], signFileUrl, showDeleteNote = true }) {
  const [items, setItems] = useState(files);

  useEffect(() => setItems(files), [files]);

  // Подписываем недостающие ссылки
   useEffect(() => {
    if (!signFileUrl) return;

    const need = (items || []).filter((f) => f && !f?.signed_url);
    if (!need.length) return;

    let cancelled = false;

    (async () => {
      const enriched = await Promise.all(
        (items || []).map(async (f) => {
          if (!f) return f;
          if (f.signed_url) return f;
          try {
            const url = await signFileUrl(f.bucket, f.path);
            return { ...f, signed_url: url || null };
          } catch {
            return f;
          }
        })
      );

      if (!cancelled) setItems(enriched);
    })();

    return () => {
      cancelled = true;
    };
  }, [items, signFileUrl]);


   const groups = useMemo(() => {
    const imgs = [];
    const vids = [];
    const audios = [];
    const docs = [];

    for (const f of items || []) {
      if (!f) continue;
      const mime = (f?.mime || "").toLowerCase();
      const url = f?.signed_url || null;

      if (mime.startsWith("audio/")) {
        // ✅ аудио добавляем даже без url (покажем плейсхолдер)
        audios.push({ ...f, url });
        continue;
      }

      // для остальных без url смысла нет
      if (!url) continue;

      if (mime.startsWith("image/")) imgs.push({ ...f, url });
      else if (mime.startsWith("video/")) vids.push({ ...f, url });
      else docs.push({ ...f, url });
    }

    return { imgs, vids, audios, docs };
  }, [items]);



  if (!items?.length) return null;

  return (
    <>
      {/* IMG + VIDEO grid */}
      {(groups.imgs.length > 0 || groups.vids.length > 0) && (
        <div className={commonStyles.attachmentsGrid}>
          {groups.imgs.map((a, idx) => (
            <a
              key={`${a.id ?? `${a.bucket}:${a.path}`}-img-${idx}`}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className={commonStyles.attachment}
              title={fileNameFromPath(a.path)}
            >
              <img
                src={a.url}
                alt={fileNameFromPath(a.path) || "image"}
                className={commonStyles.attachmentImage}
                loading="lazy"
              />
            </a>
          ))}

          {groups.vids.map((a, idx) => (
            <div
              key={`${a.id ?? `${a.bucket}:${a.path}`}-vid-${idx}`}
              className={commonStyles.attachment}
              title={fileNameFromPath(a.path)}
            >
              <video src={a.url} controls playsInline className={commonStyles.attachmentVideo} />
            </div>
          ))}
        </div>
      )}

{/* AUDIO (отдельно, чтобы показывалось даже если только голосовое) */}
{groups.audios.length > 0 && (
  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
    {groups.audios.map((a, idx) => (
      <div
        key={`${a.id ?? `${a.bucket}:${a.path}`}-aud-${idx}`}
        className={commonStyles.attachment}
        style={{ padding: 10, width: 320, maxWidth: "100%", boxSizing: "border-box" }}
      >
        {a.url ? (
          <VoiceMiniPlayer src={a.url} />
        ) : (
          <div style={{ fontSize: 12, color: "#64748b", padding: "8px 0" }}>
            Загрузка голосового…
          </div>
        )}
      </div>
    ))}
  </div>
)}


      {/* DOCS */}
      {groups.docs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {groups.docs.map((a, idx) => (
            <a
              key={`${a.id ?? `${a.bucket}:${a.path}`}-doc-${idx}`}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className={commonStyles.attachmentFile}
              title={fileNameFromPath(a.path)}
            >
              {fileNameFromPath(a.path)}
            </a>
          ))}
        </div>
      )}

{showDeleteNote &&
  (groups.imgs.length > 0 || groups.vids.length > 0 || groups.docs.length > 0) && (
    <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>
      Файл будет удалён через 5 дней после окончания поездки.
    </div>
  )}
    </>
  );
}
