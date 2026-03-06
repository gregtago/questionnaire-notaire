const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { BrevoClient } = require("@getbrevo/brevo");
const path = require("path");

const app = express();

// ─── Store OTP en mémoire (10 min) ─────────────────────
const otpStore = new Map(); // email -> { code, expires }

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ─── Route questionnaire ────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Envoi du code OTP ─────────────────────────────────
app.post("/api/otp/envoyer", async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Email invalide" });
  }
  const code = generateOtp();
  otpStore.set(email.toLowerCase(), { code, expires: Date.now() + 10 * 60 * 1000 });

  try {
    const { BrevoClient } = require("@getbrevo/brevo");
    const brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
    await brevo.transactionalEmails.sendTransacEmail({
      sender: { name: "Grégoire TAGOT | notaire", email: process.env.SENDER_EMAIL || "gregoire@tagot.fr" },
      to: [{ email }],
      subject: "Votre code de vérification — Grégoire TAGOT | notaire",
      htmlContent: `
        <div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:40px auto;padding:32px;border:1px solid #eee;border-radius:6px;">
          <div style="font-size:11px;letter-spacing:.05em;color:#999;margin-bottom:8px;">Grégoire TAGOT&nbsp; |&nbsp; notaire</div>
          <h2 style="margin:0 0 24px;font-weight:300;font-size:22px;color:#111;">Code de vérification</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;">Pour accéder au questionnaire, saisissez le code ci-dessous :</p>
          <div style="text-align:center;margin:32px 0;">
            <span style="font-size:36px;font-weight:bold;letter-spacing:.2em;color:#111;">${code}</span>
          </div>
          <p style="color:#aaa;font-size:12px;">Ce code est valable 10 minutes. Si vous n'avez pas demandé ce code, ignorez cet email.</p>
        </div>`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Erreur envoi OTP:", e.message);
    res.status(500).json({ error: "Erreur envoi email" });
  }
});

// ─── Vérification du code OTP ──────────────────────────
app.post("/api/otp/verifier", (req, res) => {
  const { email, code } = req.body;
  const entry = otpStore.get(email?.toLowerCase());
  if (!entry) return res.status(400).json({ error: "Aucun code envoyé pour cet email" });
  if (Date.now() > entry.expires) {
    otpStore.delete(email.toLowerCase());
    return res.status(400).json({ error: "Code expiré, veuillez en demander un nouveau" });
  }
  if (entry.code !== code?.trim()) {
    return res.status(400).json({ error: "Code incorrect" });
  }
  otpStore.delete(email.toLowerCase());
  res.json({ ok: true });
});

