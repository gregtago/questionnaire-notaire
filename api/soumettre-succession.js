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

const SIT_LABELS = { C:'Célibataire', M:'Marié(e)', P:'Pacsé(e)', D:'Divorcé(e)', V:'Veuf / Veuve' };
const REG_LABELS = {
  communaute_legale: 'Communauté réduite aux acquêts',
  separation: 'Séparation de biens',
  communaute_universelle: 'Communauté universelle',
  participation: 'Participation aux acquêts'
};
const LIEN_LABELS = { enfant:'Enfant', conjoint:'Conjoint(e)', parent:'Parent', frere_soeur:'Frère / Sœur', autre:'Autre' };
const TYPE_CPT = { courant:'Compte courant', livret:'Livret', pea:'PEA', titre:'Compte-titres', autre:'Autre' };
const TYPE_BIEN = { maison:'Maison', appartement:'Appartement', terrain:'Terrain', commerce:'Local commercial', autre:'Autre' };
const TYPE_DON = { manuel:'Don manuel', partage:'Donation-partage', immobilier:'Donation immobilière', assurance_vie:'Assurance-vie', autre:'Autre' };


// ── Génération XML iNot pour le défunt ────────────────
function buildXmlDefunt(defunt, situation) {
  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function v(key, val, nameOverride) {
    const nm = nameOverride || key;
    return `    <Var key="${key}" name="${nm}"><Value>${esc(String(val||''))}</Value></Var>`;
  }
  function toInotDate(d) {
    if (!d) return '';
    // format YYYY-MM-DD (input type=date)
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return m[1]+m[2]+m[3];
    return '';
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
      '91':'Essonne','92':'Hauts-de-Seine','93':'Seine-Saint-Denis','94':'Val-de-Marne',"95":"Val-d'Oise"
    };
    return depts[cp.substring(0,2)] || '';
  }

  const civ = defunt.civilite || '';
  const titre = civ === 'Monsieur' ? 'Monsieur' : 'Madame';
  const codeTitre = civ === 'Monsieur' ? 'M.' : 'MME';
  const accord = civ === 'Monsieur' ? 'M' : 'F';

  const nom = (defunt.nom || '').toUpperCase();
  const nomNaissance = (defunt.nomNaissance || defunt.nom || '').toUpperCase();
  const prenoms = defunt.prenoms || '';
  const prenomUsuel = prenoms.split(/\s+/)[0] || '';

  const adresse = defunt.adresse || '';
  const cp = defunt.cp || '';
  const ville = (defunt.ville || '').toUpperCase();
  const deptDo = deptFromCp(cp);

  const datNa = toInotDate(defunt.dateNaissance);
  const lieuNa = (defunt.lieuNaissance || '').toUpperCase();
  const cpNa = defunt.cpNaissance || '';
  const deptNa = deptFromCp(cpNa);

  const datMor = toInotDate(defunt.dateDeces);
  const lieuMor = defunt.lieuDeces || '';
  const deptMor = lieuMor ? '' : ''; // on n'a pas le CP du lieu de décès

  // Situation familiale du défunt
  const sit = situation.etat || 'C';
  const hasHistory = ['M','D','V','I','P','S'].includes(sit);

  let datMa = '';
  let cpayMa = '';
  let historiqueXml = '    <HistoriqueMarital />';

  if (['M','I','S'].includes(sit)) {
    datMa = toInotDate(situation.dateMariage);
    cpayMa = situation.lieuMariage ? 'FR' : '';
    historiqueXml = `    <HistoriqueMarital><Evenement>
      ${v('COTYMA','M')}
      ${v('DAMAMA', datMa)}
      ${v('LVT1MA', situation.lieuMariage || '')}
      ${v('LNCOMA','')}
      ${v('LPCOMA','')}
      ${v('COCRMA','')}
    </Evenement></HistoriqueMarital>`;
  } else if (sit === 'D') {
    historiqueXml = `    <HistoriqueMarital><Evenement>
      ${v('COTYMA','D')}
      ${v('DAMAMA','')}
      ${v('LVT1MA','')}
      ${v('LNCOMA','')}
      ${v('LPCOMA','')}
      ${v('COCRMA','')}
    </Evenement></HistoriqueMarital>`;
  } else if (sit === 'V') {
    historiqueXml = `    <HistoriqueMarital><Evenement>
      ${v('COTYMA','V')}
      ${v('DAMAMA','')}
      ${v('LVT1MA','')}
      ${v('LNCOMA','')}
      ${v('LPCOMA','')}
      ${v('COCRMA','')}
    </Evenement></HistoriqueMarital>`;
  } else if (sit === 'P') {
    datMa = toInotDate(situation.dateMariage);
    historiqueXml = `    <HistoriqueMarital><Evenement>
      ${v('COTYMA','P')}
      ${v('DAMAMA', datMa)}
      ${v('LVT1MA', situation.lieuMariage || '')}
      ${v('LNCOMA','')}
      ${v('LPCOMA','')}
      ${v('COCRMA','')}
    </Evenement></HistoriqueMarital>`;
  }

  const regime = ['M','I','S','D'].includes(sit) ? (REG_CODE[situation.regimeMatrimonial] || '4') : '';

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<iNova><iNot><Customer><Folder>
  <Person info="">
