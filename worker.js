/* Liz Coobys Archive – import / backup worker. Reads ZIPs lazily (random access), never uploads anything. */
'use strict';
importScripts('vendor/zip.min.js', 'shared.js');
zip.configure({ useWebWorkers: false });

const pending = new Map(); let seq = 0;
function askMain(type, payload) { return new Promise(res => { const id = ++seq; pending.set(id, res); postMessage(Object.assign({ type, id }, payload)); }); }
const progress = (phase, done, total, note) => postMessage({ type: 'progress', phase, done, total, note });
const log = (msg) => postMessage({ type: 'log', msg });

onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'reply') { const r = pending.get(d.id); pending.delete(d.id); if (r) r(d.result); return; }
  try {
    if (d.type === 'importZips') { const r = await importZips(d.files); postMessage({ type: 'done', result: r }); }
    else if (d.type === 'backup') { const blob = await makeBackup(); postMessage({ type: 'backupReady', blob }); }
    else if (d.type === 'restore') { const r = await restoreBackup(d.file); postMessage({ type: 'done', result: r }); }
  } catch (err) { postMessage({ type: 'error', message: (err && (err.message || String(err))) + '', stack: err && err.stack }); }
};

const MEDIA_KINDS = new Set(['photo', 'gif', 'video', 'audio']);
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.?\/+/, '');
function joinPath(dir, rel) {
  const out = dir ? dir.split('/') : [];
  for (const s of norm(rel).split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}
const tailFromMessages = (p) => { const s = p.split('/'); const i = s.indexOf('messages'); return i >= 0 ? s.slice(i).join('/') : null; };

async function readText(entry) { return entry.getData(new zip.TextWriter('utf-8')); }
async function readJson(entry) { return JSON.parse(await readText(entry)); }

/* ---------------- ZIP import ---------------- */
async function importZips(fileList) {
  const report = Object.assign(newReport(), await LCA.getMeta('report', null) || {});
  report.warnings = []; report.unreadableFiles = []; report.emptySections = [];
  const all = []; // {e, path, zipName}
  for (const f of fileList) {
    progress('Opening ' + f.name, 0, 1);
    const reader = new zip.ZipReader(new zip.BlobReader(f));
    let entries;
    try { entries = await reader.getEntries(); }
    catch (err) { report.warnings.push(`Could not open “${f.name}” as a ZIP: ${err.message}`); continue; }
    const files = entries.filter(x => !x.directory);
    if (files.some(x => /(^|\/)lizcoobys-backup\.json$/.test(x.filename))) return { backup: true };
    report.sources = report.sources.filter(s => s.name !== f.name);
    report.notImported = (report.notImported || []).filter(x => x.zip !== f.name);
    report.sources.push({ name: f.name, size: f.size, entries: files.length, importedAt: Date.now() });
    for (const x of files) all.push({ e: x, path: norm(x.filename), zipName: f.name });
  }
  if (!all.length) { await LCA.setMeta('report', report); return { ok: false }; }

  // indexes for resolving attachment paths (works across multi-part exports)
  const byPath = new Map(), byTail = new Map(), byBase = new Map();
  for (const it of all) {
    byPath.set(it.path, it);
    const t = tailFromMessages(it.path); if (t) byTail.set(t, it);
    const b = LCA.baseName(it.path); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(it);
  }
  const used = new Set();
  const threadFiles = new Map(); // key -> {category, folder, files:[]}
  const msgrMedia = [], otherJson = [], unsupported = [], htmlLists = [];
  const sectionStats = new Map();
  const sec = (p) => { const s = p.split('/'); let i = 0; while (i < s.length - 1 && /^(facebook-|your_facebook_activity$|your_activity_across_facebook$|this_profile|data$)/i.test(s[i]) && s.length - i > 2) i++; const top = s.slice(0, Math.min(i + 1, s.length - 1)).join('/') || '(root)'; return top; };
  let profileEntry = null;

  for (const it of all) {
    const p = it.path, segs = p.split('/'), name = segs[segs.length - 1], mi = segs.indexOf('messages');
    const x = LCA.ext(name);
    if (mi >= 0 && segs.length >= mi + 4 && /^message_\d+\.(json|html?)$/i.test(name)) {
      const category = segs[mi + 1], folder = segs[mi + 2], key = category + '/' + folder;
      if (!threadFiles.has(key)) threadFiles.set(key, { key, category, folder, dir: segs.slice(0, mi + 3).join('/'), files: [] });
      threadFiles.get(key).files.push(it); it.cls = 'thread'; continue;
    }
    if (mi >= 0 && x !== 'json' && !/^html?$/.test(x)) { msgrMedia.push(it); it.cls = 'msgrMedia'; continue; }
    if (/profile_information\.json$/i.test(name)) { profileEntry = it; it.cls = 'profile'; continue; }
    if (x === 'json') { otherJson.push(it); continue; }
    if (/^html?$/.test(x) && listKind(p)) { htmlLists.push(it); continue; }
    unsupported.push(it);
  }

  // owner name
  let owner = await LCA.getMeta('owner', null);
  if (profileEntry) {
    try { const j = LCA.fixDeep(await readJson(profileEntry.e)); const n = j?.profile_v2?.name?.full_name || j?.profile?.name?.full_name || j?.profile_v2?.name; if (typeof n === 'string') { owner = n; await LCA.setMeta('ownerFromProfile', n); } profileEntry.done = true; }
    catch (err) { report.warnings.push('Profile information unreadable: ' + err.message); }
  }

  // peek other JSONs: E2EE secure-storage threads, friends, groups, pages
  const e2eeThreads = [];
  let ji = 0;
  for (const it of otherJson) {
    ji++; if (ji % 25 === 0) progress('Scanning export sections', ji, otherJson.length);
    let j; try { j = await readJson(it.e); } catch (err) { it.cls = 'unreadable'; report.unreadableFiles.push({ path: it.path, error: err.message }); continue; }
    if (looksLikeThread(j)) { e2eeThreads.push({ it, j }); it.cls = 'thread'; continue; }
    const kind = listKind(it.path);
    if (kind) {
      const n = await importList(kind, it.path, LCA.fixDeep(j), report);
      it.cls = n > 0 ? 'list' : 'listEmpty'; if (n === 0) report.emptySections.push(it.path); continue;
    }
    it.cls = 'notImported';
  }

  // Messenger HTML-format list files (friends/groups/pages exported as HTML)
  for (const it of htmlLists) {
    const kind = listKind(it.path);
    if (!kind) { it.cls = 'notImported'; continue; }
    const txt = await readText(it.e);
    const items = await askMain('parseHtmlList', { text: txt, path: it.path });
    const n = await importList(kind, it.path, { __html_items: items || [] }, report);
    it.cls = n > 0 ? 'list' : 'listEmpty';
  }

  /* ---- Messenger threads ---- */
  const allThreads = [...threadFiles.values()];
  for (const t of e2eeThreads) {
    const folder = t.it.path.replace(/\.json$/i, '').split('/').slice(-2).join('_');
    allThreads.push({ key: 'e2ee_export/' + folder, category: 'e2ee_export', folder, dir: t.it.path.split('/').slice(0, -1).join('/'), files: [t.it], preJson: t.j });
  }
  const M = report.messenger;
  const participantFreq = new Map();
  const msgFolderSet = new Map(); // thread dir -> threadId for unreferenced media
  let ti = 0;
  for (const th of allThreads) {
    ti++; progress('Messenger conversations', ti, allThreads.length, th.folder);
    const threadId = th.key;
    msgFolderSet.set(th.dir, threadId);
    await removeThread(threadId);
    const stats = { fixed: 0 };
    let title = null, participants = [], raws = [], format = 'json', still = null, threadPath = null, warnings = [];
    th.files.sort((a, b) => (+(/(\d+)\.\w+$/.exec(a.path) || [0, 0])[1]) - (+(/(\d+)\.\w+$/.exec(b.path) || [0, 0])[1]));
    for (const f of th.files) {
      if (/\.html?$/i.test(f.path)) {
        format = 'html';
        const txt = await readText(f.e);
        const r = await askMain('parseMessageHtml', { text: txt, path: f.path });
        if (!r) { warnings.push('Could not read ' + f.path); continue; }
        title = title || r.title; if (r.participants && r.participants.length) participants = r.participants;
        r.messages.forEach(m => raws.push({ m, html: true, file: f.path }));
        if (!r.messages.length) warnings.push('No messages recognised in ' + LCA.baseName(f.path));
        continue;
      }
      let j = f === th.files[0] && th.preJson ? th.preJson : null;
      try { if (!j) j = await readJson(f.e); } catch (err) { warnings.push(`Unreadable file ${LCA.baseName(f.path)}: ${err.message}`); report.unreadableFiles.push({ path: f.path, error: err.message }); continue; }
      if (th.preJson) format = 'e2ee';
      const fx = LCA.fixDeep(j, stats);
      title = title || fx.title || fx.threadName || fx.thread_name || null;
      const ps = (fx.participants || []).map(p => typeof p === 'string' ? p : (p && (p.name || p.full_name)) || '').filter(Boolean);
      if (ps.length) participants = ps;
      if (fx.is_still_participant != null) still = fx.is_still_participant;
      threadPath = threadPath || fx.thread_path || fx.threadPath || null;
      const ms = fx.messages || [];
      const orig = j.messages || [];
      ms.forEach((m, i) => raws.push({ m, orig: orig[i], file: f.path }));
    }
    // order: Meta writes newest first; sort ascending by timestamp, keep original relative order on ties (reverse).
    raws.forEach((r, i) => r.i = i);
    const norm1 = raws.map(r => r.html ? fromHtmlMsg(r.m) : normalizeMsg(r.m, r.orig));
    norm1.forEach((n, i) => n._i = i);
    const anyTs = norm1.some(n => n.ts != null);
    if (anyTs) norm1.sort((a, b) => (a.ts ?? -Infinity) - (b.ts ?? -Infinity) || b._i - a._i);
    else norm1.reverse();
    // resolve media
    const msgs = []; const searchTexts = []; const ords = [];
    const TS = { referenced: 0, found: 0, missing: 0, unreadable: 0, remote: 0, byKind: {}, missingList: [], unreadableList: [] };
    let mediaCount = 0, missing = 0, batch = [];
    for (let k = 0; k < norm1.length; k++) {
      const n = norm1[k]; delete n._i;
      n.threadId = threadId; n.ord = k; n.id = threadId + '#' + String(k).padStart(7, '0');
      for (const a of n.att) {
        TS.referenced++;
        if (/^https?:\/\//i.test(a.uri || '')) { a.remote = true; TS.remote++; continue; }
        if (!a.uri) { a.missing = true; TS.missing++; missing++; pushCap(TS.missingList, { thread: title || th.folder, threadId, uri: '(no file name given)', kind: a.kind }); continue; }
        const hit = resolve(a.uri, th, byPath, byTail, byBase);
        if (!hit) { a.missing = true; TS.missing++; missing++; pushCap(TS.missingList, { thread: title || th.folder, threadId, uri: a.uri, kind: a.kind }); continue; }
        a.mediaId = hit.path; used.add(hit.path);
        if (hit.storedFor) { a.dupOf = hit.storedFor; TS.found++; continue; }
        try {
          const blob = await hit.e.getData(new zip.BlobWriter(LCA.mimeOf(hit.path)));
          batch.push({ id: hit.path, threadId, msgId: n.id, ts: n.ts ?? a.created ?? null, kind: a.kind, name: LCA.baseName(hit.path), mime: LCA.mimeOf(hit.path), size: blob.size, blob, referenced: true, sender: n.sender });
          hit.storedFor = n.id; TS.found++; mediaCount++;
          TS.byKind[a.kind] = (TS.byKind[a.kind] || 0) + 1;
          if (batch.length >= 25) { await saveMedia(batch); batch = []; }
        } catch (err) { a.unreadable = true; TS.unreadable++; pushCap(TS.unreadableList, { thread: title || th.folder, uri: a.uri, error: err.message }); }
      }
      msgs.push(n);
      const st = [n.text, n.share && n.share.text, n.share && n.share.link, ...n.att.map(a => a.name)].filter(Boolean).join(' ').toLowerCase();
      if (st) { searchTexts.push(st); ords.push(k); }
    }
    if (batch.length) await saveMedia(batch);
    for (let k = 0; k < msgs.length; k += 2000) await LCA.putMany('messages', msgs.slice(k, k + 2000));
    await LCA.put('search', { threadId, ords, texts: searchTexts });
    participants.forEach(p => participantFreq.set(p, (participantFreq.get(p) || 0) + 1));
    const last = msgs[msgs.length - 1];
    const senders = new Set(msgs.map(m => m.sender).filter(Boolean));
    await LCA.put('threads', {
      id: threadId, category: th.category, folder: th.folder, title: title || participants.join(', ') || th.folder, participants, senders: [...senders],
      msgCount: msgs.length, firstTs: msgs.find(m => m.ts != null)?.ts ?? null, lastTs: last?.ts ?? null,
      lastText: last ? previewOf(last) : '', lastSender: last?.sender || '', mediaCount, missingMedia: missing, format,
      isStillParticipant: still, threadPath, warnings, source: th.files[0]?.zipName, fixedStrings: stats.fixed, mediaStats: TS
    });
  }

  // Messenger media files that no message points to — kept, never discarded
  let ui = 0; let batch = [];
  for (const it of msgrMedia) {
    if (used.has(it.path)) continue;
    ui++; if (ui % 20 === 0) progress('Extra Messenger media', ui, msgrMedia.length);
    const dir = it.path.split('/'); let tid = null;
    for (let k = dir.length - 1; k > 0 && !tid; k--) tid = msgFolderSet.get(dir.slice(0, k).join('/')) || null;
    const kind = LCA.kindOf(it.path);
    const cat = (/stickers_used/.test(it.path) ? 'sticker' : kind);
    try {
      const blob = await it.e.getData(new zip.BlobWriter(LCA.mimeOf(it.path)));
      batch.push({ id: it.path, threadId: tid || '(no conversation)', msgId: null, ts: it.e.lastModDate ? +it.e.lastModDate : null, tsIsFileDate: true, kind: cat, name: LCA.baseName(it.path), mime: LCA.mimeOf(it.path), size: blob.size, blob, referenced: false });
      if (batch.length >= 25) { await saveMedia(batch); batch = []; }
    } catch (err) { report.unreadableFiles.push({ path: it.path, error: err.message }); }
    used.add(it.path);
  }
  if (batch.length) await saveMedia(batch);

  // who is "me"
  if (!owner) {
    let best = null, bc = 0; for (const [p, c] of participantFreq) if (c > bc) { best = p; bc = c; }
    if (best && bc >= Math.max(2, allThreads.length * 0.5)) owner = best;
  }
  if (owner) await LCA.setMeta('owner', owner);

  // section summary — every file in the ZIP is accounted for
  for (const it of all) {
    const s = sec(it.path); if (!sectionStats.has(s)) sectionStats.set(s, { folder: s, files: 0, bytes: 0, imported: 0, notImported: 0, unreadable: 0 });
    const st = sectionStats.get(s); st.files++; st.bytes += it.e.uncompressedSize || 0;
    const c = it.cls; if (c === 'thread' || c === 'list' || c === 'profile' || used.has(it.path)) st.imported++; else if (c === 'unreadable') st.unreadable++; else st.notImported++;
    if (!used.has(it.path) && (!c || c === 'notImported' || c === 'listEmpty')) pushCap(report.notImported, { path: it.path, size: it.e.uncompressedSize || 0, zip: it.zipName, reason: c === 'listEmpty' ? 'recognised but empty' : (c === 'notImported' ? 'data file not shown in this archive' : 'file type not shown in this archive') }, 20000);
  }
  report.notImportedCount = report.notImported.length;
  const prevSections = (report.sections || []).filter(s => !sectionStats.has(s.folder));
  report.sections = prevSections.concat([...sectionStats.values()]).sort((a, b) => b.files - a.files);
  await recountMessenger(report);
  report.updatedAt = Date.now();
  await LCA.setMeta('report', report);
  progress('Finished', 1, 1);
  return { ok: true };
}

async function saveMedia(batch) {
  await LCA.putFiles(batch);
  await LCA.putMany('media', batch.map(({ blob, ...m }) => m));
}
function pushCap(arr, v, cap = 5000) { if (arr.length < cap) arr.push(v); }
function newReport() {
  return {
    sources: [], warnings: [], unreadableFiles: [], emptySections: [], notImported: [], notImportedCount: 0, sections: [],
    messenger: { threads: 0, messages: 0, byCategory: {}, formats: {}, mojibakeFixed: 0, media: { referenced: 0, found: 0, missing: 0, unreadable: 0, remote: 0, unreferencedStored: 0, byKind: {} }, missingList: [], unreadableList: [], emptyThreads: [] },
    lists: {}
  };
}
async function recountMessenger(report) {
  const ths = await LCA.getAll('threads'); const M = report.messenger;
  Object.assign(M, { threads: ths.length, messages: 0, byCategory: {}, formats: {}, mojibakeFixed: 0, emptyThreads: [], missingList: [], unreadableList: [], threadWarnings: [],
    media: { referenced: 0, found: 0, missing: 0, unreadable: 0, remote: 0, unreferencedStored: 0, byKind: {} } });
  for (const t of ths) {
    M.messages += t.msgCount; const c = M.byCategory[t.category] = M.byCategory[t.category] || { threads: 0, messages: 0 }; c.threads++; c.messages += t.msgCount;
    M.formats[t.format] = (M.formats[t.format] || 0) + 1; M.mojibakeFixed += t.fixedStrings || 0;
    if (!t.msgCount) M.emptyThreads.push(t.title);
    for (const w of t.warnings || []) M.threadWarnings.push(t.title + ': ' + w);
    const s = t.mediaStats; if (!s) continue;
    for (const k of ['referenced', 'found', 'missing', 'unreadable', 'remote']) M.media[k] += s[k] || 0;
    for (const [k, v] of Object.entries(s.byKind || {})) M.media.byKind[k] = (M.media.byKind[k] || 0) + v;
    for (const x of s.missingList || []) pushCap(M.missingList, x); for (const x of s.unreadableList || []) pushCap(M.unreadableList, x);
  }
  let total = 0, unref = 0; const d = await LCA.openDB();
  await new Promise((res, rej) => { const c = d.transaction('media').objectStore('media').openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return res(); total++; if (cur.value.referenced === false) unref++; cur.continue(); }; c.onerror = () => rej(c.error); });
  M.mediaStored = total; M.media.unreferencedStored = unref;
}
async function removeThread(threadId) {
  await LCA.deleteByIndex('messages', 'thread', IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]));
  const old = await LCA.getAllByIndex('media', 'thread', IDBKeyRange.only(threadId));
  for (const m of old) await LCA.del('files', m.id);
  await LCA.deleteByIndex('media', 'thread', IDBKeyRange.only(threadId));
  await LCA.del('search', threadId); await LCA.del('threads', threadId);
}

