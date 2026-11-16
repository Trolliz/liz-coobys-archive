/* Parsers for Facebook "Save page as…" HTML files and Meta's HTML-format export. Runs locally. */
'use strict';
const Parsers = (() => {
  const SKIP = /^(groups|pages|friends|reel|reels|watch|marketplace|gaming|events|notifications|messages|bookmarks|settings|help|policies|privacy|stories|photo|photos|login|hashtag|search|latest|business|ads|me|home\.php|story\.php|permalink\.php|sharer|dialog|l\.php|people|profile\.php)$/i;
  const texts = (el) => { const out = []; const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const t = n.nodeValue.replace(/[\u200b\ufeff]/g, '').trim(); if (t) out.push(t); } return out; };
  const savedFrom = (txt) => { const m = /saved from url=\(\d+\)(\S+)/.exec(txt.slice(0, 3000)); return m ? m[1] : null; };
  const imgOf = (el) => { const i = el.querySelector('image'); if (i) return i.getAttribute('xlink:href') || i.getAttribute('href'); const im = el.querySelector('img[src]'); return im ? im.getAttribute('src') : null; };
  function profileKey(href) {
    if (!href) return null;
    let u; try { u = new URL(href, 'https://www.facebook.com/'); } catch (e) { return null; }
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'profile.php') { const id = u.searchParams.get('id'); return id && /^\d+$/.test(id) ? { key: 'id:' + id, id, username: null, url: 'https://www.facebook.com/profile.php?id=' + id } : null; }
    if (parts[0] === 'people' && parts[2] && /^\d+$/.test(parts[2])) return { key: 'id:' + parts[2], id: parts[2], username: null, url: 'https://www.facebook.com/profile.php?id=' + parts[2] };
    if (parts.length !== 1 || SKIP.test(parts[0])) return null;
    const p = parts[0];
    if (/^\d+$/.test(p)) return { key: 'id:' + p, id: p, username: null, url: 'https://www.facebook.com/' + p };
    if (!/^[A-Za-z0-9.\-_]+$/.test(p)) return null;
    return { key: 'u:' + p.toLowerCase(), id: null, username: p, url: 'https://www.facebook.com/' + p };
  }
  function groupKey(href) {
    const m = /facebook\.com\/groups\/([^/?#]+)\/?(?:[?#].*)?$/.exec(href || '');
    if (!m || /^(feed|discover|joins|create|notifications|search|you)$/i.test(m[1])) return null;
    return { key: 'g:' + m[1].toLowerCase(), id: /^\d+$/.test(m[1]) ? m[1] : null, slug: /^\d+$/.test(m[1]) ? null : m[1], url: 'https://www.facebook.com/groups/' + m[1] + '/' };
  }
  function after(doc, re) { const hs = [...doc.querySelectorAll('h1,h2,h3,[role=heading]')].filter(h => re.test(h.textContent.trim())); return hs[0] || null; }
  const isAfter = (a, ref) => !ref || !!(ref.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
  function cardOf(a, keyFn, key) {
    let el = a;
    for (let d = 0; d < 14 && el.parentElement && el.parentElement.tagName !== 'BODY'; d++) {
      const p = el.parentElement; let other = false;
      for (const x of p.querySelectorAll('a[href]')) { const k = keyFn(x.getAttribute('href')); if (k && k.key !== key) { other = true; break; } }
      if (other) break; el = p;
    }
    return el;
  }

  function friends(doc, raw) {
    const headingEl = after(doc, /^[\d\s.,  ]+(friends|vänner)$/i) || after(doc, /^(All friends|Alla vänner)$/i);
    const total = headingEl && /^([\d\s.,  ]+)/.exec(headingEl.textContent.trim()) ? +headingEl.textContent.replace(/\D/g, '') : null;
    const map = new Map();
    for (const a of doc.querySelectorAll('a[href]')) {
      if (!isAfter(a, headingEl)) continue;
      const k = profileKey(a.getAttribute('href')); if (!k) continue;
      let r = map.get(k.key); if (!r) { r = { ...k, names: [], image: null, detail: [], anchors: 0 }; map.set(k.key, r); }
      r.anchors++;
      const t = texts(a).join(' ').trim(); if (t && !r.names.includes(t)) r.names.push(t);
      const al = a.getAttribute('aria-label'); if (!t && al && !r.names.includes(al) && !/^(more|mer)$/i.test(al)) r.altName = al;
      if (!r.image) r.image = imgOf(a);
      if (!r.card) r.card = cardOf(a, profileKey, k.key);
    }
    const out = [];
    for (const r of map.values()) {
      const card = r.card ? texts(r.card) : [];
      const extra = card.filter(t => !r.names.includes(t));
      if (!r.image && r.card) r.image = imgOf(r.card);
      out.push({ key: r.key, name: r.names[0] || r.altName || null, otherNames: r.names.slice(1), url: r.url, fbId: r.id, username: r.username, image: r.image, detail: extra.join(' · ').slice(0, 200) });
    }
    return { kind: 'friends', savedFrom: savedFrom(raw), statedTotal: total, items: out.filter(x => x.name || x.url) };
  }

  function groups(doc, raw) {
    const map = new Map(); let section = 'other';
    const SECT = [[/^Groups you manage$|^Grupper du hanterar$/i, 'manage'], [/^Groups you've joined$|^Grupper du gått med i$/i, 'joined_recent'], [/^All groups you've joined|^Alla grupper du gått med i/i, 'joined'], [/^Pending group requests|^Väntande gruppförfrågningar/i, 'pending'], [/^Groups you've been invited|^Inbjudningar/i, 'invited']];
    let stated = null;
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) { const t = n.nodeValue.trim(); for (const [re, s] of SECT) if (re.test(t)) { section = s; if (s === 'joined') { const m = /\((\d+)\)/.exec(t); if (m) stated = +m[1]; } } continue; }
      if (n.tagName !== 'A') continue;
      const k = groupKey(n.getAttribute('href')); if (!k) continue;
      let r = map.get(k.key); if (!r) { r = { ...k, names: [], image: null, sections: new Set(), details: new Set() }; map.set(k.key, r); }
      r.sections.add(section);
      const ts = texts(n); if (ts[0] && !/^(View group|Visa grupp)$/i.test(ts[0]) && !r.names.includes(ts[0])) r.names.push(ts[0]);
      if (ts.length > 1) r.details.add(ts.slice(1).join(' '));
      if (!r.image) r.image = imgOf(n);
      if (!r.card) r.card = cardOf(n, groupKey, k.key);
    }
    const out = [];
    for (const r of map.values()) {
      if (r.card) { const ct = texts(r.card).filter(t => !r.names.includes(t) && !/^(View group|Visa grupp)$/i.test(t)); if (ct.length) r.details.add(ct.join(' ')); if (!r.image) r.image = imgOf(r.card); }
      let secs = [...r.sections]; if (secs.includes('joined_recent') && !secs.includes('joined')) secs = secs.map(s => s === 'joined_recent' ? 'joined' : s);
      out.push({ key: r.key, name: r.names[0] || null, otherNames: r.names.slice(1), url: r.url, groupId: r.id, slug: r.slug, image: r.image, sections: [...new Set(secs.filter(s => s !== 'joined_recent'))], detail: [...r.details].join(' · ').slice(0, 200) });
    }
    return { kind: 'groups', savedFrom: savedFrom(raw), statedTotal: stated, items: out };
  }

  function pages(doc, raw) {
    const headingEl = after(doc, /^(All Pages you follow|All Pages you like|Liked Pages|Alla sidor)/i);
    const stated = headingEl && /\((\d+)\)/.exec(headingEl.textContent) ? +/\((\d+)\)/.exec(headingEl.textContent)[1] : null;
    const map = new Map();
    for (const a of doc.querySelectorAll('a[href]')) {
      if (!isAfter(a, headingEl)) continue;
      const k = profileKey(a.getAttribute('href')); if (!k) continue;
      let r = map.get(k.key); if (!r) { r = { ...k, names: [], image: null }; map.set(k.key, r); }
      const t = texts(a).join(' ').trim(); if (t && !r.names.includes(t)) r.names.push(t);
      const al = a.getAttribute('aria-label'); if (al && !r.names.includes(al)) r.alt = al;
      if (!r.image) r.image = imgOf(a);
      if (!r.card) r.card = cardOf(a, profileKey, k.key);
    }
    const out = [];
    for (const r of map.values()) {
      const name = r.names[0] || r.alt || null;
      const ct = r.card ? texts(r.card).filter(t => t !== name && !/^(Following|Följer|Liked|Gillat)$/i.test(t)) : [];
      out.push({ key: r.key, name, url: r.url, fbId: r.id, username: r.username, image: r.image || (r.card && imgOf(r.card)), pageCategory: ct.join(' · ').slice(0, 120) });
    }
    return { kind: 'pages', savedFrom: savedFrom(raw), statedTotal: stated, items: out.filter(x => x.name) };
  }

  function detect(raw, fileName) {
    const sf = (savedFrom(raw) || '').toLowerCase();
    if (/facebook\.com\/(friends|.*sk=friends|.*\/friends)/.test(sf)) return 'friends';
    if (/facebook\.com\/groups/.test(sf)) return 'groups';
    if (/facebook\.com\/(pages|.*sk=likes|.*\/likes)/.test(sf)) return 'pages';
    const n = (fileName || '').toLowerCase();
    if (/friend|vänner/.test(n)) return 'friends'; if (/group|grupp/.test(n)) return 'groups'; if (/page|sidor/.test(n)) return 'pages';
    return null;
  }
  function parseSaved(raw, fileName) {
    const kind = detect(raw, fileName); if (!kind) return { kind: null };
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    return ({ friends, groups, pages })[kind](doc, raw);
  }

  /* ---------- Meta HTML-format export ---------- */
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, maj: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11 };
  function parseDate(s) {
    if (!s) return null; const t = s.trim();
    let d = Date.parse(t.replace(/\b(am|pm)\b/i, x => x.toUpperCase()).replace(/ at /, ' '));
    if (!isNaN(d)) return d;
    const m = /(\d{1,2})\s+([a-zåäö]{3})[a-zåäö.]*\s+(\d{4})(?:[, ]+(?:kl\.?\s*)?(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?/i.exec(t);
    if (m && MON[m[2].toLowerCase()] != null) return new Date(+m[3], MON[m[2].toLowerCase()], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    const iso = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +(iso[6] || 0)).getTime();
    return null;
  }
  function blocks(doc) {
    let bs = [...doc.querySelectorAll('div._a6-g')];
    if (!bs.length) bs = [...doc.querySelectorAll('div.pam.uiBoxWhite, div.uiBoxWhite')];
    return bs.map(b => {
      const kids = [...b.children]; if (kids.length < 2) return null;
      const head = kids[0], foot = kids[kids.length - 1], body = kids.slice(1, -1);
      const media = [], links = [], reactions = []; let text = [];
      for (const el of body) {
        for (const x of el.querySelectorAll('img[src],video[src],audio[src],source[src],a[href]')) {
          const u = x.getAttribute('src') || x.getAttribute('href');
          if (!u) continue; if (/^https?:/i.test(u)) { if (x.tagName === 'A') links.push(u); } else if (!media.includes(u)) media.push(u);
        }
        for (const li of el.querySelectorAll('ul li')) reactions.push(li.textContent.trim());
        const c = el.cloneNode(true); c.querySelectorAll('ul').forEach(u => u.remove());
        const tx = texts(c).join('\n'); if (tx) text.push(tx);
      }
      return { header: head.textContent.trim(), footer: foot.textContent.trim(), text: text.join('\n'), media, links, reactions };
    }).filter(Boolean);
  }
  function parseMessageHtml(raw) {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const title = (doc.querySelector('._a70e, h1') || doc.querySelector('title') || {}).textContent || null;
    let participants = [];
    for (const t of texts(doc.body).slice(0, 40)) { const m = /^(?:Participants|Deltagare):\s*(.+)$/i.exec(t); if (m) participants = m[1].split(/,\s*|\s+and\s+|\s+och\s+/).filter(Boolean); }
    const messages = blocks(doc).map(b => ({ sender: b.header, dateText: b.footer, ts: parseDate(b.footer), text: b.text || null, media: b.media, link: b.links[0] || null, reactions: b.reactions, rawText: (b.header + ' | ' + b.text + ' | ' + b.footer).slice(0, 4000) }));
    return { title: title && title.trim(), participants, messages };
  }
  function parseHtmlList(raw) {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    return blocks(doc).map(b => ({ name: b.header || b.text.split('\n')[0], detail: b.text, ts: parseDate(b.footer), url: b.links[0] || null }));
  }
  return { parseSaved, parseMessageHtml, parseHtmlList, profileKey, groupKey, parseDate };
})();
