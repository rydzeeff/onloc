import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не разрешен' });
  }

  const { to, subject, html } = req.body;

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.mail.ru',
      port: 465,
      secure: true,
      auth: {
        user: 'onloc@bk.ru',
        pass: process.env.MAILRU_PASSWORD
      }
    });

    await transporter.sendMail({
      from: 'onloc@bk.ru',
      to,
      subject,
      html,
    });

    return res.status(200).json({ message: 'Письмо успешно отправлено' });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка отправки письма' });
  }
}