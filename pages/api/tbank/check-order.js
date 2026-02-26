// /pages/api/tbank/check-order.js
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { getTbankConfig } from './_config';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const genReqId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const mask = (s, keepStart = 4, keepEnd = 4) => {
  if (!s) return s;
  const str = String(s);
  if (str.length <= keepStart + keepEnd) return '*'.repeat(Math.max(1, str.length - 1));
  return `${str.slice(0, keepStart)}…${str.slice(-keepEnd)}`;
};
const maskToken = (t) => (t ? mask(t, 6, 6) : t);
const maskKey = (k) => (k ? mask(k, 4, 4) : k);

const log = (id, ...a) => console.log(`[tbank-checkorder][${id}]`, ...a);
const logErr = (id, ...a) => console.error(`[tbank-checkorder][${id}]`, ...a);
const tbankConfig = getTbankConfig();

// EACQ терминал: убрать суффикс E2C, если вдруг указан
const stripE2C = (tk) => (tk ? tk.replace(/E2C$/i, '') : tk);

/**
 * Генерация Token для EACQ v2.
 * ВНИМАНИЕ: оставляем поведение как у вас — Password добавляется как обычный ключ
 * (это сделано намеренно для совместимости с текущими логами и сравнениями).
 */
const generateToken = (params, reqId) => {
  const pwd = tbankConfig.terminalSecret || '';
  const base = { ...params, Password: pwd };

  const pairs = Object.keys(base)
    .filter((k) => !['Token', 'DigestValue', 'SignatureValue', 'X509SerialNumber'].includes(k))
    .sort()
    .map((k) => [k, base[k]]);

  const concat = pairs.map(([, v]) => String(v)).join('');
  const token = crypto.createHash('sha256').update(concat).digest('hex');

  const printable = pairs.map(([k, v]) => [k, k === 'Password' ? '[HIDDEN]' : v]);
  log(reqId, `[CheckOrder] TOKEN BUILD ORDER (incl.Password):`, printable);
  log(reqId, `[CheckOrder] CONCAT (values, Password masked):`, concat.replace(pwd, '***PWD***'));
  log(reqId, `[CheckOrder] RESULT sha256(hex) length=${token.length}`);
  return { token, debug: { order: printable, concatPreview: concat.replace(pwd, '***PWD***') } };
};

export default async function handler(req, res) {
  const reqId = genReqId();

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не разрешён. Используйте POST.' });
  }

  try {
    const { orderId } = req.body || {};
    log(reqId, 'Incoming body:', { orderId });

    if (!orderId || String(orderId).trim() === '') {
      return res.status(400).json({ error: 'Не указан OrderId' });
    }

    const terminalKeyRaw = tbankConfig.terminalKeyBase || '';
    if (!terminalKeyRaw) {
      return res.status(500).json({ error: 'Отсутствует TBANK_TERMINAL_KEY в переменных окружения' });
    }
    const terminalKey = stripE2C(terminalKeyRaw);

    // Базовый URL: по умолчанию тестовый, можно переопределить TBANK_BASE
    const BASE = tbankConfig.eacqBaseV2;
    const endpoint = `${BASE}/CheckOrder`; // v2/CheckOrder

    // EACQ v2 — OrderId как строка
    const baseParams = {
      TerminalKey: terminalKey,
      OrderId    : String(orderId).trim(),
    };

    const { token, debug } = generateToken(baseParams, reqId);
    const params = { ...baseParams, Token: token };

    // Логи запроса (маскируем ключ/токен)
    const payloadLog = {
      ...params,
      TerminalKey: maskKey(params.TerminalKey),
      Token: maskToken(params.Token),
    };
    log(reqId, 'TBank v2 CHECKORDER payload:', payloadLog);
    log(reqId, 'TBank base URL:', BASE);

    // ───────────────────────────
    // ВЫЗОВ БАНКА
    // ───────────────────────────
    const resp = await fetch(endpoint, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(params),
    });

    const rawText = await resp.text();
    let data;
    try { data = rawText ? JSON.parse(rawText) : null; } catch { data = { raw: rawText }; }
    log(reqId, 'TBank v2 CHECKORDER response:', { status: resp.status, bodyKeys: data && typeof data === 'object' ? Object.keys(data) : null });

    if (!resp.ok) {
      // Ошибка на стороне банка -> фронт может предложить повторить оплату
      return res.status(resp.status).json({
        error: data?.Message || data?.Details || 'Ошибка CheckOrder',
        response: data || rawText || null,
        ui: { allowRetry: true, block: false, reason: 'bank_http_error' },
      });
    }

    // Выделяем статус у банка
let bankStatus =
  (data && (data.Status || data.status || data.OrderStatus || data.orderStatus)) || null;

