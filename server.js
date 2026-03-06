const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");
const path = require("path");
const PDFDocument = require("pdfkit");

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

    // ── 1. Générer le XML iNot ──────────────────────────
    const xmlPrompt = buildXmlPrompt(personnes);
    const xmlResp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{ role: "user", content: xmlPrompt }],
    });
    const xml = xmlResp.content[0].text.trim();

    // ── 2. Générer le PDF récapitulatif ─────────────────
    const pdfBase64 = await generatePdf(personnes, type);

    // ── 3. Envoyer par email si configuré ───────────────
    let emailSent = false;
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      emailSent = await sendEmail(xml, pdfBase64, personnes, type);
    }

    res.json({ xml, pdfBase64, emailSent });
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

// ─── Génération PDF avec pdfkit (JS pur) ───────────────
function generatePdf(personnes, type) {
  return new Promise((resolve, reject) => {
    const labels = {
      etatcivil: "État civil",
      acquereur: "Acquéreur",
      "vendeur-appartement": "Vendeur – Appartement",
      "vendeur-maison": "Vendeur – Maison",
      divorce: "Divorce",
      succession: "Succession",
    };
    const titre = labels[type] || "Questionnaire";
    const sitLabels = { C:"Célibataire", M:"Marié(e)", D:"Divorcé(e)", V:"Veuf / Veuve", I:"En instance de divorce", P:"Pacsé(e)", S:"Séparé(e) de corps" };
    const regLabels = { "4":"Sans contrat (régime légal)", "30":"Communauté réduite aux acquêts", "33":"Séparation de biens", "32":"Communauté universelle", "35":"Participation aux acquêts" };
    const civLabels = { "M.":"Monsieur", "MME":"Madame", "MELLE":"Mademoiselle" };

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
    doc.on("error", reject);

    const W = doc.page.width - 100;
    const today = new Date().toLocaleDateString("fr-FR");

    // En-tête
    doc.fontSize(18).font("Helvetica-Bold").fillColor("#111111").text(`Questionnaire — ${titre}`, 50, 50);
    doc.fontSize(9).font("Helvetica").fillColor("#999999").text(`Reçu le ${today} · Cabinet Tagot — Grégoire Tagot, Notaire`, 50, 76);
    doc.moveTo(50, 96).lineTo(50 + W, 96).strokeColor("#eeeeee").lineWidth(1).stroke();

    let y = 112;

    function section(title) {
      if (y > doc.page.height - 120) { doc.addPage(); y = 50; }
      y += 14;
      doc.fontSize(7).font("Helvetica-Bold").fillColor("#bbbbbb").text(title.toUpperCase(), 50, y, { width: W });
      y += 14;
      doc.moveTo(50, y).lineTo(50 + W, y).strokeColor("#eeeeee").lineWidth(0.5).stroke();
      y += 8;
    }

    function field(label, value) {
      if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
      doc.fontSize(7).font("Helvetica").fillColor("#888888").text(label.toUpperCase(), 50, y, { width: W });
      y += 11;
      if (value) {
        doc.fontSize(10).font("Helvetica").fillColor("#111111").text(value, 50, y, { width: W });
        y += doc.heightOfString(value, { width: W, fontSize: 10 }) + 5;
      } else {
        doc.fontSize(10).font("Helvetica").fillColor("#cccccc").text("—", 50, y);
        y += 16;
      }
    }

    function formatDate(d) {
      if (!d) return "";
      try { return new Date(d).toLocaleDateString("fr-FR"); } catch { return d; }
    }

    personnes.forEach((p, i) => {
      if (i > 0) {
        y += 10;
        doc.moveTo(50, y).lineTo(50 + W, y).strokeColor("#111111").lineWidth(2).stroke();
        y += 18;
      }
      const nomComplet = `${civLabels[p.civilite] || ""} ${(p.nom||"").toUpperCase()} ${p.prenoms||""}`.trim();
      doc.fontSize(13).font("Helvetica-Bold").fillColor("#111111").text(nomComplet, 50, y, { width: W });
      y += 22;

      section("Identité");
      field("Nom d'usage", (p.nom||"").toUpperCase());
      if (p.nomNaissance) field("Nom de naissance", (p.nomNaissance||"").toUpperCase());
      field("Prénoms", p.prenoms);
      const naissance = [formatDate(p.dateNaissance), p.lieuNaissance, p.cpNaissance ? `(${p.cpNaissance})` : ""].filter(Boolean).join(" à ").replace(" à (", " (");
      field("Date et lieu de naissance", naissance);
      field("Profession", p.profession);
      field("Nationalité", p.nationalite);

      section("Coordonnées");
      const adresse = [p.adresse, [p.cp, p.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      field("Adresse", adresse);
      field("Téléphone", p.tel);
      field("E-mail", p.email);

      section("Situation matrimoniale");
      const sit = p.situation || "C";
      field("Situation", sitLabels[sit] || sit);

      if (["M","I","S"].includes(sit)) {
        const mariage = [formatDate(p.dateMariage), [p.cpMariage, p.villeMariage].filter(Boolean).join(" ")].filter(Boolean).join(" à ");
        if (mariage) field("Date et lieu du mariage", mariage);
        field("Régime matrimonial", regLabels[p.regime] || p.regime);
        if (p.contratMariage) field("Contrat de mariage", "Oui");
        const conj = [(p.nomConjoint||"").toUpperCase(), p.prenomsConjoint].filter(Boolean).join(" ");
        if (conj) field("Conjoint", conj);
      }
      if (["D","I"].includes(sit)) {
        if (p.tribunal) field("Tribunal", p.tribunal);
        if (p.dateDivorce) field("Date du jugement", formatDate(p.dateDivorce));
        if (!["M","I","S"].includes(sit)) {
          const conj = [(p.nomConjoint||"").toUpperCase(), p.prenomsConjoint].filter(Boolean).join(" ");
          if (conj) field("Ex-conjoint", conj);
        }
      }
      if (sit === "V") {
        const conj = [(p.nomVeuf||"").toUpperCase(), p.prenomsVeuf].filter(Boolean).join(" ");
        if (conj) field("Conjoint décédé", conj);
      }
      if (sit === "P") {
        const pacs = [formatDate(p.datePacs), [p.cpPacs, p.villePacs].filter(Boolean).join(" ")].filter(Boolean).join(" à ");
        if (pacs) field("Date et lieu du PACS", pacs);
        const conj = [(p.nomConjoint||"").toUpperCase(), p.prenomsConjoint].filter(Boolean).join(" ");
        if (conj) field("Partenaire", conj);
      }
    });

    // Footer RGPD
    y += 20;
    doc.moveTo(50, y).lineTo(50 + W, y).strokeColor("#eeeeee").lineWidth(0.5).stroke();
    y += 8;
    doc.fontSize(7).font("Helvetica").fillColor("#aaaaaa")
      .text("Les données collectées sont traitées par le cabinet notarial Tagot dans le cadre de l'accomplissement des activités notariales. Conformément au RGPD, vous disposez d'un droit d'accès, de rectification et d'effacement. Pour exercer ces droits : gregoire@tagot.fr", 50, y, { width: W });

    doc.end();
  });
}

// ─── Envoi email ────────────────────────────────────────
async function sendEmail(xml, pdfBase64, personnes, type) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "ssl0.ovh.net",
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const noms = personnes.map((p) => `${p.nom || ""} ${p.prenoms || ""}`.trim()).join(", ");
  const labels = {
    etatcivil: "État civil",
    acquereur: "Acquéreur",
    "vendeur-appartement": "Vendeur – Appartement",
    "vendeur-maison": "Vendeur – Maison",
    divorce: "Divorce",
    succession: "Succession",
  };
  const typeLabel = labels[type] || type;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTAIRE_EMAIL || "office@tagot.notaires.fr",
    subject: `Questionnaire ${typeLabel} — ${noms}`,
    text: `Questionnaire ${typeLabel} complété par : ${noms}\n\nFichiers joints : XML iNot + PDF récapitulatif.`,
    attachments: [
      {
        filename: `import_inot_${noms.toLowerCase().replace(/\s/g, "_")}.XML`,
        content: xml,
        contentType: "application/xml",
      },
      {
        filename: `questionnaire_${noms.toLowerCase().replace(/\s/g, "_")}.pdf`,
        content: Buffer.from(pdfBase64, "base64"),
        contentType: "application/pdf",
      },
    ],
  });

  return true;
}

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
