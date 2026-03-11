const nodemailer = require('nodemailer');

const NOTAIRE = process.env.NOTAIRE_EMAIL || process.env.SMTP_USER;
const FROM    = `"Grégoire TAGOT | notaire" <${process.env.SMTP_USER}>`;

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'ssl0.ovh.net',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('fr-FR'); } catch { return d; }
}

function row(label, value) {
  if (!value) return '';
  return `<tr>
    <td style="padding:5px 14px 5px 0;font-size:12px;color:#888;white-space:nowrap;vertical-align:top;">${label}</td>
    <td style="padding:5px 0;font-size:13px;color:#111;vertical-align:top;">${value}</td>
  </tr>`;
}

function sec(title) {
  return `<tr><td colspan="2" style="padding:16px 0 5px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#bbb;font-weight:bold;border-top:1px solid #eee;">${title}</td></tr>`;
}

function yesno(v) {
  if (v === 'oui') return 'Oui';
  if (v === 'non') return 'Non';
  if (v === 'inconnu') return 'Non renseigné';
  return v || '';
}

const REG_LABELS = {
  communaute_legale: 'Communauté réduite aux acquêts (régime légal)',
  separation: 'Séparation de biens',
  communaute_universelle: 'Communauté universelle',
  participation: 'Participation aux acquêts'
};
const PROC_LABELS = { consentement_mutuel: 'Consentement mutuel', judiciaire: 'Judiciaire' };
const PLACEMENT_LABELS = { assurance_vie:'Assurance-vie', pea:'PEA', compte_titres:'Compte-titres', livret:'Livret', autre:'Autre' };
const MESURE_LABELS = { tutelle:'Tutelle', curatelle:'Curatelle', sauvegarde:'Sauvegarde de justice' };
const ATTRIBUTION_EPOUX = { epoux1:'Époux 1', epoux2:'Époux 2' };

