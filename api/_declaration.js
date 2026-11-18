/**
 * _declaration.js — Déclaration d'origine des fonds (questionnaire LCB-FT),
 * remplie dans l'espace client en réponse à une demande du notaire.
 *
 * Trois propriétés tenues ici :
 *
 * 1. Le client ne refait rien. Sa saisie est un brouillon enregistré au
 *    coffre, rattaché à la demande : il la retrouve le lendemain, sur un autre
 *    appareil, après s'être identifié de nouveau. Ses justificatifs sont
 *    enregistrés un à un ; il en revoit la liste (le nom, jamais le contenu).
 *
 * 2. Le montant attendu par le notaire s'impose en « V. Origine des fonds » :
 *    le total déclaré ne peut pas lui être inférieur.
 *
 * 3. La déclaration est signée. Signature électronique simple au sens de
 *    l'article 3, 10° du règlement (UE) n° 910/2014 (eIDAS), recevable en
 *    preuve (art. 25, § 1) ; ce n'est ni une signature avancée (art. 26) ni
 *    une signature qualifiée. Pour répondre à l'article 1367 du code civil
 *    (« procédé fiable d'identification garantissant son lien avec l'acte »),
 *    le dossier de preuve réunit :
 *      - l'identification du signataire : fiche validée par le notaire, code
 *        reçu par email puis code reçu par SMS pour entrer, et un nouveau code
 *        SMS, propre à la signature, envoyé au mobile validé ;
 *      - son consentement : le récapitulatif affiché, les déclarations sur
 *        l'honneur cochées, son nom affiché, le code saisi ;
 *      - le lien avec l'acte : l'empreinte SHA-256 de ce qui est signé
 *        (réponses, déclarations, empreinte de chaque pièce). Le code n'est
 *        valable que pour cette empreinte : une réponse modifiée après l'envoi
 *        du code l'annule ;
 *      - l'intégrité : la déclaration signée est figée en PDF au coffre, avec
 *        son empreinte, et un sceau (HMAC) de l'enregistrement de signature ;
 *      - la trace : date, adresse IP, navigateur, journal du portail.
 */

const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const coffre = require('./_coffre');
const sms = require('./_sms');
const sec = require('./_securite');
const { MOTIFS, SOURCES, erreurClient, envoyerEmail, euros } = require('./_metier');

const DUREE_CODE = 10 * 60 * 1000;
const ESSAIS_MAX = 5;
const PIECES_MAX = 20;
const COPIE_PENDANT = 30 * 60 * 1000; // le signataire peut retirer sa copie pendant 30 minutes

const ON = { O: 'Oui', N: 'Non' };

/**
 * Le questionnaire, rubrique par rubrique : il sert à la fois à dessiner le
 * formulaire (la page le reçoit), à contrôler la saisie et à composer la
 * déclaration signée. Mêmes rubriques que le questionnaire LCB-FT du site.
 */
