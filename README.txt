Liz Coobys Archive – private, offline Facebook archive (static PWA, no server, no data in this folder).
Host these files on any HTTPS static host (they must be served from the same folder).
All imported data is stored only in the browser's IndexedDB on the device that imports it.
Several profiles: each profile has its own IndexedDB database ("lizcoobys-archive" = the first/default profile,
"lizcoobys-archive-p-…" = profiles added later); the list of profiles is kept in "lizcoobys-profiles".
Third-party code: vendor/zip.min.js = zip.js 2.25.0 (BSD-3-Clause, see vendor/zip.js-LICENSE).
