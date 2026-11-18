/**
 * _questionnaires.js — Envoi d'un questionnaire en ligne à un client, depuis
 * le portail du notaire (onglet « Questionnaires », ou bouton sur une fiche).
 *
 * Reprend l'ancienne page /admin (api/envoyer-lien.js), qui n'était protégée
 * que par un mot de passe : l'envoi exige désormais la session du portail
 * (code d'accès + code à six chiffres du téléphone) et figure au journal.
 *
 * Le lien vers le questionnaire reste dans l'email, comme auparavant : le
 * questionnaire ne s'ouvre qu'après un code reçu à l'adresse du client, et
 * ne donne accès à rien de ce qui est au coffre.
 */

const sec = require('./_securite');
const coffre = require('./_coffre');
const { erreurClient, envoyerEmail, adresseDuSite } = require('./_metier');

const QUESTIONNAIRES = {
  'etatcivil': {
    label: 'État civil',
    path: '/etatcivil',
    description: 'un questionnaire d’état civil'
  },
  'acquisition': {
    label: 'Achat immobilier',
    path: '/acquisition',
    description: 'un questionnaire relatif à votre projet d’acquisition immobilière'
  },
  'vente-maison': {
    label: 'Vente — Maison',
    path: '/vente-maison',
    description: 'un questionnaire relatif à la vente de votre maison'
  },
  'vente-appartement': {
    label: 'Vente — Appartement',
    path: '/vente-appartement',
    description: 'un questionnaire relatif à la vente de votre appartement'
  },
  'divorce': {
    label: 'Divorce',
    path: '/divorce',
    description: 'un questionnaire relatif à votre dossier de divorce'
  },
  'succession': {
    label: 'Succession',
    path: '/succession',
    description: 'un questionnaire relatif à votre dossier de succession'
  },
  'lcbft': {
    label: 'LCB-FT — Origine des fonds',
    path: '/lcbft',
    description: 'un questionnaire relatif à mes obligations de vigilance (lutte contre le blanchiment de capitaux et le financement du terrorisme)'
  }
};

/** Liste publiée au portail : { clé: libellé }. */
const LIBELLES = Object.fromEntries(Object.entries(QUESTIONNAIRES).map(([k, q]) => [k, q.label]));

const EMAIL_VALIDE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

async function envoyerQuestionnaire(req, res) {
  const b = req.body;
  const q = QUESTIONNAIRES[b.type];
  if (!q) throw erreurClient('Choisissez un questionnaire');
  const email = String(b.email || '').trim();
  if (!EMAIL_VALIDE.test(email) || email.length > 200) throw erreurClient('Adresse email invalide');
  const prenom = String(b.prenom || '').trim().slice(0, 80);
  const nom = String(b.nom || '').trim().slice(0, 80);

  const lien = `${adresseDuSite(req)}${q.path}`;
  const qui = [prenom, nom].filter(Boolean).join(' ');
  const envoye = await envoyerEmail({
    a: email,
    sujet: `${q.label} — Questionnaire à compléter`,
    titre: q.label,
    sousTitre: 'Questionnaire en ligne',
    corpsHtml:
      `<p style="margin:0 0 18px;">${qui ? `Bonjour ${sec.echapper(qui)},` : 'Bonjour,'}</p>` +
      `<p style="margin:0 0 18px;">Afin de préparer votre dossier dans les meilleures conditions, je vous invite à compléter ${q.description}.</p>` +
      '<p style="margin:0 0 18px;">Le questionnaire est accessible en ligne, il vous suffit de cliquer sur le bouton ci-dessous. ' +
      'Une vérification par code envoyé sur cette adresse email vous sera demandée avant d\'accéder au formulaire.</p>' +
      `<div style="text-align:center;margin:30px 0;"><a href="${sec.echapper(lien)}" target="_blank" style="display:inline-block;padding:14px 28px;background:#111;color:#fff;border-radius:4px;font-size:13px;font-weight:600;text-decoration:none;letter-spacing:.06em;text-transform:uppercase;">Accéder au questionnaire</a></div>` +
      `<p style="font-size:11px;color:#aaa;margin:0 0 18px;text-align:center;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur&nbsp;:<br><span style="color:#666;">${sec.echapper(lien)}</span></p>` +
      '<p style="margin:22px 0 0;">Je reste à votre disposition pour toute question.<br>Bien cordialement,<br><strong>Grégoire TAGOT | notaire</strong></p>'
  });

  await coffre.journaliser({
    acteur: 'notaire', action: 'questionnaire-envoye', ...(qui ? { nom: qui } : {}), questionnaire: q.label,
    destinataire: email, ...(envoye ? {} : { email: 'non-parti' }), ip: sec.ipDe(req)
  });
  if (!envoye) throw erreurClient(`L'email à ${email} n'a pas pu partir. Réessayez dans quelques minutes.`, 502);
  res.json({ ok: true, email, questionnaire: q.label });
}

module.exports = { QUESTIONNAIRES, LIBELLES, envoyerQuestionnaire };
