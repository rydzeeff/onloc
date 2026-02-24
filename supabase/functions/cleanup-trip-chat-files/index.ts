// supabase/functions/cleanup-trip-chat-files/index.ts
// Deno Edge Function
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_KEY = Deno.env.get("CRON_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = "trip_chat_files";

// Превращаем поля arrival_date (date) + arrival_time (nullable) в Date
function toDateTime(arrival_date: string | null, arrival_time: string | null) {
  if (!arrival_date) return null;
  const time = arrival_time || "00:00";
  // трактуем как UTC; при необходимости можно сместить ваш TZ
  return new Date(`${arrival_date}T${time}:00Z`);
}

// Рекурсивный сбор всех файлов под path
async function listAllPaths(basePath: string): Promise<string[]> {
  const all: string[] = [];

  // пагинация
  let offset = 0;
  const limit = 100;

  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(basePath, {
      limit,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      console.error("list error", error, basePath);
      break;
    }
    const entries = data || [];
    if (!entries.length) break;

    for (const e of entries) {
      // У объекта с файлами есть metadata; у "папок" её нет
      if ((e as any).metadata) {
        all.push(`${basePath}/${e.name}`); // файл
      } else {
        // папка → углубляемся
        const sub = await listAllPaths(`${basePath}/${e.name}`);
        all.push(...sub);
      }
    }

    if (entries.length < limit) break;
    offset += entries.length;
  }

  return all;
}

serve(async (req) => {
  // простая авторизация CRON-запуска
  if (req.headers.get("x-cron-key") !== CRON_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  // Получаем все поездки
  const { data: trips, error: tripsErr } = await supabase
    .from("trips")
    .select("id, arrival_date, arrival_time, status");
  if (tripsErr) {
    console.error(tripsErr);
    return new Response("Error selecting trips", { status: 500 });
  }

  // Фильтр: завершившиеся более 5 дней назад
  const expiredTripIds = (trips || [])
    .filter((t) => {
      const dt = toDateTime(t.arrival_date as any, (t.arrival_time as any) || null);
      return dt !== null && dt < cutoff;
    })
    .map((t) => t.id);

  if (!expiredTripIds.length) {
    return new Response(JSON.stringify({ deleted: 0 }), { headers: { "content-type": "application/json" } });
  }

  // Чаты этих поездок
  const { data: chats, error: chatsErr } = await supabase
    .from("chats")
    .select("id, trip_id")
    .in("trip_id", expiredTripIds);
  if (chatsErr) {
    console.error(chatsErr);
    return new Response("Error selecting chats", { status: 500 });
  }

  let deletedCount = 0;
  const deletedPaths: string[] = [];

  // Собираем все пути файлов → удаляем батчами
  for (const ch of chats || []) {
    const basePath = `trips/${ch.trip_id}/chats/${ch.id}`;
    const paths = await listAllPaths(basePath); // все файлы во всех message_id-папках
    if (!paths.length) continue;

    // удаляем батчами по 100
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const { error: delErr } = await supabase.storage.from(BUCKET).remove(chunk);
      if (delErr) {
        console.error("remove error", delErr, chunk);
        continue;
      }
      deletedCount += chunk.length;
      deletedPaths.push(...chunk);
    }
  }

  // Чистим метаданные chat_message_files по удалённым путям (батчами по 500)
  for (let i = 0; i < deletedPaths.length; i += 500) {
    const chunk = deletedPaths.slice(i, i + 500);
    const { error: metaErr } = await supabase
      .from("chat_message_files")
      .delete()
      .in("path", chunk);
    if (metaErr) console.error("delete meta error", metaErr);
  }

  return new Response(JSON.stringify({ deleted: deletedCount }), {
    headers: { "content-type": "application/json" },
  });
});
