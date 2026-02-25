// /pages/api/tbank/sync-cards-payment.js
// Синхронизация карт для ОПЛАТ (EACQ, /v2/*). Все записи пишем в user_cards с card_scope='payment'.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { getTbankConfig } from './_config';

const tbankConfig = getTbankConfig();
const TBANK_BASE = tbankConfig.restBase;
const PASSWORD   = tbankConfig.terminalSecret || '';

const LOGNS = 'TBANK';
const SCOPE = 'payment';        // сохраняем карты в этом скоупе

// Терминал для ОПЛАТ: БЕЗ суффикса E2C (EACQ протокол, /v2/*)
const stripE2C = (tk) => (!tk ? tk : tk.replace(/E2C$/i, ''));
const TERMINAL_KEY = tbankConfig.terminalKeyEacq || stripE2C(tbankConfig.terminalKeyBase || '');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

function log(rid, tag, obj) {
  console.log(`[${LOGNS}][sync-cards-payment][${rid}] ${tag}`, obj);
}

function apiPath(method) {
  // EACQ: всегда /v2/*
  return `/v2/${method}`;
}

// Токен: кладём Password внутрь параметров, затем сортируем все ключи (как в payout-синке)
function makeTokenDebug(data) {
  const filtered = {};
  for (const k of Object.keys(data)) {
    if (!['Token', 'DigestValue', 'SignatureValue', 'X509SerialNumber', 'DATA'].includes(k)) {
      filtered[k] = String(data[k]);
    }
  }
  filtered.Password = PASSWORD;
  const keys = Object.keys(filtered).sort();
  const concat = keys.map(k => filtered[k]).join('');
  const token = crypto.createHash('sha256').update(concat).digest('hex');
  return {
    token,
    debug: {
      orderedKeys: keys,
      partsSummary: keys.map(k => ({ key: k, len: String(filtered[k]).length, preview: String(filtered[k]).slice(0, 16) })),
      concatenatedLen: concat.length,
      concatenatedPreview: concat.slice(0, 16) + '...' + concat.slice(-16),
      tokenPreview: token.slice(0, 8) + '...' + token.slice(-8),
    },
  };
}

async function tbankPost(rid, method, body, label) {
  const url = `${TBANK_BASE}${apiPath(method)}`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };

  const start = Date.now();
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const ms = Date.now() - start;

  let json = null;
  let rawText = null;
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try { json = await resp.json(); } catch {}
  } else {
    try { rawText = await resp.text(); } catch {}
  }

  const info = {
    httpStatus: resp.status,
    statusText: resp.statusText,
    ms,
    headers: Object.fromEntries([...resp.headers.entries()]),
    contentType: contentType || null,
    rawTextPreview: rawText ? rawText.slice(0, 256) : null,
    jsonSummary: json
      ? (Array.isArray(json) ? { arr: true, len: json.length } : { obj: true, keys: Object.keys(json) })
      : null,
  };
  log(rid, `${label}: response`, info);
  return { resp, json, rawText, url };
}

function normalizeCardsPayload(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.Cards)) return raw.Cards;
  return [];
}

function summarizeCardsForLog(cards) {
  return cards.map(c => ({
    CardId : String(c?.CardId || ''),
    Pan    : c?.Pan || c?.MaskedPan || '***',
    ExpDate: c?.ExpDate || null,
    Status : c?.Status || null,
  }));
}