${v('NUMERO','10000001')}
${v('TYPE','PP')}
${v('ADR1', adresse)}
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
${v('HISTORIQUE', hasHistory ? 'O' : 'N')}
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
${v('PROF', defunt.profession || '')}
${v('DATNA', datNa)}
${v('DEPTNA', deptNa)}
${v('CPAYNA','FRANCE')}
${v('DEPMOR', deptMor)}
${v('NATION', defunt.nationalite || '')}
${v('INCAPABLE','')}
${v('TITRE', titre)}
${v('DATMOR', datMor)}
${v('DATMA', datMa)}
${v('CPAYMA', cpayMa)}
${v('ADR1IMP', adresse)}
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
  </Person>
</Folder></Customer></iNot></iNova>`;

  return xml;
}

// Correspondance régime matrimonial
const REG_CODE = {
  communaute_legale: '4',
  separation: '33',
  communaute_universelle: '32',
  participation: '35'
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { data, email, pieces } = req.body || {};
  if (!data || !data.defunt) return res.status(400).json({ error: 'Données manquantes' });

  const { declarant, defunt, situation, conjoint, heritiers, dispositions, banques, immobilier, autresActifs, dettes, fiscalite } = data;
  const today = new Date().toLocaleDateString('fr-FR');
  const nomDefunt = [defunt.prenoms, defunt.nom].filter(Boolean).join(' ') || 'Défunt';

  let body = '';

  // ── Déclarant ───────────────────────────────────────────
  if (declarant && (declarant.nom || declarant.prenom)) {
    body += sec('Questionnaire rempli par');
    body += row('Nom / Prénom', [declarant.nom, declarant.prenom].filter(Boolean).join(' '));
    body += row('Email', email || '');
  }

  // ── Section 1 : Défunt ──────────────────────────────────
  body += sec('Personne décédée');
  body += row('Nom', defunt.nom);
  if (defunt.nomNaissance && defunt.nomNaissance !== defunt.nom) body += row('Nom de naissance', defunt.nomNaissance);
  body += row('Prénoms', defunt.prenoms);
  body += row('Naissance', [fmtDate(defunt.dateNaissance), defunt.lieuNaissance].filter(Boolean).join(' — '));
  body += row('Nationalité', defunt.nationalite);
  body += row('Profession', defunt.profession);
  body += row('N° sécurité sociale', defunt.numSecu);
  body += row('Date du décès', fmtDate(defunt.dateDeces));
  body += row('Lieu du décès', defunt.lieuDeces);
  body += row('Dernière adresse', defunt.adresse);

  // ── Section 2 : Situation familiale ────────────────────
  body += sec('Situation familiale');
  body += row('Situation', SIT_LABELS[situation.etat] || situation.etat);
  if (['M','P'].includes(situation.etat)) {
    body += row('Date mariage / PACS', fmtDate(situation.dateMariage));
    body += row('Lieu', situation.lieuMariage);
    body += row('Contrat de mariage', yesno(situation.contratMariage));
    body += row('Régime matrimonial', REG_LABELS[situation.regimeMatrimonial] || situation.regimeMatrimonial);
    body += row('Notaire du contrat', situation.notaireContrat);
  }

  // ── Section 3 : Conjoint ───────────────────────────────
  if (['M','P'].includes(situation.etat) && (conjoint.nom || conjoint.prenoms)) {
    body += sec('Conjoint / Partenaire survivant');
    body += row('Nom', conjoint.nom);
    body += row('Prénoms', conjoint.prenoms);
    body += row('Naissance', [fmtDate(conjoint.dateNaissance), conjoint.lieuNaissance].filter(Boolean).join(' — '));
    body += row('Nationalité', conjoint.nationalite);
    body += row('Profession', conjoint.profession);
    body += row('Adresse', conjoint.adresse);
    body += row('Téléphone', conjoint.tel);
    body += row('Email', conjoint.email);
  }

  // ── Section 4 : Héritiers ──────────────────────────────
  if (heritiers && heritiers.length) {
    const heritiersFiltres = heritiers.filter(h => h.nom || h.prenom);
    if (heritiersFiltres.length) {
      body += sec(`Héritiers (${heritiersFiltres.length})`);
      heritiersFiltres.forEach((h, i) => {
        const lienLabel = LIEN_LABELS[h.lien] || h.lien || '';
        const nomComplet = [h.prenom, h.nom].filter(Boolean).join(' ');
        body += row(`${i+1}. ${nomComplet}`, lienLabel);
      });
    }
  }

  // ── Section 5 : Dispositions ───────────────────────────
  body += sec('Dispositions');
  body += row('Testament', yesno(dispositions.testament));
  body += row('Donation entre époux', yesno(dispositions.donationEntreEpoux));
  body += row('Donations antérieures', yesno(dispositions.donationsAnterieures));
  if (dispositions.donations && dispositions.donations.length) {
    dispositions.donations.forEach((don, i) => {
      body += `<tr><td colspan="2" style="padding:6px 0 2px;font-size:12px;font-weight:600;color:#555;">Donation ${i+1}</td></tr>`;
      body += row('Date', fmtDate(don.date));
      body += row('Montant', don.montant);
      body += row('Bénéficiaire', don.beneficiaire);
      body += row('Type', TYPE_DON[don.type] || don.type);
    });
  }

  // ── Section 6 : Banques ────────────────────────────────
  if (banques.comptes && banques.comptes.length) {
    body += sec('Comptes bancaires');
    banques.comptes.forEach((c, i) => {
      if (!c.banque) return;
      body += row(`Compte ${i+1}`, [c.banque, c.ville, TYPE_CPT[c.type] || c.type].filter(Boolean).join(' — '));
    });
    body += row('Coffre-fort', yesno(banques.coffreFort));
    body += row('Assurance-vie', yesno(banques.assuranceVie));
  }

  // ── Section 7 : Immobilier ─────────────────────────────
  if (immobilier.biens && immobilier.biens.length) {
    body += sec('Biens immobiliers');
    immobilier.biens.forEach((b, i) => {
      if (!b.adresse) return;
      body += `<tr><td colspan="2" style="padding:8px 0 2px;font-size:12px;font-weight:600;color:#555;">Bien ${i+1} — ${TYPE_BIEN[b.type] || b.type || ''}</td></tr>`;
      body += row('Adresse', b.adresse);
      body += row('Quote-part', b.quotePart);
      body += row('Valeur estimée', b.valeur);
      body += row('Loué', yesno(b.loue));
    });
  }

  // ── Section 8 : Autres actifs ──────────────────────────
  const aaItems = [
    ['vehicules','Véhicules'], ['partsSociete','Parts de société'],
    ['crypto','Cryptomonnaies'], ['oeuvres','Œuvres / objets de valeur'],
    ['fondsCommerce','Fonds de commerce']
  ];
  const hasAA = aaItems.some(([k]) => autresActifs[k] === 'oui');
  if (hasAA) {
    body += sec('Autres actifs');
    aaItems.forEach(([key, label]) => {
      if (autresActifs[key] === 'oui') body += row(label, autresActifs[key+'Detail'] || 'Oui');
      else if (autresActifs[key] === 'non') body += row(label, 'Non');
    });
  }

  // ── Section 9 : Dettes ─────────────────────────────────
  const detItems = [
    ['emprunts','Emprunts'], ['caution','Caution'],
    ['factures','Factures impayées'], ['redressement','Redressement fiscal']
  ];
  const hasDettes = detItems.some(([k]) => dettes[k] === 'oui');
  if (hasDettes) {
    body += sec('Dettes et passif');
    detItems.forEach(([key, label]) => {
      if (dettes[key] === 'oui') body += row(label, dettes[key+'Detail'] || 'Oui');
      else if (dettes[key] === 'non') body += row(label, 'Non');
    });
  }

  // ── Section 10 : Fiscalité ─────────────────────────────
  body += sec('Fiscalité');
  body += row('Impôt sur le revenu', yesno(fiscalite.ir) + (fiscalite.irDetail ? ` — ${fiscalite.irDetail}` : ''));
  body += row('IFI', yesno(fiscalite.ifi) + (fiscalite.ifiDetail ? ` — ${fiscalite.ifiDetail}` : ''));
  body += row('Taxes locales', yesno(fiscalite.taxesLocales) + (fiscalite.taxesLocalesDetail ? ` — ${fiscalite.taxesLocalesDetail}` : ''));

  // ── HTML complet ───────────────────────────────────────
  const htmlContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT&nbsp;|&nbsp;notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Questionnaire Succession</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Reçu le ${today} — ${nomDefunt}</div>
    </div>
    <div style="padding:28px 30px;">
      <table style="width:100%;border-collapse:collapse;">${body}</table>
    </div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Questionnaire Succession — form.tagot.notaires.fr</p>
    </div>
  </div>
</body></html>`;

  // Génération XML iNot pour le défunt
  let attachment = undefined;
  try {
    const xml = buildXmlDefunt(defunt, situation);
    const slug = (defunt.nom || 'defunt').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
    const filename = `import_inot_${slug}.XML`;
    attachment = [{ name: filename, content: Buffer.from(xml).toString('base64') }];
  } catch(e) {
    console.error('Erreur XML:', e.message);
  }

  try {
    await transporter().sendMail({
      from: FROM,
      to: NOTAIRE,
      subject: `Questionnaire Succession — ${nomDefunt}`,
      html: htmlContent,
      ...(attachment ? { attachments: [{ filename: attachment[0].name, content: Buffer.from(attachment[0].content, 'base64'), contentType: 'text/xml' }] } : {})
    });
  } catch(e) {
    console.error('Erreur email étude:', e.message);
  }

  // ── Email client — liste de pièces ──────────────────────────────────────
  if (email && pieces && pieces.length) {
    const nomDefuntShort = [defunt.prenoms, defunt.nom].filter(Boolean).join(' ') || 'le défunt';
    const piecesHtml = pieces.map(s => `
      <tr><td colspan="2" style="padding:14px 0 4px;font-size:10px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.06em;border-top:1px solid #eee;">${s.section}</td></tr>
      ${s.pieces.map(p => `<tr><td style="padding:5px 0 5px 12px;font-size:13px;color:#444;border-bottom:1px solid #f8f8f8;">→ ${p}</td></tr>`).join('')}
    `).join('');

    const clientHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT | notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Succession — pièces à fournir</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">${nomDefuntShort}</div>
    </div>
    <div style="padding:28px 30px;">
      <p style="font-size:14px;color:#555;margin:0 0 20px;">Bonjour,<br><br>Suite à votre questionnaire, voici la liste des pièces à nous faire parvenir pour le dossier de succession de <strong>${nomDefuntShort}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;">${piecesHtml}</table>
      <p style="font-size:12px;color:#999;margin-top:24px;">Vous pouvez nous les adresser par email à <a href="mailto:office@tagot.notaires.fr" style="color:#555;">office@tagot.notaires.fr</a> ou les déposer directement à l'étude.</p>
    </div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <p style="margin:0;font-size:10px;color:#bbb;">Grégoire TAGOT | notaire — 2 rue Dante, 75005 Paris</p>
      <p style="margin:0;font-size:10px;color:#bbb;">tagot.notaires.fr</p>
    </div>
  </div>
</body></html>`;

    try {
      await transporter().sendMail({
        from: FROM,
        to: email,
        subject: `Succession ${nomDefuntShort} — pièces à fournir`,
        html: clientHtml,
      });
    } catch(e) {
      console.error('Erreur email client:', e.message);
    }
  }

  res.json({ ok: true });
};
