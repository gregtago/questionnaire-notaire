const { sendAll } = require("./_mailer");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const { personnes, xml, type, email, pieces } = req.body || {};
  if (!personnes || !personnes.length) return res.status(400).json({ error: "Données manquantes" });

  try {
    await sendAll(personnes, xml, type);
  } catch(e) {
    console.error("Erreur email:", e.message);
  }

  // ── Email client — liste de pièces ──────────────────────────────────
  if (email && pieces && pieces.length) {
    const nomDossier = "questionnaire état civil";
    const piecesHtml = pieces.map(s => `
      <tr><td colspan="2" style="padding:14px 0 4px;font-size:10px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.06em;border-top:1px solid #eee;">${s.section}</td></tr>
      ${s.pieces.map(p => `<tr><td style="padding:5px 0 5px 12px;font-size:13px;color:#444;border-bottom:1px solid #f8f8f8;">&rarr; ${p}</td></tr>`).join('')}
    `).join('');
    const clientHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT | notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">État civil — pièces à fournir</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">${nomDossier}</div>
    </div>
    <div style="padding:28px 30px;">
      <p style="font-size:14px;color:#555;margin:0 0 20px;">Bonjour ${personnes[0]?.PRENOMU ? personnes[0].PRENOMU : ''},<br><br>Suite à votre questionnaire, voici la liste des pièces à nous faire parvenir.</p>
      <table style="width:100%;border-collapse:collapse;">${piecesHtml}</table>
      <table style="width:100%;border-collapse:collapse;margin-top:28px;">
        <tr>
          <td style="width:50%;padding:16px 20px;vertical-align:top;border:1px solid #e5e5e5;border-radius:4px;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.06em;">Envoi par email</p>
            <p style="margin:0;font-size:13px;color:#444;line-height:1.5;">Merci d'envoyer les pièces demandées à :<br><a href="mailto:office@tagot.notaires.fr" style="color:#111;font-weight:600;">office@tagot.notaires.fr</a></p>
          </td>
          <td style="width:4%;"></td>
          <td style="width:46%;padding:16px 20px;vertical-align:top;background:#f8f8f6;border:1px solid #e5e5e5;border-radius:4px;text-align:center;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.06em;">Envoi en ligne</p>
            <p style="margin:0 0 14px;font-size:13px;color:#444;line-height:1.5;">Merci d'uploader les pièces demandées en suivant ce lien :</p>
            <a href="https://tagot-my.sharepoint.com/:f:/g/personal/gregoiretagot_tagot_notaires_fr/IgCR5rXsF-6cTr-2Obo6iiQXAUYhsjUlMlHkCJFwHs7UFOU" target="_blank" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;border-radius:4px;font-size:12px;font-weight:600;text-decoration:none;letter-spacing:.04em;">&#128206; Déposer mes pièces</a>
          </td>
        </tr>
      </table>
      <p style="font-size:11px;color:#bbb;margin-top:16px;text-align:center;">Le dépôt peut également se faire en papier directement à l'étude : 2 rue Dante, 75005 Paris.</p>
    </div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Grégoire TAGOT | notaire — 2 rue Dante, 75005 Paris</p>
    </div>
  </div>
</body></html>`;
    try {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT, secure: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
      await t.sendMail({ from: process.env.SMTP_USER, to: email, subject: `État civil — pièces à fournir${personnes[0]?.NOMU ? ' — ' + personnes[0].NOMU + ' ' + (personnes[0].PRENOMU||'') : ''}`, html: clientHtml });
    } catch(e) { console.error('Email client pieces:', e.message); }
  }

  res.json({ ok: true });
};