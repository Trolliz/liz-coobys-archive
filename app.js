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
const S = { owner: null, threads: null, report: null, searchIdx: null, urls: [], busy: false, profile: null, profiles: [], searchScope: 'this', xcache: new Map() };
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
function avatar(name, url, sq, L) {
  const el = h('div', { class: 'av' + (sq ? ' sq' : '') }, initials(name));
  if (url) (async () => {
    let u = avCache.get(url);
    if (!u) { const r = await (L || LCA).get('avatars', url).catch(() => null); if (r && r.blob) { u = URL.createObjectURL(r.blob); avCache.set(url, u); } }
    const img = h('img', { alt: '', referrerpolicy: 'no-referrer', decoding: 'async' });
    img.onerror = () => img.remove();
    img.onload = () => { el.textContent = ''; el.append(img); };
    img.src = u || url;
  })();
  return el;
}
async function cacheAvatars(urls, label, L) {
  const todo = [...new Set(urls.filter(Boolean))]; let ok = 0, fail = 0, i = 0;
  const have = new Set((await L.getAll('avatars')).filter(a => a.blob).map(a => a.url));
  const list = todo.filter(u => !have.has(u)); ok = todo.length - list.length;
  async function one() {
    while (i < list.length) {
      const u = list[i++];
      try { const r = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }); if (!r.ok) throw 0; const b = await r.blob(); await L.put('avatars', { url: u, blob: b, savedAt: Date.now() }); ok++; }
      catch (e) { fail++; }
      if ((ok + fail) % 20 === 0) setProgress(`Saving ${label} pictures for offline use`, ok + fail, todo.length);
    }
  }
  await Promise.all([one(), one(), one(), one(), one(), one()]);
  return { ok, fail, total: todo.length };
}

/* ---------- import helper (worker) ----------
   The helper normally runs as a Web Worker. It must say "ready" (with the same version as this screen) within 15 s;
   otherwise it is stopped and the same code is loaded into the page instead, so imports still work – only slower. */
const APP_VERSION = '6';
let worker = null, workerDone = null, workerMode = null, workerStarting = null;
async function onWorkerMessage(e) {
  const d = e.data; if (!d) return;
  S.lastBeat = Date.now();
  if (d.type === 'progress') setProgress(d.phase, d.done, d.total, d.note);
  else if (d.type === 'parseMessageHtml') worker.postMessage({ type: 'reply', id: d.id, result: safe(() => Parsers.parseMessageHtml(d.text)) });
  else if (d.type === 'parseHtmlList') worker.postMessage({ type: 'reply', id: d.id, result: safe(() => Parsers.parseHtmlList(d.text)) });
  else if (d.type === 'confirmProfile') worker.postMessage({ type: 'reply', id: d.id, result: await confirmProfileName(d.name).catch(() => true) });
  else if (d.type === 'isBackup') { workerDone && workerDone.resolve({ backup: true }); }
  else if (d.type === 'done' || d.type === 'backupReady') { workerDone && workerDone.resolve(d.type === 'done' ? (d.result || {}) : d); }
  else if (d.type === 'error') { workerDone && workerDone.reject(new Error(d.message)); }
}
function startRealWorker() {
  return new Promise((resolve, reject) => {
    let w; try { w = new Worker('worker.js?v=' + APP_VERSION); } catch (e) { return reject(e); }
    const timer = setTimeout(() => { w.terminate(); reject(new Error('the background helper did not start within 15 seconds')); }, 15000);
    w.onmessage = (e) => {
      if (!e.data || e.data.type !== 'ready') return;
      clearTimeout(timer);
      if (e.data.version !== APP_VERSION) { w.terminate(); return reject(new Error(`the background helper is version ${e.data.version}, this screen is version ${APP_VERSION}`)); }
      w.onmessage = onWorkerMessage;
      w.onerror = (ev) => { ev.preventDefault && ev.preventDefault(); const msg = 'The import helper stopped unexpectedly' + (ev.message ? ': ' + ev.message : ' (the phone may have run out of memory)') + '.'; worker = null; try { w.terminate(); } catch (x) { } workerDone && workerDone.reject(new Error(msg)); };
      resolve(w);
    };
    w.onerror = (ev) => { ev.preventDefault && ev.preventDefault(); clearTimeout(timer); try { w.terminate(); } catch (x) { } reject(new Error('the background helper could not be loaded' + (ev.message ? ' (' + ev.message + ')' : ''))); };
  });
}
function loadInlineHelper() {
  return new Promise((resolve, reject) => {
    if (self.LCAInlineWorker) return resolve();
    const sc = document.createElement('script'); sc.src = 'worker.js?v=' + APP_VERSION;
    sc.onload = () => self.LCAInlineWorker ? resolve() : reject(new Error('helper code missing')); sc.onerror = () => reject(new Error('could not load worker.js'));
    document.head.append(sc);
  });
}
async function getWorker() {
  if (worker) return worker;
  if (workerStarting) return workerStarting;
  workerStarting = (async () => {
    try { worker = await startRealWorker(); workerMode = 'worker'; }
    catch (err) {
      console.warn('worker failed, using in-page helper', err);
      setProgress('Starting the import helper', 0, 1, `Note: ${err.message}. Importing inside the page instead – this works, but the screen may react slowly while it runs.`);
      await loadInlineHelper();
      if (self.LCAInlineWorker.version !== APP_VERSION) throw new Error('This screen and the app files do not match (an update is half-loaded). Please reload the page and try again.');
      worker = self.LCAInlineWorker.create(onWorkerMessage); workerMode = 'inline';
    }
    return worker;
  })();
  try { return await workerStarting; } finally { workerStarting = null; }
}
function stopWorker() { if (worker) { try { worker.terminate(); } catch (e) { } worker = null; } }
function safe(f) { try { return f(); } catch (e) { console.error(e); return null; } }
async function runWorker(msg) {
  const w = await getWorker();
  return new Promise((resolve, reject) => { workerDone = { resolve, reject }; S.lastBeat = Date.now(); w.postMessage(msg); });
}

/* ---------- progress UI ----------
   The last status is remembered, so it is shown again when the Import page is redrawn, and a ticker shows
   that the app is still alive (and for how long nothing new happened) while something runs. */
