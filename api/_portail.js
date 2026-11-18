/**
 * _portail.js — Portail du notaire (servi par api/espace.js, ?zone=portail :
 * le projet est limité à 12 fonctions Vercel)
 *
 * Portail du notaire : validation des fiches clients, RIB de l'étude
 * (dépôt, communication à un client), demandes de RIB et d'origine des fonds,
 * pièces reçues (consultées sous filigrane), envoi des questionnaires en
 * ligne (ancienne page /admin), journal.
 *
 * Accès : code d'accès (PORTAIL_CODE) + code à six chiffres du téléphone
 * (TOTP). Le téléphone s'enrôle au premier passage par QR code.
 *
 * Variables d'environnement :
 *   PORTAIL_CODE            code d'accès, 12 caractères au moins, obligatoire
 *   PORTAIL_OTP_REENROLER   « 1 » pour autoriser un nouvel enrôlement
 *                           (téléphone perdu) ; à retirer aussitôt après.
 *
 * Ce portail ne supprime rien : ni fiche, ni pièce, ni ligne de journal.
 */

const QRCode = require('qrcode');
const coffre = require('./_coffre');
const annuaire = require('./_annuaire');
const sec = require('./_securite');
const {
  MOTIFS, SOURCES, erreurClient, ribEtudeInfo, ribEtudeContenu, ribEtudeDeposer,
  envoyerEmail, adresseDuSite, enveloppe, euros
} = require('./_metier');
const { filigraner, filigranerPiece, nouvelleReference } = require('./_filigrane');
const questionnaires = require('./_questionnaires');
const declaration = require('./_declaration');

const DUREE_SESSION = 12 * 60 * 60 * 1000;
const TOTP = 'portail/totp.json';
const TOTP_ATTENTE = 'portail/totp-attente.json';

/* ------------------------------------------------------------------ */
/* Authentification                                                    */
/* ------------------------------------------------------------------ */

function codeAcces() {
  const c = process.env.PORTAIL_CODE || '';
  if (c.length < 12) {
    throw Object.assign(new Error('PORTAIL_CODE absent ou trop court (12 caractères au moins)'), { configuration: true });
  }
  return c;
}

async function freinConnexion(req) {
  const permis =
    await sec.sousLimite('portail-ip', sec.ipDe(req), 10, 15 * 60 * 1000) &&
    await sec.sousLimite('portail', 'tous', 40, 60 * 60 * 1000);
  if (!permis) throw erreurClient('Trop de tentatives. Merci de patienter un quart d\'heure.', 429);
}

async function exigerCode(req) {
  await freinConnexion(req);
  if (!sec.egal(sec.hmac(`pc|${req.body.code || ''}`), sec.hmac(`pc|${codeAcces()}`))) {
    await coffre.journaliser({ acteur: 'inconnu', action: 'portail-refus', ip: sec.ipDe(req) });
    throw erreurClient('Identifiants incorrects', 401);
  }
}

