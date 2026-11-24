/**
 * Parcours complet de l'espace client et du portail, sur un coffre temporaire,
 * un carnet d'adresses fictif et sans envoi de SMS.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coffre-'));
Object.assign(process.env, {
  COFFRE_DIR: DIR,
  COFFRE_CLE: crypto.randomBytes(32).toString('hex'),
  OTP_SECRET: crypto.randomBytes(24).toString('hex'),
  PORTAIL_CODE: 'code-d-essai-portail',
  SMS_MODE: 'essai',
  ANNUAIRE_MODE: 'essai',
  PORT: '0'
});
delete process.env.SMTP_USER; // aucun email pendant les essais

const coffre = require('../api/_coffre');
const sec = require('../api/_securite');
const serveur = require('../scripts/dev.js');
const { PDFDocument } = require('pdf-lib');
const QRCode = require('qrcode');

let BASE, cookie = '';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% RIB fictif de l\'étude\n'), crypto.randomBytes(200)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300)]);
const IBAN = 'FR7630006000011234567890189';
let RIB_PDF, RIB_PNG; // RIB de l'étude : de vrais fichiers, car ils reçoivent le filigrane

const CONTACTS = [
  { id: 'c-diai', surname: 'DIAI', givenName: 'Samuel', mobilePhone: '+33612345678', emailAddresses: [{ address: 'samuel@example.org' }], categories: ['Coord-declarees', 'Vente'] },
  { id: 'c-vial-1', surname: 'VIAL', givenName: 'Anne', mobilePhone: '06 98 76 54 32', emailAddresses: [{ address: 'vial@example.org' }], categories: ['Coord-declarees'] },
  { id: 'c-vial-2', surname: 'VIAL', givenName: 'Marc', mobilePhone: '0698765432', emailAddresses: [{ address: 'vial@example.org' }], categories: ['Coord-declarees'] },
  { id: 'c-sans', surname: 'SANSTEL', givenName: 'Luc', mobilePhone: 'voir fixe', emailAddresses: [], categories: [] },
  { id: 'c-fixe', surname: 'FIXE', givenName: 'Paul', mobilePhone: '01 44 00 00 00', emailAddresses: [{ address: 'fixe@example.org' }], categories: [] },
  { id: 'c-sansmail', surname: 'SANSMAIL', givenName: 'Eve', mobilePhone: '0655555555', emailAddresses: [], categories: [] },
  // Un couple qui partage une adresse mais pas un téléphone.
  { id: 'c-duo-1', surname: 'DUO', givenName: 'Alice', mobilePhone: '0611111111', emailAddresses: [{ address: 'Duo@Example.org' }], categories: [] },
  { id: 'c-duo-2', surname: 'DUO', givenName: 'Bruno', mobilePhone: '0622222222', emailAddresses: [{ address: 'duo@example.org' }], categories: [] }
];

const oublierLimites = () => fs.rmSync(path.join(DIR, 'limites'), { recursive: true, force: true });

async function espace(action, corps = {}) {
  const r = await fetch(`${BASE}/api/espace`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...corps })
  });
  return { r, d: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}
async function portail(action, corps = {}, enTetes = { 'X-Portail': '1' }) {
  const r = await fetch(`${BASE}/api/espace?zone=portail`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie, ...enTetes }, body: JSON.stringify({ action, ...corps })
  });
  const pose = r.headers.get('set-cookie');
  if (pose) cookie = pose.split(';')[0];
  return { r, d: await r.json().catch(() => null) };
}
const b64 = (buf, nom) => ({ nom, contenu: buf.toString('base64') });

/** Identification complète : code par email, puis code par SMS (rang = mobile visé). */
async function connecterClient(email, rang = 0) {
  const a = await espace('demander-code', { email });
  assert.equal(a.r.status, 200);
  assert.match(a.d.codeEssai || '', /^\d{6}$/, 'un code email doit être émis pour une fiche validée');
  const b = await espace('verifier-email', { ticket: a.d.ticket, code: a.d.codeEssai });
  assert.equal(b.r.status, 200);
  const c = await espace('verifier-code', { ticket: a.d.ticket, code: b.d.codesEssai[rang] });
  assert.equal(c.r.status, 200);
  return c.d.session;
}
const autreCode = (c) => (c === '000000' ? '111111' : '000000');

test.before(async () => {
  await new Promise(ok => (serveur.listening ? ok() : serveur.once('listening', ok)));
  BASE = `http://127.0.0.1:${serveur.address().port}`;
  await coffre.ecrireJson('essai-annuaire/contacts.json', CONTACTS);
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText('RIB fictif de l\'office', { x: 50, y: 780, size: 14 });
  doc.addPage([595, 842]);
  RIB_PDF = Buffer.from(await doc.save());
  RIB_PNG = await QRCode.toBuffer('RIB fictif en image', { width: 300 });
});
test.after(() => { serveur.close(); fs.rmSync(DIR, { recursive: true, force: true }); });
test.beforeEach(oublierLimites);

/* ── Briques ── */

test('TOTP conforme aux vecteurs de la RFC 6238', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // « 12345678901234567890 »
  assert.equal(sec.totp(secret, 59 * 1000), '287082');
  assert.equal(sec.totp(secret, 1111111109 * 1000), '081804');
  assert.equal(sec.totp(secret, 1234567890 * 1000), '005924');
  assert.ok(sec.totpValide(secret, '287082', 59 * 1000));
  assert.ok(!sec.totpValide(secret, '287083', 59 * 1000));
});

