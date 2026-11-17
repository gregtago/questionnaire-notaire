# Espace client et portail du notaire

Deux pages ajoutées au site des questionnaires :

| Adresse    | Pour qui   | Ce qu'on y fait |
|------------|------------|-----------------|
| `/espace`  | le client  | consulter le RIB de l'étude, déposer son RIB, justifier l'origine des fonds |
| `/portail` | le notaire | valider les fiches, déposer le RIB de l'étude, demander l'origine des fonds, relever les pièces, lire le journal |

## Principe

1. Le client remplit un questionnaire : sa fiche est créée dans le dossier « Clients » d'Outlook, catégorie `Coord-declarees` (déjà en place).
2. Le notaire valide la fiche depuis `/portail` : catégorie `Coord-verifiees`, et empreinte du numéro validé conservée dans le coffre.
3. Le client saisit son mobile sur `/espace`. Si ce numéro est celui d'une fiche validée, il reçoit un code par SMS, puis accède à son espace pour 20 minutes.

## Règles de sécurité tenues par le code

- La réponse à la saisie du numéro est la même qu'il soit connu ou non.
- Code à six chiffres, 10 minutes, cinq essais, usage unique ; trois codes par quart d'heure et par numéro.
- Le client dépose mais ne relit jamais ce qu'il a déposé.
- Ce parcours ne modifie aucune coordonnée. Un questionnaire qui change le téléphone ou l'email d'une fiche validée la fait retomber en `Coord-declarees` ; un numéro modifié dans Outlook referme la fiche.
- Pièces et journal chiffrés (AES-256-GCM) avant écriture ; stockage Vercel Blob privé.
- Seuls PDF, JPEG et PNG sont acceptés (contrôle sur le contenu), 3 Mo par fichier.
- Rien n'est supprimé : un RIB remplacé reste dans l'historique, une validation retirée reste au journal.
- Portail : code d'accès + code à six chiffres du téléphone (TOTP), session de 12 heures.
- Les avis par email au notaire ne contiennent jamais de pièce jointe ; l'email au client ne contient aucun lien cliquable.

## Variables d'environnement (Vercel)

| Variable | Rôle |
|---|---|
| `COFFRE_CLE` | clé de chiffrement, 64 caractères hexadécimaux (`openssl rand -hex 32`). **À conserver hors de Vercel aussi : sans elle, les pièces sont illisibles.** |
| `BLOB_READ_WRITE_TOKEN` | posée par Vercel quand un magasin Blob **privé** est relié au projet |
| `PORTAIL_CODE` | code d'accès du portail, 12 caractères au moins |
| `PORTAIL_OTP_REENROLER` | `1` le temps de ré-enrôler un téléphone perdu, puis à retirer |
| `OVH_APP_KEY`, `OVH_APP_SECRET`, `OVH_CONSUMER_KEY` | identifiants de l'API OVHcloud (droit `POST /sms/*/jobs`) |
| `OVH_SMS_SERVICE` | nom du compte SMS (`sms-xx00000-1`) |
| `OVH_SMS_SENDER` | expéditeur déclaré chez OVHcloud (facultatif) |
| `OTP_SECRET`, `MS_*`, `SMTP_*`, `NOTAIRE_EMAIL` | déjà en place |

Hors production seulement : `ANNUAIRE_MODE=essai` (carnet fictif tenu dans le coffre) et `SMS_MODE=essai` (aucun SMS, le code est rendu à la page — admis uniquement avec le carnet fictif). Les versions d'essai écrivent sous le préfixe `essai/` du magasin.

## Développement

```
npm test        # parcours complet sur un coffre temporaire, sans réseau
npm run dev     # http://localhost:3000 (exige COFFRE_CLE, OTP_SECRET, PORTAIL_CODE)
```
