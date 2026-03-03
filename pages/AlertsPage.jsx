import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function AlertsPage({ user }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [freshIds, setFreshIds] = useState(new Set());

  useEffect(() => {
    if (!user?.id) return;

    let mounted = true;

    const load = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('trip_alerts')
        .select('id, title, body, created_at, is_read')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100);

      if (!mounted) return;
      if (error) {
        console.error('[AlertsPage] load failed:', error.message);
        setAlerts([]);
      } else {
        const unread = new Set((data || []).filter((a) => !a.is_read).map((a) => a.id));
        setAlerts(data || []);
        setFreshIds((prev) => new Set([...prev, ...unread]));
      }
      setLoading(false);

      await supabase
        .from('trip_alerts')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('is_read', false);
    };

    load();

    const channel = supabase
      .channel(`public:trip_alerts:list:${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_alerts', filter: `user_id=eq.${user.id}` }, load)
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  if (loading) return <div style={{ padding: 16 }}>Загрузка оповещений…</div>;

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginBottom: 12 }}>Оповещения</h2>
      {!alerts.length && <p>Новых оповещений пока нет.</p>}
      {alerts.map((a) => (
        <div key={a.id} style={{ border: freshIds.has(a.id) ? '2px solid #22c55e' : '1px solid #e7e7e7', borderRadius: 12, padding: 12, marginBottom: 10, background: freshIds.has(a.id) ? '#f0fdf4' : (a.is_read ? '#fff' : '#f7fbff') }}>
          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{a.title}</span>
            {freshIds.has(a.id) ? <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700 }}>НОВОЕ</span> : null}
          </div>
          <div style={{ marginTop: 4 }}>{a.body}</div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>{new Date(a.created_at).toLocaleString('ru-RU')}</div>
        </div>
      ))}
    </div>
  );
}