test('téléphones, IBAN et types de fichiers', () => {
  assert.equal(sec.telephoneE164('06 12 34 56 78'), '+33612345678');
  assert.equal(sec.telephoneE164('+33 (0)6.12.34.56.78'), '+33612345678');
  assert.equal(sec.telephoneE164('0033612345678'), '+33612345678');
  assert.equal(sec.telephoneE164('voir fixe'), null);
  // Toutes les façons d'écrire un même mobile doivent se rejoindre : c'est ce
  // qui fait concorder la saisie du client avec la fiche du carnet.
  for (const ecrit of ['0612345678', '06 12 34 56 78', '06.12.34.56.78', '06-12-34-56-78', '06\u00a012\u00a034\u00a056\u00a078',
    ' 06 12 34 56 78 ', '+33612345678', '+33 6 12 34 56 78', '+33 (0)6 12 34 56 78', '+330612345678', '0033612345678',
    '00 33 6 12 34 56 78', '06_12_34_56_78']) {
    assert.equal(sec.telephoneE164(ecrit), '+33612345678', ecrit);
  }
  assert.equal(sec.telephoneE164('+44 7700 900123'), '+447700900123');
  assert.equal(sec.telephoneE164('06 12 34 56 78 ou 01 44 00 00 00'), null);
  assert.equal(sec.telephoneE164('061234567'), null);
  assert.ok(sec.estMobile('+33612345678') && sec.estMobile('+33712345678') && sec.estMobile('+447700900123'));
  assert.ok(!sec.estMobile('+33144000000'));
  assert.equal(sec.ibanValide('FR76 3000 6000 0112 3456 7890 189'), IBAN);
  assert.equal(sec.ibanValide('FR7630006000011234567890188'), null);
  assert.equal(sec.typeDeFichier(PDF), 'application/pdf');
  assert.equal(sec.typeDeFichier(Buffer.from('MZ\x90\x00 programme')), null);
});

test('le coffre chiffre : rien de lisible sur le disque, pièce déplacée illisible', async () => {
  await coffre.ecrire('essai/secret.bin', Buffer.from('IBAN FR76 TRES SECRET'));
  const brut = fs.readFileSync(path.join(DIR, 'essai/secret.bin'));
  assert.ok(!brut.includes('SECRET'));
  assert.equal((await coffre.lire('essai/secret.bin')).toString(), 'IBAN FR76 TRES SECRET');
  fs.copyFileSync(path.join(DIR, 'essai/secret.bin'), path.join(DIR, 'essai/ailleurs.bin'));
  await assert.rejects(coffre.lire('essai/ailleurs.bin'));
  await assert.rejects(coffre.lire('../etc/passwd'), /refusé/);
});

/* ── Portail ── */

let secretTotp;

test('portail : refus sans en-tête, sans code, puis enrôlement du téléphone', async () => {
  assert.equal((await portail('etat', {}, {})).r.status, 403);
  assert.deepEqual((await portail('etat')).d, { ok: true, enrole: false, connecte: false });
  assert.equal((await portail('tableau')).r.status, 401);
  assert.equal((await portail('enroler-debut', { code: 'mauvais' })).r.status, 401);

  const debut = await portail('enroler-debut', { code: process.env.PORTAIL_CODE });
  assert.equal(debut.r.status, 200);
  assert.match(debut.d.qr, /^data:image\/png;base64,/);
  secretTotp = debut.d.secret;

  assert.equal((await portail('enroler-fin', { code: process.env.PORTAIL_CODE, totp: '000000' })).r.status, 401);
  assert.equal((await portail('enroler-fin', { code: process.env.PORTAIL_CODE, totp: sec.totp(secretTotp) })).r.status, 200);
  assert.ok(cookie.startsWith('portail='));
  assert.equal((await portail('enroler-debut', { code: process.env.PORTAIL_CODE })).r.status, 400, 'pas de second enrôlement');
});

test('portail : connexion par code d\'accès et code à six chiffres', async () => {
  cookie = '';
  assert.equal((await portail('connexion', { code: process.env.PORTAIL_CODE, totp: '123456' })).r.status, 401);
  assert.equal((await portail('connexion', { code: 'faux-code-d-acces', totp: sec.totp(secretTotp) })).r.status, 401);
  assert.equal((await portail('connexion', { code: process.env.PORTAIL_CODE, totp: sec.totp(secretTotp) })).r.status, 200);
  const t = await portail('tableau');
  assert.equal(t.d.fiches.length, 8);
  assert.ok(t.d.fiches.every(f => f.etat === 'a-valider'));
});

test('portail : un jeton falsifié ne passe pas', async () => {
  const bon = cookie;
  cookie = 'portail=' + encodeURIComponent(Buffer.from(JSON.stringify({ u: 'portail', e: Date.now() + 1e9 })).toString('base64url') + '.' + 'a'.repeat(64));
  assert.equal((await portail('tableau')).r.status, 401);
  cookie = bon;
});

/* ── Espace client ── */

test('adresse inconnue ou fiche non validée : même réponse, aucun code', async () => {
  const inconnu = await espace('demander-code', { email: 'inconnu@example.org' });
  const nonValide = await espace('demander-code', { email: 'samuel@example.org' });
  for (const x of [inconnu, nonValide]) {
    assert.equal(x.r.status, 200);
    assert.deepEqual(Object.keys(x.d).sort(), ['ok', 'ticket']);
  }
  assert.equal((await espace('verifier-email', { ticket: inconnu.d.ticket, code: '123456' })).r.status, 400);
  assert.equal((await espace('verifier-code', { ticket: inconnu.d.ticket, code: '123456' })).r.status, 400);
  assert.equal((await espace('demander-code', { email: 'abc' })).r.status, 400);
});

test('validation des fiches, y compris refus d\'une fiche sans mobile', async () => {
  assert.equal((await portail('valider', { id: 'c-sans' })).r.status, 400);
  assert.match((await portail('valider', { id: 'c-fixe' })).d.error, /ligne fixe/);
  assert.match((await portail('valider', { id: 'c-sansmail' })).d.error, /adresse email/);
  for (const id of ['c-diai', 'c-vial-1', 'c-vial-2', 'c-duo-1', 'c-duo-2']) assert.equal((await portail('valider', { id })).r.status, 200);
  const t = await portail('tableau');
  assert.equal(t.d.fiches.filter(f => f.etat === 'ouverte').length, 5);
  const annuaire = await coffre.lireJson('essai-annuaire/contacts.json');
  assert.deepEqual(annuaire[0].categories, ['Vente', 'Coord-verifiees'], 'les autres catégories sont conservées');
  assert.equal(annuaire[0].mobilePhone, '+33612345678', 'la validation ne touche pas au numéro');
});

test('code email : cinq essais au plus, et le code SMS ne s\'obtient pas sans lui', async () => {
  const a = await espace('demander-code', { email: 'Samuel@Example.org ' });
  assert.equal((await espace('verifier-code', { ticket: a.d.ticket, code: a.d.codeEssai })).r.status, 400, 'pas de saut d\'étape');
  for (let i = 0; i < 5; i++) assert.equal((await espace('verifier-email', { ticket: a.d.ticket, code: autreCode(a.d.codeEssai) })).r.status, 400);
  assert.equal((await espace('verifier-email', { ticket: a.d.ticket, code: a.d.codeEssai })).r.status, 400, 'le bon code arrive trop tard');
});

