// pages/api/tbank/shop.js
import { tbankGetShopByShopCode } from './_client';

export const config = { api: { bodyParser: false } };

const DEBUG = String(process.env.TBANK_DEBUG || '').toLowerCase() === '1' || String(process.env.TBANK_DEBUG || '').toLowerCase() === 'true';
function dlog(...args) { if (DEBUG) console.log('[TBANK][shop]', ...args); }

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // Поддержим и ?code=, и ?shopCode=, но ожидаем именно ЧИСЛО
    const qCode = (req.query?.code || '').toString().trim();
    const shopCode = (req.query?.shopCode || qCode).toString().trim();

    if (!shopCode) return res.status(400).json({ error: 'shopCode is required' });
    if (!/^\d+$/.test(shopCode)) {
      dlog('WARNING: non-numeric code:', shopCode);
      return res.status(400).json({ error: 'Передайте ЧИСЛОВОЙ shopCode (банковский идентификатор точки)' });
    }

    dlog('Incoming shopCode:', shopCode);
    const data = await tbankGetShopByShopCode(shopCode);
    return res.status(200).json({ ok: true, shopCode, payload: data });
  } catch (err) {
    const status = err?.response?.status || 400;
    dlog('ERROR status:', status);
    dlog('ERROR body:', JSON.stringify(err?.response?.data || {}, null, 2));
    return res.status(status).json({ error: err?.message || 'Ошибка получения информации о точке', details: err?.response?.data });
  }
}
