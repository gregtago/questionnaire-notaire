/**
 * _contacts.js — Écriture des contacts clients dans Outlook (Exchange Online)
 *
 * Cible : dossier de contacts « Clients » de la boîte partagée office@tagot.notaires.fr
 * Auth  : client credentials (app-only), permission Contacts.ReadWrite
 *         restreinte à la seule boîte office par Application Access Policy.
 *
 * Variables d'environnement requises (Vercel) :
 *   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_MAILBOX
 *
 * Ce module ne doit JAMAIS recevoir d'IBAN ni de pièce d'identité.
 */

const TENANT      = process.env.MS_TENANT_ID;
const CLIENT_ID   = process.env.MS_CLIENT_ID;
const SECRET      = process.env.MS_CLIENT_SECRET;
const MAILBOX     = process.env.MS_MAILBOX || 'office@tagot.notaires.fr';
const FOLDER_NAME = 'Clients';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Caches en mémoire : conservés tant que l'instance serverless reste chaude.
let tokenCache  = { value: null, expiresAt: 0 };
let folderCache = null;

/* ------------------------------------------------------------------ */
/* Authentification                                                    */
/* ------------------------------------------------------------------ */

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  if (!TENANT || !CLIENT_ID || !SECRET) {
    throw new Error('Variables MS_* absentes de l\'environnement');
  }

  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: SECRET,
    scope:         'https://graph.microsoft.com/.default',
    grant_type:    'client_credentials'
  });

  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!r.ok) throw new Error(`Token refusé (${r.status}) : ${await r.text()}`);

  const data = await r.json();
  tokenCache = {
    value:     data.access_token,
    // marge de 5 min avant expiration réelle
    expiresAt: Date.now() + (data.expires_in - 300) * 1000
  };
  return tokenCache.value;
}

