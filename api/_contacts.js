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

/**
 * Rôles applicatifs effectivement portés par le jeton.
 *
 * Un 403 d'Exchange ne dit pas s'il vient d'une permission manquante ou d'une
 * Application Access Policy : les deux rendent ErrorAccessDenied. Le portail
 * Azure n'aide pas non plus — une permission déléguée y affiche un consentement
 * vert tout en restant sans effet en client credentials. Lire la revendication
 * `roles` du jeton délivré tranche sans ambiguïté.
 *
 * Ne sont journalisés que des noms de permissions (« Contacts.ReadWrite »),
 * jamais le jeton lui-même ni la moindre donnée client.
 */
function rolesDuJeton(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')
    );
    const roles = payload.roles || [];
    return roles.length ? roles.join(', ') : 'aucun';
  } catch {
    return 'illisible';
  }
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

  if (!r.ok) {
    // Ni le corps de réponse ni la query string ne doivent partir dans les
    // logs : Graph cite parfois la valeur fautive, et le $filter de
    // findExisting porte l'email du client. On ne garde que le code d'erreur
    // Graph (énuméré, jamais nominatif) et le request-id, qui suffisent au
    // diagnostic et sont ce que le support Microsoft demande.
    const corps = await r.text();
    let code = '';
    try { code = JSON.parse(corps)?.error?.code || ''; } catch { /* corps non JSON */ }
    const reqId = r.headers.get('request-id') || '';
    throw new Error(
      `Graph ${method} ${path.split('?')[0]} → ${r.status}` +
      (code  ? ` (${code})` : '') +
      (reqId ? ` [request-id ${reqId}]` : '') +
      (r.status === 403 ? ` [rôles ${rolesDuJeton(token)}]` : '')
    );
  }
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
 * Un couple partage souvent une seule adresse email, et souvent le même nom
 * d'usage. L'appairage se fait donc sur email, nom ET prénom : sinon la fiche
 * du conjoint viendrait écraser celle de l'autre époux au lieu d'être créée.
 * Une fiche ancienne sans prénom reste appariée sur le seul nom.
 */
async function findExisting(folderId, email, nom, prenom) {
  if (!email) return null;
  const base  = `/users/${encodeURIComponent(MAILBOX)}/contactFolders/${folderId}/contacts`;
  const safe  = String(email).toLowerCase().replace(/'/g, "''");
  const cible = norm(nom);
  const cibleP = norm(prenom);

  let candidats = [];
  try {
    const filter = encodeURIComponent(`emailAddresses/any(a:a/address eq '${safe}')`);
    const res = await graph('GET', `${base}?$filter=${filter}&$select=id,surname,givenName&$top=20`);
    candidats = res.value || [];
  } catch (e) {
    // Repli si le filtre any() est refusé : balayage local du dossier.
    const res = await graph('GET', `${base}?$select=id,surname,givenName,emailAddresses&$top=999`);
    candidats = (res.value || []).filter(c =>
      (c.emailAddresses || []).some(a => (a.address || '').toLowerCase() === safe)
    );
  }

  if (!candidats.length) return null;

  const memeNom = candidats.filter(c => norm(c.surname) === cible);
  const hit = memeNom.find(c => norm(c.givenName) === cibleP)
    || (cibleP ? null : memeNom[0])
    || memeNom.find(c => !norm(c.givenName));
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
    personalNotes: p.notes || `Questionnaire reçu le ${new Date().toLocaleDateString('fr-FR')}`
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

  const existingId = await findExisting(folderId, p.email, nom, prenom);

  if (existingId) {
    // Une fiche validée par le notaire (« Coord-verifiees ») sert d'ancre à
    // l'espace client. Elle ne garde ce statut que si le questionnaire
    // n'apporte AUCUN changement de téléphone ni d'email ; sinon elle retombe
    // en « Coord-declarees » jusqu'à nouvelle validation.
    try {
      const avant = await graph('GET', `${base}/${existingId}?$select=mobilePhone,emailAddresses,categories`);
      const memeTel   = !tel || toE164(avant.mobilePhone) === tel;
      const memeEmail = !p.email || (avant.emailAddresses || [])
        .some(a => (a.address || '').toLowerCase() === String(p.email).trim().toLowerCase());
      if ((avant.categories || []).includes('Coord-verifiees') && memeTel && memeEmail) {
        contact.categories = categories.map(c => (c === 'Coord-declarees' ? 'Coord-verifiees' : c));
      }
    } catch (e) {
      // En cas de doute, la fiche retombe en « déclarée » : c'est le sens sûr.
    }

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
    console.log(`[contacts] ${res.action}`);
    return res;
  } catch (e) {
    console.error('[contacts] échec, ignoré :', e.message);
    return null;
  }
}

module.exports = {
  upsertContact, upsertContactSafe,
  // Réutilisés par _annuaire.js (lecture et validation des fiches).
  graph, getFolderId, toE164, MAILBOX
};
