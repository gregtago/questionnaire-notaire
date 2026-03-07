const { sendEmail, sendXmlEmail } = require("./_brevo");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const { personnes, xml, type } = req.body || {};
  if (!personnes || !personnes.length) return res.status(400).json({ error: "Données manquantes" });

  // Envoyer les deux emails AVANT de répondre (Vercel coupe la fonction après res.json)
  const errors = [];
  try { await sendEmail(personnes, type); } catch(e) { errors.push("récap: " + e.message); }
  try { if (xml) await sendXmlEmail(xml, personnes, type); } catch(e) { errors.push("XML: " + e.message); }

  if (errors.length) console.error("Erreurs email:", errors.join(", "));
  res.json({ ok: true });
};
