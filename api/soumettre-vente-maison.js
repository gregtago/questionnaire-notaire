const { BrevoClient } = require('@getbrevo/brevo');

const SENDER  = { name: 'Grégoire TAGOT | notaire', email: process.env.SENDER_EMAIL || 'gregoire@tagot.fr' };
const NOTAIRE = process.env.NOTAIRE_EMAIL || 'gregoire@tagot.fr';

function brevo() { return new BrevoClient({ apiKey: process.env.BREVO_API_KEY }); }

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

  const { data, email } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Données manquantes' });

  const { vendeur1, vendeur2, nbVendeurs, bien, terrain, assainissement,
          construction, equipements, prets, plusvalue, fiscalite, motivation } = data;

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
    <div style="font-size:20px;color:#fff;font-weight:300;">Questionnaire — Vente d'une maison</div>
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
      ${row('Situation jour de vente', bien.situationJour === 'libre' ? 'Libre de toute occupation' : bien.situationJour === 'loue' ? 'Louée' : '')}
      ${bien.situationJour === 'loue' ? `
        ${row('Loyer mensuel', bien.bail.loyer ? bien.bail.loyer + ' €' : '')}
        ${row('Dépôt de garantie', bien.bail.depotGarantie ? bien.bail.depotGarantie + ' €' : '')}
        ${row('Date du congé', bien.bail.dateConge || '')}` : ''}
      ${row('Louée précédemment', yesno(bien.locatairePrecedent))}

      ${sec('TERRAIN')}
      ${row('Lotissement', yesno(terrain.lotissement))}
      ${terrain.lotissement === 'oui' ? `
        ${row('ASL en activité', yesno(terrain.asl))}
        ${terrain.asl === 'oui' ? row('Président ASL', terrain.aslPresident) : ''}` : ''}
      ${row('Copropriété horizontale', yesno(terrain.coproHorizontale))}
      ${terrain.coproHorizontale === 'oui' ? row('Syndic', terrain.syndicNom) : ''}
      ${row('PV de bornage', yesno(terrain.bornage))}
      ${row('Terrain attenant (10 dernières années)', yesno(terrain.terrainAttenant))}
      ${row('Terrain boisé', yesno(terrain.terrainBoise))}
      ${row('Terrain en pente', yesno(terrain.terrainPente))}
      ${row('Activités polluantes exploitées', yesno(terrain.pollutionExploitation))}
      ${row('Pollution passée / dépôts déchets', yesno(terrain.pollutionPasse))}
      ${row('Pollution dans le voisinage', yesno(terrain.pollutionVoisinage))}
      ${row('Carrières souterraines', yesno(terrain.carrieres))}
      ${row('Zone inondable', yesno(terrain.zoneInondable))}
      ${row('Servitudes', yesno(terrain.servitudes))}
      ${terrain.servitudes === 'oui' ? row('Nature des servitudes', terrain.servitudesDetail) : ''}
      ${row('Mur séparatif', yesno(terrain.murSeparatif))}
      ${terrain.murSeparatif === 'oui' ? row('Entretien du mur', terrain.murEntretien) : ''}

      ${sec('ASSAINISSEMENT')}
      ${row('Système individuel', yesno(assainissement.systemeIndividuel))}
      ${assainissement.systemeIndividuel === 'oui' ? row('Date dernière vidange', assainissement.dateVidange) : ''}
      ${row('Tout-à-l\'égout', yesno(assainissement.toutEgout))}
      ${assainissement.toutEgout === 'oui' ? `
        ${row('Connexion réseau effectuée', yesno(assainissement.connexionReseau))}
        ${row('Taxe raccordement acquittée', yesno(assainissement.taxeRaccordement))}
        ${row('Installation en bon état', yesno(assainissement.bonEtat))}` : ''}
      ${row('Mise en demeure de travaux', yesno(assainissement.miseDemeureTravaux))}
      ${row('Eaux pluviales séparées', yesno(assainissement.eauxPluvialesSeparees))}

      ${sec('CONSTRUCTION ET TRAVAUX')}
      ${row('A fait construire', yesno(construction.aFaitConstruire))}
      ${construction.aFaitConstruire === 'oui' ? `
        ${row('Achevé depuis moins de 10 ans', yesno(construction.moinsde10ans))}
        ${construction.moinsde10ans === 'oui' ? row('Assurance dommage-ouvrage', yesno(construction.dommageOuvrage)) : ''}
        ${row('Achevé depuis moins de 5 ans', yesno(construction.moinsde5ans))}
        ${row('Taxes fiscales acquittées', yesno(construction.taxesFiscales))}
        ${row('Prescriptions particulières PC', yesno(construction.prescriptionsPC))}
        ${construction.prescriptionsPC === 'oui' ? row('Détail', construction.prescriptionsDetail) : ''}` : ''}
      ${row('Travaux postérieurs à la construction', yesno(construction.travauxPosterieur))}
      ${construction.travauxPosterieur === 'oui' ? row('Permis / déclaration de travaux', yesno(construction.travauxPermis)) : ''}
      ${row('Déclaration cadastre déposée', yesno(construction.declarationCadastre))}

      ${sec('ÉQUIPEMENTS')}
      ${row('Cuve à mazout', yesno(equipements.cuveMazout))}
      ${row('Gaz de ville', yesno(equipements.gazVille))}
      ${row('Citerne à gaz', yesno(equipements.citerne))}
      ${equipements.citerne === 'oui' ? `
        ${row('Statut citerne', equipements.citerneProprietaire === 'oui' ? 'Propriétaire' : equipements.citerneLocataire === 'oui' ? 'Locataire' : '')}
        ${equipements.citerneLocataire === 'oui' ? row('Société citerne', equipements.citerneCoord) : ''}` : ''}
      ${row('Équip. récupération eau de pluie', yesno(equipements.recuperationEauPluie))}
      ${row('Réservoir eau de pluie', yesno(equipements.reservoirEauPluie))}
      ${row('Distribution eau de pluie', yesno(equipements.distributionEauPluie))}
      ${(equipements.recuperationEauPluie === 'oui' || equipements.reservoirEauPluie === 'oui' || equipements.distributionEauPluie === 'oui') ? `
        ${row('Plaque signalisation', yesno(equipements.plaqueSignalisation))}
        ${row('Carnet sanitaire', yesno(equipements.carnetSanitaire))}
        ${row('Dernier entretien réseau', equipements.dernierEntretienReseau)}` : ''}
      ${row('Contrat d\'affichage', yesno(equipements.contratAffichage))}
      ${row('Équipements sous garantie', yesno(equipements.garantiesEquipements))}
      ${row('Installation classée (ICPE)', yesno(equipements.installationClassee))}
      ${equipements.installationClassee === 'oui' ? row('Exploitant', yesno(equipements.exploitant)) : ''}

      ${sec('PRÊTS ET HYPOTHÈQUES')}
      ${row('Saisie immobilière en cours', yesno(prets.saisieImmobiliere))}
      ${row('Prêt(s) avec hypothèque', yesno(prets.pretHypotheque))}
      ${prets.pretHypotheque === 'oui' ? row('Référence(s) prêt', prets.pretDetail) : ''}
      ${row('Crédit-relais', yesno(prets.creditRelais))}

      ${sec('PLUS-VALUES')}
      ${row('Résidence principale', yesno(plusvalue.residencePrincipale))}
      ${plusvalue.residencePrincipale === 'oui' ? row('Depuis', plusvalue.depuisQuand) : ''}
      ${plusvalue.residencePrincipale === 'non' ? `
        ${row('Remploi résidence principale', yesno(plusvalue.remploi))}
        ${row('Retraité / invalide modeste', yesno(plusvalue.retraiteInvalide))}
        ${row('Travaux surélévation / amélioration', yesno(plusvalue.travauxSurelevation))}
        ${row('Droits de mutation payés', yesno(plusvalue.droitsMutation))}` : ''}
      ${row('Sinistre catnat avant acquisition', yesno(plusvalue.sinisstreAvant))}
      ${row('Sinistre catnat depuis acquisition', yesno(plusvalue.sinistreDepuis))}

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
    await brevo().transactionalEmails.sendTransacEmail({
      sender: SENDER,
      to: [{ email: NOTAIRE }],
      replyTo: email ? { email } : undefined,
      subject: `Questionnaire Vente maison — ${nomV1}${nomV2 ? ' / ' + nomV2 : ''} — ${adresse}`,
      htmlContent
    });
    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Erreur email:', e.message);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi' });
  }
};
