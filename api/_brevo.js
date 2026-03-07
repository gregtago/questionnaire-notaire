const { BrevoClient } = require("@getbrevo/brevo");

const SENDER = { name: "Grégoire TAGOT | notaire", email: process.env.SENDER_EMAIL || "gregoire@tagot.fr" };
const NOTAIRE = process.env.NOTAIRE_EMAIL || "office@tagot.notaires.fr";

const TYPE_LABELS = { etatcivil:"État civil", acquereur:"Acquéreur", "vendeur-appartement":"Vendeur – Appartement", "vendeur-maison":"Vendeur – Maison", divorce:"Divorce", succession:"Succession" };
const SIT_LABELS = { C:"Célibataire", M:"Marié(e)", D:"Divorcé(e)", V:"Veuf / Veuve", I:"En instance de divorce", P:"Pacsé(e)", S:"Séparé(e) de corps" };
const REG_LABELS = { "4":"Sans contrat (régime légal)", "30":"Communauté réduite aux acquêts", "33":"Séparation de biens", "32":"Communauté universelle", "35":"Participation aux acquêts" };

function brevo() { return new BrevoClient({ apiKey: process.env.BREVO_API_KEY }); }

function formatInotDate(d) {
  if (!d) return "";
  if (d.length === 8) return d.slice(6)+"/"+d.slice(4,6)+"/"+d.slice(0,4);
  try { return new Date(d).toLocaleDateString("fr-FR"); } catch { return d; }
}
function row(label, value) {
  if (!value) return "";
  return `<tr><td style="padding:6px 12px 6px 0;font-size:12px;color:#888;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;font-size:13px;color:#111;vertical-align:top;">${value}</td></tr>`;
}
function section(title) {
  return `<tr><td colspan="2" style="padding:18px 0 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#bbb;font-weight:bold;border-top:1px solid #eee;">${title}</td></tr>`;
}

async function sendEmail(personnes, type) {
  const typeLabel = TYPE_LABELS[type] || type;
  const noms = personnes.map(p => `${p.NOMU||""} ${p.PRENOMU||""}`.trim()).join(", ");
  const today = new Date().toLocaleDateString("fr-FR");

  const personnesHtml = personnes.map((p, i) => {
    const sit = p.ETAT || "C";
    let rows = "";
    rows += section("Identité");
    rows += row("Civilité", p.TITRE);
    rows += row("Nom d'usage", p.NOMU);
    if (p.NOM && p.NOM !== p.NOMU) rows += row("Nom de naissance", p.NOM);
    rows += row("Prénoms", p.PRENOM || p.PRENOMU);
    const naiss = [formatInotDate(p.DATNA), p.LVNARU, p.CODERU ? `(${p.CODERU})` : ""].filter(Boolean).join(" — ");
    rows += row("Naissance", naiss);
    rows += row("Profession", p.PROF);
    rows += row("Nationalité", p.NATION);
    rows += section("Adresse et contact");
    const adr = [p.ADR1, p.ADR2, [p.ADR3, p.ADR4].filter(Boolean).join(" "), p.CPAYDO && p.CPAYDO !== "FRANCE" ? p.CPAYDO : ""].filter(Boolean).join(", ");
    rows += row("Adresse", adr);
    rows += row("Téléphone", p.TEL);
    rows += row("E-mail", p.EMAIL);
    if (p._role !== "conjoint") {
      rows += section("Situation matrimoniale");
      rows += row("Situation", SIT_LABELS[sit] || sit);
      if (["M","I","S"].includes(sit)) {
        rows += row("Date du mariage", formatInotDate(p.DATMA));
        rows += row("Lieu du mariage", p.CPVILMA);
        rows += row("Régime", REG_LABELS[p.REGIME] || p.REGIME);
        const conj = [p.LNCOMA, p.LPCOMA].filter(Boolean).join(" ");
        if (conj) rows += row("Conjoint", conj);
      }
      if (["D","I"].includes(sit)) {
        rows += row("Date du divorce", formatInotDate(p.DATDIV));
        rows += row("Tribunal", p.TRIBUNAL);
        const conj = [p.LNCOMA, p.LPCOMA].filter(Boolean).join(" ");
        if (conj) rows += row("Ex-conjoint", conj);
      }
      if (sit === "V") {
        const conj = [p.LNCOMA, p.LPCOMA].filter(Boolean).join(" ");
        if (conj) rows += row("Conjoint décédé", conj);
      }
      if (sit === "P") {
        rows += row("Date du PACS", formatInotDate(p.DATMA));
        rows += row("Lieu du PACS", p.CPVILMA);
        const conj = [p.LNCOMA, p.LPCOMA].filter(Boolean).join(" ");
        if (conj) rows += row("Partenaire", conj);
      }
    } else {
      rows += `<tr><td colspan="2" style="font-size:11px;color:#aaa;padding:6px 0;font-style:italic;">Conjoint / Partenaire</td></tr>`;
    }
    const nomComplet = `${p.TITRE||""} ${p.NOMU||""} ${p.PRENOMU||""}`.trim();
    return `${i > 0 ? '<tr><td colspan="2" style="padding:24px 0 8px;"><hr style="border:none;border-top:2px solid #111;margin:0;"/></td></tr>' : ""}
      <tr><td colspan="2" style="padding-bottom:8px;"><span style="font-size:15px;font-weight:bold;color:#111;">${nomComplet}</span></td></tr>${rows}`;
  }).join("");

  await brevo().transactionalEmails.sendTransacEmail({
    sender: SENDER, to: [{ email: NOTAIRE }],
    subject: `Questionnaire ${typeLabel} — ${noms}`,
    htmlContent: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:28px 32px;">
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:6px;">Grégoire TAGOT&nbsp; |&nbsp; notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Questionnaire ${typeLabel}</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Reçu le ${today}</div>
    </div>
    <div style="padding:32px;"><table style="width:100%;border-collapse:collapse;">${personnesHtml}</table></div>
    <div style="background:#fafafa;padding:16px 32px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;">Questionnaire soumis via questionnaire.tagot.notaires.fr · Grégoire TAGOT | notaire</p>
    </div>
  </div></body></html>`,
  });
}

async function sendXmlEmail(xml, personnes, type) {
  const typeLabel = TYPE_LABELS[type] || type;
  const noms = personnes.map(p => `${p.NOMU||""} ${p.PRENOMU||""}`.trim()).join(", ");
  const slug = noms.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"");
  await brevo().transactionalEmails.sendTransacEmail({
    sender: SENDER, to: [{ email: NOTAIRE }],
    subject: `XML iNot — ${typeLabel} — ${noms}`,
    textContent: `Fichier XML iNot en pièce jointe pour : ${noms}`,
    attachment: [{ name: `import_inot_${slug}.XML`, content: Buffer.from(xml).toString("base64") }],
  });
}

module.exports = { sendEmail, sendXmlEmail };
