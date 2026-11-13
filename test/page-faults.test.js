// Two faults of the page that are not the data's, told from an error's own words (src/engine/words.js):
// the browser's refusal of its private file storage (a Firefox private window), and the engine's own
// files not arriving (a dropped connection). The page says each in plain words (src/app.js, fail();
// src/chora/app.js); the browser checks (e2e/app_test.py, page_shell_checks) hold it to them in a real
// Firefox private window and with SQLite's WebAssembly stopped on its way. The messages here are the ones
// seen in the review of November 2026, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_STORAGE, storageRefused, NOT_DOWNLOADED, downloadFailed, POOL_BUSY, POOL_STUCK, NO_ENGINE_STORAGE, engineStorageLacking, NO_ROOM, noRoom, NO_WEBGL } from '../src/engine/words.js';

test('the browser refusing its file storage is recognised from each browser\'s words for it, and from nothing else', () => {
  for (const m of [
    'Security error when calling GetDirectory',                                           // Firefox, a private window
    "undefined is not an object (evaluating 'navigator.storage.getDirectory')",           // WebKit with no navigator.storage
    'Missing required OPFS APIs.',                                                        // SQLite, where there is none
    "Cannot read properties of undefined (reading 'getDirectory')",                       // Chromium, a page not served securely
  ]) assert.equal(storageRefused(m), true, m);
  for (const m of [
    'Access Handles cannot be created if there is another open Access Handle or WritableStream associated with the same file.',   // another tab: POOL_BUSY's
    'The engine stopped: unknown error', 'unexpected token at line 3', "This dataset has no place bath.", POOL_BUSY, POOL_STUCK, '', undefined, null,
  ]) assert.equal(storageRefused(m), false, String(m));
});

test('the engine\'s files not arriving is recognised from SQLite\'s abort and each browser\'s failed fetch, and from nothing else', () => {
  for (const m of [
    "Aborted(NetworkError: Failed to execute 'send' on 'XMLHttpRequest': Failed to load 'http://localhost:4174/assets/sqlite3-Con_VOcu.wasm'.). Build with -sASSERTIONS for more info.",
    'Aborted(both async and sync fetching of the wasm failed). Build with -sASSERTIONS for more info.',
    'Failed to fetch dynamically imported module: https://pelagios.org/plato-tools/assets/xlsx-CuSbHU4R.js',   // Chromium
    'error loading dynamically imported module: https://pelagios.org/plato-tools/assets/xlsx-CuSbHU4R.js',     // Firefox
    'Importing a module script failed.',                                                                       // Safari
    'Failed to fetch', 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed',
  ]) assert.equal(downloadFailed(m), true, m);
  for (const m of [
    'Security error when calling GetDirectory', 'The file could not be read: Failed to fetch the third record', 'line 3: a place has no name',
    'The engine stopped: unknown error', POOL_BUSY, '', undefined, null,
  ]) assert.equal(downloadFailed(m), false, String(m));
});

test('the words name a remedy, not an interface of the browser', () => {
  assert.match(NO_STORAGE, /use an ordinary window, not a private one/);
  assert.match(NOT_DOWNLOADED, /check the connection and press the button again/);
  for (const w of [NO_STORAGE, NOT_DOWNLOADED]) assert.doesNotMatch(w, /getDirectory|OPFS|SecurityError|ASSERTIONS|wasm/i);
});

// November 2026, from the WebKitGTK check and the robustness review: a browser without the storage the engine's
// worker writes through, and the browser's allowance used up while a result is written.
test('a browser without what the engine writes through is told from a private window\'s refusal, and said with its own remedy', () => {
  for (const m of ['Backend does not support this operation', 'NotSupportedError: Backend does not support this operation', 'h.createSyncAccessHandle is not a function']) {
    assert.equal(engineStorageLacking(m), true, m); assert.equal(storageRefused(m), false, m);
  }
  for (const m of ['Security error when calling GetDirectory', 'The engine stopped: unknown error', NO_ROOM, POOL_BUSY, '', undefined, null]) assert.equal(engineStorageLacking(m), false, String(m));
  assert.match(NO_ENGINE_STORAGE, /^This browser cannot run the tools/);
  assert.match(NO_ENGINE_STORAGE, /Use a current Chrome, Edge or Firefox\.$/);
  assert.doesNotMatch(NO_ENGINE_STORAGE, /private|createSyncAccessHandle|OPFS|Backend/);
});

test('no room left for a result is recognised from the engine\'s words, the browser\'s and SQLite\'s, and from nothing else', () => {
  for (const m of [NO_ROOM, 'QuotaExceededError: The operation failed because it would cause the application to exceed its storage quota.', 'SQLITE_FULL: sqlite3 result code 13: database or disk is full']) assert.equal(noRoom(m), true, m);
  for (const m of ['Security error when calling GetDirectory', 'Backend does not support this operation', 'line 3: a place has no name', POOL_BUSY, '', undefined, null]) assert.equal(noRoom(m), false, String(m));
  assert.match(NO_ROOM, /no room left for the result, so nothing was written/);
  assert.doesNotMatch(NO_ROOM, /QuotaExceeded|OPFS|SQLITE/);
});

test('the words for a map that cannot be made name WebGL, say what turned it off, and that the rest works', () => {
  assert.match(NO_WEBGL, /it needs WebGL, which this browser or window has turned off/);
  assert.match(NO_WEBGL, /The rest of the tools work/);
});
