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
  if (v === 'na')  return 'Sans objet';
  return v || '';
}

const MOTIF_LABELS = {
  mobilite_pro: 'Mobilité professionnelle',
  familial: 'Événement familial',
  mariage_pacs_divorce: 'Mariage / PACS / Divorce',
  naissance_deces: 'Naissance / Décès',
  transfert_epargne: 'Transfert d\'épargne',
  autre: 'Autre'
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { data, email, pieces } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Données manquantes' });

  const { vendeur1, vendeur2, nbVendeurs, bien, copro, travaux,
          prets, plusvalue, contrats, fiscalite, motivation } = data;

  const nomV1 = [vendeur1.prenoms, vendeur1.nom].filter(Boolean).join(' ');
  const nomV2 = nbVendeurs === 2 ? [vendeur2.prenoms, vendeur2.nom].filter(Boolean).join(' ') : '';
  const adresse = [bien.adresse, bien.cp, bien.ville].filter(Boolean).join(', ');
  const motifs = (motivation.raisons || []).map(r => MOTIF_LABELS[r] || r).join(', ');

  const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" style="background:#f7f7f5;padding:28px 0"><tr><td>
<table width="580" align="center" style="background:#fff;border:1px solid #e5e5e5;border-radius:6px;overflow:hidden;">
  <tr><td style="background:#111;padding:24px 28px;">
    <div style="font-size:13px;color:rgba(255,255,255,.6);margin-bottom:4px;">Grégoire TAGOT | notaire</div>
    <div style="font-size:20px;color:#fff;font-weight:300;">Questionnaire — Vente d'appartement</div>
    <div style="font-size:12px;color:#888;margin-top:4px;">${adresse}</div>
  </td></tr>
  <tr><td style="padding:24px 28px;">
    <table width="100%">

      ${sec('VENDEUR(S)')}
      ${row('Vendeur 1', nomV1)}
      ${nomV2 ? row('Vendeur 2', nomV2) : ''}
      ${row('Email', email || '')}

      ${sec('LE BIEN')}
      ${row('Adresse', adresse)}
      ${row('Résidence principale', yesno(bien.residencePrincipale))}
      ${bien.residencePrincipale === 'oui' ? row('Depuis', bien.depuisQuand) : ''}
      ${row('Situation jour de vente', bien.situationJour === 'libre' ? 'Libre de toute occupation' : bien.situationJour === 'loue' ? 'Loué' : '')}
      ${bien.situationJour === 'loue' ? `
        ${row('Loyer mensuel', bien.bail.loyer ? bien.bail.loyer + ' €' : '')}
        ${row('Dépôt de garantie', bien.bail.depotGarantie ? bien.bail.depotGarantie + ' €' : '')}
        ${row('Date du congé', bien.bail.dateConge || '')}` : ''}
      ${row('Loué précédemment', yesno(bien.locatairePrecedent))}
      ${row('1ère vente depuis mise en copropriété', yesno(bien.premiereDivision))}

      ${sec('COPROPRIÉTÉ')}
      ${row('Division en volume', yesno(copro.divisionVolume))}
      ${row('Lotissement', yesno(copro.lotissement))}
      ${copro.lotissement === 'oui' ? row('Association syndicale', yesno(copro.associationSyndicale)) : ''}
      ${copro.associationSyndicale === 'oui' ? row('Président ASL', [copro.presidentNom, copro.presidentCoord].filter(Boolean).join(' — ')) : ''}
      ${row('Syndic', yesno(copro.syndic))}
      ${copro.syndic === 'oui' ? row('Nom / adresse syndic', [copro.syndicNom, copro.syndicAdresse].filter(Boolean).join(', ')) : ''}
      ${row('Difficultés particulières', yesno(copro.difficultes))}
      ${copro.difficultes === 'oui' ? row('Détail', copro.difficultesDetail) : ''}
      ${row('Procédure en cours', yesno(copro.procedureContre))}
      ${row('Dégât des eaux en cours', yesno(copro.degatEaux))}
      ${copro.degatEaux === 'oui' ? row('Convention acquéreur', copro.degatEauxDetail) : ''}
      ${row('Fonds travaux / emprunt copro', yesno(copro.fondsTravaux))}

      ${sec('TRAVAUX')}
      ${row('Travaux ext. / parties communes', yesno(travaux.travauxExterieur))}
      ${travaux.travauxExterieur === 'oui' ? row('Détail travaux', travaux.travauxDetail) : ''}
      ${row('Modification affectation', yesno(travaux.modifAffectation))}
      ${row('Division / réunion de lots', yesno(travaux.divisionReunion))}
      ${(travaux.travauxExterieur === 'oui' || travaux.modifAffectation === 'oui' || travaux.divisionReunion === 'oui') ? row('Autorisations obtenues', yesno(travaux.autorisations)) : ''}
      ${row('Sanibroyeur', yesno(travaux.sanibroyeur))}
      ${row('Déclaration cadastre déposée', yesno(travaux.declarationImpots))}

      ${sec('PRÊTS ET HYPOTHÈQUES')}
      ${row('Saisie immobilière en cours', yesno(prets.saisieImmobiliere))}
      ${row('Prêt(s) avec hypothèque', yesno(prets.pretHypotheque))}
      ${prets.pretHypotheque === 'oui' ? row('Référence(s) prêt', prets.pretDetail) : ''}
      ${row('Crédit-relais', yesno(prets.creditRelais))}
      ${row('Garantie Trésor public', yesno(prets.garantieTresor))}

      ${sec('PLUS-VALUES')}
      ${row('Résidence principale', yesno(plusvalue.residencePrincipale))}
      ${plusvalue.residencePrincipale === 'oui' ? row('Depuis', plusvalue.depuisQuand) : ''}
      ${plusvalue.residencePrincipale === 'non' ? `
        ${row('Remploi résidence principale', yesno(plusvalue.remploi))}
        ${row('Retraité / invalide modeste', yesno(plusvalue.retraiteInvalide))}
        ${row('Travaux surélévation / amélioration', yesno(plusvalue.travauxSurelevation))}
        ${row('Droits de mutation payés', yesno(plusvalue.droitsMutation))}` : ''}
      ${row('Activité professionnelle dans le bien', yesno(plusvalue.activitePro))}
      ${plusvalue.activitePro === 'oui' ? row('Incidences comptables', plusvalue.activiteProDetail) : ''}

      ${sec('CONTRATS ET BAUX')}
      ${row('Contrat d\'alarme', yesno(contrats.alarme))}
      ${row('Avantage fiscal (Pinel…)', yesno(contrats.avantFiscal))}
      ${contrats.avantFiscal === 'oui' ? `
        ${row('Dispositif', contrats.avantFiscalLequel)}
        ${row('Engagement terminé', yesno(contrats.engagementTermine))}` : ''}
      ${row('Autres contrats', yesno(contrats.autresContrats))}
      ${row('Équipements sous garantie', yesno(contrats.garantiesEquipements))}
      ${row('Sinistre catnat avant acquisition', yesno(contrats.sinisstreAvant))}
      ${row('Sinistre catnat depuis acquisition', yesno(contrats.sinistreDepuis))}

      ${sec('FISCALITÉ')}
      ${row('Récupération TVA à l\'achat', yesno(fiscalite.tva))}
      ${row('Régime particulier TVA', yesno(fiscalite.tvaDroit))}
      ${row('Déficit foncier imputé', yesno(fiscalite.deficitFoncier))}
      ${row('Détenu par société civile', yesno(fiscalite.societeCivile))}
      ${fiscalite.societeCivile === 'oui' ? `
        ${row('Soumise à l\'IR', yesno(fiscalite.societeCivileIR))}
        ${row('Soumise à l\'IS', yesno(fiscalite.societeCivileIS))}` : ''}
      ${row('Résidence fiscale', fiscalite.residentFiscal === 'etranger' ? 'Étranger' : fiscalite.residentFiscal === 'france' ? 'France' : '')}

      ${sec('MOTIVATION ET OBSERVATIONS')}
      ${motifs ? row('Raisons de la vente', motifs) : ''}
      ${motivation.transfertDetail ? row('Remploi (épargne)', motivation.transfertDetail) : ''}
      ${motivation.autreRaison ? row('Autre raison', motivation.autreRaison) : ''}
      ${motivation.observations ? row('Observations', motivation.observations) : ''}

    </table>
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">
    form.tagot.notaires.fr · Grégoire TAGOT | notaire
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  try {
    await transporter().sendMail({
      from: FROM,
      to: NOTAIRE,
      replyTo: email || undefined,
      subject: `Questionnaire Vente — ${nomV1}${nomV2 ? ' / ' + nomV2 : ''} — ${adresse}`,
      html: htmlContent
    });

  // ── Email client — liste de pièces ──────────────────────────────────
  if (email && pieces && pieces.length) {
    const nomDossier = data && data.bien && data.bien.adresse ? data.bien.adresse : "Appartement";
    const piecesHtml = pieces.map(s => `
      <tr><td colspan="2" style="padding:14px 0 4px;font-size:10px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.06em;border-top:1px solid #eee;">${s.section}</td></tr>
      ${s.pieces.map(p => `<tr><td style="padding:5px 0 5px 12px;font-size:13px;color:#444;border-bottom:1px solid #f8f8f8;">&rarr; ${p}</td></tr>`).join('')}
    `).join('');
    const clientHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT | notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Vente appartement — pièces à fournir</div>
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
      await transporter().sendMail({ from: FROM, to: email, subject: `Vente appartement — pièces à fournir`, html: clientHtml });
      } catch(e) { console.error('Email client pieces:', e.message); }
    }

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Erreur email:', e.message);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi' });
  }
};
