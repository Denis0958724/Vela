/**
 * Store migration and bookkeeping checks, run without Electron.
 *
 *   npm run test:store
 *
 * The store is the only place that can silently lose a user's work, so the
 * legacy-container migration is checked directly rather than by eyeballing the
 * app afterwards.
 */
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = await mkdtemp(join(tmpdir(), 'ironcode-store-'));

// The store asks Electron for the profile directory; point it at a temp dir.
const require = Module.createRequire(import.meta.url);
const fakeElectron = { app: { getPath: () => root } };
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const { Store } = require('../dist/test/store.cjs');

let failures = 0;
function check(label, pass, extra = '') {
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!pass) failures++;
}

async function writeIndex(data) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'projects.json'), JSON.stringify(data, null, 2), 'utf8');
}

async function readIndex() {
  return JSON.parse(await readFile(join(root, 'projects.json'), 'utf8'));
}

/* ── 1. the legacy container is unwrapped, other projects survive ── */
console.log('\n[1] Міграція __scratch');
await writeIndex({
  projects: [
    { id: '__scratch', name: 'Домашня папка', path: 'C:/Users/Admin', createdAt: 1, chats: [
      { id: 'c1', title: 'Привіт', createdAt: 1, updatedAt: 1 },
      { id: 'c2', title: 'привіт', createdAt: 2, updatedAt: 2 },
    ] },
    { id: 'p_uk', name: 'ук', path: 'C:/x/uk', createdAt: 2, chats: [
      { id: 'c3', title: 'Чат 1', createdAt: 3, updatedAt: 3 },
    ] },
    { id: 'p_iron', name: 'Ironcode', path: 'R:/Ironcode', createdAt: 3, chats: [
      { id: 'c4', title: 'Сайт', createdAt: 4, updatedAt: 4 },
    ] },
  ],
  activeProjectId: '__scratch',
  activeChatId: 'c1',
});

let store = new Store('C:/Users/Default');
await store.load();
let snap = store.snapshot();

check('__scratch прибрано', !snap.projects.some(p => p.id === '__scratch'));
check('решта проєктів ЦІЛІ', snap.projects.length === 2,
  snap.projects.map(p => p.name).join(', ') || '(порожньо)');
check('«ук» на місці', snap.projects.some(p => p.name === 'ук'));
check('«Ironcode» на місці', snap.projects.some(p => p.name === 'Ironcode'));
check('чати контейнера підняті нагору', snap.chats.length === 2,
  snap.chats.map(c => c.title).join(', '));
check('тека чатів успадкована', snap.chatsFolder === 'C:/Users/Admin', snap.chatsFolder);
check('активним став звичайний чат', snap.activeProjectId === null && snap.activeChatId === 'c1');

const onDisk = await readIndex();
check('міграцію записано на диск', !onDisk.projects.some(p => p.id === '__scratch'));
check('на диску теж 2 проєкти', onDisk.projects.length === 2);

/* ── 2. a project's chats never leak into the loose list ── */
console.log('\n[2] Чати проєкту не потрапляють у звичайні');
const projectChatIds = new Set(snap.projects.flatMap(p => p.chats.map(c => c.id)));
check('жоден чат проєкту не серед звичайних',
  !snap.chats.some(c => projectChatIds.has(c.id)));

/* ── 3. deleting a project leaves the others alone ── */
console.log('\n[3] Видалення проєкту');
await store.deleteProject(snap.projects.find(p => p.name === 'ук').id);
snap = store.snapshot();
check('видалено саме «ук»', !snap.projects.some(p => p.name === 'ук'));
check('«Ironcode» уцілів', snap.projects.some(p => p.name === 'Ironcode'));
check('звичайні чати не зачеплені', snap.chats.length === 2);

/* ── 4. pinning ── */
console.log('\n[4] Закріплення');
await store.togglePin('c1');
await store.togglePin(snap.projects[0].id);
snap = store.snapshot();
check('закріплено чат і проєкт', snap.pinned.length === 2, JSON.stringify(snap.pinned));
await store.togglePin('c1');
check('відкріплення працює', store.snapshot().pinned.length === 1);

/* ── 5. a damaged index is kept, not overwritten ── */
console.log('\n[5] Пошкоджений файл не затирається');
await writeFile(join(root, 'projects.json'), '{ broken json', 'utf8');
const store2 = new Store('C:/Users/Default');
await store2.load();
check('повідомлено про пошкодження', store2.loadError() !== null,
  (store2.loadError() ?? '').slice(0, 60));
check('відновлено з .bak', store2.snapshot().projects.length > 0,
  `${store2.snapshot().projects.length} проєктів`);

await rm(root, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'Усі перевірки пройдено.' : `${failures} перевірок провалено.`}`);
process.exit(failures === 0 ? 0 : 1);