function setProgress(phase, done, total, note) {
  S.lastProg = { phase, done, total, note, at: Date.now() };
  drawProgress();
}
function drawProgress() {
  const p = $('#prog'), lp = S.lastProg; if (!p || !lp) return;
  showProgBox();
  $('#progPhase').textContent = lp.phase + (lp.total > 1 ? ` (${fmtN(lp.done)} of ${fmtN(lp.total)})` : '');
  const bar = $('#progBar');
  if (S.busy && !(lp.total > 1)) bar.removeAttribute('value'); else { bar.max = lp.total || 1; bar.value = lp.done || 0; }
  $('#progNote').textContent = lp.note || '';
  const quiet = Math.round((Date.now() - Math.max(lp.at, S.lastBeat || 0)) / 1000), el = $('#progTick');
  if (el) el.textContent = S.busy ? `⏳ Working for ${fmtDur((Date.now() - (S.busySince || lp.at)) / 1000)}` + (quiet >= 15 ? ` · no news for ${fmtDur(quiet)}` : '') : '';
  const warn = $('#progWarn');
  if (warn) { const slow = S.busy && quiet >= 90; warn.hidden = !slow; if (slow) warn.textContent = `⚠️ Nothing has happened for ${fmtDur(quiet)}. Big files can take long on a phone, but if this does not change: tap “Stop”, make sure the file is stored on the phone itself (not only in Google Drive), close the app completely and try again.`; }
  const st = $('#statusBtn span'); if (st) st.textContent = S.busy ? 'Working…' : 'Import & status';
  const sb = $('#progStop'); if (sb) sb.hidden = !S.busy;
}
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s'; };
setInterval(() => { if (S.busy) drawProgress(); }, 1000);
function showError(title, msg) {
  S.lastError = { title, msg, at: Date.now() }; drawError();
}
function drawError() {
  const e = $('#progErr'); if (!e) return; const x = S.lastError;
  e.hidden = !x; e.innerHTML = ''; if (x) showProgBox(); else { const c = $('#progCard'); if (c && !S.busy && !S.lastProg) c.hidden = true; }
  if (x) e.append(h('b', null, '❌ ' + x.title), h('div', null, x.msg), h('button', { class: 'btn', style: 'margin-top:6px', onclick: () => { S.lastError = null; drawError(); } }, 'OK'));
}
async function stopImport() {
  if (!S.busy) return;
  if (!confirm('Stop what is running now? Whatever was already saved stays; you can import the same files again later.')) return;
  stopWorker(); S.stopped = true;
  workerDone && workerDone.reject(new Error('Stopped by you.'));
}
/* Anything that goes wrong anywhere must be visible – never fail silently. */
function errorBanner(msg) {
  let b = $('#errBanner');
  if (!b) { b = h('div', { id: 'errBanner', class: 'errbanner', role: 'alert' }); document.body.append(b); }
  b.innerHTML = ''; b.append(h('div', { class: 'grow' }, '❌ Something went wrong: ' + msg), h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload'), h('button', { class: 'btn', onclick: () => b.remove() }, '✕'));
}
window.addEventListener('error', (e) => { if (e.message && !/ResizeObserver/.test(e.message)) errorBanner(e.message); });
window.addEventListener('unhandledrejection', (e) => { const m = e.reason && (e.reason.message || String(e.reason)); if (m) errorBanner(m); });

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
  // everything below writes only into the profile that was selected when the import started (switching is locked meanwhile)
  const P = S.profile, L = LCA.at(P.db);
  S.busy = true; S.busySince = Date.now(); S.stopped = false; S.lastError = null; drawError(); $('#statusBtn')?.classList.add('attn'); drawProfileBtn();
  setProgress('Starting import', 0, 1, `${files.length} file(s) selected: ` + files.map(f => `${f.name} (${fmtBytes(f.size)})`).join(', '));
  const log = []; let backupFile = null, foundName = null, failed = false;
  try {
    // never wait forever for the browser's storage answers
    await Promise.race([askPersist(), new Promise(r => setTimeout(r, 3000))]);
    const isAsset = (f) => /_files\//.test(f.webkitRelativePath || '');
    // decide by the file's content, not by its name or type (Android pickers often give no type or a generic one)
    const kinds = new Map();
    for (let k = 0; k < files.length; k++) kinds.set(files[k], await sniffFile(files[k], k + 1, files.length));
    const zips = files.filter(f => kinds.get(f) === 'zip');
    const htmls = files.filter(f => kinds.get(f) === 'html' && !isAsset(f));
    const others = files.filter(f => !zips.includes(f) && !htmls.includes(f));
    for (const f of others) if (kinds.get(f) === 'empty') log.push(`⚠️ ${f.name} is empty (0 bytes) – nothing to import. Download it again.`);
    if (!(await Promise.race([checkSpace(zips.reduce((a, f) => a + f.size, 0)), new Promise(r => setTimeout(() => r(true), 5000))]))) throw new Error('Import cancelled');
    if (zips.length) {
      // make sure every ZIP can actually be read quickly; slow phone/Drive files are copied into the app first
      const ready = [];
      for (let k = 0; k < zips.length; k++) ready.push(await readableZip(zips[k], k + 1, zips.length));
      setProgress('Starting the import helper', 0, 1);
      const r = await runWorker({ type: 'importZips', files: ready, db: P.db });
      if (r && r.backup) { backupFile = zips[0]; log.push('That file is a Liz Coobys Archive backup – see the restore options.'); }
      else if (r && r.cancelled) log.push(`Import stopped before anything was saved (export belongs to “${r.profileName}”).`);
      else if (r && r.ok === false) { failed = true; throw new Error((r.openErrors || []).join('\n') || 'No files could be read from the ZIP.'); }
      else { log.push(`Facebook export imported into “${P.name}”: ${zips.map(z => z.name).join(', ')}`); foundName = r && r.profileName; }
      if (r && r.openErrors && r.openErrors.length && r.ok) { log.push('⚠️ ' + r.openErrors.join(' · ')); showError('Some files could not be opened', r.openErrors.join('\n')); }
    }
    for (const f of htmls) {
      setProgress('Reading ' + f.name, 0, 1);
      const txt = await f.text();
      const res = Parsers.parseSaved(txt, f.name);
      if (!res.kind) { await noteIgnored(L, [{ path: f.name, size: f.size, reason: 'HTML file not recognised as a saved friends / groups / pages page' }]); log.push(`${f.name}: not recognised`); continue; }
      const n = await storeSaved(L, res, f.name);
      log.push(`${f.name}: ${n} ${res.kind} read`);
      setProgress('Saving pictures', 0, 1);
      const av = await cacheAvatars(res.items.map(i => i.image), res.kind, L);
      const rep = await L.getMeta('report', null) || {}; rep.saved = rep.saved || {}; rep.saved[res.kind].avatars = av; await L.setMeta('report', rep);
      log.push(`${av.ok} of ${av.total} pictures saved offline` + (av.fail ? ` (${av.fail} could not be downloaded – these show initials)` : ''));
    }
    if (others.length) {
      await noteIgnored(L, others.map(f => ({ path: f.webkitRelativePath || f.name, size: f.size, reason: isAsset(f) || /\.(js|css|download)$/i.test(f.name) ? 'saved-web-page asset (scripts/styles – no archive data)' : 'unsupported file type' })));
      log.push(`${others.length} other file(s) listed in the report (no archive data in them)`);
    }
    S.xcache.clear(); await loadState(true);
    if (!zips.length && !htmls.length) { failed = true; throw new Error('None of the selected files is a Facebook export (.zip) or a saved friends / Groups / pages page (.html).' + (log.length ? '\n' + log.join('\n') : '')); }
    setProgress('Done', 1, 1, log.join(' · '));
    toast(backupFile ? 'Backup file found' : 'Import finished');
    if (foundName && normName(foundName) !== normName(P.name)) toast(`This export belongs to “${foundName}” – you can rename the profile below`, 5000);
  } catch (e) {
    console.error(e); failed = true;
    const msg = (e && e.message || String(e)) + (/quota|space|full/i.test(e && e.message || '') ? '\n\nThe device seems to be out of storage space.' : '');
    setProgress('Import stopped', 0, 1, msg); showError(S.stopped ? 'Import stopped' : 'Import problem', msg);
    if (!S.stopped) alert('Import problem: ' + msg);
  } finally {
    S.busy = false; S.stopped = false; $('#statusBtn')?.classList.remove('attn'); drawProfileBtn();
    if (S.updateWaiting) toast('A new version of the app is ready – reload the page when convenient', 8000);
    try { await loadState(true); } catch (e) { console.error(e); }
    if (location.hash.startsWith('#/import')) { await render(); drawProgress(); drawError(); }
    else toast(failed ? 'Import problem – see Import & status' : 'Import finished', 5000);
  }
  if (backupFile) await restoreFlow(backupFile);
}
/* What is this file? Looks at the first bytes. Shows a ticking status while the phone hands the file over. */
async function withTicker(promise, phase, note) {
  const t0 = Date.now(); let n = 0;
  const iv = setInterval(() => { n = (Date.now() - t0) / 1000; setProgress(phase, 0, 1, note(n)); }, 1000);
  try { return await promise; } finally { clearInterval(iv); }
}
const driveHint = 'If the file is in Google Drive, the phone may be downloading it first – that can take several minutes for a big file. If nothing changes, download it to the phone (Drive → ⋮ → Download) and choose it from “Downloads”.';
async function readSlice(f, a, b) {
  try { return new Uint8Array(await f.slice(a, b).arrayBuffer()); }
  catch (e) { throw new Error(`The phone could not read “${f.name}” (${e.name || 'error'}: ${e.message}). ${driveHint}`); }
}
async function sniffFile(f, k, n) {
  if (!f.size) return 'empty';
  const head = await withTicker(readSlice(f, 0, 512), `Checking file ${k} of ${n}: ${f.name}`, (s) => s < 3 ? '' : `Waiting for the phone to hand over the file… ${fmtDur(s)}. ` + (s >= 8 ? driveHint : ''));
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5 || head[2] === 7)) return 'zip';
  const txt = new TextDecoder('utf-8', { fatal: false }).decode(head).replace(/^\ufeff/, '').trimStart().toLowerCase();
  if (/\.html?$/i.test(f.name) || /^(<!doctype html|<html|<!-- saved from|<head|<meta)/.test(txt)) return 'html';
  if (/\.zip$/i.test(f.name)) throw new Error(`“${f.name}” is called .zip but is not a ZIP file (it may be damaged or only partly downloaded). Download it again.`);
  return 'other';
}
/* zip.js reads a ZIP by jumping around in the file. Normal phone files allow that. Some Android sources (e.g. a file
   picked straight from Google Drive) deliver the bytes only slowly or in order; reading such a file at random places can
   look like a freeze. So: test-read the end and the middle; if that is not fast, copy the file into the app once,
   in pieces, with a visible MB counter, and import from the copy. */