function looksLikeThread(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.messages)) return false;
  const m = j.messages.find(x => x && typeof x === 'object');
  if (!m) return Array.isArray(j.participants);
  return ('sender_name' in m) || ('senderName' in m) || ('timestamp_ms' in m) || (('timestamp' in m) && ('text' in m || 'media' in m));
}

const ATT_KEYS = { photos: 'photo', images: 'photo', videos: 'video', audio_files: 'audio', gifs: 'gif', files: 'file', media: null, attachments: null };
function normalizeMsg(m, orig) {
  let ts = m.timestamp_ms ?? m.timestamp ?? m.timestampMs ?? null;
  if (typeof ts === 'string') ts = Date.parse(ts) || +ts || null;
  if (ts != null && ts < 1e11) ts *= 1000;
  const att = [];
  for (const k of Object.keys(ATT_KEYS)) {
    if (!Array.isArray(m[k])) continue;
    for (const a of m[k]) {
      const uri = typeof a === 'string' ? a : (a && (a.uri || a.url || a.path)) || '';
      const kind = ATT_KEYS[k] || LCA.kindOf(uri);
      let created = a && (a.creation_timestamp || a.creationTimestamp); if (created && created < 1e11) created *= 1000;
      att.push({ kind, uri, name: LCA.baseName(uri), created: created || null, thumb: a && a.thumbnail && a.thumbnail.uri || null });
    }
  }
  if (m.sticker) { const uri = typeof m.sticker === 'string' ? m.sticker : (m.sticker.uri || ''); att.push({ kind: 'sticker', uri, name: LCA.baseName(uri) }); }
  const share = m.share ? { link: m.share.link || null, text: m.share.share_text || m.share.text || null } : null;
  const reactions = Array.isArray(m.reactions) ? m.reactions.map(r => ({ r: r.reaction || r.emoji || '', actor: r.actor || r.actorName || '' })) : [];
  return {
    ts, sender: m.sender_name ?? m.senderName ?? m.sender ?? null, text: m.content ?? m.text ?? null,
    att, share, reactions, call: m.call_duration ?? null, unsent: !!(m.is_unsent || m.isUnsent), type: m.type || null,
    raw: orig !== undefined ? orig : m
  };
}
function fromHtmlMsg(h) {
  return { ts: h.ts ?? null, dateText: h.dateText || null, sender: h.sender || null, text: h.text || null,
    att: (h.media || []).map(u => ({ kind: LCA.kindOf(u), uri: u, name: LCA.baseName(u) })), share: h.link ? { link: h.link, text: null } : null,
    reactions: (h.reactions || []).map(r => ({ r, actor: '' })), call: null, unsent: false, type: 'html', raw: { html: h.rawText } };
}
function previewOf(m) {
  if (m.text) return m.text.slice(0, 120);
  if (m.att.length) return ({ photo: '📷 Photo', video: '🎬 Video', audio: '🎤 Audio', gif: 'GIF', sticker: 'Sticker', file: '📎 File' })[m.att[0].kind] || 'Attachment';
  if (m.share) return '🔗 ' + (m.share.link || 'Link');
  if (m.call != null) return '📞 Call'; if (m.unsent) return 'Message unsent'; return '';
}
function resolve(uri, th, byPath, byTail, byBase) {
  const u = norm(decodeURIComponentSafe(uri));
  if (byPath.has(u)) return byPath.get(u);
  const t = tailFromMessages(u); if (t && byTail.has(t)) return byTail.get(t);
  const rel = joinPath(th.dir, u); if (byPath.has(rel)) return byPath.get(rel);
  const cands = byBase.get(LCA.baseName(u)) || [];
  if (cands.length === 1) return cands[0];
  const inDir = cands.filter(c => c.path.startsWith(th.dir + '/'));
  if (inDir.length === 1) return inDir[0];
  const suffix = cands.filter(c => c.path.endsWith('/' + u)); if (suffix.length === 1) return suffix[0];
  return null;
}
function decodeURIComponentSafe(s) { try { return /%[0-9a-f]{2}/i.test(s) ? decodeURIComponent(s) : s; } catch (e) { return s; } }

