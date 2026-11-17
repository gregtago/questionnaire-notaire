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
 *   2. son téléphone et son email sont ceux que le notaire a validés
 *      (empreinte conservée dans le coffre au moment de la validation).
 * Si l'un des deux change dans Outlook après coup, la fiche se referme d'elle-même.
 *
 * ANNUAIRE_MODE=essai (hors production) : carnet fictif tenu dans le coffre,
 * pour tester sans toucher aux fiches réelles.
 */

const crypto = require('crypto');
const coffre = require('./_coffre');
const { telephoneE164, estMobile } = require('./_securite');

const { nomAffiche, nomNaissanceDe } = require('./_contacts');

const VERIFIEE = 'Coord-verifiees';
// « Supprimer » une fiche dans le portail ne touche pas Outlook : la fiche est
// seulement retirée du portail (liste tenue dans le coffre), ce qui ferme
// aussi l'espace client. Elle reste intacte dans le carnet et peut être
// restaurée.
const MASQUEES = 'annuaire/fiches-supprimees-du-portail.json';
async function lireMasquees() {
  return new Set(((await coffre.lireJson(MASQUEES).catch(() => null)) || {}).ids || []);
}
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
    nomNaissance: nomNaissanceDe(c.displayName),
    accord: /\(née /.test(c.displayName || '') ? 'F' : /\(né /.test(c.displayName || '') ? 'M' : '',
    adresse: (c.homeAddress || {}).street || '',
    codePostal: (c.homeAddress || {}).postalCode || '',
    ville: (c.homeAddress || {}).city || '',
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
    '?$select=id,givenName,surname,displayName,mobilePhone,emailAddresses,homeAddress,categories&$top=200';
  const out = [];
  for (let page = 0; chemin && page < 50; page++) {
    const r = await graph('GET', chemin);
    out.push(...(r.value || []).map(fiche));
    const suite = r['@odata.nextLink'];
    chemin = suite ? suite.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '') : null;
  }
  return out;
}

async function ecrireContact(id, champs) {
  if (modeEssai()) {
    const tous = (await coffre.lireJson(ESSAI)) || [];
    const c = tous.find(x => x.id === id);
    if (!c) throw new Error('Fiche introuvable');
    Object.assign(c, champs);
    await coffre.ecrireJson(ESSAI, tous);
    return;
  }
  const { graph, getFolderId, MAILBOX } = require('./_contacts');
  const folderId = await getFolderId();
  await graph('PATCH',
    `/users/${encodeURIComponent(MAILBOX)}/contactFolders/${folderId}/contacts/${encodeURIComponent(id)}`,
    champs);
}

const ecrireCategories = (id, categories) => ecrireContact(id, { categories });

/** Neutralise l'empreinte de validation (le coffre ne supprime rien). */
async function neutraliserValidation(id, motif) {
  await coffre.ecrireJson(cheminValidation(id), { telephone: null, email: null, [motif]: new Date().toISOString() });
}

/* ------------------------------------------------------------------ */
/* API publique                                                        */
/* ------------------------------------------------------------------ */

/** Toutes les fiches, avec leur état d'ouverture de l'espace client. */
async function listerFiches() {
  const [contacts, masquees] = await Promise.all([lireContacts(), lireMasquees()]);
  contacts.forEach(c => { c.aSupprimer = masquees.has(c.id); });
  const validations = new Map();
  await Promise.all(contacts.filter(c => c.verifiee).map(async c => {
    validations.set(c.id, await coffre.lireJson(cheminValidation(c.id)).catch(() => null));
  }));
  return contacts.map(c => {
    const v = validations.get(c.id);
    let etat = 'a-valider';
    if (c.aSupprimer) return { ...c, etat: 'a-supprimer', valideeLe: null };
    const memeEmail = !!c.email && !!v && !!v.email && v.email.toLowerCase() === c.email.toLowerCase();
    if (c.verifiee && v && c.telephone && v.telephone === c.telephone && memeEmail) etat = 'ouverte';
    else if (c.verifiee) etat = 'a-revalider'; // catégorie posée hors portail, ou numéro changé depuis
    return { ...c, etat, valideeLe: etat === 'ouverte' ? v.valideeLe : null };
  }).sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr'));
}