const RUBRIQUES = [
  { cle: 'identite', titre: 'I. Identité du déclarant', aide: 'Informations relatives à la personne qui souscrit la présente déclaration.', champs: [
    { cle: 'qualite', libelle: 'Agissant en qualité de', type: 'choix', requis: true, options: { ACQ: 'Acquéreur', VEN: 'Vendeur', REP: 'Représentant / mandataire', AUT: 'Autre' } },
    { cle: 'qualiteAutre', libelle: 'Précisez la qualité', type: 'texte', si: { qualite: 'AUT' }, requis: true },
    { cle: 'civilite', libelle: 'Civilité', type: 'choix', options: { 'M.': 'M.', 'Mme': 'Mme' } },
    { cle: 'nom', libelle: 'Nom de naissance', type: 'texte', requis: true },
    { cle: 'nomUsage', libelle: 'Nom d\'usage (si différent)', type: 'texte' },
    { cle: 'prenoms', libelle: 'Prénom(s)', type: 'texte', requis: true },
    { cle: 'dateNaissance', libelle: 'Date de naissance', type: 'date', requis: true },
    { cle: 'lieuNaissance', libelle: 'Lieu de naissance', type: 'texte', requis: true, exemple: 'Ville (pays si étranger)' },
    { cle: 'nationalite', libelle: 'Nationalité', type: 'texte', requis: true },
    { cle: 'adresseVoie', libelle: 'Adresse (n° et voie)', type: 'texte', requis: true },
    { cle: 'codePostal', libelle: 'Code postal', type: 'texte', requis: true },
    { cle: 'ville', libelle: 'Ville', type: 'texte', requis: true },
    { cle: 'profession', libelle: 'Profession', type: 'texte' }
  ] },
  { cle: 'ppe', titre: 'II. Personne politiquement exposée (PPE)', aide: 'Une PPE est une personne exerçant ou ayant exercé, au cours des douze derniers mois, des fonctions publiques importantes (chef d\'État, ministre, parlementaire, ambassadeur, magistrat de haute juridiction, dirigeant d\'entreprise publique…).', champs: [
    { cle: 'self', libelle: 'Êtes-vous, ou avez-vous été dans les 12 derniers mois, une PPE ?', type: 'ouinon', requis: true },
    { cle: 'selfFonction', libelle: 'Précisez la fonction exercée', type: 'texte', si: { self: 'O' }, requis: true },
    { cle: 'famille', libelle: 'Un membre de votre famille proche (conjoint, partenaire, enfants, parents) est-il une PPE ?', type: 'ouinon', requis: true },
    { cle: 'familleFonction', libelle: 'Précisez (lien de parenté, fonction)', type: 'texte', si: { famille: 'O' }, requis: true },
    { cle: 'collaborateur', libelle: 'Êtes-vous proche collaborateur d\'une PPE ?', type: 'ouinon', requis: true },
    { cle: 'collaborateurFonction', libelle: 'Précisez', type: 'texte', si: { collaborateur: 'O' }, requis: true }
  ] },
  { cle: 'operation', titre: 'III. Opération concernée', aide: 'Informations relatives à l\'acte ou au projet pour lequel la présente déclaration est établie.', champs: [
    { cle: 'nature', libelle: 'Nature de l\'opération', type: 'choix', requis: true, options: { acquisition: 'Acquisition immobilière', vente: 'Vente immobilière', donation: 'Donation', constitution: 'Constitution de société', apport: 'Apport / cession de parts', autre: 'Autre' } },
    { cle: 'natureAutre', libelle: 'Précisez', type: 'texte', si: { nature: 'autre' }, requis: true },
    { cle: 'description', libelle: 'Description du bien ou de l\'opération', type: 'long', requis: true, exemple: 'Ex. appartement sis 12 rue Dante 75005 Paris, 3 pièces, 65 m²' },
    { cle: 'prix', libelle: 'Prix ou montant de l\'opération, hors frais (€)', type: 'nombre', requis: true },
    { cle: 'datePrevisionnelle', libelle: 'Date prévisionnelle (si connue)', type: 'date' }
  ] },
  { cle: 'personneMorale', titre: 'IV. Personne morale et bénéficiaire(s) effectif(s)', aide: 'À compléter uniquement si l\'opération est réalisée par ou au profit d\'une société, d\'une association ou de toute autre personne morale.', champs: [
    { cle: 'existe', libelle: 'L\'opération implique-t-elle une personne morale (société, SCI, association…) ?', type: 'ouinon', requis: true },
    { cle: 'denomination', libelle: 'Dénomination sociale', type: 'texte', si: { existe: 'O' }, requis: true },
    { cle: 'forme', libelle: 'Forme juridique', type: 'texte', si: { existe: 'O' }, exemple: 'SCI, SARL, SAS…' },
    { cle: 'siren', libelle: 'SIREN / SIRET', type: 'texte', si: { existe: 'O' } },
    { cle: 'siege', libelle: 'Siège social', type: 'texte', si: { existe: 'O' } },
    { cle: 'beneficiaires', libelle: 'Bénéficiaire(s) effectif(s)', type: 'liste', si: { existe: 'O' },
      aide: 'Personnes physiques qui détiennent, directement ou indirectement, plus de 25 % du capital ou des droits de vote, ou qui exercent un contrôle sur la société par tout autre moyen.',
      champs: [
        { cle: 'nom', libelle: 'Nom', type: 'texte' },
        { cle: 'prenom', libelle: 'Prénom(s)', type: 'texte' },
        { cle: 'dateNaissance', libelle: 'Date de naissance', type: 'date' },
        { cle: 'lieuNaissance', libelle: 'Lieu de naissance', type: 'texte' },
        { cle: 'nationalite', libelle: 'Nationalité', type: 'texte' },
        { cle: 'detention', libelle: '% de détention', type: 'nombre' },
        { cle: 'adresse', libelle: 'Adresse', type: 'texte' }
      ] }
  ] },
  { cle: 'fonds', titre: 'V. Origine des fonds', aide: 'Indiquez la ou les sources à l\'origine des fonds destinés à financer l\'opération. Pour chaque source cochée, précisez le montant correspondant.', fonds: true, champs: [] },
  { cle: 'contexte', titre: 'VI. Objet et contexte de l\'opération', aide: 'Ces éléments me permettent de vérifier la cohérence de l\'opération avec votre situation et de satisfaire à mes obligations de vigilance.', champs: [
    { cle: 'objet', libelle: 'Objet de l\'opération', type: 'choix', requis: true, options: { residence_principale: 'Résidence principale', residence_secondaire: 'Résidence secondaire', investissement_locatif: 'Investissement locatif', transmission_familiale: 'Transmission familiale', activite_professionnelle: 'Usage professionnel / activité', autre: 'Autre' } },
    { cle: 'objetAutre', libelle: 'Précisez', type: 'texte', si: { objet: 'autre' }, requis: true },
    { cle: 'coherence', libelle: 'L\'opération est-elle cohérente avec votre situation professionnelle et patrimoniale ?', type: 'choix', requis: true, options: { O: 'Oui', N: 'Non / à préciser' } },
    { cle: 'coherencePrecision', libelle: 'Précisez', type: 'long', si: { coherence: 'N' }, requis: true },
    { cle: 'pourTiers', libelle: 'Intervenez-vous pour le compte d\'un tiers (autre que vous-même) ?', type: 'ouinon', requis: true },
    { cle: 'tiersPrecision', libelle: 'Identité du tiers et nature du mandat', type: 'long', si: { pourTiers: 'O' }, requis: true },
    { cle: 'fondsEtranger', libelle: 'Les fonds proviennent-ils, en tout ou partie, de l\'étranger ?', type: 'ouinon', requis: true },
    { cle: 'etrangerPays', libelle: 'Pays d\'origine des fonds', type: 'texte', si: { fondsEtranger: 'O' }, requis: true }
  ] }
];

