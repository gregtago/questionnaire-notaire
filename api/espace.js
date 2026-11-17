/**
 * espace.js — Espace client : RIB de l'étude, dépôt du RIB du client,
 * justification de l'origine des fonds.
 *
 * Un seul point d'entrée (POST /api/espace, champ « action ») pour ne pas
 * multiplier les fonctions Vercel. Le portail du notaire (_portail.js) passe
 * par la même fonction, avec ?zone=portail.
 *
 * Parcours :
 *   demander-code  → le client donne son adresse email ; si elle est celle
 *                    d'une fiche validée par le notaire, un code part par email
 *   verifier-email → ce code est bon : un second code part par SMS vers le
 *                    mobile validé
 *   verifier-code  → le code SMS ouvre une session de 20 minutes
 *   etat           → ce que le client peut faire
 *   rib-etude      → remet le RIB de l'étude (consigné au journal)
 *   depot-ouvrir / depot-piece / depot-clore → dépôt d'un RIB ou de justificatifs
 *
 * Règles tenues ici :
 *   - la réponse à « demander-code » est la même que le numéro soit connu ou
 *     non : la page ne permet pas de savoir qui est client de l'étude ;
 *   - le client dépose mais ne relit jamais ce qu'il a déposé ;
 *   - ce parcours ne modifie aucune coordonnée.
 */

const crypto = require('crypto');
const coffre = require('./_coffre');
const sms = require('./_sms');
const annuaire = require('./_annuaire');
const sec = require('./_securite');
const { filigraner, nouvelleReference } = require('./_filigrane');
const {
  MOTIFS, SOURCES, erreurClient, ribEtudeInfo, ribEtudeContenu,
  avisAuNotaire, envoyerEmail, enveloppe, euros
} = require('./_metier');

const DUREE_CODE = 10 * 60 * 1000;
const DUREE_SESSION = 20 * 60 * 1000;
const ESSAIS_MAX = 5;
const PIECES_MAX = 10;

const attendre = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Identification : code par email, puis code par SMS                  */
/* ------------------------------------------------------------------ */

const refus = () => erreurClient('Code incorrect ou expiré');
const codeAleatoire = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const emailValide = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);

/**
 * Étape 1 — le client donne son adresse email. Si elle est celle d'une fiche
 * validée, un code part vers cette adresse. La réponse est la même dans tous
 * les cas : la page ne dit pas qui est client de l'étude.
 */
async function demanderCode(req, res) {
  const debut = Date.now();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!emailValide(email)) throw erreurClient('Adresse email invalide');

  const ip = sec.ipDe(req);
  const permis =
    await sec.sousLimite('code-ip', ip, 10, 60 * 60 * 1000) &&
    await sec.sousLimite('code-email', email, 3, 15 * 60 * 1000) &&
    await sec.sousLimite('code-email-jour', email, 8, 24 * 60 * 60 * 1000);
  if (!permis) throw erreurClient('Trop de demandes. Merci de patienter avant de réessayer.', 429);

  const ticket = coffre.identifiant(16);
  const reponse = { ok: true, ticket };

  const fiches = await annuaire.fichesOuvertesPourEmail(email);
  if (fiches.length) {
    const code = codeAleatoire();
    await coffre.ecrireJson(`otp/${ticket}.json`, {
      etape: 'email', h: sec.hmac(`email|${ticket}|${code}`),
      c: fiches.map(f => f.id), e: Date.now() + DUREE_CODE, n: 0
    });
    if (sms.modeEssai()) {
      reponse.codeEssai = code; // hors production, carnet fictif uniquement
    } else {
      await envoyerEmail({
        a: email,
        sujet: 'Votre code de vérification — espace client',
        titre: 'Code de vérification', sousTitre: 'Espace client de l\'office',
        corpsHtml:
          '<p style="margin:0 0 14px;">Bonjour,</p>' +
          '<p style="margin:0 0 14px;">Voici le code qui vous permet de poursuivre votre identification sur l\'espace client de l\'office :</p>' +
          `<p style="margin:0 0 18px;font-size:30px;font-weight:600;letter-spacing:.25em;color:#111;">${code}</p>` +
          '<p style="margin:0 0 14px;">Il est valable 10 minutes. Un second code vous sera ensuite adressé par SMS.</p>' +
          '<p style="margin:0 0 14px;font-size:12px;color:#888;">Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message : sans votre téléphone, personne ne peut accéder à votre espace. Je ne vous demanderai jamais ce code par téléphone ni par email.</p>' +
          '<p style="margin:22px 0 0;">Bien cordialement,<br><strong>Grégoire TAGOT | notaire</strong></p>'
      });
    }
    await coffre.journaliser({ acteur: 'client', action: 'code-email-envoye', ip });
  } else {
    await coffre.journaliser({ acteur: 'inconnu', action: 'code-refuse-email-non-valide', ip });
  }

  // Durée plancher : la réponse ne doit pas être plus rapide pour une adresse inconnue.
  await attendre(Math.max(0, 1500 - (Date.now() - debut)));
  res.json(reponse);
}