async function readableZip(f, k, n) {
  const label = n > 1 ? `Opening file ${k} of ${n}: ${f.name}` : `Opening ${f.name}`;
  const probe = (async () => { const t = Date.now(); await readSlice(f, Math.max(0, f.size - 65536), f.size); await readSlice(f, Math.floor(f.size / 2), Math.floor(f.size / 2) + 65536); return Date.now() - t; })();
  probe.catch(() => {});
  const fast = await withTicker(Promise.race([probe, new Promise(r => setTimeout(() => r(null), 4000))]), label, (s) => `Checking that the file can be read… ${fmtDur(s)}`);
  if (fast != null && fast < 2500) return f;
  setProgress(label, 0, f.size, 'This file is delivered slowly by the phone, so it is copied into the app first.');
  const CH = 4 * 1048576, parts = []; let pos = 0; const t0 = Date.now();
  while (pos < f.size) {
    if (S.stopped) throw new Error('Stopped by you.');
    const end = Math.min(f.size, pos + CH);
    parts.push(await withTicker(readSlice(f, pos, end), label, () => `Copying the file into the app: ${fmtBytes(pos)} of ${fmtBytes(f.size)} – waiting for the phone… ${driveHint}`));
    pos = end;
    const secs = (Date.now() - t0) / 1000, rate = pos / Math.max(secs, 0.1);
    setProgress(label, pos, f.size, `Copying the file into the app: ${fmtBytes(pos)} of ${fmtBytes(f.size)}` + (secs > 3 ? ` · about ${fmtDur((f.size - pos) / rate)} left` : ''));
  }
  try { return new File(parts, f.name, { type: 'application/zip' }); }
  catch (e) { return new Blob(parts, { type: 'application/zip' }); }
}
async function noteIgnored(L, list) {
  const rep = await L.getMeta('report', null) || {}; rep.ignoredUploads = (rep.ignoredUploads || []).concat(list).slice(-5000);
  await L.setMeta('report', rep);
}
async function storeSaved(L, res, fileName) {
  const store = res.kind;
  const old = (await L.getAll(store)).filter(r => r.source === 'page');
  for (const o of old) await L.del(store, o.id);
  const recs = res.items.map((x, i) => Object.assign({}, x, { id: 'page:' + x.key, source: 'page', file: fileName, order: i }));
  await L.putMany(store, recs);
  const rep = await L.getMeta('report', null) || {};
  rep.saved = rep.saved || {}; rep.saved[store] = { file: fileName, savedFrom: res.savedFrom, statedTotal: res.statedTotal, items: recs.length, importedAt: Date.now() };
  await L.setMeta('report', rep);
  return recs.length;
}

