// supabase/functions/trip-autostart-or-cancel/index.ts
// Авто-старт или авто-отмена поездок, у которых старт уже наступил.
//
// Логика:
// 0) Перед решением start/cancel делаем reconcile "зависших" оплат:
//    - для неоплаченных участников берём последний платеж participant_payment;
//    - делаем TBank CheckOrder по order_id;
//    - если банк вернул CONFIRMED (оплата подтвердилась поздно) -> делаем Cancel (возврат),
//      обновляем payments, и пишем в общий чат сообщение с именами.
// 1) Неоплативших исключаем "как будто сам вышел":
//    status -> rejected + удалить из chat_participants (trip_group + trip_private)
//    + погасить "висящие" непрочитанные ЛС организатора (chat_messages.read=true для сообщений участника)
// 2) Если paid нет — поездку ставим canceled (НЕ archived), чаты архивируем (chat_type -> archived)
// 3) Если paid есть — исключаем неоплативших, paid -> confirmed_start=true, trip -> started, сообщение в общий чат.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("TRIP_CRON_SECRET") ?? Deno.env.get("CRON_SECRET") ?? "";

// TBank v2 base
const TBANK_BASE = Deno.env.get("TBANK_BASE") ?? "https://rest-api-test.tinkoff.ru/v2";
const TBANK_TERMINAL_KEY = (Deno.env.get("TBANK_TERMINAL_KEY") ?? "").trim();
const TBANK_SECRET = (Deno.env.get("TBANK_SECRET") ?? Deno.env.get("TBANK_PASSWORD") ?? "").trim();

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("[trip-autostart-or-cancel] Missing SUPABASE_URL or SERVICE_ROLE_KEY env");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type TripRow = {
  id: string;
  title: string | null;
  status: string | null;
  start_date: string | null;
  creator_id: string | null;
};

type ParticipantRow = {
  id: string;
  user_id: string | null;
  status: string | null;
  confirmed_start: boolean | null;
  approved_trip: boolean | null;
};

type PaymentRow = {
  id: string;
  trip_id: string;
  participant_id: string | null;
  amount: any; // numeric/text
  status: string | null; // "pending" etc (your DB)
  payment_type: string | null; // "participant_payment"
  payment_id: string | null; // bank PaymentId
  order_id: string | null; // bank OrderId
  is_confirmed: boolean | null;
  is_authorized: boolean | null;
  is_refunded: boolean | null;
  refunded_at: string | null;
  updated_at: string | null;
  created_at: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-cron-secret",
};

