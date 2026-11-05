import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { execFile } from 'node:child_process';
import { constants, promises as fs, appendFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { Agent, type ApprovalMode } from './agent.js';
import { fromBytes, fromPath, hasVideoSupport, type Attachment } from './attachments.js';
import { loadSettings, saveSettings, type Settings } from './config.js';
import { ConnectorRegistry, type Connector } from './connectors.js';
import { GatewayClient } from './gateway.js';
import { FreeLlmApiClient } from './free-llm-api.js';
import { ModelCatalog } from './models.js';
import { PreviewServer } from './preview.js';
import { ProviderStore } from './providers.js';
import { UsageStore } from './usage.js';
import { SkillRegistry } from './skills.js';
import { MAX_CHATS, Store } from './store.js';
import { pickFallbackModel, modelScore } from '../shared/model-rank.js';
import { estimateTokens } from '../shared/tokens.js';
import type { AgentEvent, ChatMessage } from './types.js';
import { Workspace } from './workspace.js';

// The Chromium network sandbox cannot acquire its cache directories in some
// Windows profiles and exits before main() gets a chance to run. The renderer
// stays context-isolated and Node-free either way; this only removes the
// process sandbox that cannot initialize on such a host.
app.commandLine.appendSwitch('no-sandbox');

let win: BrowserWindow | null = null;
let controlOverlay: BrowserWindow | null = null;
let controlOverlayTimer: NodeJS.Timeout | null = null;
let settings: Settings;
let gateway: GatewayClient;
let workspace: Workspace;
let agent: Agent;
let store: Store;
const preview = new PreviewServer();
const skills = new SkillRegistry();
const catalog = new ModelCatalog();
const connectors = new ConnectorRegistry();
const providers = new ProviderStore();
const usage = new UsageStore();

const IGNORED_IN_TREE = new Set(['node_modules', '.git', 'dist', 'release', '.cache']);

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function controlEdgeColor(): string {
  if (settings?.theme === 'light') return '#cb4f1a';
  if (settings?.theme === 'dark') return '#79d6b0';
  return '#8f9cff';
}

/**
 * A click-through frame around the primary display. It is deliberately a
 * separate window: the chat window can be behind another app while Vela is
 * moving the mouse, and the user still needs to see that control is active.
 */
function ensureControlOverlay(): BrowserWindow {
  if (controlOverlay && !controlOverlay.isDestroyed()) return controlOverlay;
  const box = screen.getPrimaryDisplay().bounds;
  controlOverlay = new BrowserWindow({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlOverlay.setIgnoreMouseEvents(true, { forward: true });
  controlOverlay.setAlwaysOnTop(true, 'screen-saver');
  const html = `<!doctype html><meta charset="utf-8">
<style>
:root{--edge:${controlEdgeColor()}}
html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}
.frame{position:fixed;inset:0;border:5px solid var(--edge);border-radius:14px;
box-shadow:inset 0 0 34px color-mix(in srgb,var(--edge) 32%,transparent),
0 0 22px color-mix(in srgb,var(--edge) 45%,transparent);
animation:edge 1.5s ease-in-out infinite alternate}
@keyframes edge{from{opacity:.55}to{opacity:1}}
</style><div class="frame"></div>`;
  void controlOverlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return controlOverlay;
}

function showControlOverlay(): void {
  if (controlOverlayTimer) {
    clearTimeout(controlOverlayTimer);
    controlOverlayTimer = null;
  }
  const overlay = ensureControlOverlay();
  const color = controlEdgeColor();
  void overlay.webContents.executeJavaScript(
    `document.documentElement.style.setProperty('--edge', ${JSON.stringify(color)})`,
  ).catch(() => undefined);
  overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
}

function hideControlOverlaySoon(): void {
  if (controlOverlayTimer) clearTimeout(controlOverlayTimer);
  controlOverlayTimer = setTimeout(() => {
    controlOverlayTimer = null;
    if (controlOverlay && !controlOverlay.isDestroyed()) controlOverlay.hide();
  }, 1800);
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

/** Point the agent, the preview server and the file tree at the active selection. */
function syncWorkspace(): void {
  const root = store.activeWorkspacePath();
  workspace.setRoot(root);
  preview.setRoot(root);
}

async function createWindow(): Promise<void> {
  // The default 1540x960 does not fit a 100%-to-125% scaled laptop panel, and
  // a window wider than the screen silently pushes the whole right panel off
  // it. Clamp to the work area so the first launch always shows the full shell.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1540, Math.max(960, workAreaSize.width - 48));
  const height = Math.min(960, Math.max(620, workAreaSize.height - 48));

  trace(`window: creating ${width}x${height} on a ${workAreaSize.width}x${workAreaSize.height} work area`);

  win = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: settings?.theme === 'light' ? '#f4f6f8' : '#0a0c10',
    title: 'Vela',
    icon: join(__dirname, '../../assets/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      // The renderer frames model-authored HTML in the preview tab, so it stays
      // sandboxed: no Node, no direct remote access, context isolated.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });
  trace('window: created');

  await win.loadFile(join(__dirname, '../renderer/index.html'));
  trace('window: renderer loaded');
  win.on('closed', () => {
    console.log('[vela] window closed');
    trace('window: closed');
    win = null;
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    trace(`window: renderer gone ${details.reason} (${details.exitCode})`);
    console.error('[vela] renderer gone:', details.reason, details.exitCode);
  });
}

// Windows groups taskbar buttons and picks the pinned identity by this id;
// without it the window is attributed to the generic Electron host.
app.setAppUserModelId('com.vela.app');

/**
 * Keep the existing profile across the Ironcode -> Vela rename. Only the small
 * app-data files move; browser caches are recreated by Electron. If migration
 * fails, the old profile stays authoritative instead of starting empty.
 */
function configureUserData(): void {
  const override = process.env.VELA_USER_DATA ?? process.env.IRONCODE_USER_DATA;
  if (override) {
    app.setPath('userData', override);
    return;
  }

  const appData = app.getPath('appData');
  const target = join(appData, 'Vela');
  const legacy = join(appData, 'Ironcode');
  if (!existsSync(target) && existsSync(legacy)) {
    try {
      mkdirSync(target, { recursive: true });
      for (const file of ['settings.json', 'projects.json', 'projects.json.bak', 'connectors.json']) {
        const from = join(legacy, file);
        if (existsSync(from)) cpSync(from, join(target, file));
      }
      for (const dir of ['chats', 'skills', 'Local Storage']) {
        const from = join(legacy, dir);
        if (existsSync(from)) cpSync(from, join(target, dir), { recursive: true });
      }
    } catch {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* leave the old profile as the fallback below */
      }
    }
  }

  app.setPath('userData', existsSync(target) || !existsSync(legacy) ? target : legacy);
}

configureUserData();

/**
 * Breadcrumbs for a launch that shows no window.
 *
 * A GUI build has no console, so a startup failure leaves the user with
 * "nothing happens" and no evidence. Every milestone and every crash appends a
 * line to `startup.log` in the profile, which is the only trail we can read
 * afterwards.
 */
function trace(message: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'startup.log'), `${new Date().toISOString()}  ${message}\n`);
  } catch {
    /* logging must never be the reason startup fails */
  }
}

trace(`boot: electron ${process.versions.electron}, node ${process.versions.node}, packaged=${app.isPackaged}`);

process.on('uncaughtException', err => {
  trace(`uncaught exception: ${(err as Error)?.stack ?? err}`);
  console.error('[vela] uncaught exception:', err);
});
process.on('unhandledRejection', reason => {
  trace(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  console.error('[vela] unhandled rejection:', reason);
});

app.on('render-process-gone', (_event, _contents, details) => {
  trace(`render process gone: ${details.reason} (${details.exitCode})`);
});

app.whenReady().then(async () => {
  trace('ready: whenReady resolved');
  settings = await loadSettings();
  trace(`settings loaded (theme=${settings.theme}, model=${settings.model})`);
  // The old direct-provider ids (`groq::…`) and `auto` are not Free LLM API
  // ids. Start on the requested Gemini Flash default.
  if (!settings.model || settings.model === 'auto' || settings.model.includes('::')) {
    settings.model = 'gemini-flash';
    await saveSettings(settings).catch(() => undefined);
  }
  // Project-less chats work in the user's profile folder unless changed.
  store = new Store(app.getPath('home'));
  await store.load();
  await migrateProjectsFolder();
  await store.ensureSomeChat();
  await recoverInterruptedTurn();
  // A fresh launch always opens the welcome canvas. Chats stay in the rail.
  await store.clearActive();
  trace('store ready');
  await skills.init();
  await connectors.load();
  await catalog.load();
  await providers.load();
  await usage.load();
  trace('subsystems loaded');

  gateway = new FreeLlmApiClient(
    settings.gatewayUrl || 'http://127.0.0.1:31415',
    settings.apiKey || '',
  );
  workspace = new Workspace(app.getPath('home'));
  syncWorkspace();

  agent = new Agent(gateway, workspace, skills, connectors, (event: AgentEvent) => {
    if (event.kind === 'usage') {
      void usage.add(event.model, event.prompt, event.completion, event.total);
    }
    if (event.kind === 'computer_active') {
      try {
        if (event.active) showControlOverlay();
        else hideControlOverlaySoon();
      } catch {
        // The turn must not fail just because a decorative overlay could not open.
      }
    }
    send('agent:event', event);
  }, url => shell.openExternal(url));

  // Persist the transcript the moment a turn settles, against the chat that
  // turn belonged to — switching chats mid-turn must not redirect the save.
  agent.onTurnComplete = (chatId, history) => {
    if (chatId) void store.writeHistory(chatId, history);
  };
  agent.onProgress = (chatId, history) => {
    if (chatId) void store.writeHistory(chatId, history);
  };

  const chatId = store.activeChatId();
  if (chatId) agent.setHistory(await store.readHistory(chatId), chatId);

  registerIpc();
  await createWindow();
}).catch(err => {
  // A throw in here used to leave no window and no message at all.
  trace(`FATAL startup: ${(err as Error)?.stack ?? err}`);
  dialog.showErrorBox('Vela не зміг запуститись', String((err as Error).stack ?? err));
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  console.log('[vela] all windows closed — quitting');
  trace('window-all-closed → quit');
  quitting = true;
  agent?.cancel();
  if (controlOverlayTimer) clearTimeout(controlOverlayTimer);
  if (controlOverlay && !controlOverlay.isDestroyed()) controlOverlay.destroy();
  preview.stop();
  // MCP servers are child processes; leaving them running would orphan them.
  connectors.closeAll();
  app.quit();
});

async function persistActiveChat(): Promise<void> {
  // Saves whatever the agent currently holds, under the chat it holds it for.
  const chatId = agent.currentChatId() ?? store.activeChatId();
  if (chatId) await store.writeHistory(chatId, agent.getHistory());
}

let quitting = false;

function turnMarkerPath(): string {
  return join(app.getPath('userData'), 'running-turn.json');
}

async function markTurn(chatId: string | null): Promise<void> {
  if (!chatId) return;
  try {
    await fs.writeFile(turnMarkerPath(), JSON.stringify({ chatId, at: Date.now() }), 'utf8');
  } catch {
    /* a read-only profile should not stop the turn */
  }
}

async function clearTurnMarker(): Promise<void> {
  try {
    await fs.unlink(turnMarkerPath());
  } catch {
    /* already gone */
  }
}

/** A quit in the middle of a turn leaves a marker; turn it into a visible note. */
async function recoverInterruptedTurn(): Promise<void> {
  let marker: { chatId?: string } | null = null;
  try {
    marker = JSON.parse(await fs.readFile(turnMarkerPath(), 'utf8')) as { chatId?: string };
  } catch {
    return;
  }
  try {
    if (marker?.chatId) {
      const history = await store.readHistory(marker.chatId);
      const last = history[history.length - 1];
      const completed = last?.role === 'assistant' && !last.tool_calls?.length;
      if (history.length && !completed) {
        history.push({
          role: 'assistant',
          content: 'Хід перервано: застосунок закрився до завершення відповіді. Натисни «Повторити», щоб отримати відповідь знову.',
          at: Date.now(),
        });
        await store.writeHistory(marker.chatId, history);
      }
    }
  } catch {
    // A damaged chat file cannot be allowed to block every future launch.
  } finally {
    await clearTurnMarker();
  }
}

/** Expand picked paths into attachments; one video yields several frames. */
async function collect(paths: string[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const path of paths) out.push(...await fromPath(path));
  return out;
}

/** Move the old default projects folder and fix the paths stored in the index. */
async function migrateProjectsFolder(): Promise<void> {
  const oldRoot = join(app.getPath('home'), 'IroncodeProjects');
  const newRoot = join(app.getPath('home'), 'VelaProjects');
  if (settings.projectsRoot !== oldRoot) return;

  if (!existsSync(oldRoot) && !existsSync(newRoot)) {
    settings.projectsRoot = newRoot;
    await saveSettings(settings);
    return;
  }

  let moved = false;
  if (!existsSync(newRoot) && existsSync(oldRoot)) {
    try {
      renameSync(oldRoot, newRoot);
      moved = true;
    } catch {
      // If the rename is locked, keep the old folder rather than losing sight
      // of every project that lives there.
      return;
    }
  }

  const target = existsSync(newRoot) ? newRoot : oldRoot;
  if (target === oldRoot) return;
  settings.projectsRoot = target;
  if (moved) await store.rebaseProjectPaths(oldRoot, newRoot);
  await saveSettings(settings);
}

function messageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter(part => part.type === 'text')
    .map(part => (part as { text?: string }).text ?? '')
    .join('\n');
}

/** Drop the previous answer and hand the agent its last user turn again. */
function trimForRetry(): { ok: true; text: string } | { ok: false; error: string } {
  const history = agent.getHistory();
  let index = history.length - 1;
  while (index >= 0 && history[index].role !== 'user') index--;
  if (index < 0) return { ok: false, error: 'Немає повідомлення, яке можна повторити.' };
  const text = messageText(history[index].content).trim();
  if (!text) return { ok: false, error: 'Останнє повідомлення порожнє.' };
  agent.setHistory(history.slice(0, index + 1), agent.currentChatId());
  return { ok: true, text };
}

function modelRankId(id: string): string {
  const index = id.indexOf('::');
  return index >= 0 ? id.slice(index + 2) : id;
}

function speedRank(row: { id: string; ms: number | null }): number {
  if (row.ms !== null) return row.ms;
  const id = modelRankId(row.id).toLowerCase();
  let rank = 1000;
  if (/(flash|mini|lite|nano|haiku|turbo|small)/.test(id)) rank -= 400;
  if (/(pro|opus|max|ultra|thinking|reasoning)/.test(id)) rank += 300;
  return rank;
}

/** Different strategies are just different orders for the same live models. */
function orderModels<T extends { id: string; ms: number | null }>(rows: T[]): T[] {
  if (settings.routingStrategy === 'smart') {
    return [...rows].sort((a, b) => modelScore(modelRankId(b.id)) - modelScore(modelRankId(a.id)));
  }
  if (settings.routingStrategy === 'fast') {
    return [...rows].sort((a, b) => {
      const time = speedRank(a) - speedRank(b);
      if (time !== 0) return time;
      return modelScore(modelRankId(b.id)) - modelScore(modelRankId(a.id));
    });
  }
  return [...rows].sort((a, b) => modelScore(modelRankId(b.id)) - modelScore(modelRankId(a.id)));
}

function normalizeGatewayUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

async function launchTurn(
  text: string,
  attachments: Attachment[],
  retry = false,
): Promise<{ ok: boolean; busy?: boolean; workspace?: boolean; error?: string }> {
  if (!store.hasSelection()) {
    send('agent:event', { kind: 'error', message: 'Спочатку створи чат.' });
    send('agent:event', { kind: 'turn_end', stopReason: 'error' });
    return { ok: false, error: 'Спочатку створи чат.' };
  }

  // Starting work in a folder that no longer exists would either fail
  // confusingly or, worse, let a tool recreate it somewhere unexpected.
  const root = store.activeWorkspacePath();
  const project = store.snapshot().projects.find(p => p.id === store.activeProjectId());
  const problem = await folderState(root);
  if (problem !== 'ok') {
    const message = folderProblemMessage(project ? 'project' : 'chats', root, problem);
    send('agent:event', {
      kind: 'workspace_missing',
      path: root,
      projectId: project?.id ?? null,
      scope: project ? 'project' : 'chats',
      message,
    });
    send('agent:event', { kind: 'turn_end', stopReason: 'workspace' });
    return { ok: false, error: message, workspace: true };
  }
  if (agent.busy) {
    // The renderer keeps its own queue; this is only a race guard, so the
    // message is not lost but handed back to be retried a moment later.
    return { ok: false, busy: true, error: 'Агент ще працює. Повідомлення піде одразу після завершення.' };
  }
  if (!providers.hasUsable()) {
    send('agent:event', { kind: 'error', message: 'Free LLM API не підключено. Відкрий Налаштування → Free LLM API.' });
    send('agent:event', { kind: 'turn_end', stopReason: 'error' });
    return { ok: false, error: 'Free LLM API не підключено. Відкрий Налаштування → Free LLM API.' };
  }

  if (retry) {
    const trimmed = trimForRetry();
    if (!trimmed.ok) {
      send('agent:event', { kind: 'error', message: trimmed.error });
      send('agent:event', { kind: 'turn_end', stopReason: 'error' });
      return { ok: false, error: trimmed.error };
    }
    text = trimmed.text;
    attachments = [];
    const chatId = agent.currentChatId();
    if (chatId) await store.writeHistory(chatId, agent.getHistory());
  }

  // Prefer a model whose window fits this turn. The estimate is deliberately
  // conservative (the real tokenizer lives on the provider side), but it is
  // enough to move a long conversation from, say, Sonnet to Opus before the
  // provider rejects it with a context-length error.
  const usable = catalog.cached().filter(row =>
    row.tools
    && !row.slot
    && row.verdict !== 'dead'
    && !settings.disabledModels.includes(row.id));
  const ordered = orderModels(usable);
  const snapshot = agent.contextSnapshot();
  const attachmentTokens = (attachments ?? []).reduce((sum, item) => {
    if (item.kind === 'text') return sum + estimateTokens(item.text);
    if (item.kind === 'image') return sum + 900;
    return sum + 80;
  }, 0);
  const needed = snapshot.total
    + estimateTokens(text)
    + attachmentTokens
    + (snapshot.system ? 0 : 2500);
  let model = settings.model;
  const current = usable.find(row => row.id === model);
  if (!current && model.includes('::')) {
    const bare = model.split('::').pop() ?? '';
    if (usable.some(row => row.id === bare)) {
      model = bare;
      settings.model = bare;
      await saveSettings(settings);
    }
  }
  if (current?.context && needed > current.context) {
    const fallback = pickFallbackModel(ordered, model, needed);
    if (fallback) {
      const reason = `Контекст ~${formatTokenCount(needed)} перевищує ліміт ${formatTokenCount(current.context)} у ${model}. Переходжу на ${fallback.id} (${formatTokenCount(fallback.context ?? 0)}).`;
      model = fallback.id;
      settings.model = model;
      await saveSettings(settings);
      send('agent:event', { kind: 'model_switch', model, reason });
    }
  }

  // The live catalogue order is also the fallback order: next is the closest
  // capable model rather than a hard-coded chain that may point at dead slots.
  const fallbacks = ordered.map(row => row.id);
  // Gemini Flash shares a daily quota with the heavier Gemini Flash revisions.
  // The lite route has its own quota and stays usable when that pool is empty;
  // put it immediately after the requested model instead of waiting through
  // every exhausted Gemini variant.
  const liteIndex = fallbacks.indexOf('gemini-3.1-flash-lite');
  if (liteIndex >= 0) fallbacks.splice(liteIndex, 1);
  fallbacks.splice(Math.min(1, fallbacks.length), 0, 'gemini-3.1-flash-lite');
  const turnChatId = agent.currentChatId();
  await markTurn(turnChatId);
  try {
    await agent.run(
      text,
      model,
      settings.approvalMode as ApprovalMode,
      store.activeProjectId(),
      attachments ?? [],
      [settings.instructions, store.projectInstructions(store.activeProjectId())],
      fallbacks,
      { internet: settings.allowInternet, files: settings.allowFiles, computer: settings.allowComputer },
      retry,
      store.activeChatReasoning(),
    );
  } finally {
    // A real quit keeps the marker so the next start can explain the break.
    if (!quitting) await clearTurnMarker();
  }
  return { ok: true };
}

async function folderExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A folder can be absent, be a file, or exist without being readable — a
 * distinction that matters when telling the user what actually happened.
 */
type FolderProblem = 'ok' | 'missing' | 'not-directory' | 'unreadable';

async function folderState(path: string): Promise<FolderProblem> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'missing';
  }
  if (!stat.isDirectory()) return 'not-directory';
  try {
    await fs.access(path, constants.R_OK);
    return 'ok';
  } catch {
    return 'unreadable';
  }
}