export default async function handler(req, res) {
  const rid = uuidv4();
  log(rid, 'request start', {
    method: req.method,
    TBANK_BASE,
    PROTOCOL: 'EACQ',
    TERMINAL_KEY: TERMINAL_KEY ? `${TERMINAL_KEY.slice(0, 4)}...` : null,
  });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // --- auth (как в payout-синке) ---
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const jwt = auth.slice(7);
    const supabaseAuth = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } }
    );
    const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser();
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const customerKey = user.id;

    // 1) GetCustomer (не критично для потока, но полезно для логов)
    {
      const core = { CustomerKey: customerKey, TerminalKey: TERMINAL_KEY };
      const { token, debug } = makeTokenDebug(core);
      log(rid, 'GetCustomer: token computed', debug);
      const gc = await tbankPost(rid, 'GetCustomer', { ...core, Token: token }, 'GetCustomer');
      const ok = gc.resp.ok && !!gc.json;
      if (!ok) {
        log(rid, 'GetCustomer failed (non-fatal)', {
          httpStatus: gc.resp.status,
          json: gc.json ? (gc.json.Success === false ? { Success: false, ErrorCode: gc.json.ErrorCode, Message: gc.json.Message } : { keys: Object.keys(gc.json) }) : null,
        });
      } else {
        log(rid, 'GetCustomer OK', {
          endpointPath: gc.url.replace(TBANK_BASE, ''),
          hasJson: true,
        });
      }
    }

    // 2) GetCardList — только по оплатному терминалу (/v2/*)
    const coreGL = { CustomerKey: customerKey, TerminalKey: TERMINAL_KEY };
    const { token: tokenGL, debug: debugGL } = makeTokenDebug(coreGL);
    log(rid, 'GetCardList: token computed', debugGL);
    const gl = await tbankPost(rid, 'GetCardList', { ...coreGL, Token: tokenGL }, 'GetCardList');

    const okGL = gl.resp.ok && (Array.isArray(gl.json) || gl.json?.Success === true);
    if (!okGL) {
      log(rid, 'GetCardList failed (non-fatal)', {
        httpStatus: gl.resp.status,
        json: gl.json ? (gl.json.Success === false ? { Success: false, ErrorCode: gl.json.ErrorCode, Message: gl.json.Message } : { keys: Object.keys(gl.json) }) : null,
      });
      return res.status(200).json({ success: true, count: 0, scope: SCOPE, source: gl.url.replace(TBANK_BASE, '') });
    }

    const rawCards = normalizeCardsPayload(gl.json);
    const deleted  = rawCards.filter(c => String(c?.Status || '').toUpperCase() === 'D');
    const active   = rawCards.filter(c => String(c?.Status || '').toUpperCase() !== 'D');

    log(rid, 'GetCardList OK (parsed)', {
      endpointPath: gl.url.replace(TBANK_BASE, ''),
      total: rawCards.length,
      active: active.length,
      deleted: deleted.length,
      itemsActive: summarizeCardsForLog(active),
      itemsDeleted: summarizeCardsForLog(deleted),
    });

    // 2.1 Удаляем из БД все карты со статусом D в рамках СКОУПА 'payment'
    if (deleted.length > 0) {
      const deletedIds = deleted.map(c => String(c.CardId)).filter(Boolean);
      const { error: delErr } = await supabase
        .from('user_cards')
        .delete()
        .eq('user_id', customerKey)
        .eq('card_scope', SCOPE)
        .in('card_id', deletedIds);
      if (delErr) {
        log(rid, 'Cleanup deleted cards failed (non-fatal)', { error: delErr.message, deletedIds });
      } else {
        log(rid, 'Cleanup deleted cards done', { deletedIdsCount: deletedIds.length });
      }
    }

    // 2.2 Текущие записи в БД по этому пользователю и СКОУПУ
    const { data: existingRowsRaw } = await supabase
      .from('user_cards')
      .select('id, card_id, is_primary, created_at')
      .eq('user_id', customerKey)
      .eq('card_scope', SCOPE);

// ===== 2.2.1 Reconcile "пропавших" карт (двойная проверка) =====
// Идея: если карта есть в Supabase, но её нет в GetCardList (и она не пришла со Status=D),
// делаем второй GetCardList. Если и там нет — удаляем из БД.

const existingRowsAll = Array.isArray(existingRowsRaw) ? existingRowsRaw : [];

// bankSet1: все CardId, которые банк вернул (и активные, и D) — чтобы не удалять то, что банк знает
const bankSet1 = new Set(rawCards.map(c => String(c?.CardId || '')).filter(Boolean));

// кандидаты на удаление: есть в БД, но нет в ответе банка
const missingCandidates = existingRowsAll.filter(r => !bankSet1.has(String(r.card_id)));

