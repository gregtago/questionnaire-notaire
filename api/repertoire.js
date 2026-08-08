/**
 * repertoire.js — Répertoire d'état civil, en lecture seule
 *
 * Renvoie les fiches du dossier de contacts « Clients » de la boîte partagée.
 * Exchange demeure l'unique dépôt : rien n'est recopié, chaque appel relit la
 * source. L'accès exige un jeton obtenu par /api/repertoire-connexion.
 */

const { jetonValide, jetonDeLaRequete } = require('./_totp');
const { listContacts } = require('./_contacts');

/** Réduit une fiche Graph à l'état civil, sans identifiant technique inutile. */
function versEtatCivil(c) {
  const adr = c.homeAddress || {};
  return {
    nom:        c.surname || '',
    prenom:     c.givenName || '',
    email:      (c.emailAddresses || [])[0]?.address || '',
    telephone:  c.mobilePhone || '',
    adresse:    adr.street || '',
    codePostal: adr.postalCode || '',
    ville:      adr.city || '',
    // Graph rend la date de naissance à minuit UTC ; on n'en garde que le jour
    // pour éviter tout décalage d'un jour à l'affichage.
    naissance:  c.birthday ? String(c.birthday).slice(0, 10) : '',
    dossiers:   c.categories || [],
    creeLe:     c.createdDateTime ? String(c.createdDateTime).slice(0, 10) : '',
    majLe:      c.lastModifiedDateTime ? String(c.lastModifiedDateTime).slice(0, 10) : ''
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  if (!process.env.ADMIN_TOTP_SECRET) {
    return res.status(503).json({ error: 'Accès non configuré.' });
  }

  let ouvert = false;
  try {
    ouvert = jetonValide(jetonDeLaRequete(req));
  } catch (e) {
    console.error('[repertoire] secret illisible :', e.message);
    return res.status(503).json({ error: 'Accès non configuré.' });
  }
  if (!ouvert) return res.status(401).json({ error: 'Session expirée.' });

  try {
    const fiches = (await listContacts()).map(versEtatCivil);
    fiches.sort((a, b) =>
      (a.nom || '').localeCompare(b.nom || '', 'fr') ||
      (a.prenom || '').localeCompare(b.prenom || '', 'fr'));
    // Le décompte seul : aucun nom ne doit apparaître dans les journaux.
    console.log(`[repertoire] ${fiches.length} fiche(s) transmise(s)`);
    res.json({ fiches });
  } catch (e) {
    console.error('[repertoire] lecture impossible :', e.message);
    res.status(502).json({ error: 'Répertoire momentanément indisponible.' });
  }
};
