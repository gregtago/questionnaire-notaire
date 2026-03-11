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
  if (v === 'inconnu') return 'Non renseigné';
  return v || '';
}

const REG_LABELS = {
  communaute_legale: 'Communauté réduite aux acquêts (régime légal)',
  separation: 'Séparation de biens',
  communaute_universelle: 'Communauté universelle',
  participation: 'Participation aux acquêts'
};
const REG_CODE = { communaute_legale:'4', separation:'33', communaute_universelle:'32', participation:'35' };

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

// ── XML iNot ──────────────────────────────────────────────
function buildXmlEpoux(epoux, numero, etatMarital) {
  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function v(key, val, nameOverride) {
    return `    <Var key="${key}" name="${nameOverride || key}"><Value>${esc(String(val || ''))}</Value></Var>`;
  }
  function toInotDate(d) {
    if (!d) return '';
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? m[1]+m[2]+m[3] : '';
  }
  function deptFromCp(cp) {
    if (!cp) return '';
    const depts = {
      '01':'Ain','02':'Aisne','03':'Allier','04':'Alpes-de-Haute-Provence','05':'Hautes-Alpes',
      '06':'Alpes-Maritimes','07':'Ardèche','08':'Ardennes','09':'Ariège','10':'Aube',
      '11':'Aude','12':'Aveyron','13':'Bouches-du-Rhône','14':'Calvados','15':'Cantal',
      '16':'Charente','17':'Charente-Maritime','18':'Cher','19':'Corrèze','20':'Corse',
      '21':"Côte-d'Or",'22':"Côtes-d'Armor",'23':'Creuse','24':'Dordogne','25':'Doubs',
      '26':'Drôme','27':'Eure','28':'Eure-et-Loir','29':'Finistère','30':'Gard',
      '31':'Haute-Garonne','32':'Gers','33':'Gironde','34':'Hérault','35':'Ille-et-Vilaine',
      '36':'Indre','37':'Indre-et-Loire','38':'Isère','39':'Jura','40':'Landes',
      '41':'Loir-et-Cher','42':'Loire','43':'Haute-Loire','44':'Loire-Atlantique','45':'Loiret',
      '46':'Lot','47':'Lot-et-Garonne','48':'Lozère','49':'Maine-et-Loire','50':'Manche',
      '51':'Marne','52':'Haute-Marne','53':'Mayenne','54':'Meurthe-et-Moselle','55':'Meuse',
      '56':'Morbihan','57':'Moselle','58':'Nièvre','59':'Nord','60':'Oise',
      '61':'Orne','62':'Pas-de-Calais','63':'Puy-de-Dôme','64':'Pyrénées-Atlantiques','65':'Hautes-Pyrénées',
      '66':'Pyrénées-Orientales','67':'Bas-Rhin','68':'Haut-Rhin','69':'Rhône','70':'Haute-Saône',
      '71':'Saône-et-Loire','72':'Sarthe','73':'Savoie','74':'Haute-Savoie','75':'Paris',
      '76':'Seine-Maritime','77':'Seine-et-Marne','78':'Yvelines','79':'Deux-Sèvres','80':'Somme',
      '81':'Tarn','82':'Tarn-et-Garonne','83':'Var','84':'Vaucluse','85':'Vendée',
      '86':'Vienne','87':'Haute-Vienne','88':'Vosges','89':'Yonne','90':'Territoire de Belfort',
      '91':'Essonne','92':'Hauts-de-Seine','93':'Seine-Saint-Denis','94':'Val-de-Marne','95':"Val-d'Oise"
    };
    return depts[cp.substring(0,2)] || '';
  }

  const civ = epoux.civilite || '';
  const titre = civ === 'Monsieur' ? 'Monsieur' : 'Madame';
  const codeTitre = civ === 'Monsieur' ? 'M.' : 'MME';
  const accord = civ === 'Monsieur' ? 'M' : 'F';

  const nom = (epoux.nom || '').toUpperCase();
  const nomNaissance = (epoux.nomNaissance || epoux.nom || '').toUpperCase();
  const prenoms = epoux.prenoms || '';
  const prenomUsuel = prenoms.split(/\s+/)[0] || '';

  const cp = epoux.cp || '';
  const ville = (epoux.ville || '').toUpperCase();
  const deptDo = deptFromCp(cp);
  const datNa = toInotDate(epoux.dateNaissance);
  const lieuNa = (epoux.lieuNaissance || '').toUpperCase();
  const cpNa = epoux.cpNaissance || '';
  const deptNa = deptFromCp(cpNa);

  // En instance de divorce → ETAT = I
  const sit = etatMarital || 'I';
  const hasHistory = true; // les époux étaient mariés

  // HistoriqueMarital : mariage en cours (→ en instance)
  const datMa = toInotDate((etatMarital === 'I' || etatMarital === 'M') ? epoux._dateMariage : '');
  const historiqueXml = `    <HistoriqueMarital><Evenement>
      ${v('COTYMA','M')}
      ${v('DAMAMA', datMa)}
      ${v('LVT1MA', epoux._lieuMariage || '')}
      ${v('LNCOMA','')}
      ${v('LPCOMA','')}
      ${v('COCRMA','')}
    </Evenement></HistoriqueMarital>`;

  const regime = REG_CODE[epoux._regime] || '4';

  return `  <Person info="">
${v('NUMERO', numero)}
${v('TYPE','PP')}
${v('ADR1', epoux.adresse || '')}
${v('ADR2','')}
${v('ADR3', cp)}
${v('ADR4', ville)}
${v('RCS','')}
${v('VILRCS','')}
${v('CPRCS','')}
${v('CPAYRCS','')}
${v('NUMMB','')}
${v('IDENMB','')}
${v('ACCORD', accord)}
${v('ADR1MB','')}
${v('ADR2MB','')}
${v('CPMB','')}
${v('VILLEMB','')}
${v('PRESENCE','')}
${v('INTCONJ','')}
${v('PRECONJ','')}
${v('JODATE','')}
${v('CPVILMA','')}
${v('NOTMA','')}
${v('HISTORIQUE','O')}
${v('INTCONJPURIEL','')}
${v('CODCRU','')}
${v('LVDCRU','')}
${v('CPSTAT','')}
${v('PREFDAT','')}
${v('DEPTDO', deptDo)}
${v('CPAYDO','FRANCE')}
${v('CONJ','')}
${v('ETAT', sit)}
${v('CODETITRE', codeTitre, 'CIVILITY')}
${v('NOMU', nom)}
${v('PRENOMU', prenomUsuel)}
${v('PRENOM', prenoms)}
${v('PROF', epoux.profession || '')}
${v('DATNA', datNa)}
${v('DEPTNA', deptNa)}
${v('CPAYNA','FRANCE')}
${v('DEPMOR','')}
${v('NATION', epoux.nationalite || '')}
${v('INCAPABLE','')}
${v('TITRE', titre)}
${v('DATMOR','')}
${v('DATMA', datMa)}
${v('CPAYMA', datMa ? 'FR' : '')}
${v('ADR1IMP', epoux.adresse || '')}
${v('ADR2IMP','')}
${v('CPIMP', cp)}
${v('VILLEIMP', ville)}
${v('CODERU', cpNa)}
${v('LVNARU', lieuNa)}
${v('NOM', nomNaissance)}
${v('REGIME', regime)}
${v('DATCONTR','')}
${v('DATAN','')}
${v('DATDECL','')}
${v('DATHOM','')}
${v('TGIME','')}
${v('REGPRE','')}
${v('LIEME','')}
${v('NOTME','')}
${v('NOPME','')}
${historiqueXml}
  </Person>`;
}

