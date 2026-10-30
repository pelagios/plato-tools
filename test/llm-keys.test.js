// The key a language-model service is used with (src/lib/llm-keys.js, and permissions.llmKeys, which the
// Permissions panel shows): kept in this tab's memory and nowhere else, handed out only for an address on
// the site it was typed for, listed without being shown, forgotten at once. Each check of an absence has
// its presence beside it: the key is found where it should be before it is looked for where it must not.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createKeyKeeper } from '../src/lib/llm-keys.js';
import * as permissions from '../src/lib/permissions.js';
import { llmKeysSection } from '../src/lib/permissions-panel.js';
import { PANEL } from '../src/lib/permission-words.js';

const KEY = `sk-ant-test-NEVER-REAL-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const OTHER = `sk-test-OTHER-NEVER-REAL-${Math.random().toString(36).slice(2)}`;
const MESSAGES = 'https://api.anthropic.com/v1/messages';

// A store that records every write and every read, to show that none was made.
class Store {
  constructor() { this.m = new Map(); this.writes = []; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.writes.push([k, String(v)]); this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
beforeEach(() => {
  globalThis.localStorage = new Store();
  globalThis.sessionStorage = new Store();
  globalThis.__platoCsp = { policy: '', origins: [] };
  permissions.resetForTests();
});
const everywhere = () => JSON.stringify([...localStorage.m, ...sessionStorage.m, localStorage.writes, sessionStorage.writes]);

test('a key is held for the tab: it is found where it was typed for, and in no storage at all', () => {
  const k = createKeyKeeper();
  assert.equal(k.has('anthropic'), false);
  k.set('anthropic', `  ${KEY} `);
  assert.equal(k.has('anthropic'), true);
  assert.equal(k.keyFor('anthropic', MESSAGES), KEY, 'presence: trimmed, and given for its own site');
  assert.ok(!everywhere().includes(KEY), 'absence: in neither localStorage nor sessionStorage');
  assert.deepEqual(localStorage.writes.concat(sessionStorage.writes), [], 'nothing was written to either');
  // A copy of the module that did keep it would be caught by the same search: shown by a leaking keeper.
  sessionStorage.setItem('leak', KEY);
  assert.ok(everywhere().includes(KEY), 'control: the search finds a key that is in storage');
  // And the source names no place that outlives the tab.
  const src = readFileSync(new URL('../src/lib/llm-keys.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const word of ['localStorage', 'sessionStorage', 'indexedDB', 'storage.getDirectory', 'document.cookie', 'location', 'history.', 'postMessage', 'BroadcastChannel', 'window.name']) assert.ok(!src.includes(word), `llm-keys.js must not use ${word}`);
});

test('a key is bound to the site it was typed for: it is never handed out for another site, however alike', () => {
  const k = createKeyKeeper();
  k.set('anthropic', KEY);
  assert.equal(k.keyFor('anthropic', 'https://api.anthropic.com/v1/models'), KEY, 'control: its own site, any path');
  for (const url of ['https://evil.example.org/v1/messages', 'https://api.anthropic.com.evil.example.org/v1/messages', 'http://api.anthropic.com/v1/messages',
    'https://api.anthropic.com:8443/v1/messages', 'https://www.anthropic.com/', 'https://evil.example.org/?u=https://api.anthropic.com', 'not an address', '', null, undefined, 'https://api.anthropic.com@evil.example.org/']) {
    assert.equal(k.keyFor('anthropic', url), null, String(url));
  }
  // A key typed for one service is not another's, even if the other is held too.
  k.set('http://localhost:11434', OTHER);
  assert.equal(k.keyFor('http://localhost:11434', 'http://localhost:11434/v1/chat/completions'), OTHER);
  assert.equal(k.keyFor('anthropic', 'http://localhost:11434/v1/chat/completions'), null, 'Anthropic\'s key to this computer\'s server');
  assert.equal(k.keyFor('http://localhost:11434', MESSAGES), null, 'the local server\'s key to Anthropic');
  assert.equal(k.keyFor('https://llm.example.org', 'https://llm.example.org/v1/models'), null, 'no key held for a service not given one');
  assert.deepEqual(k.boundTo('anthropic'), ['https://api.anthropic.com'], 'and the keeper says where a key may go');
  assert.deepEqual(k.boundTo('https://llm.example.org'), []);
  // Not a permission at all: no key is kept for it.
  for (const bad of ['openai', 'http://llm.example.org', 'https://llm.example.org/v1', '', 'linked:x']) assert.throws(() => k.set(bad, KEY), TypeError, bad);
});

test('a key is plain printable text: a line break or a space in it is refused, not sent as a header', () => {
  const k = createKeyKeeper();
  for (const bad of ['abc\ndef-abc-def', 'abc def abc def', 'abc\r\nx-evil: 1', 'ключ-ключ-ключ']) assert.throws(() => k.set('anthropic', bad), /key/, JSON.stringify(bad));
  assert.equal(k.has('anthropic'), false);
  k.set('anthropic', KEY);
  assert.equal(k.has('anthropic'), true, 'control: a key of such characters is kept');
});

test('what is held is listed without the key, forgotten at once, and an empty key is forgetting', () => {
  const heard = [];
  const k = createKeyKeeper({ onChange: () => heard.push(k.held().length) });
  k.set('anthropic', KEY);
  k.set('http://localhost:11434', OTHER);
  const held = k.held();
  assert.deepEqual(held.map((x) => x.key), ['llm:anthropic', 'llm:http://localhost:11434']);
  assert.deepEqual(held[0].origins, ['https://api.anthropic.com']);
  assert.equal(held[0].name, 'Anthropic');
  assert.ok(!JSON.stringify(held).includes(KEY) && !JSON.stringify(k).includes(KEY) && !String(k.held).includes(KEY) && !JSON.stringify(Object.getOwnPropertyNames(k)).includes(KEY), 'not in the list, nor on the keeper');
  assert.ok(k.secrets().includes(KEY) && k.secrets().includes(OTHER), 'presence: the page can still give a project\'s search every key held');
  k.forget('anthropic');
  assert.equal(k.has('anthropic'), false);
  assert.equal(k.keyFor('anthropic', MESSAGES), null);
  assert.equal(k.has('http://localhost:11434'), true);
  k.set('http://localhost:11434', '');
  assert.equal(k.has('http://localhost:11434'), false, 'an empty key forgets');
  k.set('anthropic', KEY); k.forgetAll();
  assert.deepEqual(k.held(), []);
  assert.deepEqual(k.secrets(), []);
  assert.deepEqual(heard, [1, 2, 1, 0, 1, 0], 'every change was announced, with how many are held');
});

test('the page\'s keeper (permissions.llmKeys): withdrawing the permission, or forgetting all, forgets its key; allowing it does not make one', async () => {
  permissions.llmKeys.set('anthropic', KEY);
  permissions.set('llm', 'anthropic', 'allowed');
  assert.equal(permissions.llmKeys.has('anthropic'), true, 'control: allowed, the key stays');
  permissions.set('llm', 'anthropic', 'never');
  assert.equal(permissions.llmKeys.has('anthropic'), false, 'Never: the key goes');
  permissions.llmKeys.set('anthropic', KEY); permissions.set('llm', 'anthropic', 'allowed');
  permissions.forget('llm', 'anthropic');
  assert.equal(permissions.llmKeys.has('anthropic'), false, 'forgotten: the key goes');
  permissions.llmKeys.set('anthropic', KEY); permissions.allowOnce('llm', 'anthropic');
  assert.equal(permissions.llmKeys.has('anthropic'), true, 'allowed for the tab: the key stays');
  permissions.forgetAll();
  assert.equal(permissions.llmKeys.has('anthropic'), false, 'forget all permissions: the key goes');
  // The key is in no storage, and not in the permissions list.
  permissions.llmKeys.set('anthropic', KEY);
  assert.ok(!everywhere().includes(KEY));
  assert.ok(!JSON.stringify(permissions.list()).includes(KEY));
  assert.ok(!JSON.stringify(permissions.remembered()).includes(KEY));
  // Changes are announced to the page, as the token's are.
  let n = 0; const stop = permissions.onChange(() => n++);
  permissions.llmKeys.forget('anthropic');
  stop();
  assert.equal(n, 1);
});

test('the panel shows what is held, and lets the user forget it, without the key', () => {
  const api = { llmKeys: createKeyKeeper() };
  assert.match(llmKeysSection(api), new RegExp(PANEL.llmKeysNone));
  assert.ok(!llmKeysSection(api).includes('data-llm-forget'), 'nothing held, nothing to forget');
  api.llmKeys.set('anthropic', KEY);
  api.llmKeys.set('http://localhost:11434', OTHER);
  const html = llmKeysSection(api);
  assert.ok(!html.includes(KEY) && !html.includes(OTHER), 'the key is never shown');
  assert.match(html, /data-llm-forget="llm:anthropic"/);
  assert.match(html, /data-llm-forget="llm:http:\/\/localhost:11434"/);
  assert.match(html, /Anthropic/);
  assert.match(html, /never saved/);
  assert.match(html, /api\.anthropic\.com/);
  assert.match(html, /forgotten when the tab is closed/);
});
