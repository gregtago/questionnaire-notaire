/**
 * _filigrane.js — Marque le RIB de l'étude au moment où il est remis à un client
 *
 * Le RIB déposé par le notaire reste intact dans le coffre. Chaque exemplaire
 * remis par l'espace client est une copie PDF qui porte :
 *   - un filigrane en travers de chaque page (office + référence) ;
 *   - un bandeau en pied de page : à qui il a été remis, quand, par quel site,
 *     sous quelle référence ;
 *   - un QR code menant à la page de vérification de l'office.
 *
 * La référence est consignée au journal du portail : un contrôleur qui tient
 * un exemplaire peut faire retrouver par l'office la ligne correspondante
 * (date, client, RIB remis). Un filigrane s'imite ; une référence absente du
 * journal, non.
 *
 * RIB_QR_URL : adresse encodée dans le QR code
 *              (défaut https://www.tagot.notaires.fr/rib).
 */

const crypto = require('crypto');
const QRCode = require('qrcode');
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
 * @param {{buf:Buffer,type:string}} rib      le RIB tel que déposé
 * @param {{beneficiaire:string,reference:string,quand?:Date}} remise
 * @returns {Promise<Buffer>} un PDF marqué
 */
async function filigraner(rib, { beneficiaire, reference, quand = new Date() }) {
  const doc = await ouvrir(rib);
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const gras = await doc.embedFont(StandardFonts.HelveticaBold);
  const qr = await doc.embedPng(await QRCode.toBuffer(URL_VERIFICATION(), { margin: 1, width: 240 }));
  const adresse = URL_VERIFICATION().replace(/^https?:\/\//, '');
  const gris = rgb(0.25, 0.25, 0.25);

  const travers = latin(`Grégoire TAGOT  |  notaire — RIB authentique — ${reference}`);
  const lignes = [
    [gras, latin(`RIB remis par l'espace client de l'office Grégoire TAGOT  |  notaire — référence ${reference}`)],
    [normal, latin(`Délivré à ${beneficiaire}, le ${dateParis(quand)}, depuis form.tagot.notaires.fr après double identification.`)],
    [normal, latin(`Vérification : scannez le QR code ou saisissez ${adresse}. L'office ne modifie jamais son RIB par email ni par SMS.`)]
  ];

  for (const page of doc.getPages()) {
    const { width: l, height: h } = page.getSize();

    // Filigrane en travers, répété : il recouvre tout le document sans le masquer.
    const corps = Math.max(11, Math.min(20, l / 34));
    const pas = Math.max(150, h / 5);
    for (let y = -h * 0.2; y < h * 1.1; y += pas) {
      page.drawText(travers, { x: l * 0.04, y, size: corps, font: gras, color: rgb(0.45, 0.45, 0.45), opacity: 0.16, rotate: degrees(28) });
    }

    // Bandeau de pied de page.
    const hb = 58, cote = 46;
    const taille = Math.max(5.5, Math.min(7.5, (l - cote - 40) / 70));
    page.drawRectangle({ x: 0, y: 0, width: l, height: hb, color: rgb(1, 1, 1), opacity: 0.9 });
    page.drawLine({ start: { x: 14, y: hb }, end: { x: l - 14, y: hb }, thickness: 0.6, color: gris });
    lignes.forEach(([police, texte], i) => {
      page.drawText(texte, { x: 16, y: hb - 17 - i * (taille + 5.5), size: taille, font: police, color: gris, maxWidth: l - cote - 40 });
    });
    page.drawImage(qr, { x: l - cote - 14, y: 6, width: cote, height: cote });
  }

  doc.setTitle(latin(`RIB de l'office — ${reference}`));
  doc.setSubject(latin(`Remis à ${beneficiaire} le ${dateParis(quand)}`));
  doc.setProducer('form.tagot.notaires.fr');
  return Buffer.from(await doc.save());
}

module.exports = { filigraner, nouvelleReference };
