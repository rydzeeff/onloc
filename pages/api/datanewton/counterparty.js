// pages/api/datanewton/counterparty.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { inn } = req.query || {};
    const innStr = String(inn || '').trim();

    if (!innStr || !/^\d{10}(\d{2})?$/.test(innStr)) {
      return res.status(400).json({ error: 'Bad request: invalid INN (10 for org, 12 for sole prop)' });
    }

    const apiKey = process.env.DATANEWTON_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfigured: DATANEWTON_API_KEY is missing' });
    }

    const base = 'https://api.datanewton.ru/v1/counterparty';

    // Важно: у ИП структура/блоки часто отличаются от юрлиц.
    // Для 10-значного ИНН (юрлицо): OWNER_BLOCK, ADDRESS_BLOCK
    // Для 12-значного ИНН (ИП): пробуем INDIVIDUAL_BLOCK, ADDRESS_BLOCK
    // Если сервис ругнётся на фильтры — делаем ретрай без фильтров (или только ADDRESS_BLOCK).
    const isIp = /^\d{12}$/.test(innStr);

    const buildUrl = (filters) => {
      const qp = new URLSearchParams();
      qp.set('key', apiKey);
      if (filters) qp.set('filters', filters);
      qp.set('inn', innStr);
      return `${base}?${qp.toString()}`;
    };

    const tryFetch = async (filters) => {
      const url = buildUrl(filters);
      const r = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });

      const text = await r.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }

      return { r, json };
    };

    // primary attempt
    const primaryFilters = isIp ? 'INDIVIDUAL_BLOCK,ADDRESS_BLOCK' : 'OWNER_BLOCK,ADDRESS_BLOCK';
    let { r, json } = await tryFetch(primaryFilters);

    // retry strategy for IP only (не ломаем то, что уже работает для ООО)
    if (!r.ok && isIp) {
      // 1) ретрай только с ADDRESS_BLOCK
      ({ r, json } = await tryFetch('ADDRESS_BLOCK'));

      // 2) если снова не ок — ретрай вообще без filters
      if (!r.ok) {
        ({ r, json } = await tryFetch(null));
      }
    }

    if (!r.ok) {
      return res.status(r.status).json({ error: json?.error || `DataNewton ${r.status}`, payload: json || null });
    }

    return res.status(200).json({ ok: true, source: 'datanewton', payload: json });
  } catch (e) {
    console.error('[DATANEWTON][counterparty] unexpected error:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
