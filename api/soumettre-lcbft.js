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

const QUALITE_LABELS = { ACQ:'Acquéreur', VEN:'Vendeur', REP:'Représentant / mandataire', AUT:'Autre' };
const SOURCE_LABELS = {
  epargne: 'Épargne personnelle (revenus professionnels, économies)',
  vente: "Vente d'un bien immobilier",
  succession: 'Succession ou donation',
  pret: 'Prêt bancaire',
  titres: 'Cession de titres ou valeurs mobilières',
  indem: 'Indemnité (assurance, licenciement…)',
  autre: 'Autre origine',
};
const PIECE_LABELS = {
  releves: 'Relevés bancaires',
  pret: 'Attestation ou offre de prêt',
  acte: 'Acte de vente (bien précédent)',
  succ: 'Attestation de donation ou de succession',
  autre: 'Autres pièces',
};
const OBJET_LABELS = {
  residence_principale: 'Résidence principale',
  residence_secondaire: 'Résidence secondaire',
  investissement_locatif: 'Investissement locatif',
  transmission_familiale: 'Transmission familiale',
  activite_professionnelle: 'Usage professionnel / activité',
  autre: 'Autre',
};
const ON = { O: 'Oui', N: 'Non' };

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('fr-FR'); } catch { return d; }
}
function fmtMontant(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (isNaN(n)) return v;
  return n.toLocaleString('fr-FR') + ' €';
}
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function row(label, value) {
  if (value === '' || value === null || value === undefined) return '';
  return `<tr>
    <td style="padding:5px 14px 5px 0;font-size:12px;color:#888;white-space:nowrap;vertical-align:top;width:40%;">${esc(label)}</td>
    <td style="padding:5px 0;font-size:13px;color:#111;vertical-align:top;">${esc(value)}</td>
  </tr>`;
}
function sec(title) {
  return `<tr><td colspan="2" style="padding:20px 0 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#bbb;font-weight:bold;border-top:1px solid #eee;">${esc(title)}</td></tr>`;
}

