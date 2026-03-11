const { BrevoClient } = require('@getbrevo/brevo');

const SENDER  = { name: 'Grégoire TAGOT | notaire', email: process.env.SENDER_EMAIL || 'gregoire@tagot.fr' };
const NOTAIRE = process.env.NOTAIRE_EMAIL || 'gregoire@tagot.fr';

function brevo() { return new BrevoClient({ apiKey: process.env.BREVO_API_KEY }); }

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
  return v || '';
}

const MODE_LABELS = { seul:'Seul(e)', couple:'En couple', indivision:'Indivision', sci:'SCI' };
const TYPE_BIEN_LABELS = { appartement:'Appartement', maison:'Maison', terrain:'Terrain', autre:'Autre' };
const DEST_LABELS = { residence_principale:'Résidence principale', residence_secondaire:'Résidence secondaire', investissement_locatif:'Investissement locatif' };
const LOC_LABELS = { meublee:'Location meublée', nue:'Location nue' };
const ORIGINE_LABELS = { epargne:'Épargne personnelle', donation:'Donation familiale', heritage:'Héritage', vente_bien:'Vente d\'un bien', indemnite:'Indemnité', autre:'Autre origine' };
const JUST_LABELS = { releve:'Relevé bancaire', attestation_banque:'Attestation bancaire', attestation_donation:'Attestation de donation' };
const COND_LABELS = { pret:'Obtention du prêt', vente_prealable:'Vente préalable d\'un bien', permis:'Permis de construire', autre:'Autre condition' };
const ASSUR_LABELS = { banque:'Auprès de la banque', externe:'Déléguée (autre assureur)', non:'Non / À définir' };
const GAR_LABELS = { caution:'Caution bancaire', hypotheque:'Hypothèque', ppd:'PPD', non:'Non précisée' };
const DEP_LABELS = { cave:'Cave', parking:'Parking', garage:'Garage', jardin:'Jardin', terrasse:'Terrasse' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { data, email } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Données manquantes' });

  const { acquereur, acquereur2, mode, indivision, sci, bien, projet,
          financement, fonds, revente, garanties, fiscalite, banque } = data;

  const nomAcq = [acquereur.prenoms, acquereur.nom].filter(Boolean).join(' ');
  const adresseBien = [bien.adresse, bien.cp, bien.ville].filter(Boolean).join(', ');

  // Bloc acquéreur
  let blocAcquereurs = '';
  if (mode === 'seul') {
    blocAcquereurs = row('Acquéreur', nomAcq);
  } else if (mode === 'couple') {
    blocAcquereurs = row('Acquéreur 1', nomAcq)
      + row('Acquéreur 2', [acquereur2.prenoms, acquereur2.nom].filter(Boolean).join(' '));
  } else if (mode === 'indivision') {
    blocAcquereurs = (indivision || []).map((ind,i) =>
      row(`Indivisaire ${i+1}`, `${ind.nom}${ind.quotePart ? ' — '+ind.quotePart+'%' : ''}`)
    ).join('');
  } else if (mode === 'sci') {
    blocAcquereurs = row('SCI', sci.nom)
      + row('Siège social', sci.siege)
      + row('Répartition des parts', sci.repartition);
  }

  const depsStr = (bien.dependances || []).map(d => DEP_LABELS[d] || d).join(', ');
  const condsStr = (financement.conditionsSuspensives || []).map(c => COND_LABELS[c] || c).join(', ');
  const originesStr = (fonds.origines || []).map(o => ORIGINE_LABELS[o] || o).join(', ');
  const justStr = (fonds.justificatifs || []).map(j => JUST_LABELS[j] || j).join(', ');

  const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" style="background:#f7f7f5;padding:28px 0"><tr><td>
<table width="560" align="center" style="background:#fff;border:1px solid #e5e5e5;border-radius:6px;overflow:hidden;">
  <tr><td style="background:#111;padding:24px 28px;">
    <div style="font-size:13px;color:rgba(255,255,255,.6);margin-bottom:4px;">Grégoire TAGOT | notaire</div>
    <div style="font-size:20px;color:#fff;font-weight:300;">Questionnaire Acquisition</div>
    <div style="font-size:12px;color:#888;margin-top:4px;">${adresseBien}</div>
  </td></tr>
  <tr><td style="padding:24px 28px;">
    <table width="100%">

      ${sec('ACQUÉREUR')}
      ${row('Mode d\'acquisition', MODE_LABELS[mode] || mode)}
      ${blocAcquereurs}
      ${row('Email', email || '')}

      ${sec('BIEN')}
      ${row('Adresse', adresseBien)}
      ${row('Type', TYPE_BIEN_LABELS[bien.type] || (bien.typeAutre || bien.type))}
      ${depsStr ? row('Dépendances', depsStr) : ''}
      ${row('Copropriété', yesno(bien.copropriete))}
      ${bien.copropriete === 'oui' ? `
        ${row('N° de lot', bien.lotNumero)}
        ${row('Tantièmes', bien.tantiemes)}
        ${row('Syndic', bien.syndic)}` : ''}

      ${sec('PROJET')}
      ${row('Destination', DEST_LABELS[projet.destination] || projet.destination)}
      ${projet.destination === 'investissement_locatif' ? row('Type de location', LOC_LABELS[projet.location] || projet.location) : ''}
      ${row('Division envisagée', yesno(projet.division))}
      ${row('Travaux', yesno(projet.travaux))}
      ${row('Changement de destination', yesno(projet.changementDestination))}

      ${sec('FINANCEMENT')}
      ${row('Prix du bien', financement.prixBien ? financement.prixBien + ' €' : '')}
      ${row('Montant meubles', financement.prixMeubles ? financement.prixMeubles + ' €' : '')}
      ${row('Apport', financement.apportMontant ? financement.apportMontant + ' €' : '')}
      ${row('Origine apport', financement.apportOrigine)}
      ${row('Montant prêt', financement.pretMontant ? financement.pretMontant + ' €' : '')}
      ${row('Durée', financement.pretDuree ? financement.pretDuree + ' ans' : '')}
      ${row('Banque prêteuse', financement.pretBanque)}
      ${row('Taux max souhaité', financement.pretTauxMax)}
      ${condsStr ? row('Conditions suspensives', condsStr) : ''}

      ${sec('ORIGINE DES FONDS (LCB-FT)')}
      ${originesStr ? row('Origines', originesStr) : ''}
      ${fonds.autreOrigine ? row('Précision', fonds.autreOrigine) : ''}
      ${justStr ? row('Justificatifs', justStr) : ''}

      ${revente.applicable === 'oui' ? `
      ${sec('REVENTE D\'UN BIEN')}
      ${row('Bien à vendre', revente.adresse)}
      ${row('Prix estimé', revente.prixEstime ? revente.prixEstime + ' €' : '')}
      ${row('Agence', revente.agence)}
      ${row('Compromis signé', yesno(revente.compromis))}
      ${row('Date prévue de signature', fmtDate(revente.dateSignature))}` : ''}

      ${sec('ASSURANCE ET GARANTIES')}
      ${row('Assurance emprunteur', ASSUR_LABELS[garanties.assuranceEmprunteur] || garanties.assuranceEmprunteur)}
      ${row('Garantie prêt', GAR_LABELS[garanties.typeGarantie] || garanties.typeGarantie)}

      ${sec('FISCALITÉ')}
      ${row('Résidence fiscale', fiscalite.residenceFiscale === 'etranger' ? `Étranger — ${fiscalite.pays || ''}` : 'France')}
      ${row('N° fiscal (NIF)', fiscalite.numeroFiscal)}

      ${sec('COORDONNÉES BANCAIRES')}
      ${row('Banque', banque.banque)}
      ${row('IBAN', banque.iban)}
      ${row('BIC', banque.bic)}

    </table>
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">
    form.tagot.notaires.fr · Grégoire TAGOT | notaire
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  try {
    await brevo().transactionalEmails.sendTransacEmail({
      sender: SENDER,
      to: [{ email: NOTAIRE }],
      replyTo: email ? { email } : undefined,
      subject: `Questionnaire Acquisition — ${nomAcq} — ${adresseBien}`,
      htmlContent
    });
    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Erreur email:', e.message);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi' });
  }
};