/** Libellé de la précision attendue pour chaque origine (vide : pas de précision). */
const PRECISIONS = {
  vente: 'Bien vendu', succession: 'Succession ou donation concernée', pret: 'Établissement prêteur',
  indem: 'Nature de l\'indemnité', autre: 'Précisez l\'autre origine'
};

const PIECES_PAR_SOURCE = {
  epargne: ['Relevés de compte', 'Relevé de situation', 'Attestation du dépositaire des fonds'],
  vente: ['Attestation de vente mentionnant le prix', 'Copie de l\'acte de vente'],
  succession: ['Courrier de la banque', 'Déclaration de succession', 'Acte de donation', 'Relevé de compte de la succession'],
  pret: ['Offre de prêt'],
  titres: ['Tout justificatif permettant de prouver l\'origine des fonds'],
  indem: ['Tout justificatif permettant de prouver l\'origine des fonds'],
  autre: ['Tout justificatif permettant de prouver l\'origine des fonds']
};

const DECLARATIONS = [
  'Les fonds utilisés ne proviennent pas d\'une activité illicite et ne participent pas au financement du terrorisme ;',
  'Les informations fournies dans la présente déclaration sont exactes, sincères et complètes ;',
  'Je m\'engage à fournir, à première demande du notaire, tout justificatif permettant d\'établir l\'origine des fonds (relevés bancaires, actes de vente, attestations bancaires, etc.) ;',
  'Je suis informé(e) que le notaire est soumis aux obligations de vigilance prévues par le code monétaire et financier et qu\'il peut être amené à effectuer une déclaration à TRACFIN en cas de doute sur l\'origine des fonds, sans m\'en informer.'
];
const ENGAGEMENT = 'La présente déclaration est faite sous ma seule responsabilité. Toute déclaration inexacte, incomplète ou frauduleuse m\'expose aux sanctions civiles et pénales prévues par la loi, notamment au titre des articles 441-1 et suivants du code pénal réprimant le faux et l\'usage de faux.';
const METHODE = 'Code à usage unique reçu par SMS sur le mobile validé par l\'office, après identification par un code reçu par email puis un code reçu par SMS';
const NIVEAU = 'Signature électronique simple — règlement (UE) n° 910/2014, art. 3, 10° et art. 25, § 1 ; code civil, art. 1366 et 1367';

/* ------------------------------------------------------------------ */
/* Saisie : nettoyage, contrôle, mise en forme                         */
/* ------------------------------------------------------------------ */

const MAX = { texte: 200, long: 1500 };

function valeurPropre(champ, v) {
  if (v === undefined || v === null) return '';
  if (champ.type === 'choix') return Object.prototype.hasOwnProperty.call(champ.options, v) ? v : '';
  if (champ.type === 'ouinon') return v === 'O' || v === 'N' ? v : '';
  if (champ.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
  if (champ.type === 'nombre') {
    const n = Math.round(Number(v) * 100) / 100;
    return v !== '' && Number.isFinite(n) && n >= 0 && n <= 1e10 ? n : '';
  }
  return String(v).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, MAX[champ.type] || MAX.texte);
}

/** Ne garde de ce qu'envoie la page que ce que le questionnaire connaît. */
function nettoyer(brut) {
  const src = brut && typeof brut === 'object' ? brut : {};
  const saisie = {};
  for (const r of RUBRIQUES) {
    const s = src[r.cle] && typeof src[r.cle] === 'object' ? src[r.cle] : {};
    const out = saisie[r.cle] = {};
    for (const c of r.champs) {
      if (c.type === 'liste') {
        out[c.cle] = (Array.isArray(s[c.cle]) ? s[c.cle] : []).slice(0, 8).map(l =>
          Object.fromEntries(c.champs.map(sc => [sc.cle, valeurPropre(sc, (l || {})[sc.cle])])));
      } else out[c.cle] = valeurPropre(c, s[c.cle]);
    }
    if (r.fonds) {
      out.sources = (Array.isArray(s.sources) ? s.sources : []).filter(x => x && SOURCES[x.type]).slice(0, 12).map(x => ({
        type: x.type,
        montant: valeurPropre({ type: 'nombre' }, x.montant),
        precision: valeurPropre({ type: 'texte' }, x.precision)
      }));
    }
  }
  return saisie;
}