function folderProblemMessage(kind: 'project' | 'chats', path: string, problem: FolderProblem): string {
  const what = kind === 'project' ? 'Папку проєкту' : 'Теку чатів';
  if (problem === 'not-directory') return `${what} не знайдено. За цим шляхом лежить файл, а не папка: ${path}`;
  if (problem === 'unreadable') return `${what} існує, але недоступна. Перевір права доступу або мережевий диск: ${path}`;
  return `${what} не знайдено: ${path}. Можливо, її переміщено або перейменовано.`;
}

/** Huge or private trees are never where a coding project lives. */
const SEARCH_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', '.cache', '.next',
  'AppData', 'Windows', 'Program Files', 'Program Files (x86)', '$Recycle.Bin',
  'System Volume Information', 'OneDrive', 'Dropbox',
]);

/**
 * Look for a project folder that was moved or renamed by the user.
 *
 * This is intentionally a bounded search of likely places (the old parent,
 * the projects root, the profile, Desktop/Documents/Downloads) instead of a
 * full disk walk: it answers in a fraction of a second and cannot hang on a
 * disconnected network drive.
 */
async function findMovedProject(projectPath: string, projectName: string): Promise<string[]> {
  const wantedNames = [basename(projectPath), projectName.trim()].filter(Boolean);
  const wanted = new Set(wantedNames.map(name => name.toLowerCase()));
  const found = new Map<string, string>();
  const original = normalize(projectPath).toLowerCase();
  const budget = { left: 1800 };

  const add = async (candidate: string): Promise<void> => {
    const key = normalize(candidate).toLowerCase();
    if (key === original || found.has(key)) return;
    if (await folderState(candidate) === 'ok') found.set(key, candidate);
  };

  // "notatky-lost", "notatky-old", "notatky 2" are all common renames and are
  // worth offering as candidates; a completely different name still needs the
  // folder picker.
  const looksSimilar = (name: string): boolean => {
    const lower = name.toLowerCase();
    for (const wantedName of wanted) {
      if (lower === wantedName) return true;
      if (lower.startsWith(wantedName) && lower.length <= wantedName.length + 16) return true;
    }
    return false;
  };

  const scan = async (root: string, depth: number): Promise<void> => {
    if (budget.left <= 0) return;
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.left <= 0) return;
      if (!entry.isDirectory() || SEARCH_SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      budget.left--;
      const full = join(root, entry.name);
      if (looksSimilar(entry.name)) await add(full);
      if (depth > 1) await scan(full, depth - 1);
    }
  };

  const roots: Array<{ path: string; depth: number }> = [
    { path: dirname(projectPath), depth: 2 },
    { path: settings.projectsRoot, depth: 2 },
    { path: app.getPath('home'), depth: 2 },
    { path: app.getPath('desktop'), depth: 2 },
    { path: app.getPath('documents'), depth: 2 },
    { path: app.getPath('downloads'), depth: 2 },
  ];

  for (const root of roots) {
    if (!root.path) continue;
    for (const name of wantedNames) await add(join(root.path, name));
    await scan(root.path, root.depth);
  }

  return [...found.values()].slice(0, 12);
}

