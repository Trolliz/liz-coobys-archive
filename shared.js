/* Liz Coobys Archive - shared helpers (window + worker). Everything stays on this device. */
'use strict';
const LCA = (() => {
  const DB_NAME = 'lizcoobys-archive', DB_VER = 1;
  const STORES = ['threads', 'messages', 'media', 'files', 'search', 'friends', 'groups', 'pages', 'avatars', 'meta'];
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('threads', { keyPath: 'id' });
        const m = d.createObjectStore('messages', { keyPath: 'id' });
        m.createIndex('thread', ['threadId', 'ord']);
        const md = d.createObjectStore('media', { keyPath: 'id' });
        md.createIndex('thread', 'threadId');
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('search', { keyPath: 'threadId' });
        d.createObjectStore('friends', { keyPath: 'id' });
        d.createObjectStore('groups', { keyPath: 'id' });
        d.createObjectStore('pages', { keyPath: 'id' });
        d.createObjectStore('avatars', { keyPath: 'url' });
        d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); res(d); };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Database blocked – close other tabs of the archive.'));
    });
    return dbp;
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Transaction aborted (storage full?)')); });
  async function get(store, key) { const d = await openDB(); return req(d.transaction(store).objectStore(store).get(key)); }
  async function getAll(store, query, count) { const d = await openDB(); return req(d.transaction(store).objectStore(store).getAll(query, count)); }
  async function count(store) { const d = await openDB(); return req(d.transaction(store).objectStore(store).count()); }
  async function put(store, val) { const d = await openDB(); const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(val); return done(t); }
  async function putMany(store, vals) {
    if (!vals.length) return; const d = await openDB(); const t = d.transaction(store, 'readwrite'); const s = t.objectStore(store);
    for (const v of vals) s.put(v); return done(t);
  }
  async function del(store, key) { const d = await openDB(); const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(key); return done(t); }
  async function clear(stores) { const d = await openDB(); const t = d.transaction(stores, 'readwrite'); for (const s of stores) t.objectStore(s).clear(); return done(t); }
  async function deleteByIndex(store, index, range) {
    const d = await openDB(); const t = d.transaction(store, 'readwrite');
    const ix = t.objectStore(store).index(index);
    await new Promise((res, rej) => { const c = ix.openKeyCursor(range); c.onsuccess = () => { const cur = c.result; if (!cur) return res(); t.objectStore(store).delete(cur.primaryKey); cur.continue(); }; c.onerror = () => rej(c.error); });
    return done(t);
  }
  async function getAllByIndex(store, index, range, count, direction) {
    const d = await openDB(); const ix = d.transaction(store).objectStore(store).index(index);
    if (!direction || direction === 'next') return req(ix.getAll(range, count));
    return new Promise((res, rej) => { const out = []; const c = ix.openCursor(range, direction); c.onsuccess = () => { const cur = c.result; if (!cur || (count && out.length >= count)) return res(out); out.push(cur.value); cur.continue(); }; c.onerror = () => rej(c.error); });
  }
  /* File bytes live in their own store so lists stay light. Some older iPhone Safari versions refuse
     Blobs inside IndexedDB (especially from workers) – then the bytes are stored as an ArrayBuffer instead. */
  async function putFiles(recs) {
    if (!recs.length) return;
    try { await putMany('files', recs.map(r => ({ id: r.id, blob: r.blob, mime: r.mime }))); }
    catch (e) {
      for (const r of recs) { const buf = await r.blob.arrayBuffer(); await put('files', { id: r.id, buf, mime: r.mime }); }
    }
  }
  async function getFile(id) {
    const r = await get('files', id); if (!r) return null;
    if (r.blob) return r.blob; if (r.buf) return new Blob([r.buf], { type: r.mime || 'application/octet-stream' }); return null;
  }
  async function getMeta(key, def) { const r = await get('meta', key); return r ? r.value : def; }
  async function setMeta(key, value) { return put('meta', { key, value }); }

  /* ---------- Facebook mojibake repair ----------
     Meta's JSON writes every UTF-8 byte as its own \u00XX escape ("Ã¥" instead of "å").
     We only repair a string when (1) every character is <= U+00FF, (2) at least one is >= U+0080,
     and (3) the bytes decode as strictly valid UTF-8. Correct text (e.g. real "åäö" = E5 E4 F6,
     or anything containing characters above U+00FF such as emoji) fails these tests and is left untouched. */
  const dec = new TextDecoder('utf-8', { fatal: true });
  function fixText(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    let high = false;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c > 0xFF) return s; if (c >= 0x80) high = true; }
    if (!high) return s;
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    try { return dec.decode(b); } catch (e) { return s; }
  }
  function fixDeep(v, stats) {
    if (typeof v === 'string') { const f = fixText(v); if (stats && f !== v) stats.fixed++; return f; }
    if (Array.isArray(v)) return v.map(x => fixDeep(x, stats));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[fixText(k)] = fixDeep(v[k], stats); return o; }
    return v;
  }

  const EXT = {
    jpg: ['image/jpeg', 'photo'], jpeg: ['image/jpeg', 'photo'], png: ['image/png', 'photo'], webp: ['image/webp', 'photo'], heic: ['image/heic', 'photo'], bmp: ['image/bmp', 'photo'], avif: ['image/avif', 'photo'],
    gif: ['image/gif', 'gif'], mp4: ['video/mp4', 'video'], mov: ['video/quicktime', 'video'], webm: ['video/webm', 'video'], m4v: ['video/mp4', 'video'], '3gp': ['video/3gpp', 'video'],
    mp3: ['audio/mpeg', 'audio'], m4a: ['audio/mp4', 'audio'], aac: ['audio/aac', 'audio'], wav: ['audio/wav', 'audio'], ogg: ['audio/ogg', 'audio'], opus: ['audio/ogg', 'audio'], amr: ['audio/amr', 'audio'],
    pdf: ['application/pdf', 'file'], txt: ['text/plain', 'file'], doc: ['application/msword', 'file'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file'],
    xls: ['application/vnd.ms-excel', 'file'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file'], zip: ['application/zip', 'file'], json: ['application/json', 'file'], html: ['text/html', 'file'], csv: ['text/csv', 'file']
  };
  const ext = (n) => { const m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; };
  const mimeOf = (n) => (EXT[ext(n)] || ['application/octet-stream'])[0];
  const kindOf = (n) => (EXT[ext(n)] || [0, 'file'])[1];
  const baseName = (p) => (p || '').split('/').pop();

  return { openDB, STORES, putFiles, getFile, get, getAll, count, put, putMany, del, clear, deleteByIndex, getAllByIndex, getMeta, setMeta, fixText, fixDeep, mimeOf, kindOf, ext, baseName };
})();
if (typeof self !== 'undefined') self.LCA = LCA;
