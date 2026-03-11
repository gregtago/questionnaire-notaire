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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { data, email } = req.body || {};
  if (!data || !data.defunt) return res.status(400).json({ error: 'Données manquantes' });

  const { defunt, situation, conjoint, heritiers, dispositions, banques, immobilier, autresActifs, dettes, fiscalite } = data;
  const today = new Date().toLocaleDateString('fr-FR');
  const nomDefunt = [defunt.prenoms, defunt.nom].filter(Boolean).join(' ') || 'Défunt';

  let body = '';

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
    body += sec(`Héritiers (${heritiers.length})`);
    heritiers.forEach((h, i) => {
      if (!h.nom && !h.prenoms) return;
      body += `<tr><td colspan="2" style="padding:10px 0 4px;font-size:12px;font-weight:600;color:#555;">${i+1}. ${[h.prenoms, h.nom].filter(Boolean).join(' ')}</td></tr>`;
      body += row('Lien', LIEN_LABELS[h.lien] || h.lien);
      body += row('Naissance', [fmtDate(h.dateNaissance), h.lieuNaissance].filter(Boolean).join(' — '));
      body += row('Adresse', h.adresse);
      body += row('Téléphone', h.tel);
      body += row('Email', h.email);
    });
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
      <p style="margin:0;font-size:10px;color:#bbb;">Questionnaire complété par : ${email || ''}</p>
    </div>
  </div>
</body></html>`;

  try {
    await brevo().transactionalEmails.sendTransacEmail({
      sender: SENDER,
      to: [{ email: NOTAIRE }],
      subject: `Questionnaire Succession — ${nomDefunt}`,
      htmlContent
    });
  } catch(e) {
    console.error('Erreur email:', e.message);
  }

  res.json({ ok: true });
};
