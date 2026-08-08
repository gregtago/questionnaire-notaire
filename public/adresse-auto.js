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
   * | 'cityPostcode' | 'country' | null
   */
  function detectRole(el) {
    if (!el || el.tagName !== 'INPUT') return null;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type !== 'text' && type !== 'search') return null;
    if (el.disabled || el.readOnly) return null;

    var k = keyOf(el);
    if (!k) return null;
    if (/mail|courriel|iban|bic|swift|siren|siret|complement/.test(k)) return null;

    if (/pays|country/.test(k)) return 'country';
    if (/cpvil|(cp|code postal)[^a-z]{0,6}(\+|et)[^a-z]{0,3}commune/.test(k)) return 'cityPostcode';

    var place = IS_PLACE.test(k);
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
    }

    el.focus();
  }

  // ── Déclenchement ─────────────────────────────────────────────────────────

  var timer = null;
  var seq = 0;

  function suggest(el) {
    var role = roleOf(el);
    if (!role || role === 'country') { close(); return; }

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