function buildXml(data) {
  const { epoux1, epoux2, mariage } = data;
  // Enrichir les époux avec les données mariage
  const e1 = Object.assign({}, epoux1, { _dateMariage: mariage.date, _lieuMariage: mariage.lieu, _regime: mariage.regimeMatrimonial });
  const e2 = Object.assign({}, epoux2, { _dateMariage: mariage.date, _lieuMariage: mariage.lieu, _regime: mariage.regimeMatrimonial });

  const p1 = buildXmlEpoux(e1, '10000001', 'I');
  const p2 = buildXmlEpoux(e2, '10000002', 'I');

  return `<?xml version="1.0" encoding="utf-8"?>
<iNova><iNot><Customer><Folder>
${p1}
${p2}
</Folder></Customer></iNot></iNova>`;
}

// ── Handler ───────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { data, email } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Données manquantes' });

  const e1 = data.epoux1 || {};
  const e2 = data.epoux2 || {};
  const nomEpoux = [e1.nom, 'et', e2.nom].filter(Boolean).join(' ');

  const htmlContent = buildEmail(data);

  // XML iNot
  let attachment;
  try {
    const xml = buildXml(data);
    const slug1 = (e1.nom || 'epoux1').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
    const slug2 = (e2.nom || 'epoux2').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
    attachment = [{ name: `import_inot_${slug1}_${slug2}.XML`, content: Buffer.from(xml).toString('base64') }];
  } catch(e) {
    console.error('Erreur XML:', e.message);
  }

  try {
    await brevo().transactionalEmails.sendTransacEmail({
      sender: SENDER,
      to: [{ email: NOTAIRE }],
      replyTo: email ? { email } : undefined,
      subject: `Questionnaire Divorce — ${nomEpoux}`,
      htmlContent,
      ...(attachment ? { attachment } : {})
    });
    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Erreur email:', e.message);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi' });
  }
};