// ── Email HTML ─────────────────────────────────────────────
function buildEmail(data) {
  const { declarant, epoux1, epoux2, mariage, procedure,
          propresE1, propresE2, recusE1, recusE2,
          communaute, passif, creances, attribution } = data;

  function blocEpoux(e, label) {
    const adresseComplete = [e.adresse, e.cp, e.ville].filter(Boolean).join(', ');
    return `
      ${sec(label)}
      ${row('Civilité', e.civilite)}
      ${row('Nom d\'usage', e.nom)}
      ${row('Nom de naissance', e.nomNaissance)}
      ${row('Prénoms', e.prenoms)}
      ${row('Date de naissance', fmtDate(e.dateNaissance))}
      ${row('Lieu de naissance', [e.cpNaissance, e.lieuNaissance].filter(Boolean).join(' '))}
      ${row('Nationalité', e.nationalite)}
      ${row('Profession', e.profession)}
      ${row('Adresse', adresseComplete)}
      ${row('Téléphone', e.tel)}
      ${row('Email', e.email)}
      ${row('Mesure de protection', MESURE_LABELS[e.mesureProtection] || e.mesureProtection)}
      ${row('Centre des impôts', e.centreImpots)}`;
  }

  function blocPropres(p, label) {
    const immos = (p.immobilier || []).map((b, i) => {
      const sit = b.existeToujours === 'vendu'
        ? `Vendu — prix : ${b.prixVente || '—'}, remploi : ${b.remploi || '—'}`
        : (b.existeToujours === 'existe' ? 'Existe toujours' : '');
      return row(`Immeuble ${i+1}`, [b.adresse, b.nature, b.valeur ? `${b.valeur}` : '', sit].filter(Boolean).join(' · '));
    }).join('');
    return `
      ${sec(label + ' — Biens propres avant mariage')}
      ${immos || row('Immobilier', '—')}
      ${row('Véhicules / mobilier', p.mobilier_vehicules || p.mobilier_objets ? [p.mobilier_vehicules, p.mobilier_objets].filter(Boolean).join(' — ') : '')}
      ${row('Avoirs financiers', p.financier_comptes || p.financier_placements ? [p.financier_comptes, p.financier_placements].filter(Boolean).join(' — ') : '')}`;
  }

  function blocRecus(r, label) {
    const dons = (r.donations || []).map((d, i) =>
      row(`Donation ${i+1}`, [d.qui, d.nature, d.valeur, fmtDate(d.date), d.notaire,
        d.existeToujours === 'vendu' ? `vendu → ${d.destination}` : ''].filter(Boolean).join(' · '))
    ).join('');
    const succs = (r.successions || []).map((s, i) =>
      row(`Succession ${i+1}`, [s.qui, s.nature, s.valeur, fmtDate(s.date), s.notaire,
        s.existeToujours === 'vendu' ? `vendu → ${s.destination}` : ''].filter(Boolean).join(' · '))
    ).join('');
    return `
      ${sec(label + ' — Biens reçus pendant le mariage')}
      ${dons || ''}
      ${succs || ''}`;
  }

  const immoComm = (communaute.immobilier || []).map((b, i) =>
    row(`Immeuble ${i+1}`, [b.adresse, b.nature, fmtDate(b.dateAcquisition), b.notaire, b.valeur].filter(Boolean).join(' · '))
  ).join('');

  const comptesComm = (communaute.comptes || []).map((c, i) =>
    row(`Compte ${i+1}`, [c.banque, c.numero, c.titulaire, c.solde ? `solde : ${c.solde}` : ''].filter(Boolean).join(' · '))
  ).join('');

  const placementsComm = (communaute.placements || []).map((p, i) =>
    row(`Placement ${i+1}`, [PLACEMENT_LABELS[p.type] || p.type, p.etablissement, p.valeur].filter(Boolean).join(' · '))
  ).join('');

  const societesComm = (communaute.societes || []).map((s, i) =>
    row(`Société ${i+1}`, [s.nom, s.parts ? `${s.parts} parts` : '', s.valeur].filter(Boolean).join(' · '))
  ).join('');

  const vehiculesComm = (communaute.vehicules || []).map((v, i) =>
    row(`Véhicule ${i+1}`, [v.marque, v.modele, v.valeur].filter(Boolean).join(' · '))
  ).join('');

  const prets = (passif.prets || []).map((p, i) =>
    row(`Prêt ${i+1}`, [p.banque, p.numero, p.montantInitial ? `initial : ${p.montantInitial}` : '', p.capitalRestant ? `CRD : ${p.capitalRestant}` : '', p.quiPaie ? `payé par : ${p.quiPaie === 'commun' ? 'commun' : p.quiPaie === 'epoux1' ? 'Époux 1' : 'Époux 2'}` : ''].filter(Boolean).join(' · '))
  ).join('');

  const credits = (passif.credits || []).map((c, i) =>
    row(`Crédit ${i+1}`, [c.objet, c.banque, c.capitalRestant ? `CRD : ${c.capitalRestant}` : ''].filter(Boolean).join(' · '))
  ).join('');

  const titreDeclarant = [declarant.prenom, declarant.nom].filter(Boolean).join(' ');
  const titreEpoux = [epoux1.nom, 'et', epoux2.nom].filter(Boolean).join(' ');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f7f7f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" style="background:#f7f7f5;padding:28px 0"><tr><td>
<table width="560" align="center" style="background:#fff;border:1px solid #e5e5e5;border-radius:6px;overflow:hidden;">
  <tr><td style="background:#111;padding:24px 28px;">
    <div style="font-size:13px;color:rgba(255,255,255,.6);margin-bottom:4px;">Grégoire TAGOT | notaire</div>
    <div style="font-size:20px;color:#fff;font-weight:300;">Questionnaire Divorce</div>
    <div style="font-size:12px;color:#888;margin-top:4px;">${titreEpoux}</div>
  </td></tr>
  <tr><td style="padding:24px 28px;">
    <table width="100%">
      ${sec('DÉCLARANT')}
      ${row('Nom', titreDeclarant)}

      ${blocEpoux(epoux1, 'ÉPOUX 1')}
      ${blocEpoux(epoux2, 'ÉPOUX 2')}

      ${sec('MARIAGE')}
      ${row('Date du mariage', fmtDate(mariage.date))}
      ${row('Lieu du mariage', mariage.lieu)}
      ${row('Contrat de mariage', yesno(mariage.contrat))}
      ${mariage.contrat === 'oui' ? `
        ${row('Régime matrimonial', REG_LABELS[mariage.regimeMatrimonial] || mariage.regimeMatrimonial)}
        ${row('Notaire', mariage.notaireContrat)}
        ${row('Date du contrat', fmtDate(mariage.dateContrat))}` : ''}
      ${row('Donation entre époux', yesno(mariage.donationEntreEpoux))}
      ${mariage.donationEntreEpoux === 'oui' ? `
        ${row('Notaire donation', mariage.notaireDonation)}
        ${row('Date donation', fmtDate(mariage.dateDonation))}` : ''}

      ${sec('PROCÉDURE')}
      ${row('Type', PROC_LABELS[procedure.type] || procedure.type)}
      ${row('Tribunal', procedure.tribunal)}
      ${row('Date ONC', fmtDate(procedure.dateONC))}
      ${row('Date jugement', fmtDate(procedure.dateJugement))}
      ${row('Date effet dissolution', fmtDate(procedure.dateEffetDissolution))}
      ${row('Avocat Époux 1', [procedure.avocat1Nom, procedure.avocat1Tel, procedure.avocat1Email].filter(Boolean).join(' · '))}
      ${row('Avocat Époux 2', [procedure.avocat2Nom, procedure.avocat2Tel, procedure.avocat2Email].filter(Boolean).join(' · '))}

      ${blocPropres(propresE1, 'ÉPOUX 1')}
      ${blocPropres(propresE2, 'ÉPOUX 2')}

      ${blocRecus(recusE1, 'ÉPOUX 1')}
      ${blocRecus(recusE2, 'ÉPOUX 2')}

      ${sec('ACTIF DE COMMUNAUTÉ — IMMOBILIER')}
      ${immoComm || row('Immobilier', '—')}

      ${sec('ACTIF DE COMMUNAUTÉ — COMPTES BANCAIRES')}
      ${comptesComm || row('Comptes', '—')}

      ${sec('ACTIF DE COMMUNAUTÉ — PLACEMENTS')}
      ${placementsComm || row('Placements', '—')}

      ${sec('ACTIF DE COMMUNAUTÉ — SOCIÉTÉS')}
      ${societesComm || row('Sociétés', '—')}

      ${sec('ACTIF DE COMMUNAUTÉ — VÉHICULES')}
      ${vehiculesComm || row('Véhicules', '—')}

      ${sec('ACTIF DE COMMUNAUTÉ — MOBILIER')}
      ${row('Mobilier courant', communaute.mobilier_courant)}
      ${row('Objets d\'art / antiquités', communaute.mobilier_art)}
      ${row('Autres objets de valeur', communaute.mobilier_autres)}

      ${sec('PASSIF — PRÊTS IMMOBILIERS')}
      ${prets || row('Prêts', '—')}

      ${sec('PASSIF — CRÉDITS CONSOMMATION')}
      ${credits || row('Crédits', '—')}

      ${sec('PASSIF — AUTRES DETTES')}
      ${row('Dettes fiscales', passif.dettesFiscales)}
      ${row('Autres dettes', passif.autresDettes)}

      ${sec('CRÉANCES ENTRE ÉPOUX')}
      ${row('Prêt commun payé seul', yesno(creances.pretCommun))}
      ${creances.pretCommun === 'oui' ? row('→ Détail', creances.pretCommun_detail) : ''}
      ${row('Financement bien propre de l\'autre', yesno(creances.financement))}
      ${creances.financement === 'oui' ? row('→ Détail', creances.financement_detail) : ''}
      ${row('Récompenses', yesno(creances.recompenses))}
      ${creances.recompenses === 'oui' ? row('→ Détail', creances.recompenses_detail) : ''}

      ${sec('ATTRIBUTION PRÉFÉRENTIELLE')}
      ${row('Logement', attribution.logement === 'oui' ? `Oui — ${ATTRIBUTION_EPOUX[attribution.logement_epoux] || ''}` : yesno(attribution.logement))}
      ${row('Entreprise', attribution.entreprise === 'oui' ? `Oui — ${ATTRIBUTION_EPOUX[attribution.entreprise_epoux] || ''}` : yesno(attribution.entreprise))}
      ${row('Véhicule', attribution.vehicule === 'oui' ? `Oui — ${ATTRIBUTION_EPOUX[attribution.vehicule_epoux] || ''} ${attribution.vehicule_detail || ''}` : yesno(attribution.vehicule))}
    </table>
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">
    form.tagot.notaires.fr · Grégoire TAGOT | notaire
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Handler ───────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { data, email, pieces } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Données manquantes' });

  const e1 = data.epoux1 || {};
  const e2 = data.epoux2 || {};
  const nomEpoux = [e1.nom, 'et', e2.nom].filter(Boolean).join(' ');

  const htmlContent = buildEmail(data);

  try {
    await transporter().sendMail({
      from: FROM,
      to: NOTAIRE,
      replyTo: email || undefined,
      subject: `Questionnaire Divorce — ${nomEpoux}`,
      html: htmlContent,
    });

  // ── Email client — liste de pièces ──────────────────────────────────
  if (email && pieces && pieces.length) {
    const nomDossier = "Divorce";
    const piecesHtml = pieces.map(s => `
      <tr><td colspan="2" style="padding:14px 0 4px;font-size:10px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.06em;border-top:1px solid #eee;">${s.section}</td></tr>
      ${s.pieces.map(p => `<tr><td style="padding:5px 0 5px 12px;font-size:13px;color:#444;border-bottom:1px solid #f8f8f8;">&rarr; ${p}</td></tr>`).join('')}
    `).join('');
    const clientHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT | notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Divorce — pièces à fournir</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">${nomDossier}</div>
    </div>
    <div style="padding:28px 30px;">
      <p style="font-size:14px;color:#555;margin:0 0 20px;">Bonjour,<br><br>Suite à votre questionnaire, voici la liste des pièces à nous faire parvenir.</p>
      <table style="width:100%;border-collapse:collapse;">${piecesHtml}</table>
      <p style="font-size:12px;color:#999;margin-top:24px;">Merci d'adresser vos pièces à <a href="mailto:office@tagot.notaires.fr" style="color:#333;font-weight:600;">office@tagot.notaires.fr</a> ou de les déposer directement à l'étude (2 rue Dante, 75005 Paris).</p>
    </div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Grégoire TAGOT | notaire — 2 rue Dante, 75005 Paris</p>
    </div>
  </div>
</body></html>`;
    try {
      await transporter().sendMail({ from: FROM, to: email, subject: `Divorce — pièces à fournir`, html: clientHtml });
    } catch(e) { console.error('Email client pieces:', e.message); }
  }
    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Erreur email:', e.message);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi' });
  }
};