/**
 * Folders move, get renamed, or sit on a drive that is not plugged in. The UI
 * needs to say so plainly rather than let the agent fail with ENOENT halfway
 * through a task.
 */
async function uiState() {
  const snapshot = store.snapshot();
  const checks = await Promise.all(snapshot.projects.map(async project => ({
    id: project.id,
    path: project.path,
    problem: await folderState(project.path),
  })));
  const missing = checks.filter(c => c.problem !== 'ok');
  const chatsFolderProblem = await folderState(snapshot.chatsFolder);

  return {
    ...snapshot,
    /** So the rail can mark the chat that is still working. */
    runningChatId: agent?.busy ? agent.currentChatId() : null,
    maxChats: MAX_CHATS,
    workspaceRoot: workspace.root,
    /** A loose chat may carry its own folder; projects never do. */
    activeChatFolder: store.activeChatFolder(),
    /** Ids of projects whose folder is gone. */
    missingProjects: missing.map(c => c.id),
    /** Why each one is unusable, for a precise banner instead of "помилка". */
    projectProblems: missing,
    chatsFolderMissing: chatsFolderProblem !== 'ok',
    chatsFolderProblem,
    // Surfaced so a damaged project index is reported instead of looking like
    // the user simply had no projects.
    loadError: store.loadError(),
  };
}