// NEW: поддержка формата с массивом Payments
if (!bankStatus && data && Array.isArray(data.Payments) && data.Payments.length) {
  // Берём первый элемент, в котором есть Status (или просто нулевой, если такого не нашли)
  const first = data.Payments.find((p) => p && (p.Status || p.status)) || data.Payments[0];
  bankStatus = first?.Status || first?.status || null;
}

// (необязательно, но полезно для отладки)
log(reqId, 'Resolved bankStatus:', bankStatus, 'Payments[0]?.Status=', data?.Payments?.[0]?.Status);



    // ───────────────────────────
    // ЧТЕНИЕ ЛОКАЛЬНОЙ БД ПО order_id
    // ───────────────────────────
    const { data: payment, error: payErr } = await supabase
      .from('payments')
      .select('id, status, is_authorized, is_confirmed, created_at, locked_until, trip_id, participant_id')
      .eq('order_id', String(orderId))
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (payErr) {
      logErr(reqId, 'DB error fetching payment by orderId', payErr);
      return res.status(500).json({
        error: 'DB fetch error',
        ui: { allowRetry: false, block: true, reason: 'db_error' },
        bank: { status: bankStatus, raw: data },
      });
    }

    const localAuthorized = !!payment?.is_authorized;
    const localConfirmed  = !!payment?.is_confirmed;

    // TTL для UI: locked_until или created_at + 10 минут
    let untilMs = 0;
    if (payment) {
      const baseUntil = payment.locked_until
        ? new Date(payment.locked_until).getTime()
        : (new Date(payment.created_at).getTime() + 10 * 60 * 1000);
      untilMs = baseUntil;
    }
    const now = Date.now();
    const within10m = untilMs ? now < untilMs : false;

    // ───────────────────────────
    // РЕШЕНИЕ ДЛЯ UI
    // ───────────────────────────
     let block = false;
    let tooltip = '';
    let allowRetry = false;
    let reason = 'ok';

    // ОСОБЫЙ СЛУЧАЙ: PAY_CHECKING — банк проверяет платёж, запускать новую оплату нельзя
    if (bankStatus === 'PAY_CHECKING') {
      block = true;
      allowRetry = false;
      reason = 'bank_pay_checking';
      tooltip =
        'Оплата невозможна, проблема на стороне банка, попробуйте позже или напишите в тех. поддержку в разделе «Сообщение» вкладка «Поддержка».';
    }

    // 1) У банка AUTHORIZED/CONFIRMED, а локально ещё не отмечено -> ЖДЁМ (блок)
    if (bankStatus === 'AUTHORIZED' || bankStatus === 'CONFIRMED') {
      const needWait =
        (!localAuthorized) || (bankStatus === 'CONFIRMED' && !localConfirmed);

      if (needWait) {
        block = true; // кнопку НЕ разблокируем
        if (within10m) {
          const leftSec = Math.max(0, Math.floor((untilMs - now) / 1000));
          const mm = String(Math.floor(leftSec / 60)).padStart(2, '0');
          const ss = String(leftSec % 60).padStart(2, '0');
          tooltip = `Проверяем платёж… Осталось ${mm}:${ss}`;
          reason = 'wait_webhook';
        } else {
          tooltip = 'Похоже, уведомление не пришло. Напишите в «Поддержка». Мы запросим переотправку нотификации.';
          reason = 'webhook_missing_after_10m';
        }
      }
    }

    // 2) Если у банка нет статуса / банк "не знает" / NEW / негатив — разрешаем ретрай
    const negativeStatuses = new Set(['REJECTED', 'CANCELED', 'DEADLINE_EXPIRED', 'REVERSED', 'REFUNDED', 'PARTIAL_REFUNDED']);
    if (!bankStatus) {
      allowRetry = true;
      block = false;
      reason = 'order_not_found_or_unknown_status';
    } else if (bankStatus === 'NEW' || bankStatus === 'FORM_SHOWED' || bankStatus === 'AUTH_FAIL') {
  allowRetry = true;
  block = false;
      reason = 'bank_new_not_paid';
    } else if (negativeStatuses.has(String(bankStatus))) {
      allowRetry = true;
      block = false;
      reason = 'bank_negative_status';
    }

    // ───────────────────────────
    // ОТВЕТ ФРОНТУ
    // ───────────────────────────
    return res.status(200).json({
      success: true,
      request: { url: endpoint, payload: payloadLog },
      bank: { status: bankStatus, raw: data },
      local: payment ? {
        id           : payment.id,
        status       : payment.status,
        is_authorized: payment.is_authorized,
        is_confirmed : payment.is_confirmed,
        created_at   : payment.created_at,
        locked_until : payment.locked_until,
      } : null,
      ui: {
        block,
        allowRetry,
        reason,
        tooltip,
        lockedUntil: untilMs ? new Date(untilMs).toISOString() : null,
      },
      debug,
    });
  } catch (e) {
    logErr(reqId, 'Critical CheckOrder error:', e);
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