test('code SMS : cinq essais au plus, usage unique, mobile masqué', async () => {
  const a = await espace('demander-code', { email: 'samuel@example.org' });
  const b = await espace('verifier-email', { ticket: a.d.ticket, code: a.d.codeEssai });
  assert.deepEqual(b.d.mobiles, ['•• •• •• •• 78']);
  assert.equal((await espace('verifier-email', { ticket: a.d.ticket, code: a.d.codeEssai })).r.status, 400, 'le code email ne sert qu\'une fois');
  const bon = b.d.codesEssai[0];
  for (let i = 0; i < 5; i++) assert.equal((await espace('verifier-code', { ticket: a.d.ticket, code: autreCode(bon) })).r.status, 400);
  assert.equal((await espace('verifier-code', { ticket: a.d.ticket, code: bon })).r.status, 400, 'le bon code arrive trop tard');

  oublierLimites();
  const c = await espace('demander-code', { email: 'samuel@example.org' });
  const d = await espace('verifier-email', { ticket: c.d.ticket, code: c.d.codeEssai });
  assert.equal((await espace('verifier-code', { ticket: c.d.ticket, code: d.d.codesEssai[0] })).r.status, 200);
  assert.equal((await espace('verifier-code', { ticket: c.d.ticket, code: d.d.codesEssai[0] })).r.status, 400, 'un code ne sert qu\'une fois');
});

test('pas plus de trois codes par quart d\'heure pour une même adresse ni pour un même mobile', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await espace('demander-code', { email: 'samuel@example.org' })).r.status, 200);
  assert.equal((await espace('demander-code', { email: 'SAMUEL@example.org' })).r.status, 429);

  // Même mobile atteint par une autre voie : la limite par numéro tient aussi.
  fs.rmSync(path.join(DIR, 'limites/code-email'), { recursive: true, force: true });
  let dernier;
  for (let i = 0; i < 3; i++) {
    const a = await espace('demander-code', { email: 'vial@example.org' });
    dernier = await espace('verifier-email', { ticket: a.d.ticket, code: a.d.codeEssai });
    if (i < 2) { assert.equal(dernier.r.status, 200); fs.rmSync(path.join(DIR, 'limites/code-email'), { recursive: true, force: true }); }
  }
  assert.equal(dernier.r.status, 200);
  fs.rmSync(path.join(DIR, 'limites/code-email'), { recursive: true, force: true });
  const a = await espace('demander-code', { email: 'vial@example.org' });
  assert.equal((await espace('verifier-email', { ticket: a.d.ticket, code: a.d.codeEssai })).r.status, 429);
});

test('une adresse partagée, deux mobiles : chacun son code, chacun sa fiche', async () => {
  const a = await espace('demander-code', { email: 'duo@example.org' });
  const b = await espace('verifier-email', { ticket: a.d.ticket, code: a.d.codeEssai });
  assert.deepEqual(b.d.mobiles, ['•• •• •• •• 11', '•• •• •• •• 22']);
  assert.equal(b.d.codesEssai.length, 2);
  const c = await espace('verifier-code', { ticket: a.d.ticket, code: b.d.codesEssai[1] });
  const e = await espace('etat', { session: c.d.session });
  assert.deepEqual(e.d.personnes.map(p => p.prenom), ['Bruno']);
  assert.equal((await espace('verifier-code', { ticket: a.d.ticket, code: b.d.codesEssai[0] })).r.status, 400, 'le ticket est consommé');
});

test('RIB de l\'étude : indisponible, puis déposé par le notaire et remis au client', async () => {
  const session = await connecterClient('samuel@example.org');
  assert.equal((await espace('etat', { session })).d.ribEtudeDisponible, false);
  assert.equal((await espace('rib-etude', { session })).r.status, 404);

  assert.equal((await portail('rib-deposer', { fichier: b64(Buffer.from('pas un RIB'), 'rib.pdf') })).r.status, 400);
  assert.match((await portail('rib-deposer', { fichier: b64(PDF, 'rib-abime.pdf') })).d.error, /filigrane/, 'un PDF illisible est refusé dès le dépôt');
  assert.equal((await portail('rib-deposer', { fichier: b64(RIB_PDF, 'RIB CLIENTS.pdf') })).r.status, 200);

  // L'exemplaire remis au client est un PDF marqué, pas le fichier d'origine.
  const r = await espace('rib-etude', { session });
  assert.equal(r.r.status, 200);
  assert.equal(r.r.headers.get('content-type'), 'application/pdf');
  const remis = Buffer.from(await r.r.arrayBuffer());
  assert.ok(!remis.equals(RIB_PDF) && remis.length > RIB_PDF.length);
  const lu = await PDFDocument.load(remis);
  assert.equal(lu.getPageCount(), 2, 'toutes les pages sont conservées');
  const reference = /RIB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/.exec(lu.getTitle())[0];
  assert.match(lu.getSubject(), /Samuel DIAI/);
  assert.ok(r.r.headers.get('content-disposition').includes(reference));

  // La référence est au journal ; un second exemplaire en porte une autre.
  const j1 = (await portail('journal')).d.lignes.filter(l => l.action === 'rib-etude-consulte');
  assert.equal(j1[0].reference, reference);
  const r2 = await PDFDocument.load(Buffer.from(await (await espace('rib-etude', { session })).r.arrayBuffer()));
  assert.notEqual(r2.getTitle(), lu.getTitle());

  // Le notaire, lui, retrouve le fichier d'origine, intact.
  const origine = await fetch(`${BASE}/api/espace?zone=portail&action=rib-etude`, { headers: { cookie } });
  assert.ok(Buffer.from(await origine.arrayBuffer()).equals(RIB_PDF));

  assert.equal((await espace('rib-etude', { session: 'x.y' })).r.status, 401);
  assert.equal((await espace('rib-etude', {})).r.status, 401);

  // Nouveau dépôt, en image : l'ancien est conservé, et l'image est remise en PDF marqué.
  await portail('rib-deposer', { fichier: b64(RIB_PNG, 'rib-2.png') });
  const t = await portail('tableau');
  assert.equal(t.d.rib.courant.nom, 'rib-2.png');
  assert.equal(t.d.rib.anciens.length, 1);
  const r3 = await espace('rib-etude', { session });
  assert.equal(r3.r.headers.get('content-type'), 'application/pdf');
  assert.equal((await PDFDocument.load(Buffer.from(await r3.r.arrayBuffer()))).getPageCount(), 1);
});

