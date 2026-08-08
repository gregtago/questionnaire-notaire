/**
 * repertoire-connexion.js — Ouverture d'une session de consultation
 *
 * Reçoit le code à 6 chiffres de l'application d'authentification et rend un
 * jeton de session à courte durée. Aucune donnée client n'est renvoyée ici.
 */

const { verifierCode, creerJeton, SESSION_MS } = require('./_totp');

// Un code à six chiffres se force en quelques milliers d'essais : on limite
// les tentatives. Le compteur vit dans l'instance serverless, il ne couvre
// donc pas tous les cas, mais il ralentit l'essentiel des tentatives
// automatisées, qui frappent la même instance en rafale.
const ESSAIS_MAX = 5;
const FENETRE_MS = 60 * 1000;
const essais = new Map();

// Un même code ne sert qu'une fois : sans cela, un code intercepté resterait
// utilisable pendant sa minute de validité.
const pasConsommes = new Map();

function trop(ip, maintenant) {
  const e = essais.get(ip);
  if (!e || maintenant - e.depuis > FENETRE_MS) {
    essais.set(ip, { depuis: maintenant, n: 1 });
    return false;
  }
  e.n++;
  return e.n > ESSAIS_MAX;
}

function nettoyer(maintenant) {
  for (const [k, v] of essais) if (maintenant - v.depuis > FENETRE_MS) essais.delete(k);
  for (const [pas, t] of pasConsommes) if (maintenant - t > 5 * 60 * 1000) pasConsommes.delete(pas);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  if (!process.env.ADMIN_TOTP_SECRET) {
    console.error('[repertoire] ADMIN_TOTP_SECRET absent : accès refusé');
    return res.status(503).json({ error: 'Accès non configuré.' });
  }

  const maintenant = Date.now();
  nettoyer(maintenant);

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  if (trop(ip, maintenant)) {
    return res.status(429).json({ error: 'Trop de tentatives. Patientez une minute.' });
  }

  let pas;
  try {
    pas = verifierCode((req.body || {}).code, maintenant);
  } catch (e) {
    console.error('[repertoire] secret illisible :', e.message);
    return res.status(503).json({ error: 'Accès non configuré.' });
  }

  if (pas === null || pasConsommes.has(pas)) {
    // Même réponse dans les deux cas : ne pas indiquer qu'un code était bon.
    return res.status(401).json({ error: 'Code incorrect ou expiré.' });
  }

  pasConsommes.set(pas, maintenant);
  essais.delete(ip);

  res.json({ token: creerJeton(maintenant), expire: maintenant + SESSION_MS });
};
