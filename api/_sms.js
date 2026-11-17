/**
 * _sms.js — Envoi du code de vérification par SMS (OVHcloud)
 *
 * Variables d'environnement :
 *   OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY   identifiants de l'API OVHcloud
 *   OVH_SMS_SERVICE   nom du compte SMS (sms-xx00000-1)
 *   OVH_SMS_SENDER    expéditeur déclaré chez OVHcloud (facultatif)
 *   SMS_MODE=essai    hors production uniquement : aucun SMS n'est envoyé,
 *                     le code est rendu à l'appelant pour les tests.
 *
 * Le numéro et le code ne sont jamais écrits dans les logs.
 */

const crypto = require('crypto');

const API = 'https://eu.api.ovh.com/1.0';

// Le mode essai rend le code à la page : il n'est admis que hors production
// ET sur le carnet fictif, jamais face aux fiches réelles des clients.
function modeEssai() {
  return process.env.SMS_MODE === 'essai' && process.env.ANNUAIRE_MODE === 'essai' &&
    process.env.VERCEL_ENV !== 'production';
}

function configure() {
  return modeEssai() || !!(process.env.OVH_APP_KEY && process.env.OVH_APP_SECRET &&
    process.env.OVH_CONSUMER_KEY && process.env.OVH_SMS_SERVICE);
}

/** Appel signé à l'API OVHcloud. */
async function ovh(methode, chemin, corps) {
  const url = API + chemin;
  const texte = corps ? JSON.stringify(corps) : '';
  const ts = Math.floor(Date.now() / 1000);
  const signature = '$1$' + crypto.createHash('sha1').update([
    process.env.OVH_APP_SECRET, process.env.OVH_CONSUMER_KEY, methode, url, texte, ts
  ].join('+')).digest('hex');
  return fetch(url, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      'X-Ovh-Application': process.env.OVH_APP_KEY,
      'X-Ovh-Consumer': process.env.OVH_CONSUMER_KEY,
      'X-Ovh-Timestamp': String(ts),
      'X-Ovh-Signature': signature
    },
    body: texte || undefined
  });
}

/**
 * Motif d'un refus d'OVHcloud. Seul le code d'erreur (énuméré : INVALID_KEY,
 * NOT_GRANTED_CALL, INVALID_SIGNATURE…) est conservé, jamais le message, qui
 * peut citer un numéro.
 */
async function motif(r) {
  let code = '';
  try { code = String((await r.json()).errorCode || '').replace(/[^A-Z_]/g, '').slice(0, 40); } catch { /* corps non JSON */ }
  return `OVH → ${r.status}${code ? ` (${code})` : ''}`;
}

/**
 * Contrôle de la liaison, pour le portail : les clés sont-elles acceptées, et
 * le compte configuré fait-il partie des comptes SMS visibles avec ces clés ?
 * Ne renvoie que des noms de comptes, aucun secret.
 */
async function diagnostic() {
  const nom = process.env.OVH_SMS_SERVICE || '';
  const manquantes = ['OVH_APP_KEY', 'OVH_APP_SECRET', 'OVH_CONSUMER_KEY', 'OVH_SMS_SERVICE'].filter(k => !process.env[k]);
  if (manquantes.length) return { ok: false, etape: 'configuration', manquantes };
  const r = await ovh('GET', '/sms/');
  if (!r.ok) return { ok: false, etape: 'cles', motif: await motif(r) };
  const comptes = (await r.json().catch(() => [])).filter(c => typeof c === 'string');
  const detail = { ok: comptes.includes(nom), etape: 'compte', configure: nom, comptes };
  if (detail.ok) {
    const c = await ovh('GET', `/sms/${encodeURIComponent(nom)}`);
    if (c.ok) { const d = await c.json().catch(() => ({})); detail.credits = d.creditsLeft; detail.statut = d.status; }
  }
  return detail;
}

async function envoyerSms(numeroE164, message) {
  if (modeEssai()) return { essai: true };

  if (!configure()) {
    const e = new Error('Envoi de SMS non configuré (variables OVH_* absentes)');
    e.configuration = true;
    throw e;
  }

  const r = await ovh('POST', `/sms/${encodeURIComponent(process.env.OVH_SMS_SERVICE)}/jobs`, {
    message,
    receivers: [numeroE164],
    noStopClause: true,           // message de service, pas de prospection
    priority: 'high',
    ...(process.env.OVH_SMS_SENDER
      ? { sender: process.env.OVH_SMS_SENDER }
      : { senderForResponse: true })
  });

  if (!r.ok) throw new Error(await motif(r));
  const d = await r.json().catch(() => ({}));
  if (Array.isArray(d.invalidReceivers) && d.invalidReceivers.length) {
    throw new Error('OVH SMS → destinataire refusé');
  }
  return { essai: false };
}

module.exports = { envoyerSms, configure, modeEssai, diagnostic };
