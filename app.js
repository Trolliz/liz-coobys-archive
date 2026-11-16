/* Liz Coobys Archive – UI. Private, local-only. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtN = (n) => (n ?? 0).toLocaleString();
const fmtBytes = (b) => b == null ? '?' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const fmtDate = (ts) => ts == null ? '' : new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtTime = (ts) => ts == null ? '' : new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDT = (ts) => ts == null ? '' : new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortWhen = (ts) => { if (ts == null) return ''; const d = new Date(ts), n = new Date(); return d.toDateString() === n.toDateString() ? fmtTime(ts) : d.getFullYear() === n.getFullYear() ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' }); };
const initials = (n) => (n || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const normName = (n) => (n || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
const CAT_LABEL = { inbox: 'Inbox', archived_threads: 'Archived', filtered_threads: 'Filtered / spam', message_requests: 'Message requests', e2ee_cutover: 'Encrypted (E2EE)', e2ee_export: 'Encrypted chat export', community_chats: 'Community chats' };
const catLabel = (c) => CAT_LABEL[c] || (c || '').replace(/_/g, ' ');
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }

/* ---------- state ---------- */
const S = { owner: null, threads: null, report: null, searchIdx: null, urls: [], busy: false };
async function loadState(force) {
  if (!S.threads || force) {
    S.threads = (await LCA.getAll('threads')).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    S.owner = await LCA.getMeta('owner', null);
    S.report = await LCA.getMeta('report', null);
    S.threadMap = new Map(S.threads.map(t => [t.id, t]));
    if (force) S.searchIdx = null;
  }
}
const isMe = (name) => !!S.owner && name === S.owner;
function track(url) { S.urls.push(url); return url; }
function revokeAll() { for (const u of S.urls) URL.revokeObjectURL(u); S.urls = []; }

/* ---------- media loading ---------- */
const io = 'IntersectionObserver' in window ? new IntersectionObserver((ents) => {
  for (const e of ents) if (e.isIntersecting) { io.unobserve(e.target); loadMediaEl(e.target); }
}, { rootMargin: '600px 0px' }) : null;
function lazy(el) { if (io) io.observe(el); else loadMediaEl(el); return el; }
async function loadMediaEl(el) {
  const id = el.dataset.media; if (!id) return;
  try {
    const b = await LCA.getFile(id);
    if (!b) { el.replaceWith(h('span', { class: 'filechip missing' }, '⚠️ File could not be loaded')); return; }
    el.src = track(URL.createObjectURL(b));
  } catch (e) { console.warn(e); }
}
async function downloadMedia(id) {
  const m = await LCA.get('media', id); const b = await LCA.getFile(id); if (!m || !b) return toast('File not available');
  saveBlob(b, m.name);
}
function saveBlob(blob, name) {
  const u = URL.createObjectURL(blob); const a = h('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
async function shareMedia(id) {
  const m = await LCA.get('media', id); const b = await LCA.getFile(id); if (!m || !b) return toast('File not available');
  const f = new File([b], m.name, { type: m.mime });
  if (navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f] }); } catch (e) { } } else saveBlob(b, m.name);
}

/* ---------- avatars (saved page pictures, cached on this device) ---------- */
const avCache = new Map();
function avatar(name, url, sq) {
  const el = h('div', { class: 'av' + (sq ? ' sq' : '') }, initials(name));
  if (url) (async () => {
    let u = avCache.get(url);
    if (!u) { const r = await LCA.get('avatars', url).catch(() => null); if (r && r.blob) { u = URL.createObjectURL(r.blob); avCache.set(url, u); } }
    const img = h('img', { alt: '', referrerpolicy: 'no-referrer', decoding: 'async' });
    img.onerror = () => img.remove();
    img.onload = () => { el.textContent = ''; el.append(img); };
    img.src = u || url;
  })();
  return el;
}
async function cacheAvatars(urls, label) {
  const todo = [...new Set(urls.filter(Boolean))]; let ok = 0, fail = 0, i = 0;
  const have = new Set((await LCA.getAll('avatars')).filter(a => a.blob).map(a => a.url));
  const list = todo.filter(u => !have.has(u)); ok = todo.length - list.length;
  async function one() {
    while (i < list.length) {
      const u = list[i++];
      try { const r = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }); if (!r.ok) throw 0; const b = await r.blob(); await LCA.put('avatars', { url: u, blob: b, savedAt: Date.now() }); ok++; }
      catch (e) { fail++; }
      if ((ok + fail) % 20 === 0) setProgress(`Saving ${label} pictures for offline use`, ok + fail, todo.length);
    }
  }
  await Promise.all([one(), one(), one(), one(), one(), one()]);
  return { ok, fail, total: todo.length };
}

/* ---------- worker ---------- */
let worker = null, workerDone = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js');
  worker.onmessage = async (e) => {
    const d = e.data;
    if (d.type === 'progress') setProgress(d.phase, d.done, d.total, d.note);
    else if (d.type === 'parseMessageHtml') worker.postMessage({ type: 'reply', id: d.id, result: safe(() => Parsers.parseMessageHtml(d.text)) });
    else if (d.type === 'parseHtmlList') worker.postMessage({ type: 'reply', id: d.id, result: safe(() => Parsers.parseHtmlList(d.text)) });
    else if (d.type === 'isBackup') { workerDone && workerDone.resolve({ backup: true }); }
    else if (d.type === 'done' || d.type === 'backupReady') { workerDone && workerDone.resolve(d.type === 'done' ? (d.result || {}) : d); }
    else if (d.type === 'error') { workerDone && workerDone.reject(new Error(d.message)); }
  };
  worker.onerror = (e) => { workerDone && workerDone.reject(new Error(e.message || 'Worker failed')); };
  return worker;
}
function safe(f) { try { return f(); } catch (e) { console.error(e); return null; } }
function runWorker(msg) { return new Promise((resolve, reject) => { workerDone = { resolve, reject }; getWorker().postMessage(msg); }); }

/* ---------- progress UI ---------- */
function setProgress(phase, done, total, note) {
  const p = $('#prog'); if (!p) return;
  p.hidden = false;
  $('#progPhase').textContent = phase + (total > 1 ? ` (${fmtN(done)} of ${fmtN(total)})` : '');
  $('#progBar').max = total || 1; $('#progBar').value = done || 0;
  $('#progNote').textContent = note || '';
}

/* ---------- storage ---------- */
async function storageInfo() {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  return { usage: est?.usage, quota: est?.quota, persisted };
}
async function askPersist() { if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(() => false); return false; }
async function checkSpace(bytes) {
  const s = await storageInfo(); if (!s.quota) return true;
  const free = s.quota - (s.usage || 0), need = bytes * 1.25;
  if (free < need) return confirm(`Storage warning: this import needs about ${fmtBytes(need)}, but only ${fmtBytes(free)} seems to be free for this app on this device.\n\nThe import may stop part-way. Free up space on the device first, or continue anyway?`);
  return true;
}

