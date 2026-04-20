const nodemailer = require('nodemailer');

const NOTAIRE = process.env.NOTAIRE_EMAIL || process.env.SMTP_USER;
const FROM    = `"Grégoire TAGOT | notaire" <${process.env.SMTP_USER}>`;
const DROPFILE_URL = 'https://tagot-my.sharepoint.com/:f:/g/personal/gregoiretagot_tagot_notaires_fr/IgCFScPZGHdWR7wRqChmXjEEAeLQrMIc7CD8Zm3dy9b-Piw';

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
  epargne: 'Épargne personnelle',
  vente: "Vente d'un bien immobilier",
  succession: 'Succession ou donation',
  pret: 'Prêt bancaire',
  titres: 'Cession de titres ou valeurs mobilières',
  indem: 'Indemnité',
  autre: 'Autre origine',
};
const OBJET_LABELS = {
  residence_principale: 'Résidence principale',
  residence_secondaire: 'Résidence secondaire',
  investissement_locatif: 'Investissement locatif',
  transmission_familiale: 'Transmission familiale',
  activite_professionnelle: 'Usage professionnel / activité',
  autre: 'Autre',
};
const PIECES_PAR_SOURCE = {
  epargne:    ['Relevés de compte', 'Relevé de situation', 'Attestation du dépositaire des fonds'],
  vente:      ['Attestation de vente mentionnant le prix', "Copie de l'acte de vente"],
  succession: ['Courrier de la banque', 'Déclaration de succession', 'Acte de donation', 'Relevé de compte de la succession'],
  pret:       ['Offre de prêt'],
  titres:     ["Tout justificatif permettant de prouver l'origine des fonds"],
  indem:      ["Tout justificatif permettant de prouver l'origine des fonds"],
  autre:      ["Tout justificatif permettant de prouver l'origine des fonds"],
};
const ON = { O: 'Oui', N: 'Non' };

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('fr-FR'); } catch { return d; }
}
function fmtMontant(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString('fr-FR') + ' €';
}
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function row(label, value) {
  if (value === '' || value === null || value === undefined) return '';
  return `<tr>
    <td style="padding:6px 14px 6px 0;font-size:12px;color:#888;white-space:nowrap;vertical-align:top;width:40%;">${esc(label)}</td>
    <td style="padding:6px 0;font-size:13px;color:#111;vertical-align:top;">${esc(value)}</td>
  </tr>`;
}
function sec(title) {
  return `<tr><td colspan="2" style="padding:22px 0 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#bbb;font-weight:bold;border-top:1px solid #eee;">${esc(title)}</td></tr>`;
}