/** Fiches ouvertes portant ce numéro (un couple peut partager un mobile). */
async function fichesOuvertesPourTelephone(e164) {
  if (!e164) return [];
  return (await listerFiches()).filter(f => f.etat === 'ouverte' && f.telephone === e164);
}

/** Fiches ouvertes portant cette adresse (un couple peut partager une boîte). */
async function fichesOuvertesPourEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  return (await listerFiches()).filter(f => f.etat === 'ouverte' && f.email.toLowerCase() === e);
}

async function ficheOuverte(id) {
  return (await listerFiches()).find(f => f.id === id && f.etat === 'ouverte') || null;
}

async function valider(id) {
  const c = (await lireContacts()).find(x => x.id === id);
  if (!c) throw Object.assign(new Error('Fiche introuvable'), { client: true });
  if ((await lireMasquees()).has(id)) throw Object.assign(new Error('Cette fiche est supprimée du portail : restaurez-la avant de la valider'), { client: true });
  if (!c.telephone) {
    throw Object.assign(new Error('Cette fiche n\'a pas de numéro de mobile exploitable : complétez-la dans Outlook avant de la valider'), { client: true });
  }
  if (!c.email) {
    throw Object.assign(new Error('Cette fiche n\'a pas d\'adresse email : le client ne pourrait pas s\'identifier. Complétez-la dans Outlook avant de la valider'), { client: true });
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

/**
 * Saisie manuelle d'un client depuis le portail. La fiche est créée dans le
 * carnet comme celles des questionnaires — « Coord-declarees » — et doit être
 * validée ensuite, comme les autres. Si une fiche existe déjà sous le même
 * email, nom et prénom, elle est mise à jour au lieu d'être dédoublée.
 */
async function creerFiche(p) {
  const f = champsSaisis(p);

  if (modeEssai()) {
    const tous = (await coffre.lireJson(ESSAI)) || [];
    const n = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
    const tel = telephoneE164(f.telephone) || f.telephone;
    const existant = tous.find(c => n(c.surname) === n(f.nom) && n(c.givenName) === n(f.prenom) &&
      (c.emailAddresses || []).some(a => (a.address || '').toLowerCase() === f.email));
    const garde = !f.nomNaissance && existant ? nomNaissanceDe(existant.displayName) : '';
    const displayName = garde ? existant.displayName : nomAffiche(f.nom, f.prenom, f.nomNaissance, f.accord);
    const champs = { givenName: f.prenom, surname: f.nom.toUpperCase(), displayName, mobilePhone: tel, emailAddresses: [{ address: f.email }] };
    if (existant) {
      const inchange = existant.mobilePhone === tel;
      Object.assign(existant, champs);
      if (!inchange) existant.categories = (existant.categories || []).filter(x => x !== VERIFIEE && x !== DECLAREE).concat(DECLAREE);
    } else {
      tous.push({ id: crypto.randomBytes(12).toString('hex'), ...champs, categories: [DECLAREE, 'Saisie-manuelle'] });
    }
    await coffre.ecrireJson(ESSAI, tous);
    return { action: existant ? 'updated' : 'created', ...f };
  }

  const { upsertContact } = require('./_contacts');
  const r = await upsertContact({
    ...f, natureDossier: 'Saisie-manuelle',
    notes: `Fiche saisie manuellement le ${new Date().toLocaleDateString('fr-FR')}`
  });
  return { action: r.action, ...f };
}

const refus = (m) => Object.assign(new Error(m), { client: true });

function champsSaisis(p) {
  const t = (v, n) => String(v || '').trim().slice(0, n);
  const f = {
    nom: t(p.nom, 80), prenom: t(p.prenom, 80), email: t(p.email, 200).toLowerCase(),
    nomNaissance: t(p.nomNaissance, 80), accord: ['F', 'M'].includes(p.accord) ? p.accord : '',
    telephone: t(p.telephone, 30), adresse: t(p.adresse, 200), codePostal: t(p.codePostal, 10), ville: t(p.ville, 80)
  };
  if (!f.nom || !f.prenom) throw refus('Le nom et le prénom sont obligatoires');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw refus('Adresse email invalide');
  if (!f.telephone) throw refus('Le téléphone est obligatoire');
  return f;
}

/**
 * Modification d'une fiche depuis le portail. Si le mobile ou l'email change,
 * la validation tombe : la fiche repasse « à valider » et l'espace client se
 * ferme jusqu'à nouvelle validation.
 */
async function modifierFiche(id, p) {
  const avant = (await lireContacts()).find(x => x.id === id);
  if (!avant) throw refus('Fiche introuvable');
  const f = champsSaisis(p);
  const { toE164 } = require('./_contacts');
  const tel = toE164(f.telephone);
  const coordChangees = (telephoneE164(tel) || tel) !== (avant.telephone || avant.telephoneBrut) ||
    f.email !== avant.email.toLowerCase();

  const champs = {
    givenName: f.prenom,
    surname: f.nom.toUpperCase(),
    displayName: nomAffiche(f.nom, f.prenom, f.nomNaissance, f.accord),
    mobilePhone: tel,
    emailAddresses: [{ address: f.email, name: nomAffiche(f.nom, f.prenom, f.nomNaissance, f.accord) }],
    homeAddress: { street: f.adresse, postalCode: f.codePostal, city: f.ville, countryOrRegion: 'France' }
  };
  if (coordChangees) {
    champs.categories = avant.categories.filter(x => x !== VERIFIEE && x !== DECLAREE).concat(DECLAREE);
  }
  await ecrireContact(id, champs);
  if (coordChangees && avant.verifiee) await neutraliserValidation(id, 'modifieeLe');
  return { ...f, coordChangees, etaitValidee: avant.verifiee };
}

/**
 * « Supprimer » depuis le portail : la fiche n'apparaît plus dans le portail
 * et l'espace client se ferme. Outlook n'est pas touché. Une validation
 * éventuelle est neutralisée : restaurée, la fiche sera à revalider.
 */
async function ecarterFiche(id) {
  const c = (await lireContacts()).find(x => x.id === id);
  if (!c) throw refus('Fiche introuvable');
  const ids = await lireMasquees(); ids.add(id);
  await coffre.ecrireJson(MASQUEES, { ids: [...ids] });
  if (c.verifiee) await neutraliserValidation(id, 'supprimeeDuPortailLe');
  return c;
}

async function restaurerFiche(id) {
  const c = (await lireContacts()).find(x => x.id === id);
  if (!c) throw refus('Fiche introuvable');
  const ids = await lireMasquees(); ids.delete(id);
  await coffre.ecrireJson(MASQUEES, { ids: [...ids] });
  return c;
}

async function retirer(id) {
  const c = (await lireContacts()).find(x => x.id === id);
  if (!c) throw Object.assign(new Error('Fiche introuvable'), { client: true });
  const categories = c.categories.filter(x => x !== DECLAREE && x !== VERIFIEE).concat(DECLAREE);
  await ecrireCategories(id, categories);
  // L'empreinte de validation est neutralisée, pas effacée : le coffre ne supprime rien.
  await neutraliserValidation(id, 'retireeLe');
  return c;
}

module.exports = { listerFiches, creerFiche, modifierFiche, ecarterFiche, restaurerFiche, fichesOuvertesPourTelephone, fichesOuvertesPourEmail, ficheOuverte, valider, retirer, modeEssai };