function lireCookie(req) {
  const m = /(?:^|;\s*)portail=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function poserCookie(req, res, valeur, dureeMs) {
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(req.headers.host || '');
  res.setHeader('Set-Cookie',
    `portail=${encodeURIComponent(valeur)}; Path=/api/espace; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(dureeMs / 1000)}${local ? '' : '; Secure'}`);
}

const connecte = (req) => !!sec.lireJeton('portail', lireCookie(req));

function ouvrir(req, res) {
  poserCookie(req, res, sec.signerJeton('portail', {}, DUREE_SESSION), DUREE_SESSION);
}

async function etatConnexion(req, res) {
  codeAcces();
  const enrole = !!(await coffre.lireJson(TOTP)) && process.env.PORTAIL_OTP_REENROLER !== '1';
  res.json({ ok: true, enrole, connecte: connecte(req) });
}

async function enrolerDebut(req, res) {
  await exigerCode(req);
  if (await coffre.lireJson(TOTP) && process.env.PORTAIL_OTP_REENROLER !== '1') {
    throw erreurClient('Un téléphone est déjà enrôlé');
  }
  const secret = sec.nouveauSecretTotp();
  await coffre.ecrireJson(TOTP_ATTENTE, { secret, e: Date.now() + 15 * 60 * 1000 });
  const uri = `otpauth://totp/${encodeURIComponent('Office TAGOT:Portail clients')}?secret=${secret}&issuer=${encodeURIComponent('Office TAGOT')}`;
  res.json({ ok: true, secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
}

async function enrolerFin(req, res) {
  await exigerCode(req);
  const attente = await coffre.lireJson(TOTP_ATTENTE);
  if (!attente || !attente.secret || Date.now() > attente.e) throw erreurClient('Enrôlement expiré : recommencez');
  if (!sec.totpValide(attente.secret, req.body.totp)) throw erreurClient('Code à six chiffres incorrect', 401);
  await coffre.ecrireJson(TOTP, { secret: attente.secret, enroleLe: new Date().toISOString() });
  await coffre.ecrireJson(TOTP_ATTENTE, { secret: null, e: 0 });
  await coffre.journaliser({ acteur: 'notaire', action: 'portail-telephone-enrole', ip: sec.ipDe(req) });
  ouvrir(req, res);
  res.json({ ok: true });
}

async function connexion(req, res) {
  await exigerCode(req);
  const t = await coffre.lireJson(TOTP);
  if (!t || !sec.totpValide(t.secret, req.body.totp)) {
    await coffre.journaliser({ acteur: 'inconnu', action: 'portail-refus', ip: sec.ipDe(req) });
    throw erreurClient('Identifiants incorrects', 401);
  }
  await coffre.journaliser({ acteur: 'notaire', action: 'portail-connexion', ip: sec.ipDe(req) });
  ouvrir(req, res);
  res.json({ ok: true });
}

async function deconnexion(req, res) {
  poserCookie(req, res, '', 0);
  res.json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Tableau de bord                                                     */
/* ------------------------------------------------------------------ */

async function tableau(req, res) {
  const [fiches, demandes, depots, rib] = await Promise.all([
    annuaire.listerFiches(), coffre.listerJson('demandes/'), coffre.listerJson('depots/'), ribEtudeInfo()
  ]);
  // Déclaration commencée par le client et pas encore signée : où il en est.
  const enCours = (d) => {
    const b = d.statut === 'en-attente' && depots.find(x => x.nature === 'origine' && x.statut === 'ouvert' && x.demandeId === d.id);
    return b ? { enCours: { commenceeLe: b.ouvertLe, enregistreeLe: b.enregistreLe, pieces: b.pieces.length } } : {};
  };
  const recent = (a, b, champ) => ((a[champ] || '') < (b[champ] || '') ? 1 : -1);
  res.json({
    ok: true,
    fiches: fiches.map(f => ({
      id: f.id, nom: f.nom, prenom: f.prenom, nomNaissance: f.nomNaissance, accord: f.accord, email: f.email,
      adresse: f.adresse, codePostal: f.codePostal, ville: f.ville,
      telephone: f.telephone || f.telephoneBrut, telephoneExploitable: !!f.telephone && sec.estMobile(f.telephone),
      etat: f.etat, valideeLe: f.valideeLe
    })),
    demandes: demandes.sort((a, b) => recent(a, b, 'creeLe')).map(d => ({
      ...d, nature: d.nature || 'origine', ...enCours(d),
      motifLibelle: d.nature === 'rib' ? 'RIB du client' : d.nature === 'rib-etude' ? 'RIB de l\'étude communiqué' : (MOTIFS[d.motif] || d.motif)
    })),
    depots: depots.filter(d => d.statut === 'clos').sort((a, b) => recent(a, b, 'closLe')).map(({ saisie, piecesRetirees, ...d }) => ({
      ...d, telephone: sec.masquerTelephone(d.telephone),
      sources: (d.sources || []).map(s => ({ ...s, libelle: SOURCES[s.type] || s.type }))
    })),
    rib, motifs: MOTIFS, questionnaires: questionnaires.LIBELLES, essai: annuaire.modeEssai()
  });
}

async function valider(req, res) {
  const c = await annuaire.valider(String(req.body.id || ''));
  await coffre.journaliser({ acteur: 'notaire', action: 'fiche-validee', nom: `${c.nom} ${c.prenom}`.trim(), telephone: sec.masquerTelephone(c.telephone), ip: sec.ipDe(req) });
  res.json({ ok: true });
}

async function ficheCreer(req, res) {
  const b = req.body;
  const c = await annuaire.creerFiche({
    nom: b.nom, prenom: b.prenom, nomNaissance: b.nomNaissance, accord: b.accord, email: b.email, telephone: b.telephone,
    adresse: b.adresse, codePostal: b.codePostal, ville: b.ville
  });
  await coffre.journaliser({ acteur: 'notaire', action: c.action === 'created' ? 'fiche-saisie' : 'fiche-saisie-maj', nom: `${c.nom.toUpperCase()} ${c.prenom}`.trim(), ip: sec.ipDe(req) });
  res.json({ ok: true, action: c.action });
}

async function ficheModifier(req, res) {
  const b = req.body;
  const c = await annuaire.modifierFiche(String(b.id || ''), {
    nom: b.nom, prenom: b.prenom, nomNaissance: b.nomNaissance, accord: b.accord, email: b.email, telephone: b.telephone,
    adresse: b.adresse, codePostal: b.codePostal, ville: b.ville
  });
  await coffre.journaliser({ acteur: 'notaire', action: 'fiche-modifiee', nom: `${c.nom.toUpperCase()} ${c.prenom}`.trim(), coordonnees: c.coordChangees ? 'modifiees' : 'inchangees', ip: sec.ipDe(req) });
  res.json({ ok: true, validationRetiree: c.coordChangees && c.etaitValidee });
}

async function ficheEcarter(req, res) {
  const c = await annuaire.ecarterFiche(String(req.body.id || ''));
  await coffre.journaliser({ acteur: 'notaire', action: 'fiche-mise-de-cote', nom: `${c.nom} ${c.prenom}`.trim(), ip: sec.ipDe(req) });
  res.json({ ok: true });
}

async function ficheRestaurer(req, res) {
  const c = await annuaire.restaurerFiche(String(req.body.id || ''));
  await coffre.journaliser({ acteur: 'notaire', action: 'fiche-restauree', nom: `${c.nom} ${c.prenom}`.trim(), ip: sec.ipDe(req) });
  res.json({ ok: true });
}

async function retirer(req, res) {
  const c = await annuaire.retirer(String(req.body.id || ''));
  await coffre.journaliser({ acteur: 'notaire', action: 'validation-retiree', nom: `${c.nom} ${c.prenom}`.trim(), ip: sec.ipDe(req) });
  res.json({ ok: true });
}

async function ribDeposer(req, res) {
  const f = sec.fichierRecu(req.body.fichier);
  // Le RIB doit pouvoir être marqué au moment de sa remise : on le vérifie dès le dépôt.
  await filigraner(f, { beneficiaire: 'essai', reference: 'RIB-ESSAI' }).catch(() => {
    throw erreurClient('Ce fichier ne peut pas recevoir le filigrane (PDF protégé ou endommagé). Déposez un PDF non protégé, ou une image du RIB.');
  });
  const courant = await ribEtudeDeposer(f, 'notaire');
  await coffre.journaliser({ acteur: 'notaire', action: 'rib-etude-depose', rib: courant.id, fichier: courant.nom, ip: sec.ipDe(req) });
  res.json({ ok: true });
}

async function demandeCreer(req, res) {
  const f = await annuaire.ficheOuverte(String(req.body.contactId || ''));
  if (!f) throw erreurClient('Cette fiche n\'est pas validée : validez-la avant de lui adresser une demande');
  if (!MOTIFS[req.body.motif]) throw erreurClient('Choisissez un motif');
  const montant = Math.round(Number(req.body.montant) * 100) / 100;
  if (!(montant > 0) || montant > 1e9) throw erreurClient('Montant à justifier invalide');

  const demande = {
    id: coffre.identifiant(), reference: nouvelleReference('DEM'), statut: 'en-attente', contactId: f.id,
    nomClient: `${f.nom} ${f.prenom}`.trim(), motif: req.body.motif, montant,
    justificatifs: req.body.justificatifs !== false, creeLe: new Date().toISOString()
  };
  await coffre.ecrireJson(`demandes/${demande.id}.json`, demande);
  await coffre.journaliser({ acteur: 'notaire', action: 'demande-origine-fonds', nom: demande.nomClient, demande: demande.reference, montant, ip: sec.ipDe(req) });

  const prevenu = req.body.prevenir === true && !!f.email && await emailOrigine(req, f, demande);
  res.json({ ok: true, prevenu });
}

/** Email au client : la déclaration se fait dans l'espace client, en une ou plusieurs fois. */
function emailOrigine(req, f, demande, relance = false) {
  const site = adresseDuSite(req).replace(/^https?:\/\//, '');
  return envoyerEmail({
    a: f.email,
    sujet: `${relance ? 'Rappel — ' : ''}Origine des fonds — déclaration à compléter et à signer`,
    titre: 'Origine des fonds',
    sousTitre: MOTIFS[demande.motif] || demande.motif,
    corpsHtml:
      `<p style="margin:0 0 14px;">Bonjour ${sec.echapper(f.prenom)},</p>` +
      `<p style="margin:0 0 14px;">Dans le cadre de votre dossier, ${relance ? 'je reste dans l\'attente de votre déclaration sur' : 'je vous remercie de bien vouloir me déclarer et me justifier'} l'origine des fonds à hauteur de <strong>${euros(demande.montant)}</strong>.</p>` +
      `<p style="margin:0 0 14px;">Référence de ma demande : <strong>${demande.reference}</strong>.</p>` +
      `<p style="margin:0 0 14px;">Vous le faites en ligne, dans l'espace client de l'office : ouvrez votre navigateur et saisissez vous-même l'adresse <strong>${sec.echapper(site)}/espace</strong>. Indiquez votre adresse email : vous recevrez un premier code par email, puis un second par SMS sur votre téléphone mobile.</p>` +
      '<p style="margin:0 0 14px;">Vous pouvez vous y prendre en plusieurs fois : votre saisie et vos justificatifs sont enregistrés au fur et à mesure, et vous les retrouvez en revenant, même depuis un autre appareil. Une fois votre déclaration complète, vous la signez par un code reçu par SMS.</p>' +
      '<p style="margin:0 0 14px;font-size:12px;color:#888;">Par prudence, cet email ne contient aucun lien cliquable. Je ne vous demanderai jamais de mot de passe ni de coordonnées bancaires par email, ni de me communiquer un code reçu par SMS.</p>' +
      '<p style="margin:22px 0 0;">Bien cordialement,<br><strong>Grégoire TAGOT | notaire</strong></p>'
  });
}

/** Rappel d'une demande d'origine des fonds restée sans réponse. */
async function demandeRelancer(req, res) {
  const id = String(req.body.id || '');
  const demande = /^[0-9a-f]{24}$/.test(id) && await coffre.lireJson(`demandes/${id}.json`);
  if (!demande || (demande.nature || 'origine') !== 'origine' || demande.statut !== 'en-attente') throw erreurClient('Cette demande n\'est plus en attente');
  const f = await annuaire.ficheOuverte(demande.contactId);
  if (!f) throw erreurClient('La fiche de ce client n\'est plus validée : validez-la avant de le relancer');
  if (!f.email) throw erreurClient('Aucune adresse email sur cette fiche');
  const envoye = await emailOrigine(req, f, demande, true);
  await coffre.journaliser({
    acteur: 'notaire', action: 'demande-origine-fonds', nom: demande.nomClient, demande: demande.reference, montant: demande.montant,
    relance: true, destinataire: f.email, ...(envoye ? {} : { email: 'non-parti' }), ip: sec.ipDe(req)
  });
  if (!envoye) throw erreurClient(`Le rappel à ${f.email} n'a pas pu partir. Réessayez dans quelques minutes.`, 502);
  res.json({ ok: true, email: f.email, demande: demande.reference });
}

/**
 * Les deux gestes « RIB » du notaire envers un client : lui demander son RIB,
 * ou lui communiquer celui de l'étude. Dans les deux cas :
 *   - seule une fiche validée (email et mobile vérifiés par le notaire) est visée ;
 *   - le client reçoit toujours un email de l'étude, sans lien ni pièce jointe ;
 *   - il agit ensuite dans l'espace client, où il n'entre qu'après un code
 *     reçu par email puis un code reçu par SMS.
 * La demande reste ouverte jusqu'au dépôt du RIB du client, ou jusqu'à ce
 * qu'il ait consulté celui de l'étude : le portail montre où il en est.
 */
const GESTES_RIB = {
  rib: {
    refus: 'Cette fiche n\'est pas validée : validez-la avant de lui demander son RIB',
    journal: 'demande-rib',
    sujet: 'Votre RIB — à me transmettre par l\'espace client',
    titre: 'Votre relevé d\'identité bancaire',
    texte: '<p style="margin:0 0 14px;">Dans le cadre de votre dossier, je vous remercie de bien vouloir me transmettre votre relevé d\'identité bancaire (RIB), à votre nom.</p>' +
      '<p style="margin:0 0 14px;">Pour des raisons de sécurité, je vous remercie de ne pas me l\'adresser par email, mais de le déposer dans l\'espace client de l\'office.</p>'
  },
  'rib-etude': {
    refus: 'Cette fiche n\'est pas validée : validez-la avant de lui communiquer le RIB de l\'étude',
    journal: 'rib-etude-communique',
    sujet: 'RIB de l\'office — à consulter dans votre espace client',
    titre: 'RIB de l\'office',
    texte: '<p style="margin:0 0 14px;">Dans le cadre de votre dossier, le relevé d\'identité bancaire de l\'office est à votre disposition, pour les virements que vous aurez à effectuer.</p>' +
      '<p style="margin:0 0 14px;">Pour des raisons de sécurité, je ne vous l\'adresse pas par email : vous le trouverez dans l\'espace client de l\'office. L\'exemplaire qui vous y sera remis portera votre nom, la date et une référence unique.</p>' +
      '<p style="margin:0 0 14px;"><strong>Je ne vous communiquerai jamais de RIB ni de changement de RIB par email ou par SMS.</strong> Si vous recevez un RIB se recommandant de l\'office par un autre moyen, ne faites aucun virement et contactez-moi à un numéro que vous connaissez déjà.</p>'
  }
};

async function gesteRib(nature, req, res) {
  const g = GESTES_RIB[nature];
  const f = await annuaire.ficheOuverte(String(req.body.contactId || ''));
  if (!f) throw erreurClient(g.refus);
  if (!f.email) throw erreurClient('Aucune adresse email sur cette fiche : le client ne pourrait pas s\'identifier');
  if (nature === 'rib-etude' && !(await ribEtudeInfo()).courant) {
    throw erreurClient('Aucun RIB de l\'étude déposé : déposez-le d\'abord (onglet « RIB de l\'étude »)');
  }

  const nomClient = `${f.nom} ${f.prenom}`.trim();
  // Une demande déjà en attente est relancée, sous sa référence d'origine.
  let demande = (await coffre.listerJson('demandes/'))
    .find(d => d.nature === nature && d.statut === 'en-attente' && d.contactId === f.id);
  const deja = !!demande;
  if (!demande || !demande.reference) {
    demande = { id: coffre.identifiant(), ...demande, reference: nouvelleReference('DEM'), nature, statut: 'en-attente', contactId: f.id, nomClient, creeLe: (demande && demande.creeLe) || new Date().toISOString() };
    await coffre.ecrireJson(`demandes/${demande.id}.json`, demande);
  }

  const site = adresseDuSite(req).replace(/^https?:\/\//, '');
  const envoye = await envoyerEmail({
    a: f.email, sujet: g.sujet, titre: g.titre, sousTitre: 'Espace client de l\'office',
    corpsHtml:
      `<p style="margin:0 0 14px;">Bonjour ${sec.echapper(f.prenom)},</p>` + g.texte +
      `<p style="margin:0 0 14px;">Référence de ma demande : <strong>${demande.reference}</strong>. Elle figurera sur ${nature === 'rib' ? 'votre RIB une fois reçu par l\'office' : 'le RIB qui vous sera remis'}.</p>` +
      `<p style="margin:0 0 14px;">Ouvrez votre navigateur et saisissez vous-même l'adresse <strong>${sec.echapper(site)}/espace</strong>. Indiquez votre adresse email : vous recevrez un premier code par email, puis un second par SMS sur votre téléphone mobile.</p>` +
      '<p style="margin:0 0 14px;font-size:12px;color:#888;">Par prudence, cet email ne contient aucun lien cliquable ni aucune pièce jointe. Je ne vous demanderai jamais de mot de passe, ni de me communiquer un code reçu par SMS.</p>' +
      '<p style="margin:22px 0 0;">Bien cordialement,<br><strong>Grégoire TAGOT | notaire</strong></p>'
  });
  await coffre.journaliser({
    acteur: 'notaire', action: g.journal, nom: nomClient, demande: demande.reference, destinataire: f.email, ...(deja ? { relance: true } : {}),
    ...(envoye ? {} : { email: 'non-parti' }), ip: sec.ipDe(req)
  });
  if (!envoye) {
    throw erreurClient(`La demande est enregistrée dans l'espace client, mais l'email à ${f.email} n'a pas pu partir. Réessayez dans quelques minutes.`, 502);
  }
  res.json({ ok: true, email: f.email, dejaEnCours: deja, demande: demande.reference });
}

const demandeRib = (req, res) => gesteRib('rib', req, res);
const ribCommuniquer = (req, res) => gesteRib('rib-etude', req, res);

async function depotVu(req, res) {
  const id = String(req.body.id || '');
  if (!/^[0-9a-f]{24}$/.test(id)) throw erreurClient('Dépôt inconnu');
  const depot = await coffre.lireJson(`depots/${id}.json`);
  if (!depot) throw erreurClient('Dépôt inconnu');
  await coffre.ecrireJson(`depots/${id}.json`, { ...depot, vuLe: depot.vuLe || new Date().toISOString() });
  res.json({ ok: true });
}

async function liaisonSms(req, res) {
  res.json({ ok: true, liaison: await require('./_sms').diagnostic() });
}

async function journal(req, res) {
  res.json({ ok: true, lignes: (await coffre.lireJournal(3)).slice(0, 400) });
}

/* ------------------------------------------------------------------ */
/* Téléchargements (GET, session exigée)                               */
/* ------------------------------------------------------------------ */

function envoyerFichier(res, { buf, type, nom }, telecharger) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition',
    `${telecharger ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(nom)}`);
  res.status(200).send(buf);
}

async function telechargement(req, res) {
  const q = req.query || {};
  if (q.action === 'rib-etude') {
    const rib = await ribEtudeContenu();
    if (!rib) throw erreurClient('Aucun RIB déposé', 404);
    return envoyerFichier(res, rib, q.telecharger === '1');
  }
  if (q.action === 'declaration') {
    // La déclaration signée, telle qu'elle a été figée au coffre à la signature.
    const depot = /^[0-9a-f]{24}$/.test(q.depot || '') && await coffre.lireJson(`depots/${q.depot}.json`);
    const signee = await declaration.lireSignee(depot);
    if (!signee) throw erreurClient('Déclaration inconnue', 404);
    await coffre.journaliser({
      acteur: 'notaire', action: signee.intacte ? 'declaration-consultee' : 'declaration-consultee-alteree',
      nom: depot.nomClient, depot: depot.id, demande: depot.signature.demande, ip: sec.ipDe(req)
    });
    if (!signee.intacte) throw erreurClient('Le contrôle d\'intégrité de cette déclaration a échoué : son empreinte ne correspond plus à celle de la signature.', 409);
    return envoyerFichier(res, { buf: signee.pdf, type: 'application/pdf', nom: `Déclaration origine des fonds — ${depot.nomClient} — ${depot.signature.demande}.pdf` }, q.telecharger === '1');
  }
  if (q.action === 'piece') {
    if (!/^[0-9a-f]{24}$/.test(q.depot || '') || !/^[0-9a-f]{24}$/.test(q.piece || '')) throw erreurClient('Pièce inconnue', 404);
    const depot = await coffre.lireJson(`depots/${q.depot}.json`);
    const piece = depot && depot.pieces.find(p => p.id === q.piece);
    const buf = piece && await coffre.lire(`pieces/${q.depot}/${q.piece}.bin`);
    if (!buf) throw erreurClient('Pièce inconnue', 404);
    // Copie filigranée : l'original reste intact dans le coffre. Un PDF qui ne
    // se laisse pas marquer (protégé, endommagé) est remis tel quel, et le
    // journal le dit.
    const marque = await filigranerPiece({ buf, type: piece.type }, { client: depot.nomClient, recuLe: depot.closLe || depot.ouvertLe, demande: (depot.demandes || []).join(', ') })
      .catch(() => null);
    await coffre.journaliser({
      acteur: 'notaire', action: marque ? 'piece-consultee' : 'piece-consultee-sans-filigrane',
      nom: depot.nomClient, depot: depot.id, fichier: piece.nom,
      ...(depot.demandes && depot.demandes.length ? { demande: depot.demandes.join(', ') } : {}), ip: sec.ipDe(req)
    });
    if (!marque) return envoyerFichier(res, { buf, type: piece.type, nom: piece.nom }, q.telecharger === '1');
    return envoyerFichier(res, { buf: marque, type: 'application/pdf', nom: piece.nom.replace(/\.(pdf|jpe?g|png)$/i, '') + '.pdf' }, q.telecharger === '1');
  }
  throw erreurClient('Action inconnue', 404);
}

/* ------------------------------------------------------------------ */

const PUBLIQUES = { etat: etatConnexion, connexion, 'enroler-debut': enrolerDebut, 'enroler-fin': enrolerFin, deconnexion };
const PROTEGEES = { tableau, valider, retirer, 'fiche-creer': ficheCreer, 'fiche-modifier': ficheModifier, 'fiche-ecarter': ficheEcarter, 'fiche-restaurer': ficheRestaurer, 'rib-deposer': ribDeposer, 'demande-creer': demandeCreer, 'demande-relancer': demandeRelancer, 'demande-rib': demandeRib, 'rib-communiquer': ribCommuniquer, 'depot-vu': depotVu, 'questionnaire-envoyer': questionnaires.envoyerQuestionnaire, journal, 'liaison-sms': liaisonSms };

module.exports = enveloppe(async (req, res) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  if (req.method === 'GET') {
    if (!connecte(req)) throw erreurClient('Session expirée', 401);
    return telechargement(req, res);
  }
  if (req.method !== 'POST') return res.status(405).end();

  // Un formulaire d'un autre site ne peut pas poser cet en-tête.
  if (req.headers['x-portail'] !== '1') throw erreurClient('Requête refusée', 403);
  req.body = req.body && typeof req.body === 'object' ? req.body : {};

  const publique = PUBLIQUES[req.body.action];
  if (publique) return publique(req, res);

  const protegee = PROTEGEES[req.body.action];
  if (!protegee) throw erreurClient('Action inconnue');
  if (!connecte(req)) throw erreurClient('Session expirée', 401);
  await protegee(req, res);
});