const visible = (champ, valeurs) => !champ.si || Object.entries(champ.si).every(([k, v]) => valeurs[k] === v);
const total = (saisie) => saisie.fonds.sources.reduce((a, s) => a + (Number(s.montant) || 0), 0);

/**
 * La saisie telle qu'elle sera signée : les champs que leur condition masque
 * sont vidés, les origines sans montant écartées.
 */
function arreter(saisie) {
  const s = nettoyer(saisie);
  for (const r of RUBRIQUES) {
    for (const c of r.champs) {
      if (!visible(c, s[r.cle])) s[r.cle][c.cle] = c.type === 'liste' ? [] : '';
      if (c.type === 'liste') s[r.cle][c.cle] = s[r.cle][c.cle].filter(l => l.nom || l.prenom);
    }
  }
  s.fonds.sources = s.fonds.sources.filter(x => Number(x.montant) > 0);
  return s;
}

/** Ce qui manque pour signer ; liste vide si la déclaration est complète. */
function manques(saisie, demande, pieces) {
  const m = [];
  for (const r of RUBRIQUES) {
    for (const c of r.champs) {
      if (c.requis && visible(c, saisie[r.cle]) && saisie[r.cle][c.cle] === '') m.push(`${r.titre} — ${c.libelle}`);
    }
  }
  const pm = saisie.personneMorale;
  if (pm.existe === 'O' && !pm.beneficiaires.length) m.push('IV. Personne morale — au moins un bénéficiaire effectif');
  const src = saisie.fonds.sources;
  if (!src.length) m.push('V. Origine des fonds — au moins une origine, avec son montant');
  if (src.some(x => x.type === 'autre' && !x.precision)) m.push('V. Origine des fonds — précisez l\'autre origine');
  if (src.length && total(saisie) + 0.005 < demande.montant) {
    m.push(`V. Origine des fonds — le total déclaré (${euros(total(saisie))}) est inférieur au montant à justifier (${euros(demande.montant)})`);
  }
  if (demande.justificatifs && !pieces.length) m.push('Justificatifs — joignez au moins une pièce');
  return m;
}

const dateFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

function texteDe(champ, v) {
  if (v === '' || v === undefined) return '';
  if (champ.type === 'choix') return champ.options[v];
  if (champ.type === 'ouinon') return ON[v];
  if (champ.type === 'date') return dateFr(v);
  if (champ.type === 'nombre') return champ.cle === 'detention' ? `${v} %` : euros(v);
  return String(v);
}

/** La déclaration en clair, telle qu'elle est montrée au signataire puis figée en PDF. */
function recapituler(saisie, demande) {
  return RUBRIQUES.map(r => {
    const lignes = [];
    for (const c of r.champs) {
      if (!visible(c, saisie[r.cle])) continue;
      if (c.type === 'liste') {
        saisie[r.cle][c.cle].forEach((l, i) => lignes.push([`Bénéficiaire effectif n° ${i + 1}`,
          c.champs.map(sc => (l[sc.cle] !== '' ? `${sc.libelle} : ${texteDe(sc, l[sc.cle])}` : '')).filter(Boolean).join(' — ')]));
      } else {
        const t = texteDe(c, saisie[r.cle][c.cle]);
        if (t) lignes.push([c.libelle, t]);
      }
    }
    if (r.fonds) {
      lignes.push(['Montant à justifier (demande du notaire)', euros(demande.montant)]);
      for (const x of saisie.fonds.sources) lignes.push([SOURCES[x.type] + (x.precision ? ` — ${x.precision}` : ''), euros(x.montant)]);
      lignes.push(['Total déclaré', euros(total(saisie))]);
    }
    return { titre: r.titre, lignes };
  });
}

const piecesSignees = (depot) => depot.pieces.map(p => ({ nom: p.nom, empreinte: p.empreinte }));

