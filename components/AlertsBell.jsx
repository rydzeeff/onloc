import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

function BellIcon({ count = 0, scale = 1, className = '' }) {
  const n = Number(count || 0);
  return (
    <svg className={className} style={{ transform: `scale(${scale})` }} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4a5 5 0 0 0-5 5v2.2c0 .9-.3 1.8-.8 2.6l-.7 1a1 1 0 0 0 .8 1.6h11.4a1 1 0 0 0 .8-1.6l-.7-1a4.7 4.7 0 0 1-.8-2.6V9a5 5 0 0 0-5-5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      {n > 0 ? <circle cx="18" cy="6" r="3" fill="#ef4444" /> : null}
    </svg>
  );
}

export default function AlertsBell({
  user,
  count = 0,
  buttonClassName = '',
  iconWrapClassName = '',
  iconClassName = '',
  scale = 1,
  mobileEdgeToEdge = false,
  onBeforeOpen,
  onOpenChange,
}) {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [freshIds, setFreshIds] = useState(new Set());
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const rootRef = useRef(null);

  const load = async (nextLimit = limit) => {
    if (!user?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('trip_alerts')
      .select('id, title, body, created_at, is_read')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(nextLimit);

    if (!error) {
      const unread = new Set((data || []).filter((a) => !a.is_read).map((a) => a.id));
      setAlerts(data || []);
      setFreshIds((prev) => new Set([...prev, ...unread]));
      await supabase
        .from('trip_alerts')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('is_read', false);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!open) return;
    load(limit);
    const channel = supabase
      .channel(`trip_alerts_popup:${user?.id || 'anon'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_alerts', filter: `user_id=eq.${user?.id}` }, () => load(limit))
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [open, user?.id, limit]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(max-width: 768px)');
    const sync = () => setIsNarrowViewport(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onOpenChange]);

  const hasMoreButton = useMemo(() => alerts.length >= limit, [alerts.length, limit]);
  const useEdgePanel = mobileEdgeToEdge && isNarrowViewport;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => {
          if (!open) onBeforeOpen?.();
          setOpen((v) => {
            const next = !v;
            onOpenChange?.(next);
            return next;
          });
        }}
        aria-label="Оповещения"
        title="Оповещения"
      >
        <span className={iconWrapClassName}>
          <BellIcon count={count} scale={scale} className={iconClassName} />
        </span>
      </button>

      {open ? (
        <div
          style={useEdgePanel
            ? {
                position: 'fixed',
                left: 0,
                right: 0,
                top: 'max(env(safe-area-inset-top, 0px), 0px)',
                bottom: 0,
                width: '100vw',
                maxWidth: '100vw',
                background: '#fff',
                border: '1px solid #e5e7eb',
                borderRadius: 0,
                boxShadow: '0 10px 24px rgba(0,0,0,.14)',
                zIndex: 1000010,
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
              }
            : { position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 360, maxWidth: '92vw', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, boxShadow: '0 10px 24px rgba(0,0,0,.14)', zIndex: 1000010, padding: 12, display: 'flex', flexDirection: 'column' }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Оповещения</div>
          <div style={{ maxHeight: useEdgePanel ? 'calc(100vh - max(env(safe-area-inset-top, 0px), 0px) - 176px)' : 320, overflow: 'auto' }}>
            {!alerts.length && !loading ? <div style={{ fontSize: 14, opacity: 0.7 }}>Пока оповещений нет.</div> : null}
            {alerts.map((a) => (
              <div key={a.id} style={{ border: freshIds.has(a.id) ? '2px solid #22c55e' : '1px solid #e7e7e7', borderRadius: 12, padding: 10, marginBottom: 8, background: freshIds.has(a.id) ? '#f0fdf4' : '#fff' }}>
                <div style={{ fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span>{a.title}</span>
                  {freshIds.has(a.id) ? <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700 }}>НОВОЕ</span> : null}
                </div>
                <div style={{ marginTop: 4, fontSize: 14 }}>{a.body}</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6 }}>{new Date(a.created_at).toLocaleString('ru-RU')}</div>
              </div>
            ))}
          </div>
          {hasMoreButton ? (
            <button
              type="button"
              style={{ marginTop: 8, width: '100%', border: '1px solid #d1d5db', background: '#f9fafb', borderRadius: 10, padding: '9px 10px', fontWeight: 600 }}
              onClick={() => setLimit((v) => v + 10)}
            >
              Показать ещё 10 оповещений
            </button>
          ) : null}
          <button
            type="button"
            style={{ marginTop: 10, width: '100%', border: '1px solid #d1d5db', background: '#fff', borderRadius: 10, padding: '10px 12px', fontWeight: 600, marginBottom: useEdgePanel ? 'calc(8px + env(safe-area-inset-bottom, 0px))' : 4 }}
            onClick={() => {
              setOpen(false);
              onOpenChange?.(false);
            }}
          >
            Закрыть
          </button>
        </div>
      ) : null}
    </div>
  );
}
