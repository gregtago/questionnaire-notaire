const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { BrevoClient } = require("@getbrevo/brevo");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ─── Route questionnaire ────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Génération XML + PDF ───────────────────────────────
app.post("/api/soumettre", async (req, res) => {
  try {
    const { personnes, type } = req.body;
    if (!personnes || !personnes.length) {
      return res.status(400).json({ error: "Données manquantes" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API manquante" });

    const client = new Anthropic({ apiKey });

    // ── 1. Répondre immédiatement au client ────────────
    res.json({ ok: true });

    // ── 2. Tout en arrière-plan ─────────────────────────
    setImmediate(async () => {
      if (!process.env.BREVO_API_KEY) return;
      try {
        // a) Email immédiat avec les réponses (sans XML)
        await sendEmail(null, personnes, type);
      } catch (e) {
        console.error("Erreur email réponses:", e.message);
      }
      try {
        // b) Générer le XML et envoyer en second email
        const xmlResp = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4000,
          messages: [{ role: "user", content: buildXmlPrompt(personnes) }],
        });
        const xml = xmlResp.content[0].text.trim();
        await sendXmlEmail(xml, personnes, type);
      } catch (e) {
        console.error("Erreur XML:", e.message);
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Erreur serveur" });
  }
});

// ─── Construction du prompt XML ────────────────────────
function buildXmlPrompt(personnes) {
  return `Tu es un assistant notarial. Génère un fichier XML iNot (format import généalogiste Genapi) à partir des données suivantes.

RÈGLES XML iNot :
- Structure : <?xml version="1.0" encoding="utf-8"?><iNova><iNot><Customer><Folder>...<\/Folder><\/Customer><\/iNot><\/iNova>
- Une balise <Person info=""> par personne
- NUMERO : 10000001, 10000002, etc.
- TYPE : PP
- Noms en MAJUSCULES, prénoms avec 1ère lettre majuscule
- ACCORD : M (masculin) ou F (féminin) selon civilité
- CODETITRE : M. / MME / MELLE
- ETAT : C=célibataire, M=marié, D=divorcé, V=veuf, I=instance divorce, P=pacsé, S=séparé corps
- HISTORIQUE : O si événement marital, N sinon
- DATNA, DATMA, DAMAMA : format AAAAMMJJ
- Régime : 4=sans contrat après 1966, 33=séparation biens, 32=communauté universelle, 35=participation acquêts, 30=communauté réduite acquêts
- DEPTDO : nom du département (ex: Paris, Hérault)
- HistoriqueMarital : vide si célibataire, sinon <Evenement> avec COTYMA, DAMAMA, LVT1MA, LNCOMA, LPCOMA
- Pour marié : HISTORIQUE=O, Evenement COTYMA=M avec date et lieu mariage
- Pour divorcé : HISTORIQUE=O, Evenement COTYMA=D (tribunal dans LVT1MA)
- Pour veuf : HISTORIQUE=O, Evenement COTYMA=V
- Pour pacsé : HISTORIQUE=O, Evenement COTYMA=P
- Tous les champs obligatoires doivent être présents même vides
- Adresse fiscale = adresse domicile si non précisée

DONNÉES :
${JSON.stringify(personnes, null, 2)}

Réponds UNIQUEMENT avec le XML complet, sans texte avant ni après, sans balises markdown.`;
}

// ─── Envoi email via Brevo API ──────────────────────────
async function sendEmail(xml, personnes, type) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("BREVO_API_KEY manquante");

  const typeLabels = { etatcivil:"État civil", acquereur:"Acquéreur", "vendeur-appartement":"Vendeur – Appartement", "vendeur-maison":"Vendeur – Maison", divorce:"Divorce", succession:"Succession" };
  const sitLabels = { C:"Célibataire", M:"Marié(e)", D:"Divorcé(e)", V:"Veuf / Veuve", I:"En instance de divorce", P:"Pacsé(e)", S:"Séparé(e) de corps" };
  const regLabels = { "4":"Sans contrat (régime légal)", "30":"Communauté réduite aux acquêts", "33":"Séparation de biens", "32":"Communauté universelle", "35":"Participation aux acquêts" };
  const civLabels = { "M.":"Monsieur", "MME":"Madame", "MELLE":"Mademoiselle" };

  const typeLabel = typeLabels[type] || type;
  const noms = personnes.map(p => `${(p.nom||"").toUpperCase()} ${p.prenoms||""}`.trim()).join(", ");
  const today = new Date().toLocaleDateString("fr-FR");

  function formatDate(d) {
    if (!d) return "";
    try { return new Date(d).toLocaleDateString("fr-FR"); } catch { return d; }
  }
  function row(label, value) {
    if (!value) return "";
    return `<tr><td style="padding:6px 12px 6px 0;font-size:12px;color:#888;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;font-size:13px;color:#111;vertical-align:top;">${value}</td></tr>`;
  }
  function section(title) {
    return `<tr><td colspan="2" style="padding:18px 0 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#bbb;font-weight:bold;border-top:1px solid #eee;">${title}</td></tr>`;
  }

  const personnesHtml = personnes.map((p, i) => {
    const sit = p.situation || "C";
    let rows = "";
    rows += section("Identité");
    rows += row("Civilité", civLabels[p.civilite] || p.civilite);
    rows += row("Nom d'usage", (p.nom||"").toUpperCase());
    if (p.nomNaissance) rows += row("Nom de naissance", (p.nomNaissance||"").toUpperCase());
    rows += row("Prénoms", p.prenoms);
    const naiss = [formatDate(p.dateNaissance), p.lieuNaissance, p.cpNaissance ? `(${p.cpNaissance})` : ""].filter(Boolean).join(" — ");
    rows += row("Date et lieu de naissance", naiss);
    rows += row("Profession", p.profession);
    rows += row("Nationalité", p.nationalite);
    rows += section("Coordonnées");
    const adresse = [p.adresse, [p.cp, p.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    rows += row("Adresse", adresse);
    rows += row("Téléphone", p.tel);
    rows += row("E-mail", p.email);
    rows += section("Situation matrimoniale");
    rows += row("Situation", sitLabels[sit] || sit);
    if (["M","I","S"].includes(sit)) {
      const mariage = [formatDate(p.dateMariage), [p.cpMariage, p.villeMariage].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
      rows += row("Date et lieu du mariage", mariage);
      rows += row("Régime matrimonial", regLabels[p.regime] || p.regime);
      if (p.contratMariage) rows += row("Contrat de mariage", "Oui");
      const conj = [(p.nomConjoint||"").toUpperCase(), p.prenomsConjoint].filter(Boolean).join(" ");
      rows += row("Conjoint", conj);
    }
    if (["D","I"].includes(sit)) {
      rows += row("Tribunal", p.tribunal);
      rows += row("Date du jugement", formatDate(p.dateDivorce));
      if (!["M"].includes(sit)) {
        const conj = [(p.nomConjoint||"").toUpperCase(), p.prenomsConjoint].filter(Boolean).join(" ");
        rows += row("Ex-conjoint", conj);
      }
    }
    if (sit === "V") {
      const conj = [(p.nomVeuf||"").toUpperCase(), p.prenomsVeuf].filter(Boolean).join(" ");
      rows += row("Conjoint décédé", conj);
    }
    if (sit === "P") {
      const pacs = [formatDate(p.datePacs), [p.cpPacs, p.villePacs].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
      rows += row("Date et lieu du PACS", pacs);
      const conj = [(p.nomConjoint||"").toUpperCase(), p.prenomsConjoint].filter(Boolean).join(" ");
      rows += row("Partenaire", conj);
    }
    const nomComplet = `${civLabels[p.civilite]||""} ${(p.nom||"").toUpperCase()} ${p.prenoms||""}`.trim();
    return `${i > 0 ? '<tr><td colspan="2" style="padding:24px 0 8px;"><hr style="border:none;border-top:2px solid #111;margin:0;" /></td></tr>' : ""}
      <tr><td colspan="2" style="padding-bottom:8px;"><span style="font-size:15px;font-weight:bold;color:#111;">${nomComplet}</span></td></tr>${rows}`;
  }).join("");

  const htmlContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
    <div style="background:#111;padding:28px 32px;">
      <div style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#888;margin-bottom:6px;">Cabinet Tagot — Notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Questionnaire ${typeLabel}</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Reçu le ${today}</div>
    </div>
    <div style="padding:32px;">
      <table style="width:100%;border-collapse:collapse;">${personnesHtml}</table>
    </div>
    <div style="background:#fafafa;padding:16px 32px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;line-height:1.6;">Questionnaire soumis via questionnaire.tagot.notaires.fr · Cabinet Tagot</p>
    </div>
  </div>
</body></html>`;

  const brevo = new BrevoClient({ apiKey });
  await brevo.transactionalEmails.sendTransacEmail({
    sender: { name: "Cabinet Tagot", email: process.env.SENDER_EMAIL || "gregoire@tagot.fr" },
    to: [{ email: process.env.NOTAIRE_EMAIL || "office@tagot.notaires.fr" }],
    subject: `Questionnaire ${typeLabel} — ${noms}`,
    htmlContent,
  });
}

// ─── Email XML iNot via Brevo ───────────────────────────
async function sendXmlEmail(xml, personnes, type) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("BREVO_API_KEY manquante");

  const typeLabels = { etatcivil:"État civil", acquereur:"Acquéreur", "vendeur-appartement":"Vendeur – Appartement", "vendeur-maison":"Vendeur – Maison", divorce:"Divorce", succession:"Succession" };
  const noms = personnes.map(p => `${(p.nom||"").toUpperCase()} ${p.prenoms||""}`.trim()).join(", ");
  const typeLabel = typeLabels[type] || type;
  const filename = `import_inot_${noms.toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"")}.XML`;

  const brevo = new BrevoClient({ apiKey });
  await brevo.transactionalEmails.sendTransacEmail({
    sender: { name: "Cabinet Tagot", email: process.env.SENDER_EMAIL || "gregoire@tagot.fr" },
    to: [{ email: process.env.NOTAIRE_EMAIL || "office@tagot.notaires.fr" }],
    subject: `XML iNot — ${typeLabel} — ${noms}`,
    textContent: `Fichier XML iNot en pièce jointe pour : ${noms}`,
    attachment: [{ name: filename, content: Buffer.from(xml).toString("base64") }],
  });
}

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