function buildEmailNotaire(p) {
  const id = p.identite;
  const ppe = p.ppe;
  const op = p.operation;
  const pm = p.personneMorale;
  const fonds = p.origineFonds;
  const ctx = p.contexte;
  const sig = p.signature;

  const nomComplet = `${id.civilite || ''} ${id.nom || ''} ${id.prenoms || ''}`.trim();

  let rows = '';
  rows += sec('Identité du déclarant');
  const qLabel = QUALITE_LABELS[id.qualite] || id.qualite;
  rows += row('Qualité', [qLabel, id.qualiteAutre].filter(Boolean).join(' — '));
  rows += row('Civilité', id.civilite);
  rows += row('Nom de naissance', id.nom);
  if (id.nomUsage && id.nomUsage !== id.nom) rows += row("Nom d'usage", id.nomUsage);
  rows += row('Prénoms', id.prenoms);
  rows += row('Naissance', [fmtDate(id.dateNaissance), id.lieuNaissance].filter(Boolean).join(' — '));
  rows += row('Nationalité', id.nationalite);
  rows += row('Adresse', id.adresse);
  rows += row('Profession', id.profession);

  rows += sec('Personne politiquement exposée (PPE)');
  rows += row('Le déclarant est-il PPE ?', ON[ppe.self] + (ppe.self === 'O' && ppe.selfFonction ? ` — ${ppe.selfFonction}` : ''));
  rows += row('Un proche familial PPE ?', ON[ppe.famille] + (ppe.famille === 'O' && ppe.familleFonction ? ` — ${ppe.familleFonction}` : ''));
  rows += row("Proche collaborateur d'une PPE ?", ON[ppe.collaborateur] + (ppe.collaborateur === 'O' && ppe.collaborateurFonction ? ` — ${ppe.collaborateurFonction}` : ''));

  rows += sec('Opération concernée');
  rows += row('Nature', [op.nature, op.natureAutre].filter(Boolean).join(' — '));
  rows += row('Description', op.description);
  rows += row('Prix / montant', fmtMontant(op.prix));
  rows += row('Date prévisionnelle', fmtDate(op.datePrevisionnelle));

  if (pm.existe === 'O') {
    rows += sec('Personne morale impliquée');
    rows += row('Dénomination', pm.denomination);
    rows += row('Forme juridique', pm.forme);
    rows += row('SIREN / SIRET', pm.siren);
    rows += row('Siège social', pm.siege);
    if (pm.beneficiairesEffectifs && pm.beneficiairesEffectifs.length) {
      pm.beneficiairesEffectifs.forEach((be, i) => {
        rows += `<tr><td colspan="2" style="padding:12px 0 4px;font-size:11px;color:#666;font-weight:600;">Bénéficiaire effectif #${i+1}</td></tr>`;
        rows += row('Nom / Prénom', `${be.nom || ''} ${be.prenom || ''}`.trim());
        rows += row('Naissance', [fmtDate(be.dateNaiss), be.lieuNaiss].filter(Boolean).join(' — '));
        rows += row('Nationalité', be.nationalite);
        rows += row('Détention', be.detention ? `${be.detention} %` : '');
        rows += row('Adresse', be.adresse);
      });
    }
  } else {
    rows += sec('Personne morale impliquée');
    rows += row('Personne morale', 'Non');
  }

  rows += sec('Origine des fonds');
  const sourcesLabels = (fonds.sources || []).map(s => SOURCE_LABELS[s] || s).join(' ; ');
  rows += row('Sources déclarées', sourcesLabels);
  rows += row("Précision — vente d'un bien", fonds.venteDetail);
  rows += row('Précision — succession / donation', fonds.successionDetail);
  rows += row('Établissement prêteur', fonds.pretEtablissement);
  rows += row('Précision — autre origine', fonds.autreDetail);
  rows += row('Montant fonds personnels', fmtMontant(fonds.montantApport));
  rows += row('Montant du prêt', fmtMontant(fonds.montantPret));

  rows += sec('Objet & contexte de l\'opération');
  rows += row('Objet', [OBJET_LABELS[ctx.objet] || ctx.objet, ctx.objetAutre].filter(Boolean).join(' — '));
  rows += row('Cohérence avec la situation ?', ON[ctx.coherence] + (ctx.coherence === 'N' && ctx.coherenceTxt ? ` — ${ctx.coherenceTxt}` : ''));
  rows += row('Agit pour un tiers ?', ON[ctx.pourTiers] + (ctx.pourTiers === 'O' && ctx.tiersTxt ? ` — ${ctx.tiersTxt}` : ''));
  rows += row("Fonds provenant de l'étranger ?", ON[ctx.fondsEtranger] + (ctx.fondsEtranger === 'O' && ctx.etrangerTxt ? ` — ${ctx.etrangerTxt}` : ''));

  rows += sec('Pièces justificatives');
  const piecesLabels = (p.pieces || []).map(k => PIECE_LABELS[k] || k).join(' ; ');
  rows += row('Pièces cochées', piecesLabels || '—');
  rows += row('Autres pièces', p.piecesAutreTxt);

  rows += sec('Signature');
  rows += row('Mention manuscrite', sig.mention);
  rows += row('Fait à', sig.faitA);
  rows += row('Le', fmtDate(sig.faitLe));
  rows += row('Email de connexion', p.email);

  const today = new Date().toLocaleDateString('fr-FR');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:640px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT&nbsp;|&nbsp;notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Questionnaire LCB-FT</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Reçu le ${today} — ${esc(nomComplet)}</div>
    </div>
    <div style="padding:28px 30px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr><td colspan="2" style="padding-bottom:6px;"><strong style="font-size:15px;color:#111;">${esc(nomComplet)}</strong></td></tr>
        ${rows}
      </table>
    </div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Attestation sur l'honneur d'origine des fonds — art. L.561-5 et s. du Code monétaire et financier.</p>
    </div>
  </div>
</body></html>`;
}

function buildEmailClient(p) {
  const id = p.identite;
  const op = p.operation;
  const fonds = p.origineFonds;
  const sig = p.signature;
  const today = new Date().toLocaleDateString('fr-FR');
  const prenomClient = id.prenoms || '';
  const sourcesLabels = (fonds.sources || []).map(s => SOURCE_LABELS[s] || s).join(', ');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT&nbsp;|&nbsp;notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Attestation LCB-FT reçue</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Récapitulatif — ${today}</div>
    </div>
    <div style="padding:32px 30px;">
      <p style="font-size:14px;color:#333;margin:0 0 18px;">Bonjour ${esc(prenomClient)},</p>
      <p style="font-size:14px;color:#555;margin:0 0 20px;line-height:1.6;">
        Nous avons bien reçu votre attestation sur l'honneur d'origine des fonds.
        Vous trouverez ci-dessous un récapitulatif des informations que vous nous avez transmises.
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;">
        ${row('Déclarant', `${id.civilite || ''} ${id.prenoms || ''} ${id.nom || ''}`.trim())}
        ${row('Opération', op.description)}
        ${row('Prix / montant', fmtMontant(op.prix))}
        ${row('Origine des fonds', sourcesLabels)}
        ${row('Fonds personnels', fmtMontant(fonds.montantApport))}
        ${row('Montant du prêt', fmtMontant(fonds.montantPret))}
        ${row('Fait à / le', [sig.faitA, fmtDate(sig.faitLe)].filter(Boolean).join(' — '))}
      </table>
      <p style="font-size:13px;color:#555;margin:28px 0 0;line-height:1.6;">
        Conformément à vos engagements, nous pourrons être amenés à vous solliciter pour obtenir les pièces justificatives correspondantes (relevés bancaires, acte de vente, attestation bancaire, etc.).
      </p>
      <p style="font-size:12px;color:#888;margin:28px 0 0;line-height:1.6;border-top:1px solid #eee;padding-top:18px;">
        Nous restons à votre disposition pour toute question.<br>
        Bien cordialement,<br>
        <strong style="color:#333;">L'étude TAGOT</strong>
      </p>
    </div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Grégoire TAGOT | notaire — 2 rue Dante, 75005 Paris</p>
    </div>
  </div>
</body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const p = req.body || {};
  if (!p.identite || !p.identite.nom) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }

  const nomComplet = `${p.identite.nom || ''} ${p.identite.prenoms || ''}`.trim();
  const t = transporter();

  // Email à l'étude
  try {
    await t.sendMail({
      from: FROM,
      to: NOTAIRE,
      subject: `LCB-FT — Attestation origine des fonds — ${nomComplet}`,
      html: buildEmailNotaire(p),
    });
  } catch (e) {
    console.error('Erreur email notaire LCB-FT:', e.message);
  }

  // Email récap client
  if (p.email && p.email.includes('@')) {
    try {
      await t.sendMail({
        from: FROM,
        to: p.email,
        subject: `LCB-FT — Récapitulatif de votre attestation — ${nomComplet}`,
        html: buildEmailClient(p),
      });
    } catch (e) {
      console.error('Erreur email client LCB-FT:', e.message);
    }
  }

  res.json({ ok: true });
};
