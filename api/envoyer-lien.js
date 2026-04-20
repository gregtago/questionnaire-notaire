const nodemailer = require('nodemailer');

const FROM = `"Grégoire TAGOT | notaire" <${process.env.SMTP_USER}>`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

const QUESTIONNAIRES = {
  'etatcivil': {
    label: 'État civil',
    path: '/etatcivil',
    description: 'un questionnaire d’état civil',
  },
  'acquisition': {
    label: 'Achat immobilier',
    path: '/acquisition',
    description: 'un questionnaire relatif à votre projet d’acquisition immobilière',
  },
  'vente-maison': {
    label: 'Vente — Maison',
    path: '/vente-maison',
    description: 'un questionnaire relatif à la vente de votre maison',
  },
  'vente-appartement': {
    label: 'Vente — Appartement',
    path: '/vente-appartement',
    description: 'un questionnaire relatif à la vente de votre appartement',
  },
  'divorce': {
    label: 'Divorce',
    path: '/divorce',
    description: 'un questionnaire relatif à votre dossier de divorce',
  },
  'succession': {
    label: 'Succession',
    path: '/succession',
    description: 'un questionnaire relatif à votre dossier de succession',
  },
  'lcbft': {
    label: 'LCB-FT — Origine des fonds',
    path: '/lcbft',
    description: 'un questionnaire relatif à nos obligations de vigilance (lutte contre le blanchiment de capitaux et le financement du terrorisme)',
  },
};

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'ssl0.ovh.net',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { password, type, email, prenom, nom } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  if (!type || !QUESTIONNAIRES[type]) {
    return res.status(400).json({ error: 'Type de questionnaire invalide' });
  }
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email invalide' });
  }

  const q = QUESTIONNAIRES[type];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'form.tagot.notaires.fr';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const link = `${proto}://${host}${q.path}`;

  const salutation = prenom || nom
    ? `Bonjour ${[prenom, nom].filter(Boolean).join(' ')},`
    : 'Bonjour,';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT&nbsp;|&nbsp;notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">${q.label}</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Questionnaire en ligne</div>
    </div>
    <div style="padding:32px 30px;">
      <p style="font-size:14px;color:#333;margin:0 0 18px;line-height:1.6;">${salutation}</p>
      <p style="font-size:14px;color:#555;margin:0 0 24px;line-height:1.6;">
        Afin de préparer votre dossier dans les meilleures conditions, nous vous invitons à compléter ${q.description}.
      </p>
      <p style="font-size:14px;color:#555;margin:0 0 28px;line-height:1.6;">
        Le questionnaire est accessible en ligne, il vous suffit de cliquer sur le bouton ci-dessous.
        Une vérification par code envoyé sur cette adresse email vous sera demandée avant d'accéder au formulaire.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${link}" target="_blank" style="display:inline-block;padding:14px 28px;background:#111;color:#fff;border-radius:4px;font-size:13px;font-weight:600;text-decoration:none;letter-spacing:.06em;text-transform:uppercase;">Accéder au questionnaire</a>
      </div>
      <p style="font-size:11px;color:#aaa;margin:28px 0 0;text-align:center;line-height:1.5;">
        Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur&nbsp;:<br>
        <span style="color:#666;">${link}</span>
      </p>
      <p style="font-size:12px;color:#888;margin:32px 0 0;line-height:1.6;border-top:1px solid #eee;padding-top:20px;">
        Nous restons à votre disposition pour toute question.<br>
        Bien cordialement,<br>
        <strong style="color:#333;">L'étude TAGOT</strong>
      </p>
    </div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Grégoire TAGOT | notaire — 2 rue Dante, 75005 Paris</p>
    </div>
  </div>
</body></html>`;

  try {
    await transporter().sendMail({
      from: FROM,
      to: email,
      subject: `${q.label} — Questionnaire à compléter`,
      html,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error('Erreur envoyer-lien:', e.message);
    return res.status(500).json({ error: 'Erreur envoi email' });
  }
};
