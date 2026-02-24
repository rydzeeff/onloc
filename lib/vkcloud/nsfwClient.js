// ./nsfwClient.js
// Клиент на фронте: отправляет изображение на серверный API для проверки VK Cloud Vision.
// Эндпоинт: /api/vkcloud/vk-nsfw-check

export async function fileToDataUrl(file) {
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

export async function checkImageWithVkNsfw(file) {
  try {
    const imageBase64 = await fileToDataUrl(file);
    if (!imageBase64) {
      console.warn('[NSFW][client] empty imageBase64 for file:', file?.name);
      return { allowed: false, score: null, error: 'empty data' };
    }

    console.debug('[NSFW][client] sending to API:', file?.name, file?.type, file?.size);
    const r = await fetch('/api/vkcloud/vk-nsfw-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, filename: file?.name || 'image.jpg' }),
    });

    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!r.ok) {
      console.error('[NSFW][client] API error:', r.status, json);
      return { allowed: false, score: null, error: json?.error || `HTTP ${r.status}` };
    }

    console.debug('[NSFW][client] API ok; score:', json?.score, 'allowed:', json?.allowed);
    return { allowed: !!json.allowed, score: json.score ?? null, details: json };
  } catch (e) {
    console.error('[NSFW][client] check error:', e);
    return { allowed: false, score: null, error: e?.message || 'check error' };
  }
}
