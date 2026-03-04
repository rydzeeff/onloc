// pages/api/tbank/company.js
import axios from 'axios';

export const config = { api: { bodyParser: false } };

const DEBUG = String(process.env.TBANK_DEBUG || '').toLowerCase() === '1' || String(process.env.TBANK_DEBUG || '').toLowerCase() === 'true';
function dlog(...args) { if (DEBUG) console.log('[TBANK][company]', ...args); }

const onlyDigits = (v) => (v ?? '').toString().replace(/\D/g, '');

function normalizeTbankExcerpt(data) {
  const d = data?.data ?? data ?? {};
  const type = (d.type || d.orgType || '').toString().toUpperCase();

  const nameShort =
    d.name?.short || d.shortName || d.organizationShortName || d.name?.short_with_opf || d.name || '';

  const nameFull =
    d.name?.full || d.fullName || d.organizationName || d.name?.full_with_opf || nameShort || '';

  const inn = d.inn || d.INN || '';
  const ogrn = d.ogrn || d.OGRN || d.ogrnip || d.OGRNIP || '';
  const kpp = d.kpp || d.KPP || '';

  const address =
    d.address?.full || d.address?.unrestricted_value || d.address?.value || d.address?.legal || d.legalAddress || d.address || '';

  const ceoName = d.management?.name || d.generalManager?.name || d.ceo?.name || d.director?.name || '';
  let [lastName='', firstName='', middleName=''] = ceoName ? ceoName.trim().split(/\s+/) : [];

  const okved = d.okved?.code || d.okved || d.mainOkved?.code || d.okvedMain?.code || '';

  return {
    companyType: type === 'INDIVIDUAL' || /ИП|ENTREPRENEUR/i.test(type) ? 'entrepreneur' : 'company',
    name: nameShort || nameFull,
    fullName: nameFull || nameShort,
    inn: onlyDigits(inn),
    ogrn: onlyDigits(ogrn),
    kpp: onlyDigits(kpp),
    legalAddress: address,
    ceo: { lastName, firstName, middleName },
    okvedMain: okved,
    raw: d,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Метод не разрешён' });

  const inn = onlyDigits(req.query?.inn || '');
  if (!/^\d{10,12}$/.test(inn)) return res.status(400).json({ error: 'ИНН некорректен (10 для ООО, 12 для ИП)' });

  const token = process.env.TBANK_KEY_PRIVATE;
  if (!token) return res.status(500).json({ error: 'Не задан TBANK_KEY_PRIVATE' });

  try {
    const url = 'https://business.tbank.ru/openapi/api/v1/counterparty/excerpt/by-inn';
    dlog('OPENAPI →', url, 'params:', { inn });
    const response = await axios.get(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      params: { inn }, timeout: 15000, validateStatus: () => true,
    });

    dlog('OPENAPI ← status:', response.status);
    dlog('OPENAPI ← body:', JSON.stringify(response.data, null, 2));

    if (response.status < 200 || response.status >= 300) {
      return res.status(200).json({
        ok: false,
        status: response.status,
        error: `TBank lookup failed (${response.status})`,
        details: response.data || null,
      });
    }

    const normalized = normalizeTbankExcerpt(response.data);
    return res.status(200).json({ ok: true, data: normalized });
  } catch (error) {
    const status = error?.response?.status || 500;
    dlog('ERROR status:', status);
    dlog('ERROR body:', JSON.stringify(error?.response?.data || {}, null, 2));
    return res.status(200).json({
      ok: false,
      status,
      error: 'Ошибка сервера Т-Банка',
      details: error?.response?.data || error.message,
    });
  }
}