let depotRib;

test('dépôt du RIB du client : contrôles, puis réception par le notaire', async () => {
  const session = await connecterClient('samuel@example.org');
  assert.equal((await espace('depot-ouvrir', { session, nature: 'rib', personne: 0, titulaire: 'Samuel DIAI', iban: 'FR7630006000011234567890188' })).r.status, 400);
  assert.equal((await espace('depot-ouvrir', { session, nature: 'rib', personne: 3, titulaire: 'X' })).r.status, 400);

  const o = await espace('depot-ouvrir', { session, nature: 'rib', personne: 0, titulaire: 'Samuel DIAI', iban: 'FR76 3000 6000 0112 3456 7890 189' });
  assert.equal(o.r.status, 200);
  depotRib = o.d.depot;
  assert.equal((await espace('depot-clore', { session, depot: depotRib })).r.status, 400, 'pas de clôture sans pièce');
  assert.equal((await espace('depot-piece', { session, depot: depotRib, fichier: b64(Buffer.from('MZ programme'), 'rib.pdf') })).r.status, 400);
  assert.equal((await espace('depot-piece', { session, depot: depotRib, fichier: b64(RIB_PNG, '../../rib mon compte.png') })).r.status, 200);
  assert.equal((await espace('depot-clore', { session, depot: depotRib })).r.status, 200);
  assert.equal((await espace('depot-piece', { session, depot: depotRib, fichier: b64(PNG, 'encore.png') })).r.status, 400, 'dépôt clos');

  const t = await portail('tableau');
  const d = t.d.depots.find(x => x.id === depotRib);
  assert.equal(d.nomClient, 'DIAI Samuel');
  assert.equal(d.iban, IBAN);
  assert.equal(d.pieces[0].nom, '.._.._rib mon compte.png');
  assert.ok(!d.telephone.includes('123456'), 'téléphone masqué');

  const url = `${BASE}/api/espace?zone=portail&action=piece&depot=${d.id}&piece=${d.pieces[0].id}`;
  assert.equal((await fetch(url)).status, 401, 'sans session du notaire, aucune pièce');
  const piece = await fetch(url, { headers: { cookie } });
  assert.equal(piece.status, 200);
  // Le notaire consulte une copie filigranée, en PDF ; l'original reste au coffre.
  assert.equal(piece.headers.get('content-type'), 'application/pdf');
  assert.match(piece.headers.get('content-disposition'), /rib%20mon%20compte\.pdf/);
  const marquee = await PDFDocument.load(Buffer.from(await piece.arrayBuffer()));
  assert.match(marquee.getSubject(), /DIAI Samuel/);
  assert.ok(coffre.lire && (await coffre.lire(`pieces/${d.id}/${d.pieces[0].id}.bin`)).equals(RIB_PNG));

  // Sur le disque, la pièce est chiffrée.
  assert.ok(!fs.readFileSync(path.join(DIR, `pieces/${d.id}/${d.pieces[0].id}.bin`)).subarray(0, 8).equals(RIB_PNG.subarray(0, 8)));
  assert.ok(!fs.readFileSync(path.join(DIR, `depots/${d.id}.json`)).includes('FR76'));
});

/** Emails interceptés : aucun ne part réellement. */
const nodemailer = require('nodemailer');
let emails = [];
async function avecEmails(fn) {
  const origine = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async (m) => { emails.push(m); } });
  process.env.SMTP_USER = 'office@example.org';
  emails = [];
  try { return await fn(); } finally { nodemailer.createTransport = origine; delete process.env.SMTP_USER; }
}

