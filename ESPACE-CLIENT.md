# Espace client et portail du notaire

Deux pages ajoutées au site des questionnaires :

| Adresse    | Pour qui   | Ce qu'on y fait |
|------------|------------|-----------------|
| `/espace`  | le client  | consulter le RIB de l'étude, déposer son RIB, justifier l'origine des fonds |
| `/portail` | le notaire | envoyer un questionnaire en ligne, valider les fiches, déposer le RIB de l'étude et le communiquer à un client, demander son RIB ou l'origine des fonds à un client, relever les pièces (sous filigrane), lire le journal |

L'ancienne page `/admin` (envoi des questionnaires, protégée par le seul mot de passe `ADMIN_PASSWORD`) est fusionnée dans le portail : onglet « Questionnaires », ou bouton « Questionnaire » sur une fiche client. L'envoi exige la session du portail (code d'accès + code du téléphone) et figure au journal. `/admin` renvoie désormais vers `/portail` ; la variable `ADMIN_PASSWORD` ne sert plus.

## Principe

1. Le client remplit un questionnaire : sa fiche est créée dans le dossier « Clients » d'Outlook, catégorie `Coord-declarees` (déjà en place).
2. Le notaire valide la fiche depuis `/portail` : catégorie `Coord-verifiees`, et empreinte du numéro validé conservée dans le coffre.
3. Le client saisit son adresse email sur `/espace`. Si elle est celle d'une fiche validée, il reçoit un code à cette adresse ; ce code saisi, un second lui est envoyé par SMS sur le mobile validé. Il accède alors à son espace pour 20 minutes, ou pour 24 heures s'il laisse cochée la case « Rester identifié sur cet appareil » (session gardée dans le navigateur, effacée par « Quitter »). Même identifié pour 24 heures, il ne dépose un RIB qu'après une identification de moins de 20 minutes, et ne signe sa déclaration que par un nouveau code SMS. Deux personnes partageant une adresse mais pas un mobile reçoivent chacune leur SMS, qui n'ouvre que leur fiche.

## Règles de sécurité tenues par le code

- La réponse à la saisie de l'adresse est la même qu'elle soit connue ou non ; le mobile n'est jamais affiché avant que l'adresse soit prouvée, et seulement par ses deux derniers chiffres.
- Deux codes à six chiffres (email, puis SMS), 10 minutes et cinq essais chacun, usage unique ; trois codes par quart d'heure, par adresse comme par mobile.
- Le client dépose mais ne relit jamais ce qu'il a déposé.
- Ce parcours ne modifie aucune coordonnée. Un questionnaire qui change le téléphone ou l'email d'une fiche validée la fait retomber en `Coord-declarees` ; un mobile ou un email modifié dans Outlook referme la fiche.
- Pièces et journal chiffrés (AES-256-GCM) avant écriture ; stockage Vercel Blob privé.
- Seuls PDF, JPEG et PNG sont acceptés (contrôle sur le contenu), 3 Mo par fichier.
- Le RIB de l'étude n'est jamais remis tel quel : chaque exemplaire est un PDF portant, en filigrane semi-transparent, l'office, le nom du client, la date et une référence unique (consignée au journal). Aucun bandeau ni QR code n'est ajouté : rien ne masque le RIB déposé, qui porte déjà le QR code de l'office. L'adresse de vérification (`RIB_QR_URL`, défaut `https://www.tagot.notaires.fr/rib`) figure dans les propriétés du PDF et dans l'email d'envoi.
- Parcours RIB : le client remplit un questionnaire (état civil…), le notaire valide sa fiche, puis, depuis le portail, lui **communique le RIB de l'étude** ou lui **demande son RIB**. Dans les deux cas le client reçoit un email de l'étude, sans lien ni pièce jointe, qui l'invite à saisir lui-même l'adresse de l'espace client ; il n'y entre qu'après un code reçu par email puis un code reçu par SMS. Le RIB ne part jamais par email.
- Chaque demande du notaire (RIB demandé, RIB de l'étude communiqué, origine des fonds) reçoit une référence `DEM-XXXX-XXXX`. Elle figure dans l'email au client, dans l'onglet « Demandes », dans le filigrane du RIB remis ou des pièces déposées en réponse, et sur chaque ligne du journal qui s'y rapporte (demande, relance, consultation, dépôt, pièce consultée). Chaque exemplaire du RIB de l'étude garde en plus sa propre référence `RIB-XXXX-XXXX`.
- Ces demandes figurent dans l'onglet « Demandes » du portail : une demande de RIB se clôt quand le client dépose son RIB ; un RIB communiqué passe à « Consulté le … » avec la référence de l'exemplaire remis. Un email qui ne part pas est signalé au notaire et au journal.
- Les pièces déposées par les clients sont consultées et téléchargées depuis le portail sous filigrane (« Reçu par l'office… — usage exclusif du dossier », nom du client, date du dépôt), en PDF ; l'original reste intact au coffre. Un PDF protégé qui refuse le filigrane est remis tel quel, et le journal le signale.
- Suivi sur la fiche : dans l'onglet « Clients », les boutons « Communiquer le RIB de l'office », « Demander le RIB » et « Origine des fonds » restent gris tant que rien n'a été demandé, passent à l'orange quand la demande est en attente du client, et au vert quand elle est réglée (RIB consulté, RIB reçu, déclaration signée). Le survol donne la date et la référence.
- Le journal se filtre par nom de client, référence de demande ou adresse email ; le bouton « Journal » d'une fiche l'ouvre filtré sur ce client.
- Rien n'est supprimé : un RIB remplacé reste dans l'historique, une validation retirée reste au journal.
- Portail : code d'accès + code à six chiffres du téléphone (TOTP), session de 12 heures.
- Les avis par email au notaire ne contiennent jamais de pièce jointe ; les emails au client ne contiennent ni lien cliquable ni pièce jointe.

## Déclaration d'origine des fonds (questionnaire LCB-FT signé)

Une demande « Origine des fonds » du portail ouvre, dans l'espace client, le questionnaire LCB-FT (`api/_declaration.js`) :

- **Montant attendu** : le montant fixé par le notaire figure en « V. Origine des fonds » ; le total déclaré ne peut pas lui être inférieur.
- **Brouillon** : la saisie est enregistrée automatiquement au coffre, rattachée à la demande. Le client la retrouve en revenant, même depuis un autre appareil, après s'être identifié de nouveau. Les justificatifs sont enregistrés un à un ; il en revoit le nom, jamais le contenu. Une pièce retirée sort de la déclaration mais reste au coffre. S'il a choisi de rester identifié 24 heures, il reprend sans nouveaux codes sur le même appareil ; sinon la session de 20 minutes est prolongée tant qu'il travaille, dans la limite de deux heures.
- **Suivi** : l'onglet « Demandes » indique « En cours — n pièces déposées » et permet de relancer le client par email.
- **Signature** : après relecture du récapitulatif et engagement sur l'honneur, le client signe par un code SMS propre à cette signature, envoyé au mobile validé ; son nom est affiché. Le code ne vaut que pour l'empreinte SHA-256 de ce qui est signé (réponses, déclarations, empreinte de chaque pièce) : toute modification l'annule.
- **Dossier de preuve** : la déclaration signée est figée en PDF au coffre (signataire, date, mobile masqué, adresse IP, empreinte), avec son empreinte et un sceau de l'enregistrement de signature ; le portail refuse de la remettre si ce contrôle échoue. Le signataire peut télécharger sa copie pendant 30 minutes et reçoit un email de confirmation portant l'empreinte.
- **Valeur** : signature électronique *simple* (règlement eIDAS n° 910/2014, art. 3, 10° et art. 25, § 1), appréciée au regard des articles 1366 et 1367 du code civil. Ce n'est ni une signature avancée (art. 26) ni une signature qualifiée : la présomption de fiabilité de l'article 1367, alinéa 2, ne joue pas.

Le questionnaire LCB-FT public (`/lcbft`, envoyé depuis l'onglet « Questionnaires ») reste inchangé.

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
