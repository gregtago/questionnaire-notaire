/**
 * Le questionnaire ne doit pas défaire une validation du notaire quand les
 * coordonnées n'ont pas changé — et doit la défaire dès qu'elles changent.
 * Microsoft Graph est simulé : aucun appel réseau.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MS_MAILBOX: 'office@example.org' });

let fiche, dernierPatch;
global.fetch = async (url, opt = {}) => {
  const rep = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o), headers: { get: () => '' } });
  url = String(url);
  if (url.includes('login.microsoftonline.com')) return rep({ access_token: 'a.e30.b', expires_in: 3600 });
  if (url.includes('/contactFolders?')) return rep({ value: [{ id: 'F', displayName: 'Clients' }] });
  if (url.includes('$filter=')) return rep({ value: [{ id: 'ID1', surname: fiche.surname }] });
  if (url.includes('/contacts/ID1') && opt.method === 'GET') return rep(fiche);
  if (url.includes('/contacts/ID1') && opt.method === 'PATCH') { dernierPatch = JSON.parse(opt.body); return rep({}); }
  throw new Error('appel inattendu : ' + url);
};

const { upsertContact } = require('../api/_contacts');
const base = { nom: 'Diai', prenom: 'Samuel', email: 'Samuel@Example.org', telephone: '06 12 34 56 78', natureDossier: 'Vente' };

test('fiche validée, mêmes coordonnées : la validation est conservée', async () => {
  fiche = { surname: 'DIAI', mobilePhone: '+33612345678', emailAddresses: [{ address: 'samuel@example.org' }], categories: ['Coord-verifiees'] };
  assert.equal((await upsertContact(base)).action, 'updated');
  assert.deepEqual(dernierPatch.categories, ['Coord-verifiees', 'Vente']);
});

test('fiche validée, téléphone différent : retour à « déclarée »', async () => {
  fiche = { surname: 'DIAI', mobilePhone: '+33699999999', emailAddresses: [{ address: 'samuel@example.org' }], categories: ['Coord-verifiees'] };
  await upsertContact(base);
  assert.deepEqual(dernierPatch.categories, ['Coord-declarees', 'Vente']);
});

test('fiche validée, email différent : retour à « déclarée »', async () => {
  fiche = { surname: 'DIAI', mobilePhone: '+33612345678', emailAddresses: [{ address: 'autre@example.org' }], categories: ['Coord-verifiees'] };
  await upsertContact(base);
  assert.deepEqual(dernierPatch.categories, ['Coord-declarees', 'Vente']);
});

test('fiche non validée : reste « déclarée »', async () => {
  fiche = { surname: 'DIAI', mobilePhone: '+33612345678', emailAddresses: [{ address: 'samuel@example.org' }], categories: ['Coord-declarees'] };
  await upsertContact(base);
  assert.deepEqual(dernierPatch.categories, ['Coord-declarees', 'Vente']);
});
