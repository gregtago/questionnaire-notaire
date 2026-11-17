/**
 * _annuaire.js — Lecture du carnet d'adresses « Clients » et validation des fiches
 *
 * Le carnet Outlook (boîte office, dossier « Clients ») est la seule source des
 * coordonnées. Ce module :
 *   - liste les fiches pour le portail du notaire ;
 *   - retrouve, pour l'espace client, les fiches VALIDÉES portant un numéro ;
 *   - pose ou retire la catégorie « Coord-verifiees ».
 *
 * Il ne modifie JAMAIS un téléphone ni un email : la validation porte sur des
 * coordonnées, elle ne les change pas.
 *
 * Une fiche n'ouvre l'espace client que si deux conditions sont réunies :
 *   1. elle porte la catégorie « Coord-verifiees » ;
 *   2. son téléphone est celui que le notaire a validé (empreinte conservée
 *      dans le coffre au moment de la validation).
 * Si le numéro change dans Outlook après coup, la fiche se referme d'elle-même.
 *
 * ANNUAIRE_MODE=essai (hors production) : carnet fictif tenu dans le coffre,
 * pour tester sans toucher aux fiches réelles.
 */

const crypto = require('crypto');
const coffre = require('./_coffre');
const { telephoneE164, estMobile } = require('./_securite');

const VERIFIEE = 'Coord-verifiees';
const DECLAREE = 'Coord-declarees';

function modeEssai() {
  return process.env.ANNUAIRE_MODE === 'essai' && process.env.VERCEL_ENV !== 'production';
}

function cheminValidation(id) {
  return `validations/${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 40)}.json`;
}

function fiche(c) {
  const categories = c.categories || [];
  return {
    id: c.id,
    nom: c.surname || '',
    prenom: c.givenName || '',
    email: ((c.emailAddresses || [])[0] || {}).address || '',
    telephone: telephoneE164(c.mobilePhone),
    telephoneBrut: c.mobilePhone || '',
    categories,
    verifiee: categories.includes(VERIFIEE)
  };
}

/* ------------------------------------------------------------------ */
/* Accès au carnet                                                     */
/* ------------------------------------------------------------------ */

const ESSAI = 'essai-annuaire/contacts.json';

async function lireContacts() {
  if (modeEssai()) return ((await coffre.lireJson(ESSAI)) || []).map(fiche);

  const { graph, getFolderId, MAILBOX } = require('./_contacts');
  const folderId = await getFolderId();
  let chemin = `/users/${encodeURIComponent(MAILBOX)}/contactFolders/${folderId}/contacts` +
    '?$select=id,givenName,surname,mobilePhone,emailAddresses,categories&$top=200';
  const out = [];
  for (let page = 0; chemin && page < 50; page++) {
    const r = await graph('GET', chemin);
    out.push(...(r.value || []).map(fiche));
    const suite = r['@odata.nextLink'];
    chemin = suite ? suite.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '') : null;
  }
  return out;
}

async function ecrireCategories(id, categories) {
  if (modeEssai()) {
    const tous = (await coffre.lireJson(ESSAI)) || [];
    const c = tous.find(x => x.id === id);
    if (!c) throw new Error('Fiche introuvable');
    c.categories = categories;
    await coffre.ecrireJson(ESSAI, tous);
    return;
  }
  const { graph, getFolderId, MAILBOX } = require('./_contacts');
  const folderId = await getFolderId();
  await graph('PATCH',
    `/users/${encodeURIComponent(MAILBOX)}/contactFolders/${folderId}/contacts/${encodeURIComponent(id)}`,
    { categories });
}

/* ------------------------------------------------------------------ */
/* API publique                                                        */
/* ------------------------------------------------------------------ */

/** Toutes les fiches, avec leur état d'ouverture de l'espace client. */
async function listerFiches() {
  const contacts = await lireContacts();
  const validations = new Map();
  await Promise.all(contacts.filter(c => c.verifiee).map(async c => {
    validations.set(c.id, await coffre.lireJson(cheminValidation(c.id)).catch(() => null));
  }));
  return contacts.map(c => {
    const v = validations.get(c.id);
    let etat = 'a-valider';
    if (c.verifiee && v && c.telephone && v.telephone === c.telephone) etat = 'ouverte';
    else if (c.verifiee) etat = 'a-revalider'; // catégorie posée hors portail, ou numéro changé depuis
    return { ...c, etat, valideeLe: etat === 'ouverte' ? v.valideeLe : null };
  }).sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr'));
}

/** Fiches ouvertes portant ce numéro (un couple peut partager un mobile). */
async function fichesOuvertesPourTelephone(e164) {
  if (!e164) return [];
  return (await listerFiches()).filter(f => f.etat === 'ouverte' && f.telephone === e164);
}

async function ficheOuverte(id) {
  return (await listerFiches()).find(f => f.id === id && f.etat === 'ouverte') || null;
}

async function valider(id) {
  const c = (await lireContacts()).find(x => x.id === id);
  if (!c) throw Object.assign(new Error('Fiche introuvable'), { client: true });
  if (!c.telephone) {
    throw Object.assign(new Error('Cette fiche n\'a pas de numéro de mobile exploitable : complétez-la dans Outlook avant de la valider'), { client: true });
  }
  if (!estMobile(c.telephone)) {
    throw Object.assign(new Error('Ce numéro est une ligne fixe : il ne peut pas recevoir de SMS. Indiquez un mobile dans Outlook avant de valider la fiche'), { client: true });
  }
  const categories = c.categories.filter(x => x !== DECLAREE && x !== VERIFIEE).concat(VERIFIEE);
  await ecrireCategories(id, categories);
  await coffre.ecrireJson(cheminValidation(id), {
    telephone: c.telephone, email: c.email, valideeLe: new Date().toISOString()
  });
  return c;
}

async function retirer(id) {
  const c = (await lireContacts()).find(x => x.id === id);
  if (!c) throw Object.assign(new Error('Fiche introuvable'), { client: true });
  const categories = c.categories.filter(x => x !== DECLAREE && x !== VERIFIEE).concat(DECLAREE);
  await ecrireCategories(id, categories);
  // L'empreinte de validation est neutralisée, pas effacée : le coffre ne supprime rien.
  await coffre.ecrireJson(cheminValidation(id), {
    telephone: null, email: null, retireeLe: new Date().toISOString()
  });
  return c;
}

module.exports = { listerFiches, fichesOuvertesPourTelephone, ficheOuverte, valider, retirer, modeEssai };
