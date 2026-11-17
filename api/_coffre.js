/**
 * _coffre.js — Stockage chiffré de l'espace client (RIB, justificatifs, journal)
 *
 * Tout ce qui est écrit ici est chiffré AVANT de quitter la fonction
 * (AES-256-GCM, clé COFFRE_CLE). Le stockage ne voit donc jamais un RIB en
 * clair : ni Vercel Blob, ni le disque du poste en développement.
 *
 * Deux supports, même interface :
 *   - Vercel Blob privé (BLOB_READ_WRITE_TOKEN présent) — production et essais ;
 *   - fichiers locaux (.coffre/) — développement uniquement, jamais sur Vercel.
 *
 * Rien n'est jamais supprimé par ce module : il n'expose aucune fonction
 * d'effacement. Une pièce remplacée reste archivée sous son identifiant.
 *
 * Variables d'environnement :
 *   COFFRE_CLE             64 caractères hexadécimaux (32 octets), obligatoire
 *   BLOB_READ_WRITE_TOKEN  fourni par Vercel quand un magasin Blob est relié
 *   COFFRE_DIR             dossier local de développement (défaut .coffre)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('TC1');

// Les versions d'essai (prévisualisations Vercel) écrivent sous un préfixe à
// part : elles ne touchent jamais aux pièces de production.
const PREFIXE = process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production'
  ? 'essai/' : '';

function cle() {
  const hex = process.env.COFFRE_CLE || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const e = new Error('COFFRE_CLE absente ou invalide (64 caractères hexadécimaux attendus)');
    e.configuration = true;
    throw e;
  }
  return Buffer.from(hex, 'hex');
}

/** Le chemin est lié au contenu (AAD) : une pièce déplacée ne se déchiffre plus. */
function chiffrer(chemin, clair) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle(), iv);
  c.setAAD(Buffer.from(chemin));
  const corps = Buffer.concat([c.update(clair), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), corps]);
}

function dechiffrer(chemin, brut) {
  if (brut.length < 31 || !brut.subarray(0, 3).equals(MAGIC)) {
    throw new Error('Pièce illisible (format inconnu)');
  }
  const d = crypto.createDecipheriv('aes-256-gcm', cle(), brut.subarray(3, 15));
  d.setAAD(Buffer.from(chemin));
  d.setAuthTag(brut.subarray(15, 31));
  return Buffer.concat([d.update(brut.subarray(31)), d.final()]);
}

/** N'accepte que des chemins construits par le code : jamais de « .. ». */
function verifierChemin(chemin) {
  if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(chemin) || chemin.includes('..')) {
    throw new Error('Chemin de coffre refusé');
  }
}

/* ------------------------------------------------------------------ */
/* Supports                                                            */
/* ------------------------------------------------------------------ */

function surBlob() { return !!process.env.BLOB_READ_WRITE_TOKEN; }

function dossierLocal() {
  if (process.env.VERCEL) {
    const e = new Error('Aucun magasin Blob relié au projet (BLOB_READ_WRITE_TOKEN absent)');
    e.configuration = true;
    throw e;
  }
  return path.resolve(process.env.COFFRE_DIR || '.coffre');
}

async function ecrireBrut(chemin, donnees) {
  if (surBlob()) {
    const { put } = require('@vercel/blob');
    await put(PREFIXE + chemin, donnees, {
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/octet-stream'
    });
    return;
  }
  const f = path.join(dossierLocal(), chemin);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, donnees);
}

async function lireBrut(chemin) {
  if (surBlob()) {
    const { get } = require('@vercel/blob');
    const r = await get(PREFIXE + chemin, { access: 'private', useCache: false });
    if (!r || !r.stream) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  }
  const f = path.join(dossierLocal(), chemin);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}

async function listerBrut(prefixe) {
  if (surBlob()) {
    const { list } = require('@vercel/blob');
    const out = [];
    let cursor;
    do {
      const r = await list({ prefix: PREFIXE + prefixe, cursor, limit: 1000 });
      for (const b of r.blobs) out.push(b.pathname.slice(PREFIXE.length));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
  const racine = dossierLocal();
  const out = [];
  (function parcourir(rel) {
    const abs = path.join(racine, rel);
    if (!fs.existsSync(abs)) return;
    for (const n of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${n.name}` : n.name;
      if (n.isDirectory()) parcourir(r); else out.push(r);
    }
  })('');
  return out.filter(c => c.startsWith(prefixe)).sort();
}

/* ------------------------------------------------------------------ */
/* API publique                                                        */
/* ------------------------------------------------------------------ */

async function ecrire(chemin, clair) {
  verifierChemin(chemin);
  await ecrireBrut(chemin, chiffrer(chemin, Buffer.isBuffer(clair) ? clair : Buffer.from(clair)));
}

async function lire(chemin) {
  verifierChemin(chemin);
  const brut = await lireBrut(chemin);
  return brut ? dechiffrer(chemin, brut) : null;
}

async function ecrireJson(chemin, objet) {
  await ecrire(chemin, JSON.stringify(objet));
}

async function lireJson(chemin) {
  const b = await lire(chemin);
  return b ? JSON.parse(b.toString('utf8')) : null;
}

async function lister(prefixe) {
  verifierChemin(prefixe);
  return listerBrut(prefixe);
}

/** Lit tous les objets JSON d'un préfixe (volumes d'une étude : quelques centaines). */
async function listerJson(prefixe) {
  const chemins = (await lister(prefixe)).filter(c => c.endsWith('.json'));
  const out = [];
  for (let i = 0; i < chemins.length; i += 20) {
    const lot = await Promise.all(chemins.slice(i, i + 20).map(c => lireJson(c).catch(() => null)));
    out.push(...lot.filter(Boolean));
  }
  return out;
}

function identifiant(octets = 12) {
  return crypto.randomBytes(octets).toString('hex');
}

/* ------------------------------------------------------------------ */
/* Journal — une ligne par événement, jamais réécrite                  */
/* ------------------------------------------------------------------ */

async function journaliser(evenement) {
  const quand = new Date().toISOString();
  const mois = quand.slice(0, 7);
  const nom = `${quand.replace(/[:.]/g, '-')}-${identifiant(4)}`;
  try {
    await ecrireJson(`journal/${mois}/${nom}.json`, { quand, ...evenement });
  } catch (e) {
    // Le journal ne doit pas faire échouer l'opération qu'il consigne,
    // mais son silence doit se voir dans les logs.
    console.error('[coffre] journal non écrit :', e.message);
  }
}

async function lireJournal(nbMois = 3) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < nbMois; i++) {
    const mois = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    out.push(...await listerJson(`journal/${mois}/`));
  }
  return out.sort((a, b) => (a.quand < b.quand ? 1 : -1));
}

module.exports = {
  ecrire, lire, ecrireJson, lireJson, lister, listerJson,
  identifiant, journaliser, lireJournal, surBlob
};
