#!/usr/bin/env node
/**
 * Génère le secret d'accès au répertoire d'état civil.
 *
 *   node scripts/generer-totp.js
 *
 * À exécuter une seule fois, sur un poste de confiance. Le secret affiché
 * n'est enregistré nulle part : il faut le reporter immédiatement dans
 * l'application d'authentification puis dans les variables d'environnement
 * Vercel, sous le nom ADMIN_TOTP_SECRET.
 *
 * Ne jamais le committer, ni l'envoyer par email ou messagerie.
 */

const crypto = require('crypto');
const { codePourPas, decodeBase32, PAS } = require('../api/_totp');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const COMPTE = 'Répertoire état civil';
const EMETTEUR = 'Office Notarial Grégoire TAGOT';

// 160 bits, la taille recommandée pour HMAC-SHA1.
const octets = crypto.randomBytes(20);
let bits = 0, valeur = 0, secret = '';
for (const o of octets) {
  valeur = (valeur << 8) | o;
  bits += 8;
  while (bits >= 5) {
    secret += ALPHABET[(valeur >>> (bits - 5)) & 31];
    bits -= 5;
  }
}
if (bits > 0) secret += ALPHABET[(valeur << (5 - bits)) & 31];

const uri = 'otpauth://totp/'
  + encodeURIComponent(`${EMETTEUR}:${COMPTE}`)
  + `?secret=${secret}`
  + `&issuer=${encodeURIComponent(EMETTEUR)}`
  + '&algorithm=SHA1&digits=6&period=30';

const codeActuel = codePourPas(decodeBase32(secret), Math.floor(Date.now() / 1000 / PAS));

console.log(`
┌─ Secret d'accès au répertoire ────────────────────────────────────────────

  1. Dans Vercel → Settings → Environment Variables, ajouter :

       ADMIN_TOTP_SECRET = ${secret}

  2. Dans Google Authenticator : « + » → « Saisir une clé de configuration »

       Compte  : ${COMPTE}
       Clé     : ${secret}
       Type    : Basé sur le temps

     Ou, si l'application accepte un lien :

       ${uri}

  3. Vérification : l'application doit afficher ${codeActuel} en ce moment
     (le code change toutes les 30 secondes).

  Ce secret ne sera plus affiché. S'il est perdu, il suffit de relancer ce
  script et de refaire l'enregistrement — l'ancien cesse alors de fonctionner.

└───────────────────────────────────────────────────────────────────────────
`);
