const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ─── OTP en mémoire (10 min) ───────────────────────────
const otpStore = new Map();

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'ssl0.ovh.net',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

const FROM = () => `"Grégoire TAGOT | notaire" <${process.env.SMTP_USER}>`;

// ─── Routes HTML ───────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/succession', (req, res) => res.sendFile(path.join(__dirname, 'public', 'succession.html')));
app.get('/divorce', (req, res) => res.sendFile(path.join(__dirname, 'public', 'divorce.html')));
app.get('/acquisition', (req, res) => res.sendFile(path.join(__dirname, 'public', 'acquisition.html')));
app.get('/vente-appartement', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vente-appartement.html')));
app.get('/vente-maison', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vente-maison.html')));

// ─── Envoi OTP ─────────────────────────────────────────
app.post('/api/otp/envoyer', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalide' });

  const code = generateOtp();
  otpStore.set(email.toLowerCase(), { code, expires: Date.now() + 10 * 60 * 1000 });

  try {
    await transporter().sendMail({
      from: FROM(),
      to: email,
      subject: 'Votre code de vérification — Grégoire TAGOT | notaire',
      html: `
        <div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:40px auto;padding:32px;border:1px solid #eee;border-radius:6px;">
          <div style="font-size:11px;letter-spacing:.05em;color:#999;margin-bottom:8px;">Grégoire TAGOT &nbsp;|&nbsp; notaire</div>
          <h2 style="margin:0 0 24px;font-weight:300;font-size:22px;color:#111;">Code de vérification</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;">Pour accéder au questionnaire, saisissez le code ci-dessous :</p>
          <div style="text-align:center;margin:32px 0;">
            <span style="font-size:36px;font-weight:bold;letter-spacing:.2em;color:#111;">${code}</span>
          </div>
          <p style="color:#aaa;font-size:12px;">Ce code est valable 10 minutes. Si vous n'avez pas demandé ce code, ignorez cet email.</p>
        </div>`
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erreur envoi OTP:', e.message);
    res.status(500).json({ error: 'Erreur envoi email' });
  }
});

// ─── Vérification OTP ──────────────────────────────────
app.post('/api/otp/verifier', (req, res) => {
  const { email, code } = req.body;
  const entry = otpStore.get(email?.toLowerCase());
  if (!entry) return res.status(400).json({ error: 'Aucun code envoyé pour cet email' });
  if (Date.now() > entry.expires) {
    otpStore.delete(email.toLowerCase());
    return res.status(400).json({ error: 'Code expiré, veuillez en demander un nouveau' });
  }
  if (entry.code !== code?.trim()) return res.status(400).json({ error: 'Code incorrect' });
  otpStore.delete(email.toLowerCase());
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