function buildEmailNotaire(p) {
  const id = p.identite;
  const ppe = p.ppe;
  const op = p.operation;
  const pm = p.personneMorale;
  const fonds = p.origineFonds;
  const ctx = p.contexte;

  const nomComplet = `${id.civilite || ''} ${id.nom || ''} ${id.prenoms || ''}`.trim();
  const adresseComplete = [
    id.adresseVoie,
    [id.codePostal, id.ville].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');

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
  rows += row('Adresse', adresseComplete);
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
  if (fonds && fonds.sources && fonds.sources.length) {
    fonds.sources.forEach(s => {
      const label = SOURCE_LABELS[s.key] || s.key;
      const detail = [fmtMontant(s.montant), s.precision].filter(Boolean).join(' — ');
      rows += row(label, detail);
    });
    rows += row('Total déclaré', fmtMontant(fonds.total));
  }

  rows += sec("Objet & contexte de l'opération");
  rows += row('Objet', [OBJET_LABELS[ctx.objet] || ctx.objet, ctx.objetAutre].filter(Boolean).join(' — '));
  rows += row('Cohérence avec la situation ?', ON[ctx.coherence] + (ctx.coherence === 'N' && ctx.coherenceTxt ? ` — ${ctx.coherenceTxt}` : ''));
  rows += row('Agit pour un tiers ?', ON[ctx.pourTiers] + (ctx.pourTiers === 'O' && ctx.tiersTxt ? ` — ${ctx.tiersTxt}` : ''));
  rows += row("Fonds provenant de l'étranger ?", ON[ctx.fondsEtranger] + (ctx.fondsEtranger === 'O' && ctx.etrangerTxt ? ` — ${ctx.etrangerTxt}` : ''));

  rows += sec('Engagement');
  rows += row('Engagement de responsabilité', p.engagement ? 'Oui, coché par le déclarant' : 'Non');
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
  const today = new Date().toLocaleDateString('fr-FR');
  const prenomClient = id.prenoms || '';

  // Pièces à demander selon sources
  const piecesHtml = (fonds.sources || [])
    .filter(s => Number(s.montant) > 0)
    .map(s => {
      const sectionLabel = SOURCE_LABELS[s.key] || s.key;
      const sectionSuffix = s.precision ? ` — ${esc(s.precision)}` : '';
      const pieces = (PIECES_PAR_SOURCE[s.key] || []).map(
        p => `<tr><td style="padding:5px 0 5px 16px;font-size:13px;color:#444;border-bottom:1px solid #f5f5f5;position:relative;">→ ${esc(p)}</td></tr>`
      ).join('');
      return `<tr><td style="padding:14px 0 4px;font-size:10px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.06em;border-top:1px solid #eee;">${esc(sectionLabel)}${sectionSuffix}</td></tr>${pieces}`;
    }).join('');

  const sourcesSummary = (fonds.sources || []).map(s =>
    `${SOURCE_LABELS[s.key] || s.key} (${fmtMontant(s.montant)})`
  ).join(', ');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:640px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT&nbsp;|&nbsp;notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Attestation LCB-FT reçue</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Récapitulatif — ${today}</div>
    </div>
    <div style="padding:32px 30px;">
      <p style="font-size:14px;color:#333;margin:0 0 18px;">Bonjour ${esc(prenomClient)},</p>
      <p style="font-size:14px;color:#555;margin:0 0 20px;line-height:1.6;">
        Nous avons bien reçu votre attestation sur l'honneur d'origine des fonds. Vous trouverez ci-dessous un récapitulatif ainsi que la liste des pièces justificatives à nous transmettre.
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;">
        ${row('Déclarant', `${id.civilite || ''} ${id.prenoms || ''} ${id.nom || ''}`.trim())}
        ${row('Opération', op.description)}
        ${row('Prix / montant', fmtMontant(op.prix))}
        ${row('Origine des fonds', sourcesSummary)}
        ${row('Total déclaré', fmtMontant(fonds.total))}
      </table>

      <h3 style="font-size:14px;color:#111;margin:28px 0 10px;">Pièces justificatives à fournir</h3>
      <table style="width:100%;border-collapse:collapse;">${piecesHtml}</table>

      <table style="width:100%;border-collapse:collapse;margin-top:28px;">
        <tr>
          <td style="width:50%;padding:16px 20px;vertical-align:top;border:1px solid #e5e5e5;border-radius:4px;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.06em;">Envoi par email</p>
            <p style="margin:0;font-size:13px;color:#444;line-height:1.5;">Merci d'envoyer les pièces demandées à :<br><a href="mailto:office@tagot.notaires.fr" style="color:#111;font-weight:600;">office@tagot.notaires.fr</a></p>
          </td>
          <td style="width:4%;"></td>
          <td style="width:46%;padding:16px 20px;vertical-align:top;background:#f8f8f6;border:1px solid #e5e5e5;border-radius:4px;text-align:center;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.06em;">Envoi en ligne</p>
            <p style="margin:0 0 14px;font-size:13px;color:#444;line-height:1.5;">Déposez vos pièces directement en suivant ce lien :</p>
            <a href="${DROPFILE_URL}" target="_blank" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;border-radius:4px;font-size:12px;font-weight:600;text-decoration:none;letter-spacing:.04em;">&#128206; Déposer mes pièces</a>
          </td>
        </tr>
      </table>
      <p style="font-size:11px;color:#bbb;margin-top:16px;text-align:center;">Le dépôt peut également se faire en papier directement à l'étude : 2 rue Dante, 75005 Paris.</p>

      <p style="font-size:12px;color:#888;margin:32px 0 0;line-height:1.6;border-top:1px solid #eee;padding-top:18px;">
        Nous restons à votre disposition pour toute question.<br>
        Bien cordialement,<br>
        <strong style="color:#333;">Grégoire TAGOT | notaire</strong>
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

  // Email récap client + pièces
  if (p.email && p.email.includes('@')) {
    try {
      await t.sendMail({
        from: FROM,
        to: p.email,
        subject: `LCB-FT — Récapitulatif et pièces à fournir — ${nomComplet}`,
        html: buildEmailClient(p),
      });
    } catch (e) {
      console.error('Erreur email client LCB-FT:', e.message);
    }
  }

  res.json({ ok: true });
};
