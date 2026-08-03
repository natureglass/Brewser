// Achievements page — renders ALL bundled achievements grouped by tier, with
// the signed-in user's EARNED ones highlighted and the rest locked (greyed +
// their unlock criteria shown). Two local documents drive it:
//   - configs/achievements.json     — the bundled criteria catalogue (all 38,
//     with `tiers` + per-achievement id/name/tier/description/criteria/source/
//     scope). Seeded from romfs; always present.
//   - configs/my-achievements.json  — the WordPress-generated set of badges the
//     signed-in user has earned (written by Check-for-Updates). Absent until a
//     signed-in sync runs → every badge renders locked.
// Badge art is bundled at brewser://assets/achievements/<slug>.png (slug == the
// criteria `id` == the WP achievement term slug), so the page works offline.
(function () {
  var APP_ROOT = 'sdmc:/switch/brewser/';
  var CRITERIA_PATH = APP_ROOT + 'configs/achievements.json';
  var EARNED_PATH = APP_ROOT + 'configs/my-achievements.json';

  var root = document.getElementById('ach-root');
  var summary = document.getElementById('ach-summary');
  if (!root) { console.debug('[achievements] init aborted; #ach-root missing'); return; }

  function readJson(path) {
    try {
      var data = Switch.readFileSync(path);
      if (!data) return null;
      return JSON.parse(new TextDecoder().decode(data));
    } catch (e) {
      console.debug('[achievements] read/parse failed for ' + path + ': ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Ordered tier list from the criteria catalogue, or derived from the
  // achievements' own tier numbers when the `tiers` array is absent.
  function deriveTiers(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var tn = list[i].tier;
      if (tn == null || seen[tn]) continue;
      seen[tn] = true;
      out.push({ tier: tn, name: list[i].tierName || '', blurb: '' });
    }
    out.sort(function (a, b) { return (a.tier || 0) - (b.tier || 0); });
    return out;
  }

  var criteria = readJson(CRITERIA_PATH);
  var earnedDoc = readJson(EARNED_PATH);

  // Earned badges only count while a session is active. Signed out → every badge
  // renders locked/transparent regardless of whether my-achievements.json still
  // exists on disk (a stale cache from a prior session must not show as earned).
  // __swbAuth comes from auth-shared.js (loaded before this script in
  // achievements.html); if it's somehow missing, treat as signed out.
  function isSignedIn() {
    try {
      var a = globalThis.__swbAuth;
      return !!(a && typeof a.readActiveSession === 'function' && a.readActiveSession());
    } catch (_) { return false; }
  }
  var signedIn = isSignedIn();

  // Earned key set — index by both the stable id and the slug so a synced or
  // pre-sync payload both match the criteria `id`. Lowercased for safety.
  var earnedSet = {};
  var earnedList = (signedIn && earnedDoc && Array.isArray(earnedDoc.achievements)) ? earnedDoc.achievements : [];
  for (var i = 0; i < earnedList.length; i++) {
    var e = earnedList[i];
    if (!e) continue;
    if (e.id) earnedSet[String(e.id).toLowerCase()] = true;
    if (e.slug) earnedSet[String(e.slug).toLowerCase()] = true;
  }
  function isEarned(id) {
    return Object.prototype.hasOwnProperty.call(earnedSet, String(id).toLowerCase());
  }

  function badgeHtml(a, earned) {
    var slug = String(a.id || a.slug || '');
    var img = 'brewser://assets/achievements/' + encodeURIComponent(slug) + '.png';
    var cls = 'ach-badge ' + (earned ? 'ach-badge--earned' : 'ach-badge--locked');
    var name = escapeHtml(a.name || slug);
    // Detail payload the tap handler reads back to populate the badge modal
    // (see wireBadges / showModal). JSON in a double-quoted attribute, so
    // escapeHtml quotes the " & < > that the descriptions contain.
    var detail = escapeHtml(JSON.stringify({
      slug: slug,
      name: a.name || slug,
      tier: a.tier,
      tierName: a.tierName || '',
      description: a.description || '',
      criteria: a.criteria || '',
      img: img,
      earned: !!earned
    }));
    // Each badge is a listener-only <a> (no href) — the same proven tap-target
    // shape the app-catalogue cards use — so a tap fires the click handler
    // instead of navigating. Not-yet-earned badges are dimmed to 50% via the
    // `--locked` class (see achievements.html).
    return '<a class="' + cls + '" title="' + name + '" data-ach="' + detail + '">'
      + '<img class="ach-badge__img" src="' + img + '" alt="' + name + '" width="112" height="112">'
      + '<div class="ach-badge__name">' + name + '</div>'
      + '</a>';
  }

  var allAch = (criteria && Array.isArray(criteria.achievements)) ? criteria.achievements : [];
  var tiers = (criteria && Array.isArray(criteria.tiers) && criteria.tiers.length) ? criteria.tiers : deriveTiers(allAch);
  var earnedCount = 0;
  var html = '';

  if (allAch.length) {
    // Group by tier number, in the tier order the criteria catalogue declares.
    for (var t = 0; t < tiers.length; t++) {
      var tierNum = tiers[t].tier;
      var group = [];
      for (var g = 0; g < allAch.length; g++) {
        if (allAch[g].tier === tierNum) group.push(allAch[g]);
      }
      if (!group.length) continue;
      var gEarned = 0;
      var cards = '';
      for (var c = 0; c < group.length; c++) {
        var earned = isEarned(group[c].id);
        if (earned) { gEarned++; earnedCount++; }
        cards += badgeHtml(group[c], earned);
      }
      // Each tier renders as a <fieldset>/<legend> group so the page matches
      // the Settings page's sectioned look — the tier name is the legend, the
      // blurb + earned count sit on the head row, badges fill the grid. The
      // fieldset/legend chrome (background, border, legend colour) lives in the
      // per-theme stylesheets (themes/styles/*.css, `fieldset.ach-group`).
      html += '<fieldset class="ach-group">'
        + '<legend>Tier ' + escapeHtml(tiers[t].tier) + ' — ' + escapeHtml(tiers[t].name || '') + '</legend>'
        + '<div class="ach-tier__head">'
        + (tiers[t].blurb ? '<p class="ach-tier__blurb">' + escapeHtml(tiers[t].blurb) + '</p>' : '')
        + '<span class="ach-tier__count">' + gEarned + ' / ' + group.length + '</span>'
        + '</div>'
        + '<div class="ach-grid">' + cards + '</div>'
        + '</fieldset>';
    }
  } else if (earnedList.length) {
    // No bundled criteria catalogue — render just the earned set as a flat grid
    // inside a single fieldset so it keeps the same sectioned look as the
    // tier-grouped path above.
    var flat = '';
    for (var k = 0; k < earnedList.length; k++) { flat += badgeHtml(earnedList[k], true); earnedCount++; }
    html = '<fieldset class="ach-group"><legend>Earned</legend>'
      + '<div class="ach-grid">' + flat + '</div></fieldset>';
  } else {
    html = '<p class="ach-empty">No achievements to show yet. Sign in and press Check for Updates on the Apps page to sync your earned badges.</p>';
  }

  root.innerHTML = html;
  if (summary) {
    var total = allAch.length || earnedList.length;
    // Signed out → every badge renders locked, so a "0 of 38 earned" count is
    // misleading; prompt the user to sign in instead.
    if (!signedIn) {
      summary.textContent = 'Log in to see your earned achievements.';
    } else {
      summary.innerHTML = total ? (earnedCount + ' of ' + total + ' earned') : '';
    }
  }

  // ---- Badge detail modal -------------------------------------------------
  // The overlay markup is static in achievements.html; we populate + toggle it
  // here. Visibility is driven by classList (NOT style.display) so the
  // live-DOM paint cache invalidates and the closed modal is actually erased —
  // the same constraint the app-catalogue modal documents (missing-app-modal.js).
  var overlay = document.getElementById('ach-modal-overlay');
  var mBadge = document.getElementById('ach-modal-badge');
  var mTitle = document.getElementById('ach-modal-title');
  var mTier = document.getElementById('ach-modal-tier');
  var mStatus = document.getElementById('ach-modal-status');
  var mDesc = document.getElementById('ach-modal-desc');
  var mCriteria = document.getElementById('ach-modal-criteria');
  var mClose = document.getElementById('ach-modal-close');
  var modalOpen = false;

  function showModal(d) {
    if (!overlay) return;
    d = d || {};
    if (mBadge) {
      mBadge.setAttribute('src', d.img
        || ('brewser://assets/achievements/' + encodeURIComponent(String(d.slug || '')) + '.png'));
      mBadge.setAttribute('alt', d.name || '');
      // Mirror the grid's 50%-dim treatment for not-yet-earned badges.
      if (d.earned) mBadge.classList.remove('ach-modal-badge--locked');
      else mBadge.classList.add('ach-modal-badge--locked');
    }
    if (mTitle) mTitle.textContent = d.name || d.slug || 'Achievement';
    if (mTier) {
      var tierTxt = (d.tier != null ? 'Tier ' + d.tier : '');
      if (d.tier != null && d.tierName) tierTxt += ' · ';
      tierTxt += (d.tierName || '');
      mTier.textContent = tierTxt;
    }
    // Earned vs locked pill. The locked copy is the "you haven't earned this"
    // line the request asked for; the palette lives in the theme sheets
    // (.ach-modal-status--earned / --locked).
    if (mStatus) {
      if (d.earned) {
        mStatus.textContent = '✓ Earned';
        mStatus.classList.add('ach-modal-status--earned');
        mStatus.classList.remove('ach-modal-status--locked');
      } else {
        mStatus.textContent = "You haven't earned this yet";
        mStatus.classList.add('ach-modal-status--locked');
        mStatus.classList.remove('ach-modal-status--earned');
      }
    }
    if (mDesc) {
      var desc = d.description || '';
      mDesc.textContent = desc;
      if (desc.replace(/^\s+|\s+$/g, '') === '') mDesc.classList.add('ach-modal-hidden');
      else mDesc.classList.remove('ach-modal-hidden');
    }
    if (mCriteria) {
      var crit = d.criteria || '';
      if (crit.replace(/^\s+|\s+$/g, '') !== '') {
        mCriteria.innerHTML = '<strong>How to earn:</strong> ' + escapeHtml(crit);
        mCriteria.classList.remove('ach-modal-hidden');
      } else {
        mCriteria.innerHTML = '';
        mCriteria.classList.add('ach-modal-hidden');
      }
    }
    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;
  }

  function closeModal() {
    if (!overlay) return;
    overlay.classList.remove('app-modal-overlay--open');
    modalOpen = false;
  }

  // Per-element wiring — the live-DOM has no event delegation, so bind each
  // badge's click with its own element closured in (matches wireAppCards).
  function wireBadges() {
    var badges = document.querySelectorAll('[data-ach]');
    for (var i = 0; i < badges.length; i++) {
      (function (el) {
        if (el.getAttribute('data-tap-wired')) return;
        el.setAttribute('data-tap-wired', '1');
        el.addEventListener('click', function (e) {
          var raw = el.getAttribute('data-ach');
          var d = {};
          if (raw) { try { d = JSON.parse(raw); } catch (_) { /* fall through */ } }
          showModal(d);
          if (e && e.preventDefault) e.preventDefault();
          if (e && e.stopPropagation) e.stopPropagation();
        });
      })(badges[i]);
    }
  }
  wireBadges();

  if (mClose) {
    mClose.addEventListener('click', function (e) {
      closeModal();
      if (e && e.stopPropagation) e.stopPropagation();
    });
  }
  // Backdrop tap → close (only when the tap lands on the overlay itself, not
  // inside the card — the card tap bubbles up through the overlay).
  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e && e.target === overlay) closeModal();
    });
  }
  // B (contextmenu) + L/Escape close the modal, so the console back buttons
  // feel consistent with the app-catalogue modal. The no-op mousedown listener
  // flips the shell's B→contextmenu routing gate (see missing-app-modal.js).
  window.addEventListener('mousedown', function () { /* gate */ });
  window.addEventListener('contextmenu', function (e) {
    if (!modalOpen) return;
    closeModal();
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  });
  window.addEventListener('keydown', function (e) {
    if (!modalOpen) return;
    var key = e && e.key;
    if (key === 'Escape' || key === 'Esc') {
      closeModal();
      if (e && e.preventDefault) e.preventDefault();
    }
  });
})();
