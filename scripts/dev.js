/**
 * Serveur de développement : sert public/ et monte les fonctions de api/
 * comme le fait Vercel (corps JSON analysé, req.query, res.status/json/send).
 *
 *   node scripts/dev.js            → http://localhost:3000
 *
 * Réservé au poste de développement. En production, c'est Vercel qui sert.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const racine = path.join(__dirname, '..');
const app = express();
app.use(express.json({ limit: '6mb' }));

const reecritures = JSON.parse(fs.readFileSync(path.join(racine, 'vercel.json'), 'utf8')).rewrites || [];
for (const r of reecritures) {
  app.get(r.source, (req, res) => res.sendFile(path.join(racine, 'public', r.destination)));
}

function monter(dossier, prefixe) {
  for (const n of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (n.name.startsWith('_')) continue;
    const abs = path.join(dossier, n.name);
    if (n.isDirectory()) { monter(abs, `${prefixe}/${n.name}`); continue; }
    if (!n.name.endsWith('.js')) continue;
    app.all(`${prefixe}/${n.name.slice(0, -3)}`, (req, res) => require(abs)(req, res));
  }
}
monter(path.join(racine, 'api'), '/api');

app.use(express.static(path.join(racine, 'public')));

const port = process.env.PORT || 3000;
module.exports = app.listen(port, () => console.log(`Développement : http://localhost:${port}`));
