const crypto = require('crypto');

const TERMINAL_KEY = '1652283243368';
const TBANK_SECRET = 'npd38yfw0k04ar7n';
const CUSTOMER_KEY = '8eeb12d4-9e8c-40e8-8018-6bfa190143a7';
const EXPECTED_TOKEN = '07aa0189462a1d86e60d5fd57ad54d17020f2580efcf668c546db0a3251eb3f1';

function generateToken(params) {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((obj, key) => {
      if (!['Token', 'DigestValue', 'SignatureValue', 'X509SerialNumber'].includes(key)) {
        obj[key] = String(params[key]).trim();
      }
      return obj;
    }, {});
  sortedParams.Password = String(TBANK_SECRET).trim();
  const sortedKeys = Object.keys(sortedParams).sort();
  const concatenated = sortedKeys.map(key => sortedParams[key]).join('');
  const token = crypto.createHmac('sha256', TBANK_SECRET).update(concatenated).digest('hex');
  return { token, concatenated, sortedParams };
}

const params = { TerminalKey: TERMINAL_KEY, CustomerKey: CUSTOMER_KEY };
const { token, concatenated, sortedParams } = generateToken(params);

console.log('Входные данные:');
console.log('TerminalKey:', TERMINAL_KEY);
console.log('TBANK_SECRET:', TBANK_SECRET);
console.log('CustomerKey:', CUSTOMER_KEY);
console.log('Параметры:', JSON.stringify(sortedParams, null, 2));
console.log('Конкатенация:', concatenated);
console.log('Токен:', token);
console.log('Ожидаемый токен:', EXPECTED_TOKEN);
console.log('Совпадение:', token === EXPECTED_TOKEN ? 'Да' : 'Нет');
console.log('Postman запрос:');
console.log('URL: https://rest-api-test.tinkoff.ru/v2/AddCustomer');
console.log('Method: POST');
console.log('Headers: Content-Type: application/json');
console.log('Body:', JSON.stringify({ TerminalKey: TERMINAL_KEY, CustomerKey: CUSTOMER_KEY, Token: token }, null, 2));