// ─── Soumission formulaire ──────────────────────────────
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
        // b) Générer le XML directement en JS
        const xml = buildXmlDirect(personnes);
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
  return `Tu es un assistant notarial. Génère un fichier XML iNot (format import généalogiste Genapi).

FORMAT OBLIGATOIRE — chaque champ utilise EXACTEMENT cette syntaxe :
<Var key="CLE" name="CLE"><Value>valeur</Value></Var>

Structure XML complète à produire :
<?xml version="1.0" encoding="utf-8"?>
<iNova><iNot><Customer><Folder>
  <Person info="">
    <Var key="NUMERO" name="NUMERO"><Value>10000001</Value></Var>
    <Var key="TYPE" name="TYPE"><Value>PP</Value></Var>
    <Var key="ADR1" name="ADR1"><Value></Value></Var>
    <Var key="ADR2" name="ADR2"><Value></Value></Var>
    <Var key="ADR3" name="ADR3"><Value></Value></Var>
    <Var key="ADR4" name="ADR4"><Value></Value></Var>
    <Var key="RCS" name="RCS"><Value></Value></Var>
    <Var key="VILRCS" name="VILRCS"><Value></Value></Var>
    <Var key="CPRCS" name="CPRCS"><Value></Value></Var>
    <Var key="CPAYRCS" name="CPAYRCS"><Value></Value></Var>
    <Var key="NUMMB" name="NUMMB"><Value></Value></Var>
    <Var key="IDENMB" name="IDENMB"><Value></Value></Var>
    <Var key="ACCORD" name="ACCORD"><Value>M ou F</Value></Var>
    <Var key="ADR1MB" name="ADR1MB"><Value></Value></Var>
    <Var key="ADR2MB" name="ADR2MB"><Value></Value></Var>
    <Var key="CPMB" name="CPMB"><Value></Value></Var>
    <Var key="VILLEMB" name="VILLEMB"><Value></Value></Var>
    <Var key="PRESENCE" name="PRESENCE"><Value></Value></Var>
    <Var key="INTCONJ" name="INTCONJ"><Value></Value></Var>
    <Var key="PRECONJ" name="PRECONJ"><Value></Value></Var>
    <Var key="JODATE" name="JODATE"><Value></Value></Var>
    <Var key="CPVILMA" name="CPVILMA"><Value></Value></Var>
    <Var key="NOTMA" name="NOTMA"><Value></Value></Var>
    <Var key="HISTORIQUE" name="HISTORIQUE"><Value>O ou N</Value></Var>
    <Var key="INTCONJPURIEL" name="INTCONJPURIEL"><Value></Value></Var>
    <Var key="CODCRU" name="CODCRU"><Value></Value></Var>
    <Var key="LVDCRU" name="LVDCRU"><Value></Value></Var>
    <Var key="CPSTAT" name="CPSTAT"><Value></Value></Var>
    <Var key="PREFDAT" name="PREFDAT"><Value></Value></Var>
    <Var key="DEPTDO" name="DEPTDO"><Value>nom département domicile</Value></Var>
    <Var key="CPAYDO" name="CPAYDO"><Value>FRANCE</Value></Var>
    <Var key="CONJ" name="CONJ"><Value></Value></Var>
    <Var key="ETAT" name="ETAT"><Value>C/M/D/V/I/P/S</Value></Var>
    <Var key="CODETITRE" name="CIVILITY"><Value>M./MME/MELLE</Value></Var>
    <Var key="NOMU" name="NOMU"><Value>NOM USUEL MAJUSCULES</Value></Var>
    <Var key="PRENOMU" name="PRENOMU"><Value>Prénom usuel</Value></Var>
    <Var key="PRENOM" name="PRENOM"><Value>Tous prénoms état civil</Value></Var>
    <Var key="PROF" name="PROF"><Value></Value></Var>
    <Var key="DATNA" name="DATNA"><Value>AAAAMMJJ</Value></Var>
    <Var key="DEPTNA" name="DEPTNA"><Value>nom département naissance</Value></Var>
    <Var key="CPAYNA" name="CPAYNA"><Value>FRANCE</Value></Var>
    <Var key="DEPMOR" name="DEPMOR"><Value></Value></Var>
    <Var key="NATION" name="NATION"><Value></Value></Var>
    <Var key="INCAPABLE" name="INCAPABLE"><Value></Value></Var>
    <Var key="TITRE" name="TITRE"><Value>Monsieur/Madame/Mademoiselle</Value></Var>
    <Var key="DATMOR" name="DATMOR"><Value></Value></Var>
    <Var key="DATMA" name="DATMA"><Value>AAAAMMJJ si marié/pacsé sinon vide</Value></Var>
    <Var key="CPAYMA" name="CPAYMA"><Value>FR si applicable</Value></Var>
    <Var key="ADR1IMP" name="ADR1IMP"><Value>= ADR1</Value></Var>
    <Var key="ADR2IMP" name="ADR2IMP"><Value></Value></Var>
    <Var key="CPIMP" name="CPIMP"><Value>= ADR3</Value></Var>
    <Var key="VILLEIMP" name="VILLEIMP"><Value>= ADR4</Value></Var>
    <Var key="CODERU" name="CODERU"><Value>CP naissance</Value></Var>
    <Var key="LVNARU" name="LVNARU"><Value>VILLE NAISSANCE MAJUSCULES</Value></Var>
    <Var key="NOM" name="NOM"><Value>NOM ÉTAT CIVIL MAJUSCULES</Value></Var>
    <Var key="REGIME" name="REGIME"><Value>4/30/32/33/35</Value></Var>
    <Var key="DATCONTR" name="DATCONTR"><Value></Value></Var>
    <Var key="DATAN" name="DATAN"><Value></Value></Var>
    <Var key="DATDECL" name="DATDECL"><Value></Value></Var>
    <Var key="DATHOM" name="DATHOM"><Value></Value></Var>
    <Var key="TGIME" name="TGIME"><Value></Value></Var>
    <Var key="REGPRE" name="REGPRE"><Value></Value></Var>
    <Var key="LIEME" name="LIEME"><Value></Value></Var>
    <Var key="NOTME" name="NOTME"><Value></Value></Var>
    <Var key="NOPME" name="NOPME"><Value></Value></Var>
    <HistoriqueMarital />
  </Person>
</Folder></Customer></iNot></iNova>

RÈGLES DE REMPLISSAGE :
- ADR1 = adresse (voie), ADR3 = CP, ADR4 = ville
- ACCORD : M si Monsieur, F si Madame ou Mademoiselle
- ETAT : C=célibataire M=marié D=divorcé V=veuf I=instance P=pacsé S=séparé
- HISTORIQUE : O si événement marital, N sinon
- DATNA/DATMA/DAMAMA : format AAAAMMJJ
- REGIME : 4=sans contrat après 1966, 33=séparation biens, 32=communauté universelle, 35=participation acquêts, 30=communauté réduite acquêts. Vide si célibataire.
- DEPTDO/DEPTNA : nom du département (ex: Paris, Hérault, Seine-et-Marne), pas le numéro
- ADR1IMP/CPIMP/VILLEIMP = identiques à ADR1/ADR3/ADR4 si pas d'adresse fiscale distincte
- Pour marié : HISTORIQUE=O, remplacer <HistoriqueMarital /> par :
  <HistoriqueMarital><Evenement><Var key="COTYMA" name="COTYMA"><Value>M</Value></Var><Var key="DAMAMA" name="DAMAMA"><Value>AAAAMMJJ</Value></Var><Var key="LVT1MA" name="LVT1MA"><Value>lieu mariage</Value></Var><Var key="LNCOMA" name="LNCOMA"><Value>NOM conjoint</Value></Var><Var key="LPCOMA" name="LPCOMA"><Value>prénoms conjoint</Value></Var><Var key="COCRMA" name="COCRMA"><Value></Value></Var></Evenement></HistoriqueMarital>
- Pour divorcé : même structure avec COTYMA=D, LVT1MA=tribunal
- Tous les champs doivent être présents, même vides
- NUMERO : 10000001 pour la 1ère personne, 10000002 pour la 2ème, etc.

CORRESPONDANCE DES CHAMPS (formulaire → XML iNot) :
- civilite → TITRE (Monsieur/Madame/Mademoiselle) et CODETITRE (M./MME/MELLE) et ACCORD (M/F)
- nom → NOMU et NOM (en MAJUSCULES)
- nomNaissance → NOM si différent, sinon = nom
- prenoms → PRENOMU (prénom usuel = 1er prénom) et PRENOM (tous les prénoms)
- dateNaissance (format JJ/MM/AAAA) → DATNA (convertir en AAAAMMJJ)
- lieuNaissance → LVNARU (en MAJUSCULES)
- cpNaissance → CODERU
- profession → PROF
- nationalite → NATION
- adresse → ADR1 et ADR1IMP
- cp → ADR3 et CPIMP
- ville → ADR4 et VILLEIMP
- situation → ETAT (C/M/D/V/I/P/S) et HISTORIQUE (O si pas C, N si C)
- dateMariage (JJ/MM/AAAA) → DATMA (AAAAMMJJ) et DAMAMA dans Evenement
- cpMariage + villeMariage → LVT1MA dans Evenement
- nomConjoint → LNCOMA dans Evenement
- prenomsConjoint → LPCOMA dans Evenement
- regime → REGIME
- tribunal → LVT1MA si divorcé
- dateDivorce (JJ/MM/AAAA) → DAMAMA dans Evenement
- nomVeuf / prenomsVeuf → LNCOMA / LPCOMA dans Evenement si veuf
- datePacs / cpPacs / villePacs → idem que mariage mais COTYMA=P

DONNÉES À TRANSFORMER :
\${JSON.stringify(personnes, null, 2)}

Réponds UNIQUEMENT avec le XML complet, sans texte avant ni après, sans balises markdown.`;
}



