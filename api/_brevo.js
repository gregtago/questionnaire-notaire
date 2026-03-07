const { BrevoClient } = require("@getbrevo/brevo");

const SENDER = { name: "Grégoire TAGOT | notaire", email: process.env.SENDER_EMAIL || "gregoire@tagot.fr" };
const NOTAIRE = process.env.NOTAIRE_EMAIL || "gregoire@tagot.fr";

const TYPE_LABELS = { etatcivil:"État civil", acquereur:"Acquéreur", "vendeur-appartement":"Vendeur – Appartement", "vendeur-maison":"Vendeur – Maison", divorce:"Divorce", succession:"Succession" };
const SIT_LABELS  = { C:"Célibataire", M:"Marié(e)", D:"Divorcé(e)", V:"Veuf / Veuve", I:"En instance de divorce", P:"Pacsé(e)", S:"Séparé(e) de corps" };
const REG_LABELS  = { "4":"Sans contrat (régime légal)", "30":"Communauté réduite aux acquêts", "33":"Séparation de biens", "32":"Communauté universelle", "35":"Participation aux acquêts" };

function brevo() { return new BrevoClient({ apiKey: process.env.BREVO_API_KEY }); }

function fmtDate(d) {
  if (!d) return "";
  if (d.length === 8) return d.slice(6)+"/"+d.slice(4,6)+"/"+d.slice(0,4);
  try { return new Date(d).toLocaleDateString("fr-FR"); } catch { return d; }
}
function row(label, value) {
  if (!value) return "";
  return `<tr>
    <td style="padding:5px 14px 5px 0;font-size:12px;color:#888;white-space:nowrap;vertical-align:top;">${label}</td>
    <td style="padding:5px 0;font-size:13px;color:#111;vertical-align:top;">${value}</td>
  </tr>`;
}
function sec(title) {
  return `<tr><td colspan="2" style="padding:16px 0 5px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#bbb;font-weight:bold;border-top:1px solid #eee;">${title}</td></tr>`;
}

// Email unique : récap HTML + XML en pièce jointe
async function sendAll(personnes, xml, type) {
  const typeLabel = TYPE_LABELS[type] || type;
  const noms = personnes.map(p => `${p.NOMU||""} ${p.PRENOMU||""}`.trim()).join(", ");
  const today = new Date().toLocaleDateString("fr-FR");

  // ── Corps HTML ──
  const personnesHtml = personnes.map((p, i) => {
    const sit = p.ETAT || "C";
    let rows = "";
    rows += sec("Identité");
    rows += row("Civilité", p.TITRE);
    rows += row("Nom d'usage", p.NOMU);
    if (p.NOM && p.NOM !== p.NOMU) rows += row("Nom de naissance", p.NOM);
    rows += row("Prénoms", p.PRENOM || p.PRENOMU);
    rows += row("Naissance", [fmtDate(p.DATNA), p.LVNARU, p.CODERU ? `(${p.CODERU})` : ""].filter(Boolean).join(" — "));
    rows += row("Profession", p.PROF);
    rows += row("Nationalité", p.NATION);
    rows += sec("Adresse et contact");
    rows += row("Adresse", [p.ADR1, p.ADR2, [p.ADR3, p.ADR4].filter(Boolean).join(" "), p.CPAYDO && p.CPAYDO !== "FRANCE" ? p.CPAYDO : ""].filter(Boolean).join(", "));
    if (p.ADR1IMP || p.CPIMP || p.VILLEIMP) {
      rows += row("Centre des impôts", [p.ADR1IMP, [p.CPIMP, p.VILLEIMP].filter(Boolean).join(" ")].filter(Boolean).join(", "));
    }
    rows += row("Téléphone", (p.TEL||"").replace(/[_\s]/g, ""));
    rows += row("E-mail", p.EMAIL);
    if (p._role !== "conjoint") {
      rows += sec("Situation matrimoniale");
      rows += row("Situation", SIT_LABELS[sit] || sit);
      if (["M","I","S"].includes(sit)) {
        rows += row("Date du mariage", fmtDate(p.DATMA));
        rows += row("Lieu du mariage", p.CPVILMA);
        rows += row("Régime", REG_LABELS[p.REGIME] || p.REGIME);
        const conj = [p.LNCOMA, p.LPCOMA].filter(Boolean).join(" ");
        if (conj) rows += row("Conjoint", conj);
      }
      if (["D","I"].includes(sit)) {
        rows += row("Date du divorce", fmtDate(p.DATDIV));
        rows += row("Tribunal", p.TRIBUNAL);
        const conj = [p.LNCOMA, p.LPCOMA].filter(Boolean).join(" ");
        if (conj) rows += row("Ex-conjoint", conj);
      }
      if (sit === "V") {
        const conj = [p.LNCOMA, p.LPCOMA].filter(Boolean).join(" ");
        if (conj) rows += row("Conjoint décédé", conj);
      }
      if (sit === "P") {
        rows += row("Date du PACS", fmtDate(p.DATMA));
        rows += row("Lieu du PACS", p.CPVILMA);
        const conj = [p.LNCOMA, p.LPCOMA].filter(Boolean).join(" ");
        if (conj) rows += row("Partenaire", conj);
      }
    } else {
      rows += `<tr><td colspan="2" style="font-size:11px;color:#aaa;padding:5px 0;font-style:italic;">Conjoint / Partenaire</td></tr>`;
    }
    const nomComplet = `${p.TITRE||""} ${p.NOMU||""} ${p.PRENOMU||""}`.trim();
    return `${i > 0 ? '<tr><td colspan="2" style="padding:20px 0 6px;"><hr style="border:none;border-top:2px solid #111;margin:0;"/></td></tr>' : ""}
      <tr><td colspan="2" style="padding-bottom:6px;"><strong style="font-size:15px;color:#111;">${nomComplet}</strong></td></tr>${rows}`;
  }).join("");

  const htmlContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:26px 30px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:5px;">Grégoire TAGOT&nbsp;|&nbsp;notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Questionnaire ${typeLabel}</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Reçu le ${today}</div>
    </div>
    <div style="padding:28px 30px;">
      <table style="width:100%;border-collapse:collapse;">${personnesHtml}</table>
    </div>
    <div style="background:#f5f5f5;padding:14px 30px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Le fichier XML iNot est joint à cet email.</p>
    </div>
  </div>
</body></html>`;

  // ── Nom du fichier XML ──
  const slug = noms.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"");
  const filename = `import_inot_${slug}.XML`;

  // ── Envoi unique avec pièce jointe ──
  const payload = {
    sender: SENDER,
    to: [{ email: NOTAIRE }],
    subject: `Questionnaire ${typeLabel} — ${noms}`,
    htmlContent,
  };
  if (xml) {
    payload.attachment = [{ name: filename, content: Buffer.from(xml).toString("base64") }];
  }

  await brevo().transactionalEmails.sendTransacEmail(payload);
}

module.exports = { sendAll };
