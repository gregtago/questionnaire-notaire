/**
 * Suggestions de villes et d'adresses pour les questionnaires de l'Office.
 *
 * Module autonome, sans dépendance ni clé d'API. Il s'ajoute aux formulaires
 * existants sans les modifier : si le réseau ou l'API est indisponible, la
 * saisie manuelle reste strictement identique.
 *
 * Sources (API publiques de l'État, gratuites, sans authentification) :
 *   - Base Adresse Nationale  https://api-adresse.data.gouv.fr  (adresses)
 *   - API Découpage administratif  https://geo.api.gouv.fr      (communes)
 *
 * Les pays sont proposés à partir d'une liste embarquée : les États actuels
 * pour une adresse, auxquels s'ajoutent, pour un lieu de naissance, les États
 * et territoires disparus (URSS, Yougoslavie, Algérie française, Dahomey…),
 * l'acte de naissance portant le nom du pays à la date de la naissance.
 *
 * Les champs sont reconnus à la volée (nom de l'attribut data-*, id, classe et
 * libellé), puis un menu de suggestions est attaché au focus. Le remplissage
 * d'un champ passe par des événements `input` / `change` synthétiques, ce qui
 * met à jour les modèles de données des pages sans y toucher.
 */
(function () {
  'use strict';

  if (window.__adresseAuto) return;
  window.__adresseAuto = true;

  var BAN = 'https://api-adresse.data.gouv.fr/search/';
  var GEO = 'https://geo.api.gouv.fr/communes';

  var MIN_CHARS = 3;
  var DEBOUNCE_MS = 220;
  var MAX_CACHE = 200;

  // Communes à arrondissements : leur « code postal principal » ne veut rien
  // dire, on ne le pré-remplit jamais.
  var MULTI_CP = { '75056': 1, '69123': 1, '13055': 1 };

  // Conteneurs au-delà desquels on ne cherche plus de champ apparenté.
  var BOUNDARY = '.sec, .card, .repeat-block, [data-idx], [data-be], form, body';

  // Champ complémentaire à remplir pour un rôle donné.
  var PARTNER = {
    city: 'postcode',
    postcode: 'city',
    placeCity: 'placePostcode',
    placePostcode: 'placeCity'
  };

  // ── Utilitaires ───────────────────────────────────────────────────────────

  function norm(s) {
    return (s == null ? '' : String(s))
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function isFrance(v) {
    var n = norm(v).trim();
    return n === '' || n === 'fr' || n === 'france';
  }

  // ── Reconnaissance des champs ─────────────────────────────────────────────

  var ROLES = new WeakMap();

  /** Chaîne de reconnaissance : attributs data-*, id, name, classe, libellé. */
  function keyOf(el) {
    var parts = [];
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && a.name.indexOf('data-i18n') !== 0) parts.push(a.value);
    }
    if (el.id) parts.push(el.id);
    if (el.name) parts.push(el.name);
    if (el.className) parts.push(el.className);
    var field = el.closest('.field, .fg');
    var label = field && field.querySelector('label');
    if (label) parts.push(label.textContent);
    return norm(parts.join(' '));
  }

  var IS_POSTCODE = /code ?postal|codepostal|postcode|coderu|(^| )cp($| )|cpimp/;
  var IS_CITY = /ville|commune|city|localite|lvnaru|lieuna|(^| |\.)lieu($| )/;

  // Lieu de naissance, de décès, de mariage : une commune, mais qui n'a rien à
  // voir avec la ville du domicile. Les deux familles ne doivent jamais être
  // appariées entre elles.
  var IS_PLACE = /naissance|naiss|deces|mariage|lvnaru|coderu/;

  /**
   * 'street' | 'city' | 'postcode' | 'placeCity' | 'placePostcode'
   * | 'cityPostcode' | 'country' | 'placeCountry' | null
   */
  function detectRole(el) {
    if (!el || el.tagName !== 'INPUT') return null;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type !== 'text' && type !== 'search') return null;
    if (el.disabled || el.readOnly) return null;

    var k = keyOf(el);
    if (!k) return null;
    if (/mail|courriel|iban|bic|swift|siren|siret|complement/.test(k)) return null;

    var place = IS_PLACE.test(k);
    if (/pays|country/.test(k)) return place ? 'placeCountry' : 'country';
    if (/cpvil|(cp|code postal)[^a-z]{0,6}(\+|et)[^a-z]{0,3}commune/.test(k)) return 'cityPostcode';

    if (IS_POSTCODE.test(k)) return place ? 'placePostcode' : 'postcode';
    if (IS_CITY.test(k)) return place ? 'placeCity' : 'city';
    if (/adresse|address|(^| )voie($| )|adr1/.test(k)) return 'street';
    return null;
  }

  function roleOf(el) {
    if (ROLES.has(el)) return ROLES.get(el);
    var r = null;
    try { r = detectRole(el); } catch (e) { r = null; }
    ROLES.set(el, r);
    return r;
  }

  /**
   * Préfixe d'un champ répété : `data-bi="2.adresse"` → `data-bi|2`.
   * Permet de ne relier entre eux que les champs d'un même bloc (bien n° 2,
   * enfant n° 3…) même si le balisage les regroupe.
   */
  function prefixOf(el) {
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') !== 0 || a.name.indexOf('data-i18n') === 0) continue;
      var dot = a.value.lastIndexOf('.');
      if (dot > 0) return a.name + '|' + a.value.slice(0, dot);
    }
    return null;
  }

  /** Cherche de proche en proche un champ apparenté du rôle demandé. */
  function findRelated(el, role) {
    var px = prefixOf(el);
    var node = el.parentElement;
    var depth = 0;
    while (node && depth < 8) {
      var candidates = node.querySelectorAll('input');
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (c === el || c.disabled || c.readOnly) continue;
        if (roleOf(c) !== role) continue;
        if (prefixOf(c) !== px) continue;
        return c;
      }
      if (node.matches(BOUNDARY)) break;
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  // ── Écriture dans les champs ──────────────────────────────────────────────

  /** Affecte une valeur et notifie la page (les formulaires écoutent input/change). */
  function setVal(el, value, force) {
    if (!el || value == null) return;
    if (value === '' && !force) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    delete el.__aaAuto;
  }

  /**
   * Remplit un champ et retient que la valeur vient de nous : une correction
   * ultérieure du champ voisin pourra la remplacer, une saisie manuelle non.
   */
  function setValAuto(el, value) {
    if (!el || value == null || value === '') return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.__aaAuto = el.value;
  }

  /** Remplit un champ seulement s'il est vide ou s'il porte encore notre valeur. */
  function setValSoft(el, value) {
    if (!el || value == null || value === '') return;
    var cur = el.value.trim();
    if (cur !== '' && cur !== el.__aaAuto) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.__aaAuto = el.value;
  }

  // ── Appels réseau ─────────────────────────────────────────────────────────

  var cache = new Map();
  var inflight = null;

  function fetchJSON(url) {
    if (cache.has(url)) return Promise.resolve(cache.get(url));
    if (inflight) { try { inflight.abort(); } catch (e) {} }
    var ctrl = new AbortController();
    inflight = ctrl;
    return fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) {
          if (cache.size >= MAX_CACHE) cache.clear();
          cache.set(url, data);
        }
        return data;
      })
      .catch(function () { return null; });
  }

  function searchAddresses(q) {
    var url = BAN + '?q=' + encodeURIComponent(q) + '&limit=6&autocomplete=1';
    return fetchJSON(url).then(function (data) {
      var feats = (data && data.features) || [];
      return feats.map(function (f) {
        var p = f.properties || {};
        return {
          kind: 'address',
          main: p.name || p.label || '',
          sub: [p.postcode, p.city].filter(Boolean).join(' '),
          street: p.type === 'municipality' ? '' : (p.name || ''),
          postcode: p.postcode || '',
          city: p.city || '',
          label: p.label || ''
        };
      }).filter(function (it) { return it.main; });
    });
  }

  function searchCommunes(params) {
    var url = GEO + '?' + params + '&fields=nom,code,codesPostaux,departement&limit=10';
    return fetchJSON(url).then(function (data) {
      return Array.isArray(data) ? data : [];
    });
  }

  function communeItems(list) {
    return list.map(function (c) {
      var cps = c.codesPostaux || [];
      var dep = (c.departement && c.departement.nom) || '';
      var sub = cps.length === 1
        ? [cps[0], dep].filter(Boolean).join(' · ')
        : (dep ? dep + ' · ' + cps.length + ' codes postaux' : cps.length + ' codes postaux');
      return {
        kind: 'commune',
        main: c.nom,
        sub: sub,
        city: c.nom,
        code: c.code,
        postcode: cps.length === 1 && !MULTI_CP[c.code] ? cps[0] : '',
        codesPostaux: cps
      };
    });
  }

  // ── Pays ──────────────────────────────────────────────────────────────────

  // États actuels et territoires usuels. Après la barre : autres noms sous
  // lesquels on les cherche, séparés par des points-virgules.
  var PAYS_ACTUELS = [
    'Afghanistan', 'Afrique du Sud', 'Albanie', 'Algérie', 'Allemagne', 'Andorre',
    'Angola', 'Antigua-et-Barbuda', 'Arabie saoudite', 'Argentine', 'Arménie',
    'Australie', 'Autriche', 'Azerbaïdjan', 'Bahamas', 'Bahreïn', 'Bangladesh',
    'Barbade', 'Belgique', 'Belize', 'Bénin', 'Bhoutan', 'Biélorussie|Bélarus',
    'Birmanie|Myanmar', 'Bolivie', 'Bosnie-Herzégovine', 'Botswana', 'Brésil',
    'Brunei', 'Bulgarie', 'Burkina Faso', 'Burundi', 'Cambodge', 'Cameroun',
    'Canada', 'Cap-Vert', 'Centrafrique|République centrafricaine', 'Chili',
    'Chine', 'Chypre', 'Colombie', 'Comores',
    'Congo|République du Congo;Congo-Brazzaville',
    'République démocratique du Congo|RDC;Congo-Kinshasa',
    'Corée du Nord', 'Corée du Sud', 'Costa Rica', "Côte d'Ivoire", 'Croatie',
    'Cuba', 'Danemark', 'Djibouti', 'Dominique', 'Égypte', 'Émirats arabes unis',
    'Équateur', 'Érythrée', 'Espagne', 'Estonie', 'Eswatini|Swaziland',
    'États-Unis|USA;Amérique', 'Éthiopie', 'Fidji', 'Finlande', 'France', 'Gabon',
    'Gambie', 'Géorgie', 'Ghana', 'Grèce', 'Grenade', 'Guatemala', 'Guinée',
    'Guinée-Bissau', 'Guinée équatoriale', 'Guyana', 'Haïti', 'Honduras',
    'Hongrie', 'Inde', 'Indonésie', 'Irak', 'Iran', 'Irlande', 'Islande', 'Israël',
    'Italie', 'Jamaïque', 'Japon', 'Jordanie', 'Kazakhstan', 'Kenya',
    'Kirghizistan', 'Kiribati', 'Kosovo', 'Koweït', 'Laos', 'Lesotho', 'Lettonie',
    'Liban', 'Liberia', 'Libye', 'Liechtenstein', 'Lituanie', 'Luxembourg',
    'Macédoine du Nord|Macédoine', 'Madagascar', 'Malaisie', 'Malawi', 'Maldives',
    'Mali', 'Malte', 'Maroc', 'Îles Marshall|Marshall', 'Maurice|Île Maurice',
    'Mauritanie', 'Mexique', 'Micronésie', 'Moldavie', 'Monaco', 'Mongolie',
    'Monténégro', 'Mozambique', 'Namibie', 'Nauru', 'Népal', 'Nicaragua', 'Niger',
    'Nigeria', 'Norvège', 'Nouvelle-Zélande', 'Oman', 'Ouganda', 'Ouzbékistan',
    'Pakistan', 'Palaos', 'Palestine', 'Panama', 'Papouasie-Nouvelle-Guinée',
    'Paraguay', 'Pays-Bas|Hollande', 'Pérou', 'Philippines', 'Pologne', 'Portugal',
    'Qatar', 'République dominicaine', 'Tchéquie|République tchèque', 'Roumanie',
    "Royaume-Uni|Angleterre;Grande-Bretagne;Écosse;Pays de Galles;Irlande du Nord",
    'Russie', 'Rwanda', 'Saint-Christophe-et-Niévès', 'Sainte-Lucie',
    'Saint-Marin', 'Saint-Vincent-et-les-Grenadines', 'Îles Salomon|Salomon',
    'Salvador', 'Samoa', 'Sao Tomé-et-Principe', 'Sénégal', 'Serbie',
    'Seychelles', 'Sierra Leone', 'Singapour', 'Slovaquie', 'Slovénie', 'Somalie',
    'Soudan', 'Soudan du Sud', 'Sri Lanka', 'Suède', 'Suisse', 'Suriname', 'Syrie',
    'Tadjikistan', 'Tanzanie', 'Tchad', 'Thaïlande', 'Timor oriental',
    'Togo', 'Tonga', 'Trinité-et-Tobago', 'Tunisie', 'Turkménistan', 'Turquie',
    'Tuvalu', 'Ukraine', 'Uruguay', 'Vanuatu', 'Vatican|Saint-Siège', 'Venezuela',
    'Viêt Nam|Vietnam', 'Yémen', 'Zambie', 'Zimbabwe',
    // Territoires
    'Hong Kong', 'Macao', 'Taïwan', 'Porto Rico', 'Groenland', 'Îles Féroé',
    'Gibraltar', 'Bermudes', 'Îles Caïmans', 'Curaçao', 'Aruba', 'Jersey',
    'Guernesey', 'Île de Man', 'Sahara occidental'
  ];

  // États et territoires disparus, pour les lieux de naissance seulement.
  // Nom | autres noms | période et pays d'aujourd'hui.
  var PAYS_ANCIENS = [
    'URSS|Union soviétique;Union des républiques socialistes soviétiques|1922-1991 · auj. Russie, Ukraine, Biélorussie, pays baltes, Caucase, Asie centrale',
    "Empire russe|Russie impériale|jusqu'en 1917",
    'Tchécoslovaquie||1918-1992 · auj. Tchéquie, Slovaquie',
    'Protectorat de Bohême-Moravie|Bohême;Moravie|1939-1945 · auj. Tchéquie',
    'Yougoslavie|Royaume des Serbes, Croates et Slovènes|1918-1992 · auj. Serbie, Croatie, Slovénie, Bosnie-Herzégovine, Monténégro, Macédoine du Nord, Kosovo',
    'Serbie-et-Monténégro|République fédérale de Yougoslavie|1992-2006 · auj. Serbie, Monténégro, Kosovo',
    "Allemagne de l'Est|RDA;République démocratique allemande|1949-1990 · auj. Allemagne",
    "Allemagne de l'Ouest|RFA;République fédérale d'Allemagne|1949-1990 · auj. Allemagne",
    "Reich allemand|Empire allemand;Troisième Reich|jusqu'en 1945 · auj. Allemagne, Pologne, Russie",
    "Prusse|Royaume de Prusse|jusqu'en 1947 · auj. Allemagne, Pologne, Russie",
    'Sarre|Protectorat de la Sarre|1947-1956 · auj. Allemagne',
    'Ville libre de Dantzig|Dantzig|1920-1939 · auj. Pologne',
    'Autriche-Hongrie|Empire austro-hongrois|1867-1918',
    "Empire ottoman|Turquie ottomane|jusqu'en 1922",
    "État libre d'Irlande||1922-1937 · auj. Irlande",
    "Terre-Neuve|Dominion de Terre-Neuve|jusqu'en 1949 · auj. Canada",
    "Algérie française|Algérie (départements français)|jusqu'en 1962 · auj. Algérie",
    'Maroc (protectorat français)|Protectorat français du Maroc;Maroc espagnol|1912-1956 · auj. Maroc',
    'Tunisie (protectorat français)|Protectorat français de Tunisie|1881-1956 · auj. Tunisie',
    "Libye italienne|Tripolitaine;Cyrénaïque|1912-1947 · auj. Libye",
    "Indochine française|Indochine;Tonkin;Annam;Cochinchine|jusqu'en 1954 · auj. Viêt Nam, Laos, Cambodge",
    'Nord-Viêt Nam|Vietnam du Nord;République démocratique du Viêt Nam|1945-1976 · auj. Viêt Nam',
    'Sud-Viêt Nam|Vietnam du Sud;République du Viêt Nam|1955-1976 · auj. Viêt Nam',
    'Kampuchéa démocratique|Kampuchéa;République khmère|1970-1989 · auj. Cambodge',
    "Afrique-Occidentale française|AOF|1895-1958 · auj. Sénégal, Mali, Guinée, Côte d'Ivoire, Burkina Faso, Bénin, Niger, Mauritanie",
    'Afrique-Équatoriale française|AEF|1910-1958 · auj. Gabon, Congo, Centrafrique, Tchad',
    "Soudan français||jusqu'en 1960 · auj. Mali",
    "Dahomey||jusqu'en 1975 · auj. Bénin",
    "Haute-Volta||jusqu'en 1984 · auj. Burkina Faso",
    "Oubangui-Chari||jusqu'en 1960 · auj. Centrafrique",
    'Empire centrafricain||1976-1979 · auj. Centrafrique',
    "Moyen-Congo||jusqu'en 1960 · auj. Congo",
    "Congo belge||jusqu'en 1960 · auj. République démocratique du Congo",
    'Zaïre||1971-1997 · auj. République démocratique du Congo',
    "Ruanda-Urundi||jusqu'en 1962 · auj. Rwanda, Burundi",
    'Cameroun français|Cameroun sous tutelle|1919-1960 · auj. Cameroun',
    'Togo français|Togo sous tutelle|1919-1960 · auj. Togo',
    "Côte française des Somalis|Territoire français des Afars et des Issas;TFAI|jusqu'en 1977 · auj. Djibouti",
    "Nouvelles-Hébrides||jusqu'en 1980 · auj. Vanuatu",
    "Établissements français de l'Inde|Pondichéry;Chandernagor;Karikal;Mahé;Yanaon|jusqu'en 1962 · auj. Inde",
    "Inde britannique|Empire des Indes;Raj britannique|jusqu'en 1947 · auj. Inde, Pakistan, Bangladesh, Birmanie",
    'Pakistan oriental||1947-1971 · auj. Bangladesh',
    "Ceylan||jusqu'en 1972 · auj. Sri Lanka",
    "Siam||jusqu'en 1939 · auj. Thaïlande",
    "Perse||jusqu'en 1935 · auj. Iran",
    'Palestine mandataire|Palestine (mandat britannique)|1920-1948 · auj. Israël, Palestine',
    'Transjordanie||1921-1949 · auj. Jordanie',
    'Levant (mandat français)|Syrie (mandat français);Liban (mandat français);États du Levant|1920-1946 · auj. Syrie, Liban',
    'République arabe unie|RAU|1958-1971 · auj. Égypte, Syrie',
    'Yémen du Nord|République arabe du Yémen|1962-1990 · auj. Yémen',
    'Yémen du Sud|Aden;République démocratique populaire du Yémen|1967-1990 · auj. Yémen',
    'Abyssinie||auj. Éthiopie',
    "Rhodésie|Rhodésie du Sud|jusqu'en 1980 · auj. Zimbabwe",
    "Rhodésie du Nord||jusqu'en 1964 · auj. Zambie",
    "Nyassaland||jusqu'en 1964 · auj. Malawi",
    "Bechuanaland||jusqu'en 1966 · auj. Botswana",
    "Basutoland||jusqu'en 1966 · auj. Lesotho",
    "Tanganyika||jusqu'en 1964 · auj. Tanzanie",
    "Zanzibar||jusqu'en 1964 · auj. Tanzanie",
    "Gold Coast|Côte-de-l'Or|jusqu'en 1957 · auj. Ghana",
    "Sud-Ouest africain|Afrique du Sud-Ouest|jusqu'en 1990 · auj. Namibie",
    "Guinée portugaise||jusqu'en 1974 · auj. Guinée-Bissau",
    "Guinée espagnole||jusqu'en 1968 · auj. Guinée équatoriale",
    "Sahara espagnol||jusqu'en 1976 · auj. Sahara occidental",
    "Somaliland britannique|Somalie italienne|jusqu'en 1960 · auj. Somalie",
    "Formose||auj. Taïwan",
    'Mandchoukouo||1932-1945 · auj. Chine',
    "Indes néerlandaises|Indes orientales néerlandaises|jusqu'en 1949 · auj. Indonésie",
    'Malaya|Fédération de Malaya|1948-1963 · auj. Malaisie',
    "Sikkim||jusqu'en 1975 · auj. Inde",
    "Hong Kong britannique||jusqu'en 1997 · auj. Chine",
    "Macao portugais||jusqu'en 1999 · auj. Chine",
    "Antilles néerlandaises||jusqu'en 2010 · auj. Curaçao, Sint Maarten, Pays-Bas caribéens"
  ];

  function paysListe(src, ancien) {
    return src.map(function (ligne) {
      var t = ligne.split('|');
      var noms = [t[0]].concat(t[1] ? t[1].split(';') : []);
      return {
        nom: t[0],
        sub: ancien ? 'Ancien État · ' + (t[2] || '').replace(/(\d{4})-(\d{4})/, '$1–$2') : '',
        cles: noms.map(norm),
        ancien: ancien
      };
    });
  }

  var PAYS = null;   // construit à la première recherche

  /**
   * Pays dont un nom commence par la saisie (rang 0) ou dont un mot du nom
   * commence par elle (rang 1) : « congo » trouve aussi « République
   * démocratique du Congo ». Les États actuels passent avant les anciens.
   */
  function searchCountries(q, avecAnciens) {
    if (!PAYS) PAYS = paysListe(PAYS_ACTUELS, false).concat(paysListe(PAYS_ANCIENS, true));
    var n = norm(q).trim();
    if (!n) return [];
    var found = [];
    PAYS.forEach(function (p) {
      if (p.ancien && !avecAnciens) return;
      var rang = -1;
      p.cles.forEach(function (c) {
        if (c.indexOf(n) === 0) rang = 0;
        else if (rang < 0 && (' ' + c.replace(/[-'(]/g, ' ')).indexOf(' ' + n) >= 0) rang = 1;
      });
      if (rang >= 0) found.push({ p: p, r: rang * 2 + (p.ancien ? 1 : 0) });
    });
    found.sort(function (a, b) { return a.r - b.r || a.p.nom.localeCompare(b.p.nom, 'fr'); });
    return found.slice(0, 12).map(function (f) {
      return { kind: 'country', main: f.p.nom, sub: f.p.sub, value: f.p.nom.toUpperCase() };
    });
  }

  // ── Menu de suggestions ───────────────────────────────────────────────────

  var menu = null;
  var current = null;   // { el, role, items, index }

  function buildMenu() {
    var style = document.createElement('style');
    style.textContent = [
      '.aa-menu{background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden;display:none;',
      "font-size:14px;color:#1a1a1a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;}",
      '.aa-menu.open{display:block;}',
      // Sur grand écran, le menu flotte au-dessus de la page.
      '.aa-menu.aa-float{position:fixed;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.10);}',
      // Sur mobile, il s'insère sous le champ : aucun calcul de position, donc
      // rien qui puisse le placer hors de l'écran.
      '.aa-menu.aa-inline{position:static;width:auto;margin:6px 0 2px;box-shadow:0 2px 8px rgba(0,0,0,.06);}',
      '.aa-inline .aa-list{max-height:240px;}',
      '.aa-list{overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;}',
      '.aa-item{padding:8px 11px;cursor:pointer;border-bottom:1px solid #f2f2f2;line-height:1.35;}',
      // Au doigt, il faut de quoi viser.
      '@media (pointer:coarse){.aa-item{padding:11px 12px;}}',
      '.aa-item:last-child{border-bottom:none;}',
      '.aa-item.on,.aa-item:hover{background:#f5f5f5;}',
      '.aa-main{display:block;color:#111;}',
      '.aa-sub{display:block;font-size:12px;color:#999;margin-top:1px;}'
    ].join('');
    document.head.appendChild(style);

    menu = document.createElement('div');
    menu.className = 'aa-menu';
    menu.setAttribute('role', 'listbox');
    menu.id = 'aa-menu';
    menu.innerHTML = '<div class="aa-list"></div>';
    document.body.appendChild(menu);

    // mousedown : on agit avant le blur du champ.
    menu.addEventListener('mousedown', function (ev) {
      var item = ev.target.closest('.aa-item');
      if (!item) return;
      ev.preventDefault();
      choose(+item.dataset.i);
    });
  }

  var GAP = 4;      // écart entre le champ et le menu
  var EDGE = 8;     // marge minimale aux bords de l'écran
  var MIN_H = 96;   // en deçà, le menu ne vaut plus la peine d'être ouvert
  var MAX_H = 280;

  /**
   * Zone réellement visible, en coordonnées de la fenêtre de mise en page —
   * les mêmes que celles de getBoundingClientRect() et de `position: fixed`.
   *
   * Sur mobile, `window.innerHeight` ne diminue pas quand le clavier virtuel
   * s'ouvre : seul visualViewport rend compte de la place qui reste. S'en
   * remettre à innerHeight fait croire à une hauteur disponible qui n'existe
   * pas, et le menu se retrouve placé hors de l'écran.
   */
  function viewport() {
    var vv = window.visualViewport;
    if (!vv) return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
    return { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height };
  }

  /**
   * Sur mobile, le menu s'insère dans le flux plutôt que de flotter.
   *
   * `position: fixed` est pris en défaut dès que le clavier virtuel est
   * ouvert : iOS décale la fenêtre visible sans en informer la mise en page,
   * et l'élément se retrouve hors de l'écran quoi qu'on calcule. Inséré sous
   * le champ, le menu est placé par le navigateur — il ne peut plus se perdre.
   */
  function useInline() {
    return window.matchMedia
      ? window.matchMedia('(max-width: 700px), (pointer: coarse)').matches
      : window.innerWidth <= 700;
  }

  function place() {
    if (!current || !menu || current.inline) return;
    var r = current.el.getBoundingClientRect();
    var v = viewport();
    var list = menu.querySelector('.aa-list');

    // Hauteur naturelle, avant toute contrainte, pour connaître la hauteur du
    // pied et des bordures.
    list.style.maxHeight = 'none';
    var natural = menu.offsetHeight;
    var chrome = natural - list.offsetHeight;

    var below = v.top + v.height - r.bottom - GAP - EDGE;
    var above = r.top - v.top - GAP - EDGE;
    var down = below >= Math.min(natural, MIN_H) || below >= above;
    var avail = Math.min(MAX_H, Math.max(down ? below : above, MIN_H));

    list.style.maxHeight = Math.max(avail - chrome, 48) + 'px';
    var h = menu.offsetHeight;

    var minLeft = v.left + EDGE;
    var maxLeft = v.left + v.width - EDGE - r.width;
    var left = maxLeft > minLeft ? Math.min(Math.max(r.left, minLeft), maxLeft) : minLeft;

    menu.style.left = Math.round(left) + 'px';
    menu.style.width = Math.round(r.width) + 'px';
    menu.style.top = Math.round(down ? r.bottom + GAP : r.top - GAP - h) + 'px';
  }

  function close() {
    if (!menu || !menu.classList.contains('open')) return;
    menu.classList.remove('open');
    if (current) {
      current.el.removeAttribute('aria-expanded');
      current.el.removeAttribute('aria-activedescendant');
    }
    current = null;
    // Le menu ne reste jamais dans le formulaire : les pages remplacent des
    // sections entières par innerHTML, autant ne rien laisser sur leur chemin.
    if (menu.parentNode !== document.body) document.body.appendChild(menu);
  }

  /**
   * Remonte le champ vers le haut de la zone visible pour dégager la place
   * qu'occupera la liste. Sans cela, un champ situé juste au-dessus du clavier
   * verrait ses suggestions s'afficher derrière celui-ci.
   */
  function revealField(el) {
    var v = viewport();
    // La liste tient déjà sous le champ : inutile de bouger la page.
    if (v.top + v.height - el.getBoundingClientRect().bottom >= menu.offsetHeight + 16) return;

    // On vise le bloc entier, libellé compris : remonter jusqu'au champ seul
    // ferait disparaître son intitulé sous le bord de l'écran.
    var bloc = el.closest('.field, .fg') || el;
    var delta = bloc.getBoundingClientRect().top - (v.top + 12);
    if (delta <= 8) return;                       // on ne descend jamais le champ
    try { window.scrollBy({ top: delta, behavior: 'smooth' }); }
    catch (e) { window.scrollBy(0, delta); }
  }

  function open(el, role, items) {
    if (!menu || !items.length) { close(); return; }
    var inline = useInline();
    var reopening = menu.classList.contains('open') && current && current.el === el;
    current = { el: el, role: role, items: items, index: -1, inline: inline };

    menu.classList.toggle('aa-inline', inline);
    menu.classList.toggle('aa-float', !inline);
    if (inline) {
      // Juste après le champ, à l'intérieur de son bloc : la ligne .row2/.row3
      // repasse sur une colonne en dessous de 640 px, le menu occupe donc
      // toute la largeur utile.
      menu.style.left = menu.style.top = menu.style.width = '';
      menu.querySelector('.aa-list').style.maxHeight = '';
      if (menu.previousSibling !== el) el.parentNode.insertBefore(menu, el.nextSibling);
    } else if (menu.parentNode !== document.body) {
      document.body.appendChild(menu);
    }

    var list = menu.querySelector('.aa-list');
    list.innerHTML = items.map(function (it, i) {
      return '<div class="aa-item" role="option" id="aa-opt-' + i + '" data-i="' + i + '">' +
        '<span class="aa-main">' + esc(it.main) + '</span>' +
        (it.sub ? '<span class="aa-sub">' + esc(it.sub) + '</span>' : '') +
        '</div>';
    }).join('');
    list.scrollTop = 0;
    menu.classList.add('open');
    el.setAttribute('aria-expanded', 'true');
    el.setAttribute('aria-controls', 'aa-menu');
    place();
    if (inline && !reopening) revealField(el);
  }

  function highlight(i) {
    if (!current) return;
    var items = menu.querySelectorAll('.aa-item');
    if (!items.length) return;
    if (current.index >= 0 && items[current.index]) items[current.index].classList.remove('on');
    current.index = (i + items.length) % items.length;
    var node = items[current.index];
    node.classList.add('on');
    current.el.setAttribute('aria-activedescendant', node.id);
    var list = menu.querySelector('.aa-list');
    if (node.offsetTop < list.scrollTop) list.scrollTop = node.offsetTop;
    else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight;
    }
  }

  // ── Application d'une suggestion ──────────────────────────────────────────

  function choose(i) {
    if (!current) return;
    var el = current.el, role = current.role, it = current.items[i];
    close();
    if (!it) return;

    if (role === 'street') {
      var cp = findRelated(el, 'postcode');
      var vil = findRelated(el, 'city');
      if (cp || vil) {
        // La voie d'un côté, le code postal et la ville de l'autre. Si la
        // suggestion retenue est une commune, la ligne de voie est vidée : le
        // nom de la commune n'a rien à y faire.
        setVal(el, it.street, true);
        setVal(cp, it.postcode);
        setVal(vil, it.city);
      } else {
        // Champ « adresse complète » isolé : on y met la ligne entière.
        setVal(el, it.label || [it.street, it.postcode, it.city].filter(Boolean).join(' '));
      }
      var pays = findRelated(el, 'country');
      if (pays && pays.value.trim() === '') setVal(pays, 'FRANCE');

    } else if (role === 'city' || role === 'placeCity') {
      setVal(el, it.city);
      if (it.postcode) setValSoft(findRelated(el, PARTNER[role]), it.postcode);

    } else if (role === 'postcode' || role === 'placePostcode') {
      // La commune vient du code postal : si celui-ci est corrigé, elle doit
      // pouvoir l'être aussi.
      setValAuto(findRelated(el, PARTNER[role]), it.city);

    } else if (role === 'cityPostcode') {
      setVal(el, it.value || it.city);
    } else if (role === 'country' || role === 'placeCountry') {
      setVal(el, it.value);
    }

    el.focus();
  }

  // ── Déclenchement ─────────────────────────────────────────────────────────

  var timer = null;
  var seq = 0;

  function suggest(el) {
    var role = roleOf(el);
    if (!role) { close(); return; }

    // Pays : liste embarquée, aucun appel réseau. Les États disparus ne sont
    // proposés que pour un lieu de naissance.
    if (role === 'country' || role === 'placeCountry') {
      if (el.value.trim().length < 2) { close(); return; }
      var pays = searchCountries(el.value, role === 'placeCountry');
      // Valeur déjà choisie (l'insertion relance la saisie) : rien à proposer.
      if (pays.length && pays[0].value === el.value.trim().toUpperCase()) { close(); return; }
      open(el, role, pays);
      return;
    }

    // Naissance à l'étranger : les communes françaises ne servent à rien.
    if (role === 'placeCity' || role === 'placePostcode') {
      var paysNa = findRelated(el, 'placeCountry');
      if (paysNa && !isFrance(paysNa.value)) { close(); return; }
    }

    // Adresse à l'étranger : les référentiels français ne servent à rien.
    // (Un lieu de naissance ne dépend pas du pays de domicile : on ne teste
    // que les champs d'adresse.)
    if (role === 'street' || role === 'city' || role === 'postcode') {
      var pays = findRelated(el, 'country');
      if (pays && !isFrance(pays.value)) { close(); return; }
    }

    var q = el.value.trim();
    var token = ++seq;
    var done = function (items) {
      if (token !== seq || document.activeElement !== el) return;
      open(el, role, items);
    };

    if (role === 'postcode' || role === 'placePostcode') {
      if (!/^\d{5}$/.test(q)) { close(); return; }
      searchCommunes('codePostal=' + q).then(function (list) {
        if (token !== seq) return;
        var items = communeItems(list);
        var villeEl = findRelated(el, PARTNER[role]);
        if (items.length === 1) {
          // Un seul choix possible : on complète sans rien demander.
          setValSoft(villeEl, items[0].city);
          close();
          return;
        }
        // Plusieurs communes partagent ce code postal : on laisse choisir.
        if (villeEl && villeEl.value.trim() !== '' && villeEl.value.trim() !== villeEl.__aaAuto) { close(); return; }
        done(items);
      });
      return;
    }

    if (q.length < MIN_CHARS) { close(); return; }

    if (role === 'street') {
      searchAddresses(q).then(done);
      return;
    }

    // 'city', 'placeCity' et 'cityPostcode'
    searchCommunes('nom=' + encodeURIComponent(q) + '&boost=population').then(function (list) {
      var items = communeItems(list);
      if (role === 'cityPostcode') {
        // Le champ attend « code postal + commune » : on développe les communes
        // à codes multiples, sauf celles qui en ont trop (Paris, Lyon…).
        var out = [];
        items.forEach(function (c) {
          var cps = MULTI_CP[c.code] ? [] : (c.codesPostaux || []);
          if (cps.length > 1 && cps.length <= 6) {
            cps.forEach(function (cp) {
              out.push({ main: cp + ' ' + c.main, sub: c.sub, value: cp + ' ' + c.main, city: c.main });
            });
          } else if (cps.length === 1) {
            out.push({ main: cps[0] + ' ' + c.main, sub: c.sub, value: cps[0] + ' ' + c.main, city: c.main });
          } else {
            out.push({ main: c.main, sub: c.sub, value: c.main, city: c.main });
          }
        });
        items = out.slice(0, 12);
      }
      done(items);
    });
  }

  // ── Écouteurs délégués (les formulaires se re-rendent en permanence) ──────

  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (!el || el.tagName !== 'INPUT' || !roleOf(el)) return;
    if (!el.hasAttribute('aria-autocomplete')) {
      // On ne touche pas à l'attribut `autocomplete` : les pages y déclarent le
      // type de donnée personnelle attendu, ce qui permet au navigateur de
      // proposer celles qu'il connaît déjà de l'utilisateur. Nos suggestions
      // s'ajoutent à cette proposition, elles ne la remplacent pas.
      el.setAttribute('role', 'combobox');
      el.setAttribute('aria-autocomplete', 'list');
      el.setAttribute('aria-controls', 'aa-menu');
    }
    clearTimeout(timer);
    timer = setTimeout(function () { suggest(el); }, DEBOUNCE_MS);
  }, true);

  document.addEventListener('keydown', function (ev) {
    if (!current || ev.target !== current.el) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); highlight(current.index + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(current.index - 1); }
    else if (ev.key === 'Enter') {
      if (current.index >= 0) { ev.preventDefault(); choose(current.index); }
    } else if (ev.key === 'Escape' || ev.key === 'Tab') { close(); }
  }, true);

  document.addEventListener('focusout', function (ev) {
    if (current && ev.target === current.el) setTimeout(close, 120);
  }, true);

  document.addEventListener('mousedown', function (ev) {
    if (current && menu && !menu.contains(ev.target) && ev.target !== current.el) close();
  }, true);

  window.addEventListener('scroll', function () { if (current) place(); }, true);
  window.addEventListener('resize', function () { if (current) place(); });

  // Ouverture et fermeture du clavier virtuel : la zone visible change sans
  // qu'aucun événement de redimensionnement classique ne soit émis.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () { if (current) place(); });
    window.visualViewport.addEventListener('scroll', function () { if (current) place(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildMenu);
  } else {
    buildMenu();
  }
})();