if (missingCandidates.length > 0) {
  log(rid, 'Reconcile: missing candidates found, rechecking GetCardList', {
    missingCandidatesCount: missingCandidates.length,
    sample: missingCandidates.slice(0, 5).map(r => String(r.card_id)),
  });

  // второй GetCardList (повторная проверка, чтобы не снести данные из-за "пустого" ответа/глюка)
  const gl2 = await tbankPost(
    rid,
    'GetCardList',
    { ...coreGL, Token: tokenGL },   // coreGL/tokenGL уже есть выше в файле
    'GetCardList(recheck)'
  );

  const okGL2 = gl2.resp.ok && (Array.isArray(gl2.json) || gl2.json?.Success === true);

  if (!okGL2) {
    log(rid, 'Reconcile: recheck GetCardList failed, skip deletion (non-fatal)', {
      httpStatus: gl2.resp.status,
      json: gl2.json ? (gl2.json.Success === false
        ? { Success: false, ErrorCode: gl2.json.ErrorCode, Message: gl2.json.Message }
        : { keys: Object.keys(gl2.json) }
      ) : null,
    });
  } else {
    const rawCards2 = normalizeCardsPayload(gl2.json);
    const bankSet2 = new Set(rawCards2.map(c => String(c?.CardId || '')).filter(Boolean));

    // удаляем только то, что отсутствует и во 2-й проверке
    const toDelete = missingCandidates
      .map(r => String(r.card_id))
      .filter(cardId => cardId && !bankSet2.has(cardId));

    if (toDelete.length > 0) {
      const { error: delMissErr } = await supabase
        .from('user_cards')
        .delete()
        .eq('user_id', customerKey)
        .eq('card_scope', SCOPE)
        .in('card_id', toDelete);

      if (delMissErr) {
        log(rid, 'Reconcile: delete missing cards failed (non-fatal)', {
          error: delMissErr.message,
          toDeleteCount: toDelete.length,
        });
      } else {
        log(rid, 'Reconcile: deleted missing cards', {
          toDeleteCount: toDelete.length,
          sample: toDelete.slice(0, 10),
        });
      }
    } else {
      log(rid, 'Reconcile: nothing to delete after recheck', {});
    }
  }
}
// ===== конец reconcile =====


    const existingRows = Array.isArray(existingRowsRaw) ? existingRowsRaw : [];
    const activeIdsSet = new Set(active.map(c => String(c?.CardId || '')));

    // существующие активные записи
    const existingActiveRows = existingRows.filter(r => activeIdsSet.has(String(r.card_id)));

    // уже выбранная «основная»? если да — оставляем как есть
    const existingPrimaries = existingActiveRows.filter(r => !!r.is_primary);
    existingPrimaries.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let chosenPrimaryId = existingPrimaries.length > 0 ? String(existingPrimaries[0].card_id) : null;

    // 2.3 Апсерты активных карт (мета апдейт; is_primary НЕ трогаем на существующих)
    let upsertCount = 0;
    for (const c of active) {
      if (!c || !c.CardId) continue;
      const cardId = String(c.CardId);
      const last4  = String(c.Pan || '').slice(-4) || null;
      const exp    = (c.ExpDate || '').toString().replace(/\D/g, '').slice(0, 4) || null;

      const existing = existingRows.find(r => String(r.card_id) === cardId);

      if (existing) {
        const { error: updErr } = await supabase
          .from('user_cards')
          .update({ last_four_digits: last4, expiry_date: exp })
          .eq('id', existing.id);
        if (updErr) {
          log(rid, 'Upsert update failed (non-fatal)', { cardId, error: updErr.message });
        } else {
          upsertCount++;
        }
      } else {
        // вставка; если primary ещё не выбран — первая новая станет основной
        const makePrimary = !chosenPrimaryId;
        const { error: insErr, data: insData } = await supabase
          .from('user_cards')
          .insert({
            user_id         : customerKey,
            card_id         : cardId,
            last_four_digits: last4,
            expiry_date     : exp,
            is_primary      : makePrimary,
            card_scope      : SCOPE,
          })
          .select('id, card_id')
          .single();

        if (insErr) {
          log(rid, 'Upsert insert failed (non-fatal)', { cardId, error: insErr.message });
        } else {
          upsertCount++;
          if (makePrimary) chosenPrimaryId = cardId;
        }
      }
    }

    // 2.4 Если основной нет — берём самую раннюю активную запись
    if (!chosenPrimaryId && existingActiveRows[0]) {
      existingActiveRows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      chosenPrimaryId = String(existingActiveRows[0].card_id);
    }

    // 2.5 Гарантируем уникальность основной в рамках СКОУПа
    if (chosenPrimaryId) {
      const { error: clearErr } = await supabase
        .from('user_cards')
        .update({ is_primary: false })
        .eq('user_id', customerKey)
        .eq('card_scope', SCOPE)
        .neq('card_id', chosenPrimaryId);
      if (clearErr) {
        log(rid, 'Primary uniqueness: clear others failed (non-fatal)', { error: clearErr.message });
      }

      const { error: setErr } = await supabase
        .from('user_cards')
        .update({ is_primary: true })
        .eq('user_id', customerKey)
        .eq('card_scope', SCOPE)
        .eq('card_id', chosenPrimaryId);
      if (setErr) {
        log(rid, 'Primary uniqueness: set chosen failed (non-fatal)', { error: setErr.message });
      } else {
        log(rid, 'Primary uniqueness enforced', { chosenPrimaryId });
      }
    } else {
      log(rid, 'Primary uniqueness: no active cards to mark as primary', {});
    }

    log(rid, 'Upsert complete', {
      scope: SCOPE,
      affected: upsertCount,
      keptActive: active.length,
      removedDeleted: deleted.length,
      chosenPrimaryId: chosenPrimaryId || null,
    });

    return res.status(200).json({
      success: true,
      scope: SCOPE,
      count: upsertCount,
      keptActive: active.length,
      removedDeleted: deleted.length,
      chosenPrimaryId: chosenPrimaryId || null,
      source: gl.url.replace(TBANK_BASE, ''),
    });
  } catch (e) {
    log(rid, 'unhandled', { error: String(e) });
    // Не валим UI при сбоях тестового стенда банка
    return res.status(200).json({ success: true, scope: SCOPE, count: 0, source: null });
  }
}