/* ---------- import ---------- */
async function importFiles(fileList) {
  if (S.busy) return toast('An import is already running');
  const files = [...fileList]; if (!files.length) return;
  S.busy = true; $('#statusBtn')?.classList.add('attn');
  const prog = $('#prog'); if (prog) prog.hidden = false;
  const log = [];
  try {
    await askPersist();
    const isAsset = (f) => /_files\//.test(f.webkitRelativePath || '');
    const zips = files.filter(f => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed');
    const htmls = files.filter(f => /\.html?$/i.test(f.name) && !zips.includes(f) && !isAsset(f));
    const others = files.filter(f => !zips.includes(f) && !htmls.includes(f));
    if (!(await checkSpace(zips.reduce((a, f) => a + f.size, 0)))) throw new Error('Import cancelled');
    if (zips.length) {
      setProgress('Reading ZIP', 0, 1);
      const r = await runWorker({ type: 'importZips', files: zips });
      if (r && r.backup) {
        if (confirm('This file is a Liz Coobys Archive backup. Restore it? This replaces everything currently stored in the app.')) {
          await runWorker({ type: 'restore', file: zips[0] }); log.push('Backup restored.');
        }
      } else log.push(`Facebook export imported: ${zips.map(z => z.name).join(', ')}`);
    }
    for (const f of htmls) {
      setProgress('Reading ' + f.name, 0, 1);
      const txt = await f.text();
      const res = Parsers.parseSaved(txt, f.name);
      if (!res.kind) { await noteIgnored([{ path: f.name, size: f.size, reason: 'HTML file not recognised as a saved friends / groups / pages page' }]); log.push(`${f.name}: not recognised`); continue; }
      const n = await storeSaved(res, f.name);
      log.push(`${f.name}: ${n} ${res.kind} read`);
      setProgress('Saving pictures', 0, 1);
      const av = await cacheAvatars(res.items.map(i => i.image), res.kind);
      const rep = await LCA.getMeta('report', null) || {}; rep.saved = rep.saved || {}; rep.saved[res.kind].avatars = av; await LCA.setMeta('report', rep);
      log.push(`${av.ok} of ${av.total} pictures saved offline` + (av.fail ? ` (${av.fail} could not be downloaded – these show initials)` : ''));
    }
    if (others.length) {
      await noteIgnored(others.map(f => ({ path: f.webkitRelativePath || f.name, size: f.size, reason: isAsset(f) || /\.(js|css|download)$/i.test(f.name) ? 'saved-web-page asset (scripts/styles – no archive data)' : 'unsupported file type' })));
      log.push(`${others.length} other file(s) listed in the report (no archive data in them)`);
    }
    await loadState(true);
    setProgress('Done', 1, 1, log.join(' · '));
    toast('Import finished');
  } catch (e) {
    console.error(e); setProgress('Import stopped', 0, 1, e.message);
    alert('Import problem: ' + e.message + (/quota|space|full/i.test(e.message) ? '\n\nThe device seems to be out of storage space.' : ''));
  } finally {
    S.busy = false; $('#statusBtn')?.classList.remove('attn'); await loadState(true);
    if (location.hash.startsWith('#/import')) { const note = $('#progNote')?.textContent; await render(); setProgress('Done', 1, 1, note); }
  }
}
async function noteIgnored(list) {
  const rep = await LCA.getMeta('report', null) || {}; rep.ignoredUploads = (rep.ignoredUploads || []).concat(list).slice(-5000);
  await LCA.setMeta('report', rep);
}
async function storeSaved(res, fileName) {
  const store = res.kind;
  const old = (await LCA.getAll(store)).filter(r => r.source === 'page');
  for (const o of old) await LCA.del(store, o.id);
  const recs = res.items.map((x, i) => Object.assign({}, x, { id: 'page:' + x.key, source: 'page', file: fileName, order: i }));
  await LCA.putMany(store, recs);
  const rep = await LCA.getMeta('report', null) || {};
  rep.saved = rep.saved || {}; rep.saved[store] = { file: fileName, savedFrom: res.savedFrom, statedTotal: res.statedTotal, items: recs.length, importedAt: Date.now() };
  await LCA.setMeta('report', rep);
  return recs.length;
}

/* ---------- router ---------- */
window.addEventListener('hashchange', render);
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#q').value.trim(); if (q) location.hash = '#/search/' + encodeURIComponent(q); $('#q').blur(); });
async function render() {
  revokeAll();
  const parts = (location.hash || '#/messenger').slice(2).split('/');
  const tab = parts[0] || 'messenger';
  document.body.classList.toggle('chat', tab === 'thread');
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.tab === tab || (tab === 'thread' && a.dataset.tab === 'messenger'));
  await loadState();
  view.innerHTML = '';
  try {
    if (tab === 'thread') await renderThread(decodeURIComponent(parts[1] || ''), parts[2] != null && parts[2] !== '' ? +parts[2] : null);
    else if (tab === 'media') await renderMedia();
    else if (tab === 'friends') await renderFriends();
    else if (tab === 'groups') await renderGroups();
    else if (tab === 'pages') await renderPages();
    else if (tab === 'import') await renderImport();
    else if (tab === 'search') await renderSearch(decodeURIComponent(parts.slice(1).join('/')));
    else await renderMessenger();
  } catch (e) { console.error(e); view.append(h('div', { class: 'note' }, 'Something went wrong: ' + e.message)); }
  if (tab !== 'thread') window.scrollTo(0, 0);
}
function emptyState(what) {
  return h('div', { class: 'card empty' }, h('div', { style: 'font-size:42px' }, '🐾'), h('p', null, `No ${what} imported yet.`),
    h('a', { class: 'btn primary', href: '#/import' }, 'Import my Facebook files'));
}
function chips(options, current, onPick) {
  return h('div', { class: 'chips' }, options.map(([v, label]) => h('button', { class: 'chip' + (v === current ? ' on' : ''), onclick: () => onPick(v) }, label)));
}
const inputStyle = 'width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);margin-bottom:8px';

/* ---------- Messenger list ---------- */
let msgrFilter = { cat: 'all', q: '' };
async function renderMessenger() {
  const ths = S.threads;
  if (!ths.length) { view.append(h('h2', null, 'Messenger'), emptyState('conversations')); return; }
  const cats = [...new Set(ths.map(t => t.category))];
  const listEl = h('ul', { class: 'list card', style: 'padding:0 8px' });
  const filt = h('input', { type: 'search', placeholder: 'Filter conversations by name…', value: msgrFilter.q, style: inputStyle });
  const count = h('span', { class: 'mut small' });
  let shown = 150;
  const draw = () => {
    const q = normName(msgrFilter.q);
    const list = ths.filter(t => (msgrFilter.cat === 'all' || t.category === msgrFilter.cat) && (!q || normName(t.title + ' ' + t.participants.join(' ')).includes(q)));
    listEl.innerHTML = '';
    for (const t of list.slice(0, shown)) {
      const others = t.participants.filter(p => !isMe(p));
      listEl.append(h('li', null, h('a', { class: 'item', href: '#/thread/' + encodeURIComponent(t.id) },
        avatar(t.title, null),
        h('div', { class: 'grow' }, h('div', { class: 't1' }, t.title || '(no name)'),
          h('div', { class: 't2' }, (t.lastSender ? (isMe(t.lastSender) ? 'You: ' : (others.length > 1 ? t.lastSender.split(' ')[0] + ': ' : '')) : '') + (t.lastText || '')),
          h('div', null, t.category !== 'inbox' ? h('span', { class: 'badge p' }, catLabel(t.category)) : null, t.missingMedia ? h('span', { class: 'badge warn' }, `${t.missingMedia} media missing`) : null, t.msgCount === 0 ? h('span', { class: 'badge warn' }, 'empty') : null)),
        h('div', { class: 'when' }, shortWhen(t.lastTs)))));
    }
    if (list.length > shown) listEl.append(h('li', null, h('button', { class: 'btn more', onclick: () => { shown += 300; draw(); } }, `Show more (${fmtN(list.length - shown)} left)`)));
    if (!list.length) listEl.append(h('li', { class: 'empty' }, 'No conversations match.'));
    count.textContent = `${fmtN(list.length)} conversation${list.length === 1 ? '' : 's'}`;
  };
  filt.addEventListener('input', () => { msgrFilter.q = filt.value; shown = 150; draw(); });
  const chipBox = h('div');
  const drawChips = () => { chipBox.innerHTML = ''; chipBox.append(chips([['all', 'All'], ...cats.map(c => [c, catLabel(c)])], msgrFilter.cat, (v) => { msgrFilter.cat = v; drawChips(); draw(); })); };
  drawChips();
  view.append(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', null, 'Messenger'), count), filt, chipBox, listEl,
    h('div', { class: 'note' }, 'ℹ️ This shows exactly what is in Meta’s export. End-to-end encrypted chats are often exported separately by Meta (Messenger → Settings → End-to-end encrypted chats → Message storage → Download secure storage data), and very old or deleted conversations may be missing. Nothing here is added or reconstructed.'));
  draw();
}

