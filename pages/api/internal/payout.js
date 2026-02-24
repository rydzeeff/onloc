// pages/api/internal/payout.js
// Внутренняя выплата организатору (E2C), максимально идентичная логике pages/api/tbank/payout.js,
// но:
//  - без пользовательской авторизации (только x-internal-secret)
//  - с service role ключом Supabase
//
// Совместимо с Edge функцией auto-approve-after-dispute:
//   body: { tripId, participantRowId }  // participantRowId = trip_participants.id
//
// Также поддерживает:
//   body: { tripId, participantId }     // alias (то же что participantRowId)
//   body: { tripId, sourcePaymentId }   // напрямую по платежу
//
// Опционально:
//   { amountNetRub, finalPayout }  // amountNetRub = NET, finalPayout = override финальности

import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { platformSettings } from "../../../lib/platformSettings";

// ---------------- CORS ----------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-internal-secret",
};

// ---------------- TBANK ----------------
const TBANK_E2C_BASE =
  process.env.TBANK_E2C_BASE || "https://rest-api-test.tinkoff.ru/e2c/v2";

// ---------- utils ----------
const genReqId = () =>
  `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

const mask = (s, keepStart = 4, keepEnd = 4) => {
  if (!s) return s;
  const str = String(s);
  if (str.length <= keepStart + keepEnd) return "*".repeat(Math.max(1, str.length - 1));
  return `${str.slice(0, keepStart)}…${str.slice(-keepEnd)}`;
};

const maskToken = (t) => (t ? mask(t, 6, 6) : t);
const maskCardId = (c) => (c ? mask(c, 4, 4) : c);
const maskKey = (k) => (k ? mask(k, 4, 4) : k);

const log = (id, ...a) => console.log(`[internal-payout][${id}]`, ...a);
const logErr = (id, ...a) => console.error(`[internal-payout][${id}]`, ...a);

// ---------- Token генерация (как в payout.js) ----------
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

function buildTokenWithPassword(params) {
  // делаем как в payout.js: TBANK_SECRET
  const pwd = process.env.TBANK_SECRET || "";
  const pairs = Object.entries({ ...params, Password: pwd })
    .filter(([k]) => !["Token", "DigestValue", "SignatureValue", "X509SerialNumber"].includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const concat = pairs.map(([, v]) => String(v)).join("");
  return { token: sha256Hex(concat), concat, pwd };
}

function ensureE2CTerminal(key) {
  const base = String(key || "").trim();
  if (!base) return "";
  return base.endsWith("E2C") ? base : `${base}E2C`;
}

// ---------- комиссии (как в payout.js: FLOOR вниз до копейки) ----------
function computeNetFromGrossUsingTripPercents(gross, trip) {
  const platformPercent = Number.isFinite(Number(trip?.platform_fee))
    ? Number(trip.platform_fee)
    : Number(platformSettings?.platformFeePercent || 0);

  const tbankPercent = Number.isFinite(Number(trip?.tbank_fee))
    ? Number(trip.tbank_fee)
    : Number(platformSettings?.tbankFeePercent || 0);

  const total = Math.max(0, platformPercent + tbankPercent);
  const netRaw = Number(gross) * (1 - total / 100);
  const net = Math.floor(netRaw * 100) / 100; // ↓↓↓ вниз до копейки

  return { net, platformPercent, tbankPercent, totalPercent: total };
}

// ---------- phone normalization ----------
function normalizePhoneTo7Digits(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("9")) return `7${digits}`;
  return digits;
}

// ---------- DB helpers (service-role) ----------
function createServiceSupabase() {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_ROLE =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error("SUPABASE_ENV_MISSING");
  }

  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

async function getTrip(supabase, tripId) {
  const { data, error } = await supabase
    .from("trips")
    .select("id, creator_id, is_company_trip, deal_id, status, platform_fee, tbank_fee, title")
    .eq("id", tripId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getTripParticipantRow(supabase, tripId, participantRowId) {
  const { data, error } = await supabase
    .from("trip_participants")
    .select("id, trip_id, user_id, status, approved_trip")
    .eq("id", participantRowId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getActiveCompanyForOrganizer(supabase, userId) {
  const { data, error } = await supabase
    .from("mycompany")
    .select("company_id, tbank_shop_code, is_active, verified, status")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getOrganizerPayoutCardId(supabase, userId) {
  const { data, error } = await supabase
    .from("user_cards")
    .select("card_id, is_primary, created_at")
    .eq("user_id", userId)
    .eq("card_scope", "payout")
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data && data[0]?.card_id) || null;
}

async function getOrganizerPhoneForPaymentRecipientId(supabase, organizerUserId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("phone")
    .eq("user_id", organizerUserId)
    .maybeSingle();
  if (error) throw error;

  const normalized = normalizePhoneTo7Digits(data?.phone);
  if (!normalized || !/^7\d{10}$/.test(normalized)) return null;
  return normalized;
}

// --- payments safe readers ---
// ❗️Тут главный фикс: НЕТ amount_rub в select.
async function readPaymentByIdSafe(supabase, paymentId, reqId) {
  // пробуем с payout_completed/payout_at (если у тебя эти поля есть)
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("id, amount, payout_completed, payout_at, created_at, status, payment_type, participant_id, user_id")
      .eq("id", paymentId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (e) {
    log(reqId, "readPaymentByIdSafe: fallback minimal select:", String(e?.message || e));
  }

  // минимальный набор (точно не должен падать из-за payout_* полей, если их нет)
  const { data, error } = await supabase
    .from("payments")
    .select("id, amount, created_at, status, payment_type, participant_id, user_id")
    .eq("id", paymentId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getLatestConfirmedParticipantPaymentFlex(supabase, { tripId, participantUserId, reqId }) {
  // Вариант A (как payout.js): payments(participant_id, payment_type, status, amount)
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("id, amount, status, payment_type, created_at, payout_completed, payout_at")
      .eq("trip_id", tripId)
      .eq("participant_id", participantUserId)
      .eq("payment_type", "participant_payment")
      .eq("status", "confirmed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  } catch (e) {
    log(reqId, "Payment resolve A failed, fallback to B:", String(e?.message || e));
  }

  // Вариант B: payments(user_id) / без payment_type/status строгих
  const { data, error } = await supabase
    .from("payments")
    .select("id, amount, status, created_at, payout_completed, payout_at, participant_id, user_id")
    .eq("trip_id", tripId)
    .or(`user_id.eq.${participantUserId},participant_id.eq.${participantUserId}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