/** Empreinte de ce qui est signé : toute modification la change. */
function empreinteDe(depot, demande, signataire) {
  return crypto.createHash('sha256').update(JSON.stringify({
    v: 1, demande: demande.reference || demande.id, montant: demande.montant, signataire, contact: depot.contactId,
    saisie: arreter(depot.saisie), declarations: DECLARATIONS, engagement: ENGAGEMENT, pieces: piecesSignees(depot)
  })).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Déclaration signée : le PDF conservé au coffre                      */
/* ------------------------------------------------------------------ */

const latin = (s) => String(s).normalize('NFC').replace(/[\r\n\t\u00a0\u202f\u2009]+/g, ' ').replace(/\u2022/g, '*').replace(/\u2026/g, '...').replace(/[^\x20-\x7e -ÿ—’Œœ€]/g, '?');
const dateParis = (d) => new Date(d).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function composerPdf({ demande, recap, pieces, signature }) {
  const doc = await PDFDocument.create();
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const gras = await doc.embedFont(StandardFonts.HelveticaBold);
  const L = 595.28, H = 841.89, MG = 50, BAS = 60, LARGE = L - 2 * MG;
  const gris = rgb(0.45, 0.45, 0.45), noir = rgb(0.07, 0.07, 0.07);
  let page, y;
  const nouvellePage = () => { page = doc.addPage([L, H]); y = H - 54; };
  const couper = (texte, police, corps, largeur) => {
    const lignes = []; let ligne = '';
    for (const mot of latin(texte).split(' ')) {
      const essai = ligne ? `${ligne} ${mot}` : mot;
      if (police.widthOfTextAtSize(essai, corps) <= largeur || !ligne) ligne = essai;
      else { lignes.push(ligne); ligne = mot; }
    }
    if (ligne) lignes.push(ligne);
    return lignes;
  };
  const ecrire = (texte, { police = normal, corps = 9.5, x = MG, largeur = LARGE, couleur = noir, apres = 4 } = {}) => {
    for (const l of couper(texte, police, corps, largeur)) {
      if (y < BAS + corps) nouvellePage();
      page.drawText(l, { x, y, size: corps, font: police, color: couleur });
      y -= corps * 1.38;
    }
    y -= apres;
  };

  /** Libellé à gauche, valeur à droite, sur la même page. */
  const paire = (libelle, valeur, { xg = MG, lg = 195, xd = MG + 205, corps = 9.5 } = {}) => {
    const g = couper(libelle, normal, corps - 0.5, lg), d = couper(valeur, normal, corps, L - MG - xd - (xg - MG));
    const pas = corps * 1.38;
    if (y < BAS + Math.max(g.length, d.length) * pas) nouvellePage();
    g.forEach((l, i) => page.drawText(l, { x: xg, y: y - i * pas, size: corps - 0.5, font: normal, color: gris }));
    d.forEach((l, i) => page.drawText(l, { x: xd, y: y - i * pas, size: corps, font: normal, color: noir }));
    y -= Math.max(g.length, d.length) * pas + 3;
  };

  nouvellePage();
  ecrire('Grégoire TAGOT  |  notaire — 2 rue Dante, 75005 Paris', { corps: 8.5, couleur: gris, apres: 12 });
  ecrire('Déclaration d\'origine des fonds', { police: gras, corps: 17, apres: 4 });
  ecrire(`Demande ${demande.reference || ''} — ${MOTIFS[demande.motif] || demande.motif} — montant à justifier : ${euros(demande.montant)}`, { corps: 10, couleur: gris, apres: 14 });

  for (const r of recap) {
    if (!r.lignes.length) continue;
    if (y < BAS + 50) nouvellePage();
    ecrire(r.titre, { police: gras, corps: 11, apres: 5 });
    for (const [libelle, valeur] of r.lignes) paire(libelle, valeur);
    y -= 8;
  }

  if (y < BAS + 50) nouvellePage();
  ecrire('Justificatifs déposés dans l\'espace client', { police: gras, corps: 11, apres: 5 });
  if (!pieces.length) ecrire('Aucun.', { couleur: gris });
  for (const p of pieces) ecrire(`${p.nom} — empreinte SHA-256 : ${p.empreinte}`, { corps: 8.5, apres: 2 });
  y -= 8;

  if (y < BAS + 120) nouvellePage();
  ecrire('VII. Déclarations sur l\'honneur', { police: gras, corps: 11, apres: 5 });
  ecrire('Je certifie sur l\'honneur que :', { apres: 3 });
  for (const d of DECLARATIONS) ecrire(`— ${d}`, { x: MG + 8, largeur: LARGE - 8, apres: 2 });
  ecrire(ENGAGEMENT, { apres: 3 });
  ecrire('Je reconnais avoir lu ce qui précède et déclare engager ma responsabilité.', { police: gras, apres: 12 });

  // Cartouche de signature : d'un seul tenant, sur une page s'il le faut.
  const lignes = [
    ['Signé électroniquement par', signature.signataire],
    ['Le', `${dateParis(signature.signeLe)} (heure de Paris)`],
    ['Procédé', METHODE],
    ['Mobile', signature.mobile],
    ['Adresse IP', signature.ip],
    ['Empreinte SHA-256 de la déclaration', signature.empreinte],
    ['Valeur', NIVEAU]
  ];
  const hauteur = lignes.reduce((a, [, v]) => a + couper(v, normal, 9, LARGE - 192).length * 12.5 + 3, 0) + 60;
  if (y < BAS + hauteur) nouvellePage();
  const haut = y + 6;
  y -= 12;
  ecrire('SIGNATURE', { police: gras, corps: 9, x: MG + 12, couleur: gris, apres: 2 });
  ecrire(signature.signataire, { police: gras, corps: 15, x: MG + 12, apres: 6 });
  for (const [libelle, valeur] of lignes.slice(1)) paire(libelle, valeur, { xg: MG + 12, lg: 160, xd: MG + 180, corps: 9 });
  page.drawRectangle({ x: MG, y: y - 4, width: LARGE, height: haut - (y - 4), borderColor: noir, borderWidth: 0.8 });

  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(
    latin(`Déclaration d'origine des fonds — ${demande.reference || ''} — signée par ${signature.signataire} — empreinte ${signature.empreinte.slice(0, 16)}… — page ${i + 1}/${pages.length}`),
    { x: MG, y: 30, size: 7, font: normal, color: gris }));
  doc.setTitle(latin(`Déclaration d'origine des fonds — ${demande.reference || ''}`));
  doc.setSubject(latin(`Signée par ${signature.signataire} le ${dateParis(signature.signeLe)} — empreinte ${signature.empreinte}`));
  doc.setProducer('form.tagot.notaires.fr');
  return Buffer.from(await doc.save());
}