/* ---------- router ---------- */
window.addEventListener('hashchange', render);
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#q').value.trim(); if (q) location.hash = '#/search/' + encodeURIComponent(q); $('#q').blur(); });
async function render() {
  if (!S.profile) return; // still starting up
  revokeAll();
  const parts = (location.hash || '#/messenger').slice(2).split('/');
  const tab = parts[0] || 'messenger';
  // #/go/<profileId>/<rest>: open something that belongs to another profile (from "all profiles" search)
  if (tab === 'go') {
    const rest = '#/' + parts.slice(2).join('/');
    if (parts[1] && parts[1] !== S.profile.id && S.profiles.some(p => p.id === parts[1])) { if (!(await switchProfile(parts[1], rest, true))) history.back(); }
    else location.replace(rest);
    return;
  }
  document.body.classList.toggle('chat', tab === 'thread');
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.tab === tab || (tab === 'thread' && a.dataset.tab === 'messenger'));
  if (tab === 'import') { view.innerHTML = ''; view.append(h('h2', null, 'Import & status'), statusBox()); drawProgress(); drawError(); }
  await loadState();
  if (tab !== 'import') view.innerHTML = '';
  else for (const el of [...view.children].slice(2)) el.remove();
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
  return h('div', { class: 'card empty' }, h('div', { style: 'font-size:42px' }, S.profile?.icon || '🐾'), h('p', null, `No ${what} imported yet in the profile “${S.profile?.name || ''}”.`),
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
    S.profiles.length > 1 ? h('div', null, 'Profile: ', (S.profile.icon || '👤') + ' ' + S.profile.name) : null,
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
function friendItem(r, L, badge) {
  const m = r._match;
  return h('li', { class: 'item' }, avatar(r.name, r.image, false, L),
    h('div', { class: 'grow' },
      h('div', { class: 't1' }, r.name || '(no name)'),
      linkEl(r.url) || h('div', { class: 't2' }, 'No profile link available'),
      h('div', null,
        idLine(r) ? h('span', { class: 'badge' }, idLine(r)) : null,
        r.source === 'export' ? h('span', { class: 'badge p' }, (r.category === 'friend' ? 'From export' : r.category.replace(/_/g, ' ')) + (r.ts ? ' · ' + fmtDate(r.ts) : '')) : null,
        m && r.source === 'page' ? h('span', { class: 'badge ok' }, '✓ In export' + (m.ts ? ' · friends since ' + fmtDate(m.ts) : '')) : null,
        r._ambig ? h('span', { class: 'badge warn' }, `Name shared (${r._ambig.page} on page / ${r._ambig.exp} in export) – not merged`) : null,
        r.otherNames && r.otherNames.length ? h('span', { class: 'badge' }, 'also shown as ' + r.otherNames.join(', ')) : null),
      r.detail ? h('div', { class: 'mut small' }, r.detail) : null, badge || null));
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
/* Everything search needs from one profile. The current profile uses the loaded state; other profiles are read from their own database. */
async function searchCtx(p) {
  if (p.id === S.profile.id) { await ensureSearchIdx(); return { p, L: LCA, threads: S.threads, threadMap: S.threadMap, owner: S.owner, idx: S.searchIdx, cur: true }; }
  if (S.xcache.has(p.id)) return S.xcache.get(p.id);
  const L = LCA.at(p.db);
  const threads = await L.getAll('threads'); const rows = await L.getAll('search');
  const c = { p, L, threads, threadMap: new Map(threads.map(t => [t.id, t])), owner: await L.getMeta('owner', null), idx: new Map(rows.map(r => [r.threadId, r])), cur: false };
  S.xcache.set(p.id, c); return c;
}
const profBadge = (p) => h('span', { class: 'badge prof', title: 'Profile' }, (p.icon || '👤') + ' ' + p.name);
async function renderSearch(qfull) {
  const qi = qfull.lastIndexOf('?t='); const q = (qi >= 0 ? qfull.slice(0, qi) : qfull).trim(); const onlyThread = qi >= 0 ? decodeURIComponent(qfull.slice(qi + 3)) : null;
  $('#q').value = q;
  view.append(h('h2', null, `Search: “${q}”`));
  const multi = S.profiles.length > 1 && !onlyThread;
  const all = multi && S.searchScope === 'all';
  if (multi) view.append(h('div', { class: 'scope' }, chips([['this', `${S.profile.icon || '👤'} This profile only`], ['all', `All profiles (${S.profiles.length})`]], all ? 'all' : 'this', async (v) => { S.searchScope = v; await PR.setSetting('searchScope', v); render(); })));
  if (!q) return;
  const ql = q.toLowerCase(), qn = normName(q);
  const t0 = performance.now();
  const ctxs = [];
  for (const p of (all ? S.profiles : [S.profile])) { try { ctxs.push(await searchCtx(p)); } catch (e) { view.append(h('div', { class: 'note' }, `Could not search the profile “${p.name}”: ${e.message}`)); } }
  const hits = []; let total = 0, scanned = 0;
  for (const c of ctxs) for (const [tid, s] of c.idx) {
    if (onlyThread && tid !== onlyThread) continue;
    scanned += s.texts.length;
    for (let i = 0; i < s.texts.length; i++) if (s.texts[i].includes(ql)) { total++; hits.push([c, tid, s.ords[i]]); }
  }
  // links into another profile switch to it first
  const href = (c, path) => c.cur ? '#/' + path : '#/go/' + encodeURIComponent(c.p.id) + '/' + path;
  const pb = (c) => all ? profBadge(c.p) : null;
  const fm = (arr) => arr.filter(r => normName((r.name || '') + ' ' + (r.username || '') + ' ' + (r.fbId || '') + ' ' + (r.title || '')).includes(qn));
  if (onlyThread) view.append(h('div', { class: 'mut small' }, 'In conversation: ', h('a', { href: '#/thread/' + encodeURIComponent(onlyThread) }, S.threadMap.get(onlyThread)?.title || '')));
  const convs = onlyThread ? [] : ctxs.flatMap(c => c.threads.filter(t => normName(t.title + ' ' + t.participants.join(' ')).includes(qn)).map(t => [c, t])).slice(0, 80);
  if (convs.length) view.append(h('h3', null, `Conversations (${convs.length})`), h('ul', { class: 'list card', style: 'padding:0 8px' }, convs.map(([c, t]) => h('li', null, h('a', { class: 'item', href: href(c, 'thread/' + encodeURIComponent(t.id)) }, avatar(t.title), h('div', { class: 'grow' }, h('div', { class: 't1' }, t.title), h('div', { class: 't2' }, `${fmtN(t.msgCount)} messages · ${catLabel(t.category)}`), pb(c)))))));
  const msgBox = h('ul', { class: 'list card', style: 'padding:0 8px' });
  const LIMIT = 300;
  view.append(h('h3', null, `Messages (${fmtN(total)}${total > LIMIT ? ', showing ' + LIMIT + ' newest' : ''})`), msgBox);
  hits.sort((a, b) => ((b[0].threadMap.get(b[1])?.lastTs || 0) - (a[0].threadMap.get(a[1])?.lastTs || 0)) || b[2] - a[2]);
  const msgs = (await Promise.all(hits.slice(0, 1500).map(async ([c, tid, ord]) => { const m = await c.L.get('messages', tid + '#' + String(ord).padStart(7, '0')); return m ? [c, m] : null; }))).filter(Boolean).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).slice(0, LIMIT);
  for (const [c, m] of msgs) {
    const t = c.threadMap.get(m.threadId);
    const txt = [m.text, m.share?.text, m.share?.link, ...(m.att || []).map(a => a.name)].filter(Boolean).join(' ');
    const i = Math.max(0, txt.toLowerCase().indexOf(ql)); const st = Math.max(0, i - 50);
    const snip = (st > 0 ? '…' : '') + esc(txt.slice(st, i)) + '<mark class="hl">' + esc(txt.slice(i, i + q.length)) + '</mark>' + esc(txt.slice(i + q.length, i + q.length + 90)) + (i + q.length + 90 < txt.length ? '…' : '');
    const me = !!c.owner && m.sender === c.owner;
    msgBox.append(h('li', null, h('a', { class: 'item', href: href(c, 'thread/' + encodeURIComponent(m.threadId) + '/' + m.ord) }, h('div', { class: 'grow' },
      h('div', { class: 't1' }, (t?.title || '') + ' · ' + (me ? 'You' : (m.sender || ''))), h('div', { class: 'snip', html: snip }), pb(c)), h('div', { class: 'when' }, fmtDate(m.ts)))));
  }
  if (!msgs.length) msgBox.append(h('li', { class: 'empty' }, ctxs.some(c => c.idx.size) ? 'No messages contain that text.' : 'No conversations imported yet.'));
  if (!onlyThread) {
    const lists = await Promise.all(ctxs.map(async c => [c, ...(await Promise.all(['friends', 'groups', 'pages'].map(s => c.L.getAll(s))))]));
    const sect = (label, k, kind) => {
      const f = lists.flatMap(row => fm(row[k]).map(r => [row[0], r])); if (!f.length) return;
      view.append(h('h3', null, `${label} (${f.length})`), h('ul', { class: 'list card', style: 'padding:0 8px' }, f.slice(0, 150).map(([c, r]) => kind === 'friends' ? friendItem(r, c.L, pb(c)) : h('li', { class: 'item' }, avatar(r.name, r.image, kind === 'groups', c.L), h('div', { class: 'grow' }, h('div', { class: 't1' }, r.name || r.title), linkEl(r.url) || h('div', { class: 't2' }, r.source === 'export' ? 'From export' : ''), pb(c))))));
    };
    sect('Friends', 1, 'friends'); sect('Groups', 2, 'groups'); sect('Pages', 3, 'pages');
  }
  view.append(h('div', { class: 'mut small', style: 'margin-top:10px' }, `Searched ${fmtN(scanned)} messages${all ? ` in ${ctxs.length} profiles` : ` in “${S.profile.name}”`} in ${Math.round(performance.now() - t0)} ms.`));
}

/* ---------- Import & status ---------- */
/* The status box is drawn first and without waiting for the database, so it is visible at once even while an import keeps the database busy. */
function statusBox() {
  return h('div', { id: 'progCard', class: 'card', hidden: !S.busy && !S.lastProg && !S.lastError },
    h('div', { id: 'prog', hidden: !S.busy && !S.lastProg }, h('div', { id: 'progPhase', class: 'small' }, 'Working…'), h('progress', { id: 'progBar', max: 1, value: 0 }), h('div', { id: 'progNote', class: 'mut small' }),
      h('div', { id: 'progTick', class: 'mut small' }), h('div', { id: 'progWarn', class: 'note', hidden: true }),
      h('button', { id: 'progStop', class: 'btn danger', style: 'margin-top:6px', hidden: !S.busy, onclick: stopImport }, '■ Stop')),
    h('div', { id: 'progErr', class: 'errbox', hidden: true }));
}
function showProgBox() { const c = $('#progCard'), p = $('#prog'); if (c) c.hidden = false; if (p) p.hidden = false; }
async function renderImport() {
  const st = await storageInfo();
  const fileInput = (accept, multiple, dir) => { const i = h('input', { type: 'file', accept: accept || null, multiple, hidden: true }); if (dir) i.setAttribute('webkitdirectory', ''); i.addEventListener('change', () => { importFiles(i.files); }); return i; };
  const any = fileInput('', true), zipI = fileInput('.zip,application/zip', true), htmlI = fileInput('.html,.htm,text/html', true), dirI = fileInput('', true, true);
  const restI = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  restI.addEventListener('change', () => { const f = restI.files[0]; restI.value = ''; if (f) restoreFlow(f); });
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const P = S.profile, stats = await profileStats(LCA);
  view.append(installCard() || '',
    (await nameSuggestionCard()) || "",
    h('div', { class: 'card' },
      h('div', { class: 'into' }, h('span', { class: 'pic' }, P.icon || '👤'), h('div', { class: 'grow' }, h('div', { class: 'small mut' }, 'Everything you import now goes into the profile'), h('b', null, P.name)),
        h('button', { class: 'btn', disabled: S.busy, onclick: () => openProfileSheet() }, S.profiles.length > 1 ? 'Switch' : 'Add profile')),
      h('p', null, '🔒 Your files are read and stored only on this device. Nothing is uploaded, and no Facebook login is needed.'),
      ios && !standalone ? h('div', { class: 'note' }, '📱 On iPhone: first add this app to your Home Screen (Share ⬆️ → “Add to Home Screen”), open it from there, and import inside the app. Safari and the Home Screen app keep separate storage.') : null,
      h('button', { class: 'btn big primary', onclick: () => any.click() }, '📂 Choose files to import'),
      h('div', { class: 'mut small' }, 'Pick the profile’s Facebook export (.zip) and/or its saved friends.html, Groups.html and pages.html — one at a time or several together. No need to unzip or rename anything. Re-importing a file replaces what came from it before (in this profile only). Each Facebook profile has its own export: switch profile at the top before importing the next one.'),
      h('details', null, h('summary', null, 'More import options'),
        h('button', { class: 'btn big', onclick: () => zipI.click() }, '🗜️ Facebook export (.zip, several parts allowed)'),
        h('button', { class: 'btn big', onclick: () => htmlI.click() }, '🌐 Saved Facebook pages (friends / Groups / pages .html)'),
        h('button', { class: 'btn big', onclick: () => dirI.click() }, '📁 A whole folder, e.g. “Liz Coobys” (computer)'),
        h('div', { class: 'mut small' }, 'The “…_files” folders saved next to the .html pages only contain Facebook’s scripts and styles (no names or pictures), so they are optional. If you add them they are listed in the report.')),
      any, zipI, htmlI, dirI, restI),
    await reportView(),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '💾 Storage'),
      h('div', null, h('b', null, `${P.icon || '👤'} ${P.name}: `), statsLine(stats)),
      h('div', null, `Whole app on this device (all ${S.profiles.length} profile${S.profiles.length === 1 ? '' : 's'}): ${fmtBytes(st.usage)} used${st.quota ? ' · available to this app: ' + fmtBytes(st.quota) : ''}.`),
      h('div', null, st.persisted ? '✅ Storage is persistent – the browser will not clear it on its own.' : '⚠️ Storage is not marked persistent yet. ', !st.persisted ? h('button', { class: 'btn', onclick: async () => { const ok = await askPersist(); toast(ok ? 'Storage is now persistent' : 'The browser declined – installing the app to the home screen helps'); render(); } }, 'Make persistent') : null),
      st.quota && st.usage / st.quota > 0.85 ? h('div', { class: 'note' }, '⚠️ Storage is almost full. Make a backup and free up space on the device.') : null),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '🧳 Backup & move to another device'),
      h('p', { class: 'small mut', style: 'margin-top:0' }, 'Creates one .zip file with every conversation, photo, video, friend, group and page – either of this profile only, or of all profiles together. Keep it somewhere safe (computer, USB stick, your own cloud). On another device, open this app and tap “Restore backup” (or simply import the backup file). Backups made with the earlier one-profile version can be restored too.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => doBackup(false) }, `⤓ Back up “${P.name}”`),
        S.profiles.length > 1 ? h('button', { class: 'btn primary', onclick: () => doBackup(true) }, `⤓ Back up all ${S.profiles.length} profiles`) : null,
        h('button', { class: 'btn', onclick: () => restI.click() }, '⤒ Restore backup'))),
    (await ownerCard()) || "",
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'About'), h('div', { class: 'small mut' }, 'Liz Coobys Archive works offline after the first visit. It shows only what is actually in your imported files; nothing is invented or reconstructed. Profile links open Facebook and will only work while those profiles exist.'),
      h('button', { class: 'btn danger', style: 'margin-top:8px', onclick: eraseAll }, `Erase the data of “${P.name}”`), h('div', { class: 'small mut' }, 'Only this profile is erased. To remove a profile completely, use the profile menu at the top.')));
}
async function ownerCard() {
  const names = new Map(); for (const t of S.threads) for (const p of t.participants) names.set(p, (names.get(p) || 0) + 1);
  if (!names.size) return null;
  const sel = h('select', { style: 'padding:8px;border-radius:10px;border:1px solid var(--line);background:var(--card);max-width:100%' }, h('option', { value: '' }, '(not set)'), [...names].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([n, c]) => h('option', { value: n, selected: n === S.owner }, `${n} (${c} chats)`)));
  sel.addEventListener('change', async () => { await LCA.setMeta('owner', sel.value || null); S.owner = sel.value || null; toast('Saved'); });
  return h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '🙋 Which name is you?'), h('div', { class: 'small mut' }, 'Your own messages are shown on the right in blue.'), sel);
}
async function doBackup(all) {
  if (S.busy) return toast('Please wait – something is still running'); S.busy = true; drawProfileBtn(); showProgBox();
  const list = (all ? S.profiles : [S.profile]).map(p => ({ id: p.id, name: p.name, icon: p.icon || null, db: p.db }));
  try {
    const r = await runWorker({ type: 'backup', profiles: list, all: !!all }); const d = new Date().toISOString().slice(0, 10);
    saveBlob(r.blob, all ? `liz-coobys-archive-backup-all-profiles-${d}.zip` : `liz-coobys-archive-backup-${fileSafe(list[0].name)}-${d}.zip`);
    for (const p of list) await LCA.at(p.db).setMeta('lastBackup', Date.now());
    setProgress('Backup ready – ' + fmtBytes(r.blob.size) + (all ? ` (${list.length} profiles)` : ` (${list[0].name})`), 1, 1);
  }
  catch (e) { alert('Backup failed: ' + e.message); } finally { S.busy = false; drawProfileBtn(); }
}
const fileSafe = (n) => (n || 'profile').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40);
async function eraseAll() {
  if (!confirm(`Erase all archived data of the profile “${S.profile.name}” from this device? Other profiles are not touched. Make a backup first if you want to keep it.`)) return;
  if (!confirm(`Really erase everything in “${S.profile.name}”?`)) return;
  await LCA.clear(LCA.STORES); await LCA.setMeta('profileName', S.profile.name); avCache.clear(); S.xcache.clear(); await loadState(true); toast('Erased'); render();
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
/* ---------- profiles ----------
   The list of profiles lives in its own small database. Each profile's data lives in a separate database,
   so nothing can mix. The first version's database becomes the profile "Liz Coobys", untouched. */
const PR = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('lizcoobys-profiles', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('profiles', { keyPath: 'id' }); d.createObjectStore('settings', { keyPath: 'key' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const tx = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out && 'result' in out ? out.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); }); };
  return {
    all: async () => ((await tx('profiles', 'readonly', s => s.getAll())) || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt),
    put: (p) => tx('profiles', 'readwrite', s => { s.put(p); }),
    del: (id) => tx('profiles', 'readwrite', s => { s.delete(id); }),
    getSetting: async (k, def) => { const r = await tx('settings', 'readonly', s => s.get(k)); return r ? r.value : def; },
    setSetting: (k, v) => tx('settings', 'readwrite', s => { s.put({ key: k, value: v }); })
  };
})();
const ICONS = ['👤', '🐱', '🐶', '🐾', '🐴', '🌸', '⭐', '💜', '🏡', '💼'];
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function initProfiles() {
  let list = await PR.all();
  if (!list.length) {
    // first start of this version (or a fresh install): keep the existing archive as the default profile
    const L = LCA.at(LCA.LEGACY_DB);
    const had = (await L.count('threads')) + (await L.count('friends')) + (await L.count('groups')) + (await L.count('pages')) + (await L.count('media'));
    const d = { id: 'p-default', name: (await L.getMeta('profileName', null)) || 'Liz Coobys', icon: (await L.getMeta('profileIcon', null)) || '🐱', db: LCA.LEGACY_DB, createdAt: Date.now(), order: 0 };
    if (had) d.migratedFromV1 = Date.now();
    await PR.put(d); await L.setMeta('profileName', d.name); await L.setMeta('profileIcon', d.icon);
    // if the profile list was lost but other profile databases are still there, list them again instead of hiding them
    if (indexedDB.databases) {
      try {
        let order = 1;
        for (const x of await indexedDB.databases()) if (x.name && x.name.startsWith(LCA.PROFILE_DB_PREFIX)) {
          const R = LCA.at(x.name);
          await PR.put({ id: x.name.slice(LCA.PROFILE_DB_PREFIX.length), name: (await R.getMeta('profileName', null)) || 'Recovered profile', icon: (await R.getMeta('profileIcon', null)) || '👤', db: x.name, createdAt: Date.now(), order: order++ });
        }
      } catch (e) { console.warn(e); }
    }
    list = await PR.all();
  }
  const cur = await PR.getSetting('current', null);
  S.searchScope = await PR.getSetting('searchScope', 'this');
  const p = list.find(x => x.id === cur) || list[0];
  LCA.use(p.db); S.profiles = list; S.profile = p;
}
function resetProfileView() {
  revokeAll(); for (const u of avCache.values()) if (u.startsWith('blob:')) URL.revokeObjectURL(u); avCache.clear();
  S.threads = null; S.threadMap = null; S.searchIdx = null; S.report = null; S.owner = null;
  msgrFilter = { cat: 'all', q: '' }; galF = { thread: '', kind: 'visual', from: '', to: '' }; frF = { tab: 'all', q: '' }; grF = { tab: 'all', q: '' }; pgF = { tab: 'page', q: '' };
}
async function switchProfile(id, hashAfter, replace) {
  if (S.busy) { toast('Please wait until the import / backup has finished'); return false; }
  const p = S.profiles.find(x => x.id === id); if (!p) return false;
  if (p.id !== S.profile.id) {
    S.profile = p; LCA.use(p.db); await PR.setSetting('current', p.id); resetProfileView(); await loadState(true); drawProfileBtn();
    toast(`${p.icon || '👤'} ${p.name}`, 1500);
  }
  let target = hashAfter;
  if (!target) { const tab = (location.hash || '#/messenger').slice(2).split('/')[0]; target = ['thread', 'search', 'go'].includes(tab) ? '#/messenger' : (location.hash || '#/messenger'); }
  if (location.hash === target) render(); else if (replace) location.replace(target); else location.hash = target;
  return true;
}
function drawProfileBtn() {
  const b = $('#profBtn'); if (!b || !S.profile) return;
  b.innerHTML = ''; b.append(h('span', { class: 'pic' }, S.profile.icon || '👤'), h('span', { class: 'pname' }, S.profile.name), h('span', { class: 'caret' }, '▾'));
  b.title = 'Profile: ' + S.profile.name + ' – tap to switch'; b.classList.toggle('busy', !!S.busy);
  document.title = S.profile.name + ' · Liz Coobys Archive';
}
async function profileStats(L) {
  const [threads, messages, friends, groups, pages] = await Promise.all(['threads', 'messages', 'friends', 'groups', 'pages'].map(s => L.count(s)));
  let media = 0, mediaBytes = 0; const d = await L.openDB();
  await new Promise((res, rej) => { const c = d.transaction('media').objectStore('media').openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return res(); media++; mediaBytes += cur.value.size || 0; cur.continue(); }; c.onerror = () => rej(c.error); });
  return { threads, messages, friends, groups, pages, media, mediaBytes, lastBackup: await L.getMeta('lastBackup', null), fbName: await L.getMeta('ownerFromProfile', null) };
}
const statsLine = (st) => !st.threads && !st.friends && !st.groups && !st.pages && !st.media ? 'nothing imported yet' :
  `${fmtN(st.threads)} conversations · ${fmtN(st.messages)} messages · ${fmtN(st.media)} media files (${fmtBytes(st.mediaBytes)}) · ${fmtN(st.friends)} people · ${fmtN(st.groups)} groups · ${fmtN(st.pages)} pages`;