async function lireOtp(req, etape) {
  const ticket = String(req.body.ticket || '');
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!/^[0-9a-f]{32}$/.test(ticket) || !/^\d{6}$/.test(code)) throw refus();
  if (!await sec.sousLimite('verif-ip', sec.ipDe(req), 40, 60 * 60 * 1000)) {
    throw erreurClient('Trop d\'essais. Merci de patienter avant de réessayer.', 429);
  }
  const chemin = `otp/${ticket}.json`;
  const otp = await coffre.lireJson(chemin);
  if (!otp || otp.etape !== etape || Date.now() > otp.e || otp.n >= ESSAIS_MAX) throw refus();
  // L'essai est compté AVANT la comparaison : cinq essais par étape, pas un de plus.
  otp.n += 1;
  await coffre.ecrireJson(chemin, otp);
  return { ticket, code, chemin, otp };
}

/**
 * Étape 2 — le code reçu par email est bon : un second code part par SMS vers
 * le mobile validé de chaque fiche. Deux personnes qui partagent une adresse
 * mais pas un téléphone reçoivent chacune le leur, qui n'ouvre que leur fiche.
 */
async function verifierEmail(req, res) {
  const { ticket, code, chemin, otp } = await lireOtp(req, 'email');
  if (!sec.egal(otp.h, sec.hmac(`email|${ticket}|${code}`))) throw refus();

  // Les fiches sont relues : elles ont pu être refermées depuis l'étape 1.
  const fiches = (await annuaire.listerFiches()).filter(f => f.etat === 'ouverte' && otp.c.includes(f.id));
  if (!fiches.length) throw refus();
  const parMobile = new Map();
  for (const f of fiches) parMobile.set(f.telephone, [...(parMobile.get(f.telephone) || []), f.id]);

  for (const tel of parMobile.keys()) {
    if (!await sec.sousLimite('code-tel', tel, 3, 15 * 60 * 1000)) {
      throw erreurClient('Trop de codes envoyés à ce numéro. Merci de patienter un quart d\'heure.', 429);
    }
  }

  const envois = [];
  const codesEssai = [];
  for (const [tel, ids] of parMobile) {
    const c = codeAleatoire();
    envois.push({ t: tel, c: ids, h: sec.hmac(`sms|${ticket}|${tel}|${c}`) });
    const envoi = await sms.envoyerSms(tel,
      `Grégoire TAGOT  |  notaire : votre code est ${c}, valable 10 minutes. Ne le communiquez à personne.`)
      .catch(async (e) => {
        console.error('[espace] SMS non envoyé :', e.message);
        await coffre.journaliser({ acteur: 'client', action: 'code-non-envoye-echec-sms', telephone: sec.masquerTelephone(tel), ip: sec.ipDe(req) });
        // L'adresse email est déjà prouvée : on peut dire que le SMS n'est pas parti.
        throw erreurClient('Le SMS n\'a pas pu être envoyé. Merci de réessayer dans quelques minutes ou de contacter l\'étude.', 502);
      });
    if (envoi.essai) codesEssai.push(c);
    await coffre.journaliser({ acteur: 'client', action: 'code-envoye', telephone: sec.masquerTelephone(tel), ip: sec.ipDe(req) });
  }

  await coffre.ecrireJson(chemin, { etape: 'sms', envois, e: Date.now() + DUREE_CODE, n: 0 });
  res.json({
    ok: true,
    // L'email étant prouvé, les deux derniers chiffres aident le client à savoir où regarder.
    mobiles: envois.map(x => `•• •• •• •• ${x.t.slice(-2)}`),
    ...(codesEssai.length ? { codesEssai } : {})
  });
}

