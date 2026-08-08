/**
 * _totp.js — Code à usage unique (RFC 6238) et jeton de session
 *
 * Protège la consultation du répertoire d'état civil. Le secret est partagé
 * une fois avec l'application d'authentification (Google Authenticator, Authy,
 * Microsoft Authenticator…) puis conservé côté serveur uniquement.
 *
 * Variable d'environnement requise (Vercel) :
 *   ADMIN_TOTP_SECRET   secret en base32, généré par scripts/generer-totp.js
 *
 * Aucune dépendance : la fonction ne repose que sur le module crypto de Node.
 * Aucune valeur par défaut n'est prévue — sans secret configuré, l'accès est
 * refusé plutôt qu'ouvert.
 */

const crypto = require('crypto');

const PAS = 30;             // durée de validité d'un code, en secondes
const CHIFFRES = 6;
const TOLERANCE = 1;        // ±1 pas, pour absorber les horloges décalées
const SESSION_MS = 2 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Base32 (RFC 4648) — alphabet des applications d'authentification    */
/* ------------------------------------------------------------------ */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(s) {
  const propre = String(s || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!propre || /[^A-Z2-7]/.test(propre)) throw new Error('Secret TOTP invalide');

  let bits = 0, valeur = 0;
  const octets = [];
  for (const c of propre) {
    valeur = (valeur << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(octets);
}

/* ------------------------------------------------------------------ */
/* Génération et vérification du code                                  */
/* ------------------------------------------------------------------ */

function codePourPas(cle, pas) {
  const compteur = Buffer.alloc(8);
  compteur.writeUInt32BE(Math.floor(pas / 0x100000000), 0);
  compteur.writeUInt32BE(pas >>> 0, 4);

  const hmac = crypto.createHmac('sha1', cle).update(compteur).digest();
  const decalage = hmac[hmac.length - 1] & 0x0f;
  const tronque =
    ((hmac[decalage] & 0x7f) << 24) |
    ((hmac[decalage + 1] & 0xff) << 16) |
    ((hmac[decalage + 2] & 0xff) << 8) |
    (hmac[decalage + 3] & 0xff);

  return String(tronque % 10 ** CHIFFRES).padStart(CHIFFRES, '0');
}

/** Comparaison à durée constante : la vérification ne doit rien laisser fuir. */
function memeCode(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function secret() {
  const s = process.env.ADMIN_TOTP_SECRET;
  if (!s) throw new Error('ADMIN_TOTP_SECRET absent de l\'environnement');
  return decodeBase32(s);
}

/** @returns {number|null} le pas validé, ou null si le code est refusé. */
function verifierCode(saisie, maintenant = Date.now()) {
  const propre = String(saisie || '').replace(/\D/g, '');
  if (propre.length !== CHIFFRES) return null;

  const cle = secret();
  const pasCourant = Math.floor(maintenant / 1000 / PAS);
  for (let d = -TOLERANCE; d <= TOLERANCE; d++) {
    if (memeCode(propre, codePourPas(cle, pasCourant + d))) return pasCourant + d;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Jeton de session                                                    */
/* ------------------------------------------------------------------ */

// Clé distincte du secret TOTP, dérivée de lui : une seule variable à gérer,
// sans jamais réutiliser le secret tel quel pour signer.
function cleSession() {
  return crypto.createHmac('sha256', secret()).update('session-repertoire').digest();
}

function creerJeton(maintenant = Date.now()) {
  const charge = Buffer.from(JSON.stringify({ exp: maintenant + SESSION_MS }))
    .toString('base64url');
  const signature = crypto.createHmac('sha256', cleSession()).update(charge).digest('base64url');
  return `${charge}.${signature}`;
}

function jetonValide(jeton, maintenant = Date.now()) {
  const parts = String(jeton || '').split('.');
  if (parts.length !== 2) return false;

  const attendue = crypto.createHmac('sha256', cleSession()).update(parts[0]).digest('base64url');
  if (!memeCode(parts[1], attendue)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return typeof exp === 'number' && maintenant < exp;
  } catch {
    return false;
  }
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer …`. */
function jetonDeLaRequete(req) {
  const brut = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(brut);
  return m ? m[1].trim() : '';
}

module.exports = {
  verifierCode, creerJeton, jetonValide, jetonDeLaRequete,
  SESSION_MS, PAS, CHIFFRES, decodeBase32, codePourPas
};