const cheminPdf = (depotId) => `declarations/${depotId}.bin`;

/** Sceau de l'enregistrement de signature : il ne se refait pas sans la clé du serveur. */
function sceller(s) {
  const { sceau, ...reste } = s;
  return sec.hmac(`signature|${JSON.stringify(reste, Object.keys(reste).sort())}`);
}

/* ------------------------------------------------------------------ */
/* Actions de l'espace client                                          */
/* ------------------------------------------------------------------ */

/**
 * @param o outils de api/espace.js : ouvrirSession, demandesEnAttente, nomDe, cloreDepot, renouveler
 */
module.exports = function actions(o) {
  const signataireDe = (f) => `${f.prenom} ${String(f.nom).toUpperCase()}`.trim();
  const vue = (depot) => depot.pieces.map(p => ({ id: p.id, nom: p.nom, taille: p.taille, deposeLe: p.deposeLe }));

  /** Le brouillon ouvert de ce client, avec sa demande et la fiche visée. */
  async function brouillon(req) {
    const session = await o.ouvrirSession(req);
    const id = String(req.body.depot || '');
    if (!/^[0-9a-f]{24}$/.test(id)) throw erreurClient('Déclaration inconnue');
    const depot = await coffre.lireJson(`depots/${id}.json`);
    const fiche = depot && session.fiches.find(f => f.id === depot.contactId);
    if (!depot || depot.nature !== 'origine' || depot.statut !== 'ouvert' || !fiche) throw erreurClient('Déclaration inconnue ou déjà signée');
    const demande = (await o.demandesEnAttente([fiche.id])).find(d => d.id === depot.demandeId);
    if (!demande) throw erreurClient('Cette demande n\'est plus en attente');
    return { session, depot, fiche, demande };
  }

  /** Ouvre la déclaration d'une demande : le brouillon existant, ou un nouveau, prérempli de la fiche. */
  async function ouvrir(req, res) {
    const session = await o.ouvrirSession(req);
    const ids = session.fiches.map(f => f.id);
    const demande = (await o.demandesEnAttente(ids)).find(d => d.id === req.body.demande);
    if (!demande) throw erreurClient('Demande introuvable ou déjà traitée');
    const fiche = session.fiches.find(f => f.id === demande.contactId);

    let depot = (await coffre.listerJson('depots/'))
      .find(d => d.nature === 'origine' && d.statut === 'ouvert' && d.demandeId === demande.id && d.contactId === fiche.id);
    if (!depot) {
      if (!await sec.sousLimite('depot', session.tel, 10, 60 * 60 * 1000)) throw erreurClient('Trop de dépôts. Merci de patienter.', 429);
      depot = {
        id: coffre.identifiant(), statut: 'ouvert', nature: 'origine', demandeId: demande.id,
        contactId: fiche.id, nomClient: o.nomDe(fiche), telephone: session.tel,
        ouvertLe: new Date().toISOString(), pieces: [], piecesMax: PIECES_MAX,
        justificatifsAttendus: !!demande.justificatifs,
        saisie: nettoyer({ identite: {
          civilite: fiche.accord === 'F' ? 'Mme' : fiche.accord === 'M' ? 'M.' : '',
          nom: fiche.nomNaissance || fiche.nom, nomUsage: fiche.nomNaissance ? fiche.nom : '', prenoms: fiche.prenom,
          nationalite: 'Française', adresseVoie: fiche.adresse, codePostal: fiche.codePostal, ville: fiche.ville
        } })
      };
      await coffre.ecrireJson(`depots/${depot.id}.json`, depot);
      await coffre.journaliser({ acteur: 'client', action: 'declaration-commencee', nom: depot.nomClient, demande: demande.reference, ip: sec.ipDe(req) });
    }
    res.json({
      ok: true, depot: depot.id, reference: demande.reference, motif: MOTIFS[demande.motif] || demande.motif,
      montant: demande.montant, justificatifs: !!demande.justificatifs, signataire: signataireDe(fiche),
      rubriques: RUBRIQUES, sources: SOURCES, precisions: PRECISIONS, piecesConseillees: PIECES_PAR_SOURCE,
      declarations: DECLARATIONS, engagement: ENGAGEMENT, piecesMax: PIECES_MAX,
      saisie: depot.saisie, pieces: vue(depot), enregistreLe: depot.enregistreLe || null
    });
  }

  /** Enregistrement automatique du brouillon ; la session est prolongée tant que le client travaille. */
  async function enregistrer(req, res) {
    const { session, depot } = await brouillon(req);
    depot.saisie = nettoyer(req.body.saisie);
    depot.enregistreLe = new Date().toISOString();
    await coffre.ecrireJson(`depots/${depot.id}.json`, depot);
    res.json({ ok: true, enregistreLe: depot.enregistreLe, ...o.renouveler(session) });
  }

  /** Une pièce déposée par erreur sort de la déclaration ; elle reste au coffre, rien n'est effacé. */
  async function retirerPiece(req, res) {
    const { depot } = await brouillon(req);
    const piece = depot.pieces.find(p => p.id === req.body.piece);
    if (!piece) throw erreurClient('Pièce inconnue');
    depot.pieces = depot.pieces.filter(p => p !== piece);
    depot.piecesRetirees = [...(depot.piecesRetirees || []), { ...piece, retireeLe: new Date().toISOString() }];
    await coffre.ecrireJson(`depots/${depot.id}.json`, depot);
    res.json({ ok: true, pieces: vue(depot) });
  }

  /**
   * Signature, premier temps : la déclaration est contrôlée, arrêtée, et un
   * code propre à cette signature part par SMS vers le mobile validé.
   */
  async function signerDemander(req, res) {
    const { session, depot, fiche, demande } = await brouillon(req);
    if (req.body.saisie) depot.saisie = nettoyer(req.body.saisie);
    depot.saisie = arreter(depot.saisie);
    depot.enregistreLe = new Date().toISOString();
    await coffre.ecrireJson(`depots/${depot.id}.json`, depot);

    const m = manques(depot.saisie, demande, depot.pieces);
    if (m.length) return res.status(400).json({ error: 'La déclaration est incomplète.', manques: m });
    if (req.body.engagement !== true) throw erreurClient('Cochez la case par laquelle vous engagez votre responsabilité');
    if (!await sec.sousLimite('signature-tel', session.tel, 3, 15 * 60 * 1000)) {
      throw erreurClient('Trop de codes de signature envoyés. Merci de patienter un quart d\'heure.', 429);
    }

    const signataire = signataireDe(fiche);
    const empreinte = empreinteDe(depot, demande, signataire);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await coffre.ecrireJson(`signatures/${depot.id}.json`, {
      h: sec.hmac(`signature|${depot.id}|${empreinte}|${code}`), empreinte, e: Date.now() + DUREE_CODE, n: 0
    });
    const envoi = await sms.envoyerSms(session.tel,
      `Grégoire TAGOT  |  notaire : ${code} est votre code pour SIGNER votre déclaration d'origine des fonds ${demande.reference || ''}. Valable 10 minutes. Ne le communiquez à personne.`)
      .catch(async (e) => {
        console.error('[espace] SMS de signature non envoyé :', e.message);
        await coffre.journaliser({ acteur: 'client', action: 'code-non-envoye-echec-sms', telephone: sec.masquerTelephone(session.tel), ip: sec.ipDe(req) });
        throw erreurClient('Le SMS n\'a pas pu être envoyé. Votre déclaration est enregistrée : réessayez dans quelques minutes ou contactez l\'étude.', 502);
      });
    await coffre.journaliser({ acteur: 'client', action: 'code-signature-envoye', nom: depot.nomClient, demande: demande.reference, telephone: sec.masquerTelephone(session.tel), ip: sec.ipDe(req) });
    res.json({
      ok: true, signataire, empreinte, mobile: `•• •• •• •• ${session.tel.slice(-2)}`,
      ...(envoi.essai ? { codeEssai: code } : {}), ...o.renouveler(session)
    });
  }

  /** Récapitulatif montré au signataire avant l'envoi du code : exactement ce qui sera signé. */
  async function recapitulatif(req, res) {
    const { depot, fiche, demande } = await brouillon(req);
    if (req.body.saisie) {
      depot.saisie = nettoyer(req.body.saisie);
      depot.enregistreLe = new Date().toISOString();
      await coffre.ecrireJson(`depots/${depot.id}.json`, depot);
    }
    const saisie = arreter(depot.saisie);
    const m = manques(saisie, demande, depot.pieces);
    if (m.length) return res.status(400).json({ error: 'La déclaration est incomplète.', manques: m });
    res.json({ ok: true, signataire: signataireDe(fiche), recap: recapituler(saisie, demande), pieces: vue(depot) });
  }

  /** Signature, second temps : le code reçu par SMS signe la déclaration arrêtée. */
  async function signer(req, res) {
    const { session, depot, fiche, demande } = await brouillon(req);
    const code = String(req.body.code || '').replace(/\s/g, '');
    const refus = () => erreurClient('Code incorrect ou expiré');
    if (!/^\d{6}$/.test(code)) throw refus();
    if (!await sec.sousLimite('verif-ip', sec.ipDe(req), 40, 60 * 60 * 1000)) throw erreurClient('Trop d\'essais. Merci de patienter avant de réessayer.', 429);

    const chemin = `signatures/${depot.id}.json`;
    const attente = await coffre.lireJson(chemin);
    if (!attente || !attente.h || Date.now() > attente.e || attente.n >= ESSAIS_MAX) throw refus();
    attente.n += 1; // l'essai est compté avant la comparaison
    await coffre.ecrireJson(chemin, attente);

    const signataire = signataireDe(fiche);
    const empreinte = empreinteDe(depot, demande, signataire);
    // Le code ne vaut que pour la déclaration telle qu'elle était à son envoi.
    if (empreinte !== attente.empreinte) {
      await coffre.ecrireJson(chemin, { h: null, e: 0, n: ESSAIS_MAX });
      throw erreurClient('Votre déclaration a été modifiée depuis l\'envoi du code. Demandez un nouveau code de signature.', 409);
    }
    if (!sec.egal(attente.h, sec.hmac(`signature|${depot.id}|${empreinte}|${code}`))) throw refus();
    await coffre.ecrireJson(chemin, { h: null, e: 0, n: ESSAIS_MAX, utilise: true });

    const saisie = arreter(depot.saisie);
    const signature = {
      signataire, signeLe: new Date().toISOString(), mobile: sec.masquerTelephone(session.tel),
      empreinte, ip: sec.ipDe(req), navigateur: String(req.headers['user-agent'] || '').slice(0, 200),
      demande: demande.reference || demande.id, procede: METHODE, niveau: NIVEAU
    };
    const pdf = await composerPdf({ demande, recap: recapituler(saisie, demande), pieces: piecesSignees(depot), signature });
    signature.empreintePdf = crypto.createHash('sha256').update(pdf).digest('hex');
    signature.sceau = sceller(signature);
    await coffre.ecrire(cheminPdf(depot.id), pdf);

    Object.assign(depot, {
      saisie, signature, total: total(saisie),
      sources: saisie.fonds.sources.map(x => ({ type: x.type, montant: x.montant, precision: x.precision }))
    });
    await coffre.journaliser({
      acteur: 'client', action: 'declaration-signee', nom: depot.nomClient, demande: demande.reference,
      empreinte, telephone: signature.mobile, ip: signature.ip
    });
    await o.cloreDepot(req, depot);

    if (fiche.email) {
      await envoyerEmail({
        a: fiche.email, sujet: `Votre déclaration d'origine des fonds est signée — ${demande.reference || ''}`,
        titre: 'Déclaration signée', sousTitre: 'Espace client de l\'office',
        corpsHtml:
          `<p style="margin:0 0 14px;">Bonjour ${sec.echapper(fiche.prenom)},</p>` +
          `<p style="margin:0 0 14px;">Vous avez signé électroniquement, le <strong>${sec.echapper(dateParis(signature.signeLe))}</strong>, votre déclaration d'origine des fonds en réponse à ma demande <strong>${sec.echapper(demande.reference || '')}</strong>, par un code reçu par SMS au ${sec.echapper(signature.mobile)}. Je l'ai bien reçue.</p>` +
          `<p style="margin:0 0 14px;">Empreinte de la déclaration signée :<br><span style="font-family:monospace;font-size:12px;word-break:break-all;">${empreinte}</span></p>` +
          '<p style="margin:0 0 14px;font-size:12px;color:#888;">Si vous n\'êtes pas à l\'origine de cette signature, contactez-moi sans attendre à un numéro que vous connaissez déjà. Par prudence, cet email ne contient ni lien ni pièce jointe.</p>' +
          '<p style="margin:22px 0 0;">Bien cordialement,<br><strong>Grégoire TAGOT | notaire</strong></p>'
      });
    }
    res.json({ ok: true, signataire, signeLe: signature.signeLe, empreinte, reference: demande.reference });
  }

  /** Copie remise au signataire, dans la demi-heure qui suit sa signature. */
  async function copie(req, res) {
    const session = await o.ouvrirSession(req);
    const id = String(req.body.depot || '');
    const depot = /^[0-9a-f]{24}$/.test(id) && await coffre.lireJson(`depots/${id}.json`);
    if (!depot || !depot.signature || !session.fiches.some(f => f.id === depot.contactId) ||
        Date.now() - new Date(depot.signature.signeLe).getTime() > COPIE_PENDANT) {
      throw erreurClient('Cette copie n\'est plus disponible ici : demandez-la à l\'étude.', 404);
    }
    const pdf = await coffre.lire(cheminPdf(depot.id));
    if (!pdf) throw erreurClient('Copie indisponible', 404);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="declaration-origine-des-fonds-${depot.signature.demande}.pdf"`);
    res.status(200).send(pdf);
  }

  return {
    'declaration-ouvrir': ouvrir, 'declaration-enregistrer': enregistrer, 'declaration-piece-retirer': retirerPiece,
    'declaration-recapitulatif': recapitulatif, 'declaration-signer-demander': signerDemander,
    'declaration-signer': signer, 'declaration-copie': copie
  };
};

/** Pour le portail : la déclaration signée et le contrôle de son dossier de preuve. */
module.exports.lireSignee = async (depot) => {
  const pdf = depot && depot.signature && await coffre.lire(cheminPdf(depot.id));
  if (!pdf) return null;
  return {
    pdf,
    intacte: crypto.createHash('sha256').update(pdf).digest('hex') === depot.signature.empreintePdf &&
      sec.egal(depot.signature.sceau, sceller(depot.signature))
  };
};
module.exports.PIECES_MAX = PIECES_MAX;