/** Étape 3 — le code reçu par SMS ouvre la session. */
async function verifierCode(req, res) {
  const { ticket, code, chemin, otp } = await lireOtp(req, 'sms');
  const envoi = otp.envois.find(x => sec.egal(x.h, sec.hmac(`sms|${ticket}|${x.t}|${code}`)));
  if (!envoi) throw refus();
  await coffre.ecrireJson(chemin, { etape: 'utilise', e: 0, n: ESSAIS_MAX });

  const session = sec.signerJeton('espace', { c: envoi.c, t: envoi.t }, DUREE_SESSION);
  await coffre.journaliser({ acteur: 'client', action: 'connexion', telephone: sec.masquerTelephone(envoi.t), ip: sec.ipDe(req) });
  res.json({ ok: true, session, expireDans: DUREE_SESSION });
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/**
 * Les fiches sont relues à chaque action : si le notaire retire sa validation
 * ou si le numéro change, la session tombe aussitôt.
 */
async function ouvrirSession(req) {
  const s = sec.lireJeton('espace', req.body.session);
  if (!s) throw erreurClient('Session expirée. Merci de vous identifier à nouveau.', 401);
  const fiches = (await annuaire.fichesOuvertesPourTelephone(s.t)).filter(f => s.c.includes(f.id));
  if (!fiches.length) throw erreurClient('Session expirée. Merci de vous identifier à nouveau.', 401);
  return { tel: s.t, fiches };
}

function personneChoisie(session, indice) {
  const f = session.fiches[Number(indice)];
  if (!f) throw erreurClient('Personne inconnue');
  return f;
}

const nomDe = (f) => `${f.nom} ${f.prenom}`.trim();

/** Demandes du notaire en attente : origine des fonds (par défaut) ou RIB. */
async function demandesEnAttente(ids, nature = 'origine') {
  return (await coffre.listerJson('demandes/'))
    .filter(d => d.statut === 'en-attente' && ids.includes(d.contactId) && (d.nature || 'origine') === nature);
}

async function etat(req, res) {
  const session = await ouvrirSession(req);
  const ids = session.fiches.map(f => f.id);
  const [rib, demandes, demandesRib, ribCommunique] = await Promise.all([
    ribEtudeInfo(), demandesEnAttente(ids), demandesEnAttente(ids, 'rib'), demandesEnAttente(ids, 'rib-etude')
  ]);
  res.json({
    ok: true,
    personnes: session.fiches.map((f, i) => ({ indice: i, nom: f.nom, prenom: f.prenom })),
    ribEtudeDisponible: !!rib.courant,
    demandes: demandes.map(d => ({
      id: d.id, personne: ids.indexOf(d.contactId), motif: MOTIFS[d.motif] || d.motif,
      montant: d.montant, justificatifs: !!d.justificatifs, creeLe: d.creeLe
    })),
    // Personnes dont l'étude attend le RIB.
    ribDemande: [...new Set(demandesRib.map(d => ids.indexOf(d.contactId)))],
    ribEtudeCommunique: ribCommunique.length > 0,
    sources: SOURCES
  });
}

/* ------------------------------------------------------------------ */
/* RIB de l'étude                                                      */
/* ------------------------------------------------------------------ */

async function ribEtude(req, res) {
  const session = await ouvrirSession(req);
  if (!await sec.sousLimite('rib-etude', session.tel, 10, 60 * 60 * 1000)) {
    throw erreurClient('Trop de consultations. Merci de patienter.', 429);
  }
  const rib = await ribEtudeContenu();
  if (!rib) throw erreurClient('Le RIB de l\'étude n\'est pas encore disponible en ligne. Merci de contacter l\'étude.', 404);

  // Chaque exemplaire remis est marqué : filigrane, bénéficiaire, date et
  // référence. Sans marquage possible, rien n'est remis.
  const reference = nouvelleReference();
  const beneficiaire = session.fiches.map(f => `${f.prenom} ${f.nom}`.trim()).join(' et ');
  // Si le notaire a communiqué son RIB, l'exemplaire porte la référence de sa demande.
  const communications = await demandesEnAttente(session.fiches.map(f => f.id), 'rib-etude');
  const demande = communications.map(d => d.reference).filter(Boolean).join(', ') || undefined;
  const pdf = await filigraner(rib, { beneficiaire, reference, demande });

  await coffre.journaliser({
    acteur: 'client', action: 'rib-etude-consulte',
    nom: session.fiches.map(nomDe).join(' / '), reference, ...(demande ? { demande } : {}),
    telephone: sec.masquerTelephone(session.tel), ip: sec.ipDe(req), rib: rib.id
  });
  // Le RIB communiqué par le notaire est désormais consulté.
  for (const d of communications) {
    await coffre.ecrireJson(`demandes/${d.id}.json`, { ...d, statut: 'repondue', exemplaire: reference, reponduLe: new Date().toISOString() });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="RIB-office-TAGOT-${reference}.pdf"`);
  res.status(200).send(pdf);
}

/* ------------------------------------------------------------------ */
/* Dépôts                                                              */
/* ------------------------------------------------------------------ */

async function depotOuvrir(req, res) {
  const session = await ouvrirSession(req);
  const f = personneChoisie(session, req.body.personne);
  if (!await sec.sousLimite('depot', session.tel, 10, 60 * 60 * 1000)) {
    throw erreurClient('Trop de dépôts. Merci de patienter.', 429);
  }

  const depot = {
    id: coffre.identifiant(), statut: 'ouvert', nature: req.body.nature,
    contactId: f.id, nomClient: nomDe(f), telephone: session.tel,
    ouvertLe: new Date().toISOString(), pieces: []
  };

  if (depot.nature === 'rib') {
    depot.titulaire = String(req.body.titulaire || '').trim().slice(0, 120);
    if (!depot.titulaire) throw erreurClient('Indiquez le titulaire du compte');
    if (req.body.iban) {
      depot.iban = sec.ibanValide(req.body.iban);
      if (!depot.iban) throw erreurClient('IBAN invalide : vérifiez la saisie');
    }
  } else if (depot.nature === 'origine') {
    const demande = (await demandesEnAttente([f.id])).find(d => d.id === req.body.demande);
    if (!demande) throw erreurClient('Demande introuvable ou déjà traitée');
    if (req.body.atteste !== true) throw erreurClient('L\'attestation sur l\'honneur est requise');
    const sources = (Array.isArray(req.body.sources) ? req.body.sources : []).slice(0, 12).map(s => ({
      type: s.type, montant: Math.round(Number(s.montant) * 100) / 100,
      precision: String(s.precision || '').trim().slice(0, 300)
    }));
    if (!sources.length || sources.some(s => !SOURCES[s.type] || !(s.montant > 0))) {
      throw erreurClient('Indiquez au moins une origine, avec son montant');
    }
    const total = sources.reduce((a, s) => a + s.montant, 0);
    if (total + 0.005 < demande.montant) {
      throw erreurClient(`Le total déclaré (${euros(total)}) est inférieur au montant à justifier (${euros(demande.montant)})`);
    }
    Object.assign(depot, { demandeId: demande.id, sources, total, justificatifsAttendus: !!demande.justificatifs });
  } else {
    throw erreurClient('Nature de dépôt inconnue');
  }

  await coffre.ecrireJson(`depots/${depot.id}.json`, depot);
  res.json({ ok: true, depot: depot.id });
}

async function depotDuClient(req, session) {
  const id = String(req.body.depot || '');
  if (!/^[0-9a-f]{24}$/.test(id)) throw erreurClient('Dépôt inconnu');
  const depot = await coffre.lireJson(`depots/${id}.json`);
  if (!depot || depot.statut !== 'ouvert' || !session.fiches.some(f => f.id === depot.contactId)) {
    throw erreurClient('Dépôt inconnu ou déjà clos');
  }
  return depot;
}

async function depotPiece(req, res) {
  const session = await ouvrirSession(req);
  const depot = await depotDuClient(req, session);
  if (depot.pieces.length >= PIECES_MAX) throw erreurClient(`${PIECES_MAX} pièces au maximum par dépôt`);

  const { buf, type, nom } = sec.fichierRecu(req.body.fichier);
  const id = coffre.identifiant();
  await coffre.ecrire(`pieces/${depot.id}/${id}.bin`, buf);
  depot.pieces.push({
    id, nom, type, taille: buf.length,
    empreinte: crypto.createHash('sha256').update(buf).digest('hex')
  });
  await coffre.ecrireJson(`depots/${depot.id}.json`, depot);
  res.json({ ok: true, pieces: depot.pieces.length });
}

async function depotClore(req, res) {
  const session = await ouvrirSession(req);
  const depot = await depotDuClient(req, session);
  const pieceRequise = depot.nature === 'rib' || depot.justificatifsAttendus;
  if (pieceRequise && !depot.pieces.length) throw erreurClient('Joignez au moins une pièce avant de valider');

  depot.statut = 'clos';
  depot.closLe = new Date().toISOString();
  await coffre.ecrireJson(`depots/${depot.id}.json`, depot);

  // Demandes auxquelles ce dépôt répond : celle d'origine des fonds visée,
  // ou toutes les demandes de RIB en attente pour cette personne.
  const repondues = depot.demandeId
    ? [await coffre.lireJson(`demandes/${depot.demandeId}.json`)]
    : depot.nature === 'rib' ? await demandesEnAttente([depot.contactId], 'rib') : [];
  for (const demande of repondues.filter(Boolean)) {
    await coffre.ecrireJson(`demandes/${demande.id}.json`, { ...demande, statut: 'repondue', depotId: depot.id, reponduLe: depot.closLe });
  }
  // Le dépôt garde la référence des demandes auxquelles il répond : elle
  // figurera dans le filigrane des pièces et au journal.
  depot.demandes = repondues.filter(d => d && d.reference).map(d => d.reference);
  if (depot.demandes.length) await coffre.ecrireJson(`depots/${depot.id}.json`, depot);

  const objet = depot.nature === 'rib' ? 'RIB déposé' : 'Origine des fonds justifiée';
  await coffre.journaliser({
    acteur: 'client', action: depot.nature === 'rib' ? 'rib-client-depose' : 'origine-fonds-deposee',
    nom: depot.nomClient, telephone: sec.masquerTelephone(depot.telephone),
    ip: sec.ipDe(req), depot: depot.id, pieces: depot.pieces.length,
    ...(depot.demandes.length ? { demande: depot.demandes.join(', ') } : {})
  });
  await avisAuNotaire(req, `Espace client — ${objet} par ${depot.nomClient}`, objet, [
    `${depot.nomClient} vient de déposer ${depot.pieces.length} pièce(s) dans l'espace client.`,
    depot.nature === 'origine' ? `Total déclaré : ${euros(depot.total)}.` : `Titulaire indiqué : ${depot.titulaire}.`
  ]);
  res.json({ ok: true });
}

/* ------------------------------------------------------------------ */

const ACTIONS = {
  'demander-code': demanderCode, 'verifier-email': verifierEmail, 'verifier-code': verifierCode, etat,
  'rib-etude': ribEtude, 'depot-ouvrir': depotOuvrir,
  'depot-piece': depotPiece, 'depot-clore': depotClore
};

const clients = enveloppe(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  req.body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = ACTIONS[req.body.action];
  if (!action) throw erreurClient('Action inconnue');
  await action(req, res);
});

// Le portail du notaire partage cette fonction (limite de 12 fonctions par
// déploiement) : /api/espace?zone=portail. Ses contrôles d'accès sont les siens.
module.exports = (req, res) => {
  const zone = (req.query && req.query.zone) || new URL(req.url, 'http://x').searchParams.get('zone');
  return zone === 'portail' ? require('./_portail')(req, res) : clients(req, res);
};
