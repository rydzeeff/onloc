// pages/api/tbank/close-deal.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const TBANK_BASE = process.env.TBANK_BASE || 'https://rest-api-test.tinkoff.ru/v2';

// --- utils ---
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const genReqId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const log = (id, ...a) => console.log(`[close-deal][${id}]`, ...a);
const logErr = (id, ...a) => console.error(`[close-deal][${id}]`, ...a);
const mask = (s, a=4, b=4) => (s ? `${String(s).slice(0,a)}…${String(s).slice(-b)}` : s);
const maskKey = (k) => (k ? mask(k,4,4) : k);

// токен = sort(all fields + Password) -> join -> sha256
function makeToken(params) {
  const pwd = process.env.TBANK_SECRET || '';
  const pairs = Object.entries({ ...params, Password: pwd })
    .filter(([k]) => !['Token','DigestValue','SignatureValue','X509SerialNumber','DATA'].includes(k))
    .sort(([a],[b]) => (a<b?-1:a>b?1:0));
  const concat = pairs.map(([,v]) => String(v ?? '')).join('');
  return sha256Hex(concat);
}

async function getTripById(tripId) {
  const { data, error } = await supabase
    .from('trips')
    .select('id, deal_id, status')
    .eq('id', tripId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function archiveTripAndAllChats(tripId) {
  // поездка -> archived
  await supabase.from('trips').update({ status: 'archived' }).eq('id', tripId);

  // все чаты этой поездки (включая dispute) -> archived
  await supabase
    .from('chats')
    .update({
      chat_type: 'archived',
      support_close_confirmed: true,
      support_close_requested_at: new Date().toISOString(),
    })
    .eq('trip_id', tripId)
    .neq('chat_type', 'archived');
}

export default async function handler(req, res) {
  const reqId = genReqId();
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { tripId, dealId: dealIdRaw } = req.body || {};
    if (!tripId && !dealIdRaw) {
      return res.status(400).json({ error: 'tripId or dealId is required' });
    }

    // 1) получаем dealId из trips, если не передан
    let dealId = (dealIdRaw || '').toString().trim();
    if (!dealId) {
      const trip = await getTripById(tripId);
      if (!trip || !trip.deal_id) {
        return res.status(400).json({ error: 'dealId not found for the trip' });
      }
      dealId = String(trip.deal_id);
    }

    // 2) closeSpDeal к T-Банку
    const TerminalKey = process.env.TBANK_TERMINAL_KEY || '';
    const payload = { TerminalKey, SpAccumulationId: dealId };
    const Token = makeToken(payload);
    const body = { ...payload, Token };

    log(reqId, '→ closeSpDeal request', {
      url: `${TBANK_BASE}/closeSpDeal`,
      TerminalKey: maskKey(TerminalKey),
      SpAccumulationId: dealId,
    });

    const resp = await fetch(`${TBANK_BASE}/closeSpDeal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await resp.json().catch(() => ({}));
    log(reqId, '← closeSpDeal response', { status: resp.status, body: json });

    if (!resp.ok || String(json?.ErrorCode) !== '0' || json?.Success === false) {
      return res.status(502).json({ error: json?.Message || json?.Details || 'closeSpDeal failed', bank: json });
    }

    // 3) по успеху — архивируем поездку и все её чаты (включая диспут)
    if (tripId) {
      await archiveTripAndAllChats(tripId);
    }

    return res.status(200).json({ ok: true, bank: json });
  } catch (e) {
    logErr(reqId, 'Critical error:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