// ---------- финализация (как payout.js) ----------
async function getPaidUserIdsForTrip(supabase, tripId, reqId) {
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("participant_id")
      .eq("trip_id", tripId)
      .eq("payment_type", "participant_payment")
      .eq("status", "confirmed");
    if (error) throw error;

    const ids = (data || []).map((r) => r.participant_id).filter(Boolean);
    return Array.from(new Set(ids));
  } catch (e) {
    log(reqId, "Finalization paid users A failed, fallback to B:", String(e?.message || e));
  }

  const { data, error } = await supabase
    .from("payments")
    .select("user_id")
    .eq("trip_id", tripId);

  if (error) throw error;
  const ids = (data || []).map((r) => r.user_id).filter(Boolean);
  return Array.from(new Set(ids));
}

async function countApprovedPaidParticipants(supabase, tripId, paidUserIds) {
  if (!paidUserIds.length) return 0;
  const { data, error } = await supabase
    .from("trip_participants")
    .select("user_id")
    .eq("trip_id", tripId)
    .in("user_id", paidUserIds)
    .eq("approved_trip", true);

  if (error) throw error;
  return (data || []).length;
}

// Архивирование — как в payout.js
async function archiveTripAndChats(supabase, tripId) {
  await supabase.from("trips").update({ status: "archived" }).eq("id", tripId);

  await supabase
    .from("chats")
    .update({
      chat_type: "archived",
      support_close_confirmed: true,
      support_close_requested_at: new Date().toISOString(),
    })
    .eq("trip_id", tripId)
    .neq("chat_type", "archived");
}