const nowUtc = () => new Date();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startedAt = new Date().toISOString();
  console.log("[trip-autostart-or-cancel] request start", { at: startedAt });

  try {
    const headerSecret = req.headers.get("x-cron-secret") || "";
    if (CRON_SECRET && headerSecret !== CRON_SECRET) {
      console.warn("[trip-autostart-or-cancel] Forbidden: invalid x-cron-secret");
      return json({ ok: false, error: "Forbidden" }, 403);
    }

    const now = nowUtc();
    const nowIso = now.toISOString();
    console.log("[trip-autostart-or-cancel] now UTC =", nowIso);

    // active-поездки, где старт уже наступил
    const { data: trips, error: tripsErr } = await supabase
      .from("trips")
      .select("id, title, start_date, status, creator_id")
      .eq("status", "active")
      .lt("start_date", nowIso)
      .order("start_date", { ascending: true })
      .limit(200);

    if (tripsErr) {
      console.error("[trip-autostart-or-cancel] trips select error", tripsErr);
      return json({ ok: false, error: "trips select error", details: tripsErr.message }, 500);
    }

    const list = (trips || []) as TripRow[];
    console.log("[trip-autostart-or-cancel] found trips:", list.length);

    if (list.length === 0) {
      return json({ ok: true, processed: 0, errors: [] }, 200);
    }

    let processed = 0;
    const errors: any[] = [];

    for (const trip of list) {
      try {
        await processTrip(trip);
        processed++;
      } catch (e) {
        console.error("[trip-autostart-or-cancel] error per trip", { tripId: trip.id, error: e });
        errors.push({ tripId: trip.id, error: (e as Error)?.message || String(e) });
      }
    }

    console.log("[trip-autostart-or-cancel] done", { processed, errorsCount: errors.length });
    return json({ ok: true, processed, errors }, errors.length ? 207 : 200);
  } catch (e) {
    console.error("[trip-autostart-or-cancel] fatal error", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function processTrip(trip: TripRow) {
  const tripId = trip.id;

  console.log("[processTrip] trip", tripId, {
    status: trip.status,
    start_date: trip.start_date,
  });

  // 0) Перечитываем участников
  const { data: rows, error: partsErr } = await supabase
    .from("trip_participants")
    .select("id, user_id, status, confirmed_start, approved_trip")
    .eq("trip_id", tripId);

  if (partsErr) throw new Error(`load participants error: ${partsErr.message}`);

  const participants = (rows || []) as ParticipantRow[];

  // 1) Чаты поездки (нужны для чистки участников/сообщений)
  const chatIds = await getTripChatIds(tripId);
  const dmChatIds = await getTripDmChatIds(tripId);
  const groupChatId = await getTripGroupChatId(tripId);

  // 0.1) ✅ reconcile "зависших" платежей: поздний CONFIRMED -> Cancel -> сообщение в чат
  const reconcileCandidates = participants.filter((p) => {
    const st = (p.status || "").toLowerCase();
    // проверяем тех, кто ещё не paid/rejected (т.е. может быть "confirmed/pending/authorizing/..."):
    return st !== "paid" && st !== "rejected";
  });

  let lateRefundedUserIds: string[] = [];
  if (reconcileCandidates.length) {
    try {
      lateRefundedUserIds = await reconcileLateConfirmedPayments(tripId, reconcileCandidates);
    } catch (e) {
      console.error("[processTrip] reconcileLateConfirmedPayments error", tripId, e);
    }
  }

  if (lateRefundedUserIds.length) {
    try {
      await sendTripLateConfirmedRefundMessage(trip, lateRefundedUserIds, groupChatId);
    } catch (e) {
      console.error("[processTrip] sendTripLateConfirmedRefundMessage error", tripId, e);
    }
  }

  // paid считаем по статусу trip_participants (как у тебя сейчас)
  const paid = participants.filter((p) => (p.status || "").toLowerCase() === "paid");
  const hasParticipants = participants.length > 0;
  const hasPaid = paid.length > 0;

  // helper: кто "не оплатил" (всё, что НЕ paid и НЕ rejected)
  const unpaid = participants.filter((p) => {
    const st = (p.status || "").toLowerCase();
    return st !== "paid" && st !== "rejected";
  });

  // ---- CASE A: нет участников или нет paid ----
  if (!hasParticipants || !hasPaid) {
    console.log("[processTrip] trip", tripId, "-> cancel (no paid/participants)");

    // если участники есть, но оплат нет — чистим их как "сам вышел":
    if (unpaid.length) {
      await rejectAndCleanupUsers({
        tripId,
        trip,
        unpaidParticipants: unpaid,
        chatIds,
        dmChatIds,
        groupChatId,
        reason: "no_paid",
      });
    }

    // сообщение в общий чат: поездка отменена
    try {
      const reason: "no_participants" | "no_paid_participants" =
        !hasParticipants ? "no_participants" : "no_paid_participants";
      await sendTripAutoCancelMessage(trip, reason, groupChatId);
    } catch (e) {
      console.error("[processTrip] sendTripAutoCancelMessage error", tripId, e);
    }

    // поездку в canceled и архивируем чаты
    await finalizeTripWithStatus(tripId, "canceled");
    return;
  }

  // ---- CASE B: есть paid ----
  console.log("[processTrip] trip", tripId, "-> start (has paid)");

  // 2) Исключаем неоплативших "как будто вышли сами"
  if (unpaid.length) {
    await rejectAndCleanupUsers({
      tripId,
      trip,
      unpaidParticipants: unpaid,
      chatIds,
      dmChatIds,
      groupChatId,
      reason: "unpaid_before_start",
    });

    // Сообщение в общий чат поездки: кто исключён за неоплату
    try {
      await sendTripAutoExcludeUnpaidMessage(trip, unpaid, groupChatId);
    } catch (e) {
      console.error("[processTrip] sendTripAutoExcludeUnpaidMessage error", tripId, e);
    }
  }

  // 3) paid → confirmed_start=true (approved_trip НЕ ТРОГАЕМ)
  const { error: confErr } = await supabase
    .from("trip_participants")
    .update({ confirmed_start: true })
    .eq("trip_id", tripId)
    .eq("status", "paid");

  if (confErr) {
    console.error("[processTrip] set confirmed_start for paid error", tripId, confErr);
  }

  // 4) Trip -> started
  const { error: tripErr } = await supabase
    .from("trips")
    .update({ status: "started" })
    .eq("id", tripId)
    .eq("status", "active");

  if (tripErr) {
    throw new Error(`update trip->started error: ${tripErr.message}`);
  }

  console.log("[processTrip] trip", tripId, "started; paid participants:", paid.length);

  // 5) Сообщение в trip_group про авто-старт
  try {
    await sendTripAutoStartMessage(trip, groupChatId);
  } catch (e) {
    console.error("[processTrip] sendTripAutoStartMessage error", tripId, e);
  }
}

/** ===== TBank helpers (v2) ===== */

// Тинькофф/Т-Банк "зависшие/переходные" статусы (по CheckOrder Payments[0].Status)
const TBANK_PENDING_LIKE = new Set([
  "NEW",
  "FORM_SHOWED",
  "AUTHORIZING",
  "AUTHORIZED",
  "CONFIRMING",
  "CONFIRMED", // нам важен: поздно подтвердился
]);

function mask(s: string, keepStart = 4, keepEnd = 4) {
  const str = String(s || "");
  if (!str) return "";
  if (str.length <= keepStart + keepEnd) return str;
  return `${str.slice(0, keepStart)}…${str.slice(-keepEnd)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuf);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildTokenWithPassword(params: Record<string, any>, password: string): Promise<string> {
  const excluded = new Set(["Token", "DigestValue", "SignatureValue", "X509SerialNumber"]);

  const sortedKeys = Object.keys({ ...params, Password: password })
    .filter((k) => !excluded.has(k))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const base = { ...params, Password: password };
  const concat = sortedKeys.map((k) => String(base[k])).join("");
  return await sha256Hex(concat);
}

async function tbankCheckOrder(orderId: string) {
  if (!TBANK_TERMINAL_KEY || !TBANK_SECRET) {
    throw new Error("TBANK env missing (TBANK_TERMINAL_KEY / TBANK_SECRET)");
  }

  const url = `${TBANK_BASE}/CheckOrder`;
  const payload: Record<string, any> = {
    TerminalKey: TBANK_TERMINAL_KEY,
    OrderId: String(orderId),
  };
  payload.Token = await buildTokenWithPassword(payload, TBANK_SECRET);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await resp.json().catch(() => ({} as any));
  const payment0 = Array.isArray(json?.Payments) ? json.Payments[0] : null;
  const bankStatus = String(payment0?.Status || json?.Status || "").toUpperCase();

  return {
    ok: resp.ok && json?.Success !== false && String(json?.ErrorCode || "0") === "0",
    httpStatus: resp.status,
    bankStatus,
    raw: json,
  };
}

async function tbankCancelPayment(paymentId: string, amountRub: number) {
  if (!TBANK_TERMINAL_KEY || !TBANK_SECRET) {
    throw new Error("TBANK env missing (TBANK_TERMINAL_KEY / TBANK_SECRET)");
  }

  const url = `${TBANK_BASE}/Cancel`;
  const amountKop = Math.round(Number(amountRub) * 100);

  const payload: Record<string, any> = {
    TerminalKey: TBANK_TERMINAL_KEY,
    PaymentId: String(paymentId),
    Amount: amountKop,
  };
  payload.Token = await buildTokenWithPassword(payload, TBANK_SECRET);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await resp.json().catch(() => ({} as any));
  return {
    ok: resp.ok && json?.Success !== false && String(json?.ErrorCode || "0") === "0",
    httpStatus: resp.status,
    raw: json,
  };
}

/**
 * reconcileLateConfirmedPayments:
 * - Для кандидатов (не paid/rejected) находим их последний participant_payment
 * - Делаем CheckOrder по order_id
 * - Если банкStatus=CONFIRMED -> делаем Cancel, помечаем payment как refunded/canceled
 * - Возвращаем список participant_id (user_id) кому сделали возврат
 */
async function reconcileLateConfirmedPayments(tripId: string, candidates: ParticipantRow[]): Promise<string[]> {
  const userIds = Array.from(new Set(candidates.map((p) => p.user_id).filter(Boolean))) as string[];
  if (!userIds.length) return [];

  // подтягиваем платежи только для этих участников
  const { data: pays, error: payErr } = await supabase
    .from("payments")
    .select(
      "id, trip_id, participant_id, amount, status, payment_type, payment_id, order_id, is_confirmed, is_authorized, is_refunded, refunded_at, updated_at, created_at",
    )
    .eq("trip_id", tripId)
    .eq("payment_type", "participant_payment")
    .in("participant_id", userIds)
    .order("created_at", { ascending: false });

  if (payErr) {
    console.error("[reconcile] payments select error", { tripId, err: payErr.message });
    return [];
  }

  const list = (pays || []) as PaymentRow[];

  // берём самый свежий платёж на каждого участника
  const latestByUser = new Map<string, PaymentRow>();
  for (const p of list) {
    const uid = p.participant_id;
    if (!uid) continue;
    if (!latestByUser.has(uid)) latestByUser.set(uid, p);
  }

  const refundedUserIds: string[] = [];

  for (const uid of userIds) {
    const pay = latestByUser.get(uid);
    if (!pay) continue;

    const dbStatus = String(pay.status || "").toLowerCase();
    const alreadyRefunded = pay.is_refunded === true || dbStatus === "canceled" || dbStatus === "refunded";
    if (alreadyRefunded) continue;

    // если нет order_id — нечего проверять
    const orderId = String(pay.order_id || "").trim();
    if (!orderId) continue;

    // Решаем: когда вообще лезем в CheckOrder
    // - если у нас status "pending" (твоя БД) или flags is_authorized/is_confirmed
    // - или если участник в trip_participants имеет "подозрительный" статус (confirmed/authorizing/...)
    const shouldCheck =
      dbStatus === "pending" ||
      dbStatus === "new" ||
      pay.is_authorized === true ||
      pay.is_confirmed === true;

    if (!shouldCheck) continue;

    try {
      const chk = await tbankCheckOrder(orderId);
      const bankSt = String(chk.bankStatus || "").toUpperCase();

      console.log("[reconcile] CheckOrder", {
        tripId,
        participantId: uid,
        orderId: mask(orderId),
        ok: chk.ok,
        bankStatus: bankSt,
      });

      // если банк вернул CONFIRMED — оплата подтвердилась, но мы её не успели учесть.
      // по твоей новой логике: "подтвердилась поздно" -> делаем отмену платежа
      if (bankSt === "CONFIRMED") {
        const paymentId = String(pay.payment_id || "").trim();
        const amountRub = Number(pay.amount || 0);

        if (!paymentId || !(amountRub > 0)) {
          console.warn("[reconcile] CONFIRMED but missing payment_id/amount", {
            tripId,
            participantId: uid,
            paymentId: pay.payment_id,
            amount: pay.amount,
          });
          continue;
        }

        const cancel = await tbankCancelPayment(paymentId, amountRub);
        console.log("[reconcile] Cancel", {
          tripId,
          participantId: uid,
          paymentId: mask(paymentId),
          amountRub,
          ok: cancel.ok,
          httpStatus: cancel.httpStatus,
        });

        if (cancel.ok) {
          const nowIso = new Date().toISOString();
          const { error: updErr } = await supabase
            .from("payments")
            .update({
              is_refunded: true,
              refunded_at: nowIso,
              status: "canceled",
              updated_at: nowIso,
            })
            .eq("id", pay.id);

          if (updErr) {
            console.error("[reconcile] update payment -> refunded error", {
              tripId,
              payId: pay.id,
              err: updErr.message,
            });
          } else {
            refundedUserIds.push(uid);
          }
        } else {
          console.error("[reconcile] Cancel failed", {
            tripId,
            participantId: uid,
            paymentId: mask(paymentId),
            bank: cancel.raw,
          });
        }

        continue;
      }

      // Для “зависших” статусов просто фиксируем, что они есть (мы НЕ отменяем их автоматически)
      if (TBANK_PENDING_LIKE.has(bankSt)) {
        // NEW/FORM_SHOWED/AUTHORIZING/AUTHORIZED/CONFIRMING — всё ещё висит
        // Можно оставить лог и продолжать — поездка дальше пойдёт по твоей текущей логике.
        continue;
      }

      // Финальные негативные статусы — просто логируем (и дальше поездка решит, что нет paid)
      if (bankSt === "REJECTED" || bankSt === "CANCELLED" || bankSt === "DEADLINE_EXPIRED") {
        continue;
      }
    } catch (e) {
      console.error("[reconcile] error per payment", {
        tripId,
        participantId: uid,
        orderId: mask(orderId),
        error: (e as Error)?.message || String(e),
      });
    }
  }

  return Array.from(new Set(refundedUserIds));
}

/** ===== helpers: chat ids ===== */
async function getTripChatIds(tripId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("chats")
    .select("id")
    .eq("trip_id", tripId)
    .in("chat_type", ["trip_group", "trip_private"]);
  if (error) throw error;
  return (data || []).map((c: any) => c.id);
}

async function getTripDmChatIds(tripId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("chats")
    .select("id")
    .eq("trip_id", tripId)
    .eq("chat_type", "trip_private");
  if (error) throw error;
  return (data || []).map((c: any) => c.id);
}

async function getTripGroupChatId(tripId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("chats")
    .select("id")
    .eq("trip_id", tripId)
    .eq("chat_type", "trip_group")
    .maybeSingle();
  if (error) return null;
  return data?.id ?? null;
}

/** ===== helpers: profiles / names ===== */
async function getUserFullNames(userIds: string[]): Promise<Record<string, string>> {
  const uniq = Array.from(new Set(userIds.filter(Boolean)));
  if (!uniq.length) return {};

  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, first_name, last_name, patronymic")
    .in("user_id", uniq);

  if (error) {
    console.error("[getUserFullNames] profiles load error", error);
    return {};
  }

  const map: Record<string, string> = {};
  for (const row of (data || []) as any[]) {
    const full = [row.last_name, row.first_name, row.patronymic].filter(Boolean).join(" ").trim();
    map[row.user_id] = full || "Неизвестный пользователь";
  }
  return map;
}

/** ===== core: reject + cleanup (как confirmLeaveTrip по смыслу) ===== */
async function rejectAndCleanupUsers(opts: {
  tripId: string;
  trip: TripRow;
  unpaidParticipants: ParticipantRow[];
  chatIds: string[];
  dmChatIds: string[];
  groupChatId: string | null;
  reason: "unpaid_before_start" | "no_paid";
}) {
  const { unpaidParticipants, chatIds, dmChatIds } = opts;

  const ids = unpaidParticipants.map((p) => p.id).filter(Boolean);
  const userIds = unpaidParticipants.map((p) => p.user_id).filter(Boolean) as string[];

  if (!ids.length || !userIds.length) return;

  // 1) status -> rejected
  const { error: updErr } = await supabase
    .from("trip_participants")
    .update({ status: "rejected" })
    .in("id", ids);

  if (updErr) {
    console.error("[rejectAndCleanupUsers] update trip_participants->rejected error", updErr);
  }

  // 2) погасить "висящие" непрочитанные ЛС организатора с этими участниками
  if (dmChatIds.length) {
    const { error: readErr } = await supabase
      .from("chat_messages")
      .update({ read: true })
      .in("chat_id", dmChatIds)
      .in("user_id", userIds)
      .eq("read", false);

    if (readErr) {
      console.error("[rejectAndCleanupUsers] mark dm messages read error", readErr);
    }
  }

  // 3) удалить этих пользователей из всех чатов поездки (trip_group + trip_private)
  if (chatIds.length) {
    const { error: delErr } = await supabase
      .from("chat_participants")
      .delete()
      .in("chat_id", chatIds)
      .in("user_id", userIds);

    if (delErr) {
      console.error("[rejectAndCleanupUsers] delete chat_participants error", delErr);
    }
  }
}

/** ===== messaging ===== */
async function sendTripLateConfirmedRefundMessage(
  trip: TripRow,
  userIds: string[],
  groupChatId: string | null,
) {
  const tripId = trip.id;
  if (!groupChatId) return;

  const uniq = Array.from(new Set(userIds.filter(Boolean))).slice(0, 20);
  if (!uniq.length) return;

  const namesMap = await getUserFullNames(uniq);
  const items = uniq.map((uid) => namesMap[uid] || uid.slice(0, 8));

  const title = (trip.title || "").trim() || "без названия";
  const list = items.length ? `\n— ${items.join("\n— ")}` : "";

  const content =
    `Оплата по поездке «${title}» была подтверждена банком с задержкой и автоматически возвращена.` +
    list;

  const senderUserId = trip.creator_id || null;

  const { error: msgErr } = await supabase.from("chat_messages").insert({
    chat_id: groupChatId,
    user_id: senderUserId,
    content,
    read: false,
  });

  if (msgErr) {
    console.error("[sendTripLateConfirmedRefundMessage] insert chat_message error", tripId, msgErr);
  }
}

async function sendTripAutoStartMessage(trip: TripRow, groupChatId: string | null) {
  const tripId = trip.id;
  if (!groupChatId) {
    console.warn("[sendTripAutoStartMessage] no trip_group chat for trip", tripId);
    return;
  }

  const title = (trip.title || "").trim() || "без названия";
  const startDate = trip.start_date ? new Date(trip.start_date) : null;

  let when = "";
  if (startDate) {
    const iso = startDate.toISOString();
    when = iso.slice(0, 16).replace("T", " ");
  }

  const content = [
    `Поездка «${title}» автоматически началась, так как наступило время выезда${when ? ` (${when} по серверному времени)` : ""}.`,
    "Все участники с оплаченной бронью отмечены как присутствующие.",
  ].join(" ");

  const senderUserId = trip.creator_id || null;

  const { error: msgErr } = await supabase.from("chat_messages").insert({
    chat_id: groupChatId,
    user_id: senderUserId,
    content,
    read: false,
  });

  if (msgErr) {
    console.error("[sendTripAutoStartMessage] insert chat_message error", tripId, msgErr);
  } else {
    console.log("[sendTripAutoStartMessage] message sent to trip_group for trip", tripId);
  }
}

async function sendTripAutoExcludeUnpaidMessage(trip: TripRow, unpaid: ParticipantRow[], groupChatId: string | null) {
  const tripId = trip.id;
  if (!groupChatId) {
    console.warn("[sendTripAutoExcludeUnpaidMessage] no trip_group chat for trip", tripId);
    return;
  }

  const userIds = unpaid.map((p) => p.user_id).filter(Boolean) as string[];
  const namesMap = await getUserFullNames(userIds);

  const items = userIds.map((uid) => namesMap[uid] || uid.slice(0, 8)).slice(0, 20);

  const title = (trip.title || "").trim() || "без названия";
  const list = items.length ? `\n— ${items.join("\n— ")}` : "";

  const content =
    `Неоплаченные участники автоматически исключены из поездки «${title}», ` +
    `так как к моменту старта оплата не была внесена.` +
    list;

  const senderUserId = trip.creator_id || null;

  const { error: msgErr } = await supabase.from("chat_messages").insert({
    chat_id: groupChatId,
    user_id: senderUserId,
    content,
    read: false,
  });

  if (msgErr) {
    console.error("[sendTripAutoExcludeUnpaidMessage] insert chat_message error", tripId, msgErr);
  } else {
    console.log("[sendTripAutoExcludeUnpaidMessage] message sent", tripId);
  }
}

async function sendTripAutoCancelMessage(
  trip: TripRow,
  reason: "no_participants" | "no_paid_participants",
  groupChatId: string | null,
) {
  const tripId = trip.id;
  if (!groupChatId) {
    console.warn("[sendTripAutoCancelMessage] no trip_group chat for trip", tripId);
    return;
  }

  const title = (trip.title || "").trim() || "без названия";
  const startDate = trip.start_date ? new Date(trip.start_date) : null;

  let when = "";
  if (startDate) {
    const iso = startDate.toISOString();
    when = iso.slice(0, 16).replace("T", " ");
  }

  const reasonText =
    reason === "no_participants"
      ? "На момент начала поездки в ней не осталось ни одного участника."
      : "На момент начала поездки не было ни одного участника с оплаченной бронью.";

  const content =
    `Поездка «${title}» автоматически отменена, так как наступило время выезда` +
    (when ? ` (${when} по серверному времени). ` : ". ") +
    reasonText;

  const senderUserId = trip.creator_id || null;

  const { error: msgErr } = await supabase.from("chat_messages").insert({
    chat_id: groupChatId,
    user_id: senderUserId,
    content,
    read: false,
  });

  if (msgErr) {
    console.error("[sendTripAutoCancelMessage] insert chat_message error", tripId, msgErr);
  } else {
    console.log("[sendTripAutoCancelMessage] message sent to trip_group for trip", tripId);
  }
}

/** ===== finalization ===== */
async function finalizeTripWithStatus(tripId: string, finalStatus: "canceled" | "archived" | string) {
  const { error: tripErr } = await supabase.from("trips").update({ status: finalStatus }).eq("id", tripId);

  if (tripErr) {
    console.error("[finalizeTripWithStatus] update trip error", tripId, tripErr);
  }

  // как раньше: при canceled/archived архивируем чаты (chat_type -> archived)
  if (finalStatus === "canceled" || finalStatus === "archived") {
    const nowIso = new Date().toISOString();

    const { error: chatsErr } = await supabase
      .from("chats")
      .update({
        chat_type: "archived",
        support_close_confirmed: true,
        support_close_requested_at: nowIso,
      })
      .eq("trip_id", tripId)
      .neq("chat_type", "archived");

    if (chatsErr) {
      console.error("[finalizeTripWithStatus] archive chats error", tripId, chatsErr);
    }
  }
}
