const { sendEmail, sendXmlEmail } = require("./_brevo");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).end();
  const { personnes, xml, type } = req.body || {};
  if (!personnes || !personnes.length) return res.status(400).json({ error: "Données manquantes" });
  res.json({ ok: true });
  // Emails en arrière-plan
  try { await sendEmail(personnes, type); } catch(e) { console.error("Email récap:", e.message); }
  try { if (xml) await sendXmlEmail(xml, personnes, type); } catch(e) { console.error("Email XML:", e.message); }
};