// ---------- payout_attempts helper ----------
async function updateAttemptByOrderId(supabase, orderId, patch) {
  await supabase.from("payout_attempts").update(patch).eq("order_id", orderId);
}

// ---------- E2C calls (Init -> Payment) ----------
async function tbankInitAndPayment({
  reqId,
  amountKop,
  dealId,
  partnerId,
  cardId,
  finalPayout = true,
  orderId,
  paymentRecipientId,
}) {
  const terminalKey = ensureE2CTerminal(process.env.TBANK_TERMINAL_KEY || "");
  if (!terminalKey) throw new Error("TBANK_TERMINAL_KEY is empty");

  let safeOrderId = orderId && String(orderId).trim();
  if (!safeOrderId) safeOrderId = crypto.randomBytes(12).toString("hex");
  if (safeOrderId.length > 50) {
    const sha1 = crypto.createHash("sha1").update(safeOrderId).digest("hex");
    safeOrderId = `o-${sha1.slice(0, 32)}`;
  }

  const initParams = {
    TerminalKey: terminalKey,
    Amount: Number(amountKop),
    DealId: String(dealId),
    OrderId: safeOrderId,
    ...(finalPayout ? { FinalPayout: true } : {}),
    ...(partnerId ? { PartnerId: String(partnerId) } : {}),
    ...(cardId ? { CardId: String(cardId) } : {}),
    ...(paymentRecipientId ? { PaymentRecipientId: String(paymentRecipientId) } : {}),
  };

  const { token } = buildTokenWithPassword(initParams);
  const initBody = { ...initParams, Token: token };

  log(reqId, "[Init] payload:", {
    TerminalKey: maskKey(terminalKey),
    Amount: initParams.Amount,
    DealId: initParams.DealId,
    OrderId: initParams.OrderId,
    PartnerId: initParams.PartnerId,
    CardId: initParams.CardId ? maskCardId(initParams.CardId) : undefined,
    FinalPayout: !!initParams.FinalPayout,
    PaymentRecipientId: initParams.PaymentRecipientId,
    Token: maskToken(token),
  });

  const initResp = await fetch(`${TBANK_E2C_BASE}/Init`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": reqId },
    body: JSON.stringify(initBody),
  });

  const initJson = await initResp.json().catch(() => ({}));
  log(reqId, "TBank INIT response:", { status: initResp.status, body: initJson });

  if (!initResp.ok || String(initJson?.ErrorCode) !== "0" || initJson?.Success === false) {
    throw new Error(initJson?.Message || initJson?.Details || "Ошибка Init");
  }

  const paymentParams = {
    TerminalKey: terminalKey,
    PaymentId: initJson.PaymentId,
  };
  const { token: payToken } = buildTokenWithPassword(paymentParams);
  const paymentBody = { ...paymentParams, Token: payToken };

  const payResp = await fetch(`${TBANK_E2C_BASE}/Payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": reqId },
    body: JSON.stringify(paymentBody),
  });

  const payJson = await payResp.json().catch(() => ({}));
  log(reqId, "TBank PAYMENT response:", { status: payResp.status, body: payJson });

  if (!payResp.ok) {
    throw new Error(payJson?.Message || payJson?.Details || "Ошибка Payment");
  }

  const bankStatus = String(payJson?.Status || "").toUpperCase();
  const errorCode = payJson?.ErrorCode || null;
  const success = payJson?.Success !== false && errorCode === "0";

  return {
    paymentId: initJson.PaymentId,
    orderId: safeOrderId,
    bankStatus,
    bankSuccess: success,
    bankErrorCode: errorCode,
    bankMessage: payJson?.Message || null,
    raw: payJson,
  };
}

// ---------- GetState (E2C) ----------
async function tbankGetState({ reqId, paymentId, orderId, ip }) {
  const terminalKey = ensureE2CTerminal(process.env.TBANK_TERMINAL_KEY || "");
  if (!terminalKey) throw new Error("TBANK_TERMINAL_KEY is empty");

  const baseParams = {
    TerminalKey: terminalKey,
    ...(paymentId ? { PaymentId: String(paymentId) } : {}),
    ...(paymentId ? {} : orderId ? { OrderId: String(orderId) } : {}),
    ...(ip ? { IP: String(ip) } : {}),
  };

  if (!baseParams.PaymentId && !baseParams.OrderId) {
    throw new Error("GetState requires PaymentId or OrderId");
  }

  const { token } = buildTokenWithPassword(baseParams);
  const params = { ...baseParams, Token: token };
  const url = `${TBANK_E2C_BASE}/GetState`;

  log(reqId, "=== OUTGOING GETSTATE ===", {
    URL: url,
    Payload: { ...params, TerminalKey: maskKey(params.TerminalKey), Token: params.Token },
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": reqId },
    body: JSON.stringify(params),
  });

  const rawText = await resp.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    json = { raw: rawText };
  }

  log(reqId, "=== INCOMING GETSTATE ===", { status: resp.status, body: json });

  if (!resp.ok) {
    throw new Error(json?.Message || json?.Details || "Ошибка GetState");
  }

  const bankStatus = String(json?.Status || "").toUpperCase();
  return {
    ok: !!json?.Success && json?.ErrorCode === "0",
    bankStatus,
    errorCode: json?.ErrorCode || null,
    message: json?.Message || null,
    raw: json,
    paymentId: json?.PaymentId || paymentId || null,
    orderId: json?.OrderId || orderId || null,
  };
}

// ---------- DM notify (как payout.js) ----------
async function notifyOrganizerDmAboutApprovalAndPayout(supabase, { reqId, trip, participantUserId }) {
  try {
    const organizerId = trip?.creator_id;
    if (!organizerId || !participantUserId) return;

    const { data: tripChats, error: chatsErr } = await supabase
      .from("chats")
      .select("id, is_group, chat_type")
      .eq("trip_id", trip.id)
      .eq("is_group", false);

    if (chatsErr) {
      logErr(reqId, "DM payout: read chats error:", chatsErr.message);
      return;
    }
    if (!tripChats || tripChats.length === 0) {
      log(reqId, "DM payout: нет DM-чатов (is_group=false) для этой поездки");
      return;
    }

    const chatIds = tripChats.map((c) => c.id);

    const { data: membersRows, error: membersErr } = await supabase
      .from("chat_participants")
      .select("chat_id, user_id")
      .in("chat_id", chatIds);

    if (membersErr) {
      logErr(reqId, "DM payout: read chat_participants error:", membersErr.message);
      return;
    }
    if (!membersRows || membersRows.length === 0) {
      log(reqId, "DM payout: нет участников в DM-чатах для этой поездки");
      return;
    }

    const byChat = {};
    for (const row of membersRows) {
      if (!byChat[row.chat_id]) byChat[row.chat_id] = new Set();
      byChat[row.chat_id].add(row.user_id);
    }

    const dmChatEntry = Object.entries(byChat).find(([, set]) => {
      return set.has(organizerId) && set.has(participantUserId);
    });
    const dmChatId = dmChatEntry?.[0];

    if (!dmChatId) {
      log(reqId, "DM payout: подходящий DM-чат (is_group=false) не найден");
      return;
    }

    const title = trip?.title || "";
    const text = `Я одобрил(а) поездку «${title}». Выплата за поездку произведена.`;

    const { error: msgErr } = await supabase.from("chat_messages").insert({
      chat_id: dmChatId,
      user_id: participantUserId,
      content: text,
    });

    if (msgErr) {
      logErr(reqId, "DM payout: insert chat_message error:", msgErr.message);
    } else {
      log(reqId, "DM payout: сообщение об одобрении и выплате отправлено организатору");
    }
  } catch (e) {
    logErr(reqId, "DM payout: notify error:", e?.message || e);
  }
}

// ---------------- handler ----------------
export default async function handler(req, res) {
  const reqId = genReqId();

  // CORS
  if (req.method === "OPTIONS") {
    return res
      .status(200)
      .setHeader("Access-Control-Allow-Origin", "*")
      .setHeader("Access-Control-Allow-Methods", corsHeaders["Access-Control-Allow-Methods"])
      .setHeader("Access-Control-Allow-Headers", corsHeaders["Access-Control-Allow-Headers"])
      .json({});
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  const internalSecret =
    process.env.INTERNAL_PAYOUT_SECRET ||
    process.env.TRIP_CRON_SECRET ||
    process.env.CRON_SECRET ||
    "";

  const gotSecret = String(req.headers["x-internal-secret"] || "");
  if (!internalSecret || gotSecret !== internalSecret) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const body = req.body || {};
  const tripId = body.tripId;
  const participantRowId = body.participantRowId || body.participantId || null; // alias
  const sourcePaymentId = body.sourcePaymentId || null;

  const amountNetRub = body.amountNetRub;
  const finalPayout = body.finalPayout;
  const overrideFinal = typeof finalPayout === "boolean" ? finalPayout : null;

  if (!tripId) return res.status(400).json({ error: "TRIP_ID_REQUIRED" });
  if (!participantRowId && !sourcePaymentId) {
    return res
      .status(400)
      .json({ error: "participantRowId/participantId OR sourcePaymentId required" });
  }

  let supabase;
  try {
    supabase = createServiceSupabase();
  } catch (e) {
    return res.status(500).json({ error: e?.message || "SUPABASE_ENV_MISSING" });
  }

  try {
    log(reqId, "Incoming request", {
      tripId,
      participantRowId: participantRowId ? mask(participantRowId) : null,
      sourcePaymentId: sourcePaymentId ? mask(sourcePaymentId) : null,
      overrideFinal,
      amountNetRub,
    });

    const trip = await getTrip(supabase, tripId);
    if (!trip) return res.status(404).json({ error: "TRIP_NOT_FOUND" });

    log(reqId, "Trip:", {
      id: trip.id,
      creator_id: trip.creator_id,
      is_company_trip: trip.is_company_trip,
      deal_id: trip.deal_id,
      status: trip.status,
    });

    // participant row
    let partRow = null;
    let participantUserId = null;

    if (participantRowId) {
      partRow = await getTripParticipantRow(supabase, tripId, participantRowId);
      if (!partRow) return res.status(404).json({ error: "PARTICIPANT_NOT_FOUND" });

      participantUserId = partRow.user_id;

      const st = String(partRow.status || "").toLowerCase();
      if (st && st !== "paid") {
        return res.status(409).json({
          error: "PARTICIPANT_NOT_PAID",
          message: `participant not paid (status=${st})`,
        });
      }
    }

    // recipient
    let partnerId = null;
    let cardId = null;
    const paymentRecipientId = await getOrganizerPhoneForPaymentRecipientId(
      supabase,
      trip.creator_id
    );
    if (!paymentRecipientId) {
      return res.status(400).json({ error: "Organizer phone invalid for PaymentRecipientId" });
    }

    if (trip.is_company_trip) {
      const company = await getActiveCompanyForOrganizer(supabase, trip.creator_id);
      partnerId = (company?.tbank_shop_code || "").trim();
      if (!partnerId) {
        return res.status(400).json({ error: "Organizer company tbank_shop_code is missing" });
      }
    } else {
      cardId = await getOrganizerPayoutCardId(supabase, trip.creator_id);
      if (!cardId) {
        return res.status(400).json({ error: "Organizer payout card not found (CardId)" });
      }
    }

    log(reqId, "Payout recipient resolved:", {
      is_company_trip: !!trip.is_company_trip,
      partnerId: partnerId || undefined,
      cardId: cardId ? maskCardId(cardId) : undefined,
      paymentRecipientId,
      overrideFinal,
    });

    // resolve payment
    let resolvedSourcePaymentId = sourcePaymentId || null;
    let pay = null;

    if (!resolvedSourcePaymentId) {
      if (!participantUserId) return res.status(400).json({ error: "SOURCE_PAYMENT_NOT_FOUND" });

      pay = await getLatestConfirmedParticipantPaymentFlex(supabase, {
        tripId,
        participantUserId,
        reqId,
      });

      if (!pay?.id) return res.status(400).json({ error: "SOURCE_PAYMENT_NOT_FOUND" });
      resolvedSourcePaymentId = pay.id;
    } else {
      pay = await readPaymentByIdSafe(supabase, resolvedSourcePaymentId, reqId);
    }

    if (!pay?.id) return res.status(400).json({ error: "SOURCE_PAYMENT_NOT_FOUND" });

    // идемпотентность (если поле payout_completed отсутствует — будет undefined и не заблокирует)
    if (pay?.payout_completed === true) {
      log(reqId, "Already payout_completed on payment", resolvedSourcePaymentId);

      if (participantRowId) {
        await supabase
          .from("trip_participants")
          .update({ approved_trip: true })
          .eq("id", participantRowId);
      }

      return res.status(200).json({
        success: true,
        message: "Уже выплачено ранее (payout_completed=true). Повторная выплата не требуется.",
      });
    }

    // pending-guard
    try {
      const { data: pending = [], error: pendErr } = await supabase
        .from("payout_attempts")
        .select("id, order_id, bank_order_id, payment_id, status, bank_status, source_payment_id")
        .eq("source_payment_id", resolvedSourcePaymentId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1);

      if (pendErr) throw pendErr;

      const pa = pending?.[0];
      if (pa && String(pa.bank_status || "").toUpperCase() === "CREDIT_CHECKING") {
        const getState = await tbankGetState({
          reqId,
          paymentId: pa.payment_id || null,
          orderId: pa.bank_order_id || pa.order_id || null,
        });

        await supabase
          .from("payout_attempts")
          .update({
            bank_status: getState.bankStatus || pa.bank_status,
            bank_error_code: getState.errorCode || null,
            bank_message: getState.message || null,
            bank_payload: getState.raw || null,
            last_attempt_at: new Date().toISOString(),
            payment_id: getState.paymentId || pa.payment_id,
            bank_order_id: getState.orderId || pa.bank_order_id || pa.order_id,
          })
          .eq("id", pa.id);

        if (getState.bankStatus === "CREDIT_CHECKING") {
          return res.status(202).json({
            success: false,
            pending: true,
            bankStatus: "CREDIT_CHECKING",
            message: "Выплата подтверждается банком (CREDIT_CHECKING). Повторно запускать не нужно.",
          });
        }

        if (getState.bankStatus === "COMPLETED") {
          await supabase
            .from("payout_attempts")
            .update({
              status: "completed",
              bank_status: "COMPLETED",
              last_attempt_at: new Date().toISOString(),
              error_message: null,
            })
            .eq("id", pa.id);

          await supabase
            .from("payments")
            .update({ payout_completed: true, payout_at: new Date().toISOString() })
            .eq("id", resolvedSourcePaymentId);

          if (participantRowId) {
            await supabase
              .from("trip_participants")
              .update({ approved_trip: true })
              .eq("id", participantRowId);
          }

          try {
            const paidUserIds = await getPaidUserIdsForTrip(supabase, tripId, reqId);
            const approvedCount = await countApprovedPaidParticipants(supabase, tripId, paidUserIds);
            if (paidUserIds.length > 0 && approvedCount === paidUserIds.length) {
              await archiveTripAndChats(supabase, tripId);
            }
          } catch (finErr) {
            logErr(reqId, "Finalization (archive) error:", finErr?.message || finErr);
          }

          return res.status(200).json({
            success: true,
            message: "Выплата завершилась в банке ранее (COMPLETED). Повторный запуск не требуется.",
          });
        }

        return res.status(409).json({
          error: "BANK_PENDING_UNKNOWN",
          message: `Выплата в состоянии ${getState.bankStatus || "UNKNOWN"}. Новую выплату не запускаю.`,
        });
      }
    } catch (guardErr) {
      logErr(reqId, "Pending guard error:", guardErr?.message || guardErr);
    }

    // сумма: тут важно — amount_rub НЕ используем, только amount
    const grossRub = Number(pay?.amount || 0);
    if (!(grossRub > 0) && !(Number(amountNetRub) > 0)) {
      return res.status(400).json({ error: "Invalid participant payment amount" });
    }

    let netRub;
    if (Number.isFinite(Number(amountNetRub)) && Number(amountNetRub) > 0) {
      netRub = Math.floor(Number(amountNetRub) * 100) / 100;
      log(reqId, "Using override amountNetRub (NET):", { netRub });
    } else {
      const { net, platformPercent, tbankPercent, totalPercent } =
        computeNetFromGrossUsingTripPercents(grossRub, trip);
      netRub = net;
      log(reqId, "Computed gross→net:", {
        grossRub,
        netRub,
        platformPercent,
        tbankPercent,
        totalPercent,
      });
    }

    if (!(netRub > 0)) {
      return res.status(400).json({ error: "Net amount after fees is not positive" });
    }

    // prepare_payout_atomic
    let prep;
    try {
      const feePlatformPct = Number.isFinite(Number(trip?.platform_fee))
        ? Number(trip.platform_fee)
        : Number(platformSettings?.platformFeePercent || 0);

      const feeTbankPct = Number.isFinite(Number(trip?.tbank_fee))
        ? Number(trip.tbank_fee)
        : Number(platformSettings?.tbankFeePercent || 0);

      const { data, error } = await supabase.rpc("prepare_payout_atomic", {
        p_trip_id: tripId,
        p_source_payment_id: resolvedSourcePaymentId,
        p_amount_net_rub: netRub,
        p_fee_platform_pct: feePlatformPct,
        p_fee_tbank_pct: feeTbankPct,
        p_participant_id: participantRowId || null,
        p_hint_is_final: overrideFinal,
      });

      if (error) throw error;
      prep = (data && data[0]) || null;
      if (!prep?.order_id) throw new Error("prepare_payout_atomic: empty response");
    } catch (e) {
      const msg = String(e?.message || e);
      if (/PAYOUT_EXCEEDS_AVAILABLE|PAYOUT_AMOUNT_INVALID/i.test(msg)) {
        logErr(reqId, "prepare_payout_atomic business error:", msg);
        return res.status(409).json({ error: msg });
      }
      logErr(reqId, "prepare_payout_atomic error:", msg);
      return res.status(500).json({ error: "Failed to prepare payout" });
    }

    const dealId = body.dealId || trip.deal_id;
    if (!dealId) return res.status(400).json({ error: "Missing dealId for payout" });

    const amountKop = Number.isFinite(Number(prep?.amount_kop))
      ? Number(prep.amount_kop)
      : Math.trunc(Number(netRub) * 100);

    const isActuallyFinal =
      overrideFinal === true || (overrideFinal === null && !!prep?.computed_is_final);

    // банк
    let bank;
    try {
      bank = await tbankInitAndPayment({
        reqId,
        amountKop,
        dealId,
        partnerId,
        cardId,
        finalPayout: isActuallyFinal,
        orderId: prep.order_id,
        paymentRecipientId,
      });
    } catch (e) {
      const msg = String(e?.message || e);
      logErr(reqId, "Bank Init/Payment error:", msg);

      await updateAttemptByOrderId(supabase, prep.order_id, {
        status: "failed",
        last_attempt_at: new Date().toISOString(),
        error_message: msg || "unknown",
      });

      return res.status(500).json({ error: msg || "Payout error" });
    }

    if (bank.bankStatus === "CREDIT_CHECKING") {
      await updateAttemptByOrderId(supabase, prep.order_id, {
        status: "pending",
        bank_status: "CREDIT_CHECKING",
        bank_error_code: bank.bankErrorCode || null,
        bank_message: bank.bankMessage || "Асинхронная проверка (CREDIT_CHECKING)",
        bank_payload: bank.raw || null,
        last_attempt_at: new Date().toISOString(),
        payment_id: bank.paymentId,
        bank_order_id: bank.orderId,
      });

      return res.status(202).json({
        success: true,
        pending: true,
        bankStatus: "CREDIT_CHECKING",
        message:
          "Платёж на выплату подтверждается банком (CREDIT_CHECKING). Повторно запускать не нужно.",
        orderId: prep.order_id,
        bankOrderId: bank.orderId,
        paymentId: bank.paymentId,
      });
    }

    if (bank.bankStatus !== "COMPLETED") {
      await updateAttemptByOrderId(supabase, prep.order_id, {
        status: "failed",
        bank_status: bank.bankStatus,
        bank_error_code: bank.bankErrorCode || null,
        bank_message: bank.bankMessage || "Ошибка Payment",
        bank_payload: bank.raw || null,
        last_attempt_at: new Date().toISOString(),
        payment_id: bank.paymentId,
        bank_order_id: bank.orderId,
        error_message: bank.bankMessage || `Bank status ${bank.bankStatus}`,
      });

      return res.status(409).json({
        error: "BANK_NOT_COMPLETED",
        bankStatus: bank.bankStatus,
        message: bank.bankMessage || `Bank status: ${bank.bankStatus}`,
      });
    }

    // COMPLETED -> finalize
    const feePlatformPct = Number.isFinite(Number(trip?.platform_fee))
      ? Number(trip.platform_fee)
      : Number(platformSettings?.platformFeePercent || 0);

    const feeTbankPct = Number.isFinite(Number(trip?.tbank_fee))
      ? Number(trip.tbank_fee)
      : Number(platformSettings?.tbankFeePercent || 0);

    const totalPct = feePlatformPct + feeTbankPct;
    const amountNetRubFinal = Math.floor((amountKop / 100) * 100) / 100;
    const grossEquivRub =
      totalPct >= 100 ? null : Math.trunc((amountNetRubFinal / (1 - totalPct / 100)) * 100) / 100;

    await updateAttemptByOrderId(supabase, prep.order_id, {
      status: "completed",
      bank_status: "COMPLETED",
      last_attempt_at: new Date().toISOString(),
      error_message: null,
      payment_id: bank.paymentId,
      bank_order_id: bank.orderId,
      source_payment_id: resolvedSourcePaymentId,
      fee_platform_pct: feePlatformPct,
      fee_tbank_pct: feeTbankPct,
      amount_net_rub: amountNetRubFinal,
      amount_gross_equiv_rub: grossEquivRub,
    });

    // помечаем платёж как выплаченный (если у тебя нет payout_completed — лучше добавить, но обычно он есть)
    await supabase
      .from("payments")
      .update({ payout_completed: true, payout_at: new Date().toISOString() })
      .eq("id", resolvedSourcePaymentId);

    if (participantRowId) {
      await supabase.from("trip_participants").update({ approved_trip: true }).eq("id", participantRowId);
    }

    // финализация архивом (как payout.js)
    try {
      const paidUserIds = await getPaidUserIdsForTrip(supabase, tripId, reqId);
      const approvedCount = await countApprovedPaidParticipants(supabase, tripId, paidUserIds);
      log(reqId, "Finalization check:", { paidUsers: paidUserIds.length, approvedCount });

      if (paidUserIds.length > 0 && approvedCount === paidUserIds.length) {
        await archiveTripAndChats(supabase, tripId);
        log(reqId, "Trip and chats archived after last payout");
      }
    } catch (finErr) {
      logErr(reqId, "Finalization (archive) error:", finErr?.message || finErr);
    }

    // DM организатору (как payout.js)
    if (participantUserId) {
      await notifyOrganizerDmAboutApprovalAndPayout(supabase, {
        reqId,
        trip,
        participantUserId,
      });
    }

    return res.status(200).json({
      success: true,
      bankStatus: "COMPLETED",
      orderId: prep.order_id,
      bankOrderId: bank.orderId,
      paymentId: bank.paymentId,
      finalPayout: isActuallyFinal,
    });
  } catch (error) {
    logErr(reqId, "Critical payout error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
}