/* ---------- conversation ---------- */
async function renderThread(id, focusOrd) {
  const t = S.threadMap.get(id);
  if (!t) { view.append(h('div', { class: 'note' }, 'Conversation not found.'), h('a', { href: '#/messenger', class: 'btn' }, '← Back')); return; }
  const group = t.participants.length > 2 || (t.senders || []).length > 2;
  const head = h('div', { class: 'chathead' }, h('a', { class: 'back', href: '#/messenger', 'aria-label': 'Back' }, '‹'), avatar(t.title),
    h('div', { class: 'grow' }, h('div', { class: 't1' }, t.title), h('div', { class: 't2' }, `${fmtN(t.msgCount)} messages · ${catLabel(t.category)}${t.firstTs ? ' · ' + fmtDate(t.firstTs) + ' – ' + fmtDate(t.lastTs) : ''}`)),
    h('button', { class: 'iconbtn', title: 'Search in conversation', 'aria-label': 'Search in conversation', onclick: () => inSearch() }, '🔎'),
    h('button', { class: 'iconbtn', title: 'Export conversation', 'aria-label': 'Export conversation', onclick: () => exportMenu(t) }, '⤓'));
  const box = h('div', { class: 'msgs' });
  const info = h('div', { class: 'card small mut' },
    h('div', null, 'Participants: ', t.participants.join(', ') || '—'),
    t.isStillParticipant === false ? h('div', null, 'You had left this conversation.') : null,
    t.missingMedia ? h('div', { style: 'color:var(--warn)' }, `⚠️ ${t.missingMedia} attachment(s) are referenced in the messages but were not included in the export.`) : null,
    t.fixedStrings ? h('div', null, `Repaired Facebook’s character encoding in ${fmtN(t.fixedStrings)} text field(s) (å ä ö, emoji). The original export text is kept unchanged in the archive.`) : null,
    (t.warnings || []).map(w => h('div', { style: 'color:var(--warn)' }, '⚠️ ' + w)),
    t.format === 'html' ? h('div', null, 'Imported from Meta’s HTML export format; dates shown as written by Meta.') : null);
  view.append(head, info, box);
  const PAGE = 250;
  let lo, hi;
  const load = (a, b) => LCA.getAllByIndex('messages', 'thread', IDBKeyRange.bound([id, a], [id, b]));
  function renderBatch(msgs) {
    const frag = document.createDocumentFragment(); let ps = null, pd = null, pt = null;
    for (const m of msgs) {
      const day = m.ts != null ? new Date(m.ts).toDateString() : (m.dateText || '').slice(0, 12);
      if (day !== pd) { frag.append(h('div', { class: 'day' }, m.ts != null ? new Date(m.ts).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' }) : (m.dateText || 'Date unknown'))); ps = null; }
      const me = isMe(m.sender);
      const newGroup = m.sender !== ps || (m.ts && pt && m.ts - pt > 600000);
      frag.append(renderMsg(m, me, group, newGroup && !me));
      ps = m.sender; pd = day; pt = m.ts;
    }
    return frag;
  }
  const topBar = h('div', { class: 'loadmore' }), botBar = h('div', { class: 'loadmore' });
  box.append(topBar);
  let loading = false;
  async function loadEarlier() {
    if (lo <= 0 || loading) return; loading = true; const a = Math.max(0, lo - PAGE); const msgs = await load(a, lo - 1); lo = a;
    const before = document.documentElement.scrollHeight; topBar.after(renderBatch(msgs)); window.scrollTo(0, window.scrollY + document.documentElement.scrollHeight - before); drawTop(); loading = false;
  }
  async function loadLater() {
    if (hi >= t.msgCount - 1) return; const b = Math.min(t.msgCount - 1, hi + PAGE); const msgs = await load(hi + 1, b); hi = b; botBar.before(renderBatch(msgs)); drawBot();
  }
  const drawTop = () => { topBar.innerHTML = ''; if (lo > 0) topBar.append(h('button', { class: 'btn', onclick: loadEarlier }, `Load earlier messages (${fmtN(lo)} more)`)); else topBar.append(h('div', { class: 'mut small' }, 'Beginning of the exported conversation' + (t.firstTs ? ' · ' + fmtDT(t.firstTs) : ''))); };
  const drawBot = () => { botBar.innerHTML = ''; if (hi < t.msgCount - 1) botBar.append(h('button', { class: 'btn', onclick: loadLater }, `Load later messages (${fmtN(t.msgCount - 1 - hi)} more)`)); };
  if (focusOrd != null && !isNaN(focusOrd)) { lo = Math.max(0, focusOrd - 100); hi = Math.min(t.msgCount - 1, focusOrd + 150); }
  else { hi = t.msgCount - 1; lo = Math.max(0, t.msgCount - PAGE); }
  const msgs = t.msgCount ? await load(lo, hi) : [];
  box.append(renderBatch(msgs), botBar); drawTop(); drawBot();
  if (!t.msgCount) box.append(h('div', { class: 'empty' }, 'This conversation has no messages in the export.'));
  if (io) { const o = new IntersectionObserver((e) => { if (!document.body.contains(topBar)) return o.disconnect(); if (e[0].isIntersecting && lo > 0) loadEarlier(); }, { rootMargin: '200px' }); setTimeout(() => o.observe(topBar), 900); }
  requestAnimationFrame(() => {
    if (focusOrd != null) { const el = box.querySelector(`[data-ord="${focusOrd}"]`); if (el) { el.classList.add('hit'); el.scrollIntoView({ block: 'center' }); } }
    else window.scrollTo(0, document.documentElement.scrollHeight);
  });
  async function inSearch() {
    const q = prompt('Search in this conversation:'); if (!q) return;
    location.hash = '#/search/' + encodeURIComponent(q) + '?t=' + encodeURIComponent(id);
  }
}
function renderMsg(m, me, showName, newGroup) {
  const wrap = h('div', { class: 'm' + (me ? ' me' : ''), 'data-ord': m.ord });
  if (showName && newGroup && m.sender) wrap.append(h('div', { class: 'who' }, m.sender));
  const hasText = m.text != null && m.text !== '';
  if (m.unsent) wrap.append(h('div', { class: 'b unsent' }, hasText ? m.text : 'Message unsent'));
  else if (hasText || m.share) {
    const b = h('div', { class: 'b' }); if (hasText) b.append(linkify(m.text));
    if (m.share && m.share.link && !(m.text || '').includes(m.share.link)) b.append(h('a', { class: 'share', href: m.share.link, target: '_blank', rel: 'noopener noreferrer' }, '🔗 ' + (m.share.text || m.share.link)));
    else if (m.share && m.share.text && !hasText) b.append(m.share.text);
    if (m.call != null) b.append(h('div', { class: 'small' }, `📞 ${Math.floor(m.call / 60)} min ${m.call % 60} s`));
    wrap.append(b);
  } else if (m.call != null) wrap.append(h('div', { class: 'b sys' }, `📞 Call · ${Math.floor(m.call / 60)} min ${m.call % 60} s`));
  if (m.att && m.att.length) { const g = h('div', { class: 'attgrid' }); for (const a of m.att) g.append(renderAtt(a, m)); wrap.append(g); }
  if (!hasText && !m.share && !(m.att && m.att.length) && m.call == null && !m.unsent) wrap.append(h('div', { class: 'b sys' }, m.type && !/^(Generic|html)$/.test(m.type) ? `(${m.type} – no text in export)` : '(no text in export)'));
  if (m.reactions && m.reactions.length) wrap.append(h('div', { class: 'react', title: m.reactions.map(r => `${r.r} ${r.actor}`).join('\n') }, m.reactions.map(r => r.r).join('') + (m.reactions.length > 1 ? ' ' + m.reactions.length : '')));
  wrap.append(h('div', { class: 'ts', title: m.ts ? new Date(m.ts).toString() : '' }, m.ts != null ? fmtTime(m.ts) : (m.dateText || '')));
  return wrap;
}
function linkify(text) {
  const frag = document.createDocumentFragment(); const re = /https?:\/\/[^\s<>"]+/g; let last = 0, mm;
  while ((mm = re.exec(text))) { frag.append(text.slice(last, mm.index)); frag.append(h('a', { href: mm[0], target: '_blank', rel: 'noopener noreferrer' }, mm[0])); last = mm.index + mm[0].length; }
  frag.append(text.slice(last)); return frag;
}
const KIND_LABEL = { photo: 'Photo', gif: 'GIF', sticker: 'Sticker', video: 'Video', audio: 'Audio', file: 'File' };
function renderAtt(a, m) {
  const id = a.mediaId;
  if (a.remote) return h('a', { class: 'filechip', href: a.uri, target: '_blank', rel: 'noopener noreferrer' }, '🔗 ' + (KIND_LABEL[a.kind] || 'Link') + ' (online link, not stored)');
  if (a.missing || a.unreadable || !id) return h('span', { class: 'filechip missing', title: a.uri || '' }, `⚠️ ${KIND_LABEL[a.kind] || 'File'} ${a.unreadable ? 'could not be read' : 'not included in export'}: ${a.name || ''}`);
  const dl = h('button', { class: 'dl', onclick: () => downloadMedia(id) }, '⤓ Save');
  if (a.kind === 'photo' || a.kind === 'gif' || a.kind === 'sticker') {
    const img = lazy(h('img', { class: 'att-img' + (a.kind === 'sticker' ? ' sticker' : ''), alt: a.name || '', 'data-media': id, decoding: 'async' }));
    img.addEventListener('click', () => openViewerForThread(m.threadId, id));
    return h('div', null, img, a.kind === 'sticker' ? null : dl);
  }
  if (a.kind === 'video') return h('div', null, lazy(h('video', { class: 'att-vid', controls: true, preload: 'metadata', playsinline: true, 'data-media': id })), dl);
  if (a.kind === 'audio') return h('div', null, lazy(h('audio', { controls: true, preload: 'none', 'data-media': id })), dl);
  return h('button', { class: 'filechip', onclick: () => downloadMedia(id) }, '📎 ' + (a.name || 'File'), h('span', { class: 'mut small' }, ' ⤓'));
}

/* ---------- full-screen viewer ---------- */
let V = { list: [], i: 0, url: null };
async function openViewerForThread(threadId, mediaId) {
  const all = (await LCA.getAllByIndex('media', 'thread', IDBKeyRange.only(threadId))).filter(x => /photo|gif|sticker|video/.test(x.kind)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const list = all.map(x => ({ id: x.id, kind: x.kind, name: x.name, ts: x.ts, msgId: x.msgId, threadId: x.threadId }));
  openViewer(list, Math.max(0, list.findIndex(x => x.id === mediaId)));
}
function openViewer(list, i) { V = { list, i, url: null }; $('#viewer').hidden = false; document.body.style.overflow = 'hidden'; drawViewer(); }
function closeViewer() { const v = $('#viewer'); v.hidden = true; v.innerHTML = ''; document.body.style.overflow = ''; if (V.url) URL.revokeObjectURL(V.url); V.url = null; }
async function drawViewer() {
  const v = $('#viewer'); const it = V.list[V.i]; if (!it) return closeViewer();
  const b = await LCA.getFile(it.id); if (V.url) URL.revokeObjectURL(V.url); V.url = b ? URL.createObjectURL(b) : null;
  const t = S.threadMap.get(it.threadId);
  const ord = it.msgId ? +(it.msgId.split('#').pop()) : null;
  v.innerHTML = '';
  const stage = h('div', { class: 'stage' }, it.kind === 'video' ? h('video', { src: V.url, controls: true, autoplay: true, playsinline: true }) : h('img', { src: V.url, alt: it.name }),
    V.i > 0 ? h('button', { class: 'nav l', 'aria-label': 'Previous', onclick: () => { V.i--; drawViewer(); } }, '‹') : null,
    V.i < V.list.length - 1 ? h('button', { class: 'nav r', 'aria-label': 'Next', onclick: () => { V.i++; drawViewer(); } }, '›') : null);
  let sx = null; stage.addEventListener('touchstart', e => sx = e.touches[0].clientX, { passive: true });
  stage.addEventListener('touchend', e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) < 50) return; if (dx < 0 && V.i < V.list.length - 1) V.i++; else if (dx > 0 && V.i > 0) V.i--; else return; drawViewer(); });
  v.append(h('div', { class: 'vbar' }, h('button', { onclick: closeViewer, 'aria-label': 'Close' }, '✕'),
    h('div', { class: 'grow' }, `${V.i + 1} / ${V.list.length} · ${t ? t.title + ' · ' : ''}${it.ts ? fmtDT(it.ts) : ''}`),
    t && ord != null ? h('button', { title: 'Show in conversation', onclick: () => { closeViewer(); location.hash = '#/thread/' + encodeURIComponent(t.id) + '/' + ord; } }, '💬') : null,
    h('button', { onclick: () => shareMedia(it.id), title: 'Save / share' }, '⤓ Save')), stage);
}
document.addEventListener('keydown', (e) => { if ($('#viewer').hidden) return; if (e.key === 'Escape') closeViewer(); if (e.key === 'ArrowLeft' && V.i > 0) { V.i--; drawViewer(); } if (e.key === 'ArrowRight' && V.i < V.list.length - 1) { V.i++; drawViewer(); } });

/* ---------- conversation export ---------- */
function exportMenu(t) {
  const d = h('div', { class: 'card', style: 'position:fixed;left:10px;right:10px;bottom:calc(20px + var(--safe-b));z-index:40;box-shadow:0 10px 40px rgba(0,0,0,.25);max-width:600px;margin:0 auto' },
    h('h3', { style: 'margin-top:0' }, 'Export “' + t.title + '”'),
    h('button', { class: 'btn big primary', onclick: () => { d.remove(); exportConversation(t, 'zip'); } }, '📦 Web page with photos & videos (.zip)'),
    h('button', { class: 'btn big', onclick: () => { d.remove(); exportConversation(t, 'html'); } }, '📄 Web page, text only (.html)'),
    h('button', { class: 'btn big', onclick: () => { d.remove(); exportConversation(t, 'txt'); } }, '📝 Plain text (.txt)'),
    h('button', { class: 'btn big', onclick: () => d.remove() }, 'Cancel'));
  document.body.append(d);
}
async function exportConversation(t, mode) {
  toast('Preparing export…', 8000);
  const msgs = await LCA.getAllByIndex('messages', 'thread', IDBKeyRange.bound([t.id, -Infinity], [t.id, Infinity]));
  const safeName = (t.title || 'conversation').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  const when = (m) => m.ts != null ? new Date(m.ts).toLocaleString() : (m.dateText || '?');
  if (mode === 'txt') {
    const lines = [t.title, `Participants: ${t.participants.join(', ')}`, `Exported from Liz Coobys Archive ${new Date().toLocaleString()} – ${msgs.length} messages`, ''];
    for (const m of msgs) {
      const att = (m.att || []).map(a => `[${KIND_LABEL[a.kind] || 'File'}: ${a.name || a.uri}${a.missing ? ' – not in export' : ''}]`).join(' ');
      lines.push(`[${when(m)}] ${m.sender || '?'}: ${m.unsent ? '(unsent) ' : ''}${m.text || ''}${m.share && m.share.link ? ' ' + m.share.link : ''}${att ? ' ' + att : ''}${m.reactions?.length ? '  (' + m.reactions.map(r => r.r + ' ' + r.actor).join(', ') + ')' : ''}`);
    }
    return saveBlob(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/plain;charset=utf-8' }), safeName + '.txt');
  }
  const files = [];
  const rows = msgs.map(m => {
    const att = (m.att || []).map(a => {
      if (a.missing || !a.mediaId) return `<div class="miss">⚠️ ${esc(KIND_LABEL[a.kind] || 'File')} not included in export: ${esc(a.name || a.uri)}</div>`;
      const fn = 'media/' + a.mediaId.split('/').slice(-3).join('_');
      if (mode !== 'zip') return `<div class="miss">[${esc(KIND_LABEL[a.kind])}: ${esc(a.name)}]</div>`;
      files.push([fn, a.mediaId]);
      if (/photo|gif|sticker/.test(a.kind)) return `<a href="${esc(fn)}"><img src="${esc(fn)}" loading="lazy" alt=""></a>`;
      if (a.kind === 'video') return `<video src="${esc(fn)}" controls preload="metadata"></video>`;
      if (a.kind === 'audio') return `<audio src="${esc(fn)}" controls></audio>`;
      return `<a href="${esc(fn)}">📎 ${esc(a.name)}</a>`;
    }).join('');
    return `<div class="m ${isMe(m.sender) ? 'me' : ''}"><div class="who">${esc(m.sender || '')} · ${esc(when(m))}</div>${m.text || m.unsent ? `<div class="b">${m.unsent ? '<i>Message unsent</i> ' : ''}${esc(m.text || '')}</div>` : ''}${m.share && m.share.link ? `<div class="b"><a href="${esc(m.share.link)}">${esc(m.share.text || m.share.link)}</a></div>` : ''}${att}${m.reactions?.length ? `<div class="r">${m.reactions.map(r => esc(r.r + ' ' + r.actor)).join(', ')}</div>` : ''}</div>`;
  }).join('\n');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title)}</title><style>body{font:15px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:0 auto;padding:12px;background:#f6f3fb}.m{margin:6px 0;display:flex;flex-direction:column;align-items:flex-start}.m.me{align-items:flex-end}.b{background:#eceaf1;padding:8px 12px;border-radius:16px;max-width:80%;white-space:pre-wrap;overflow-wrap:anywhere}.me .b{background:#0a7cff;color:#fff}.me .b a{color:#fff}.who{font-size:12px;color:#666;margin:6px 8px 2px}img,video{max-width:260px;max-height:320px;border-radius:12px;margin:2px}.miss{font-size:13px;color:#b45309}.r{font-size:12px;color:#666}</style></head><body><h1>${esc(t.title)}</h1><p>Participants: ${esc(t.participants.join(', '))}<br>${msgs.length} messages · exported from Liz Coobys Archive ${esc(new Date().toLocaleString())}</p>${rows}</body></html>`;
  if (mode === 'html') return saveBlob(new Blob([page], { type: 'text/html;charset=utf-8' }), safeName + '.html');
  const w = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
  await w.add('conversation.html', new zip.TextReader(page));
  const seen = new Set();
  for (const [fn, id] of files) { if (seen.has(fn)) continue; seen.add(fn); const b = await LCA.getFile(id); if (b) await w.add(fn, new zip.BlobReader(b), { level: 0 }); }
  saveBlob(await w.close(), safeName + '.zip'); toast('Export ready');
}

/* ---------- Photos & Videos ---------- */
let galF = { thread: '', kind: 'visual', from: '', to: '' };
async function renderMedia() {
  view.append(h('h2', null, 'Photos & Videos'));
  const all = await LCA.getAll('media');
  if (!all.length) { view.append(emptyState('photos or videos')); return; }
  const ths = [...new Set(all.map(m => m.threadId))].map(id => [id, S.threadMap.get(id)?.title || id]).sort((a, b) => a[1].localeCompare(b[1]));
  const sel = h('select', { 'aria-label': 'Conversation' }, h('option', { value: '' }, 'All conversations'), ths.map(([id, t]) => h('option', { value: id, selected: id === galF.thread }, t)));
  const kind = h('select', { 'aria-label': 'Type' }, [['visual', 'Photos, GIFs & videos'], ['photo', 'Photos'], ['video', 'Videos'], ['gif', 'GIFs'], ['sticker', 'Stickers'], ['audio', 'Audio'], ['file', 'Documents'], ['all', 'Everything']].map(([v, l]) => h('option', { value: v, selected: v === galF.kind }, l)));
  const from = h('input', { type: 'date', value: galF.from, 'aria-label': 'From date' }), to = h('input', { type: 'date', value: galF.to, 'aria-label': 'To date' });
  const info = h('div', { class: 'mut small', style: 'margin-bottom:6px' });
  const grid = h('div', { class: 'grid' });
  view.append(h('div', { class: 'filters' }, h('div', { class: 'full' }, sel), h('div', { class: 'full' }, kind), from, to), info, grid);
  let list = [], shown = 0;
  const more = h('button', { class: 'btn more', onclick: () => drawMore() }, 'Show more');
  function apply() {
    galF = { thread: sel.value, kind: kind.value, from: from.value, to: to.value };
    const f = galF.from ? new Date(galF.from + 'T00:00').getTime() : null, tt = galF.to ? new Date(galF.to + 'T23:59:59').getTime() : null;
    list = all.filter(m => (!galF.thread || m.threadId === galF.thread) && (galF.kind === 'all' || (galF.kind === 'visual' ? /photo|gif|video/.test(m.kind) : m.kind === galF.kind)) && (f == null || (m.ts != null && m.ts >= f)) && (tt == null || (m.ts != null && m.ts <= tt)))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    info.textContent = `${fmtN(list.length)} item(s) · ${fmtBytes(list.reduce((a, m) => a + (m.size || 0), 0))}`;
    revokeAll(); grid.innerHTML = ''; shown = 0; drawMore();
  }
  function drawMore() {
    more.remove();
    list.slice(shown, shown + 120).forEach((m) => {
      let inner;
      if (/photo|gif|sticker/.test(m.kind)) inner = lazy(h('img', { 'data-media': m.id, alt: m.name, decoding: 'async' }));
      else if (m.kind === 'video') inner = lazy(h('video', { 'data-media': m.id, preload: 'metadata', muted: true, playsinline: true }));
      else inner = h('div', { style: 'display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;padding:6px;text-align:center;word-break:break-all' }, (m.kind === 'audio' ? '🎤 ' : '📎 ') + m.name);
      const tile = h('button', { class: 'tile', title: `${S.threadMap.get(m.threadId)?.title || ''} · ${fmtDT(m.ts)}` }, inner, m.kind !== 'photo' ? h('span', { class: 'k' }, KIND_LABEL[m.kind] || m.kind) : null, !m.referenced ? h('span', { class: 'k', style: 'left:4px;right:auto', title: 'File was in the export folder but no message points to it' }, 'unlinked') : null);
      tile.addEventListener('click', () => {
        if (/photo|gif|sticker|video/.test(m.kind)) { const vis = list.filter(x => /photo|gif|sticker|video/.test(x.kind)); openViewer(vis, vis.indexOf(m)); }
        else downloadMedia(m.id);
      });
      grid.append(tile);
    });
    shown += 120;
    if (shown < list.length) { more.textContent = `Show more (${fmtN(list.length - shown)} left)`; grid.after(more); if (io) { const o = new IntersectionObserver(e => { if (e[0].isIntersecting) { o.disconnect(); drawMore(); } }); o.observe(more); } }
  }
  for (const el of [sel, kind, from, to]) el.addEventListener('change', apply);
  apply();
}

/* ---------- Friends ---------- */
let frF = { tab: 'all', q: '' };
function crossRef(pageRecs, exportRecs) {
  // match only when the name is unique on BOTH sides – people who share a name are never merged
  const group = (arr) => { const m = new Map(); for (const r of arr) { const k = normName(r.name); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const P = group(pageRecs), E = group(exportRecs);
  const res = { matched: [], pageOnly: [], exportOnly: [], ambiguous: [], ambiguousExport: [], sameNamePage: 0, sameNameExport: 0 };
  for (const r of pageRecs.concat(exportRecs)) { delete r._match; delete r._ambig; }
  for (const [k, ps] of P) {
    const es = E.get(k) || [];
    if (ps.length > 1) res.sameNamePage += ps.length;
    if (ps.length === 1 && es.length === 1) { ps[0]._match = es[0]; es[0]._match = ps[0]; res.matched.push(ps[0]); }
    else if (!es.length && ps.length === 1) res.pageOnly.push(ps[0]);
    else { ps.forEach(p => { p._ambig = { page: ps.length, exp: es.length }; res.ambiguous.push(p); }); es.forEach(e => { e._ambig = { page: ps.length, exp: es.length }; res.ambiguousExport.push(e); }); }
  }
  for (const [k, es] of E) { if (es.length > 1) res.sameNameExport += es.length; if (!P.has(k)) { if (es.length === 1) res.exportOnly.push(es[0]); else es.forEach(e => { e._ambig = { page: 0, exp: es.length }; res.ambiguousExport.push(e); }); } }
  return res;
}
const idLine = (r) => [r.fbId ? 'ID ' + r.fbId : null, r.username ? '@' + r.username : null].filter(Boolean).join(' · ');
const linkEl = (url) => url ? h('a', { class: 't2', href: url, target: '_blank', rel: 'noopener noreferrer', style: 'display:block;color:var(--p)' }, url.replace(/^https?:\/\/(www\.)?/, '')) : null;
async function renderFriends() {
  view.append(h('h2', null, 'Friends'));
  const all = await LCA.getAll('friends');
  if (!all.length) { view.append(emptyState('friends')); return; }
  const page = all.filter(r => r.source === 'page').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const exp = all.filter(r => r.source === 'export');
  const expFriends = exp.filter(r => r.category === 'friend');
  const otherExp = exp.filter(r => r.category !== 'friend');
  const x = crossRef(page, expFriends);
  const rep = S.report?.saved?.friends;
  const noLink = page.filter(r => !r.url);
  view.append(h('div', { class: 'card small' },
    h('div', null, h('b', null, fmtN(page.length)), ' friends from your saved friends page' + (rep?.statedTotal ? ` (the page says ${fmtN(rep.statedTotal)} friends)` : '') + ' · ', h('b', null, fmtN(expFriends.length)), ' in the export’s friend list.'),
    expFriends.length && page.length ? h('div', null, `${fmtN(x.matched.length)} matched by name · ${fmtN(x.pageOnly.length)} only on saved page · ${fmtN(x.exportOnly.length)} only in export · ${fmtN(x.ambiguous.length + x.ambiguousExport.length)} share a name (kept separate)`) : null,
    !expFriends.length ? h('div', { class: 'mut' }, 'No friend list from the Facebook export yet, so nothing to cross-check against.') : null,
    !page.length ? h('div', { class: 'mut' }, 'Import friends.html to get profile links and pictures.') : null,
    rep?.statedTotal && rep.statedTotal > page.length ? h('div', { style: 'color:var(--warn)' }, `⚠️ ${fmtN(rep.statedTotal - page.length)} friends were not loaded when the page was saved (Facebook only loads more while you scroll). Their names may still be in the export’s friend list.`) : null));
  const tabs = [['all', 'All'], ...(expFriends.length && page.length ? [['matched', 'Matched'], ['pageOnly', 'Only saved page'], ['exportOnly', 'Only in export'], ['ambiguous', 'Same name']] : []), ['nolink', 'Missing link'], ...(otherExp.length ? [['other', 'Other lists']] : [])];
  const box = h('div'), listEl = h('ul', { class: 'list card', style: 'padding:0 8px' });
  const filt = h('input', { type: 'search', placeholder: 'Search friends by name, username or ID…', value: frF.q, style: inputStyle });
  view.append(filt, box, listEl);
  let shown = 200;
  const draw = () => {
    box.innerHTML = ''; box.append(chips(tabs, frF.tab, v => { frF.tab = v; shown = 200; draw(); }));
    const exportNoMatch = expFriends.filter(e => !e._match);
    let list = { matched: x.matched, pageOnly: x.pageOnly, exportOnly: x.exportOnly, ambiguous: x.ambiguous.concat(x.ambiguousExport), nolink: noLink.concat(exportNoMatch), other: otherExp }[frF.tab] || page.concat(exportNoMatch);
    const q = normName(frF.q); if (q) list = list.filter(r => normName(r.name + ' ' + (r.username || '') + ' ' + (r.fbId || '')).includes(q));
    listEl.innerHTML = '';
    for (const r of list.slice(0, shown)) listEl.append(friendItem(r));
    if (list.length > shown) listEl.append(h('li', null, h('button', { class: 'btn more', onclick: () => { shown += 400; draw(); } }, `Show more (${fmtN(list.length - shown)} left)`)));
    if (!list.length) listEl.append(h('li', { class: 'empty' }, 'Nobody here.'));
  };
  filt.addEventListener('input', () => { frF.q = filt.value; shown = 200; draw(); });
  draw();
}
function friendItem(r) {
  const m = r._match;
  return h('li', { class: 'item' }, avatar(r.name, r.image),
    h('div', { class: 'grow' },
      h('div', { class: 't1' }, r.name || '(no name)'),
      linkEl(r.url) || h('div', { class: 't2' }, 'No profile link available'),
      h('div', null,
        idLine(r) ? h('span', { class: 'badge' }, idLine(r)) : null,
        r.source === 'export' ? h('span', { class: 'badge p' }, (r.category === 'friend' ? 'From export' : r.category.replace(/_/g, ' ')) + (r.ts ? ' · ' + fmtDate(r.ts) : '')) : null,
        m && r.source === 'page' ? h('span', { class: 'badge ok' }, '✓ In export' + (m.ts ? ' · friends since ' + fmtDate(m.ts) : '')) : null,
        r._ambig ? h('span', { class: 'badge warn' }, `Name shared (${r._ambig.page} on page / ${r._ambig.exp} in export) – not merged`) : null,
        r.otherNames && r.otherNames.length ? h('span', { class: 'badge' }, 'also shown as ' + r.otherNames.join(', ')) : null),
      r.detail ? h('div', { class: 'mut small' }, r.detail) : null));
}

/* ---------- Groups ---------- */
let grF = { tab: 'all', q: '' };
const GSEC = { manage: 'I manage', joined: 'Joined', pending: 'Pending request', invited: 'Invited', other: 'Other' };
async function renderGroups() {
  view.append(h('h2', null, 'Groups'));
  const all = await LCA.getAll('groups');
  if (!all.length) { view.append(emptyState('groups')); return; }
  const page = all.filter(r => r.source === 'page').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const exp = all.filter(r => r.source === 'export');
  const pageNames = new Set(page.map(r => normName(r.name)));
  const expNames = new Map(); for (const e of exp) { const k = normName(e.name); if (!expNames.has(k)) expNames.set(k, []); expNames.get(k).push(e); }
  const rep = S.report?.saved?.groups;
  const cnt = (s) => page.filter(r => (r.sections || []).includes(s)).length;
  view.append(h('div', { class: 'card small' }, h('b', null, fmtN(page.length)), ' groups from your saved Groups page' + (rep?.statedTotal ? ` (page says ${fmtN(rep.statedTotal)} joined)` : '') + `: ${cnt('manage')} you manage, ${cnt('joined')} joined, ${cnt('pending')} pending. `, exp.length ? [h('b', null, fmtN(exp.length)), ' group entries from the export (membership history).'] : 'No group data from the export yet.'));
  const tabs = [...(page.length ? [['all', 'All on saved page'], ['manage', 'I manage'], ['joined', 'Joined'], ['pending', 'Pending']] : []), ...(exp.length ? [['export', 'Export history'], ...(page.length ? [['past', 'Not on current page']] : [])] : [])];
  if (!tabs.some(t => t[0] === grF.tab)) grF.tab = tabs[0][0];
  const box = h('div'), listEl = h('ul', { class: 'list card', style: 'padding:0 8px' });
  const filt = h('input', { type: 'search', placeholder: 'Search groups…', value: grF.q, style: inputStyle });
  view.append(filt, box, listEl);
  const draw = () => {
    box.innerHTML = ''; box.append(chips(tabs, grF.tab, v => { grF.tab = v; draw(); }));
    let list = grF.tab === 'export' ? exp : grF.tab === 'past' ? exp.filter(e => !pageNames.has(normName(e.name))) : grF.tab === 'all' ? page : page.filter(r => (r.sections || []).includes(grF.tab));
    const q = normName(grF.q); if (q) list = list.filter(r => normName((r.name || '') + ' ' + (r.title || '')).includes(q));
    listEl.innerHTML = '';
    for (const r of list) {
      const e1 = r.source === 'page' ? (expNames.get(normName(r.name)) || [])[0] : null;
      listEl.append(h('li', { class: 'item' }, avatar(r.name, r.image, true), h('div', { class: 'grow' },
        h('div', { class: 't1' }, r.name || r.title || '(no name)'),
        linkEl(r.url) || h('div', { class: 't2' }, 'No link in export'),
        h('div', null, (r.sections || []).map(s => h('span', { class: 'badge ' + (s === 'manage' ? 'ok' : s === 'pending' ? 'warn' : 'p') }, GSEC[s] || s)),
          r.groupId ? h('span', { class: 'badge' }, 'ID ' + r.groupId) : null,
          e1 ? h('span', { class: 'badge ok' }, '✓ also in export' + (e1.ts ? ' · ' + fmtDate(e1.ts) : '')) : null,
          r.source === 'export' ? h('span', { class: 'badge p' }, r.category.replace(/_/g, ' ') + (r.ts ? ' · ' + fmtDate(r.ts) : '')) : null,
          r.source === 'export' && page.length && !pageNames.has(normName(r.name)) ? h('span', { class: 'badge warn' }, 'not on current joined page') : null),
        r.title && r.title !== r.name ? h('div', { class: 'mut small' }, r.title) : null,
        r.detail ? h('div', { class: 'mut small' }, r.detail + (r.source === 'page' ? ' (when the page was saved)' : '')) : null)));
    }
    if (!list.length) listEl.append(h('li', { class: 'empty' }, 'Nothing here.'));
  };
  filt.addEventListener('input', () => { grF.q = filt.value; draw(); });
  draw();
}

/* ---------- Pages ---------- */
let pgF = { tab: 'page', q: '' };
const PCAT = { liked_page: 'Liked Pages (export)', followed_page: 'Followed Pages (export)', followed_profile: 'Followed profiles (export)', unfollowed_page: 'Unfollowed Pages (export)', unfollowed_profile: 'Unfollowed profiles (export)' };
async function renderPages() {
  view.append(h('h2', null, 'Pages'));
  const all = await LCA.getAll('pages');
  if (!all.length) { view.append(emptyState('pages')); return; }
  const page = all.filter(r => r.source === 'page').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const exp = all.filter(r => r.source === 'export');
  const cats = [...new Set(exp.map(r => r.category))];
  const rep = S.report?.saved?.pages;
  const pageNames = new Set(page.map(r => normName(r.name)));
  view.append(h('div', { class: 'card small' }, h('b', null, fmtN(page.length)), ' Pages from your saved Pages list' + (rep?.statedTotal ? ` (page says ${fmtN(rep.statedTotal)} Pages you follow)` : '') + '. ', cats.map(c => `${fmtN(exp.filter(r => r.category === c).length)} ${PCAT[c] || c.replace(/_/g, ' ')}. `)));
  const tabs = [...(page.length ? [['page', 'Pages you follow (saved page)']] : []), ...cats.map(c => [c, PCAT[c] || c.replace(/_/g, ' ')])];
  if (!tabs.some(t => t[0] === pgF.tab)) pgF.tab = tabs[0][0];
  const box = h('div'), listEl = h('ul', { class: 'list card', style: 'padding:0 8px' });
  const filt = h('input', { type: 'search', placeholder: 'Search pages…', value: pgF.q, style: inputStyle });
  view.append(filt, box, listEl);
  const draw = () => {
    box.innerHTML = ''; box.append(chips(tabs, pgF.tab, v => { pgF.tab = v; draw(); }));
    let list = pgF.tab === 'page' ? page : exp.filter(r => r.category === pgF.tab);
    const q = normName(pgF.q); if (q) list = list.filter(r => normName((r.name || '') + ' ' + (r.pageCategory || '')).includes(q));
    listEl.innerHTML = '';
    for (const r of list) listEl.append(h('li', { class: 'item' }, avatar(r.name, r.image), h('div', { class: 'grow' },
      h('div', { class: 't1' }, r.name || r.title || '(no name)'),
      linkEl(r.url) || h('div', { class: 't2' }, 'No link in export'),
      h('div', null, r.pageCategory ? h('span', { class: 'badge' }, r.pageCategory) : null, idLine(r) ? h('span', { class: 'badge' }, idLine(r)) : null,
        r.source === 'export' ? h('span', { class: 'badge p' }, (PCAT[r.category] || r.category) + (r.ts ? ' · ' + fmtDate(r.ts) : '')) : null,
        r.source === 'export' && pageNames.has(normName(r.name)) ? h('span', { class: 'badge ok' }, '✓ also on saved page') : null))));
    if (!list.length) listEl.append(h('li', { class: 'empty' }, 'Nothing here.'));
  };
  filt.addEventListener('input', () => { pgF.q = filt.value; draw(); });
  draw();
}

/* ---------- Search ---------- */
async function ensureSearchIdx() { if (S.searchIdx) return; const rows = await LCA.getAll('search'); S.searchIdx = new Map(rows.map(r => [r.threadId, r])); }
async function renderSearch(qfull) {
  const qi = qfull.lastIndexOf('?t='); const q = (qi >= 0 ? qfull.slice(0, qi) : qfull).trim(); const onlyThread = qi >= 0 ? decodeURIComponent(qfull.slice(qi + 3)) : null;
  $('#q').value = q;
  view.append(h('h2', null, `Search: “${q}”`));
  if (!q) return;
  const ql = q.toLowerCase(), qn = normName(q);
  await ensureSearchIdx();
  const t0 = performance.now();
  const hits = []; let total = 0, scanned = 0;
  for (const [tid, s] of S.searchIdx) {
    if (onlyThread && tid !== onlyThread) continue;
    scanned += s.texts.length;
    for (let i = 0; i < s.texts.length; i++) if (s.texts[i].includes(ql)) { total++; hits.push([tid, s.ords[i]]); }
  }
  const convs = onlyThread ? [] : S.threads.filter(t => normName(t.title + ' ' + t.participants.join(' ')).includes(qn)).slice(0, 50);
  const [fr, gr, pg] = onlyThread ? [[], [], []] : await Promise.all(['friends', 'groups', 'pages'].map(s => LCA.getAll(s)));
  const fm = (arr) => arr.filter(r => normName((r.name || '') + ' ' + (r.username || '') + ' ' + (r.fbId || '') + ' ' + (r.title || '')).includes(qn));
  if (onlyThread) view.append(h('div', { class: 'mut small' }, 'In conversation: ', h('a', { href: '#/thread/' + encodeURIComponent(onlyThread) }, S.threadMap.get(onlyThread)?.title || '')));
  if (convs.length) view.append(h('h3', null, `Conversations (${convs.length})`), h('ul', { class: 'list card', style: 'padding:0 8px' }, convs.map(t => h('li', null, h('a', { class: 'item', href: '#/thread/' + encodeURIComponent(t.id) }, avatar(t.title), h('div', { class: 'grow' }, h('div', { class: 't1' }, t.title), h('div', { class: 't2' }, `${fmtN(t.msgCount)} messages · ${catLabel(t.category)}`)))))));
  const msgBox = h('ul', { class: 'list card', style: 'padding:0 8px' });
  const LIMIT = 300;
  view.append(h('h3', null, `Messages (${fmtN(total)}${total > LIMIT ? ', showing ' + LIMIT + ' newest' : ''})`), msgBox);
  hits.sort((a, b) => ((S.threadMap.get(b[0])?.lastTs || 0) - (S.threadMap.get(a[0])?.lastTs || 0)) || b[1] - a[1]);
  const msgs = (await Promise.all(hits.slice(0, 1500).map(([tid, ord]) => LCA.get('messages', tid + '#' + String(ord).padStart(7, '0'))))).filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, LIMIT);
  for (const m of msgs) {
    const t = S.threadMap.get(m.threadId);
    const txt = [m.text, m.share?.text, m.share?.link, ...(m.att || []).map(a => a.name)].filter(Boolean).join(' ');
    const i = Math.max(0, txt.toLowerCase().indexOf(ql)); const st = Math.max(0, i - 50);
    const snip = (st > 0 ? '…' : '') + esc(txt.slice(st, i)) + '<mark class="hl">' + esc(txt.slice(i, i + q.length)) + '</mark>' + esc(txt.slice(i + q.length, i + q.length + 90)) + (i + q.length + 90 < txt.length ? '…' : '');
    msgBox.append(h('li', null, h('a', { class: 'item', href: '#/thread/' + encodeURIComponent(m.threadId) + '/' + m.ord }, h('div', { class: 'grow' },
      h('div', { class: 't1' }, (t?.title || '') + ' · ' + (isMe(m.sender) ? 'You' : (m.sender || ''))), h('div', { class: 'snip', html: snip })), h('div', { class: 'when' }, fmtDate(m.ts)))));
  }
  if (!msgs.length) msgBox.append(h('li', { class: 'empty' }, S.searchIdx.size ? 'No messages contain that text.' : 'No conversations imported yet.'));
  const sect = (label, arr, kind) => { const f = fm(arr); if (!f.length) return; view.append(h('h3', null, `${label} (${f.length})`), h('ul', { class: 'list card', style: 'padding:0 8px' }, f.slice(0, 100).map(r => kind === 'friends' ? friendItem(r) : h('li', { class: 'item' }, avatar(r.name, r.image, kind === 'groups'), h('div', { class: 'grow' }, h('div', { class: 't1' }, r.name || r.title), linkEl(r.url) || h('div', { class: 't2' }, r.source === 'export' ? 'From export' : '')))))); };
  sect('Friends', fr, 'friends'); sect('Groups', gr, 'groups'); sect('Pages', pg, 'pages');
  view.append(h('div', { class: 'mut small', style: 'margin-top:10px' }, `Searched ${fmtN(scanned)} messages in ${Math.round(performance.now() - t0)} ms.`));
}

/* ---------- Import & status ---------- */
async function renderImport() {
  const st = await storageInfo();
  const fileInput = (accept, multiple, dir) => { const i = h('input', { type: 'file', accept: accept || null, multiple, hidden: true }); if (dir) i.setAttribute('webkitdirectory', ''); i.addEventListener('change', () => { importFiles(i.files); }); return i; };
  const any = fileInput('', true), zipI = fileInput('.zip,application/zip', true), htmlI = fileInput('.html,.htm,text/html', true), dirI = fileInput('', true, true);
  const restI = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  restI.addEventListener('change', async () => {
    if (!restI.files[0]) return; if (!confirm('Restore this backup? Everything currently stored in the app will be replaced.')) return;
    S.busy = true; $('#prog').hidden = false;
    try { await runWorker({ type: 'restore', file: restI.files[0] }); await loadState(true); toast('Backup restored'); render(); } catch (e) { alert('Restore failed: ' + e.message); } finally { S.busy = false; }
  });
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  view.append(h('h2', null, 'Import & status'), installCard() || '',
    h('div', { class: 'card' },
      h('p', { style: 'margin-top:0' }, '🔒 Your files are read and stored only on this device. Nothing is uploaded, and no Facebook login is needed.'),
      ios && !standalone ? h('div', { class: 'note' }, '📱 On iPhone: first add this app to your Home Screen (Share ⬆️ → “Add to Home Screen”), open it from there, and import inside the app. Safari and the Home Screen app keep separate storage.') : null,
      h('button', { class: 'btn big primary', onclick: () => any.click() }, '📂 Choose files to import'),
      h('div', { class: 'mut small' }, 'Pick “Liz coobys meta export.zip” and/or friends.html, Groups.html and pages.html — one at a time or several together. No need to unzip or rename anything. Re-importing a file replaces what came from it before.'),
      h('details', null, h('summary', null, 'More import options'),
        h('button', { class: 'btn big', onclick: () => zipI.click() }, '🗜️ Facebook export (.zip, several parts allowed)'),
        h('button', { class: 'btn big', onclick: () => htmlI.click() }, '🌐 Saved Facebook pages (friends / Groups / pages .html)'),
        h('button', { class: 'btn big', onclick: () => dirI.click() }, '📁 A whole folder, e.g. “Liz Coobys” (computer)'),
        h('div', { class: 'mut small' }, 'The “…_files” folders saved next to the .html pages only contain Facebook’s scripts and styles (no names or pictures), so they are optional. If you add them they are listed in the report.')),
      any, zipI, htmlI, dirI, restI,
      h('div', { id: 'prog', hidden: !S.busy, style: 'margin-top:10px' }, h('div', { id: 'progPhase', class: 'small' }, 'Working…'), h('progress', { id: 'progBar', max: 1, value: 0 }), h('div', { id: 'progNote', class: 'mut small' }))),
    await reportView(),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '💾 Storage on this device'),
      h('div', null, `Used: ${fmtBytes(st.usage)}${st.quota ? ' · available to this app: ' + fmtBytes(st.quota) : ''}.`),
      h('div', null, st.persisted ? '✅ Storage is persistent – the browser will not clear it on its own.' : '⚠️ Storage is not marked persistent yet. ', !st.persisted ? h('button', { class: 'btn', onclick: async () => { const ok = await askPersist(); toast(ok ? 'Storage is now persistent' : 'The browser declined – installing the app to the home screen helps'); render(); } }, 'Make persistent') : null),
      st.quota && st.usage / st.quota > 0.85 ? h('div', { class: 'note' }, '⚠️ Storage is almost full. Make a backup and free up space on the device.') : null),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '🧳 Backup & move to another device'),
      h('p', { class: 'small mut', style: 'margin-top:0' }, 'Creates one .zip file with every conversation, photo, video, friend, group and page in this app. Keep it somewhere safe (computer, USB stick, your own cloud). On another device, open this app and tap “Restore backup” (or simply import the backup file).'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: doBackup }, '⤓ Download full backup'), h('button', { class: 'btn', onclick: () => restI.click() }, '⤒ Restore backup'))),
    await ownerCard(),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'About'), h('div', { class: 'small mut' }, 'Liz Coobys Archive works offline after the first visit. It shows only what is actually in your imported files; nothing is invented or reconstructed. Profile links open Facebook and will only work while those profiles exist.'),
      h('button', { class: 'btn danger', style: 'margin-top:8px', onclick: eraseAll }, 'Erase everything from this device')));
}
async function ownerCard() {
  const names = new Map(); for (const t of S.threads) for (const p of t.participants) names.set(p, (names.get(p) || 0) + 1);
  if (!names.size) return null;
  const sel = h('select', { style: 'padding:8px;border-radius:10px;border:1px solid var(--line);background:var(--card);max-width:100%' }, h('option', { value: '' }, '(not set)'), [...names].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([n, c]) => h('option', { value: n, selected: n === S.owner }, `${n} (${c} chats)`)));
  sel.addEventListener('change', async () => { await LCA.setMeta('owner', sel.value || null); S.owner = sel.value || null; toast('Saved'); });
  return h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '🙋 Which name is you?'), h('div', { class: 'small mut' }, 'Your own messages are shown on the right in blue.'), sel);
}
async function doBackup() {
  if (S.busy) return; S.busy = true; $('#prog').hidden = false;
  try { const r = await runWorker({ type: 'backup' }); const d = new Date().toISOString().slice(0, 10); saveBlob(r.blob, `liz-coobys-archive-backup-${d}.zip`); await LCA.setMeta('lastBackup', Date.now()); setProgress('Backup ready – ' + fmtBytes(r.blob.size), 1, 1); }
  catch (e) { alert('Backup failed: ' + e.message); } finally { S.busy = false; }
}
async function eraseAll() {
  if (!confirm('Erase ALL archived data from this device? Make a backup first if you want to keep it.')) return;
  if (!confirm('Really erase everything?')) return;
  await LCA.clear(LCA.STORES); avCache.clear(); await loadState(true); toast('Erased'); render();
}
async function reportView() {
  const r = S.report; const c = h('div', { class: 'card', id: 'report' }, h('h3', { style: 'margin-top:0' }, '📋 What has been recovered'));
  if (!r) { c.append(h('div', { class: 'mut' }, 'Nothing imported yet.')); return c; }
  const M = r.messenger || { media: {} }; const md = M.media || {};
  const allF = await LCA.getAll('friends'); const pf = allF.filter(x => x.source === 'page'); const ef = allF.filter(x => x.source === 'export' && x.category === 'friend');
  const x = crossRef(pf, ef);
  const g = await LCA.getAll('groups'), p = await LCA.getAll('pages');
  const dupUrl = (() => { const m = new Map(); for (const f of pf) if (f.url) m.set(f.url, (m.get(f.url) || 0) + 1); return [...m.values()].filter(v => v > 1).length; })();
  const sameName = (arr) => { const m = new Map(); for (const f of arr) { const k = normName(f.name); m.set(k, (m.get(k) || 0) + 1); } return [...m].filter(([, v]) => v > 1); };
  const pfSame = sameName(pf);
  const row = (label, n, cls) => h('tr', null, h('td', null, label), h('td', { class: 'n', style: cls ? `color:var(--${cls})` : '' }, typeof n === 'number' ? fmtN(n) : n));
  const sub = (label) => h('tr', null, h('td', { colspan: 2, style: 'padding-top:14px' }, h('b', null, label)));
  const lastBackup = await LCA.getMeta('lastBackup', null);
  c.append(h('div', { class: 'small mut' }, 'Imported: ', [...(r.sources || []).map(s => `${s.name} (${fmtBytes(s.size)}, ${fmtN(s.entries)} files)`), ...Object.values(r.saved || {}).map(s => s.file)].join(' · ') || '—'),
    h('table', { class: 'rep' },
      sub('💬 Messenger'),
      row('Conversations', M.threads || 0), row('Messages', M.messages || 0),
      Object.entries(M.byCategory || {}).map(([k, v]) => row(' · ' + catLabel(k), `${fmtN(v.threads)} chats · ${fmtN(v.messages)} msgs`)),
      row('Text fields with Facebook’s encoding repaired (å ä ö, emoji)', M.mojibakeFixed || 0),
      row('Attachments referenced in messages', md.referenced || 0), row('Media files found & stored', md.found || 0, 'ok'),
      row('Referenced but missing from the export', md.missing || 0, md.missing ? 'warn' : null), row('Unreadable media files', md.unreadable || 0, md.unreadable ? 'bad' : null),
      row('Online-only links (not stored)', md.remote || 0), row('Extra Messenger media not linked to a message (kept)', md.unreferencedStored || 0),
      row('Empty conversations', (M.emptyThreads || []).length),
      sub('👥 Friends'),
      row('From saved friends page', pf.length), r.saved?.friends?.statedTotal ? row(' · total the page said', r.saved.friends.statedTotal, r.saved.friends.statedTotal > pf.length ? 'warn' : null) : null,
      row(' · with profile link', pf.filter(f => f.url).length), row(' · missing profile link', pf.filter(f => !f.url).length), row(' · with numeric ID', pf.filter(f => f.fbId).length), row(' · with username', pf.filter(f => f.username).length),
      row(' · same link listed twice', dupUrl), row(' · names shared by different people (kept separate)', pfSame.reduce((a, [, v]) => a + v, 0)),
      row(' · pictures saved offline', r.saved?.friends?.avatars ? `${fmtN(r.saved.friends.avatars.ok)} / ${fmtN(r.saved.friends.avatars.total)}` : '—'),
      row('From the export’s friend list', ef.length),
      ef.length && pf.length ? [row(' · matched by name', x.matched.length, 'ok'), row(' · only on saved page (unmatched)', x.pageOnly.length), row(' · only in export (unmatched, no link)', x.exportOnly.length), row(' · same name – not merged', x.ambiguous.length + x.ambiguousExport.length, (x.ambiguous.length + x.ambiguousExport.length) ? 'warn' : null)] : null,
      row('Other people lists in export (removed, requests, followers)', allF.filter(f => f.source === 'export' && f.category !== 'friend').length),
      sub('🏘️ Groups'),
      row('From saved Groups page', g.filter(z => z.source === 'page').length), r.saved?.groups?.statedTotal ? row(' · joined total the page said', r.saved.groups.statedTotal) : null,
      row(' · I manage / joined / pending', ['manage', 'joined', 'pending'].map(s => g.filter(z => (z.sections || []).includes(s)).length).join(' / ')),
      row('Group entries from export (history)', g.filter(z => z.source === 'export').length),
      sub('🚩 Pages'),
      row('From saved Pages list', p.filter(z => z.source === 'page').length), r.saved?.pages?.statedTotal ? row(' · total the page said', r.saved.pages.statedTotal) : null,
      [...new Set(p.filter(z => z.source === 'export').map(z => z.category))].map(cat => row((PCAT[cat] || cat.replace(/_/g, ' ')), p.filter(z => z.source === 'export' && z.category === cat).length)),
      sub('🗂️ Other'),
      row('Media stored in total', M.mediaStored ?? '—'), row('Export files not shown in this app (listed below)', r.notImportedCount || 0), row('Last backup', lastBackup ? fmtDT(lastBackup) : 'never', lastBackup ? null : 'warn')));
  const det = (title, items, fn, cap = 3000) => items && items.length ? h('details', null, h('summary', null, title), h('div', { class: 'scroll' }, items.slice(0, cap).map(i => h('div', null, fn(i))), items.length > cap ? h('div', null, `… and ${fmtN(items.length - cap)} more`) : null)) : null;
  c.append(...[h('div', { class: 'note' }, 'ℹ️ Meta’s export can leave things out: end-to-end encrypted chats (Meta exports those separately from Messenger’s “secure storage”), chats deleted before the export, and some photos/videos. Anything referenced but not included is marked ⚠️. Nothing is invented.'),
    det(`⚠️ Missing media (${fmtN(md.missing)})`, M.missingList, m => `${m.thread}: ${m.uri}`),
    det(`Unreadable media (${fmtN((M.unreadableList || []).length)})`, M.unreadableList, m => `${m.thread}: ${m.uri} – ${m.error}`),
    det(`Empty conversations (${fmtN((M.emptyThreads || []).length)})`, M.emptyThreads, m => m),
    det(`Same name, different people – kept separate (${fmtN(x.ambiguous.length + x.ambiguousExport.length)})`, x.ambiguous.concat(x.ambiguousExport), f => `${f.name} – ${f.url || 'export entry, no link'}`),
    ef.length && pf.length ? det(`Unmatched: only in export, no link (${fmtN(x.exportOnly.length)})`, x.exportOnly, f => `${f.name}${f.ts ? ' – friends since ' + fmtDate(f.ts) : ''}`) : null,
    ef.length && pf.length ? det(`Unmatched: only on saved page (${fmtN(x.pageOnly.length)})`, x.pageOnly, f => `${f.name} – ${f.url || ''}`) : null,
    det(`Friends without a profile link (${fmtN(pf.filter(f => !f.url).length)})`, pf.filter(f => !f.url), f => f.name),
    (r.sections || []).length ? h('details', null, h('summary', null, `Export sections (${r.sections.length} folders)`), h('table', { class: 'rep' }, h('tr', null, h('td', null, h('b', null, 'Folder')), h('td', { class: 'n' }, 'files · shown · not shown')), r.sections.map(s => h('tr', null, h('td', null, s.folder, h('div', { class: 'mut small' }, fmtBytes(s.bytes))), h('td', { class: 'n' }, `${fmtN(s.files)} · ${fmtN(s.imported)} · ${fmtN(s.notImported + (s.unreadable || 0))}`))))) : null,
    det(`Files in the export not shown in this app (${fmtN(r.notImportedCount || (r.notImported || []).length)}) – listed, nothing deleted`, r.notImported, f => `${f.path} (${fmtBytes(f.size)}) – ${f.reason}`),
    det(`Unreadable files (${fmtN((r.unreadableFiles || []).length)})`, r.unreadableFiles, f => `${f.path}: ${f.error}`),
    det(`Other selected files without archive data (${fmtN((r.ignoredUploads || []).length)})`, r.ignoredUploads, f => `${f.path} – ${f.reason}`),
    det(`Warnings (${fmtN((r.warnings || []).length + (M.threadWarnings || []).length)})`, (r.warnings || []).concat(M.threadWarnings || []), w => w),
    det(`People / group / page files read from the export (${Object.keys(r.lists || {}).length})`, Object.entries(r.lists || {}), ([k, v]) => `${k}: ${v.records} entries (${Object.entries(v.categories).map(([a, b]) => a + ' ' + b).join(', ')})`)].filter(Boolean));
  return c;
}

/* ---------- boot ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (location.hash.startsWith('#/import')) render(); });
function installCard() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return null;
  if (installEvt) return h('div', { class: 'card' }, h('button', { class: 'btn big primary', onclick: async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => null); installEvt = null; render(); } }, '📲 Install Liz Coobys Archive on this device'));
  return h('div', { class: 'card small mut' }, '📲 Install: on iPhone tap Share ⬆️ → “Add to Home Screen”. On Android open the Chrome menu ⋮ → “Install app” / “Add to Home screen”.');
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
(async () => {
  try { await LCA.openDB(); } catch (e) { view.append(h('div', { class: 'note' }, 'This browser cannot store the archive (IndexedDB unavailable – private browsing?). ' + e.message)); return; }
  await loadState(true);
  if (!location.hash) { location.replace('#/' + (S.threads.length || S.report ? 'messenger' : 'import')); }
  render();
})();