function registerIpc(): void {
  /* ── settings ── */

  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', async (_e, incoming: Partial<Settings>) => {
    settings = { ...settings, ...incoming };
    try {
      await saveSettings(settings);
    } catch (err) {
      // The profile can be temporarily locked by antivirus or another process.
      // The in-memory setting must still apply, otherwise the model picker and
      // theme cards look broken for the rest of the session.
      trace(`settings save failed: ${(err as Error).message}`);
    }
    return settings;
  });

  ipcMain.handle('models:list', async () => ({
    models: await catalog.list(gateway),
    checkedAt: catalog.lastCheckedAt(),
  }));

  ipcMain.handle('models:probe', async () => {
    // Progress is streamed so a minute-long sweep shows a count, not a freeze.
    const summary = await catalog.probeAll(gateway, (done, total, id) => {
      send('models:progress', { done, total, id });
    });
    return { summary, models: await catalog.list(gateway), checkedAt: catalog.lastCheckedAt() };
  });

  ipcMain.handle('models:probe-one', async (_e, id: string) => {
    const row = catalog.cached().find(m => m.id === id);
    const result = await catalog.probeById(gateway, id, row?.tools ?? true);
    return { ok: result.verdict === 'ok', verdict: result.verdict, detail: result.detail };
  });

  /* ── direct providers ── */

  ipcMain.handle('freellmapi:save', async (_e, rawUrl: string, rawKey: string) => {
    const url = normalizeGatewayUrl(rawUrl);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      return { ok: false, error: 'Вкажи повну адресу, наприклад http://127.0.0.1:31415' };
    }
    const key = rawKey.trim() || settings.apiKey || '';
    if (!key) return { ok: false, error: 'Введи API-ключ Free LLM API.' };
    settings.gatewayUrl = url;
    settings.apiKey = key;
    try {
      await saveSettings(settings);
    } catch {
      /* in-memory connection must still work */
    }
    (gateway as FreeLlmApiClient).update(url, key);
    return { ok: true, url, keyMask: `${key.slice(0, 4)}…${key.slice(-4)}` };
  });

  ipcMain.handle('freellmapi:test', async () => {
    try {
      const health = await gateway.health();
      return { ok: health.ok, detail: health.detail, count: health.modelCount ?? 0 };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  });

  ipcMain.handle('providers:list', () => providers.summaries());

  ipcMain.handle('providers:save', async (_e, id: string, key: string, enabled: boolean) => {
    try {
      return { ok: true, provider: await providers.save(id, key, enabled) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('providers:test', async (_e, id: string) => {
    try {
      const provider = await providers.test(id);
      return {
        ok: provider.status === 'ok',
        provider,
        error: provider.status === 'ok' ? undefined : provider.detail,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('providers:setEnabled', async (_e, id: string, enabled: boolean) => {
    try {
      return { ok: true, provider: await providers.setEnabled(id, enabled) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('providers:remove', async (_e, id: string) => {
    await providers.remove(id);
    return { ok: true };
  });

  ipcMain.handle('usage:get', () => usage.snapshot());

  /* ── projects & chats ── */

  ipcMain.handle('ui:state', () => uiState());

  ipcMain.handle('project:create', async (_e, name: string, folder?: string) => {
    const safeName = (name ?? '').trim();
    if (!safeName && !folder) return { ok: false, error: 'Порожня назва' };
    if (agent?.busy) {
      return { ok: false, error: 'Агент зараз працює. Створи проєкт після завершення ходу.' };
    }
    const path = folder?.trim()
      || join(settings.projectsRoot, safeName.replace(/[\\/:*?"<>|]/g, '-'));
    try {
      const existing = await folderState(path);
      if (existing === 'not-directory') return { ok: false, error: `Це файл, а не папка: ${path}` };
      if (existing === 'unreadable') return { ok: false, error: `Папка недоступна: ${path}` };
      await store.createProject(safeName || basename(path), path);
      syncWorkspace();
      agent.setHistory([], store.activeChatId());
      return { ok: true, state: await uiState() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /** Folder picker shared by "new project" and "change the chats folder". */
  ipcMain.handle('folder:pick', async (_e, purpose: 'project' | 'chats' | 'chat') => {
    if (!win) return { ok: false };
    const title = purpose === 'project'
      ? 'Тека проєкту'
      : purpose === 'chat'
        ? 'Тека для цього чату'
        : 'Тека для звичайних чатів';
    const result = await dialog.showOpenDialog(win, {
      title,
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: purpose === 'project'
        ? settings.projectsRoot
        : purpose === 'chat'
          ? (store.activeChatFolder() ?? store.chatsFolder())
          : store.chatsFolder(),
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('chat:setFolder', async (_e, path: string) => {
    if (!store.hasSelection()) return { ok: false, error: 'Спочатку створи чат.' };
    if (store.activeProjectId()) {
      return { ok: false, error: 'У проєкті агент працює лише в папці проєкту.' };
    }
    if (agent?.busy) {
      return { ok: false, error: 'Агент зараз працює. Зміни папку після завершення ходу.' };
    }
    const problem = await folderState(path);
    if (problem !== 'ok') {
      return { ok: false, error: folderProblemMessage('chats', path, problem) };
    }
    const chatId = store.activeChatId();
    if (!chatId) return { ok: false, error: 'Спочатку створи чат.' };
    const saved = await store.setChatFolder(chatId, path);
    if (!saved) return { ok: false, error: 'Не вдалося прив’язати папку до чату.' };
    syncWorkspace();
    return { ok: true, state: await uiState() };
  });

  ipcMain.handle('chat:setReasoning', async (_e, chatId: string, effort: string) => {
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
      return { ok: false, error: 'Невідомий рівень зусилля.' };
    }
    const saved = await store.setChatReasoning(chatId, effort);
    if (!saved) return { ok: false, error: 'Чат не знайдено.' };
    return { ok: true, state: await uiState() };
  });

  ipcMain.handle('chats:setFolder', async (_e, path: string) => {
    const problem = await folderState(path);
    if (problem !== 'ok') {
      throw new Error(folderProblemMessage('chats', path, problem));
    }
    if (agent?.busy) {
      throw new Error('Агент зараз працює. Зміни теку після завершення ходу.');
    }
    await store.setChatsFolder(path);
    syncWorkspace();
    return await uiState();
  });

  ipcMain.handle('project:rename', async (_e, projectId: string, name: string) => {
    await store.renameProject(projectId, name);
    return uiState();
  });

  ipcMain.handle('project:delete', async (_e, projectId: string) => {
    await store.deleteProject(projectId);
    syncWorkspace();
    const chatId = store.activeChatId();
    agent.setHistory(chatId ? await store.readHistory(chatId) : [], chatId);
    return { state: await uiState(), messages: agent.getHistory() };
  });

  ipcMain.handle('project:find', async (_e, projectId: string) => {
    const project = store.snapshot().projects.find(p => p.id === projectId);
    if (!project) return { ok: false, error: 'Проєкт не знайдено', candidates: [] as string[] };
    try {
      return { ok: true, candidates: await findMovedProject(project.path, project.name) };
    } catch (err) {
      return { ok: false, error: (err as Error).message, candidates: [] as string[] };
    }
  });

  /** Point an existing project at a folder that has moved. */
  ipcMain.handle('project:relocate', async (_e, projectId: string, selectedPath?: string) => {
    const current = store.snapshot().projects.find(p => p.id === projectId);
    if (!current) return { ok: false, error: 'Проєкт не знайдено' };
    if (agent?.busy) {
      return {
        ok: false,
        error: 'Агент зараз працює. Зупини хід або дочекайся завершення. Інакше частина роботи піде в стару папку.',
      };
    }

    let target = selectedPath?.trim();
    if (!target) {
      if (!win) return { ok: false, error: 'Вікно недоступне' };
      const result = await dialog.showOpenDialog(win, {
        title: `Де тепер папка проєкту «${current.name}»?`,
        properties: ['openDirectory'],
        defaultPath: (await folderExists(dirname(current.path))) ? dirname(current.path) : settings.projectsRoot,
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      target = result.filePaths[0];
    }

    const state = await folderState(target);
    if (state !== 'ok') return { ok: false, error: folderProblemMessage('project', target, state) };

    await store.relocateProject(projectId, target);
    syncWorkspace();
    return { ok: true, state: await uiState() };
  });

  ipcMain.handle('project:instructions', async (_e, projectId: string, text: string) => {
    await store.setProjectInstructions(projectId, text ?? '');
    return uiState();
  });

  ipcMain.handle('project:reveal', async (_e, projectId: string) => {
    const project = store.snapshot().projects.find(p => p.id === projectId);
    if (!project) return false;
    if (!(await folderExists(project.path))) return false;
    return (await shell.openPath(project.path)) === '';
  });

  ipcMain.handle('pin:toggle', async (_e, targetId: string) => {
    await store.togglePin(targetId);
    return await uiState();
  });

  ipcMain.handle('chat:create', async (_e, projectId: string | null) => {
    if (agent?.busy) {
      return { ok: false, error: 'Агент зараз працює. Новий чат можна створити після завершення.' };
    }
    await persistActiveChat();
    const chat = await store.createChat(projectId ?? null);
    if (!chat) return { ok: false, error: `Ліміт: ${MAX_CHATS} чатів у проєкті` };
    syncWorkspace();
    agent.setHistory([], chat.id);
    return { ok: true, state: await uiState() };
  });

  ipcMain.handle('chat:select', async (_e, projectId: string | null, chatId: string) => {
    // Re-opening the chat whose turn is still running must not kill it, and
    // must hand back what it has produced so far.
    if (agent.isRunningFor(chatId)) {
      await store.setActive(projectId ?? null, chatId);
      syncWorkspace();
      return { state: await uiState(), messages: agent.getHistory(), running: true };
    }

    await persistActiveChat();
    agent.cancel();
    await store.setActive(projectId ?? null, chatId);
    syncWorkspace();
    agent.setHistory(await store.readHistory(chatId), chatId);
    return { state: await uiState(), messages: agent.getHistory(), running: false };
  });

  ipcMain.handle('chat:history', async (_e, chatId: string) => store.readHistory(chatId));

  ipcMain.handle('chat:rename', async (_e, chatId: string, title: string) => {
    await store.renameChat(chatId, title);
    return await uiState();
  });

  ipcMain.handle('chat:delete', async (_e, chatId: string) => {
    await store.deleteChat(chatId);
    syncWorkspace();
    const active = store.activeChatId();
    agent.setHistory(active ? await store.readHistory(active) : [], active);
    return { state: await uiState(), messages: agent.getHistory() };
  });

  ipcMain.handle('chat:clear', async () => {
    agent.reset();
    await persistActiveChat();
    return true;
  });

  /* ── skills ── */

  ipcMain.handle('skills:list', () => skills.list());

  ipcMain.handle('skills:install-github', async (_e, url: string) => {
    try {
      return { ok: true, skill: await skills.installFromGitHub(url) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('skills:save', async (_e, input: { name: string; description: string; body: string; always: boolean }) => {
    try {
      return { ok: true, skill: await skills.save(input) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('skills:delete', async (_e, name: string) => {
    await skills.remove(name);
    return true;
  });

  ipcMain.handle('skills:import', async () => {
    if (!win) return { ok: false };
    const result = await dialog.showOpenDialog(win, {
      title: 'Імпортувати скіл з .md файлу',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'mdx'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    try {
      return { ok: true, skill: await skills.importFile(result.filePaths[0]) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('skills:reveal', async () => {
    await shell.openPath(skills.folder());
    return true;
  });

  /* ── connectors ── */

  ipcMain.handle('connectors:list', () => connectors.list());

  ipcMain.handle('connectors:save', async (_e, input: Partial<Connector> & { name: string }) => {
    try {
      const saved = await connectors.save(input);
      const { env, headers, ...safe } = saved;
      return { ok: true, connector: safe };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('connectors:delete', async (_e, id: string) => {
    await connectors.remove(id);
    return true;
  });

  ipcMain.handle('connectors:test', (_e, id: string) => connectors.test(id));

  ipcMain.handle('connectors:disconnect', (_e, id: string) => {
    connectors.disconnect(id);
    return true;
  });

  /* ── files ── */

  ipcMain.handle('workspace:tree', async () => {
    interface Node { name: string; path: string; dir: boolean; children?: Node[] }

    if (!store.hasSelection()) return { root: '', nodes: [] };

    async function walk(dir: string, depth: number): Promise<Node[]> {
      if (depth > 4) return [];
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      entries.sort((a, b) =>
        a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
      );
      const nodes: Node[] = [];
      for (const e of entries.slice(0, 400)) {
        if (IGNORED_IN_TREE.has(e.name)) continue;
        const full = join(dir, e.name);
        nodes.push({
          name: e.name,
          path: workspace.display(full),
          dir: e.isDirectory(),
          ...(e.isDirectory() ? { children: await walk(full, depth + 1) } : {}),
        });
      }
      return nodes;
    }

    return { root: workspace.root, nodes: await walk(workspace.root, 1) };
  });

  ipcMain.handle('file:read', async (_e, relPath: string) => {
    try {
      const abs = workspace.safe(relPath);
      const stat = await fs.stat(abs);
      if (stat.size > 2_000_000) return { ok: false, error: 'Файл завеликий для редактора (>2 МБ)' };
      return { ok: true, content: await fs.readFile(abs, 'utf8') };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('image:read', async (_e, relPath: string) => {
    try {
      const abs = workspace.safe(relPath);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return { ok: false, error: 'Це не файл.' };
      if (stat.size > 16 * 1024 * 1024) return { ok: false, error: 'Зображення завелике.' };
      const lower = abs.toLowerCase();
      const mime = lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'image/jpeg'
        : lower.endsWith('.webp')
          ? 'image/webp'
          : lower.endsWith('.gif')
            ? 'image/gif'
            : lower.endsWith('.png')
              ? 'image/png'
              : '';
      if (!mime) return { ok: false, error: 'Підтримуються PNG, JPG, WebP і GIF.' };
      const data = await fs.readFile(abs);
      return { ok: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('shell:run', async (_e, command: string) => {
    if (!settings.allowFiles) return { ok: false, output: 'Керування файлами вимкнено в дозволах.' };
    if (!command.trim()) return { ok: false, output: 'Порожня команда.' };
    return await new Promise<{ ok: boolean; output: string }>(resolve => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { cwd: workspace.root, timeout: 60_000, maxBuffer: 2_000_000, windowsHide: true },
        (err, stdout, stderr) => {
          const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, 24_000);
          resolve({ ok: !err, output: output || (err ? `ПОМИЛКА: ${err.message}` : '') });
        },
      );
    });
  });

  ipcMain.handle('file:save', async (_e, relPath: string, content: string) => {
    try {
      await fs.writeFile(workspace.safe(relPath), content, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /* ── agent ── */

  ipcMain.handle('attach:pick', async () => {
    if (!win) return { ok: false, items: [] as Attachment[] };
    const result = await dialog.showOpenDialog(win, {
      title: 'Додати до повідомлення',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Усе підтримуване', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'mov', 'webm', 'mkv', 'txt', 'md', 'json', 'csv', 'log', 'ts', 'js', 'html', 'css', 'py'] },
        { name: 'Зображення', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'Відео', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] },
        { name: 'Усі файли', extensions: ['*'] },
      ],
    });
    if (result.canceled) return { ok: false, items: [] as Attachment[] };
    return { ok: true, items: await collect(result.filePaths) };
  });

  ipcMain.handle('attach:paths', async (_e, paths: string[]) => ({
    ok: true,
    items: await collect(paths ?? []),
  }));

  ipcMain.handle('attach:bytes', (_e, name: string, bytes: Uint8Array) => ({
    ok: true,
    items: [fromBytes(name || 'вставлене зображення', bytes)],
  }));

  ipcMain.handle('attach:videoSupport', () => hasVideoSupport());

  ipcMain.handle('agent:send', async (_e, text: string, attachments: Attachment[] = []) => {
    return launchTurn(text, attachments, false);
  });

  ipcMain.handle('agent:retry', async () => {
    return launchTurn('', [], true);
  });

  ipcMain.handle('agent:context', () => agent.contextSnapshot());

  ipcMain.on('agent:cancel', () => agent.cancel(true));
  ipcMain.on('agent:approve', (_e, id: string, ok: boolean) => agent.resolveApproval(id, ok));

  /* ── preview ── */

  ipcMain.handle('preview:start', async () => {
    if (!store.hasSelection()) return { ok: false, error: 'Немає активного чату' };
    try {
      return { ok: true, url: await preview.start(workspace.root) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('external:open', async (_e, url: string) => {
    // Chat links may point anywhere the model found; only web and mail schemes
    // are handed to the OS, never file:// or custom protocol handlers.
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });
}
