/**
 * _securite.js — Jetons de session, code TOTP, limites d'essais, contrôles de fichiers
 *
 * Aucune dépendance externe : tout repose sur le module crypto de Node.
 */

const crypto = require('crypto');
const coffre = require('./_coffre');

function secret() {
  const s = process.env.OTP_SECRET;
  if (!s || s.length < 16) {
    const e = new Error('OTP_SECRET absent de l\'environnement');
    e.configuration = true;
    throw e;
  }
  return s;
}

function hmac(texte) {
  return crypto.createHmac('sha256', secret()).update(String(texte)).digest('hex');
}

function egal(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------------ */
/* Jetons signés (session client, session notaire)                     */
/* ------------------------------------------------------------------ */

function signerJeton(usage, contenu, dureeMs) {
  const corps = Buffer.from(JSON.stringify({ ...contenu, u: usage, e: Date.now() + dureeMs }))
    .toString('base64url');
  return `${corps}.${hmac(`${usage}|${corps}`)}`;
}

function lireJeton(usage, jeton) {
  if (typeof jeton !== 'string' || jeton.length > 8000) return null;
  const [corps, sig] = jeton.split('.');
  if (!corps || !sig || !egal(sig, hmac(`${usage}|${corps}`))) return null;
  try {
    const c = JSON.parse(Buffer.from(corps, 'base64url').toString('utf8'));
    if (c.u !== usage || !(c.e > Date.now())) return null;
    return c;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Limites d'essais (compteurs dans le coffre, fenêtre glissante)      */
/* ------------------------------------------------------------------ */

/**
 * Compte un essai et dit s'il reste dans la limite.
 * La clé est hachée : ni téléphone ni adresse IP n'apparaît dans un nom de fichier.
 */
async function sousLimite(categorie, cle, max, fenetreMs) {
  const chemin = `limites/${categorie}/${hmac(`${categorie}|${cle}`).slice(0, 40)}.json`;
  const maintenant = Date.now();
  const etat = (await coffre.lireJson(chemin).catch(() => null)) || { t: [] };
  const recents = etat.t.filter(x => x > maintenant - fenetreMs);
  if (recents.length >= max) return false;
  recents.push(maintenant);
  await coffre.ecrireJson(chemin, { t: recents });
  return true;
}

function ipDe(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim() || 'inconnue';
}

/* ------------------------------------------------------------------ */
/* TOTP (RFC 6238, SHA-1, 6 chiffres, pas de 30 s)                     */
/* ------------------------------------------------------------------ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = '', out = '';
  for (const o of buf) bits += o.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function deBase32(txt) {
  let bits = '';
  for (const c of String(txt).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    bits += B32.indexOf(c).toString(2).padStart(5, '0');
  }
  const octets = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) octets.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(octets);
}

function totp(secretB32, instantMs = Date.now(), decalage = 0) {
  const compteur = Buffer.alloc(8);
  compteur.writeBigUInt64BE(BigInt(Math.floor(instantMs / 30000) + decalage));
  const h = crypto.createHmac('sha1', deBase32(secretB32)).update(compteur).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

/** Tolère un pas d'avance ou de retard (horloge du téléphone). */
function totpValide(secretB32, code, instantMs = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some(d => egal(totp(secretB32, instantMs, d), c));
}

function nouveauSecretTotp() {
  return base32(crypto.randomBytes(20));
}

/* ------------------------------------------------------------------ */
/* Téléphones et IBAN                                                  */
/* ------------------------------------------------------------------ */

/** Forme canonique +CCNNN… ; null si ce n'est pas un numéro exploitable. */
function telephoneE164(tel) {
  const brut = String(tel || '').replace(/[\s.\-()_]/g, '');
  if (/^0[1-9]\d{8}$/.test(brut)) return '+33' + brut.slice(1);
  if (/^00\d{8,15}$/.test(brut)) return '+' + brut.slice(2);
  if (/^\+33 ?0[1-9]\d{8}$/.test(brut)) return '+33' + brut.slice(4);
  if (/^\+\d{8,15}$/.test(brut)) return brut;
  return null;
}

function masquerTelephone(e164) {
  const t = String(e164 || '');
  return t.length > 6 ? `${t.slice(0, 4)}••••${t.slice(-2)}` : '••••';
}

/** Contrôle IBAN : longueur plausible et clé modulo 97. */
function ibanValide(iban) {
  const s = String(iban || '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return null;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let reste = 0;
  for (const ch of r) reste = (reste * 10 + Number(ch)) % 97;
  return reste === 1 ? s : null;
}

/* ------------------------------------------------------------------ */
/* Fichiers déposés                                                    */
/* ------------------------------------------------------------------ */

const TAILLE_MAX = 3 * 1024 * 1024; // 3 Mo : la limite Vercel est de 4,5 Mo par requête

/**
 * Le type est déduit du contenu, jamais de l'extension ni du type annoncé :
 * seuls PDF, JPEG et PNG sont acceptés.
 */
function typeDeFichier(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** Décode et contrôle un fichier reçu en base64. Lève une erreur lisible par le client. */
function fichierRecu(f) {
  const erreur = (m) => Object.assign(new Error(m), { client: true });
  if (!f || typeof f.contenu !== 'string') throw erreur('Fichier manquant');
  if (f.contenu.length > TAILLE_MAX * 1.4) throw erreur('Fichier trop volumineux (3 Mo maximum)');
  const buf = Buffer.from(f.contenu, 'base64');
  if (!buf.length) throw erreur('Fichier vide');
  if (buf.length > TAILLE_MAX) throw erreur('Fichier trop volumineux (3 Mo maximum)');
  const type = typeDeFichier(buf);
  if (!type) throw erreur('Format refusé : seuls les fichiers PDF, JPEG et PNG sont acceptés');
  const nom = String(f.nom || 'piece').replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 120) || 'piece';
  return { buf, type, nom };
}

function echapper(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  hmac, egal, signerJeton, lireJeton, sousLimite, ipDe,
  totp, totpValide, nouveauSecretTotp,
  telephoneE164, masquerTelephone, ibanValide,
  fichierRecu, typeDeFichier, TAILLE_MAX, echapper
};
