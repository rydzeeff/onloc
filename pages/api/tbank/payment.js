export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не разрешён' });
  }

  try {
    // TODO: Добавить реализацию API платежей Т-Банка
    // Например, вызов /v2/Init для создания платежа
    // const response = await axios.post('https://securepay.tinkoff.ru/v2/Init', { ... }, { headers: { ... } });
    return res.status(501).json({ error: 'API платежей пока не реализовано' });
  } catch (error) {
    console.error('Ошибка обработки платежа:', {
      status: error.response?.status,
      message: error.message,
      data: error.response?.data,
    });
    res.status(error.response?.status || 500).json({
      error: 'Ошибка обработки платежа',
      details: error.response?.data || error.message,
    });
  }
}