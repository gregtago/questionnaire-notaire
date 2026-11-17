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

async function envoyerSms(numeroE164, message) {
  if (modeEssai()) return { essai: true };

  if (!configure()) {
    const e = new Error('Envoi de SMS non configuré (variables OVH_* absentes)');
    e.configuration = true;
    throw e;
  }

  const url = `${API}/sms/${encodeURIComponent(process.env.OVH_SMS_SERVICE)}/jobs`;
  const corps = JSON.stringify({
    message,
    receivers: [numeroE164],
    noStopClause: true,           // message de service, pas de prospection
    priority: 'high',
    ...(process.env.OVH_SMS_SENDER
      ? { sender: process.env.OVH_SMS_SENDER }
      : { senderForResponse: true })
  });
  const ts = Math.floor(Date.now() / 1000);
  const signature = '$1$' + crypto.createHash('sha1').update([
    process.env.OVH_APP_SECRET, process.env.OVH_CONSUMER_KEY, 'POST', url, corps, ts
  ].join('+')).digest('hex');

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ovh-Application': process.env.OVH_APP_KEY,
      'X-Ovh-Consumer': process.env.OVH_CONSUMER_KEY,
      'X-Ovh-Timestamp': String(ts),
      'X-Ovh-Signature': signature
    },
    body: corps
  });

  if (!r.ok) {
    // Le corps d'erreur d'OVH peut citer le numéro : on ne garde que le statut.
    throw new Error(`OVH SMS → ${r.status}`);
  }
  const d = await r.json().catch(() => ({}));
  if (Array.isArray(d.invalidReceivers) && d.invalidReceivers.length) {
    throw new Error('OVH SMS → destinataire refusé');
  }
  return { essai: false };
}

module.exports = { envoyerSms, configure, modeEssai };