/* ---------- friends / groups / pages lists from the official export ---------- */
function listKind(path) {
  const p = path.toLowerCase(), b = LCA.baseName(p).replace(/[’']/g, "'");
  if (/messages\//.test(p)) return null;
  if (/^(your_friends|friends|removed_friends|deleted_friends|sent_friend_requests|received_friend_requests|rejected_friend_requests|friend_requests_sent|friend_requests_received|followers|people_who_follow_you)(_\d+)?\.(json|html?)$/.test(b)) return 'friends';
  if (/^(who_you've_followed|following|profiles_you've_unfollowed|unfollowed_profiles)(_\d+)?\.(json|html?)$/.test(b)) return 'follow';
  if (/^(your_group_membership_activity|group_membership_activity|groups_you've_joined|your_groups|groups_you've_managed|groups_you_admin|groups_you've_left)(_\d+)?\.(json|html?)$/.test(b)) return 'groups';
  if (/^(pages_you've_liked|pages_you_follow|pages_you've_unfollowed|pages_and_profiles_you_follow|pages_and_profiles_you've_unfollowed|liked_pages|pages_you_like)(_\d+)?\.(json|html?)$/.test(b)) return 'pages';
  return null;
}
function storeFor(category, kind) {
  if (/followed_profile|unfollowed_profile|_page$/.test(category)) return 'pages';
  if (/friend|request|follower/.test(category)) return 'friends';
  if (/membership|managed|group/.test(category)) return 'groups';
  return kind === 'follow' ? 'pages' : kind;
}
const CAT = {
  friends_v2: 'friend', friends: 'friend', removed_friends_v2: 'removed_friend', deleted_friends_v2: 'removed_friend', sent_requests_v2: 'sent_request', received_requests_v2: 'received_request', rejected_requests_v2: 'rejected_request',
  followers_v2: 'follower', followers: 'follower', following_v3: 'followed_profile', following_v2: 'followed_profile', following: 'followed_profile', unfollowed_profiles_v2: 'unfollowed_profile',
  groups_joined_v2: 'membership_activity', groups_admined_v2: 'managed', group_membership: 'membership_activity',
  page_likes_v2: 'liked_page', pages_followed_v2: 'followed_page', pages_unfollowed_v2: 'unfollowed_page', pages_and_profiles_you_follow: 'followed_page'
};
function extractItems(j) {
  if (j && j.__html_items) return j.__html_items.map(x => ({ key: '__html', item: x }));
  const out = [];
  const visit = (key, v) => {
    if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object') out.push({ key, item: it }); }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) visit(k, v[k]);
  };
  if (Array.isArray(j)) visit('items', j); else visit('root', j);
  return out;
}
function itemFields(item) {
  let name = item.name || item.title_name || null, url = item.url || item.href || item.uri || null, ts = item.timestamp || item.timestamp_ms || item.creation_timestamp || null, title = item.title || null;
  if (!name && Array.isArray(item.data)) { const d = item.data.find(x => x && x.name); if (d) name = d.name; }
  if (!name && item.string_list_data) { const d = item.string_list_data[0]; if (d) { name = d.value; url = url || d.href; ts = ts || d.timestamp; } }
  if (Array.isArray(item.label_values)) {
    for (const lv of item.label_values) {
      const l = (lv.label || '').toLowerCase();
      if (!name && /^(name|namn|group|page|title)/.test(l) && typeof lv.value === 'string') name = lv.value;
      if (!url && (lv.href || /url|link/.test(l))) url = lv.href || lv.value;
      if (Array.isArray(lv.dict)) for (const d of lv.dict) { if (!name && /name/i.test(d.label || '')) name = d.value; if (!url && d.href) url = d.href; }
    }
    ts = ts || item.timestamp;
  }
  if (!name && title) { const m = /^(?:.*?)(?:joined|became a member of|gilla|liked|followed)\s+(.+?)\.?$/i.exec(title); if (m) name = m[1]; }
  if (ts && ts < 1e11) ts *= 1000;
  return { name, url, ts, title };
}
async function importList(kind, path, j, report) {
  const items = extractItems(j);
  const recs = []; let i = 0;
  for (const { key, item } of items) {
    const f = key === '__html' ? { name: item.name, url: item.url || null, ts: item.ts || null, title: item.detail || null } : itemFields(item);
    if (!f.name && !f.url && !f.title) continue;
    const category = CAT[key] || (key === '__html' ? LCA.baseName(path).replace(/\.\w+$/, '') : key);
    recs.push({ id: 'export:' + path + ':' + (i++), source: 'export', file: path, category, name: f.name || null, url: f.url || null, ts: f.ts || null, title: f.title || null, raw: item, storeName: storeFor(category, kind) });
  }
  const byStore = {};
  for (const r of recs) (byStore[r.storeName] = byStore[r.storeName] || []).push(r);
  for (const s of ['friends', 'groups', 'pages']) {
    // replace previous records from the same file
    const old = (await LCA.getAll(s)).filter(x => x.file === path).map(x => x.id);
    for (const id of old) await LCA.del(s, id);
    if (byStore[s]) await LCA.putMany(s, byStore[s]);
  }
  report.lists[path] = { kind, records: recs.length, categories: recs.reduce((a, r) => (a[r.category] = (a[r.category] || 0) + 1, a), {}) };
  return recs.length;
}

/* ---------------- backup ---------------- */
async function makeBackup() {
  const w = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { bufferedWrite: false });
  const manifest = { app: 'Liz Coobys Archive', version: 1, createdAt: Date.now(), stores: {} };
  const textStores = ['threads', 'search', 'friends', 'groups', 'pages', 'meta'];
  let step = 0; const total = textStores.length + 2;
  for (const s of textStores) {
    const rows = await LCA.getAll(s); manifest.stores[s] = rows.length;
    await w.add(`stores/${s}.json`, new zip.TextReader(JSON.stringify(rows)));
    progress('Backing up ' + s, ++step, total);
  }
  // messages in chunks
  const d = await LCA.openDB(); let chunk = [], n = 0, part = 0;
  await new Promise((res, rej) => {
    const c = d.transaction('messages').objectStore('messages').openCursor();
    c.onsuccess = () => { const cur = c.result; if (!cur) return res(); chunk.push(cur.value); n++; cur.continue(); };
    c.onerror = () => rej(c.error);
  });
  for (let k = 0; k < chunk.length; k += 5000) await w.add(`stores/messages-${String(part++).padStart(4, '0')}.json`, new zip.TextReader(JSON.stringify(chunk.slice(k, k + 5000))));
  manifest.stores.messages = n; chunk = null;
  progress('Backing up media', 0, 1);
  const keys = await new Promise((res, rej) => { const r = d.transaction('media').objectStore('media').getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const mediaMeta = [];
  for (let k = 0; k < keys.length; k++) {
    const meta = await LCA.get('media', keys[k]); const file = `media/${String(k).padStart(6, '0')}.${LCA.ext(meta.name) || 'bin'}`;
    const blob = await LCA.getFile(keys[k]); delete meta.blob; meta.file = blob ? file : null; mediaMeta.push(meta);
    if (blob) await w.add(file, new zip.BlobReader(blob), { level: 0 });
    if (k % 20 === 0) progress('Backing up media', k, keys.length);
  }
  await w.add('stores/media.json', new zip.TextReader(JSON.stringify(mediaMeta)));
  const av = await LCA.getAll('avatars'); const avMeta = [];
  for (let k = 0; k < av.length; k++) { const { blob, ...meta } = av[k]; meta.file = `avatars/${k}.img`; avMeta.push(meta); if (blob) await w.add(meta.file, new zip.BlobReader(blob), { level: 0 }); }
  await w.add('stores/avatars.json', new zip.TextReader(JSON.stringify(avMeta)));
  manifest.stores.media = mediaMeta.length; manifest.stores.avatars = avMeta.length;
  await w.add('lizcoobys-backup.json', new zip.TextReader(JSON.stringify(manifest, null, 2)));
  progress('Finishing backup file', 1, 1);
  return w.close();
}
async function restoreBackup(file) {
  const r = new zip.ZipReader(new zip.BlobReader(file)); const es = await r.getEntries();
  const by = new Map(es.map(e => [e.filename, e]));
  const man = by.get('lizcoobys-backup.json'); if (!man) throw new Error('This is not a Liz Coobys Archive backup file.');
  const manifest = JSON.parse(await man.getData(new zip.TextWriter()));
  await LCA.clear(LCA.STORES);
  for (const s of ['threads', 'search', 'friends', 'groups', 'pages', 'meta']) { const e = by.get(`stores/${s}.json`); if (e) await LCA.putMany(s, JSON.parse(await e.getData(new zip.TextWriter()))); progress('Restoring ' + s, 0, 1); }
  const parts = es.filter(e => /^stores\/messages-\d+\.json$/.test(e.filename)).sort((a, b) => a.filename < b.filename ? -1 : 1);
  for (let k = 0; k < parts.length; k++) { const rows = JSON.parse(await parts[k].getData(new zip.TextWriter())); for (let q = 0; q < rows.length; q += 2000) await LCA.putMany('messages', rows.slice(q, q + 2000)); progress('Restoring messages', k + 1, parts.length); }
  for (const [s, f] of [['media', 'stores/media.json'], ['avatars', 'stores/avatars.json']]) {
    const e = by.get(f); if (!e) continue; const meta = JSON.parse(await e.getData(new zip.TextWriter())); let batch = [];
    for (let k = 0; k < meta.length; k++) {
      const m = meta[k]; const fe = m.file ? by.get(m.file) : null; delete m.file;
      if (fe) m.blob = await fe.getData(new zip.BlobWriter(m.mime || 'application/octet-stream'));
      batch.push(m); if (batch.length >= 25) { await (s === 'media' ? saveMedia(batch.filter(x => x.blob)).then(() => LCA.putMany('media', batch.filter(x => !x.blob))) : LCA.putMany(s, batch)); batch = []; }
      if (k % 20 === 0) progress('Restoring ' + s, k, meta.length);
    }
    if (batch.length) await (s === 'media' ? saveMedia(batch.filter(x => x.blob)).then(() => LCA.putMany('media', batch.filter(x => !x.blob))) : LCA.putMany(s, batch));
  }
  progress('Finished', 1, 1);
  return { ok: true, restored: manifest.stores };
}
