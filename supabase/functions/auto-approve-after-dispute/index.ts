// /home/deno/functions/auto-approve-after-dispute/index.ts
// Авто-одобрение поездок по истечении dispute_period_ends_at,
// если участник не открыл спор и не нажал "Одобрить".

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CRON_SECRET =
  Deno.env.get("TRIP_CRON_SECRET") ?? Deno.env.get("CRON_SECRET") ?? "";

const APP_BASE_URL =
  Deno.env.get("INTERNAL_APP_BASE_URL") ||
  Deno.env.get("NEXT_PUBLIC_BASE_URL") ||
  "http://127.0.0.1:3000";

// 🔐 новый секрет для внутреннего API /api/internal/payout
const INTERNAL_PAYOUT_SECRET = Deno.env.get("INTERNAL_PAYOUT_SECRET") ?? "";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("[auto-approve] Missing SUPABASE_URL or SERVICE_ROLE_KEY env");
}
if (!INTERNAL_PAYOUT_SECRET) {
  console.error("[auto-approve] Missing INTERNAL_PAYOUT_SECRET env");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function nowUtc() {
  return new Date();
}

// helper для fetch с таймаутом — чтобы не висеть до таймаута Kong’а
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// helper для JSON-ответов
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  console.log("[auto-approve] request start", { at: startedAt });

  try {
    // 0) защита крона
    const headerSecret = req.headers.get("x-cron-secret") || "";
    if (CRON_SECRET && headerSecret !== CRON_SECRET) {
      console.warn("[auto-approve] Forbidden: invalid x-cron-secret");
      return json({ ok: false, error: "Forbidden" }, 403);
    }

    if (!INTERNAL_PAYOUT_SECRET) {
      console.error("[auto-approve] INTERNAL_PAYOUT_SECRET is empty -> cannot call internal payout");
      return json({ ok: false, error: "Missing INTERNAL_PAYOUT_SECRET" }, 500);
    }

    const now = nowUtc();
    console.log("[auto-approve] now UTC =", now.toISOString());

    // 1) Поездки, у которых окончен dispute_period_ends_at и статус finished
    const { data: trips, error: tripsErr } = await supabase
      .from("trips")
      .select("id, title, creator_id, dispute_period_ends_at, status")
      .eq("status", "finished")
      .lte("dispute_period_ends_at", now.toISOString())
      .limit(20);

    if (tripsErr) {
      console.error("[auto-approve] trips select error", tripsErr);
      return json({ ok: false, error: "trips select error" }, 500);
    }

    console.log("[auto-approve] found trips:", trips?.length ?? 0);
    if (!trips || trips.length === 0) {
      return json({ ok: true, processed: 0 });
    }

    let processed = 0;
    const errors: any[] = [];

    for (const trip of trips) {
      try {
        console.log("[auto-approve] processing trip", {
          tripId: trip.id,
          title: trip.title,
          dispute_period_ends_at: trip.dispute_period_ends_at,
        });

        // 2) Открытые споры по этой поездке (по initiator_id)
        const { data: disputes, error: disputesErr } = await supabase
          .from("disputes")
          .select("id, initiator_id, status")
          .eq("trip_id", trip.id)
          .in("status", ["awaiting_moderator", "in_progress"]);

        if (disputesErr) {
          console.error("[auto-approve] disputes select error", {
            tripId: trip.id,
            error: disputesErr,
          });
          errors.push({
            tripId: trip.id,
            error: "disputes select error",
          });
          continue; // лучше пропустить поездку, чем одобрить при открытом споре
        }

        const initiatorsWithOpenDispute = new Set(
          (disputes || []).map((d: any) => d.initiator_id)
        );

        console.log("[auto-approve] open disputes by initiator:", {
          tripId: trip.id,
          initiatorsCount: initiatorsWithOpenDispute.size,
        });

        // 3) Участники: оплаченные, ещё не одобрившие поездку
        const { data: participants, error: partErr } = await supabase
          .from("trip_participants")
          .select("id, user_id, status, approved_trip")
          .eq("trip_id", trip.id)
          .eq("status", "paid")
          .is("approved_trip", null);

        if (partErr) {
          console.error("[auto-approve] participants error", {
            tripId: trip.id,
            error: partErr,
          });
          errors.push({
            tripId: trip.id,
            error: "participants select error",
          });
          continue;
        }

        // исключаем тех, кто является initiator активного спора
        const eligible = (participants || []).filter(
          (p: any) => !initiatorsWithOpenDispute.has(p.user_id)
        );

        console.log("[auto-approve] eligible participants:", eligible.length);

        for (const p of eligible) {
          try {
            console.log("[auto-approve] processing participant", {
              tripId: trip.id,
              participantRowId: p.id,
              userId: p.user_id,
            });

            // 4) Внутренний payout через Next endpoint /api/internal/payout
            // Он:
            //  - сам делает prepare_payout_atomic + банк
            //  - сам ставит approved_trip = true (только при COMPLETED)
            //  - сам отправляет ЛС организатору (текст авто-одобрения)
            const payoutBody = {
              tripId: trip.id,
              participantRowId: p.id,
            };

            const resp = await fetchWithTimeout(
              `${APP_BASE_URL}/api/internal/payout`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-internal-secret": INTERNAL_PAYOUT_SECRET,
                },
                body: JSON.stringify(payoutBody),
              },
              15000
            );

            let payload: any = null;
            try {
              payload = await resp.json();
            } catch {
              payload = null;
            }

            // 202 (CREDIT_CHECKING) — не ошибка, просто подождать следующего крона
            if (resp.status === 202) {
              console.log("[auto-approve] payout pending (202)", {
                tripId: trip.id,
                participantRowId: p.id,
                payload,
              });
              errors.push({
                tripId: trip.id,
                participantRowId: p.id,
                error: "payout pending (CREDIT_CHECKING)",
              });
              continue;
            }

            if (!resp.ok) {
              console.error("[auto-approve] payout resp not ok", {
                tripId: trip.id,
                participantRowId: p.id,
                status: resp.status,
                payload,
              });
              errors.push({
                tripId: trip.id,
                participantRowId: p.id,
                error: "payout http not ok",
                status: resp.status,
              });
              continue;
            }

            console.log("[auto-approve] payout success", {
              tripId: trip.id,
              participantRowId: p.id,
              payload,
            });

            processed++;
          } catch (perPartError) {
            console.error("[auto-approve] error per participant", {
              tripId: trip.id,
              participantRowId: p.id,
              error: perPartError,
            });
            errors.push({
              tripId: trip.id,
              participantRowId: p.id,
              error: String(perPartError),
            });
          }
        }
      } catch (perTripError) {
        console.error("[auto-approve] error per trip", {
          tripId: trip.id,
          error: perTripError,
        });
        errors.push({ tripId: trip.id, error: String(perTripError) });
      }
    }

    console.log("[auto-approve] done", {
      processed,
      errorsCount: errors.length,
    });

    return json({ ok: true, processed, errors }, errors.length ? 207 : 200);
  } catch (e) {
    console.error("[auto-approve] fatal error", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
