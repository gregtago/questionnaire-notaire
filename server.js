const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");
const path = require("path");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");

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
    const pdfBase64 = generatePdf(personnes, type);

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

// ─── Génération PDF avec Python / reportlab ─────────────
function generatePdf(personnes, type) {
  const labels = {
    etatcivil: "État civil",
    acquereur: "Acquéreur",
    "vendeur-appartement": "Vendeur – Appartement",
    "vendeur-maison": "Vendeur – Maison",
    divorce: "Divorce",
    succession: "Succession",
  };
  const titre = labels[type] || "Questionnaire";
  const data = JSON.stringify(personnes).replace(/'/g, "\\'").replace(/\\/g, "\\\\");

  const script = `
import json, sys, os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
from reportlab.lib.enums import TA_LEFT, TA_CENTER

outpath = sys.argv[1]
personnes = json.loads(sys.argv[2])
titre = sys.argv[3]

doc = SimpleDocTemplate(outpath, pagesize=A4,
    leftMargin=2*cm, rightMargin=2*cm, topMargin=2*cm, bottomMargin=2*cm)

styles = getSampleStyleSheet()
story = []

# Styles
s_title = ParagraphStyle('title', fontSize=16, fontName='Helvetica-Bold',
    spaceAfter=4, textColor=colors.HexColor('#111111'))
s_sub = ParagraphStyle('sub', fontSize=9, fontName='Helvetica',
    spaceAfter=20, textColor=colors.HexColor('#999999'))
s_section = ParagraphStyle('section', fontSize=8, fontName='Helvetica-Bold',
    spaceBefore=16, spaceAfter=8, textColor=colors.HexColor('#bbbbbb'),
    borderPad=0)
s_label = ParagraphStyle('label', fontSize=8, fontName='Helvetica',
    textColor=colors.HexColor('#888888'), spaceAfter=1)
s_value = ParagraphStyle('value', fontSize=10, fontName='Helvetica',
    textColor=colors.HexColor('#111111'), spaceAfter=6)
s_empty = ParagraphStyle('empty', fontSize=10, fontName='Helvetica',
    textColor=colors.HexColor('#cccccc'), spaceAfter=6)

from datetime import date
story.append(Paragraph(f"Questionnaire — {titre}", s_title))
story.append(Paragraph(f"Reçu le {date.today().strftime('%d/%m/%Y')} · Cabinet Tagot", s_sub))
story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#eeeeee'), spaceAfter=20))

sit_labels = {
    'C': 'Célibataire', 'M': 'Marié(e)', 'D': 'Divorcé(e)',
    'V': 'Veuf / Veuve', 'I': 'En instance de divorce',
    'P': 'Pacsé(e)', 'S': 'Séparé(e) de corps'
}
civ_labels = {'M.': 'Monsieur', 'MME': 'Madame', 'MELLE': 'Mademoiselle'}
reg_labels = {
    '4': 'Sans contrat (régime légal)', '30': 'Communauté réduite aux acquêts',
    '33': 'Séparation de biens', '32': 'Communauté universelle', '35': 'Participation aux acquêts'
}

def field(story, label, value):
    story.append(Paragraph(label.upper(), s_label))
    if value:
        story.append(Paragraph(str(value), s_value))
    else:
        story.append(Paragraph("—", s_empty))

def section(story, title):
    story.append(Paragraph(title.upper(), s_section))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#eeeeee'), spaceAfter=8))

for i, p in enumerate(personnes):
    if i > 0:
        story.append(Spacer(1, 0.5*cm))
        story.append(HRFlowable(width="100%", thickness=2, color=colors.HexColor('#111111'), spaceAfter=16))

    nom_complet = f"{civ_labels.get(p.get('civilite',''), '')} {p.get('nom','').upper()} {p.get('prenoms','')}"
    story.append(Paragraph(nom_complet.strip(), ParagraphStyle('nom_p',
        fontSize=13, fontName='Helvetica-Bold', spaceAfter=12, textColor=colors.HexColor('#111111'))))

    section(story, "Identité")
    # Ligne 1 : nom / nom naissance / prénoms
    row1 = [
        [Paragraph("NOM D'USAGE", s_label), Paragraph(p.get('nom','').upper() or '—', s_value)],
        [Paragraph("NOM DE NAISSANCE", s_label), Paragraph(p.get('nomNaissance','').upper() or '—', s_value)],
        [Paragraph("PRÉNOMS", s_label), Paragraph(p.get('prenoms','') or '—', s_value)],
    ]
    for row in row1:
        story.append(row[0])
        story.append(row[1])

    # Date/lieu naissance
    dn = p.get('dateNaissance','')
    if dn:
        try:
            from datetime import datetime
            dn = datetime.strptime(dn, '%Y-%m-%d').strftime('%d/%m/%Y')
        except: pass
    naissance = f"{dn} à {p.get('lieuNaissance','')} ({p.get('cpNaissance','')})" if dn or p.get('lieuNaissance') else '—'
    field(story, "Date et lieu de naissance", naissance)
    field(story, "Profession", p.get('profession'))
    field(story, "Nationalité", p.get('nationalite'))

    section(story, "Coordonnées")
    adresse = p.get('adresse','')
    if p.get('cp') or p.get('ville'):
        adresse += f"\\n{p.get('cp','')} {p.get('ville','')}".strip()
    field(story, "Adresse", adresse)
    field(story, "Téléphone", p.get('tel'))
    field(story, "E-mail", p.get('email'))

    section(story, "Situation matrimoniale")
    sit = p.get('situation', 'C')
    field(story, "Situation", sit_labels.get(sit, sit))

    if sit == 'M':
        dm = p.get('dateMariage','')
        if dm:
            try:
                from datetime import datetime
                dm = datetime.strptime(dm, '%Y-%m-%d').strftime('%d/%m/%Y')
            except: pass
        mariage = f"Le {dm} à {p.get('cpMariage','')} {p.get('villeMariage','')}".strip() if dm else '—'
        field(story, "Date et lieu du mariage", mariage)
        field(story, "Régime matrimonial", reg_labels.get(p.get('regime','4'), p.get('regime','4')))
        if p.get('contratMariage'):
            field(story, "Contrat de mariage", "Oui")
        conj = f"{p.get('nomConjoint','').upper()} {p.get('prenomsConjoint','')}".strip()
        field(story, "Conjoint", conj or '—')

    elif sit in ('D', 'I'):
        dd = p.get('dateDivorce','')
        if dd:
            try:
                from datetime import datetime
                dd = datetime.strptime(dd, '%Y-%m-%d').strftime('%d/%m/%Y')
            except: pass
        field(story, "Tribunal de grande instance", p.get('tribunal'))
        field(story, "Date du jugement", dd or '—')
        conj = f"{p.get('nomConjoint','').upper()} {p.get('prenomsConjoint','')}".strip()
        field(story, "Ex-conjoint", conj or '—')

    elif sit == 'V':
        conj = f"{p.get('nomVeuf','').upper()} {p.get('prenomsVeuf','')}".strip()
        field(story, "Conjoint décédé", conj or '—')

    elif sit == 'P':
        dp = p.get('datePacs','')
        if dp:
            try:
                from datetime import datetime
                dp = datetime.strptime(dp, '%Y-%m-%d').strftime('%d/%m/%Y')
            except: pass
        pacs = f"Le {dp} à {p.get('cpPacs','')} {p.get('villePacs','')}".strip() if dp else '—'
        field(story, "Date et lieu du PACS", pacs)
        conj = f"{p.get('nomConjoint','').upper()} {p.get('prenomsConjoint','')}".strip()
        field(story, "Partenaire", conj or '—')

# Footer RGPD
story.append(Spacer(1, 1*cm))
story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#eeeeee'), spaceAfter=8))
s_rgpd = ParagraphStyle('rgpd', fontSize=7, fontName='Helvetica',
    textColor=colors.HexColor('#aaaaaa'), leading=10)
story.append(Paragraph(
    "Les données collectées sont traitées par le cabinet notarial Tagot dans le cadre de l'accomplissement des activités notariales. "
    "Conformément au RGPD, vous disposez d'un droit d'accès, de rectification et d'effacement. "
    "Pour exercer ces droits : gregoiretagot@tagot.notaires.fr",
    s_rgpd))

doc.build(story)
print("OK")
`;

  const tmpScript = path.join(os.tmpdir(), `pdf_gen_${Date.now()}.py`);
  const tmpOut = path.join(os.tmpdir(), `out_${Date.now()}.pdf`);

  try {
    fs.writeFileSync(tmpScript, script);
    execSync(`python3 "${tmpScript}" "${tmpOut}" '${data.replace(/'/g, "\\'")}' "${titre}"`, {
      timeout: 30000,
    });
    const pdfBuffer = fs.readFileSync(tmpOut);
    return pdfBuffer.toString("base64");
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── Envoi email ────────────────────────────────────────
async function sendEmail(xml, pdfBase64, personnes, type) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.office365.com",
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
    to: process.env.NOTAIRE_EMAIL || process.env.SMTP_USER,
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
