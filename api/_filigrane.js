/**
 * _filigrane.js — Marque le RIB de l'étude au moment où il est remis à un client
 *
 * Le RIB déposé par le notaire reste intact dans le coffre. Chaque exemplaire
 * remis par l'espace client est une copie PDF qui porte :
 *   - un filigrane en travers de chaque page : office, référence, à qui il a
 *     été remis et quand. Pas de bandeau : il masquait le bas du RIB.
 *
 * Aucun QR code n'est ajouté : celui de l'office figure déjà sur le RIB déposé.
 *
 * La référence est consignée au journal du portail : un contrôleur qui tient
 * un exemplaire peut faire retrouver par l'office la ligne correspondante
 * (date, client, RIB remis). Un filigrane s'imite ; une référence absente du
 * journal, non.
 *
 * Les pièces déposées par les clients reçoivent, elles aussi, un filigrane
 * quand l'office les consulte (filigranerPiece).
 *
 * RIB_QR_URL : adresse de la page de vérification citée dans les propriétés
 *              (défaut https://www.tagot.notaires.fr/rib).
 */

const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

const URL_VERIFICATION = () => process.env.RIB_QR_URL || 'https://www.tagot.notaires.fr/rib';

/** Référence lisible à voix haute : pas de 0/O ni de 1/I. */
function nouvelleReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (const o of crypto.randomBytes(8)) r += alphabet[o % alphabet.length];
  return `RIB-${r.slice(0, 4)}-${r.slice(4)}`;
}

function dateParis(d) {
  return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .replace(' ', ' à ').replace(':', ' h ');
}

/** Les polices standard d'un PDF ne connaissent que le Latin-1 étendu. */
function latin(s) {
  return String(s).normalize('NFC').replace(/[^\x20-\x7e -ÿ—’Œœ]/g, '?');
}

async function ouvrir({ buf, type }) {
  if (type === 'application/pdf') return PDFDocument.load(buf);
  // Un RIB déposé en image est posé sur une page A4.
  const doc = await PDFDocument.create();
  const image = type === 'image/png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
  const page = doc.addPage([595.28, 841.89]);
  const echelle = Math.min((page.getWidth() - 60) / image.width, (page.getHeight() - 160) / image.height, 1);
  page.drawImage(image, {
    x: (page.getWidth() - image.width * echelle) / 2, y: page.getHeight() - 40 - image.height * echelle,
    width: image.width * echelle, height: image.height * echelle
  });
  return doc;
}

/**
 * Filigrane en travers de chaque page : deux lignes qui alternent, répétées
 * sur toute la hauteur. Semi-transparent, il recouvre le document sans
 * masquer aucune information ; aucun bandeau n'est posé.
 */
function poserFiligrane(doc, police, lignes) {
  const angle = 28;
  for (const page of doc.getPages()) {
    const { width: l, height: h } = page.getSize();
    // Corps choisi pour que la plus longue ligne tienne sur la diagonale.
    const utile = (l * 0.92) / Math.cos(angle * Math.PI / 180);
    const large = Math.max(...lignes.map(t => police.widthOfTextAtSize(t, 1)));
    const corps = Math.max(8, Math.min(18, utile / large));
    const pas = Math.max(corps * 6, h / 7);
    let i = 0;
    for (let y = -h * 0.35; y < h * 1.05; y += pas, i++) {
      page.drawText(lignes[i % lignes.length], {
        x: l * 0.04, y, size: corps, font: police,
        color: rgb(0.45, 0.45, 0.45), opacity: 0.2, rotate: degrees(angle)
      });
    }
  }
}

/**
 * RIB de l'étude remis à un client.
 * @param {{buf:Buffer,type:string}} rib      le RIB tel que déposé
 * @param {{beneficiaire:string,reference:string,quand?:Date}} remise
 * @returns {Promise<Buffer>} un PDF marqué
 */
async function filigraner(rib, { beneficiaire, reference, quand = new Date() }) {
  const doc = await ouvrir(rib);
  const gras = await doc.embedFont(StandardFonts.HelveticaBold);
  poserFiligrane(doc, gras, [
    latin(`Grégoire TAGOT  |  notaire — RIB authentique — ${reference}`),
    latin(`Remis à ${beneficiaire} le ${dateParis(quand)}`)
  ]);
  doc.setTitle(latin(`RIB de l'office — ${reference}`));
  doc.setSubject(latin(`Remis à ${beneficiaire} le ${dateParis(quand)} — vérification : ${URL_VERIFICATION().replace(/^https?:\/\//, '')}`));
  doc.setProducer('form.tagot.notaires.fr');
  return Buffer.from(await doc.save());
}

/**
 * Pièce déposée par un client (son RIB, ses justificatifs), au moment où
 * l'office la consulte : la copie porte l'origine et l'usage de la pièce.
 * L'original reste intact dans le coffre.
 * @param {{buf:Buffer,type:string}} piece
 * @param {{client:string,recuLe:string|Date}} origine
 */
async function filigranerPiece(piece, { client, recuLe }) {
  const doc = await ouvrir(piece);
  const gras = await doc.embedFont(StandardFonts.HelveticaBold);
  const quand = dateParis(new Date(recuLe));
  poserFiligrane(doc, gras, [
    latin(`Reçu par l'office Grégoire TAGOT  |  notaire — usage exclusif du dossier`),
    latin(`Déposé par ${client} le ${quand} — espace client`)
  ]);
  doc.setSubject(latin(`Pièce déposée par ${client} le ${quand}`));
  doc.setProducer('form.tagot.notaires.fr');
  return Buffer.from(await doc.save());
}

module.exports = { filigraner, filigranerPiece, nouvelleReference };
