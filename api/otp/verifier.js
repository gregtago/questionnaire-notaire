const crypto = require("crypto");
const SECRET = process.env.OTP_SECRET || "changeme";

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).end();
  const { email, code, token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Token manquant" });
  try {
    const raw = Buffer.from(token, "base64url").toString();
    const parts = raw.split("|");
    if (parts.length !== 4) return res.status(400).json({ error: "Token invalide" });
    const [tCode, tEmail, tExpires, tHmac] = parts;
    // Vérifier HMAC
    const payload = `${tCode}|${tEmail}|${tExpires}`;
    const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex").slice(0,16);
    if (expected !== tHmac) return res.status(400).json({ error: "Token invalide" });
    // Vérifier expiration
    if (Date.now() > parseInt(tExpires)) return res.status(400).json({ error: "Code expiré" });
    // Vérifier code et email
    if (tCode !== code?.trim()) return res.status(400).json({ error: "Code incorrect" });
    if (tEmail !== email?.toLowerCase()) return res.status(400).json({ error: "Email incorrect" });
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: "Token invalide" });
  }
};