/* bottom sheet */
const fill = (box, ...kids) => box.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
function sheet(build, onClose) {
  const bg = h('div', { class: 'sheet-bg' }); const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc_); if (onClose) onClose(); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); }); document.addEventListener('keydown', esc_);
  bg.append(box); document.body.append(bg); build(box, close); return close;
}
function choose(title, text, options) {
  return new Promise((resolve) => {
    sheet((box, close) => {
      fill(box, h('h3', { style: 'margin-top:0' }, title), text ? h('p', { class: 'small', style: 'white-space:pre-line' }, text) : null,
        options.map(([v, label, cls]) => h('button', { class: 'btn big ' + (cls || ''), onclick: () => { resolve(v); close(); } }, label)),
        h('button', { class: 'btn big', onclick: () => close() }, 'Cancel'));
    }, () => resolve(null));
  });
}
async function openProfileSheet() {
  if (S.busy) return toast('Please wait until the import / backup has finished');
  const stats = new Map(await Promise.all(S.profiles.map(async p => [p.id, await profileStats(LCA.at(p.db)).catch(() => null)])));
  sheet((box, close) => {
    fill(box, h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', { style: 'margin:0' }, 'Profiles'), h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: close }, '✕')),
      h('p', { class: 'small mut', style: 'margin:4px 0 8px' }, 'Each profile keeps its own conversations, photos, friends, groups, pages, report and backup. Imports always go into the profile that is selected.'),
      h('ul', { class: 'list profs' }, S.profiles.map(p => {
        const st = stats.get(p.id), on = p.id === S.profile.id;
        return h('li', { class: 'prow' + (on ? ' on' : '') },
          h('button', { class: 'pick', 'data-profile': p.id, onclick: async () => { close(); await switchProfile(p.id); } },
            h('span', { class: 'pic big' }, p.icon || '👤'),
            h('span', { class: 'grow' }, h('span', { class: 't1' }, p.name, on ? h('span', { class: 'badge ok', style: 'margin-left:6px' }, '✓ selected') : null),
              h('span', { class: 't2' }, st ? statsLine(st) : 'could not be read'),
              st && st.fbName && normName(st.fbName) !== normName(p.name) ? h('span', { class: 't2' }, `Facebook name in export: ${st.fbName}`) : null)),
          h('button', { class: 'iconbtn', 'aria-label': 'Edit profile ' + p.name, title: 'Rename / delete', onclick: () => { close(); profileForm(p); } }, '✏️'));
      })),
      h('button', { class: 'btn big primary', onclick: () => { close(); profileForm(null); } }, '＋ Add a profile'));
  });
}
function profileForm(p) {
  const editing = !!p; let icon = p ? (p.icon || '👤') : '👤';
  sheet((box, close) => {
    const name = h('input', { type: 'text', value: p ? p.name : '', placeholder: 'e.g. Lizette (private) or the dog’s name', maxlength: 60, style: inputStyle, 'aria-label': 'Profile name' });
    const icons = h('div', { class: 'chips', style: 'flex-wrap:wrap' });
    const drawIcons = () => { icons.innerHTML = ''; ICONS.forEach(ic => icons.append(h('button', { class: 'chip' + (ic === icon ? ' on' : ''), 'aria-label': 'Icon ' + ic, onclick: () => { icon = ic; drawIcons(); } }, ic))); };
    drawIcons();
    const save = async () => {
      const n = name.value.trim(); if (!n) { name.focus(); return toast('Please type a name'); }
      if (S.profiles.some(x => x.id !== p?.id && normName(x.name) === normName(n))) return toast('Another profile already has that name');
      if (editing) { await renameProfile(p, n, icon); close(); toast('Saved'); render(); }
      else { const np = await createProfile(n, icon); close(); await switchProfile(np.id, '#/import'); toast(`Profile “${n}” created – now import its Facebook files`, 3500); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    fill(box, h('h3', { style: 'margin-top:0' }, editing ? 'Edit profile' : 'New profile'),
      h('label', { class: 'small mut' }, 'Name'), name, h('div', { class: 'small mut' }, 'Icon'), icons,
      !editing ? h('p', { class: 'small mut' }, 'After creating it you can import that profile’s Facebook export. If the export contains the profile’s name, the app offers it as the profile name.') : null,
      h('button', { class: 'btn big primary', onclick: save }, editing ? 'Save' : 'Create profile'),
      editing ? h('button', { class: 'btn big danger', disabled: S.profiles.length < 2, onclick: () => { close(); deleteProfile(p); } }, S.profiles.length < 2 ? 'Delete profile (not possible – it is the only one)' : `🗑 Delete profile “${p.name}”…`) : null,
      h('button', { class: 'btn big', onclick: close }, 'Cancel'));
    setTimeout(() => name.focus(), 50);
  });
}
async function createProfile(name, icon, id) {
  id = id || newId();
  const p = { id, name, icon: icon || '👤', db: LCA.PROFILE_DB_PREFIX + id, createdAt: Date.now(), order: Math.max(0, ...S.profiles.map(x => x.order ?? 0)) + 1 };
  const L = LCA.at(p.db); await L.setMeta('profileName', name); await L.setMeta('profileIcon', p.icon);
  await PR.put(p); S.profiles = await PR.all(); return p;
}
async function renameProfile(p, name, icon) {
  const np = Object.assign({}, p, { name, icon: icon || p.icon }); await PR.put(np);
  const L = LCA.at(p.db); await L.setMeta('profileName', name); await L.setMeta('profileIcon', np.icon);
  S.profiles = await PR.all(); if (S.profile.id === p.id) S.profile = S.profiles.find(x => x.id === p.id); S.xcache.clear(); drawProfileBtn();
}
async function deleteProfile(p) {
  if (S.busy) return toast('Please wait until the import / backup has finished');
  if (S.profiles.length < 2) return toast('The last profile cannot be deleted');
  const st = await profileStats(LCA.at(p.db)).catch(() => null);
  const typed = prompt(`Delete the profile “${p.name}” and everything imported into it (${st ? statsLine(st) : 'unknown contents'})?\n\nOther profiles are not touched. This cannot be undone – make a backup first if you want to keep it.\n\nType the profile name to confirm:`);
  if (typed == null) return;
  if (normName(typed) !== normName(p.name)) return alert('The name did not match – nothing was deleted.');
  if (p.id === S.profile.id) { const other = S.profiles.find(x => x.id !== p.id); S.profile = other; LCA.use(other.db); await PR.setSetting('current', other.id); resetProfileView(); }
  stopWorker(); S.xcache.clear();
  await PR.del(p.id); S.profiles = await PR.all();
  try { await LCA.deleteDatabase(p.db); } catch (e) { console.warn(e); }
  await loadState(true); drawProfileBtn(); toast(`Profile “${p.name}” deleted`);
  location.hash = '#/messenger'; render();
}
/* Before an export is imported: does its own profile name fit the selected profile? */
async function confirmProfileName(found) {
  const P = S.profile, n = normName(found);
  const here = await LCA.at(P.db).getMeta('ownerFromProfile', null);
  if (here && normName(here) !== n) return confirm(`This export belongs to the Facebook profile “${found}”, but the profile “${P.name}” in this app already contains an export of “${here}”.\n\nImport it into “${P.name}” anyway? Press Cancel to stop – nothing has been imported yet.`);
  for (const o of S.profiles) {
    if (o.id === P.id) continue;
    const other = await LCA.at(o.db).getMeta('ownerFromProfile', null).catch(() => null);
    if ((other && normName(other) === n) || (!here && normName(o.name) === n && normName(P.name) !== n)) return confirm(`This export belongs to the Facebook profile “${found}”, which looks like your other profile “${o.name}” in this app.\n\nImport it into “${P.name}” anyway? Press Cancel to stop – nothing has been imported yet (then switch profile at the top).`);
  }
  return true;
}
async function nameSuggestionCard() {
  const fb = await LCA.getMeta('ownerFromProfile', null); if (!fb || normName(fb) === normName(S.profile.name)) return null;
  if ((await LCA.getMeta('nameSuggestionDismissed', null)) === fb) return null;
  const c = h('div', { class: 'card suggest' }, h('div', null, `💡 The imported export says this Facebook profile is called “${fb}”.`),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn primary', onclick: async () => { if (S.profiles.some(x => x.id !== S.profile.id && normName(x.name) === normName(fb))) return toast('Another profile already has that name'); await renameProfile(S.profile, fb, S.profile.icon); toast('Profile renamed'); render(); } }, `Rename “${S.profile.name}” to “${fb}”`),
      h('button', { class: 'btn', onclick: async () => { await LCA.setMeta('nameSuggestionDismissed', fb); c.remove(); } }, 'Keep current name')));
  return c;
}
/* ---------- restore ---------- */
async function restoreFlow(file) {
  if (S.busy) return toast('Please wait until the import / backup has finished');
  let info;
  S.busy = true; drawProfileBtn();
  try { setProgress('Reading backup', 0, 1); info = await runWorker({ type: 'inspectBackup', file }); }
  catch (e) { alert('Could not read the backup: ' + e.message); return; }
  finally { S.busy = false; drawProfileBtn(); }
  const ps = info.profiles.map((x, i) => Object.assign(x, { label: x.name || x.meta?.profileName || x.meta?.ownerFromProfile || (info.profiles.length > 1 ? `Restored profile ${i + 1}` : 'Restored backup') }));
  const desc = (x) => `${x.label}: ${fmtN(x.stores?.threads || 0)} conversations, ${fmtN(x.stores?.messages || 0)} messages, ${fmtN(x.stores?.media || 0)} media files`;
  const when = info.createdAt ? ` from ${fmtDT(info.createdAt)}` : '';
  let choice;
  if (ps.length === 1) {
    choice = await choose('Restore backup', `This backup${when} contains one profile${info.version < 2 ? ' (made with the earlier one-profile version)' : ''} – ${desc(ps[0])}.`,
      [['new', `＋ Restore as a new profile “${uniqueName(ps[0].label, S.profiles)}”`, 'primary'], ['replace', `Replace the data of “${S.profile.name}” with it`]]);
  } else {
    choice = await choose('Restore backup', `This backup${when} contains ${ps.length} profiles:\n` + ps.map(desc).join(' · '),
      [['new', `＋ Add all ${ps.length} profiles`, 'primary'], ['replaceAll', `Replace all ${S.profiles.length} profile(s) on this device with these ${ps.length}`]]);
  }
  if (!choice) return;
  if (choice === 'replace' && !confirm(`Replace everything in “${S.profile.name}” with the backup? Other profiles are not touched.`)) return;
  if (choice === 'replaceAll' && !confirm(`Replace ALL profiles on this device with the ${ps.length} profiles from the backup? Profiles that are not in the backup will be deleted.`)) return;
  S.busy = true; drawProfileBtn(); showProgBox();
  const done = [];
  try {
    // each profile is restored into a fresh database first; old data is removed only after that succeeded
    for (let i = 0; i < ps.length; i++) {
      const x = ps[i], id = newId(), db = LCA.PROFILE_DB_PREFIX + id;
      setProgress(`Restoring “${x.label}” (${i + 1} of ${ps.length})`, 0, 1);
      done.push({ x, id, db });
      await runWorker({ type: 'restore', file, prefix: x.dir || '', db });
    }
    stopWorker(); S.xcache.clear();
    const old = S.profiles.slice();
    if (choice === 'replace') {
      const P = S.profile, oldDb = P.db;
      const np = Object.assign({}, P, { db: done[0].db, restoredAt: Date.now() });
      const L = LCA.at(np.db); await L.setMeta('profileName', np.name); await L.setMeta('profileIcon', np.icon);
      await PR.put(np); S.profiles = await PR.all(); S.profile = np; LCA.use(np.db);
      await LCA.deleteDatabase(oldDb).catch(e => console.warn(e));
    } else {
      let first = null;
      for (const d of done) {
        const name = uniqueName(d.x.label, choice === 'replaceAll' ? [] : S.profiles);
        const p = { id: d.id, name, icon: d.x.icon || d.x.meta?.profileIcon || '👤', db: d.db, createdAt: Date.now(), restoredAt: Date.now(), order: Math.max(0, ...S.profiles.map(z => z.order ?? 0)) + 1 };
        const L = LCA.at(p.db); await L.setMeta('profileName', p.name); await L.setMeta('profileIcon', p.icon);
        await PR.put(p); S.profiles = await PR.all(); first = first || p;
      }
      S.profile = first; LCA.use(first.db);
      if (choice === 'replaceAll') {
        for (const o of old) { await PR.del(o.id); await LCA.deleteDatabase(o.db).catch(e => console.warn(e)); }
        S.profiles = await PR.all();
      }
    }
    await PR.setSetting('current', S.profile.id);
    resetProfileView(); await loadState(true); drawProfileBtn();
    setProgress('Backup restored', 1, 1, done.map(d => d.x.label).join(' · ')); toast('Backup restored');
  } catch (e) {
    console.error(e); stopWorker();
    for (const d of done) if (!S.profiles.some(p => p.db === d.db)) await LCA.deleteDatabase(d.db).catch(() => {});
    alert('Restore failed: ' + e.message + '\n\nNothing on this device was replaced.');
  } finally { S.busy = false; drawProfileBtn(); }
  if (location.hash.startsWith('#/import')) { const note = $('#progNote')?.textContent; await render(); setProgress('Backup restored', 1, 1, note); } else location.hash = '#/messenger';
}
function uniqueName(n, list) { let out = n, k = 2; while (list.some(p => normName(p.name) === normName(out))) out = `${n} (${k++})`; return out; }

// a page loaded from an older cached index.html has no profile button yet – add it
if (!$('#profBtn')) { const b = h('button', { type: 'button', id: 'profBtn', class: 'profbtn', 'aria-label': 'Switch profile' }); const br = $('.brand'); if (br) br.after(b); else $('#top').prepend(b); }
$('#profBtn').addEventListener('click', () => openProfileSheet());
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  // when a new version takes over, load it (never in the middle of an import – then offer it afterwards)
  const hadController = !!navigator.serviceWorker.controller; let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    if (S.busy) { S.updateWaiting = true; return; }
    reloading = true; location.reload();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => { }); });
}
(async () => {
  if (typeof LCA.use !== 'function') {
    // old shared.js from the browser cache next to the new app.js: reload once to get matching files
    view.append(h('div', { class: 'note' }, 'Updating the app… ', h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload')));
    if (!sessionStorage.getItem('lca-reloaded')) { sessionStorage.setItem('lca-reloaded', '1'); setTimeout(() => location.reload(), 1500); }
    return;
  }
  sessionStorage.removeItem('lca-reloaded');
  try { await initProfiles(); await LCA.openDB(); } catch (e) { view.append(h('div', { class: 'note' }, 'This browser cannot store the archive (IndexedDB unavailable – private browsing?). ' + e.message)); return; }
  drawProfileBtn();
  await loadState(true);
  if (!location.hash) { location.replace('#/' + (S.threads.length || S.report ? 'messenger' : 'import')); }
  render();
})();
