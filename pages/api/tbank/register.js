// pages/api/tbank/register.js
import { tbankRegister, toBillingDescriptor, parseAddress } from './_client';

export const config = { api: { bodyParser: true } };

const DEBUG = String(process.env.TBANK_DEBUG || '').toLowerCase() === 'true';
function dlog(...args) { if (DEBUG) console.log('[TBANK][register]', ...args); }

const asString = (v) => (v ?? '').toString().trim();
const onlyDigits = (v) => (v ?? '').toString().replace(/\D/g, '');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    dlog('Incoming body:', JSON.stringify(req.body, null, 2));

    const {
      // базовые данные компании / ИП
      name,
      full_name,
      inn,
      kpp,
      ogrn,
      legalAddress,
      address,
      phone,
      ceo_first_name,
      ceo_last_name,
      ceo_middle_name,

      // банковские реквизиты
      payment_account,
      payment_bik,
      payment_corr_account,
      bank_name,
      payment_details,

      // прочее/необязательное
      site_url,
      mcc,
      comment,
      partnerEmail,
      shopArticleId,
    } = req.body || {};

    const shortName = asString(name || full_name);
    const fullName = asString(full_name || name);
    const billingDescriptor = toBillingDescriptor(shortName);

    const _inn = onlyDigits(inn);
    const isIP = /^\d{12}$/.test(_inn);
    const _ogrn = onlyDigits(ogrn);
    const _kpp = isIP ? '000000000' : (onlyDigits(kpp) || '000000000');

    const legalAddressNormalized = asString(legalAddress) || asString(address);
    const addr = parseAddress(legalAddressNormalized || '');

    // Пэйлоад без `name2` — серверная схема Merchant его не принимает
    const payload = {
      serviceProviderEmail: process.env.TBANK_PARTNER_EMAIL || asString(partnerEmail) || 'onloc@bk.ru',
      shopArticleId: asString(shopArticleId) || `onloc_${_inn}`,
      billingDescriptor,
      fullName: fullName || shortName,
      name: shortName,

      inn: _inn,
      kpp: _kpp,
      ogrn: _ogrn ? Number(_ogrn) : undefined,

      addresses: [
        {
          type: 'legal',
          zip: asString(addr?.zip) || '101000',
          country: 'RUS',
          city: asString(addr?.city) || 'Москва',
          // Ваша parseAddress уже собирает «улица, дом» в street — оставляем как есть
          street: asString(addr?.street) || legalAddressNormalized,
          description: 'Юридический адрес',
        },
      ],

      phones: [
        {
          type: 'common',
          phone: asString(phone),
        },
      ],

      email: asString(partnerEmail) || 'onloc@bk.ru',

      ceo: {
        firstName: asString(ceo_first_name),
        lastName: asString(ceo_last_name),
        middleName: asString(ceo_middle_name) || undefined,
        phone: asString(phone),
        country: 'RUS',
      },

      siteUrl: asString(site_url) || process.env.NEXT_PUBLIC_BASE_URL,

      bankAccount: {
        account: asString(payment_account),
        korAccount: asString(payment_corr_account) || undefined,
        bankName: asString(bank_name),
        bik: asString(payment_bik),
        details: asString(payment_details),
      },

      comment: asString(comment) || undefined,
      nonResident: false,
      ...(mcc ? { mcc: Number(mcc) } : {}),
    };

    dlog('REGISTER → payload:', JSON.stringify(payload, null, 2));
    const result = await tbankRegister(payload);

    res.status(200).json({
      success: true,
      shopCode: result?.shopCode,
      code: result?.code,
      raw: result,
    });
} catch (err) {
  const status = err?.response?.status || 400;

  // payload от ТБанка (обычно тут есть message)
  const data = err?.response?.data;

  // 1) пытаемся взять человекопонятное сообщение из ответа банка
  let bankMsg =
    (data && (data.message || data.error || data.details || data.title)) ||
    null;

  // 2) если message вдруг объект/массив — приводим к строке
  if (bankMsg && typeof bankMsg !== "string") {
    try { bankMsg = JSON.stringify(bankMsg); } catch { bankMsg = String(bankMsg); }
  }

  // 3) финальный текст ошибки (НЕ "Register failed: 400")
  const publicMsg =
    (bankMsg && bankMsg.trim()) ||
    (err?.message && !/^Register failed:/i.test(String(err.message)) ? String(err.message) : "") ||
    "Ошибка регистрации в Т-Банк";

  dlog("ERROR status:", status);
  try { dlog("ERROR body:", JSON.stringify(data || {}, null, 2)); } catch (_) {}

return res.status(status).json({
  message: publicMsg,
  status,
  details: data,
});
}
}