// ─── Génération XML iNot directe en JS ─────────────────
function buildXmlDirect(personnes) {
  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function v(key, val) {
    return `    <Var key="${key}" name="${key === 'CODETITRE' ? 'CIVILITY' : key}"><Value>${esc(val)}</Value></Var>`;
  }
  // Convertit JJ/MM/AAAA → AAAAMMJJ
  function toInotDate(d) {
    if (!d) return '';
    const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return m[3] + m[2] + m[1];
    return d.replace(/\D/g,'').length === 8 ? d.replace(/\D/g,'') : '';
  }
  // Détermine le département à partir du CP
  function deptFromCp(cp) {
    if (!cp) return '';
    const n = cp.substring(0, 2);
    const depts = {
      '01':'Ain','02':'Aisne','03':'Allier','04':'Alpes-de-Haute-Provence','05':'Hautes-Alpes',
      '06':'Alpes-Maritimes','07':'Ardèche','08':'Ardennes','09':'Ariège','10':'Aube',
      '11':'Aude','12':'Aveyron','13':'Bouches-du-Rhône','14':'Calvados','15':'Cantal',
      '16':'Charente','17':'Charente-Maritime','18':'Cher','19':'Corrèze','20':'Corse',
      '21':'Côte-d\'Or','22':'Côtes-d\'Armor','23':'Creuse','24':'Dordogne','25':'Doubs',
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
      '91':'Essonne','92':'Hauts-de-Seine','93':'Seine-Saint-Denis','94':'Val-de-Marne','95':'Val-d\'Oise',
      '97':'Outre-mer'
    };
    return depts[n] || '';
  }

  const persons = personnes.map((p, i) => {
    const num = String(10000001 + i);
    const sit = p.situation || 'C';
    const hasHistory = ['M','D','V','I','P','S'].includes(sit);
    const isMarie = ['M','I','S'].includes(sit);
    const isDivorce = ['D','I'].includes(sit);
    const isVeuf = sit === 'V';
    const isPacs = sit === 'P';

    // Civilité
    const civ = p.civilite || '';
    const titre = civ === 'Monsieur' ? 'Monsieur' : civ === 'Madame' ? 'Madame' : civ === 'Mademoiselle' ? 'Mademoiselle' : '';
    const codeTitre = civ === 'Monsieur' ? 'M.' : civ === 'Madame' ? 'MME' : civ === 'Mademoiselle' ? 'MELLE' : '';
    const accord = civ === 'Monsieur' ? 'M' : 'F';

    // Noms
    const nom = (p.nom || '').toUpperCase();
    const nomNaissance = (p.nomNaissance || p.nom || '').toUpperCase();
    const prenoms = p.prenoms || '';
    const prenomUsuel = prenoms.split(/\s+/)[0] || '';

    // Adresse
    const adresse = p.adresse || '';
    const cp = p.cp || '';
    const ville = (p.ville || '').toUpperCase();
    const deptDo = deptFromCp(cp);

    // Naissance
    const datNa = toInotDate(p.dateNaissance);
    const lieuNa = (p.lieuNaissance || '').toUpperCase();
    const cpNa = p.cpNaissance || '';
    const deptNa = deptFromCp(cpNa);

    // Mariage / événement
    let datMa = '';
    let cpayMa = '';
    let historiqueXml = '<HistoriqueMarital />';

    if (isMarie) {
      datMa = toInotDate(p.dateMariage);
      cpayMa = p.cpMariage ? 'FR' : '';
      const lieuMa = [p.cpMariage, p.villeMariage].filter(Boolean).join(' ');
      const conjNom = (p.nomConjoint || '').toUpperCase();
      const conjPrenoms = p.prenomsConjoint || '';
      const cotyma = sit === 'S' ? 'S' : 'M';
      historiqueXml = `<HistoriqueMarital><Evenement>
      <Var key="COTYMA" name="COTYMA"><Value>${cotyma}</Value></Var>
      <Var key="DAMAMA" name="DAMAMA"><Value>${esc(datMa)}</Value></Var>
      <Var key="LVT1MA" name="LVT1MA"><Value>${esc(lieuMa)}</Value></Var>
      <Var key="LNCOMA" name="LNCOMA"><Value>${esc(conjNom)}</Value></Var>
      <Var key="LPCOMA" name="LPCOMA"><Value>${esc(conjPrenoms)}</Value></Var>
      <Var key="COCRMA" name="COCRMA"><Value></Value></Var>
    </Evenement></HistoriqueMarital>`;
    } else if (isDivorce) {
      const datDiv = toInotDate(p.dateDivorce);
      const trib = p.tribunal || '';
      const conjNom = (p.nomConjoint || '').toUpperCase();
      const conjPrenoms = p.prenomsConjoint || '';
      historiqueXml = `<HistoriqueMarital><Evenement>
      <Var key="COTYMA" name="COTYMA"><Value>D</Value></Var>
      <Var key="DAMAMA" name="DAMAMA"><Value>${esc(datDiv)}</Value></Var>
      <Var key="LVT1MA" name="LVT1MA"><Value>${esc(trib)}</Value></Var>
      <Var key="LNCOMA" name="LNCOMA"><Value>${esc(conjNom)}</Value></Var>
      <Var key="LPCOMA" name="LPCOMA"><Value>${esc(conjPrenoms)}</Value></Var>
      <Var key="COCRMA" name="COCRMA"><Value></Value></Var>
    </Evenement></HistoriqueMarital>`;
    } else if (isVeuf) {
      const veufNom = (p.nomVeuf || '').toUpperCase();
      const veufPrenoms = p.prenomsVeuf || '';
      historiqueXml = `<HistoriqueMarital><Evenement>
      <Var key="COTYMA" name="COTYMA"><Value>V</Value></Var>
      <Var key="DAMAMA" name="DAMAMA"><Value></Value></Var>
      <Var key="LVT1MA" name="LVT1MA"><Value></Value></Var>
      <Var key="LNCOMA" name="LNCOMA"><Value>${esc(veufNom)}</Value></Var>
      <Var key="LPCOMA" name="LPCOMA"><Value>${esc(veufPrenoms)}</Value></Var>
      <Var key="COCRMA" name="COCRMA"><Value></Value></Var>
    </Evenement></HistoriqueMarital>`;
    } else if (isPacs) {
      const datPacs = toInotDate(p.datePacs);
      const lieuPacs = [p.cpPacs, p.villePacs].filter(Boolean).join(' ');
      const conjNom = (p.nomConjoint || '').toUpperCase();
      const conjPrenoms = p.prenomsConjoint || '';
      historiqueXml = `<HistoriqueMarital><Evenement>
      <Var key="COTYMA" name="COTYMA"><Value>P</Value></Var>
      <Var key="DAMAMA" name="DAMAMA"><Value>${esc(datPacs)}</Value></Var>
      <Var key="LVT1MA" name="LVT1MA"><Value>${esc(lieuPacs)}</Value></Var>
      <Var key="LNCOMA" name="LNCOMA"><Value>${esc(conjNom)}</Value></Var>
      <Var key="LPCOMA" name="LPCOMA"><Value>${esc(conjPrenoms)}</Value></Var>
      <Var key="COCRMA" name="COCRMA"><Value></Value></Var>
    </Evenement></HistoriqueMarital>`;
    }

    const regime = isMarie || sit === 'D' ? (p.regime || '4') : '';

    return `  <Person info="">
${v('NUMERO', num)}
${v('TYPE', 'PP')}
${v('ADR1', adresse)}
${v('ADR2', '')}
${v('ADR3', cp)}
${v('ADR4', ville)}
${v('RCS', '')}
${v('VILRCS', '')}
${v('CPRCS', '')}
${v('CPAYRCS', '')}
${v('NUMMB', '')}
${v('IDENMB', '')}
${v('ACCORD', accord)}
${v('ADR1MB', '')}
${v('ADR2MB', '')}
${v('CPMB', '')}
${v('VILLEMB', '')}
${v('PRESENCE', '')}
${v('INTCONJ', '')}
${v('PRECONJ', '')}
${v('JODATE', '')}
${v('CPVILMA', '')}
${v('NOTMA', '')}
${v('HISTORIQUE', hasHistory ? 'O' : 'N')}
${v('INTCONJPURIEL', '')}
${v('CODCRU', '')}
${v('LVDCRU', '')}
${v('CPSTAT', '')}
${v('PREFDAT', '')}
${v('DEPTDO', deptDo)}
${v('CPAYDO', 'FRANCE')}
${v('CONJ', '')}
${v('ETAT', sit)}
${v('CODETITRE', codeTitre)}
${v('NOMU', nom)}
${v('PRENOMU', prenomUsuel)}
${v('PRENOM', prenoms)}
${v('PROF', p.profession || '')}
${v('DATNA', datNa)}
${v('DEPTNA', deptNa)}
${v('CPAYNA', 'FRANCE')}
${v('DEPMOR', '')}
${v('NATION', p.nationalite || '')}
${v('INCAPABLE', '')}
${v('TITRE', titre)}
${v('DATMOR', '')}
${v('DATMA', datMa)}
${v('CPAYMA', cpayMa)}
${v('ADR1IMP', adresse)}
${v('ADR2IMP', '')}
${v('CPIMP', cp)}
${v('VILLEIMP', ville)}
${v('CODERU', cpNa)}
${v('LVNARU', lieuNa)}
${v('NOM', nomNaissance)}
${v('REGIME', regime)}
${v('DATCONTR', '')}
${v('DATAN', '')}
${v('DATDECL', '')}
${v('DATHOM', '')}
${v('TGIME', '')}
${v('REGPRE', '')}
${v('LIEME', '')}
${v('NOTME', '')}
${v('NOPME', '')}
    ${historiqueXml}
  </Person>`;
  });

  return `<?xml version="1.0" encoding="utf-8"?>\n<iNova><iNot><Customer><Folder>\n${persons.join('\n')}\n</Folder></Customer></iNot></iNova>`;
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
      <div style="font-size:11px;letter-spacing:.05em;color:#888;margin-bottom:6px;">Grégoire TAGOT&nbsp; |&nbsp; notaire</div>
      <div style="font-size:20px;font-weight:300;color:#fff;">Questionnaire ${typeLabel}</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">Reçu le ${today}</div>
    </div>
    <div style="padding:32px;">
      <table style="width:100%;border-collapse:collapse;">${personnesHtml}</table>
    </div>
    <div style="background:#fafafa;padding:16px 32px;border-top:1px solid #eee;">
      <p style="margin:0;font-size:10px;color:#bbb;line-height:1.6;">Questionnaire soumis via questionnaire.tagot.notaires.fr · Grégoire TAGOT | notaire</p>
    </div>
  </div>
</body></html>`;

  const brevo = new BrevoClient({ apiKey });
  await brevo.transactionalEmails.sendTransacEmail({
    sender: { name: "Grégoire TAGOT | notaire", email: process.env.SENDER_EMAIL || "gregoire@tagot.fr" },
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
    sender: { name: "Grégoire TAGOT | notaire", email: process.env.SENDER_EMAIL || "gregoire@tagot.fr" },
    to: [{ email: process.env.NOTAIRE_EMAIL || "office@tagot.notaires.fr" }],
    subject: `XML iNot — ${typeLabel} — ${noms}`,
    textContent: `Fichier XML iNot en pièce jointe pour : ${noms}`,
    attachment: [{ name: filename, content: Buffer.from(xml).toString("base64") }],
  });
}

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
