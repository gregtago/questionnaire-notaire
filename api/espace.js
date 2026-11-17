/**
 * espace.js — Espace client : RIB de l'étude, dépôt du RIB du client,
 * justification de l'origine des fonds.
 *
 * Un seul point d'entrée (POST /api/espace, champ « action ») pour ne pas
 * multiplier les fonctions Vercel. Le portail du notaire (_portail.js) passe
 * par la même fonction, avec ?zone=portail.
 *
 * Parcours :
 *   demander-code  → le client donne son mobile ; s'il correspond à une fiche
 *                    validée par le notaire, un code part par SMS
 *   verifier-code  → ouvre une session de 20 minutes
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
const {
  MOTIFS, SOURCES, erreurClient, ribEtudeInfo, ribEtudeContenu,
  avisAuNotaire, enveloppe, euros
} = require('./_metier');

const DUREE_CODE = 10 * 60 * 1000;
const DUREE_SESSION = 20 * 60 * 1000;
const ESSAIS_MAX = 5;
const PIECES_MAX = 10;

const attendre = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Code par SMS                                                        */
/* ------------------------------------------------------------------ */

async function demanderCode(req, res) {
  const debut = Date.now();
  const tel = sec.telephoneE164(req.body.telephone);
  if (!tel) throw erreurClient('Numéro de téléphone invalide');

  const ip = sec.ipDe(req);
  const permis =
    await sec.sousLimite('code-ip', ip, 10, 60 * 60 * 1000) &&
    await sec.sousLimite('code-tel', tel, 3, 15 * 60 * 1000) &&
    await sec.sousLimite('code-tel-jour', tel, 8, 24 * 60 * 60 * 1000);
  if (!permis) throw erreurClient('Trop de demandes. Merci de patienter avant de réessayer.', 429);

  // Le ticket est rendu dans tous les cas : il ne révèle rien.
  const ticket = coffre.identifiant(16);
  const reponse = { ok: true, ticket };

  const fiches = await annuaire.fichesOuvertesPourTelephone(tel);
  if (fiches.length) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await coffre.ecrireJson(`otp/${ticket}.json`, {
      h: sec.hmac(`code|${ticket}|${code}`),
      c: fiches.map(f => f.id), t: tel, e: Date.now() + DUREE_CODE, n: 0
    });
    // Un SMS qui ne part pas ne doit pas changer la réponse : elle dirait
    // sinon que le numéro est connu. L'échec se lit dans les logs et le journal.
    let action = 'code-envoye';
    try {
      const envoi = await sms.envoyerSms(tel,
        `Grégoire TAGOT notaire : votre code est ${code}, valable 10 minutes. Ne le communiquez à personne.`);
      if (envoi.essai) reponse.codeEssai = code; // hors production uniquement
    } catch (e) {
      console.error('[espace] SMS non envoyé :', e.message);
      action = 'code-non-envoye-echec-sms';
    }
    await coffre.journaliser({ acteur: 'client', action, telephone: sec.masquerTelephone(tel), ip });
  } else {
    await coffre.journaliser({ acteur: 'inconnu', action: 'code-refuse-numero-non-valide', telephone: sec.masquerTelephone(tel), ip });
  }

  // Durée plancher : la réponse ne doit pas être plus rapide pour un numéro inconnu.
  await attendre(Math.max(0, 1500 - (Date.now() - debut)));
  res.json(reponse);
}

async function verifierCode(req, res) {
  const refus = () => erreurClient('Code incorrect ou expiré');
  const ticket = String(req.body.ticket || '');
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!/^[0-9a-f]{32}$/.test(ticket) || !/^\d{6}$/.test(code)) throw refus();

  if (!await sec.sousLimite('verif-ip', sec.ipDe(req), 30, 60 * 60 * 1000)) {
    throw erreurClient('Trop d\'essais. Merci de patienter avant de réessayer.', 429);
  }

  const chemin = `otp/${ticket}.json`;
  const otp = await coffre.lireJson(chemin);
  if (!otp || otp.utilise || Date.now() > otp.e || otp.n >= ESSAIS_MAX) throw refus();

  // L'essai est compté AVANT la comparaison : cinq essais, pas un de plus.
  otp.n += 1;
  const bon = sec.egal(otp.h, sec.hmac(`code|${ticket}|${code}`));
  if (bon) otp.utilise = true;
  await coffre.ecrireJson(chemin, otp);
  if (!bon) throw refus();

  const session = sec.signerJeton('espace', { c: otp.c, t: otp.t }, DUREE_SESSION);
  await coffre.journaliser({ acteur: 'client', action: 'connexion', telephone: sec.masquerTelephone(otp.t), ip: sec.ipDe(req) });
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

async function demandesEnAttente(ids) {
  return (await coffre.listerJson('demandes/'))
    .filter(d => d.statut === 'en-attente' && ids.includes(d.contactId));
}

async function etat(req, res) {
  const session = await ouvrirSession(req);
  const ids = session.fiches.map(f => f.id);
  const [rib, demandes] = await Promise.all([ribEtudeInfo(), demandesEnAttente(ids)]);
  res.json({
    ok: true,
    personnes: session.fiches.map((f, i) => ({ indice: i, nom: f.nom, prenom: f.prenom })),
    ribEtudeDisponible: !!rib.courant,
    demandes: demandes.map(d => ({
      id: d.id, personne: ids.indexOf(d.contactId), motif: MOTIFS[d.motif] || d.motif,
      montant: d.montant, justificatifs: !!d.justificatifs, creeLe: d.creeLe
    })),
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

  await coffre.journaliser({
    acteur: 'client', action: 'rib-etude-consulte',
    nom: session.fiches.map(nomDe).join(' / '),
    telephone: sec.masquerTelephone(session.tel), ip: sec.ipDe(req), rib: rib.id
  });
  res.setHeader('Content-Type', rib.type);
  res.setHeader('Content-Disposition', 'inline; filename="RIB-etude-TAGOT' + (rib.type === 'application/pdf' ? '.pdf' : '') + '"');
  res.status(200).send(rib.buf);
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

  if (depot.demandeId) {
    const chemin = `demandes/${depot.demandeId}.json`;
    const demande = await coffre.lireJson(chemin);
    if (demande) {
      await coffre.ecrireJson(chemin, { ...demande, statut: 'repondue', depotId: depot.id, reponduLe: depot.closLe });
    }
  }

  const objet = depot.nature === 'rib' ? 'RIB déposé' : 'Origine des fonds justifiée';
  await coffre.journaliser({
    acteur: 'client', action: depot.nature === 'rib' ? 'rib-client-depose' : 'origine-fonds-deposee',
    nom: depot.nomClient, telephone: sec.masquerTelephone(depot.telephone),
    ip: sec.ipDe(req), depot: depot.id, pieces: depot.pieces.length
  });
  await avisAuNotaire(req, `Espace client — ${objet} par ${depot.nomClient}`, objet, [
    `${depot.nomClient} vient de déposer ${depot.pieces.length} pièce(s) dans l'espace client.`,
    depot.nature === 'origine' ? `Total déclaré : ${euros(depot.total)}.` : `Titulaire indiqué : ${depot.titulaire}.`
  ]);
  res.json({ ok: true });
}

/* ------------------------------------------------------------------ */

const ACTIONS = {
  'demander-code': demanderCode, 'verifier-code': verifierCode, etat,
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