async function graph(method, path, body) {
  const token = await getToken();
  const r = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!r.ok) throw new Error(`Graph ${method} ${path} → ${r.status} : ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

/* ------------------------------------------------------------------ */
/* Dossier « Clients » — créé au premier appel s'il n'existe pas       */
/* ------------------------------------------------------------------ */

async function getFolderId() {
  if (folderCache) return folderCache;

  const base = `/users/${encodeURIComponent(MAILBOX)}/contactFolders`;
  const list = await graph('GET', `${base}?$select=id,displayName&$top=100`);
  const found = (list.value || []).find(f => f.displayName === FOLDER_NAME);

  if (found) {
    folderCache = found.id;
    return folderCache;
  }

  const created = await graph('POST', base, { displayName: FOLDER_NAME });
  folderCache = created.id;
  return folderCache;
}

/* ------------------------------------------------------------------ */
/* Recherche d'un contact existant par email (anti-doublon)            */
/* ------------------------------------------------------------------ */

/**
 * Un couple partage souvent une seule adresse email. L'appairage se fait donc
 * sur email ET nom : si l'email existe déjà mais sous un autre nom, on crée
 * une fiche distincte au lieu d'écraser celle du conjoint.
 */
async function findExisting(folderId, email, nom) {
  if (!email) return null;
  const base  = `/users/${encodeURIComponent(MAILBOX)}/contactFolders/${folderId}/contacts`;
  const safe  = String(email).toLowerCase().replace(/'/g, "''");
  const cible = norm(nom);

  let candidats = [];
  try {
    const filter = encodeURIComponent(`emailAddresses/any(a:a/address eq '${safe}')`);
    const res = await graph('GET', `${base}?$filter=${filter}&$select=id,surname&$top=20`);
    candidats = res.value || [];
  } catch (e) {
    // Repli si le filtre any() est refusé : balayage local du dossier.
    const res = await graph('GET', `${base}?$select=id,surname,emailAddresses&$top=999`);
    candidats = (res.value || []).filter(c =>
      (c.emailAddresses || []).some(a => (a.address || '').toLowerCase() === safe)
    );
  }

  if (!candidats.length) return null;

  const hit = candidats.find(c => norm(c.surname) === cible);
  return hit ? hit.id : null;
}

/** Normalise pour comparaison : sans accents, sans casse, sans ponctuation. */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z]/g, '');
}

/* ------------------------------------------------------------------ */
/* Normalisations                                                      */
/* ------------------------------------------------------------------ */

/**
 * Graph stocke birthday en UTC. Une date à minuit ressort souvent la veille
 * dans Outlook selon le fuseau : on ancre à midi UTC.
 * Accepte "1975-04-12" ou "12/04/1975".
 */
function toBirthday(v) {
  if (!v) return null;
  const s = String(v).trim();

  let y, m, d;
  let mo = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mo) { [, y, m, d] = mo; }
  else {
    mo = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!mo) return null;
    [, d, m, y] = mo;
  }

  const year = Number(y);
  if (year < 1900 || year > new Date().getFullYear()) return null;
  return `${y}-${m}-${d}T12:00:00Z`;
}

function toE164(tel) {
  if (!tel) return null;
  const raw = String(tel).replace(/[\s.\-()]/g, '');
  if (/^0\d{9}$/.test(raw)) return '+33' + raw.slice(1);
  if (/^\+\d{8,15}$/.test(raw)) return raw;
  return String(tel).trim(); // laissé tel quel plutôt que perdu
}

/* ------------------------------------------------------------------ */
/* API publique                                                        */
/* ------------------------------------------------------------------ */

/**
 * Crée ou met à jour un contact dans le dossier « Clients ».
 *
 * @param {Object} p
 * @param {string} p.nom
 * @param {string} p.prenom
 * @param {string} p.email
 * @param {string} [p.telephone]
 * @param {string} [p.adresse]        ligne de voie
 * @param {string} [p.codePostal]
 * @param {string} [p.ville]
 * @param {string} [p.dateNaissance]  "AAAA-MM-JJ" ou "JJ/MM/AAAA"
 * @param {string} [p.natureDossier]  ex. "Acquisition", "Succession"
 * @param {boolean}[p.newsletter]     consentement campagnes (case dédiée)
 * @returns {Promise<{action:'created'|'updated', id:string}>}
 */
async function upsertContact(p) {
  const folderId = await getFolderId();
  const base = `/users/${encodeURIComponent(MAILBOX)}/contactFolders/${folderId}/contacts`;

  const nom    = (p.nom    || '').trim();
  const prenom = (p.prenom || '').trim();

  // Statut de provenance : toute donnée issue du formulaire est déclarative
  // tant qu'elle n'a pas été confrontée à une pièce d'identité.
  const categories = ['Coord-declarees'];
  if (p.natureDossier) categories.push(String(p.natureDossier).trim());
  if (p.newsletter)    categories.push('Newsletter-OK');

  const contact = {
    givenName:   prenom,
    surname:     nom.toUpperCase(),
    displayName: `${nom.toUpperCase()} ${prenom}`.trim(),
    categories,
    personalNotes: `Questionnaire reçu le ${new Date().toLocaleDateString('fr-FR')}`
  };

  if (p.email) {
    contact.emailAddresses = [{
      address: String(p.email).trim().toLowerCase(),
      name:    contact.displayName
    }];
  }

  const tel = toE164(p.telephone);
  if (tel) contact.mobilePhone = tel;

  if (p.adresse || p.ville || p.codePostal) {
    contact.homeAddress = {
      street:          p.adresse || '',
      city:            p.ville || '',
      postalCode:      p.codePostal || '',
      countryOrRegion: 'France'
    };
  }

  const bday = toBirthday(p.dateNaissance);
  if (bday) contact.birthday = bday;

  const existingId = await findExisting(folderId, p.email, nom);

  if (existingId) {
    // Mise à jour : on ne réécrit pas les notes, qui peuvent avoir été
    // annotées à la main par l'étude.
    delete contact.personalNotes;
    await graph('PATCH', `${base}/${existingId}`, contact);
    return { action: 'updated', id: existingId };
  }

  const created = await graph('POST', base, contact);
  return { action: 'created', id: created.id };
}

/**
 * Enveloppe non bloquante : à utiliser dans les handlers.
 * Un échec Graph ne doit jamais empêcher l'envoi de l'email ni du XML.
 */
async function upsertContactSafe(p) {
  try {
    const res = await upsertContact(p);
    console.log(`[contacts] ${res.action} — ${p.nom} ${p.prenom}`);
    return res;
  } catch (e) {
    console.error('[contacts] échec, ignoré :', e.message);
    return null;
  }
}

module.exports = { upsertContact, upsertContactSafe };
