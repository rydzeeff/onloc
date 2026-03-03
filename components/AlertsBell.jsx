import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

function BellIcon({ count = 0, scale = 1, className = '' }) {
  const n = Number(count || 0);
  const label = n > 99 ? '99+' : String(n);
  return (
    <svg className={className} style={{ transform: `scale(${scale})` }} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a5 5 0 0 0-5 5v2.4c0 .7-.2 1.4-.6 2l-1.1 1.7c-.5.8 0 1.9.9 1.9h11.6c.9 0 1.4-1.1.9-1.9l-1.1-1.7a3.7 3.7 0 0 1-.6-2V8a5 5 0 0 0-5-5Z" fill={n > 0 ? '#ef4444' : 'none'} stroke={n > 0 ? '#ef4444' : 'currentColor'} strokeWidth="2"/>
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      {n > 0 ? <text x="12" y="11.5" textAnchor="middle" fontSize={label.length >= 3 ? '6' : '8'} fontWeight="700" fill="#fff">{label}</text> : null}
    </svg>
  );
}

export default function AlertsBell({
  user,
  count = 0,
  buttonClassName = '',
  iconClassName = '',
  scale = 1,
  onBeforeOpen,
}) {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [freshIds, setFreshIds] = useState(new Set());
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(false);
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
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const hasMoreButton = useMemo(() => alerts.length >= limit, [alerts.length, limit]);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => {
          if (!open) onBeforeOpen?.();
          setOpen((v) => !v);
        }}
        aria-label="Оповещения"
        title="Оповещения"
      >
        <BellIcon count={count} scale={scale} className={iconClassName} />
      </button>

      {open ? (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 360, maxWidth: '92vw', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, boxShadow: '0 10px 24px rgba(0,0,0,.14)', zIndex: 3000, padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Оповещения</div>
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
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
        </div>
      ) : null}
    </div>
  );
}
