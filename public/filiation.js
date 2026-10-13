/**
 * Filiation des Français nés à l'étranger.
 *
 * L'acte de naissance d'un Français né à l'étranger est tenu par le Service
 * central d'état civil (Nantes) : pour le demander comme pour rédiger l'acte,
 * il faut les noms, prénoms, dates et lieux de naissance (avec le pays) des
 * deux parents. Ce module fournit aux questionnaires le bloc de saisie
 * correspondant, qui n'apparaît que lorsque la personne est de nationalité
 * française et née hors de France.
 *
 * Les champs portent un attribut data-f : ils sont reliés au modèle de la page
 * par son propre code de liaison, comme tous les autres champs d'état civil.
 */
(function () {
  'use strict';

  var PARENTS = [
    { cle: 'PERE', titre: 'Père', nom: 'Nom' },
    { cle: 'MERE', titre: 'Mère', nom: 'Nom de naissance' }
  ];

  // Champs ajoutés au modèle d'une personne, dans l'ordre d'affichage.
  var CHAMPS = [];
  PARENTS.forEach(function (pa) {
    ['NOM', 'PRENOMS', 'DATNA', 'LIEUNA', 'PAYSNA'].forEach(function (c) {
      CHAMPS.push(pa.cle + '_' + c);
    });
  });

  function norm(s) {
    return (s == null ? '' : String(s))
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().trim();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** Pays vide ou France : naissance en France. */
  function estFrance(pays) {
    var n = norm(pays);
    return n === '' || n === 'fr' || n === 'france';
  }

  /** Nationalité française, seule ou parmi d'autres (« française et marocaine »). */
  function estFrancais(nation) {
    return /fran[cç]/.test(norm(nation));
  }

  /** La filiation est demandée : Français né hors de France. */
  function requise(p) {
    return !!p && !estFrance(p.CPAYNA) && estFrancais(p.NATION);
  }

  function champ(p, f, libelle, type, oblig) {
    return '<div class="field"><label>' + libelle +
      (oblig ? ' <span class="req">*</span>' : '') + '</label>' +
      '<input type="' + (type || 'text') + '" data-f="' + f + '" value="' + esc(p[f]) + '"></div>';
  }

  function blocParent(p, pa) {
    var k = pa.cle + '_';
    if (!p[k + 'PAYSNA']) p[k + 'PAYSNA'] = '';
    return '<div class="filiation-parent">' +
      '<div class="sec-title" style="margin:14px 0 12px">' + pa.titre + '</div>' +
      '<div class="row2">' +
        champ(p, k + 'NOM', pa.nom, 'text', true) +
        champ(p, k + 'PRENOMS', 'Prénoms', 'text', true) +
      '</div>' +
      '<div class="row3">' +
        champ(p, k + 'DATNA', 'Date de naissance', 'date', true) +
        champ(p, k + 'PAYSNA', 'Pays de naissance', 'text', true) +
        champ(p, k + 'LIEUNA', 'Lieu de naissance (ville)', 'text', true) +
      '</div>' +
    '</div>';
  }

  /** Bloc complet, masqué tant que la filiation n'est pas requise. */
  function bloc(p) {
    return '<div class="cond filiation' + (requise(p) ? ' show' : '') + '">' +
      '<div class="sec-title">Filiation — Français né à l\'étranger</div>' +
      '<p style="font-size:12px;color:#888;line-height:1.6;margin:-8px 0 4px">' +
        'L\'acte de naissance d\'un Français né à l\'étranger est détenu par le Service central d\'état civil ' +
        '(Nantes). Pour le demander et préparer l\'acte, nous avons besoin des ' +
        'renseignements suivants sur les parents. Indiquez le pays tel qu\'il ' +
        's\'appelait à leur naissance (ex. : URSS, Yougoslavie, Algérie française).' +
      '</p>' +
      PARENTS.map(function (pa) { return blocParent(p, pa); }).join('') +
    '</div>';
  }

  /**
   * Met l'affichage en accord avec la saisie, sans re-rendre la page (ce qui
   * ferait perdre le focus) : bloc de filiation et code postal de naissance,
   * sans objet pour une naissance à l'étranger.
   */
  function maj(sec, p) {
    if (!sec || !p) return;
    var f = sec.querySelector('.filiation');
    if (f) f.classList.toggle('show', requise(p));
    var cp = sec.querySelector('input[data-f="CODERU"]');
    var champCp = cp && cp.closest('.field');
    if (champCp) champCp.style.display = estFrance(p.CPAYNA) ? '' : 'none';
  }

  /** Message d'erreur, ou chaîne vide si la filiation est complète. */
  function verifier(p, qui) {
    if (!requise(p)) return '';
    var manque = [];
    PARENTS.forEach(function (pa) {
      var k = pa.cle + '_';
      if (!p[k + 'NOM'] || !p[k + 'PRENOMS'] || !p[k + 'DATNA'] || !p[k + 'LIEUNA'] || !p[k + 'PAYSNA']) {
        manque.push(pa.cle === 'PERE' ? 'du père' : 'de la mère');
      }
    });
    if (!manque.length) return '';
    return qui + ' : naissance à l\'étranger, merci de compléter la filiation — nom, ' +
      'prénoms, date, lieu et pays de naissance ' + manque.join(' et ') + '.';
  }

  /** Avant l'envoi : on ne transmet pas une filiation devenue sans objet. */
  function nettoyer(p) {
    if (!p || requise(p)) return;
    CHAMPS.forEach(function (c) { delete p[c]; });
  }

  window.Filiation = {
    CHAMPS: CHAMPS,
    MAJUSCULES: ['PERE_NOM', 'MERE_NOM', 'PERE_LIEUNA', 'MERE_LIEUNA', 'PERE_PAYSNA', 'MERE_PAYSNA'],
    PRENOMS: ['PERE_PRENOMS', 'MERE_PRENOMS'],
    estFrance: estFrance,
    requise: requise,
    bloc: bloc,
    maj: maj,
    verifier: verifier,
    nettoyer: nettoyer
  };
})();