test('demande de RIB : email au client, dépôt après double vérification, demande close', async () => {
  // Sans email possible, le notaire est averti (et la demande reste enregistrée).
  assert.equal((await portail('demande-rib', { contactId: 'c-diai' })).r.status, 502);

  let ref;
  await avecEmails(async () => {
    assert.equal((await portail('demande-rib', { contactId: 'c-sans' })).r.status, 400, 'fiche non validée');
    const a = await portail('demande-rib', { contactId: 'c-diai' });
    assert.equal(a.r.status, 200);
    assert.equal(a.d.dejaEnCours, true, 'pas de doublon de demande');
    ref = a.d.demande;
    assert.match(ref, /^DEM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(emails.length, 1);
    assert.ok(emails[0].html.includes(ref), 'la référence de la demande figure dans l\'email');
    assert.equal(emails[0].to, 'samuel@example.org');
    assert.ok(!emails[0].attachments, 'aucune pièce jointe');
    assert.ok(!/href=/.test(emails[0].html), 'aucun lien');
    assert.match(emails[0].html, /\/espace/);
  });

  const session = await connecterClient('samuel@example.org');
  const e = await espace('etat', { session });
  assert.deepEqual(e.d.ribDemande, [0]);
  assert.equal(e.d.demandes.length, 0, 'une demande de RIB n\'est pas une demande d\'origine des fonds');
  let t = await portail('tableau');
  assert.equal(t.d.demandes.filter(d => d.nature === 'rib').length, 1);

  const o = await espace('depot-ouvrir', { session, nature: 'rib', personne: 0, titulaire: 'Samuel DIAI' });
  await espace('depot-piece', { session, depot: o.d.depot, fichier: b64(RIB_PNG, 'rib.png') });
  assert.equal((await espace('depot-clore', { session, depot: o.d.depot })).r.status, 200);
  assert.deepEqual((await espace('etat', { session })).d.ribDemande, []);
  t = await portail('tableau');
  const d = t.d.demandes.find(x => x.nature === 'rib');
  assert.equal(d.statut, 'repondue');
  assert.equal(d.depotId, o.d.depot);
  assert.equal(d.reference, ref);

  // Le RIB reçu porte, dans son filigrane, la référence de la demande, comme le journal.
  const depot = t.d.depots.find(x => x.id === o.d.depot);
  assert.deepEqual(depot.demandes, [ref]);
  const piece = await fetch(`${BASE}/api/espace?zone=portail&action=piece&depot=${depot.id}&piece=${depot.pieces[0].id}`, { headers: { cookie } });
  assert.ok((await PDFDocument.load(Buffer.from(await piece.arrayBuffer()))).getSubject().includes(ref));
  const j = (await portail('journal')).d.lignes;
  for (const action of ['demande-rib', 'rib-client-depose', 'piece-consultee']) {
    assert.ok(j.some(l => l.action === action && l.demande === ref), `journal : ${action} porte ${ref}`);
  }
});

test('RIB de l\'étude communiqué : email sans pièce jointe, remis dans l\'espace après double vérification', async () => {
  let ref;
  await avecEmails(async () => {
    assert.equal((await portail('rib-communiquer', { contactId: 'c-sans' })).r.status, 400);
    const a = await portail('rib-communiquer', { contactId: 'c-diai' });
    assert.equal(a.r.status, 200);
    ref = a.d.demande;
    assert.equal(emails.length, 1);
    assert.ok(!emails[0].attachments, 'le RIB ne part pas par email');
    assert.ok(!/href=/.test(emails[0].html));
  });

  const session = await connecterClient('samuel@example.org');
  assert.equal((await espace('etat', { session })).d.ribEtudeCommunique, true);
  let t = await portail('tableau');
  assert.equal(t.d.demandes.find(d => d.nature === 'rib-etude').statut, 'en-attente');

  const r = await espace('rib-etude', { session });
  assert.equal(r.r.status, 200);
  const reference = /RIB-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(r.r.headers.get('content-disposition'))[0];
  const remis = await PDFDocument.load(Buffer.from(await r.r.arrayBuffer()));
  assert.ok(remis.getSubject().includes(ref), 'le RIB remis porte la référence de la demande');
  assert.equal((await espace('etat', { session })).d.ribEtudeCommunique, false);
  t = await portail('tableau');
  const d = t.d.demandes.find(x => x.nature === 'rib-etude');
  assert.equal(d.statut, 'repondue');
  assert.equal(d.reference, ref);
  assert.equal(d.exemplaire, reference, 'le portail montre quel exemplaire a été remis');
  const j = (await portail('journal')).d.lignes;
  assert.ok(j.some(l => l.action === 'rib-etude-communique' && l.demande === ref && l.destinataire === 'samuel@example.org'));
  assert.ok(j.some(l => l.action === 'rib-etude-consulte' && l.demande === ref && l.reference === reference));
});

test('rester identifié 24 heures : session longue, mais RIB déposé seulement après une identification récente', async () => {
  const a = await espace('demander-code', { email: 'samuel@example.org' });
  const b = await espace('verifier-email', { ticket: a.d.ticket, code: a.d.codeEssai });
  const c = await espace('verifier-code', { ticket: a.d.ticket, code: b.d.codesEssai[0], rester: true });
  assert.equal(c.d.expireDans, 24 * 60 * 60 * 1000);
  assert.equal((await espace('etat', { session: c.d.session })).r.status, 200);
  assert.equal((await espace('depot-ouvrir', { session: c.d.session, nature: 'rib', personne: 0, titulaire: 'Samuel DIAI' })).r.status, 200, 'identification récente');
  // La même session, le lendemain : elle ouvre l'espace, pas le dépôt d'un RIB.
  const veille = sec.signerJeton('espace', { c: ['c-diai'], t: '+33612345678', d: Date.now() - 3 * 60 * 60 * 1000, l: 1 }, 60 * 1000);
  assert.equal((await espace('etat', { session: veille })).r.status, 200);
  const refus = await espace('depot-ouvrir', { session: veille, nature: 'rib', personne: 0, titulaire: 'Samuel DIAI' });
  assert.equal(refus.r.status, 401);
  assert.match(refus.d.error, /identification de moins de 20 minutes/);
  // Sans la case, la session reste de 20 minutes.
  assert.equal(sec.lireJeton('espace', await connecterClient('samuel@example.org')).l, undefined);
});

test('un client ne peut pas agir sur le dépôt d\'un autre', async () => {
  const autre = await connecterClient('vial@example.org');
  const mien = await connecterClient('samuel@example.org');
  const o = await espace('depot-ouvrir', { session: mien, nature: 'rib', personne: 0, titulaire: 'Samuel DIAI' });
  assert.equal((await espace('depot-piece', { session: autre, depot: o.d.depot, fichier: b64(PNG, 'x.png') })).r.status, 400);
});

test('origine des fonds : demande du notaire, déclaration et justificatifs du client', async () => {
  assert.equal((await portail('demande-creer', { contactId: 'c-sans', motif: 'achat_immobilier', montant: 1000 })).r.status, 400);
  assert.equal((await portail('demande-creer', { contactId: 'c-vial-2', motif: 'inconnu', montant: 1000 })).r.status, 400);
  assert.equal((await portail('demande-creer', { contactId: 'c-vial-2', motif: 'achat_immobilier', montant: 0 })).r.status, 400);
  assert.equal((await portail('demande-creer', { contactId: 'c-vial-2', motif: 'achat_immobilier', montant: 250000, justificatifs: true })).r.status, 200);

  // Le couple partage un mobile : deux personnes dans la session, la demande vise Marc.
  const session = await connecterClient('vial@example.org');
  const e = await espace('etat', { session });
  assert.equal(e.d.personnes.length, 2);
  assert.equal(e.d.demandes.length, 1);
  const demande = e.d.demandes[0];
  assert.equal(e.d.personnes[demande.personne].prenom, 'Marc');
  assert.equal(demande.motif, 'Achat immobilier');

  assert.match(demande.reference, /^DEM-/);

  // L'ancien dépôt sans signature n'existe plus.
  assert.equal((await espace('depot-ouvrir', { session, nature: 'origine', personne: demande.personne, demande: demande.id })).r.status, 400);

  // Ouverture : le questionnaire, le montant attendu, l'identité reprise de la fiche.
  const o = await espace('declaration-ouvrir', { session, demande: demande.id });
  assert.equal(o.r.status, 200);
  assert.equal(o.d.montant, 250000);
  assert.equal(o.d.signataire, 'Marc VIAL');
  assert.equal(o.d.saisie.identite.prenoms, 'Marc');
  assert.ok(o.d.rubriques.some(r => r.titre === 'V. Origine des fonds'));
  const depot = o.d.depot;
  const samuel = await connecterClient('samuel@example.org');
  assert.equal((await espace('declaration-enregistrer', { session: samuel, depot, saisie: {} })).r.status, 400, 'la déclaration d\'un autre');

  // Saisie partielle, enregistrée ; la session est prolongée.
  const saisie = o.d.saisie;
  Object.assign(saisie.identite, { qualite: 'ACQ', dateNaissance: '1980-05-17', lieuNaissance: 'Lyon', adresseVoie: '12 rue Dante', codePostal: '75005', ville: 'Paris', intrus: 'x' });
  const e1 = await espace('declaration-enregistrer', { session, depot, saisie });
  assert.equal(e1.r.status, 200);
  assert.ok(e1.d.session && e1.d.session !== session, 'session prolongée');
  await espace('depot-piece', { session, depot, fichier: b64(PDF, 'offre de prêt.pdf') });

  // Le lendemain, sur un autre appareil : nouvelle identification, tout est là.
  oublierLimites();
  const retour = await connecterClient('vial@example.org');
  const etat2 = await espace('etat', { session: retour });
  assert.ok(etat2.d.demandes[0].commenceeLe);
  assert.equal(etat2.d.demandes[0].pieces, 1);
  const o2 = await espace('declaration-ouvrir', { session: retour, demande: demande.id });
  assert.equal(o2.d.depot, depot, 'le même brouillon');
  assert.equal(o2.d.saisie.identite.lieuNaissance, 'Lyon');
  assert.equal(o2.d.saisie.identite.intrus, undefined, 'un champ inconnu n\'est pas gardé');
  assert.deepEqual(o2.d.pieces.map(p => p.nom), ['offre de prêt.pdf']);
  assert.equal(o2.d.pieces[0].empreinte, undefined, 'le client ne revoit que le nom de ses pièces');
  let t = await portail('tableau');
  assert.equal(t.d.demandes.find(d => d.id === demande.id).enCours.pieces, 1, 'le notaire voit l\'avancement');

  // Incomplète : la liste de ce qui manque.
  const r1 = await espace('declaration-recapitulatif', { session: retour, depot, saisie: o2.d.saisie });
  assert.equal(r1.r.status, 400);
  assert.ok(r1.d.manques.some(m => /PPE/.test(m)) && r1.d.manques.some(m => /au moins une origine/.test(m)));

  const complete = o2.d.saisie;
  Object.assign(complete.identite, { nationalite: 'Française' });
  Object.assign(complete.ppe, { self: 'N', famille: 'N', collaborateur: 'N', selfFonction: 'ne doit pas rester' });
  Object.assign(complete.operation, { nature: 'acquisition', description: 'Appartement, 12 rue Dante, Paris 5e', prix: 400000 });
  Object.assign(complete.personneMorale, { existe: 'N' });
  Object.assign(complete.contexte, { objet: 'residence_principale', coherence: 'O', pourTiers: 'N', fondsEtranger: 'N' });
  complete.fonds.sources = [{ type: 'pret', montant: 200000, precision: 'Banque X' }];
  const r2 = await espace('declaration-recapitulatif', { session: retour, depot, saisie: complete });
  assert.ok(r2.d.manques.some(m => /inférieur au montant à justifier/.test(m)), 'le montant attendu s\'impose');
  complete.fonds.sources.push({ type: 'epargne', montant: 50000 }, { type: 'inconnue', montant: 9 });
  const r3 = await espace('declaration-recapitulatif', { session: retour, depot, saisie: complete });
  assert.equal(r3.r.status, 200);
  assert.equal(r3.d.signataire, 'Marc VIAL');
  const fonds = r3.d.recap.find(r => r.titre === 'V. Origine des fonds').lignes;
  assert.ok(fonds.some(([a, b]) => /Montant à justifier/.test(a) && /250/.test(b)));
  assert.ok(!JSON.stringify(r3.d.recap).includes('ne doit pas rester'), 'une précision masquée n\'est pas signée');

  // Une pièce déposée par erreur est retirée de la déclaration.
  const p2 = await espace('depot-piece', { session: retour, depot, fichier: b64(PNG, 'erreur.png') });
  assert.equal(p2.d.liste.length, 2);
  const retrait = await espace('declaration-piece-retirer', { session: retour, depot, piece: p2.d.liste[1].id });
  assert.deepEqual(retrait.d.pieces.map(p => p.nom), ['offre de prêt.pdf']);
  assert.equal((await espace('depot-clore', { session: retour, depot })).r.status, 400, 'pas de clôture sans signature');

  // Signature : engagement, code SMS propre à la déclaration.
  assert.equal((await espace('declaration-signer-demander', { session: retour, depot })).r.status, 400, 'engagement requis');
  const c1 = await espace('declaration-signer-demander', { session: retour, depot, engagement: true });
  assert.equal(c1.r.status, 200);
  assert.match(c1.d.codeEssai, /^\d{6}$/);
  assert.match(c1.d.mobile, /32$/);
  // Modifiée après l'envoi du code : le code ne vaut plus.
  complete.identite.profession = 'Architecte';
  await espace('declaration-enregistrer', { session: retour, depot, saisie: complete });
  assert.equal((await espace('declaration-signer', { session: retour, depot, code: c1.d.codeEssai })).r.status, 409);
  const c2 = await espace('declaration-signer-demander', { session: retour, depot, engagement: true });
  assert.notEqual(c2.d.empreinte, c1.d.empreinte);
  assert.equal((await espace('declaration-signer', { session: retour, depot, code: autreCode(c2.d.codeEssai) })).r.status, 400);
  let signee;
  await avecEmails(async () => {
    signee = await espace('declaration-signer', { session: retour, depot, code: c2.d.codeEssai });
    assert.equal(signee.r.status, 200);
    const confirmation = emails.find(m => m.to === 'vial@example.org');
    assert.ok(confirmation.html.includes(c2.d.empreinte), 'le signataire reçoit l\'empreinte');
    assert.ok(!/href=/.test(confirmation.html) && !confirmation.attachments);
  });
  assert.equal(signee.d.signataire, 'Marc VIAL');
  assert.equal(signee.d.empreinte, c2.d.empreinte);
  assert.equal((await espace('declaration-signer', { session: retour, depot, code: c2.d.codeEssai })).r.status, 400, 'on ne signe qu\'une fois');

  // Le signataire retire sa copie ; un autre client, non.
  const copie = await espace('declaration-copie', { session: retour, depot });
  assert.equal(copie.r.status, 200);
  assert.equal((await espace('declaration-copie', { session: samuel, depot })).r.status, 404);

  assert.equal((await espace('etat', { session: retour })).d.demandes.length, 0);
  t = await portail('tableau');
  assert.equal(t.d.demandes.find(d => d.id === demande.id).statut, 'repondue');
  const d = t.d.depots.find(x => x.id === depot);
  assert.equal(d.total, 250000);
  assert.equal(d.pieces.length, 1);
  assert.equal(d.sources[0].libelle, 'Prêt bancaire');
  assert.equal(d.saisie, undefined);
  assert.equal(d.signature.signataire, 'Marc VIAL');
  assert.equal(d.signature.empreinte, c2.d.empreinte);
  assert.deepEqual(d.demandes, [demande.reference]);

  // La déclaration signée, figée au coffre : nom, montant attendu, empreinte ; intégrité contrôlée.
  const url = `${BASE}/api/espace?zone=portail&action=declaration&depot=${depot}`;
  const pdf = await fetch(url, { headers: { cookie } });
  assert.equal(pdf.status, 200);
  const octets = Buffer.from(await pdf.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(octets).digest('hex'), d.signature.empreintePdf);
  assert.ok(octets.equals(Buffer.from(await copie.r.arrayBuffer())), 'la copie du signataire est la même');
  const lu = await PDFDocument.load(octets);
  assert.ok(lu.getSubject().includes('Marc VIAL') && lu.getSubject().includes(c2.d.empreinte));
  const brut = await coffre.lireJson(`depots/${depot}.json`);
  await coffre.ecrireJson(`depots/${depot}.json`, { ...brut, signature: { ...brut.signature, signataire: 'Jean FAUX' } });
  assert.equal((await fetch(url, { headers: { cookie } })).status, 409, 'une signature retouchée est détectée');
  await coffre.ecrireJson(`depots/${depot}.json`, brut);

  const j = (await portail('journal')).d.lignes;
  for (const action of ['declaration-commencee', 'code-signature-envoye', 'declaration-signee', 'origine-fonds-deposee', 'declaration-consultee', 'declaration-consultee-alteree']) {
    assert.ok(j.some(l => l.action === action && l.demande === demande.reference), `journal : ${action}`);
  }
});

test('origine des fonds : relance d\'une demande restée sans réponse', async () => {
  await portail('demande-creer', { contactId: 'c-diai', motif: 'donation', montant: 1000, justificatifs: false });
  const id = (await portail('tableau')).d.demandes.find(d => d.contactId === 'c-diai' && d.nature === 'origine' && d.statut === 'en-attente').id;
  assert.equal((await portail('demande-relancer', { id })).r.status, 502);
  await avecEmails(async () => {
    const r = await portail('demande-relancer', { id });
    assert.equal(r.r.status, 200);
    assert.match(emails[0].subject, /^Rappel/);
    assert.ok(!/href=/.test(emails[0].html));
    assert.match(emails[0].html, /plusieurs fois/);
  });
});

test('la session tombe dès que la validation est retirée ou que le numéro change', async () => {
  const session = await connecterClient('samuel@example.org');
  assert.equal((await portail('retirer', { id: 'c-diai' })).r.status, 200);
  assert.equal((await espace('etat', { session })).r.status, 401);
  assert.deepEqual(Object.keys((await espace('demander-code', { email: 'samuel@example.org' })).d).sort(), ['ok', 'ticket']);

  // Numéro modifié dans le carnet après validation : la fiche se referme d'elle-même.
  const s2 = await connecterClient('vial@example.org');
  const annuaire = await coffre.lireJson('essai-annuaire/contacts.json');
  annuaire.find(c => c.id === 'c-vial-1').mobilePhone = '+33700000000';
  annuaire.find(c => c.id === 'c-vial-2').mobilePhone = '+33700000000';
  await coffre.ecrireJson('essai-annuaire/contacts.json', annuaire);
  assert.equal((await espace('etat', { session: s2 })).r.status, 401);
  assert.equal((await espace('demander-code', { email: 'vial@example.org' })).d.codeEssai, undefined);

  // Email modifié dans le carnet après validation : même effet.
  const s3 = await connecterClient('duo@example.org');
  const carnet = await coffre.lireJson('essai-annuaire/contacts.json');
  carnet.find(c => c.id === 'c-duo-1').emailAddresses = [{ address: 'pirate@example.org' }];
  await coffre.ecrireJson('essai-annuaire/contacts.json', carnet);
  assert.equal((await espace('etat', { session: s3 })).r.status, 401);
  assert.equal((await espace('demander-code', { email: 'pirate@example.org' })).d.codeEssai, undefined);
  const t = await portail('tableau');
  assert.equal(t.d.fiches.find(f => f.id === 'c-vial-1').etat, 'a-revalider');
});

test('journal : les gestes sont consignés, sans numéro complet', async () => {
  const j = await portail('journal');
  const actions = new Set(j.d.lignes.map(l => l.action));
  for (const a of ['code-email-envoye', 'code-envoye', 'fiche-validee', 'rib-etude-consulte', 'rib-client-depose', 'origine-fonds-deposee', 'piece-consultee', 'validation-retiree', 'portail-refus']) {
    assert.ok(actions.has(a), `journal : ${a}`);
  }
  assert.ok(!JSON.stringify(j.d.lignes).includes('612345678'));
});

test('saisie manuelle d\'un client depuis le portail', async () => {
  assert.equal((await portail('fiche-creer', { nom: 'Martin', prenom: 'Lucie', email: 'pas-un-email', telephone: '06 11 22 33 44' })).r.status, 400);
  assert.equal((await portail('fiche-creer', { nom: 'Martin', prenom: '', email: 'lucie@example.org', telephone: '06 11 22 33 44' })).r.status, 400);
  const a = await portail('fiche-creer', { nom: 'Martin', prenom: 'Lucie', nomNaissance: 'Dupont', accord: 'F', email: 'Lucie@Example.org', telephone: '06 11 22 33 44' });
  assert.equal(a.r.status, 200); assert.equal(a.d.action, 'created');
  // Le conjoint, même nom, même email : fiche distincte.
  assert.equal((await portail('fiche-creer', { nom: 'MARTIN', prenom: 'Paul', email: 'lucie@example.org', telephone: '06 55 66 77 88' })).d.action, 'created');
  assert.equal((await portail('fiche-creer', { nom: 'Martin', prenom: 'Lucie', email: 'lucie@example.org', telephone: '06 11 22 33 44' })).d.action, 'updated');
  const fiches = (await portail('tableau')).d.fiches.filter(f => f.nom === 'MARTIN');
  assert.equal(fiches.find(f => f.prenom === 'Lucie').nomNaissance, 'DUPONT', 'nom de naissance conservé à la mise à jour');
  assert.deepEqual(fiches.map(f => f.prenom).sort(), ['Lucie', 'Paul']);
  assert.ok(fiches.every(f => f.etat === 'a-valider'));
  const j = await portail('journal');
  assert.ok(j.d.lignes.some(l => l.action === 'fiche-saisie'));
});

test('modifier une fiche : coordonnées changées, la validation tombe', async () => {
  const lucie = () => portail('tableau').then(t => t.d.fiches.find(f => f.nom === 'MARTIN' && f.prenom === 'Lucie'));
  const avant = await lucie();
  assert.equal((await portail('valider', { id: avant.id })).r.status, 200);
  assert.equal((await lucie()).etat, 'ouverte');
  // Adresse seule : la validation tient.
  const m1 = await portail('fiche-modifier', { id: avant.id, nom: 'Martin', prenom: 'Lucie', nomNaissance: 'Dupont', accord: 'F', email: 'lucie@example.org', telephone: '06 11 22 33 44', adresse: '2 rue Dante', codePostal: '75005', ville: 'Paris' });
  assert.equal(m1.r.status, 200); assert.equal(m1.d.validationRetiree, false);
  let f = await lucie();
  assert.equal(f.etat, 'ouverte'); assert.equal(f.ville, 'Paris'); assert.equal(f.nomNaissance, 'DUPONT');
  // Mobile changé : la fiche repasse à valider.
  const m2 = await portail('fiche-modifier', { id: avant.id, nom: 'Martin', prenom: 'Lucie', nomNaissance: 'Dupont', accord: 'F', email: 'lucie@example.org', telephone: '06 99 88 77 66' });
  assert.equal(m2.d.validationRetiree, true);
  f = await lucie();
  assert.notEqual(f.etat, 'ouverte'); assert.equal(f.telephone, '+33699887766');
  assert.equal((await portail('fiche-modifier', { id: avant.id, nom: 'Martin', prenom: 'Lucie', email: 'x', telephone: '06' })).r.status, 400);
});

test('supprimer une fiche du portail : Outlook intact, restauration possible', async () => {
  const carnetAvant = JSON.stringify(await coffre.lireJson('essai-annuaire/contacts.json'));
  const paul = (await portail('tableau')).d.fiches.find(f => f.prenom === 'Paul' && f.nom === 'MARTIN');
  assert.equal((await portail('fiche-ecarter', { id: paul.id })).r.status, 200);
  assert.equal(JSON.stringify(await coffre.lireJson('essai-annuaire/contacts.json')), carnetAvant, 'le carnet n\'est pas modifié');
  assert.equal((await portail('tableau')).d.fiches.find(f => f.id === paul.id).etat, 'a-supprimer');
  assert.equal((await portail('valider', { id: paul.id })).r.status, 400);
  await portail('fiche-restaurer', { id: paul.id });
  assert.equal((await portail('tableau')).d.fiches.find(f => f.id === paul.id).etat, 'a-valider');
});

test('questionnaires : envoi depuis le portail (ancienne page /admin), consigné au journal', async () => {
  const t = await portail('tableau');
  assert.equal(t.d.questionnaires.etatcivil, 'État civil');
  // Sans email possible, le notaire est averti, et le journal le dit.
  assert.equal((await portail('questionnaire-envoyer', { type: 'etatcivil', email: 'samuel@example.org' })).r.status, 502);
  await avecEmails(async () => {
    assert.equal((await portail('questionnaire-envoyer', { type: 'inconnu', email: 'samuel@example.org' })).r.status, 400);
    assert.equal((await portail('questionnaire-envoyer', { type: 'succession', email: 'pas-une-adresse' })).r.status, 400);
    const a = await portail('questionnaire-envoyer', { type: 'succession', email: 'samuel@example.org', prenom: 'Samuel', nom: '<b>DIAI</b>' });
    assert.equal(a.r.status, 200);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, 'samuel@example.org');
    assert.match(emails[0].subject, /Succession/);
    assert.match(emails[0].html, /\/succession"/, 'le lien du questionnaire figure dans l\'email');
    assert.ok(!emails[0].html.includes('<b>DIAI'), 'le nom est échappé');
  });
  const j = (await portail('journal')).d.lignes.filter(l => l.action === 'questionnaire-envoye');
  assert.equal(j.length, 2);
  assert.ok(j.some(l => l.email === 'non-parti'));
  assert.ok(j.some(l => l.questionnaire === 'Succession' && l.destinataire === 'samuel@example.org'));
});

test('journal : le filtre retient les lignes d\'un client, sans égard aux accents ni à la casse', async () => {
  const tout = (await portail('journal')).d.lignes;
  const diai = (await portail('journal', { filtre: 'samuel  DIAÏ' })).d.lignes;
  assert.ok(diai.length > 0 && diai.length < tout.length);
  assert.ok(diai.every(l => /diai/i.test(l.nom || '') && /samuel/i.test(l.nom || '')));
  assert.equal((await portail('journal', { filtre: 'personne-de-ce-nom' })).d.lignes.length, 0);
});

test('/admin renvoie au portail', async () => {
  const r = await fetch(`${BASE}/admin`, { redirect: 'manual' });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), '/portail');
});

test('déconnexion du portail', async () => {
  await portail('deconnexion');
  assert.equal((await portail('tableau')).r.status, 401);
});
