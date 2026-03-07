const { sendAll } = require("./_brevo");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const { personnes, xml, type } = req.body || {};
  if (!personnes || !personnes.length) return res.status(400).json({ error: "Données manquantes" });
  res.json({ ok: true });
  try {
    await sendAll(personnes, xml, type);
  } catch(e) {
    console.error("Erreur envoi email:", e.message);
  }
};
