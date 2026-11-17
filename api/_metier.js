/**
 * _metier.js — Éléments communs à l'espace client (api/espace.js) et au
 * portail du notaire (api/_portail.js) : libellés, RIB de l'étude, avis par
 * email, traitement uniforme des erreurs.
 */

const nodemailer = require('nodemailer');
const coffre = require('./_coffre');
const { echapper } = require('./_securite');

const MOTIFS = {
  achat_immobilier: 'Achat immobilier',
  entreprise: "Création ou acquisition d'entreprise",
  donation: 'Donation',
  bail: 'Bail',
  sequestre: 'Séquestre',
  autre: 'Autre'
};

// Mêmes origines que le questionnaire LCB-FT du site.
const SOURCES = {
  epargne: 'Épargne personnelle',
  vente: "Vente d'un bien immobilier",
  succession: 'Succession ou donation',
  pret: 'Prêt bancaire',
  titres: 'Cession de titres ou valeurs mobilières',
  indem: 'Indemnité',
  autre: 'Autre origine'
};

const erreurClient = (message, statut = 400) => Object.assign(new Error(message), { client: true, statut });

/* ------------------------------------------------------------------ */
/* RIB de l'étude                                                      */
/* ------------------------------------------------------------------ */

const RIB_INDEX = 'etude/rib.json';

async function ribEtudeInfo() {
  return (await coffre.lireJson(RIB_INDEX)) || { courant: null, anciens: [] };
}

async function ribEtudeContenu() {
  const { courant } = await ribEtudeInfo();
  if (!courant) return null;
  const buf = await coffre.lire(`etude/rib/${courant.id}.bin`);
  return buf ? { ...courant, buf } : null;
}

/** Le RIB précédent n'est pas effacé : il passe dans « anciens ». */
async function ribEtudeDeposer({ buf, type, nom }, auteur) {
  const index = await ribEtudeInfo();
  const id = coffre.identifiant();
  await coffre.ecrire(`etude/rib/${id}.bin`, buf);
  if (index.courant) index.anciens.unshift({ ...index.courant, remplaceLe: new Date().toISOString() });
  index.courant = { id, nom, type, taille: buf.length, deposeLe: new Date().toISOString(), deposePar: auteur };
  await coffre.ecrireJson(RIB_INDEX, index);
  return index.courant;
}

/* ------------------------------------------------------------------ */
/* Emails. Les avis au notaire n'ont jamais de pièce jointe ; seul     */
/* l'envoi du RIB de l'étude au client en porte une (filigranée).      */
/* ------------------------------------------------------------------ */

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'ssl0.ovh.net',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function gabarit(titre, sousTitre, corpsHtml) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT&nbsp;|&nbsp;notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">${echapper(titre)}</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">${echapper(sousTitre)}</div>
    </div>
    <div style="padding:28px 30px;font-size:14px;color:#444;line-height:1.6;">${corpsHtml}</div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Grégoire TAGOT | notaire — 2 rue Dante, 75005 Paris</p>
    </div>
  </div>
</body></html>`;
}

function adresseDuSite(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'form.tagot.notaires.fr';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

/** Non bloquant : un email qui ne part pas ne doit pas faire échouer un dépôt. */
async function envoyerEmail({ a, sujet, titre, sousTitre, corpsHtml, piecesJointes }) {
  if (!process.env.SMTP_USER) return false;
  try {
    await transporter().sendMail({
      from: `"Grégoire TAGOT | notaire" <${process.env.SMTP_USER}>`,
      to: a, subject: sujet, html: gabarit(titre, sousTitre, corpsHtml),
      ...(piecesJointes ? { attachments: piecesJointes } : {})
    });
    return true;
  } catch (e) {
    console.error('[espace] email non envoyé :', e.message);
    return false;
  }
}

function avisAuNotaire(req, sujet, titre, lignes) {
  const a = process.env.NOTAIRE_EMAIL || process.env.SMTP_USER;
  if (!a) return Promise.resolve(false);
  const corpsHtml = lignes.map(l => `<p style="margin:0 0 10px;">${echapper(l)}</p>`).join('') +
    `<p style="margin:22px 0 0;"><a href="${adresseDuSite(req)}/portail" style="display:inline-block;padding:11px 22px;background:#111;color:#fff;border-radius:4px;font-size:12px;font-weight:600;text-decoration:none;letter-spacing:.06em;text-transform:uppercase;">Ouvrir le portail</a></p>` +
    '<p style="margin:18px 0 0;font-size:12px;color:#999;">Par sécurité, aucune pièce n\'est jointe à cet email : elle se consulte depuis le portail.</p>';
  return envoyerEmail({ a, sujet, titre, sousTitre: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), corpsHtml });
}

/* ------------------------------------------------------------------ */
/* Enveloppe des fonctions                                             */
/* ------------------------------------------------------------------ */

function enTetes(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/**
 * Erreur « client » : message rendu tel quel. Toute autre erreur : message
 * neutre côté navigateur, détail dans les logs (sans donnée nominative).
 */
function enveloppe(traiter) {
  return async (req, res) => {
    enTetes(res);
    try {
      await traiter(req, res);
    } catch (e) {
      if (e.client) return res.status(e.statut || 400).json({ error: e.message });
      console.error(`[espace] ${e.configuration ? 'configuration' : 'erreur'} :`, e.message);
      return res.status(e.configuration ? 503 : 500).json({
        error: e.configuration
          ? 'Service momentanément indisponible. Merci de contacter l\'étude.'
          : 'Une erreur est survenue. Merci de réessayer.'
      });
    }
  };
}

function euros(n) {
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

module.exports = {
  MOTIFS, SOURCES, erreurClient,
  ribEtudeInfo, ribEtudeContenu, ribEtudeDeposer,
  envoyerEmail, avisAuNotaire, adresseDuSite, enveloppe, euros
};
