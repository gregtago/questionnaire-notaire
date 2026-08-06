const crypto = require("crypto");
const SECRET = process.env.OTP_SECRET;

// Comparaison à temps constant : évite de laisser fuir l'empreinte attendue
// par la durée de la comparaison.
function equalConstantTime(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).end();
  const { email, code, token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Token manquant" });
  if (!SECRET) {
    console.error("OTP_SECRET absent de l'environnement — vérification refusée");
    return res.status(500).json({ error: "Configuration incomplète" });
  }
  try {
    const raw = Buffer.from(token, "base64url").toString();
    const parts = raw.split("|");
    if (parts.length !== 3) return res.status(400).json({ error: "Token invalide" });
    const [tEmail, tExpires, tHmac] = parts;
    // Vérifier expiration
    if (Date.now() > parseInt(tExpires)) return res.status(400).json({ error: "Code expiré" });
    // Vérifier email
    if (tEmail !== email?.toLowerCase()) return res.status(400).json({ error: "Email incorrect" });
    // Le code n'est pas dans le token : on recalcule l'empreinte à partir du
    // code saisi. Un code faux ne peut pas reproduire l'empreinte attendue.
    const expected = crypto.createHmac("sha256", SECRET)
      .update(`${code?.trim()}|${tEmail}|${tExpires}`).digest("hex");
    if (!equalConstantTime(expected, tHmac)) return res.status(400).json({ error: "Code incorrect" });
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: "Token invalide" });
  }
};
