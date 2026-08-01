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

  // Earned key set — index by both the stable id and the slug so a synced or
  // pre-sync payload both match the criteria `id`. Lowercased for safety.
  var earnedSet = {};
  var earnedList = (earnedDoc && Array.isArray(earnedDoc.achievements)) ? earnedDoc.achievements : [];
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
    // Title only — no description / criteria / meta. Not-yet-earned badges are
    // dimmed to 50% opacity via the `--locked` class (see achievements.html).
    return '<div class="' + cls + '" title="' + name + '">'
      + '<img class="ach-badge__img" src="' + img + '" alt="' + name + '" width="112" height="112">'
      + '<div class="ach-badge__name">' + name + '</div>'
      + '</div>';
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
      html += '<section class="ach-tier">'
        + '<div class="ach-tier__head">'
        + '<h3 class="ach-tier__name">Tier ' + escapeHtml(tiers[t].tier) + ' — ' + escapeHtml(tiers[t].name || '') + '</h3>'
        + (tiers[t].blurb ? '<p class="ach-tier__blurb">' + escapeHtml(tiers[t].blurb) + '</p>' : '')
        + '<span class="ach-tier__count">' + gEarned + ' / ' + group.length + '</span>'
        + '</div>'
        + '<div class="ach-grid">' + cards + '</div>'
        + '</section>';
    }
  } else if (earnedList.length) {
    // No bundled criteria catalogue — render just the earned set as a flat grid.
    var flat = '';
    for (var k = 0; k < earnedList.length; k++) { flat += badgeHtml(earnedList[k], true); earnedCount++; }
    html = '<div class="ach-grid">' + flat + '</div>';
  } else {
    html = '<p class="ach-empty">No achievements to show yet. Sign in and press Check for Updates on the Apps page to sync your earned badges.</p>';
  }

  root.innerHTML = html;
  if (summary) {
    var total = allAch.length || earnedList.length;
    summary.innerHTML = total ? (earnedCount + ' of ' + total + ' earned') : '';
  }
})();
