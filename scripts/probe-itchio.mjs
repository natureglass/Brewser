// Anonymous itch.io probe — verifies the same contract the page script
// hits (RSS fetch + parse + sample project-page embed extraction). Run
// offline (Node has http/https + DOMParser-free regex, mirrors what the
// runtime supports).
//
// Args: node scripts/probe-itchio.mjs [feed-key] [item-index]
//   feed-key   = 'newest' (default) or 'top'
//   item-index = 0-based index into the parsed feed; default 0
//
// Steps: fetch RSS → parse → list summary → fetch nth item's project
// page → extract data-iframe → log the iframe src (the launch URL the
// page-side detail view will eventually navigate to per-card).

const FEED_KEY = (process.argv[2] || 'newest').toLowerCase();
const ITEM_IDX = parseInt(process.argv[3] || '0', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FEEDS = {
  newest: 'https://itch.io/games/platform-web/newest.xml',
  top: 'https://itch.io/games/platform-web/top-rated.xml',
};

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseRssFeed(xml) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const tagText = (tag) => {
      const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>');
      const mm = block.match(re);
      if (!mm) return '';
      let inner = mm[1];
      const cd = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
      if (cd) inner = cd[1];
      return inner.trim();
    };
    out.push({
      title: decodeEntities(tagText('plainTitle')) || decodeEntities(tagText('title')),
      titleFull: decodeEntities(tagText('title')),
      link: tagText('link'),
      imageurl: tagText('imageurl'),
      price: tagText('price'),
      pubDate: tagText('pubDate'),
    });
  }
  return out;
}

function extractEmbedSrc(projectHtml) {
  // Project page wraps the iframe markup in data-iframe="..." with HTML
  // entities escaped. Decode → pull src=. Some pages lazy-load (no
  // inline data-iframe) — return null in that case so the caller can
  // log it as "needs lazy fetch".
  const m = projectHtml.match(/data-iframe="([^"]+)"/i);
  if (!m) return null;
  const decoded = decodeEntities(m[1]);
  const sm = decoded.match(/src="([^"]+)"/i);
  return sm ? sm[1] : null;
}

(async () => {
  const feedUrl = FEEDS[FEED_KEY];
  if (!feedUrl) {
    console.error('Unknown feed key: ' + FEED_KEY + '. Use one of: ' + Object.keys(FEEDS).join(', '));
    process.exit(1);
  }
  console.log('# feed:', FEED_KEY, '→', feedUrl);

  const fr = await fetch(feedUrl, { headers: { 'User-Agent': UA } });
  console.log('# feed HTTP', fr.status, 'content-type:', fr.headers.get('content-type'));
  if (!fr.ok) {
    console.log((await fr.text()).slice(0, 500));
    process.exit(1);
  }
  const xml = await fr.text();
  console.log('# feed bytes:', xml.length);

  const items = parseRssFeed(xml);
  console.log('# parsed', items.length, 'items');
  console.log('--- summary (first 10) ---');
  for (let i = 0; i < Math.min(10, items.length); i++) {
    const it = items[i];
    console.log(`${i.toString().padStart(2, ' ')}. ${it.title}  [${it.price || '?'}]  ${it.link}`);
  }

  if (items.length === 0) {
    console.log('# no items, exiting');
    return;
  }

  const target = items[ITEM_IDX];
  if (!target) {
    console.error('# item index ' + ITEM_IDX + ' out of range');
    process.exit(1);
  }

  console.log('\n# inspecting item', ITEM_IDX + ':', target.title);
  console.log('#   project page:', target.link);
  const pr = await fetch(target.link, { headers: { 'User-Agent': UA } });
  console.log('#   project HTTP', pr.status);
  if (!pr.ok) {
    console.log((await pr.text()).slice(0, 500));
    process.exit(1);
  }
  const projectHtml = await pr.text();
  console.log('#   project bytes:', projectHtml.length);

  const embedSrc = extractEmbedSrc(projectHtml);
  if (embedSrc) {
    console.log('#   embed src: ' + embedSrc);
  } else {
    console.log('#   no inline data-iframe found — page lazy-loads the embed (deferred slice)');
  }
})();
