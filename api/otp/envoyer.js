const nodemailer = require('nodemailer');
const crypto = require('crypto');

const FROM   = `"Grégoire TAGOT | notaire" <${process.env.SMTP_USER}>`;
const SECRET = process.env.OTP_SECRET || 'changeme';

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'ssl0.ovh.net',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function signToken(code, email, expires) {
  const payload = `${code}|${email.toLowerCase()}|${expires}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0,16);
  return Buffer.from(`${payload}|${hmac}`).toString('base64url');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();
  const { email } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalide' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + 10 * 60 * 1000;
  const token = signToken(code, email, expires);

  try {
    await transporter().sendMail({
      from: FROM,
      to: email,
      subject: 'Votre code de vérification — Grégoire TAGOT | notaire',
      html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:40px auto;padding:32px;border:1px solid #eee;border-radius:6px;">
        <div style="font-size:11px;letter-spacing:.05em;color:#999;margin-bottom:8px;">Grégoire TAGOT&nbsp;|&nbsp;notaire</div>
        <h2 style="margin:0 0 24px;font-weight:300;font-size:22px;color:#111;">Code de vérification</h2>
        <p style="color:#555;font-size:14px;line-height:1.6;">Pour accéder au questionnaire, saisissez le code ci-dessous :</p>
        <div style="text-align:center;margin:32px 0;"><span style="font-size:36px;font-weight:bold;letter-spacing:.2em;color:#111;">${code}</span></div>
        <p style="color:#aaa;font-size:12px;">Ce code est valable 10 minutes.</p>
      </div>`,
    });
    res.json({ ok: true, token });
  } catch(e) {
    console.error(e.message);
    res.status(500).json({ error: 'Erreur envoi email' });
  }
};
