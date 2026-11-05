/** Renderer: owns the DOM only. All privileged work goes through window.ironcode. */

import { highlight, langFromPath } from './highlight.js';
import { renderMarkdown } from './markdown.js';
import { modelScore } from '../shared/model-rank.js';

/* ───────────── types ───────────── */

interface Settings {
  model: string;
  projectsRoot: string;
  approvalMode: 'ask' | 'auto' | 'turbo';
  instructions: string;
  allowInternet: boolean;
  allowFiles: boolean;
  allowComputer: boolean;
  theme: 'indigo' | 'light' | 'dark';
  disabledModels: string[];
  routingStrategy: 'balanced' | 'smart' | 'fast';
  gatewayUrl: string;
  apiKey: string;
  leftWidth: number;
  rightWidth: number;
  rightCollapsed: boolean;
  leftCollapsed: boolean;
}

interface ChatMeta { id: string; title: string; createdAt: number; updatedAt: number; folder?: string; reasoning?: 'low' | 'medium' | 'high' }
interface Project { id: string; name: string; path: string; createdAt: number; chats: ChatMeta[]; instructions?: string }
interface ProjectProblem { id: string; path: string; problem: 'missing' | 'not-directory' | 'unreadable' }
interface UiState {
  projects: Project[];
  /** Chats that belong to no project; they all work in `chatsFolder`. */
  chats: ChatMeta[];
  chatsFolder: string;
  activeProjectId: string | null;
  activeChatId: string | null;
  /** Ids of pinned chats and projects. */
  pinned: string[];
  /** The chat whose turn is still running, if any. */
  runningChatId: string | null;
  /** Ids of projects whose folder is gone from disk. */
  missingProjects: string[];
  /** The precise reason each project folder is unusable. */
  projectProblems?: ProjectProblem[];
  chatsFolderMissing: boolean;
  chatsFolderProblem?: 'ok' | 'missing' | 'not-directory' | 'unreadable';
  maxChats: number;
  workspaceRoot: string;
  /** Custom folder of a project-less chat, when one was picked. */
  activeChatFolder: string | null;
  loadError: string | null;
}

type Attachment =
  | { kind: 'image'; name: string; dataUrl: string; note?: string }
  | { kind: 'text'; name: string; text: string }
  | { kind: 'error'; name: string; message: string };

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ToolCall { id: string; function: { name: string; arguments: string } }
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  at?: number;
}

interface Skill { name: string; description: string; always: boolean; body: string }

interface ConnectorSummary {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  scope: 'all' | 'selected';
  projects: string[];
  secretKeys: string[];
  status: 'idle' | 'ready' | 'error';
  statusDetail: string;
  toolCount: number;
}
interface ModelRow {
  id: string;
  name: string;
  context: number | null;
  tools: boolean;
  /** Direct provider id, absent for FreeLLMAPI entries. */
  provider?: string;
  /** Advertised router slot without real parameter metadata. */
  slot: boolean;
  /** Provider/model accepts a reasoning-effort control. */
  reasoning: boolean;
  /** What the last probe found: 'ok' answered, 'dead' refused, 'unknown' untested. */
  verdict: 'ok' | 'dead' | 'unknown';
  ms: number | null;
  detail: string;
}

interface ProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  hint: string;
  docs: string;
  configured: boolean;
  enabled: boolean;
  keyMask: string;
  status: 'unknown' | 'ok' | 'error';
  detail: string;
  checkedAt: number | null;
  modelCount: number | null;
}

interface UsageSnapshot {
  month: string;
  models: Record<string, { prompt: number; completion: number; total: number; requests: number }>;
  total: number;
}

interface ContextSnapshot {
  system: number;
  tools: number;
  messages: number;
  total: number;
  messageCount: number;
  model: string;
}

interface ExtensionPreset {
  id: string;
  name: string;
  description: string;
  developer: string;
  category: 'Розробка' | 'Дані' | 'Продуктивність' | 'Фічі';
  color: string;
  initial: string;
  kind: 'connector' | 'instruction';
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  envKeys?: string[];
  url?: string;
  skillName?: string;
}

const EXTENSION_PRESETS: ExtensionPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Репозиторії, issues, pull requests і пошук коду.',
    developer: 'GitHub',
    category: 'Розробка',
    color: '#6e7681',
    initial: 'GH',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'filesystem',
    name: 'Файлова система',
    description: 'Доступ до вибраної теки з контрольованими правами.',
    developer: 'Model Context Protocol',
    category: 'Дані',
    color: '#3b82f6',
    initial: 'FS',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/Users/Admin'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Запити й схема бази без ручного SQL-клієнта.',
    developer: 'Model Context Protocol',
    category: 'Дані',
    color: '#336791',
    initial: 'PG',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Локальні бази даних, таблиці й запити.',
    developer: 'Model Context Protocol',
    category: 'Дані',
    color: '#0f80cc',
    initial: 'DB',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', 'C:/data/app.db'],
  },
  {
    id: 'puppeteer',
    name: 'Браузер',
    description: 'Відкриває сторінки, читає DOM і робить знімки.',
    developer: 'Model Context Protocol',
    category: 'Продуктивність',
    color: '#00a67e',
    initial: 'BR',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  {
    id: 'memory',
    name: 'Пам\'ять',
    description: 'Зберігає факти й повертає їх у наступних запитах.',
    developer: 'Model Context Protocol',
    category: 'Продуктивність',
    color: '#8b5cf6',
    initial: 'MM',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'sequential',
    name: 'Покрокове мислення',
    description: 'Розбиває складну задачу на послідовні кроки.',
    developer: 'Model Context Protocol',
    category: 'Фічі',
    color: '#f59e0b',
    initial: 'ST',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'brave',
    name: 'Brave Search',
    description: 'Веб-пошук без відкриття браузера вручну.',
    developer: 'Brave',
    category: 'Продуктивність',
    color: '#fb542b',
    initial: 'BS',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envKeys: ['BRAVE_API_KEY'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Повідомлення, канали й пошук по робочому чату.',
    developer: 'Slack',
    category: 'Продуктивність',
    color: '#4a154b',
    initial: 'SL',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Сторінки, бази й робочі простори через MCP.',
    developer: 'Notion',
    category: 'Продуктивність',
    color: '#111111',
    initial: 'N',
    kind: 'connector',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    description: 'Файли й теки Google Drive у робочій папці агента.',
    developer: 'Google',
    category: 'Продуктивність',
    color: '#1a73e8',
    initial: 'GD',
    kind: 'connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    envKeys: ['GDRIVE_CREDENTIALS_PATH', 'GDRIVE_TOKEN_PATH'],
  },
  {
    id: 'writing-style',
    name: 'Стиль письма',
    description: 'Живий розмовний стиль, короткі речення, без емодзі.',
    developer: 'Vela',
    category: 'Фічі',
    color: '#eab308',
    initial: 'W',
    kind: 'instruction',
    skillName: 'writing-style',
  },
  {
    id: 'code-review',
    name: 'Огляд коду',
    description: 'Порядок перевірки коду й формат знахідок.',
    developer: 'Vela',
    category: 'Розробка',
    color: '#22c55e',
    initial: 'CR',
    kind: 'instruction',
    skillName: 'code-review',
  },
  {
    id: 'static-site',
    name: 'Статичний сайт',
    description: 'Семантика, адаптивність і доступність без зайвих залежностей.',
    developer: 'Vela',
    category: 'Розробка',
    color: '#0ea5e9',
    initial: 'SS',
    kind: 'instruction',
    skillName: 'static-site',
  },
];
interface TreeNode { name: string; path: string; dir: boolean; children?: TreeNode[] }

type AgentEvent =
  | { kind: 'status'; text: string }
  | { kind: 'model'; model: string; note?: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'text'; delta: string }
  | { kind: 'tool_start'; id: string; name: string; args: unknown }
  | { kind: 'tool_end'; id: string; ok: boolean; result: string }
  | { kind: 'approval'; id: string; name: string; args: unknown; detail: string }
  | { kind: 'model_switch'; model: string; reason: string }
  | {
      kind: 'workspace_missing';
      path: string;
      projectId: string | null;
      scope: 'project' | 'chats';
      message: string;
    }
  | { kind: 'workspace_lost'; path: string; projectId: string | null; message: string }
  | { kind: 'turn_end'; stopReason: string }
  | { kind: 'computer_active'; active: boolean }
  | { kind: 'usage'; model: string; prompt: number; completion: number; total: number }
  | { kind: 'error'; message: string };

declare const ironcode: {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  listModels(): Promise<{ models: ModelRow[]; checkedAt: number | null }>;
  probeModels(): Promise<{
    summary: { ok: number; dead: number; total: number };
    models: ModelRow[];
    checkedAt: number | null;
  }>;
  probeModel(id: string): Promise<{ ok: boolean; verdict: string; detail: string }>;
  listProviders(): Promise<ProviderSummary[]>;
  saveFreeLlmApi(url: string, key: string): Promise<{ ok: boolean; url?: string; keyMask?: string; error?: string }>;
  testFreeLlmApi(): Promise<{ ok: boolean; detail: string; count: number }>;
  saveProvider(id: string, key: string, enabled: boolean): Promise<{ ok: boolean; provider?: ProviderSummary; error?: string }>;
  testProvider(id: string): Promise<{ ok: boolean; provider?: ProviderSummary; error?: string }>;
  setProviderEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; provider?: ProviderSummary; error?: string }>;
  removeProvider(id: string): Promise<{ ok: boolean }>;
  getUsage(): Promise<UsageSnapshot>;
  onModelProgress(handler: (p: { done: number; total: number; id: string }) => void): void;
  state(): Promise<UiState>;
  createProject(name: string, folder?: string): Promise<{ ok: boolean; state?: UiState; error?: string }>;
  pickFolder(purpose: 'project' | 'chats' | 'chat'): Promise<{ ok: boolean; path?: string }>;
  setChatsFolder(path: string): Promise<UiState>;
  setChatFolder(path: string): Promise<{ ok: boolean; state?: UiState; error?: string }>;
  setChatReasoning(chatId: string, effort: 'low' | 'medium' | 'high'): Promise<{ ok: boolean; state?: UiState; error?: string }>;
  togglePin(targetId: string): Promise<UiState>;
  renameProject(id: string, name: string): Promise<UiState>;
  deleteProject(id: string): Promise<{ state: UiState; messages: ChatMessage[] }>;
  revealProject(id: string): Promise<boolean>;
  relocateProject(id: string, path?: string): Promise<{ ok: boolean; state?: UiState; error?: string; canceled?: boolean }>;
  findProjectFolder(id: string): Promise<{ ok: boolean; candidates: string[]; error?: string }>;
  setProjectInstructions(id: string, text: string): Promise<UiState>;
  createChat(projectId: string | null): Promise<{ ok: boolean; state?: UiState; error?: string }>;
  selectChat(projectId: string | null, chatId: string): Promise<{ state: UiState; messages: ChatMessage[]; running?: boolean }>;
  renameChat(chatId: string, title: string): Promise<UiState>;
  deleteChat(chatId: string): Promise<{ state: UiState; messages: ChatMessage[] }>;
  clearChat(): Promise<boolean>;
  listSkills(): Promise<Skill[]>;
  saveSkill(input: Omit<Skill, never>): Promise<{ ok: boolean; skill?: Skill; error?: string }>;
  deleteSkill(name: string): Promise<boolean>;
  importSkill(): Promise<{ ok: boolean; skill?: Skill; error?: string }>;
  installSkillFromGithub(url: string): Promise<{ ok: boolean; skill?: Skill; error?: string }>;
  revealSkills(): Promise<boolean>;
  listConnectors(): Promise<ConnectorSummary[]>;
  saveConnector(input: unknown): Promise<{ ok: boolean; connector?: ConnectorSummary; error?: string }>;
  deleteConnector(id: string): Promise<boolean>;
  testConnector(id: string): Promise<{ ok: boolean; detail: string; tools: string[] }>;
  disconnectConnector(id: string): Promise<boolean>;
  tree(): Promise<{ root: string; nodes: TreeNode[] }>;
  readFile(path: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  readImage(path: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  saveFile(path: string, content: string): Promise<{ ok: boolean; error?: string }>;
  runShell(command: string): Promise<{ ok: boolean; output: string }>;
  send(text: string, attachments?: Attachment[]): Promise<{
    ok: boolean;
    busy?: boolean;
    workspace?: boolean;
    error?: string;
  }>;
  retryLast(): Promise<{
    ok: boolean;
    busy?: boolean;
    workspace?: boolean;
    error?: string;
  }>;
  context(): Promise<ContextSnapshot>;
  pickAttachments(): Promise<{ ok: boolean; items: Attachment[] }>;
  attachPaths(paths: string[]): Promise<{ ok: boolean; items: Attachment[] }>;
  attachBytes(name: string, bytes: Uint8Array): Promise<{ ok: boolean; items: Attachment[] }>;
  videoSupport(): Promise<boolean>;
  filePath(file: File): string;
  cancel(): void;
  approve(id: string, ok: boolean): void;
  startPreview(): Promise<{ ok: boolean; url?: string; error?: string }>;
  openExternal(url: string): Promise<{ ok: boolean }>;
  onAgentEvent(handler: (event: AgentEvent) => void): void;
};

/* ───────────── element handles ───────────── */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  layout: $('layout'),
  leftPanel: $('leftPanel'),
  rightPanel: $('rightPanel'),
  splitLeft: $('splitLeft'),
  splitRight: $('splitRight'),
  toggleLeft: $<HTMLButtonElement>('toggleLeft'),
  toggleRight: $<HTMLButtonElement>('toggleRight'),

  projectLabel: $('projectLabel'),
  probeBtn: $<HTMLButtonElement>('probeBtn'),
  modeBtn: $<HTMLButtonElement>('modeBtn'),
  modeBtnLabel: $('modeBtnLabel'),
  modeBtnUse: document.getElementById('modeBtnUse') as unknown as SVGUseElement,
  modePop: $('modePop'),
  settingsBtn: $<HTMLButtonElement>('settingsBtn'),

  railList: $('railList'),
  addBtn: $<HTMLButtonElement>('addBtn'),
  chatsFolderBtn: $<HTMLButtonElement>('chatsFolderBtn'),
  chatsFolderLabel: $('chatsFolderLabel'),
  loadWarning: $('loadWarning'),
  pluginCount: $('pluginCount'),
  pluginInstructionCount: $('pluginInstructionCount'),
  pluginToolCount: $('pluginToolCount'),
  pluginGithubUrl: $<HTMLInputElement>('pluginGithubUrl'),
  pluginGithubInstall: $<HTMLButtonElement>('pluginGithubInstall'),
  pluginGithubStatus: $('pluginGithubStatus'),
  extensionSearch: $<HTMLInputElement>('extensionSearch'),
  extensionCategories: $('extensionCategories'),
  extensionCatalog: $('extensionCatalog'),
  railSettingsBtn: $<HTMLButtonElement>('railSettingsBtn'),

  messages: $('messages'),
  noChat: $('noChat'),
  noChatNew: $<HTMLButtonElement>('noChatNew'),
  noChatProject: $<HTMLButtonElement>('noChatProject'),
  chatTitle: $('chatTitle'),
  chatPath: $<HTMLButtonElement>('chatPath'),
  promptSave: $<HTMLButtonElement>('promptSave'),
  workspaceAlert: $('workspaceAlert'),
  computerBanner: $('computerBanner'),
  jumpBottom: $<HTMLButtonElement>('jumpBottom'),
  composer: $('composer'),
  attachBtn: $<HTMLButtonElement>('attachBtn'),
  chatFolderBtn: $<HTMLButtonElement>('chatFolderBtn'),
  attachBox: $('attachBox'),
  queueBox: $('queueBox'),
  dropHint: $('dropHint'),
  input: $<HTMLTextAreaElement>('input'),
  mentionPop: $('mentionPop'),
  sendBtn: $<HTMLButtonElement>('sendBtn'),
  sendLabel: $('sendLabel'),
  stopBtn: $<HTMLButtonElement>('stopBtn'),
  modelBtn: $<HTMLButtonElement>('modelBtn'),
  modelBtnName: $('modelBtnName'),
  modelBtnLimit: $('modelBtnLimit'),
  modelPop: $('modelPop'),
  effortBtn: $<HTMLButtonElement>('effortBtn'),
  effortLabel: $('effortLabel'),
  effortPop: $('effortPop'),
  effortModel: $('effortModel'),
  modelList: $('modelList'),
  contextBtn: $<HTMLButtonElement>('contextBtn'),
  contextPercent: $('contextPercent'),
  contextPop: $('contextPop'),
  ctxArc: document.getElementById('ctxArc') as unknown as SVGCircleElement,
  ctxModelName: $('ctxModelName'),
  ctxPercentBig: $('ctxPercentBig'),
  ctxTotal: $('ctxTotal'),
  ctxFill: $('ctxFill'),
  ctxRows: $('ctxRows'),
  approval: $('approval'),
  apTitle: $('apTitle'),
  apDetail: $('apDetail'),
  apArtifact: $('apArtifact'),
  apYes: $<HTMLButtonElement>('apYes'),
  apNo: $<HTMLButtonElement>('apNo'),

  tree: $('tree'),
  refreshTree: $<HTMLButtonElement>('refreshTree'),
  quickOpenBtn: $<HTMLButtonElement>('quickOpenBtn'),
  paneFiles: $('paneFiles'),
  paneEditor: $('paneEditor'),
  panePreview: $('panePreview'),
  toolsFiles: $('toolsFiles'),
  toolsEditor: $('toolsEditor'),
  toolsPreview: $('toolsPreview'),

  editorPath: $('editorPath'),
  editorDirty: $('editorDirty'),
  editor: $<HTMLTextAreaElement>('editor'),
  codeHl: $('codeHl'),
  codeScroll: $('codeScroll'),
  gutterInner: $('gutterInner'),
  saveBtn: $<HTMLButtonElement>('saveBtn'),

  previewEmpty: $('previewEmpty'),
  previewFrame: $<HTMLIFrameElement>('previewFrame'),
  previewStart: $<HTMLButtonElement>('previewStart'),
  previewReload: $<HTMLButtonElement>('previewReload'),
  previewOpen: $<HTMLButtonElement>('previewOpen'),

  projectDlg: $<HTMLDialogElement>('projectDlg'),
  projectName: $<HTMLInputElement>('projectName'),
  projectPath: $<HTMLInputElement>('projectPath'),
  projectBrowse: $<HTMLButtonElement>('projectBrowse'),
  projectPathNote: $('projectPathNote'),
  projectCreate: $<HTMLButtonElement>('projectCreate'),

  skillsList: $('skillsList'),
  skillName: $<HTMLInputElement>('skillName'),
  skillDesc: $<HTMLInputElement>('skillDesc'),
  skillAlways: $<HTMLInputElement>('skillAlways'),
  skillBody: $<HTMLTextAreaElement>('skillBody'),
  skillSave: $<HTMLButtonElement>('skillSave'),
  skillNew: $<HTMLButtonElement>('skillNew'),
  skillDelete: $<HTMLButtonElement>('skillDelete'),
  skillImport: $<HTMLButtonElement>('skillImport'),
  skillReveal: $<HTMLButtonElement>('skillReveal'),

  settingsDlg: $<HTMLDialogElement>('settingsDlg'),
  settingsClose: $<HTMLButtonElement>('settingsClose'),
  settingsProbe: $<HTMLButtonElement>('settingsProbe'),
  settingsModelList: $('settingsModelList'),
  routingStrategy: $<HTMLSelectElement>('routingStrategy'),
  usageTotal: $('usageTotal'),
  freellmUrl: $<HTMLInputElement>('freellmUrl'),
  freellmKey: $<HTMLInputElement>('freellmKey'),
  freellmStatus: $('freellmStatus'),
  freellmSave: $<HTMLButtonElement>('freellmSave'),
  freellmTest: $<HTMLButtonElement>('freellmTest'),
  providerList: $('providerList'),
  setRoot: $<HTMLInputElement>('setRoot'),
  setResetLayout: $<HTMLInputElement>('setResetLayout'),
  setInstructions: $<HTMLTextAreaElement>('setInstructions'),
  setSave: $<HTMLButtonElement>('setSave'),
  permInternet: $<HTMLInputElement>('permInternet'),
  permFiles: $<HTMLInputElement>('permFiles'),
  permComputer: $<HTMLInputElement>('permComputer'),
  permSave: $<HTMLButtonElement>('permSave'),

  promptDlg: $<HTMLDialogElement>('promptDlg'),
  promptGlobal: $<HTMLTextAreaElement>('promptGlobal'),
  promptProject: $<HTMLTextAreaElement>('promptProject'),
  promptProjectBlock: $('promptProjectBlock'),
  promptProjectName: $('promptProjectName'),
  promptState: $('promptState'),
  recoverDlg: $<HTMLDialogElement>('recoverDlg'),
  recoverList: $('recoverList'),
  recoverNote: $('recoverNote'),
  recoverBrowse: $<HTMLButtonElement>('recoverBrowse'),
  toast: $('toast'),

  connectorsList: $('connectorsList'),
  connName: $<HTMLInputElement>('connName'),
  connDesc: $<HTMLInputElement>('connDesc'),
  connTransport: $<HTMLSelectElement>('connTransport'),
  stdioFields: $('stdioFields'),
  httpFields: $('httpFields'),
  connCommand: $<HTMLInputElement>('connCommand'),
  connArgs: $<HTMLTextAreaElement>('connArgs'),
  connEnv: $<HTMLTextAreaElement>('connEnv'),
  connUrlField: $<HTMLInputElement>('connUrlField'),
  connHeaders: $<HTMLTextAreaElement>('connHeaders'),
  connEnabled: $<HTMLInputElement>('connEnabled'),
  connScope: $<HTMLSelectElement>('connScope'),
  connectorHealth: $('connectorHealth'),
  connectorTest: $<HTMLButtonElement>('connectorTest'),
  connectorNew: $<HTMLButtonElement>('connectorNew'),
  connectorSave: $<HTMLButtonElement>('connectorSave'),
  connectorDelete: $<HTMLButtonElement>('connectorDelete'),

  quickOpen: $('quickOpen'),
  quickInput: $<HTMLInputElement>('quickInput'),
  quickResults: $('quickResults'),
  ctxMenu: $('ctxMenu'),
};

/* ───────────── state ───────────── */

interface MessageHandle {
  wrap: HTMLElement;
  bubble: HTMLElement;
  meta: HTMLElement;
  raw: string;
  at: number;
}

interface QueuedTurn {
  id: string;
  text: string;
  attachments: Attachment[];
  at: number;
}

type SettingsTab = 'general' | 'appearance' | 'permissions' | 'freellmapi' | 'models' | 'extensions';

let settings: Settings;
let state: UiState;
let skills: Skill[] = [];
let extensionCategory = 'Усі';
let extensionQuery = '';
let models: ModelRow[] = [];
let providers: ProviderSummary[] = [];
let usageSnapshot: UsageSnapshot | null = null;
let contextState: ContextSnapshot | null = null;
let filePaths: string[] = [];
let dirPaths: string[] = [];

let previewUrl: string | null = null;
let openFile: string | null = null;
let savedContent = '';
let running = false;
let networkDown = false;
let computerBannerTimer = 0;
/** Files staged for the next message. */
let staged: Attachment[] = [];
let turnContextFiles = new Set<string>();
let currentUserBubble: HTMLElement | null = null;
/**
 * Messages typed while a turn was running. Kept per chat: switching to another
 * conversation and back must not move one chat's pending prompt into another
 * or lose it on the way.
 */
const queues = new Map<string, QueuedTurn[]>();

let activeMessage: MessageHandle | null = null;
let activeReasoning: HTMLElement | null = null;
/** Assistant bubbles belonging to the current turn, finalized at its end. */
let turnAssistants: MessageHandle[] = [];

/**
 * Streaming state.
 *
 * The assistant's reply is kept as raw Markdown and re-rendered, rather than
 * appended to a text node: formatting only exists once the whole block is
 * there. Re-parsing is O(n), so it is throttled — every frame would burn the
 * CPU on a long answer for changes nobody can read that fast.
 */
let assistantRaw = '';
let reasoningNode: Text | null = null;
let pendingReasoning = '';
let flushQueued = false;
let lastMarkdownAt = 0;

const MARKDOWN_INTERVAL = 120;

function paintAssistant(): void {
  if (!activeMessage) return;
  activeMessage.raw = assistantRaw;
  activeMessage.bubble.replaceChildren(renderMarkdown(assistantRaw));
  decorateFileCodes(activeMessage.bubble);
  if (activeMessage.bubble.querySelector('.md-image[data-path]')) void hydrateImages(activeMessage.bubble);
  lastMarkdownAt = performance.now();
}

function flushStream(): void {
  flushQueued = false;
  if (activeMessage && performance.now() - lastMarkdownAt >= MARKDOWN_INTERVAL) {
    paintAssistant();
  }
  if (pendingReasoning && reasoningNode) {
    reasoningNode.appendData(pendingReasoning);
    pendingReasoning = '';
  }
  scroll();
}

/** Land every pending byte immediately — used when a turn or message ends. */
function finishStream(): void {
  if (activeMessage) paintAssistant();
  if (pendingReasoning && reasoningNode) {
    reasoningNode.appendData(pendingReasoning);
    pendingReasoning = '';
  }
  scroll();
}

function queueFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(flushStream);
}
let pendingApprovalId: string | null = null;
const toolCards = new Map<string, HTMLElement>();

interface ToolGroup {
  wrap: HTMLElement;
  head: HTMLButtonElement;
  label: HTMLElement;
  body: HTMLElement;
  live: HTMLElement;
  done: number;
  failed: number;
}

/** Finished tool calls of the current turn, collapsed behind one row. */
let toolGroup: ToolGroup | null = null;

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return n + ' дія';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return n + ' дії';
  return n + ' дій';
}

function ensureToolGroup(): ToolGroup {
  if (toolGroup) return toolGroup;

  const wrap = document.createElement('div');
  wrap.className = 'tool-group';

  const head = document.createElement('button');
  head.className = 'tool-group-head hidden';
  head.type = 'button';
  head.append(icon('i-chevron'));
  const label = document.createElement('span');
  head.append(label);

  const body = document.createElement('div');
  body.className = 'tool-group-body hidden';

  const live = document.createElement('div');
  live.className = 'tool-group-live';

  head.addEventListener('click', () => {
    const open = body.classList.toggle('hidden');
    wrap.classList.toggle('open', !open);
  });

  wrap.append(head, body, live);
  el.messages.append(wrap);
  toolGroup = { wrap, head, label, body, live, done: 0, failed: 0 };
  return toolGroup;
}

function updateGroupLabel(group: ToolGroup): void {
  group.head.classList.toggle('hidden', group.done === 0);
  group.label.textContent = plural(group.done) + ' виконано';
  if (group.failed > 0) {
    const fail = document.createElement('span');
    fail.className = 'fail';
    fail.textContent = ', ' + group.failed + ' з помилкою';
    group.label.append(fail);
  }
}

function closeToolGroup(): void {
  toolGroup = null;
}

/** The pulsing dots shown while a turn is in flight, plus its elapsed time. */
let thinkingEl: HTMLElement | null = null;
let thinkingClock: number | null = null;
let turnStarted = 0;

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} хв ${String(seconds).padStart(2, '0')} с`;
}

function showThinking(): void {
  if (thinkingEl) return;
  clearPlaceholder();
  turnStarted = Date.now();

  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.title = 'Агент працює';
  for (let i = 0; i < 3; i++) thinkingEl.append(document.createElement('i'));

  const clock = document.createElement('span');
  clock.className = 'thinking-time';
  clock.textContent = '0 с';
  thinkingEl.append(clock);

  el.messages.append(thinkingEl);
  // A visible clock is the difference between "it is working" and "it is stuck".
  thinkingClock = window.setInterval(() => {
    clock.textContent = formatElapsed(Date.now() - turnStarted);
  }, 500);

  scroll(true);
}

function hideThinking(): void {
  if (thinkingClock !== null) {
    clearInterval(thinkingClock);
    thinkingClock = null;
  }
  thinkingEl?.remove();
  thinkingEl = null;
}

/** Leave the turn's duration behind, so past turns can be compared. */
function stampTurnDuration(): void {
  if (!turnStarted) return;
  const elapsed = Date.now() - turnStarted;
  turnStarted = 0;
  // Sub-second turns are noise; they are almost always an immediate error.
  if (elapsed < 1000) return;
  const note = document.createElement('div');
  note.className = 'turn-time';
  note.textContent = `думав ${formatElapsed(elapsed)}`;
  el.messages.append(note);
  scroll();
}

/** Appending an existing node moves it, keeping the dots below new content. */
function keepThinkingLast(): void {
  if (thinkingEl) el.messages.append(thinkingEl);
}

/* ───────────── layout: splitters & panel toggles ───────────── */

const LIMITS = { leftMin: 180, leftMax: 460, rightMin: 280, rightMax: 900 };

/**
 * Below this width the file tree would squeeze the conversation into a column
 * of five words. It becomes an overlay instead, closed by default and opened by
 * the same topbar button — the persisted wide-layout preference is untouched.
 */
const NARROW_LAYOUT = 1120;
let wasNarrow = false;
let narrowRightHidden = false;

function isNarrow(): boolean {
  return window.innerWidth < NARROW_LAYOUT;
}

function applyLayout(): void {
  if (!settings) return;
  const narrow = isNarrow();
  if (narrow !== wasNarrow) {
    wasNarrow = narrow;
    if (narrow) narrowRightHidden = true;
  }
  const rightHidden = narrow ? narrowRightHidden : settings.rightCollapsed;

  document.documentElement.style.setProperty('--left-w', `${settings.leftWidth}px`);
  document.documentElement.style.setProperty('--right-w', `${settings.rightWidth}px`);
  el.layout.classList.toggle('no-left', settings.leftCollapsed);
  el.layout.classList.toggle('no-right', rightHidden);
  el.layout.classList.toggle('narrow', narrow);
  el.toggleLeft.classList.toggle('on', !settings.leftCollapsed);
  el.toggleRight.classList.toggle('on', !rightHidden);
}

function dragSplitter(handle: HTMLElement, side: 'left' | 'right'): void {
  handle.addEventListener('mousedown', down => {
    down.preventDefault();
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const startX = down.clientX;
    const startW = side === 'left' ? settings.leftWidth : settings.rightWidth;

    const move = (e: MouseEvent) => {
      // The right panel grows as the cursor moves left, hence the inverted delta.
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
      const min = side === 'left' ? LIMITS.leftMin : LIMITS.rightMin;
      const max = side === 'left' ? LIMITS.leftMax : LIMITS.rightMax;
      const width = Math.min(max, Math.max(min, startW + delta));
      if (side === 'left') settings.leftWidth = width;
      else settings.rightWidth = width;
      applyLayout();
    };

    const up = async () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      // Persist once at the end, not on every mousemove.
      settings = await ironcode.setSettings({
        leftWidth: settings.leftWidth,
        rightWidth: settings.rightWidth,
      });
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // Double-click restores the default width for that side.
  handle.addEventListener('dblclick', async () => {
    if (side === 'left') settings.leftWidth = 250;
    else settings.rightWidth = 460;
    applyLayout();
    settings = await ironcode.setSettings({
      leftWidth: settings.leftWidth,
      rightWidth: settings.rightWidth,
    });
  });
}

async function togglePanel(side: 'left' | 'right'): Promise<void> {
  if (side === 'right' && isNarrow()) {
    narrowRightHidden = !narrowRightHidden;
    applyLayout();
    return;
  }
  if (side === 'left') settings.leftCollapsed = !settings.leftCollapsed;
  else settings.rightCollapsed = !settings.rightCollapsed;
  applyLayout();
  settings = await ironcode.setSettings({
    leftCollapsed: settings.leftCollapsed,
    rightCollapsed: settings.rightCollapsed,
  });
}

window.addEventListener('resize', applyLayout);

el.toggleLeft.addEventListener('click', () => void togglePanel('left'));
el.toggleRight.addEventListener('click', () => void togglePanel('right'));

/* ───────────── chat rendering ───────────── */

function clearPlaceholder(): void {
  el.messages.querySelector('.placeholder')?.remove();
}

function atBottom(): boolean {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;
}

/**
 * Follow the bottom only while the user is already there — scrolling up to
 * read must not be yanked back down by the next token.
 *
 * The decision is kept as a flag updated from real scroll events rather than
 * measured at write time: collapsing a tool group changes scrollHeight
 * abruptly, and a measurement taken mid-change read as "not at the bottom"
 * and silently stopped following for the rest of the turn.
 */
let stickToBottom = true;

function updateJumpButton(): void {
  el.jumpBottom.classList.toggle('hidden', atBottom());
}

el.messages.addEventListener('scroll', () => {
  stickToBottom = atBottom();
  updateJumpButton();
});

function scroll(force = false): void {
  if (force) stickToBottom = true;
  if (stickToBottom) el.messages.scrollTop = el.messages.scrollHeight;
  updateJumpButton();
}

el.jumpBottom.addEventListener('click', () => scroll(true));

/** File codes and markdown links are shortcuts; images open a viewer. */
el.messages.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  const link = target.closest<HTMLElement>('.md-link');
  if (link) {
    e.preventDefault();
    const href = link.dataset.href;
    if (href) void openLink(href);
    return;
  }
  const image = target.closest<HTMLImageElement>('img');
  if (image && (image.classList.contains('md-image') || image.closest('.msg-attachments'))) {
    e.preventDefault();
    openLightbox(image);
    return;
  }
  const code = target.closest<HTMLElement>('.file-code');
  if (!code) return;
  const path = code.textContent?.trim();
  if (path) void openInEditor(path);
});

el.messages.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const link = (e.target as HTMLElement).closest<HTMLElement>('.md-link');
  if (!link) return;
  e.preventDefault();
  const href = link.dataset.href;
  if (href) void openLink(href);
});

/** A user message may be parts; pull out the prose and the images separately. */
function splitContent(content: ChatMessage['content']): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const text = content.filter(p => p.type === 'text').map(p => (p as any).text).join('\n');
  const images = content
    .filter(p => p.type === 'image_url')
    .map(p => (p as any).image_url.url as string);
  return { text, images };
}

function attachImagesTo(bubble: HTMLElement, images: string[]): void {
  if (!images.length) return;
  const box = document.createElement('div');
  box.className = 'msg-attachments';
  for (const url of images) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'вкладення';
    box.append(img);
  }
  bubble.append(box);
}

/** Inline code that names a project file becomes a shortcut to the editor. */
function decorateFileCodes(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>('.md-code')) {
    const text = code.textContent?.trim() ?? '';
    if (!text || text.length > 180 || /[\n]/.test(text)) continue;
    if (!/[\\/]|\.[a-z0-9]{1,8}$/i.test(text)) continue;
    if (/^(https?:|npm |npx |cd |git |node |powershell|pwsh)/i.test(text)) continue;
    code.classList.add('file-code');
    code.title = `Відкрити ${text} у редакторі`;
  }
  for (const link of root.querySelectorAll<HTMLElement>('.md-link')) {
    const href = link.dataset.href;
    if (!href) continue;
    const target = localTarget(href);
    if (!target) continue;
    link.classList.add('file-link');
    link.title = target.line ? `${target.path}, рядок ${target.line}` : target.path;
  }
}

function localTarget(href: string): { path: string; line?: number } | null {
  const raw = href.replace(/^<|>$/g, '').trim();
  if (!raw || /^(javascript|data|vbscript):/i.test(raw)) return null;
  if (/^(https?:|mailto:)/i.test(raw)) return null;
  let path = raw;
  let line: number | undefined;
  const hash = /#L(\d+)$/.exec(path);
  if (hash) {
    line = Number(hash[1]);
    path = path.slice(0, hash.index);
  } else {
    const colon = /^(.*):(\d+)$/.exec(path);
    if (colon && !/^[a-z]:$/i.test(colon[1])) {
      path = colon[1];
      line = Number(colon[2]);
    }
  }
  return path ? { path: decodeURIComponent(path), line } : null;
}

async function openLink(href: string): Promise<void> {
  if (/^(https?:|mailto:)/i.test(href)) {
    const res = await ironcode.openExternal(href);
    if (!res.ok) toast('Не вдалося відкрити посилання.');
    return;
  }
  const target = localTarget(href);
  if (target) await openInEditor(target.path, undefined, target.line);
}

async function hydrateImages(root: HTMLElement): Promise<void> {
  const images = [...root.querySelectorAll<HTMLImageElement>('.md-image[data-path]')];
  await Promise.all(images.map(async img => {
    const path = img.dataset.path;
    if (!path) return;
    const res = await ironcode.readImage(path);
    if (res.ok && res.dataUrl) {
      img.src = res.dataUrl;
      img.removeAttribute('data-path');
    } else {
      const error = document.createElement('span');
      error.className = 'md-image-error';
      error.textContent = res.error ?? `Не вдалося показати ${path}`;
      img.replaceWith(error);
    }
  }));
}

interface Lightbox {
  root: HTMLElement;
  image: HTMLImageElement;
  caption: HTMLElement;
  counter: HTMLElement;
  close: HTMLButtonElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
}

let lightbox: Lightbox | null = null;
let lightboxImages: Array<{ src: string; alt: string }> = [];
let lightboxIndex = 0;

function ensureLightbox(): Lightbox {
  if (lightbox) return lightbox;
  const root = document.createElement('div');
  root.className = 'lightbox hidden';
  root.innerHTML = `
    <button type="button" class="lightbox-close" title="Закрити">×</button>
    <button type="button" class="lightbox-prev" title="Попереднє">‹</button>
    <img class="lightbox-image" alt="" />
    <button type="button" class="lightbox-next" title="Наступне">›</button>
    <div class="lightbox-foot"><span class="lightbox-counter"></span><span class="lightbox-caption"></span></div>
  `;
  document.body.append(root);
  lightbox = {
    root,
    image: root.querySelector('.lightbox-image') as HTMLImageElement,
    caption: root.querySelector('.lightbox-caption') as HTMLElement,
    counter: root.querySelector('.lightbox-counter') as HTMLElement,
    close: root.querySelector('.lightbox-close') as HTMLButtonElement,
    prev: root.querySelector('.lightbox-prev') as HTMLButtonElement,
    next: root.querySelector('.lightbox-next') as HTMLButtonElement,
  };
  lightbox.close.addEventListener('click', closeLightbox);
  lightbox.prev.addEventListener('click', () => showLightbox(lightboxIndex - 1));
  lightbox.next.addEventListener('click', () => showLightbox(lightboxIndex + 1));
  root.addEventListener('click', event => {
    if (event.target === root) closeLightbox();
  });
  return lightbox;
}

function showLightbox(index: number): void {
  if (!lightboxImages.length) return;
  const box = ensureLightbox();
  lightboxIndex = (index + lightboxImages.length) % lightboxImages.length;
  const item = lightboxImages[lightboxIndex];
  box.image.src = item.src;
  box.image.alt = item.alt;
  box.caption.textContent = item.alt;
  box.counter.textContent = `${lightboxIndex + 1} з ${lightboxImages.length}`;
  box.root.classList.remove('hidden');
  box.prev.classList.toggle('hidden', lightboxImages.length < 2);
  box.next.classList.toggle('hidden', lightboxImages.length < 2);
}

function closeLightbox(): void {
  lightbox?.root.classList.add('hidden');
}

function openLightbox(image: HTMLImageElement): void {
  const all = [...el.messages.querySelectorAll<HTMLImageElement>('img')].filter(img => img.src);
  lightboxImages = all.map(img => ({ src: img.src, alt: img.alt || 'Зображення' }));
  showLightbox(Math.max(0, all.indexOf(image)));
}

document.addEventListener('keydown', event => {
  if (!lightbox || lightbox.root.classList.contains('hidden')) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') showLightbox(lightboxIndex - 1);
  if (event.key === 'ArrowRight') showLightbox(lightboxIndex + 1);
});

/* ── message meta: time, copy, feedback ── */

function formatRelative(at: number): string {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'щойно';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} хв тому`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн тому`;
  return new Date(at).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const FEEDBACK_STORE = 'ironcode:feedback';
let feedback: Record<string, 1 | -1> = (() => {
  try {
    return JSON.parse(localStorage.getItem(FEEDBACK_STORE) ?? '{}') as Record<string, 1 | -1>;
  } catch {
    return {};
  }
})();

function saveFeedback(): void {
  try {
    localStorage.setItem(FEEDBACK_STORE, JSON.stringify(feedback));
  } catch {
    /* private mode or a full disk: the vote is still shown for this session */
  }
}

function feedbackKey(handle: MessageHandle): string {
  return `${state?.activeChatId ?? 'none'}:${handle.at}:${hashText(handle.raw)}`;
}

function metaButton(iconId: string, title: string, act: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meta-btn';
  button.title = title;
  button.dataset.act = act;
  button.append(icon(iconId));
  return button;
}

function createMeta(role: 'user' | 'assistant', at: number): HTMLElement {
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  if (at) {
    const time = document.createElement('time');
    time.dateTime = new Date(at).toISOString();
    time.textContent = formatRelative(at);
    time.title = new Date(at).toLocaleString('uk-UA');
    meta.append(time);
  }

  if (role === 'assistant') {
    meta.append(metaButton('i-retry', 'Повторити відповідь', 'retry'));
  }
  meta.append(metaButton('i-copy', 'Копіювати', 'copy'));
  if (role === 'assistant') {
    meta.append(
      metaButton('i-thumb-up', 'Корисна відповідь', 'up'),
      metaButton('i-thumb-down', 'Не те', 'down'),
    );
  }
  return meta;
}

function syncRetryButtons(): void {
  const assistants = [...el.messages.querySelectorAll<HTMLElement>('.msg.assistant')];
  const last = assistants[assistants.length - 1];
  const lastUser = [...el.messages.querySelectorAll<HTMLElement>('.msg.user')].pop();
  const canRetry = Boolean(last && (!lastUser
    || (lastUser.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING)));
  assistants.forEach(node => {
    const button = node.querySelector<HTMLElement>('[data-act="retry"]');
    if (button) button.classList.toggle('hidden', node !== last || !canRetry);
  });
}

function wireMeta(handle: MessageHandle): void {
  handle.meta.addEventListener('click', async e => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.meta-btn');
    if (!button) return;
    e.stopPropagation();
    const act = button.dataset.act;

    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(handle.raw);
        button.classList.add('saved');
        const oldTitle = button.title;
        button.title = 'Скопійовано';
        window.setTimeout(() => {
          button.classList.remove('saved');
          button.title = oldTitle;
        }, 1400);
      } catch {
        toast('Не вдалося скопіювати');
      }
      return;
    }

  if (act === 'retry') {
    await retryAssistant(handle);
    return;
  }

    if (act === 'up' || act === 'down') {
      const key = feedbackKey(handle);
      const vote: 1 | -1 = act === 'up' ? 1 : -1;
      const next = feedback[key] === vote ? 0 : vote;
      if (next) feedback[key] = next;
      else delete feedback[key];
      saveFeedback();
      const up = handle.meta.querySelector<HTMLElement>('[data-act="up"]');
      const down = handle.meta.querySelector<HTMLElement>('[data-act="down"]');
      up?.classList.toggle('on', feedback[key] === 1);
      down?.classList.toggle('on', feedback[key] === -1);
      toast(feedback[key] === 1 ? 'Позначено як корисне' : feedback[key] === -1 ? 'Позначено як не те' : 'Оцінку знято');
    }
  });

  // Persist a vote across history re-renders.
  const key = feedbackKey(handle);
  const vote = feedback[key];
  if (vote) {
    handle.meta.querySelector<HTMLElement>('[data-act="up"]')?.classList.toggle('on', vote === 1);
    handle.meta.querySelector<HTMLElement>('[data-act="down"]')?.classList.toggle('on', vote === -1);
  }
}

function finalizeAssistant(handle: MessageHandle): void {
  handle.raw = handle.raw || '';
  handle.meta.classList.remove('hidden');
  const time = handle.meta.querySelector('time');
  if (time) time.textContent = formatRelative(handle.at);
  // The raw text is only complete now, so this is when the vote key is stable.
  const key = feedbackKey(handle);
  const vote = feedback[key];
  handle.meta.querySelector<HTMLElement>('[data-act="up"]')?.classList.toggle('on', vote === 1);
  handle.meta.querySelector<HTMLElement>('[data-act="down"]')?.classList.toggle('on', vote === -1);
}

function addMessage(
  role: 'user' | 'assistant',
  text = '',
  markdown = false,
  opts: { at?: number; done?: boolean } = {},
): MessageHandle {
  clearPlaceholder();
  // Prose ends the current run of tool calls.
  closeToolGroup();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  // The user's own text stays verbatim; only the model's reply is formatted.
  if (markdown) {
    bubble.append(renderMarkdown(text));
    decorateFileCodes(bubble);
    if (bubble.querySelector('.md-image[data-path]')) void hydrateImages(bubble);
  } else {
    bubble.textContent = text;
  }

  const at = opts.at !== undefined ? opts.at : Date.now();
  const meta = createMeta(role, at);
  const handle: MessageHandle = { wrap, bubble, meta, raw: text, at };
  wireMeta(handle);
  wrap.append(bubble, meta);
  meta.classList.toggle('hidden', !(opts.done ?? role === 'user'));
  el.messages.append(wrap);
  if (role === 'assistant') turnAssistants.push(handle);
  syncRetryButtons();
  keepThinkingLast();
  scroll(true);
  return handle;
}

function addSystem(text: string, cls = ''): void {
  clearPlaceholder();
  const node = document.createElement('div');
  node.className = `sys ${cls}`.trim();
  node.textContent = text;
  el.messages.append(node);
  keepThinkingLast();
  scroll();
}

function summarizeArgs(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, 180);
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  for (const key of ['path', 'command', 'pattern', 'name']) {
    if (typeof obj[key] === 'string') return String(obj[key]).slice(0, 180);
  }
  return JSON.stringify(obj).slice(0, 180);
}

function toolIcon(name: string): string {
  if (name === 'read_file') return 'i-file';
  if (name === 'write_file' || name === 'edit_file' || name === 'make_dir') return 'i-pencil';
  if (name === 'list_dir' || name === 'search_files') return 'i-search';
  if (name === 'run_shell') return 'i-chevron';
  if (name === 'delete_path') return 'i-trash';
  if (name === 'use_skill') return 'i-book';
  if (name === 'open_url' || name === 'web_fetch' || name === 'web_search') return 'i-globe';
  if (name === 'computer') return 'i-monitor';
  return 'i-sliders';
}

interface ArtifactCard {
  node: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  args: Record<string, unknown>;
  name: string;
}

const artifactCards = new Map<string, ArtifactCard>();
const terminalCards = new Map<string, { node: HTMLElement; command: string; output: HTMLElement; state: HTMLElement }>();

function createTerminalCard(id: string, rawArgs: unknown): void {
  if (terminalCards.has(id)) return;
  const args = toolArgs(rawArgs);
  const command = String(args.command ?? '');
  const card = document.createElement('div');
  card.className = 'terminal-card';

  const head = document.createElement('div');
  head.className = 'terminal-head';
  const label = document.createElement('span');
  label.className = 'terminal-label';
  label.textContent = 'PowerShell';
  const state = document.createElement('span');
  state.className = 'terminal-state running';
  state.textContent = 'виконую…';
  const actions = document.createElement('div');
  actions.className = 'terminal-actions';

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'artifact-btn';
  run.textContent = 'Run';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'artifact-btn';
  edit.textContent = 'Edit';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'artifact-btn';
  cancel.textContent = 'Cancel';
  actions.append(run, edit, cancel);

  const commandEl = document.createElement('pre');
  commandEl.className = 'terminal-command';
  commandEl.textContent = command;
  const output = document.createElement('pre');
  output.className = 'terminal-output';
  output.textContent = 'очікую виводу…';

  run.addEventListener('click', async () => {
    state.className = 'terminal-state running';
    state.textContent = 'виконую…';
    output.textContent = '';
    const current = commandEl.textContent ?? command;
    const res = await ironcode.runShell(current);
    output.textContent = res.output || '(немає виводу)';
    state.className = `terminal-state ${res.ok ? 'ok' : 'bad'}`;
    state.textContent = res.ok ? 'готово' : 'помилка';
  });
  edit.addEventListener('click', () => {
    commandEl.contentEditable = 'true';
    commandEl.classList.add('editing');
    commandEl.focus();
  });
  commandEl.addEventListener('blur', () => {
    commandEl.contentEditable = 'false';
    commandEl.classList.remove('editing');
  });
  cancel.addEventListener('click', () => {
    state.className = 'terminal-state bad';
    state.textContent = 'скасовано';
    card.classList.add('cancelled');
  });

  head.append(icon('i-terminal'), label, state, actions);
  card.append(head, commandEl, output);
  el.messages.append(card);
  terminalCards.set(id, { node: card, command, output, state });
  keepThinkingLast();
  scroll();
}

function finishTerminalCard(id: string, ok: boolean, result: string): void {
  const card = terminalCards.get(id);
  if (!card) return;
  card.output.textContent = result;
  card.state.className = `terminal-state ${ok ? 'ok' : 'bad'}`;
  card.state.textContent = ok ? 'готово' : 'помилка';
  terminalCards.delete(id);
}


function toolArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fileLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ({ ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', css: 'CSS', html: 'HTML', json: 'JSON', md: 'Markdown', py: 'Python' } as Record<string, string>)[ext] ?? 'Код';
}

function diffRows(oldText: string, newText: string): Array<{ kind: 'add' | 'del' | 'eq'; text: string }> {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // Keep the preview cheap for very large edits; apply still works on the full strings.
  const max = 360;
  if (oldLines.length > max || newLines.length > max || oldLines.length * newLines.length > 90_000) {
    return [
      ...oldLines.slice(0, max).map(text => ({ kind: 'del' as const, text })),
      ...newLines.slice(0, max).map(text => ({ kind: 'add' as const, text })),
    ];
  }
  const dp = Array.from({ length: oldLines.length + 1 }, () => new Uint16Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ kind: 'add' | 'del' | 'eq'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'eq', text: oldLines[i] }); i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: oldLines[i++] });
    } else {
      out.push({ kind: 'add', text: newLines[j++] });
    }
  }
  while (i < oldLines.length) out.push({ kind: 'del', text: oldLines[i++] });
  while (j < newLines.length) out.push({ kind: 'add', text: newLines[j++] });
  return out;
}

function createArtifactCard(id: string, name: string, rawArgs: unknown): void {
  if (name === 'run_shell') {
    createTerminalCard(id, rawArgs);
    return;
  }
  if (name !== 'write_file' && name !== 'edit_file') return;
  if (artifactCards.has(id)) return;
  const args = toolArgs(rawArgs);
  const path = String(args.path ?? 'файл');
  const write = name === 'write_file';
  const oldText = String(args.old_str ?? '');
  const newText = write ? String(args.content ?? '') : String(args.new_str ?? '');

  const card = document.createElement('div');
  card.className = 'artifact';

  const head = document.createElement('div');
  head.className = 'artifact-head';
  const iconEl = icon(write ? 'i-file-plus' : 'i-file');
  const title = document.createElement('span');
  title.className = 'artifact-title';
  title.textContent = path;
  const meta = document.createElement('span');
  meta.className = 'artifact-meta';
  meta.textContent = `${fileLanguage(path)} · ${write ? 'новий вміст' : 'diff'}${write ? ` · ${newText.split('\n').length} рядків` : ''}`;
  const status = document.createElement('span');
  status.className = 'artifact-status running';
  status.textContent = write ? 'записую…' : 'застосовую…';
  const actions = document.createElement('div');
  actions.className = 'artifact-actions';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'artifact-btn';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async e => {
    e.stopPropagation();
    await navigator.clipboard.writeText(write ? newText : diffRows(oldText, newText).map(r => `${r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}${r.text}`).join('\n'));
    copy.textContent = 'Copied';
    window.setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
  });

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'artifact-btn';
  open.textContent = 'Open';
  open.addEventListener('click', e => { e.stopPropagation(); void openInEditor(path); });

  actions.append(copy, open);
  head.append(iconEl, title, meta, status, actions);

  const body = document.createElement('div');
  body.className = 'artifact-body';
  if (write) {
    const pre = document.createElement('pre');
    pre.className = 'artifact-code';
    pre.textContent = newText.slice(0, 60_000);
    body.append(pre);
  } else {
    const diff = document.createElement('div');
    diff.className = 'artifact-diff';
    for (const row of diffRows(oldText, newText).slice(0, 500)) {
      const line = document.createElement('div');
      line.className = `diff-line ${row.kind}`;
      line.textContent = `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '} ${row.text}`;
      diff.append(line);
    }
    body.append(diff);
  }

  card.append(head, body);
  el.messages.append(card);
  artifactCards.set(id, { node: card, body, status, args, name });
  keepThinkingLast();
  scroll();
}

function finishArtifactCard(id: string, ok: boolean): void {
  const card = artifactCards.get(id);
  if (!card) return;
  card.status.className = `artifact-status ${ok ? 'ok' : 'bad'}`;
  card.status.textContent = ok ? 'застосовано' : 'помилка';
  artifactCards.delete(id);
}

function noteContextFile(name: string, args: unknown): void {
  if (name !== 'read_file') return;
  const path = String(toolArgs(args).path ?? '').trim();
  if (path) turnContextFiles.add(path);
}

function finishContextBadge(): void {
  if (!currentUserBubble || !turnContextFiles.size) {
    turnContextFiles.clear();
    return;
  }
  const wrap = currentUserBubble.closest('.msg');
  if (wrap) {
    const badge = document.createElement('div');
    badge.className = 'context-badge';
    const label = document.createElement('span');
    label.textContent = `Used ${turnContextFiles.size} file${turnContextFiles.size === 1 ? '' : 's'} as context`;
    badge.append(label);
    let shown = 0;
    for (const path of turnContextFiles) {
      if (shown++ >= 4) break;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'context-file';
      chip.textContent = path.split(/[\\/]/).pop() ?? path;
      chip.title = path;
      chip.addEventListener('click', () => void openInEditor(path));
      badge.append(chip);
    }
    wrap.append(badge);
  }
  turnContextFiles.clear();
  currentUserBubble = null;
}

function renderApprovalArtifact(name: string, rawArgs: unknown): void {
  const args = toolArgs(rawArgs);
  el.apArtifact.innerHTML = '';
  const isWrite = name === 'write_file';
  const isEdit = name === 'edit_file';
  const isShell = name === 'run_shell';
  if (!isWrite && !isEdit && !isShell) {
    el.apArtifact.classList.add('hidden');
    el.apYes.textContent = 'Дозволити';
    el.apNo.textContent = 'Відмовити';
    return;
  }
  el.apArtifact.classList.remove('hidden');
  if (isWrite || isEdit) {
    const path = String(args.path ?? 'файл');
    const label = document.createElement('div');
    label.className = 'approval-artifact-label';
    label.textContent = `${path} · ${isWrite ? 'повний запис' : 'diff'}`;
    const pre = document.createElement('pre');
    pre.className = 'approval-artifact-code';
    if (isWrite) {
      pre.textContent = String(args.content ?? '').slice(0, 4_000);
    } else {
      pre.innerHTML = '';
      for (const row of diffRows(String(args.old_str ?? ''), String(args.new_str ?? '')).slice(0, 80)) {
        const line = document.createElement('div');
        line.className = `diff-line ${row.kind}`;
        line.textContent = `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '} ${row.text}`;
        pre.append(line);
      }
    }
    el.apArtifact.append(label, pre);
    el.apYes.textContent = 'Застосувати';
    el.apNo.textContent = 'Відхилити';
    return;
  }
  const command = document.createElement('pre');
  command.className = 'approval-artifact-command';
  command.textContent = String(args.command ?? '');
  el.apArtifact.append(command);
  el.apYes.textContent = 'Run command';
  el.apNo.textContent = 'Cancel';
}

function toolDisplay(name: string, args: unknown): string {
  const obj = toolArgs(args);
  const path = String(obj.path ?? '').split(/[\\/]/).pop();
  if (name === 'read_file') return path ? `Читаю ${path}` : 'Читаю файл';
  if (name === 'write_file') return path ? `Записую ${path}` : 'Записую файл';
  if (name === 'edit_file') return path ? `Редагую ${path}` : 'Редагую файл';
  if (name === 'list_dir') return path ? `Дивлюся ${path}` : 'Дивлюся теку';
  if (name === 'search_files') return `Шукаю ${String(obj.pattern ?? '')}`;
  if (name === 'run_shell') return 'Запускаю команду';
  if (name === 'make_dir') return path ? `Створюю ${path}` : 'Створюю теку';
  return name;
}

function addToolCard(id: string, name: string, args: unknown, result?: { ok: boolean; text: string }): void {
  clearPlaceholder();
  finishStream();
  activeMessage = null;
  activeReasoning = null;
  assistantRaw = '';
  reasoningNode = null;
  createArtifactCard(id, name, args);

  const card = document.createElement('div');
  card.className = 'tool';

  const head = document.createElement('div');
  head.className = 'tool-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = toolDisplay(name, args);
  const argsEl = document.createElement('span');
  argsEl.className = 'tool-args';
  argsEl.textContent = summarizeArgs(args);
  const stateEl = document.createElement('span');
  stateEl.className = 'tool-state running';
  stateEl.textContent = '…';
  head.append(icon(toolIcon(name)), nameEl, argsEl, stateEl);

  const out = document.createElement('pre');
  out.className = 'tool-out hidden';

  head.addEventListener('click', () => out.classList.toggle('hidden'));
  card.append(head, out);
  ensureToolGroup().live.append(card);
  keepThinkingLast();
  toolCards.set(id, card);

  if (result) finishToolCard(id, result.ok, result.text);
  scroll();
}

function showToolImage(path: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const image = document.createElement('img');
  image.className = 'md-image';
  image.alt = 'Знімок екрана';
  image.dataset.path = path;
  bubble.append(image);
  wrap.append(bubble);
  el.messages.append(wrap);
  void hydrateImages(bubble);
  keepThinkingLast();
  scroll();
}

function finishToolCard(id: string, ok: boolean, result: string): void {
  finishArtifactCard(id, ok);
  finishTerminalCard(id, ok, result);
  const card = toolCards.get(id);
  if (!card) return;
  const stateEl = card.querySelector('.tool-state') as HTMLElement;
  stateEl.className = `tool-state ${ok ? 'ok' : 'bad'}`;
  stateEl.textContent = ok ? '✓' : '✗';
  const out = card.querySelector('.tool-out') as HTMLElement;
  out.textContent = result;
  const imageMatch = /!\[[^\]]*\]\(([^)]+)\)/.exec(result)
    ?? /((?:\.vela[\\/])?screenshots[\\/][^\s)]+\.(?:png|jpe?g|webp|gif))/i.exec(result);
  if (ok && imageMatch) {
    const path = imageMatch[1].replace(/^<|>$/g, '');
    out.textContent = result.replace(imageMatch[0], 'Знімок екрана');
    showToolImage(path);
  }
  toolCards.delete(id);

  const group = ensureToolGroup();
  group.done++;
  if (ok) {
    // Success is noise once it is done: fold it away.
    group.body.append(card);
  } else {
    // A failure stays on screen, with its output open — that is the one thing
    // the user must not have to go looking for.
    group.failed++;
    out.classList.remove('hidden');
    group.live.append(card);
  }
  updateGroupLabel(group);
  keepThinkingLast();
  scroll();
}

/** Repaint a stored transcript when the user switches chats. */
function renderHistory(messages: ChatMessage[]): void {
  el.messages.innerHTML = '';
  toolCards.clear();
  artifactCards.clear();
  terminalCards.clear();
  thinkingEl = null;
  assistantRaw = '';
  reasoningNode = null;
  pendingReasoning = '';
  closeToolGroup();
  activeMessage = null;
  activeReasoning = null;
  turnAssistants = [];

  const results = new Map<string, string>();
  for (const m of messages) {
    // Tool results are always plain text, but the type now allows parts.
    if (m.role === 'tool' && m.tool_call_id) {
      results.set(m.tool_call_id, typeof m.content === 'string' ? m.content : '');
    }
  }

  for (const m of messages) {
    if (m.role === 'user') {
      const { text, images } = splitContent(m.content);
      const handle = addMessage('user', text, false, { at: m.at ?? 0, done: true });
      attachImagesTo(handle.bubble, images);
    } else if (m.role === 'assistant') {
      const { text } = splitContent(m.content);
      if (text) {
        const handle = addMessage('assistant', text, true, { at: m.at ?? 0, done: true });
        finalizeAssistant(handle);
      }
      if (m.tool_calls?.length) closeToolGroup();
      for (const call of m.tool_calls ?? []) {
        let args: unknown = call.function.arguments;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          /* show the raw string when the model emitted invalid JSON */
        }
        const toolText = results.get(call.id) ?? '(без результату)';
        addToolCard(call.id, call.function.name, args, { ok: !toolText.startsWith('ПОМИЛКА'), text: toolText });
      }
    }
  }

  turnAssistants = [];
  syncRetryButtons();
  if (!messages.length) showEmptyChat();
  scroll(true);
}

function showEmptyChat(): void {
  el.messages.innerHTML = '';
  thinkingEl = null;
  closeToolGroup();

  const project = state?.projects.find(p => p.id === state.activeProjectId);
  const box = document.createElement('div');
  box.className = 'placeholder';

  const mark = document.createElement('div');
  mark.className = 'ph-logo-wrap';
  const logo = icon('i-logo');
  logo.classList.add('ph-logo');
  mark.append(logo);

  const kicker = document.createElement('p');
  kicker.className = 'ph-kicker';
  kicker.textContent = project ? 'Проєкт' : 'Звичайний чат';

  const title = document.createElement('p');
  title.className = 'ph-title';
  title.textContent = project ? project.name : 'Без папки';

  const text = document.createElement('p');
  text.className = 'ph-text';
  text.textContent = project
    ? 'Агент бачить файли в цій папці. Напиши, що зробити.'
    : 'Агент працює в домашній теці. Для коду краще створити проєкт.';

  const path = document.createElement('p');
  path.className = 'ph-path';
  path.textContent = project ? project.path : state?.chatsFolder ?? '';

  box.append(mark, kicker, title, text, path);

  const suggestions = document.createElement('div');
  suggestions.className = 'ph-prompts';
  const prompts = [
    ['01', 'Огляд', 'Покажи структуру і поясни, що тут є.', 'Покажи структуру проєкту і поясни, що тут уже є.'],
    ['02', 'Перевірки', 'Запусти тести й виправ помилки.', 'Запусти перевірки, знайди помилки й виправ їх.'],
    ['03', 'Сторінка', 'Зроби просту HTML-сторінку.', 'Створи просту адаптивну HTML-сторінку в цьому проєкті.'],
  ];
  for (const [num, heading, hint, prompt] of prompts) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ph-prompt';
    const number = document.createElement('span');
    number.className = 'ph-num';
    number.textContent = num;
    const body = document.createElement('span');
    body.className = 'ph-body';
    const b = document.createElement('b');
    b.textContent = heading;
    const small = document.createElement('small');
    small.textContent = hint;
    body.append(b, small);
    const go = document.createElement('span');
    go.className = 'ph-go';
    go.textContent = '→';
    row.append(number, body, go);
    row.addEventListener('click', () => {
      el.input.value = prompt;
      autoGrow();
      updateSendState();
      el.input.focus();
    });
    suggestions.append(row);
  }
  box.append(suggestions);

  const actions = document.createElement('div');
  actions.className = 'ph-actions';
  if (!project) {
    const newProject = document.createElement('button');
    newProject.className = 'btn primary';
    newProject.textContent = 'Створити проєкт';
    newProject.addEventListener('click', openProjectDialog);
    actions.append(newProject);
  }
  if (actions.childElementCount) box.append(actions);
  el.messages.append(box);
}

/* ───────────── agent events ───────────── */

ironcode.onAgentEvent(event => {
  switch (event.kind) {
    case 'text':
      cleanupRetryDom();
      if (!activeMessage) {
        activeMessage = addMessage('assistant', '', true, { done: false });
        assistantRaw = '';
      }
      activeReasoning = null;
      reasoningNode = null;
      assistantRaw += event.delta;
      queueFlush();
      break;

    case 'reasoning':
      cleanupRetryDom();
      if (!activeReasoning) {
        clearPlaceholder();
        activeReasoning = document.createElement('div');
        activeReasoning.className = 'reasoning';
        reasoningNode = document.createTextNode('');
        activeReasoning.append(reasoningNode);
        el.messages.append(activeReasoning);
        keepThinkingLast();
      }
      pendingReasoning += event.delta;
      queueFlush();
      break;

    case 'model':
      if (event.note) addSystem(`${event.model}. ${event.note}`, 'model');
      break;

    case 'model_switch':
      settings.model = event.model;
      updateModelButton();
      renderModelMenu();
      addSystem(event.reason, 'model');
      void refreshContext();
      break;

    case 'tool_start':
      cleanupRetryDom();
      noteContextFile(event.name, event.args);
      addToolCard(event.id, event.name, event.args);
      break;

    case 'tool_end':
      finishToolCard(event.id, event.ok, event.result);
      break;

    case 'approval':
      pendingApprovalId = event.id;
      el.apTitle.textContent = `Дозволити ${event.name}?`;
      el.apDetail.textContent = event.detail;
      renderApprovalArtifact(event.name, event.args);
      el.approval.classList.remove('hidden');
      break;

    case 'workspace_missing':
    case 'workspace_lost':
      addWorkspaceCard(event);
      break;

    case 'status':
      addSystem(event.text);
      break;

    case 'error': {
      const message = event.message;
      if (/немає з'єднання|немає мережі|інтернет|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
        networkDown = true;
        if (currentQueue().length) {
          addSystem('Мережа зникла. Черга зупинена, повідомлення не загубляться.', 'err');
        }
      }
      const dead = /Model '([^']+)' is not in the catalog/i.exec(message);
      if (dead) {
        const id = dead[1];
        const row = models.find(m => m.id === id);
        if (row) {
          row.verdict = 'dead';
          row.detail = 'немає в каталозі провайдера';
        }
        renderModelMenu();
        renderSettingsModels();
        if (settings.model === id) {
          settings.model = 'auto';
          void ironcode.setSettings({ model: 'auto' }).then(() => {
            updateModelButton();
            void refreshContext();
          });
          addSystem(`Модель ${id} недоступна. Перемкнув на auto.`, 'err');
        }
      }
      addSystem(`помилка: ${message}`, 'err');
      break;
    }

    case 'computer_active':
      if (event.active) {
        window.clearTimeout(computerBannerTimer);
        el.computerBanner.classList.remove('hidden');
      } else {
        window.clearTimeout(computerBannerTimer);
        computerBannerTimer = window.setTimeout(() => {
          el.computerBanner.classList.add('hidden');
        }, 1200);
      }
      break;

    case 'turn_end':
      if (pendingRetryUser) cleanupRetryDom();
      finishContextBadge();
      el.computerBanner.classList.add('hidden');
      finishStream();
      closeToolGroup();
      for (const handle of turnAssistants) finalizeAssistant(handle);
      turnAssistants = [];
      syncRetryButtons();
      setRunning(false);
      stampTurnDuration();
      activeMessage = null;
      activeReasoning = null;
      assistantRaw = '';
      reasoningNode = null;
      el.approval.classList.add('hidden');
      pendingApprovalId = null;
      void refreshTree();
      // Titles and missing-folder state can both change during a turn. The
      // refresh also lets the banner appear the moment a drive is unplugged.
      void refreshState();
      // The transcript is written from the agent's `finally` just after this
      // event; a second refresh picks up the title the store derived from the
      // first user message instead of leaving "Чат N" in the rail.
      window.setTimeout(() => void refreshState(), 500);
      if (previewUrl) reloadPreview();
      // A recovery card and the turn's duration note are appended near the
      // end; without this the card's buttons can sit just under the composer.
      scroll(true);
      void refreshContext();
      void refreshUsage();
      // The agent clears its busy flag in a `finally` that runs just after the
      // turn_end event leaves this handler; a short beat avoids a false
      // "agent is already working" when the queued prompt starts instantly.
      window.setTimeout(() => {
        if (networkDown) {
          renderQueue();
          return;
        }
        if (suppressDrainOnce) {
          suppressDrainOnce = false;
          renderQueue();
          return;
        }
        void drainQueue();
      }, 80);
      break;
  }
});

function setRunning(value: boolean): void {
  running = value;
  el.input.placeholder = value
    ? 'Напиши далі, стане в чергу'
    : 'Напиши задачу';
  el.sendLabel.textContent = value ? 'У чергу' : 'Надіслати';
  el.sendBtn.classList.toggle('queue-mode', value);
  el.stopBtn.classList.toggle('hidden', !value);
  el.composer.classList.toggle('busy', value);
  if (value) showThinking();
  else hideThinking();
  updateSendState();
  renderQueue();
}

function updateSendState(): void {
  el.sendBtn.disabled = !el.input.value.trim() && staged.length === 0;
}

/* ───────────── attachments ───────────── */

function renderStaged(): void {
  el.attachBox.innerHTML = '';
  el.attachBox.classList.toggle('hidden', staged.length === 0);

  staged.forEach((item, index) => {
    const chip = document.createElement('div');
    chip.className = `attach-chip${item.kind === 'error' ? ' bad' : ''}`;

    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = item.name;
      chip.append(img);
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.kind === 'error' ? `${item.name}: ${item.message}` : item.name;
    name.title = name.textContent;
    chip.append(name);

    const remove = document.createElement('button');
    remove.className = 'icon-btn';
    remove.title = 'Прибрати';
    remove.append(icon('i-x'));
    remove.addEventListener('click', () => {
      staged.splice(index, 1);
      renderStaged();
    });
    chip.append(remove);

    el.attachBox.append(chip);
  });
  updateSendState();
}

function addStaged(items: Attachment[]): void {
  staged.push(...items);
  renderStaged();
  const failed = items.filter(i => i.kind === 'error');
  for (const f of failed) addSystem(`${f.name}: ${(f as any).message}`, 'err');
}

el.attachBtn.addEventListener('click', async () => {
  const res = await ironcode.pickAttachments();
  if (res.ok) addStaged(res.items);
});

el.chatFolderBtn.addEventListener('click', async () => {
  if (activeProject()) {
    toast('У проєкті агент працює лише в папці проєкту.');
    return;
  }
  const picked = await ironcode.pickFolder('chat');
  if (!picked.ok || !picked.path) return;
  const res = await ironcode.setChatFolder(picked.path);
  if (!res.ok) {
    toast(res.error ?? 'Не вдалося прив’язати папку.');
    return;
  }
  state = res.state!;
  syncChatHeader();
  await refreshTree();
  toast('Папку чату змінено');
});

/** Pasting a screenshot is the fastest way to show the agent something. */
el.input.addEventListener('paste', async e => {
  const items = [...(e.clipboardData?.items ?? [])].filter(i => i.type.startsWith('image/'));
  if (!items.length) return;
  e.preventDefault();
  for (const item of items) {
    const file = item.getAsFile();
    if (!file) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await ironcode.attachBytes(file.name || 'знімок.png', bytes);
    if (res.ok) addStaged(res.items);
  }
});

/** Drag and drop onto the composer. */
let dragDepth = 0;
for (const type of ['dragenter', 'dragover'] as const) {
  el.composer.addEventListener(type, e => {
    e.preventDefault();
    if (type === 'dragenter') dragDepth++;
    el.dropHint.classList.remove('hidden');
  });
}
el.composer.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el.dropHint.classList.add('hidden');
});
el.composer.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  el.dropHint.classList.add('hidden');

  const files = [...(e.dataTransfer?.files ?? [])];
  const paths: string[] = [];
  for (const file of files) {
    // A real path lets the main process handle video and large files without
    // moving their bytes through the renderer.
    const path = ironcode.filePath(file);
    if (path) {
      paths.push(path);
      continue;
    }
    if (file.type.startsWith('image/')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await ironcode.attachBytes(file.name, bytes);
      if (res.ok) addStaged(res.items);
    } else {
      addSystem(`${file.name}: не вдалося визначити шлях. Додай через скріпку.`, 'err');
    }
  }
  if (paths.length) {
    const res = await ironcode.attachPaths(paths);
    if (res.ok) addStaged(res.items);
  }
});

/* ───────────── queued messages ───────────── */

function queueKey(): string {
  return state?.activeChatId ?? '__none';
}

function currentQueue(): QueuedTurn[] {
  return queues.get(queueKey()) ?? [];
}

const QUEUE_STORE = 'ironcode.queues.v1';

function persistQueues(): void {
  try {
    if (!queues.size) {
      localStorage.removeItem(QUEUE_STORE);
      return;
    }
    localStorage.setItem(QUEUE_STORE, JSON.stringify(Object.fromEntries(queues)));
  } catch {
    // Huge image attachments can exceed the localStorage quota. The queue is
    // still in memory for this run; dropping the persisted copy is safer than
    // crashing the send path.
  }
}

function restoreQueues(): void {
  try {
    const raw = localStorage.getItem(QUEUE_STORE);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, QueuedTurn[]>;
    for (const [key, items] of Object.entries(parsed)) {
      if (!Array.isArray(items)) continue;
      const clean = items.filter(item => item && typeof item.text === 'string' && item.text.trim());
      if (clean.length) queues.set(key, clean);
    }
  } catch {
    /* a damaged local cache must not block the app */
  }
}

function setCurrentQueue(items: QueuedTurn[]): void {
  if (items.length) queues.set(queueKey(), items);
  else queues.delete(queueKey());
  persistQueues();
  renderQueue();
}

function queueChipNote(attachments: Attachment[]): string {
  if (!attachments.length) return '';
  const images = attachments.filter(a => a.kind === 'image').length;
  const files = attachments.length - images;
  const parts: string[] = [];
  if (images) parts.push(`${images} зобр.`);
  if (files) parts.push(`${files} файл.`);
  return parts.join(', ');
}

function renderQueue(): void {
  el.queueBox.innerHTML = '';
  const items = currentQueue();
  el.queueBox.classList.toggle('hidden', items.length === 0);
  if (!items.length) return;

  const head = document.createElement('div');
  head.className = 'queue-head';
  const label = document.createElement('b');
  label.textContent = `Черга, ${items.length}`;
  const hint = document.createElement('span');
  hint.className = 'qh-hint';
  hint.textContent = running ? 'піде після ходу' : 'чекає';
  head.append(label, hint);

  if (!running) {
    const sendNow = document.createElement('button');
    sendNow.className = 'qh-btn';
    sendNow.textContent = 'Надіслати';
    sendNow.title = 'Надіслати перше повідомлення з черги';
    sendNow.addEventListener('click', () => void drainQueue());
    head.append(sendNow);
  }

  const clear = document.createElement('button');
  clear.className = 'qh-btn';
  clear.textContent = 'Очистити';
  clear.addEventListener('click', () => setCurrentQueue([]));
  head.append(clear);
  el.queueBox.append(head);

  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.title = 'Клік: повернути в поле';

    const number = document.createElement('span');
    number.className = 'q-index';
    number.textContent = String(index + 1);

    const body = document.createElement('div');
    body.className = 'q-body';
    const text = document.createElement('span');
    text.className = 'q-text';
    text.textContent = item.text || '(лише вкладення)';
    text.title = item.text;
    body.append(text);

    const noteParts = [queueChipNote(item.attachments)].filter(Boolean);
    if (noteParts.length) {
      const note = document.createElement('span');
      note.className = 'q-note';
      note.textContent = noteParts.join(', ');
      body.append(note);
    }

    const actions = document.createElement('div');
    actions.className = 'q-actions';
    const edit = metaButton('i-pencil', 'Правити', 'edit');
    const remove = metaButton('i-x', 'Прибрати з черги', 'remove');
    actions.append(edit, remove);

    const takeBack = () => {
      const next = currentQueue();
      next.splice(index, 1);
      setCurrentQueue(next);
      el.input.value = el.input.value ? `${el.input.value}\n${item.text}` : item.text;
      staged.push(...item.attachments);
      renderStaged();
      autoGrow();
      updateSendState();
      el.input.focus();
    };

    row.addEventListener('click', takeBack);
    edit.addEventListener('click', e => { e.stopPropagation(); takeBack(); });
    remove.addEventListener('click', e => {
      e.stopPropagation();
      const next = currentQueue();
      next.splice(index, 1);
      setCurrentQueue(next);
    });

    row.append(number, body, actions);
    el.queueBox.append(row);
  });
}

/** Called when a turn ends: the next queued message goes out on its own. */
async function drainQueue(): Promise<void> {
  if (running) return;
  const items = currentQueue();
  if (!items.length) return;
  // A gone folder is a stop sign, not something to retry blindly: the queued
  // prompt would fail exactly like the turn that just ended. The banner and
  // the queue's own "Надіслати" button take over once the user relinks it.
  const project = activeProject();
  if (project ? state.missingProjects.includes(project.id) : state.chatsFolderMissing) {
    toast('Спочатку вкажи актуальну папку. Повідомлення не втрачено.');
    renderQueue();
    return;
  }
  const next = items.shift()!;
  setCurrentQueue(items);
  await dispatch(next.text, next.attachments);
}

/* ───────────── composer ───────────── */

function autoGrow(): void {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

let suppressDrainOnce = false;
let pendingRetryUser: HTMLElement | null = null;

function cleanupRetryDom(): void {
  if (!pendingRetryUser) return;
  let node = pendingRetryUser.nextElementSibling;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
  pendingRetryUser = null;
}

async function retryAssistant(handle: MessageHandle): Promise<void> {
  if (running) {
    toast('Агент ще працює. Дочекайся завершення.');
    return;
  }
  const assistants = [...el.messages.querySelectorAll<HTMLElement>('.msg.assistant')];
  if (assistants[assistants.length - 1] !== handle.wrap) {
    toast('Повторити можна лише останню відповідь.');
    return;
  }
  const users = [...el.messages.querySelectorAll<HTMLElement>('.msg.user')];
  const lastUser = users[users.length - 1];
  if (!lastUser || !(lastUser.compareDocumentPosition(handle.wrap) & Node.DOCUMENT_POSITION_FOLLOWING)) return;

  pendingRetryUser = lastUser;
  activeMessage = null;
  turnAssistants = [];
  assistantRaw = '';
  activeReasoning = null;
  reasoningNode = null;
  networkDown = false;
  setRunning(true);
  const res = await ironcode.retryLast();
  if (!res.ok) {
    if (res.busy || res.workspace) pendingRetryUser = null;
    else cleanupRetryDom();
    setRunning(false);
    addSystem(res.error ?? 'Не вдалося повторити відповідь.', 'err');
    void refreshContext();
  }
}

/** Actually hand a message to the agent. */
async function dispatch(text: string, attachments: Attachment[]): Promise<boolean> {
  networkDown = false;
  const handle = addMessage('user', text);
  attachImagesTo(handle.bubble, attachments.filter(a => a.kind === 'image').map(a => (a as any).dataUrl));
  turnContextFiles = new Set<string>();
  currentUserBubble = handle.bubble;
  noteChatTitle(text);
  activeMessage = null;
  turnAssistants = [];
  assistantRaw = '';
  setRunning(true);
  const res = await ironcode.send(text, attachments);
  if (!res || !res.ok) {
    setRunning(false);
    if (res?.busy) {
      // The turn_end event can reach the renderer a hair before the agent
      // clears its busy flag. Put the prompt back at the head of the queue and
      // retry — dropping it here is exactly what the queue exists to prevent.
      handle.wrap.remove();
      const items = currentQueue();
      items.unshift({ id: `q_${Date.now()}`, text, attachments, at: Date.now() });
      setCurrentQueue(items);
      window.setTimeout(() => void drainQueue(), 220);
    } else if (res?.workspace) {
      // The bubble was never persisted (the turn could not start), so keep the
      // text where it can be sent once the folder is relinked instead of
      // leaving a message that will vanish on reload.
      handle.wrap.remove();
      const items = currentQueue();
      items.unshift({ id: `q_${Date.now()}`, text, attachments, at: Date.now() });
      setCurrentQueue(items);
      toast('Повідомлення в черзі. Вкажи папку й натисни «Надіслати».');
    } else {
      addSystem(res?.error ?? 'Не вдалося надіслати повідомлення', 'err');
    }
    return false;
  }
  return true;
}

async function send(): Promise<void> {
  const text = el.input.value.trim();
  if (!text && !staged.length) return;
  networkDown = false;

  // While a turn is running the message is not dropped and does not interrupt:
  // it waits and goes out as soon as the agent is free. Attachments travel with
  // the queued prompt instead of being stranded in the composer.
  if (running) {
    const items = currentQueue();
    items.push({ id: `q_${Date.now()}`, text, attachments: staged, at: Date.now() });
    setCurrentQueue(items);
    staged = [];
    renderStaged();
    el.input.value = '';
    autoGrow();
    updateSendState();
    el.input.focus();
    return;
  }

  const attachments = staged;
  staged = [];
  renderStaged();
  el.input.value = '';
  autoGrow();
  updateSendState();
  await dispatch(text, attachments);
}

let mentionItems: string[] = [];
let mentionIndex = 0;

function mentionQuery(): { start: number; query: string } | null {
  const value = el.input.value;
  const caret = el.input.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
}

function closeMentionPop(): void {
  el.mentionPop.classList.add('hidden');
  mentionItems = [];
}

function updateMentionState(): void {
  const found = mentionQuery();
  if (!found) {
    closeMentionPop();
    return;
  }
  const query = found.query;
  mentionItems = [...dirPaths, ...filePaths]
    .filter(path => !query || path.toLowerCase().includes(query))
    .slice(0, 9);
  if (!mentionItems.length) {
    closeMentionPop();
    return;
  }
  mentionIndex = Math.min(mentionIndex, mentionItems.length - 1);
  el.mentionPop.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'mention-head';
  head.textContent = 'Додати файл у контекст';
  el.mentionPop.append(head);
  mentionItems.forEach((path, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `mention-row${index === mentionIndex ? ' active' : ''}`;
    const isDir = path.endsWith('/');
    const name = document.createElement('b');
    name.textContent = isDir
      ? path.replace(/\/+$/, '').split(/[\\/]/).pop() + '/'
      : path.split(/[\\/]/).pop() ?? path;
    const dir = document.createElement('small');
    dir.textContent = isDir ? 'тека' : (path.includes('/') || path.includes('\\') ? path.replace(/[^\\/]+$/, '') : '');
    row.append(icon(isDir ? 'i-folder' : 'i-file'), name, dir);
    row.addEventListener('mousedown', e => {
      e.preventDefault();
      void pickMention(path);
    });
    el.mentionPop.append(row);
  });
  el.mentionPop.classList.remove('hidden');
}

async function pickMention(path: string): Promise<void> {
  const found = mentionQuery();
  if (!found) return;
  const value = el.input.value;
  const caret = el.input.selectionStart ?? value.length;
  el.input.value = `${value.slice(0, found.start)}@${path} ${value.slice(caret)}`;
  const nextCaret = found.start + path.length + 2;
  el.input.selectionStart = el.input.selectionEnd = nextCaret;
  closeMentionPop();
  autoGrow();
  updateSendState();
  if (path.endsWith('/')) {
    el.input.focus();
    return;
  }
  const res = await ironcode.readFile(path);
  if (!res.ok) {
    addSystem(`@${path}: ${res.error}`, 'err');
    return;
  }
  if (staged.some(item => item.kind === 'text' && item.name === path)) return;
  addStaged([{ kind: 'text', name: path, text: res.content ?? '' }]);
  el.input.focus();
}

el.input.addEventListener('input', () => {
  autoGrow();
  updateSendState();
  updateMentionState();
});
el.input.addEventListener('keydown', e => {
  if (!el.mentionPop.classList.contains('hidden')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length;
      updateMentionState();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      void pickMention(mentionItems[mentionIndex]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionPop();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});
document.addEventListener('click', e => {
  if (!(e.target as HTMLElement).closest('#mentionPop, #input')) closeMentionPop();
});
el.input.addEventListener('blur', () => window.setTimeout(closeMentionPop, 120));

el.sendBtn.addEventListener('click', () => void send());
el.stopBtn.addEventListener('click', async () => {
  // Stop means stop: the current turn is cancelled and the queue is not
  // launched automatically afterwards. The prompts stay visible and can be
  // sent with one click once the user is ready.
  if (currentQueue().length) suppressDrainOnce = true;
  ironcode.cancel();
  if (!running) {
    // No turn was actually in flight; do not leave the suppression armed.
    suppressDrainOnce = false;
    renderQueue();
  }
});

el.apYes.addEventListener('click', () => {
  if (pendingApprovalId) ironcode.approve(pendingApprovalId, true);
  pendingApprovalId = null;
  el.approval.classList.add('hidden');
  el.apArtifact.classList.add('hidden');
});
el.apNo.addEventListener('click', () => {
  if (pendingApprovalId) ironcode.approve(pendingApprovalId, false);
  pendingApprovalId = null;
  el.approval.classList.add('hidden');
  el.apArtifact.classList.add('hidden');
});

/* ───────────── rail: chats and projects in one list ───────────── */

function icon(id: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function sectionLabel(text: string): HTMLElement {
  const el2 = document.createElement('div');
  el2.className = 'rail-section';
  el2.textContent = text;
  return el2;
}

function isPinned(targetId: string): boolean {
  return state.pinned.includes(targetId);
}

async function togglePin(targetId: string): Promise<void> {
  state = await ironcode.togglePin(targetId);
  renderRail();
}

/** One row for a chat, wherever it lives. */
function chatRow(chat: ChatMeta, projectId: string | null, indent: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = `row-item chat-row${indent ? ' indented' : ''}${chat.id === state.activeChatId ? ' active' : ''}`;
  row.title = chat.title;

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = chat.title;
  row.append(label);

  if (isPinned(chat.id)) {
    const pin = document.createElement('span');
    pin.className = 'pin';
    pin.textContent = '●';
    pin.title = 'Закріплено';
    row.append(pin);
  }

  const del = document.createElement('button');
  del.className = 'icon-btn sm';
  del.title = 'Видалити чат';
  del.append(icon('i-trash'));
  del.addEventListener('click', async e => {
    e.stopPropagation();
    if (running) {
      toast('Агент працює. Чат можна видалити після завершення ходу.');
      return;
    }
    if (!window.confirm(`Видалити чат «${chat.title}»?`)) return;
    const res = await ironcode.deleteChat(chat.id);
    state = res.state;
    renderRail();
    syncChatHeader();
    renderQueue();
    renderHistory(res.messages);
    await refreshTree();
  });
  row.append(del);

  row.addEventListener('click', () => void selectChat(projectId, chat.id));
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    openCtxMenu(e.clientX, e.clientY, [
      { label: isPinned(chat.id) ? 'Відкріпити' : 'Закріпити', run: () => void togglePin(chat.id) },
      { label: 'Перейменувати', run: () => void renameChatPrompt(chat) },
    ]);
  });
  return row;
}

/** One project block: its own row plus its chats, never shown anywhere else. */
function projectBlock(project: Project): HTMLElement {
  const box = document.createElement('div');
  box.className = 'project-block';
  const problem = state.projectProblems?.find(p => p.id === project.id)?.problem;
  const missing = Boolean(problem) || state.missingProjects.includes(project.id);

  const row = document.createElement('div');
  const owns = project.id === state.activeProjectId;
  row.className = `row-item project-row${owns ? ' active' : ''}${missing ? ' missing' : ''}`;
  row.title = missing ? `Папку недоступно: ${project.path}. Правий клік, щоб вказати нове розташування.` : project.path;
  row.append(icon('i-folder'));

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = project.name;
  row.append(label);

  if (missing) {
    const warn = document.createElement('span');
    warn.className = 'missing-flag';
    warn.textContent = problem === 'unreadable'
      ? 'немає доступу'
      : problem === 'not-directory' ? 'не папка' : 'немає папки';
    row.append(warn);
  }

  if (isPinned(project.id)) {
    const pin = document.createElement('span');
    pin.className = 'pin';
    pin.textContent = '●';
    row.append(pin);
  }

  row.addEventListener('click', () => {
    const first = project.chats[0];
    if (first) void selectChat(project.id, first.id);
  });
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    openCtxMenu(e.clientX, e.clientY, [
      { label: isPinned(project.id) ? 'Відкріпити' : 'Закріпити', run: () => void togglePin(project.id) },
      { label: 'Новий чат у проєкті', run: () => void addChat(project.id) },
      { label: 'Промт проєкту…', run: () => openPromptDialog(project.id) },
      { label: 'Вказати нове розташування…', run: () => void relocate(project) },
      ...(missing ? [{ label: 'Знайти папку автоматично', run: () => void findProjectFolder(project) }] : []),
      { label: 'Відкрити папку', run: () => void ironcode.revealProject(project.id) },
      { label: 'Перейменувати', run: () => void renameProjectPrompt(project) },
      { label: 'Прибрати проєкт', danger: true, run: () => void deleteProjectConfirm(project) },
    ]);
  });
  box.append(row);

  for (const chat of project.chats) box.append(chatRow(chat, project.id, true));

  const add = document.createElement('button');
  add.className = 'add-chat';
  add.disabled = project.chats.length >= state.maxChats;
  add.append(icon('i-plus'));
  const addLabel = document.createElement('span');
  addLabel.textContent = add.disabled ? `ліміт ${state.maxChats} чатів` : 'Новий чат';
  add.append(addLabel);
  add.addEventListener('click', () => void addChat(project.id));
  box.append(add);

  return box;
}

function renderRail(): void {
  el.railList.innerHTML = '';

  const pinnedProjects = state.projects.filter(p => isPinned(p.id));
  const pinnedChats = state.chats.filter(c => isPinned(c.id));
  const looseProjects = state.projects.filter(p => !isPinned(p.id));
  const looseChats = state.chats.filter(c => !isPinned(c.id));

  if (pinnedProjects.length || pinnedChats.length) {
    el.railList.append(sectionLabel('Закріплені'));
    for (const project of pinnedProjects) el.railList.append(projectBlock(project));
    for (const chat of pinnedChats) el.railList.append(chatRow(chat, null, false));
  }

  if (looseProjects.length) {
    el.railList.append(sectionLabel('Проєкти'));
    for (const project of looseProjects) el.railList.append(projectBlock(project));
  }

  if (looseChats.length) {
    el.railList.append(sectionLabel('Чати'));
    for (const chat of looseChats) el.railList.append(chatRow(chat, null, false));
  }

  if (!state.projects.length && !state.chats.length) {
    const empty = document.createElement('div');
    empty.className = 'rail-empty';
    empty.textContent = 'Тут поки нічого. Натисни +, щоб створити чат або проєкт.';
    el.railList.append(empty);
  }

  el.chatsFolderLabel.textContent = state.chatsFolder;
  el.chatsFolderBtn.title = `Звичайні чати працюють у ${state.chatsFolder}. Натисни, щоб змінити.`;

  renderWorkspaceWarning();
}

function activeProject(): Project | undefined {
  return state?.projects.find(p => p.id === state.activeProjectId);
}

function activeChatMeta(): ChatMeta | undefined {
  const project = activeProject();
  if (project) return project.chats.find(c => c.id === state.activeChatId);
  return state.chats.find(c => c.id === state.activeChatId);
}

/** The store names a fresh chat "Чат N"; the first message is a better label. */
function noteChatTitle(text: string): void {
  const chat = activeChatMeta();
  if (!chat || !/^Чат \d+$/.test(chat.title)) return;
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!title) return;
  chat.title = title;
  renderRail();
  syncChatHeader();
}

let toastTimer: number | null = null;

function toast(text: string): void {
  el.toast.textContent = text;
  el.toast.classList.remove('hidden');
  requestAnimationFrame(() => el.toast.classList.add('show'));
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.classList.remove('show');
    window.setTimeout(() => el.toast.classList.add('hidden'), 220);
  }, 2200);
}

async function pickChatsFolder(): Promise<void> {
  try {
    const picked = await ironcode.pickFolder('chats');
    if (!picked.ok || !picked.path) return;
    state = await ironcode.setChatsFolder(picked.path);
    renderRail();
    syncProjectLabel();
    syncChatHeader();
    renderQueue();
    resetPreview();
    await refreshTree();
    addSystem(`Звичайні чати тепер працюють у ${picked.path}`);
    toast('Теку чатів змінено');
  } catch (err) {
    addSystem((err as Error).message, 'err');
  }
}

async function relocate(project: Project, path?: string): Promise<boolean> {
  if (running) {
    toast('Агент працює. Зміни розташування після завершення ходу.');
    return false;
  }
  const isActive = project.id === state.activeProjectId;
  const res = await ironcode.relocateProject(project.id, path);
  if (!res.ok || !res.state) {
    if (!res.canceled) addSystem(res.error ?? 'Не вдалося змінити папку проєкту', 'err');
    return false;
  }
  state = res.state;
  renderRail();
  syncProjectLabel();
  syncChatHeader();
  renderQueue();
  await refreshTree();
  if (isActive) addSystem(`Проєкт «${project.name}» тепер вказує на ${path ?? 'нову папку'}.`);
  toast('Розташування проєкту оновлено');
  return true;
}

/** Look in likely places for a project folder the user moved. */
async function findProjectFolder(project: Project): Promise<void> {
  if (running) {
    toast('Агент працює. Пошук папки доступний після завершення ходу.');
    return;
  }
  toast('Шукаю схожі папки…');
  const res = await ironcode.findProjectFolder(project.id);
  if (!res.ok) {
    addSystem(res.error ?? 'Пошук не вдався', 'err');
    return;
  }
  if (!res.candidates.length) {
    toast('Схожих папок не знайдено. Вкажи вручну.');
    await relocate(project);
    return;
  }

  el.recoverList.innerHTML = '';
  el.recoverDlg.dataset.projectId = project.id;
  el.recoverNote.textContent = res.candidates.length === 1
    ? 'Знайдено одну схожу папку. Якщо це вона, виберіть її. Чати залишаться.'
    : 'Знайдено кілька схожих папок. Виберіть потрібну. Чати й історія залишаться.';

  for (const candidate of res.candidates) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recover-item';
    const name = document.createElement('b');
    name.textContent = candidate.split(/[\\/]/).filter(Boolean).pop() ?? candidate;
    const path = document.createElement('span');
    path.textContent = candidate;
    item.append(name, path);
    item.addEventListener('click', async () => {
      el.recoverDlg.close();
      const fresh = state.projects.find(p => p.id === project.id);
      if (fresh) await relocate(fresh, candidate);
    });
    el.recoverList.append(item);
  }
  el.recoverDlg.showModal();
}

el.recoverBrowse.addEventListener('click', e => {
  e.preventDefault();
  const projectId = el.recoverDlg.dataset.projectId;
  el.recoverDlg.close();
  const project = state.projects.find(p => p.id === projectId);
  if (project) void relocate(project);
});

function problemLabel(problem: UiState['chatsFolderProblem']): string {
  if (problem === 'not-directory') return 'за цим шляхом лежить файл, а не папка';
  if (problem === 'unreadable') return 'папка існує, але недоступна';
  return 'папку не знайдено. Можливо, її переміщено або перейменовано';
}

/**
 * A banner beats a cryptic ENOENT halfway through a task: the agent refuses to
 * start in a folder that is gone, and this says what to do about it.
 */
function renderWorkspaceAlert(): void {
  el.workspaceAlert.innerHTML = '';
  const project = activeProject();
  const projectProblem = project
    ? state.projectProblems?.find(p => p.id === project.id)?.problem
      ?? (state.missingProjects.includes(project.id) ? 'missing' as const : undefined)
    : undefined;
  const broken = project ? projectProblem : (state.chatsFolderMissing ? state.chatsFolderProblem ?? 'missing' : undefined);

  if (!broken) {
    el.workspaceAlert.classList.add('hidden');
    return;
  }

  el.workspaceAlert.classList.remove('hidden');
  const iconWrap = document.createElement('span');
  iconWrap.className = 'wa-icon';
  iconWrap.append(icon('i-warning'));

  const text = document.createElement('div');
  text.className = 'wa-text';
  const title = document.createElement('b');
  const path = project?.path ?? state.chatsFolder;
  title.textContent = project ? `Папку проєкту «${project.name}» недоступно` : 'Теку чатів недоступно';
  const detail = document.createElement('div');
  detail.append(`${problemLabel(broken)}: `);
  const code = document.createElement('code');
  code.textContent = path;
  detail.append(code);
  text.append(title, detail);

  const actions = document.createElement('div');
  actions.className = 'wa-actions';
  if (project) {
    const pick = document.createElement('button');
    pick.className = 'btn sm primary';
    pick.textContent = 'Вказати папку';
    pick.addEventListener('click', () => void relocate(project));
    const find = document.createElement('button');
    find.className = 'btn sm';
    find.textContent = 'Знайти';
    find.addEventListener('click', () => void findProjectFolder(project));
    const remove = document.createElement('button');
    remove.className = 'btn sm ghost';
    remove.textContent = 'Прибрати';
    remove.addEventListener('click', () => void deleteProjectConfirm(project));
    actions.append(pick, find, remove);
  } else {
    const pick = document.createElement('button');
    pick.className = 'btn sm primary';
    pick.textContent = 'Вибрати теку';
    pick.addEventListener('click', () => void pickChatsFolder());
    actions.append(pick);
  }

  el.workspaceAlert.append(iconWrap, text, actions);
}

function renderWorkspaceWarning(): void {
  el.loadWarning.classList.toggle('hidden', !state.loadError);
  if (state.loadError) el.loadWarning.textContent = state.loadError;
  renderWorkspaceAlert();
}

/** An inline recovery card for a turn that could not start or lost its folder. */
function addWorkspaceCard(event: {
  path: string;
  projectId: string | null;
  message: string;
}): void {
  clearPlaceholder();
  const project = event.projectId ? state.projects.find(p => p.id === event.projectId) : undefined;
  const card = document.createElement('div');
  card.className = 'recover-card';

  const title = document.createElement('p');
  title.className = 'rc-title';
  title.append(icon('i-warning'), document.createTextNode(project ? 'Папка зникла' : 'Тека чатів зникла'));

  const text = document.createElement('p');
  text.className = 'rc-text';
  text.append(event.message, document.createElement('br'));
  const code = document.createElement('code');
  code.textContent = event.path;
  text.append(code);

  const actions = document.createElement('div');
  actions.className = 'rc-actions';
  if (project) {
    const pick = document.createElement('button');
    pick.className = 'btn sm primary';
    pick.textContent = 'Вказати папку';
    pick.addEventListener('click', () => void relocate(project));
    const find = document.createElement('button');
    find.className = 'btn sm';
    find.textContent = 'Знайти автоматично';
    find.addEventListener('click', () => void findProjectFolder(project));
    actions.append(pick, find);
  } else {
    const pick = document.createElement('button');
    pick.className = 'btn sm primary';
    pick.textContent = 'Вибрати теку';
    pick.addEventListener('click', () => void pickChatsFolder());
    actions.append(pick);
  }

  card.append(title, text, actions);
  el.messages.append(card);
  keepThinkingLast();
  scroll(true);
  // The card is a couple of frames taller than the viewport thinks; settle it
  // once the browser has laid the buttons out.
  window.setTimeout(() => scroll(true), 30);
}

function openPromptDialog(projectId?: string): void {
  const project = state.projects.find(p => p.id === (projectId ?? state.activeProjectId));
  el.promptGlobal.value = settings.instructions ?? '';
  el.promptProject.value = project?.instructions ?? '';
  el.promptProjectBlock.classList.toggle('hidden', !project);
  el.promptProjectName.textContent = project?.name ?? '...';
  el.promptDlg.dataset.projectId = project?.id ?? '';
  el.promptState.className = 'prompt-state';
  el.promptState.textContent = running
    ? 'Агент працює. Зміни підуть у наступний хід і в чергу.'
    : 'Зміни діють з наступного повідомлення.';
  el.promptDlg.showModal();
  el.promptGlobal.focus();
}

el.promptSave.addEventListener('click', async e => {
  e.preventDefault();
  const projectId = el.promptDlg.dataset.projectId;
  settings = await ironcode.setSettings({ instructions: el.promptGlobal.value });
  if (projectId) state = await ironcode.setProjectInstructions(projectId, el.promptProject.value);
  renderRail();
  syncProjectLabel();
  syncChatHeader();
  el.promptDlg.close();
  toast('Промт збережено. Діє з наступного повідомлення.');
  addSystem('Промт оновлено. Нові інструкції діють з наступного повідомлення.', 'model');
});

el.chatPath.addEventListener('click', async () => {
  const project = activeProject();
  if (!project) {
    void pickChatsFolder();
    return;
  }
  const ok = await ironcode.revealProject(project.id);
  if (!ok) toast('Папку не знайдено. Вкажи нове розташування.');
});

function syncNoChatState(): void {
  const hasChat = Boolean(state?.activeChatId);
  document.querySelector('.chat')?.classList.toggle('no-chat', !hasChat);
  el.noChat.classList.toggle('hidden', hasChat);
}

function syncChatHeader(): void {
  syncNoChatState();
  if (!state) return;
  const project = activeProject();
  const chat = activeChatMeta();
  el.chatTitle.textContent = chat?.title ?? 'Чат';
  el.chatTitle.title = chat?.title ?? 'Чат';
  const path = project?.path ?? state.activeChatFolder ?? state.chatsFolder;
  el.chatPath.textContent = path;
  el.chatPath.title = `Відкрити ${path}`;
  el.chatFolderBtn.classList.toggle('hidden', Boolean(project));
  el.chatFolderBtn.title = state.activeChatFolder
    ? `Папка чату: ${state.activeChatFolder}. Натисни, щоб змінити.`
    : 'Додати папку для цього чату';
  updateEffortControl();
}

async function addChat(projectId: string | null): Promise<void> {
  const res = await ironcode.createChat(projectId);
  if (!res.ok) {
    addSystem(res.error ?? 'Не вдалося створити чат', 'err');
    return;
  }
  state = res.state!;
  renderRail();
  syncProjectLabel();
  syncChatHeader();
  showEmptyChat();
  renderQueue();
  resetPreview();
  await refreshTree();
  void refreshContext();
}

async function selectChat(projectId: string | null, chatId: string): Promise<void> {
  const res = await ironcode.selectChat(projectId, chatId);
  state = res.state;
  renderRail();
  syncProjectLabel();
  syncChatHeader();
  renderHistory(res.messages);
  // Coming back to a chat that is still working shows it as working, with
  // everything the agent has produced so far already in place.
  setRunning(Boolean(res.running));
  resetPreview();
  await refreshTree();
  void refreshContext();
}

function syncProjectLabel(): void {
  const project = activeProject();
  if (project) {
    el.projectLabel.textContent = project.name;
    el.projectLabel.title = project.path;
    return;
  }
  el.projectLabel.textContent = 'Без проєкту';
  el.projectLabel.title = state.chatsFolder;
}

let refreshingState = false;

async function refreshState(): Promise<void> {
  if (refreshingState) return;
  refreshingState = true;
  try {
    state = await ironcode.state();
  } catch {
    refreshingState = false;
    return;
  }
  try {
    renderRail();
    syncProjectLabel();
    syncChatHeader();
    renderQueue();
  } finally {
    refreshingState = false;
  }
}

// Coming back to the window is the moment a moved folder or a pulled USB drive
// is most likely to be noticed; refresh before the user hits Enter.
window.addEventListener('focus', () => void refreshState());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshState();
});
// A folder can also be moved while the app stays focused. A slow poll catches
// that without touching the conversation; the agent's own checks still guard
// every turn, so this is only about showing the banner early.
window.setInterval(() => {
  if (!document.hidden && !running) void refreshState();
}, 30_000);

async function renameChatPrompt(chat: ChatMeta): Promise<void> {
  const title = window.prompt('Нова назва чату', chat.title);
  if (title === null) return;
  state = await ironcode.renameChat(chat.id, title);
  renderRail();
  syncChatHeader();
}

async function renameProjectPrompt(project: Project): Promise<void> {
  const name = window.prompt('Нова назва проєкту', project.name);
  if (name === null) return;
  state = await ironcode.renameProject(project.id, name);
  renderRail();
  syncProjectLabel();
  syncChatHeader();
}

async function deleteProjectConfirm(project: Project): Promise<void> {
  if (running) {
    toast('Агент працює. Проєкт можна прибрати після завершення ходу.');
    return;
  }
  const ok = window.confirm(
    `Прибрати «${project.name}» зі списку?\n\nПапка на диску залишиться:\n${project.path}`,
  );
  if (!ok) return;
  const res = await ironcode.deleteProject(project.id);
  state = res.state;
  renderRail();
  syncProjectLabel();
  syncChatHeader();
  renderQueue();
  renderHistory(res.messages);
  await refreshTree();
}

/* ── creating things ── */

el.addBtn.addEventListener('click', e => {
  e.stopPropagation();
  const box = el.addBtn.getBoundingClientRect();
  openCtxMenu(box.left, box.bottom + 4, [
    { label: 'Новий чат', run: () => void addChat(null) },
    { label: 'Новий проєкт…', run: openProjectDialog },
  ]);
});

$('phChat')?.addEventListener('click', () => void addChat(null));
$('phCreate')?.addEventListener('click', openProjectDialog);
el.noChatNew.addEventListener('click', () => void addChat(null));
el.noChatProject.addEventListener('click', openProjectDialog);

function suggestedProjectPath(name: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|]/g, '-');
  const base = state.chatsFolder.replace(/[\\/]+$/, '');
  return safe ? `${base}\\${safe}` : base;
}

function openProjectDialog(): void {
  el.projectName.value = '';
  el.projectPath.value = '';
  el.projectPathNote.textContent = 'Порожнє поле створить теку поруч із текою чатів.';
  el.projectDlg.showModal();
  el.projectName.focus();
}

el.projectName.addEventListener('input', () => {
  // Keep the suggested path in step with the name until the user edits it.
  if (!el.projectPath.dataset.touched) {
    el.projectPath.value = suggestedProjectPath(el.projectName.value);
  }
});
el.projectPath.addEventListener('input', () => {
  el.projectPath.dataset.touched = '1';
});

el.projectBrowse.addEventListener('click', async e => {
  e.preventDefault();
  const picked = await ironcode.pickFolder('project');
  if (!picked.ok || !picked.path) return;
  el.projectPath.value = picked.path;
  el.projectPath.dataset.touched = '1';
  if (!el.projectName.value.trim()) {
    el.projectName.value = picked.path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  }
});

el.projectCreate.addEventListener('click', async e => {
  e.preventDefault();
  const name = el.projectName.value.trim();
  const folder = el.projectPath.value.trim();
  if (!name && !folder) return;
  const res = await ironcode.createProject(name, folder || undefined);
  if (!res.ok) {
    addSystem(res.error ?? 'Не вдалося створити проєкт', 'err');
    return;
  }
  state = res.state!;
  delete el.projectPath.dataset.touched;
  el.projectDlg.close();
  renderRail();
  syncProjectLabel();
  syncChatHeader();
  showEmptyChat();
  renderQueue();
  resetPreview();
  await refreshTree();
  void refreshContext();
});

el.chatsFolderBtn.addEventListener('click', () => void pickChatsFolder());

/* ───────────── context menu ───────────── */

function openCtxMenu(x: number, y: number, items: Array<{ label: string; danger?: boolean; run: () => void }>): void {
  el.ctxMenu.innerHTML = '';
  for (const item of items) {
    const button = document.createElement('button');
    button.textContent = item.label;
    if (item.danger) button.className = 'danger';
    button.addEventListener('click', () => {
      closeCtxMenu();
      item.run();
    });
    el.ctxMenu.append(button);
  }
  el.ctxMenu.style.left = `${x}px`;
  el.ctxMenu.style.top = `${y}px`;
  el.ctxMenu.classList.remove('hidden');
}

function closeCtxMenu(): void {
  el.ctxMenu.classList.add('hidden');
}

window.addEventListener('click', closeCtxMenu);
window.addEventListener('blur', closeCtxMenu);

/* ───────────── right panel: tabs ───────────── */

function showTab(which: 'files' | 'editor' | 'preview'): void {
  for (const tab of document.querySelectorAll<HTMLElement>('.side-tabs .tab')) {
    tab.classList.toggle('active', tab.dataset.tab === which);
  }
  el.paneFiles.classList.toggle('hidden', which !== 'files');
  el.paneEditor.classList.toggle('hidden', which !== 'editor');
  el.panePreview.classList.toggle('hidden', which !== 'preview');
  el.toolsFiles.classList.toggle('hidden', which !== 'files');
  el.toolsEditor.classList.toggle('hidden', which !== 'editor');
  el.toolsPreview.classList.toggle('hidden', which !== 'preview');
  // The textarea cannot size itself while its pane is display:none.
  if (which === 'editor') syncEditorSize();
}

for (const tab of document.querySelectorAll<HTMLElement>('.side-tabs .tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab as 'files' | 'editor' | 'preview'));
}

/* ───────────── file tree ───────────── */

function renderTree(nodes: TreeNode[], container: HTMLElement, depth = 0): void {
  for (const node of nodes) {
    const row = document.createElement('div');
    row.className = `node${node.dir ? ' dir' : ''}`;
    row.style.paddingLeft = `${7 + depth * 12}px`;
    row.title = node.path;

    const label = document.createElement('span');
    label.className = 'node-name';
    label.textContent = node.dir ? `${node.name}/` : node.name;
    row.append(label);

    if (!node.dir) {
      row.addEventListener('click', () => void openInEditor(node.path, row));
    }
    container.append(row);
    if (node.children?.length) renderTree(node.children, container, depth + 1);
  }
}

function collectPaths(nodes: TreeNode[], out: string[]): void {
  for (const node of nodes) {
    if (node.dir) collectPaths(node.children ?? [], out);
    else out.push(node.path);
  }
}

function collectDirs(nodes: TreeNode[], out: string[]): void {
  for (const node of nodes) {
    if (node.dir) {
      out.push(`${node.path.replace(/\/+$/, '')}/`);
      collectDirs(node.children ?? [], out);
    }
  }
}

async function refreshTree(): Promise<void> {
  const { root, nodes } = await ironcode.tree();
  el.tree.innerHTML = '';
  filePaths = [];
  dirPaths = [];
  if (!root) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'Немає активного проєкту.';
    el.tree.append(empty);
    return;
  }
  if (!nodes.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'Папка порожня. Попроси агента щось створити.';
    el.tree.append(empty);
    return;
  }
  renderTree(nodes, el.tree);
  collectPaths(nodes, filePaths);
  collectDirs(nodes, dirPaths);
}

el.refreshTree.addEventListener('click', () => void refreshTree());

/* ───────────── editor ───────────── */

let gutterLines = -1;
let highlightQueued = false;

/**
 * Re-tokenising and re-measuring on every keystroke made typing in a large
 * file stutter. One pass per animation frame is imperceptible and collapses a
 * burst of keystrokes into a single layout.
 */
function syncHighlight(): void {
  if (highlightQueued) return;
  highlightQueued = true;
  requestAnimationFrame(() => {
    highlightQueued = false;
    const code = el.editor.value;
    el.codeHl.innerHTML = highlight(code, langFromPath(openFile ?? ''));

    // The gutter only changes when the line count does.
    const lines = code.split('\n').length;
    if (lines !== gutterLines) {
      gutterLines = lines;
      const numbers: string[] = [];
      for (let i = 1; i <= lines; i++) numbers.push(String(i));
      el.gutterInner.textContent = numbers.join('\n');
    }

    el.editorDirty.classList.toggle('hidden', code === savedContent);
    syncEditorSize();
  });
}

function syncEditorSize(): void {
  el.editor.style.height = 'auto';
  el.editor.style.height = `${Math.max(el.editor.scrollHeight, el.codeScroll.clientHeight)}px`;
}

el.editor.addEventListener('input', syncHighlight);
el.codeScroll.addEventListener('scroll', () => {
  el.gutterInner.style.transform = `translateY(${-el.codeScroll.scrollTop}px)`;
});

el.editor.addEventListener('keydown', e => {
  // A plain Tab would leave the textarea; in an editor it must indent.
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: t, value } = el.editor;
    el.editor.value = `${value.slice(0, s)}  ${value.slice(t)}`;
    el.editor.selectionStart = el.editor.selectionEnd = s + 2;
    syncHighlight();
  }
});

async function openInEditor(path: string, row?: HTMLElement, line?: number): Promise<void> {
  const res = await ironcode.readFile(path);
  if (!res.ok) {
    addSystem(`не можу відкрити ${path}: ${res.error}`, 'err');
    return;
  }
  openFile = path;
  savedContent = res.content ?? '';
  el.editor.value = savedContent;
  el.editorPath.textContent = path;
  el.editorPath.title = path;
  showTab('editor');
  gutterLines = -1;
  syncHighlight();
  el.codeScroll.scrollTop = 0;
  el.gutterInner.style.transform = 'translateY(0)';
  if (line && line > 0) {
    const offset = savedContent.split('\n').slice(0, line - 1).join('\n').length;
    el.editor.selectionStart = el.editor.selectionEnd = Math.min(offset, savedContent.length);
    const lineHeight = parseFloat(getComputedStyle(el.editor).lineHeight) || 20;
    el.codeScroll.scrollTop = Math.max(0, (line - 3) * lineHeight);
    el.editor.focus();
  }
  el.tree.querySelectorAll('.node.active').forEach(n => n.classList.remove('active'));
  row?.classList.add('active');
}

async function saveEditor(): Promise<void> {
  if (!openFile) return;
  const content = el.editor.value;
  const res = await ironcode.saveFile(openFile, content);
  if (res.ok) {
    savedContent = content;
    el.editorDirty.classList.add('hidden');
    addSystem(`збережено ${openFile}`);
    if (previewUrl) reloadPreview();
  } else {
    addSystem(`не зберігся ${openFile}: ${res.error}`, 'err');
  }
}

el.saveBtn.addEventListener('click', () => void saveEditor());

/* ───────────── quick open ───────────── */

let quickSelection = 0;

function openQuick(): void {
  if (!filePaths.length) return;
  el.quickOpen.classList.remove('hidden');
  el.quickInput.value = '';
  renderQuick('');
  el.quickInput.focus();
}

function closeQuick(): void {
  el.quickOpen.classList.add('hidden');
}

function renderQuick(query: string): void {
  const q = query.toLowerCase().trim();
  const matches = (q ? filePaths.filter(p => p.toLowerCase().includes(q)) : filePaths).slice(0, 60);
  quickSelection = 0;
  el.quickResults.innerHTML = '';

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'quick-empty';
    empty.textContent = 'Нічого не знайдено';
    el.quickResults.append(empty);
    return;
  }

  matches.forEach((path, i) => {
    const item = document.createElement('div');
    item.className = `quick-item${i === 0 ? ' sel' : ''}`;
    item.textContent = path;
    item.addEventListener('click', () => {
      closeQuick();
      void openInEditor(path);
    });
    el.quickResults.append(item);
  });
}

function moveQuick(delta: number): void {
  const items = [...el.quickResults.querySelectorAll<HTMLElement>('.quick-item')];
  if (!items.length) return;
  items[quickSelection]?.classList.remove('sel');
  quickSelection = (quickSelection + delta + items.length) % items.length;
  items[quickSelection].classList.add('sel');
  items[quickSelection].scrollIntoView({ block: 'nearest' });
}

el.quickInput.addEventListener('input', () => renderQuick(el.quickInput.value));
el.quickInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeQuick();
  else if (e.key === 'ArrowDown') { e.preventDefault(); moveQuick(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveQuick(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const item = el.quickResults.querySelectorAll<HTMLElement>('.quick-item')[quickSelection];
    if (item) {
      closeQuick();
      void openInEditor(item.textContent ?? '');
    }
  }
});
el.quickOpen.addEventListener('click', e => {
  if (e.target === el.quickOpen) closeQuick();
});
el.quickOpenBtn.addEventListener('click', openQuick);

/* ───────────── preview ───────────── */

function resetPreview(): void {
  previewUrl = null;
  el.previewFrame.classList.add('hidden');
  el.previewFrame.src = 'about:blank';
  el.previewEmpty.classList.remove('hidden');
}

function reloadPreview(): void {
  if (!previewUrl) return;
  // A fresh query string defeats the frame's caching of the previous build.
  el.previewFrame.src = `${previewUrl}?t=${Date.now()}`;
}

el.previewStart.addEventListener('click', async () => {
  const res = await ironcode.startPreview();
  if (!res.ok || !res.url) {
    addSystem(`прев'ю не запустилось: ${res.error}`, 'err');
    return;
  }
  previewUrl = res.url;
  el.previewEmpty.classList.add('hidden');
  el.previewFrame.classList.remove('hidden');
  reloadPreview();
});
el.previewReload.addEventListener('click', reloadPreview);
el.previewOpen.addEventListener('click', () => {
  if (previewUrl) void ironcode.openExternal(previewUrl);
});

/* ───────────── settings dialog ───────────── */

function setSettingsTab(tab: SettingsTab): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-settings-tab]')) {
    button.classList.toggle('active', button.dataset.settingsTab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) {
    panel.classList.toggle('active', panel.dataset.settingsPanel === tab);
  }
}

async function showSettingsTab(tab: SettingsTab): Promise<void> {
  setSettingsTab(tab);
  if (tab === 'extensions') {
    await refreshSkills();
    await refreshConnectors();
    renderExtensionCatalog();
    if (!skills.some(s => s.name === editingSkill)) loadSkillIntoForm(skills[0] ?? null);
    else {
      renderSkills();
      updateSkillButtons();
    }
    if (!connectors.some(c => c.id === editingConnector)) loadConnectorIntoForm(connectors[0] ?? null);
    else {
      renderConnectors();
      syncTransportFields();
      updateConnectorButtons();
    }
  } else if (tab === 'models') {
    await refreshUsage();
    renderSettingsModels();
  } else if (tab === 'freellmapi') {
    renderFreeLlmApi();
  } else if (tab === 'appearance') {
    updateThemeChoices();
  } else if (tab === 'permissions') {
    el.permInternet.checked = Boolean(settings.allowInternet);
    el.permFiles.checked = Boolean(settings.allowFiles);
    el.permComputer.checked = Boolean(settings.allowComputer);
  }
}

function updateThemeChoices(): void {
  for (const card of document.querySelectorAll<HTMLElement>('[data-theme-choice]')) {
    card.classList.toggle('active', card.dataset.themeChoice === settings.theme);
  }
}

function applyTheme(): void {
  const theme = settings.theme ?? 'indigo';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  updateThemeChoices();
}

for (const card of document.querySelectorAll<HTMLElement>('[data-theme-choice]')) {
  card.addEventListener('click', async () => {
    const theme = card.dataset.themeChoice as Settings['theme'];
    if (!theme) return;
    // Apply immediately; a profile write failure must not make the theme look
    // broken. Persist afterwards and report failure honestly.
    settings = { ...settings, theme };
    applyTheme();
    try {
      settings = await ironcode.setSettings({ theme });
      toast(`Тема: ${theme === 'indigo' ? 'Індиго' : theme === 'light' ? 'Світла' : 'Ніч'}`);
    } catch (err) {
      toast(`Тему застосовано, але не збережено: ${(err as Error).message}`);
    }
  });
}

function providerStatusText(provider: ProviderSummary): string {
  if (!provider.configured) return 'ключ не додано';
  if (provider.status === 'ok') return provider.modelCount ? `${provider.modelCount} моделей` : 'підключено';
  if (provider.status === 'error') return 'помилка';
  return 'не перевірено';
}

function renderProviders(): void {
  el.providerList.innerHTML = '';
  if (!providers.length) {
    el.providerList.textContent = 'Провайдерів не знайдено.';
    return;
  }

  for (const provider of providers) {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.provider = provider.id;

    const head = document.createElement('div');
    head.className = 'provider-head';
    const name = document.createElement('b');
    name.textContent = provider.name;
    const status = document.createElement('span');
    status.className = `provider-status ${provider.status}`;
    status.textContent = providerStatusText(provider);
    head.append(name, status);

    const url = document.createElement('small');
    url.className = 'provider-url';
    url.textContent = provider.baseUrl;

    const row = document.createElement('div');
    row.className = 'provider-row';
    const key = document.createElement('input');
    key.type = 'password';
    key.autocomplete = 'off';
    key.placeholder = provider.configured ? `Ключ збережено ${provider.keyMask}` : provider.hint;
    key.setAttribute('aria-label', `API-ключ ${provider.name}`);
    key.disabled = provider.configured;

    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'btn sm';
    test.textContent = 'Перевірити';
    test.disabled = !provider.configured;

    const toggle = document.createElement('label');
    toggle.className = 'provider-toggle';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = provider.enabled;
    check.disabled = !provider.configured;
    const toggleText = document.createElement('span');
    toggleText.textContent = 'увімкнено';
    toggle.append(check, toggleText);

    if (!provider.configured) {
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn sm primary';
      save.textContent = 'Зберегти';
      save.disabled = true;
      key.addEventListener('input', () => {
        save.disabled = !key.value.trim();
      });
      save.addEventListener('click', async () => {
        save.disabled = true;
        save.textContent = 'Зберігаю…';
        const saved = await ironcode.saveProvider(provider.id, key.value, true);
        if (!saved.ok) {
          save.disabled = !key.value.trim();
          save.textContent = 'Зберегти';
          toast(saved.error ?? 'Не вдалося зберегти ключ.');
          return;
        }
        key.value = '';
        save.textContent = 'Перевіряю…';
        const result = await ironcode.testProvider(provider.id);
        providers = await ironcode.listProviders();
        renderProviders();
        if (!result.ok) toast(result.error ?? 'Провайдер не відповів.');
        else toast(`${provider.name}: ${providerStatusText(result.provider!)}`);
        await refreshModels();
      });
      row.append(key, save, toggle);
    } else {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn sm';
      remove.title = 'Видалити ключ';
      remove.append(icon('i-trash'));
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Видалити ключ ${provider.name}?`)) return;
        await ironcode.removeProvider(provider.id);
        providers = await ironcode.listProviders();
        renderProviders();
        await refreshModels();
        toast(`${provider.name}: ключ видалено`);
      });
      test.addEventListener('click', async () => {
        test.disabled = true;
        test.textContent = 'Перевіряю…';
        const res = await ironcode.testProvider(provider.id);
        providers = await ironcode.listProviders();
        renderProviders();
        if (!res.ok) toast(res.error ?? 'Провайдер не відповів.');
        else toast(`${provider.name}: ${providerStatusText(res.provider!)}`);
        await refreshModels();
      });
      check.addEventListener('change', async () => {
        const res = await ironcode.setProviderEnabled(provider.id, check.checked);
        if (!res.ok) {
          check.checked = !check.checked;
          toast(res.error ?? 'Не вдалося змінити стан.');
          return;
        }
        providers = await ironcode.listProviders();
        renderProviders();
        await refreshModels();
      });
      row.append(key, test, toggle, remove);
    }

    const detail = document.createElement('p');
    detail.className = `provider-detail ${provider.status}`;
    detail.textContent = provider.detail || (provider.configured ? 'Ключ збережено.' : 'Ключ не додано.');

    card.append(head, url, row, detail);
    el.providerList.append(card);
  }
}

async function refreshProviders(): Promise<void> {
  providers = await ironcode.listProviders();
  renderProviders();
}

// Kept for migration diagnostics; the providers UI is replaced by Free LLM API.
void refreshProviders;

function renderFreeLlmApi(): void {
  el.freellmUrl.value = settings.gatewayUrl || 'http://127.0.0.1:31415';
  el.freellmKey.value = '';
  const bound = settings.apiKey
    ? `Ключ збережено: ${settings.apiKey.slice(0, 4)}…${settings.apiKey.slice(-4)}. Залиш поле порожнім, щоб не змінювати.`
    : 'Ключ ще не додано.';
  el.freellmKey.placeholder = bound;
  el.freellmStatus.textContent = bound;
  el.freellmStatus.classList.remove('ok', 'err');
}

function setPluginView(view: 'catalog' | 'installed' | 'instructions'): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-plugin-tab]')) {
    button.classList.toggle('active', button.dataset.pluginTab === view);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-plugin-view]')) {
    panel.classList.toggle('hidden', panel.dataset.pluginView !== view);
  }
}

for (const button of document.querySelectorAll<HTMLElement>('[data-plugin-tab]')) {
  button.addEventListener('click', () => {
    const view = button.dataset.pluginTab;
    if (view === 'catalog' || view === 'installed' || view === 'instructions') setPluginView(view);
  });
}

function extensionInstalled(preset: ExtensionPreset): boolean {
  if (preset.kind === 'instruction') return skills.some(s => s.name === preset.skillName);
  return connectors.some(c => c.name === preset.id);
}

function useExtension(preset: ExtensionPreset): void {
  if (preset.kind === 'instruction') {
    setPluginView('instructions');
    const skill = skills.find(s => s.name === preset.skillName);
    if (skill) loadSkillIntoForm(skill);
    else toast('Інструкція не знайдена. Увімкни її у списку.');
    return;
  }

  const installed = connectors.find(c => c.name === preset.id);
  if (installed) {
    editingConnector = installed.id;
    loadConnectorIntoForm(installed);
    setPluginView('installed');
    renderConnectors();
    updateConnectorButtons();
    return;
  }

  loadConnectorIntoForm(null);
  el.connName.value = preset.id;
  el.connDesc.value = preset.description;
  el.connTransport.value = preset.transport ?? 'stdio';
  syncTransportFields();
  el.connCommand.value = preset.command ?? '';
  el.connArgs.value = (preset.args ?? []).join('\n');
  el.connEnv.value = (preset.envKeys ?? []).map(key => `${key}=`).join('\n');
  el.connUrlField.value = preset.url ?? '';
  el.connHeaders.value = '';
  el.connEnabled.checked = true;
  editingConnector = null;
  el.connectorHealth.textContent = preset.envKeys?.length
    ? `Впиши ${preset.envKeys.join(' і ')} і натисни «Зберегти».`
    : 'Перевір параметри і натисни «Зберегти».';
  el.connectorHealth.className = 'dlg-health';
  updateConnectorButtons();
  setPluginView('installed');
  window.setTimeout(() => (preset.transport === 'http' ? el.connUrlField : el.connCommand).focus(), 80);
}

function renderExtensionCatalog(): void {
  el.extensionCategories.innerHTML = '';
  const categories = ['Усі', 'Розробка', 'Дані', 'Продуктивність', 'Фічі'];
  for (const category of categories) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `extension-chip${extensionCategory === category ? ' active' : ''}`;
    button.textContent = category;
    button.addEventListener('click', () => {
      extensionCategory = category;
      renderExtensionCatalog();
    });
    el.extensionCategories.append(button);
  }

  const query = extensionQuery.trim().toLowerCase();
  const visible = EXTENSION_PRESETS.filter(preset => {
    if (extensionCategory !== 'Усі' && preset.category !== extensionCategory) return false;
    if (!query) return true;
    return `${preset.name} ${preset.description} ${preset.developer}`.toLowerCase().includes(query);
  });

  el.extensionCatalog.innerHTML = '';
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = 'Нічого не знайдено.';
    el.extensionCatalog.append(empty);
    return;
  }

  for (const preset of visible) {
    const card = document.createElement('div');
    card.className = 'extension-card';
    card.dataset.extension = preset.id;

    const mark = document.createElement('span');
    mark.className = 'extension-mark';
    mark.style.background = preset.color;
    mark.textContent = preset.initial;

    const body = document.createElement('div');
    body.className = 'extension-body';
    const head = document.createElement('div');
    head.className = 'extension-head';
    const name = document.createElement('b');
    name.textContent = preset.name;
    const badge = document.createElement('span');
    badge.className = `extension-badge${extensionInstalled(preset) ? ' installed' : ''}`;
    badge.textContent = extensionInstalled(preset) ? 'увімкнено' : preset.kind === 'instruction' ? 'інструкція' : 'MCP';
    head.append(name, badge);
    const desc = document.createElement('p');
    desc.textContent = preset.description;
    const foot = document.createElement('div');
    foot.className = 'extension-foot';
    const developer = document.createElement('span');
    developer.textContent = preset.developer;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn sm';
    action.textContent = extensionInstalled(preset) ? 'Відкрити' : 'Підключити';
    action.addEventListener('click', () => useExtension(preset));
    foot.append(developer, action);
    body.append(head, desc, foot);
    card.append(mark, body);
    el.extensionCatalog.append(card);
  }
}

el.extensionSearch.addEventListener('input', () => {
  extensionQuery = el.extensionSearch.value;
  renderExtensionCatalog();
});

async function installPluginFromGithub(): Promise<void> {  const url = el.pluginGithubUrl.value.trim();
  if (!url) {
    el.pluginGithubUrl.focus();
    return;
  }
  el.pluginGithubInstall.disabled = true;
  el.pluginGithubStatus.textContent = 'Завантажую…';
  el.pluginGithubStatus.className = 'plugin-install-status';
  const res = await ironcode.installSkillFromGithub(url);
  el.pluginGithubInstall.disabled = false;
  if (!res.ok || !res.skill) {
    el.pluginGithubStatus.textContent = res.error ?? 'Не вдалося встановити.';
    el.pluginGithubStatus.className = 'plugin-install-status bad';
    return;
  }
  el.pluginGithubUrl.value = '';
  el.pluginGithubStatus.textContent = `Встановлено: ${res.skill.name}`;
  el.pluginGithubStatus.className = 'plugin-install-status ok';
  window.setTimeout(() => {
    if (el.pluginGithubStatus.textContent?.startsWith('Встановлено:')) {
      el.pluginGithubStatus.textContent = '';
      el.pluginGithubStatus.className = 'plugin-install-status';
    }
  }, 4000);
  await refreshSkills();
  loadSkillIntoForm(res.skill);
  setPluginView('instructions');
  toast(`Інструкцію ${res.skill.name} встановлено`);
}

el.pluginGithubInstall.addEventListener('click', () => void installPluginFromGithub());
el.pluginGithubUrl.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void installPluginFromGithub();
  }
});

el.routingStrategy.addEventListener('change', async () => {
  settings = await ironcode.setSettings({
    routingStrategy: el.routingStrategy.value as Settings['routingStrategy'],
  });
  renderModelMenu();
  renderSettingsModels();
  toast('Стратегію маршрутизації збережено');
});

async function openSettings(tab: SettingsTab = 'general'): Promise<void> {
  el.setRoot.value = settings.projectsRoot;
  el.setInstructions.value = settings.instructions ?? '';
  el.setResetLayout.checked = false;
  el.permInternet.checked = Boolean(settings.allowInternet);
  el.permFiles.checked = Boolean(settings.allowFiles);
  el.permComputer.checked = Boolean(settings.allowComputer);
  renderSettingsModels();
  if (!el.settingsDlg.open) el.settingsDlg.showModal();
  await showSettingsTab(tab);
}

el.settingsBtn.addEventListener('click', () => void openSettings('general'));
el.railSettingsBtn.addEventListener('click', () => void openSettings('general'));

for (const button of document.querySelectorAll<HTMLElement>('[data-settings-tab]')) {
  button.addEventListener('click', () => {
    const tab = button.dataset.settingsTab as SettingsTab | undefined;
    if (tab) void showSettingsTab(tab);
  });
}

el.settingsClose.addEventListener('click', () => el.settingsDlg.close());
el.settingsDlg.querySelector('form')?.addEventListener('submit', e => e.preventDefault());

el.settingsProbe.addEventListener('click', () => void probeModels());

el.permSave.addEventListener('click', async () => {
  settings = await ironcode.setSettings({
    allowInternet: el.permInternet.checked,
    allowFiles: el.permFiles.checked,
    allowComputer: el.permComputer.checked,
  });
  toast('Дозволи збережено');
});

async function testFreeLlmApi(): Promise<void> {
  el.freellmTest.disabled = true;
  el.freellmTest.textContent = 'Перевіряю...';
  el.freellmStatus.textContent = 'Перевіряю з\'єднання...';
  el.freellmStatus.classList.remove('ok', 'err');
  try {
    const res = await ironcode.testFreeLlmApi();
    el.freellmStatus.textContent = res.ok
      ? `Підключено. ${res.count} моделей доступно.`
      : res.detail;
    el.freellmStatus.classList.add(res.ok ? 'ok' : 'err');
    if (!res.ok) toast(res.detail);
  } catch (err) {
    el.freellmStatus.textContent = (err as Error).message;
    el.freellmStatus.classList.add('err');
  } finally {
    el.freellmTest.disabled = false;
    el.freellmTest.textContent = 'Перевірити';
  }
}

el.freellmTest.addEventListener('click', () => void testFreeLlmApi());

el.freellmSave.addEventListener('click', async () => {
  el.freellmSave.disabled = true;
  el.freellmStatus.textContent = 'Зберігаю...';
  el.freellmStatus.classList.remove('ok', 'err');
  const key = el.freellmKey.value.trim();
  try {
    const res = await ironcode.saveFreeLlmApi(el.freellmUrl.value.trim(), key);
    if (!res.ok) {
      el.freellmStatus.textContent = res.error ?? 'Не вдалося зберегти.';
      el.freellmStatus.classList.add('err');
      toast(res.error ?? 'Не вдалося зберегти.');
      return;
    }
    settings.gatewayUrl = res.url ?? settings.gatewayUrl;
    if (key) settings.apiKey = key;
    el.freellmKey.value = '';
    renderFreeLlmApi();
    await refreshModels();
    await testFreeLlmApi();
  } finally {
    el.freellmSave.disabled = false;
  }
});

el.setSave.addEventListener('click', async () => {
  const patch: Partial<Settings> = {
    projectsRoot: el.setRoot.value.trim() || settings.projectsRoot,
    instructions: el.setInstructions.value,
  };
  if (el.setResetLayout.checked) {
    patch.leftWidth = 250;
    patch.rightWidth = 460;
  }
  settings = await ironcode.setSettings(patch);
  applyLayout();
  syncChatHeader();
  toast('Збережено');
});

/* ───────────── model & context ───────────── */

function formatLimit(value: number | null): string {
  if (!value) return '...';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function modelRankId(row: ModelRow): string {
  if (!row.provider) return row.id;
  const index = row.id.indexOf('::');
  return index >= 0 ? row.id.slice(index + 2) : row.id;
}

function speedRank(row: ModelRow): number {
  if (row.ms !== null) return row.ms;
  const id = modelRankId(row).toLowerCase();
  let rank = 1000;
  if (/(flash|mini|lite|nano|haiku|turbo|small)/.test(id)) rank -= 400;
  if (/(pro|opus|max|ultra|thinking|reasoning)/.test(id)) rank += 300;
  return rank;
}

/** Same order drives the picker and fallback. */
function sortByStrategy(rows: ModelRow[]): ModelRow[] {
  const strategy = settings.routingStrategy ?? 'balanced';
  if (strategy === 'fast') {
    return [...rows].sort((a, b) => {
      const time = speedRank(a) - speedRank(b);
      if (time !== 0) return time;
      return modelScore(modelRankId(b)) - modelScore(modelRankId(a));
    });
  }
  if (strategy === 'smart') {
    return [...rows].sort((a, b) => {
      const score = modelScore(modelRankId(b)) - modelScore(modelRankId(a));
      if (score !== 0) return score;
      return (b.context ?? 0) - (a.context ?? 0);
    });
  }
  return [...rows].sort((a, b) => {
    const score = modelScore(modelRankId(b)) - modelScore(modelRankId(a));
    if (score !== 0) return score;
    const time = speedRank(a) - speedRank(b);
    if (time !== 0) return time;
    return modelRankId(a).localeCompare(modelRankId(b));
  });
}

function usableModels(): ModelRow[] {
  const disabled = new Set(settings.disabledModels ?? []);
  return sortByStrategy(models.filter(m =>
    m.tools
    && !m.slot
    && m.verdict !== 'dead'
    && m.provider !== 'orcarouter'
    && !disabled.has(m.id)));
}

function selectedModel(): ModelRow | undefined {
  return models.find(m => m.id === settings.model);
}

function contextLimit(): number | null {
  return selectedModel()?.context ?? null;
}

function updateModelButton(): void {
  const current = selectedModel();
  el.modelBtnName.textContent = current?.provider ? current.name : settings.model;
  el.modelBtnLimit.textContent = formatLimit(current?.context ?? null);
  el.modelBtnLimit.classList.toggle('hidden', !current?.context);
  el.modelBtn.title = current
    ? `${current.id}, ліміт ${formatLimit(current.context)}${current.verdict === 'ok' ? ', перевірена' : ''}`
    : settings.model;
  updateEffortControl();
}

type ReasoningEffort = 'low' | 'medium' | 'high';

function allChats(): ChatMeta[] {
  return [...(state?.chats ?? []), ...(state?.projects.flatMap(p => p.chats) ?? [])];
}

function currentChatReasoning(): ReasoningEffort {
  return allChats().find(c => c.id === state?.activeChatId)?.reasoning ?? 'medium';
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: 'Низьке',
  medium: 'Середнє',
  high: 'Високе',
};

function updateEffortControl(): void {
  if (!el?.effortBtn) return;
  const supported = Boolean(state?.activeChatId && selectedModel()?.reasoning);
  el.effortBtn.classList.toggle('hidden', !supported);
  if (!supported) {
    el.effortPop.classList.add('hidden');
    return;
  }
  const effort = currentChatReasoning();
  el.effortLabel.textContent = EFFORT_LABEL[effort];
  el.effortBtn.dataset.level = effort;
  el.effortBtn.title = `Зусилля мислення: ${EFFORT_LABEL[effort]}`;
  el.effortModel.textContent = selectedModel()?.name ?? '';
  for (const option of document.querySelectorAll<HTMLElement>('[data-effort]')) {
    option.classList.toggle('active', option.dataset.effort === effort);
  }
}

async function setChatReasoning(effort: ReasoningEffort): Promise<void> {
  if (!state?.activeChatId) return;
  const res = await ironcode.setChatReasoning(state.activeChatId, effort);
  if (!res.ok) {
    toast(res.error ?? 'Не вдалося змінити зусилля.');
    return;
  }
  if (res.state) state = res.state;
  updateEffortControl();
  el.effortPop.classList.add('hidden');
}

async function selectModel(id: string): Promise<void> {
  if ((settings.disabledModels ?? []).includes(id)) return;
  // Selecting a catalog entry must not depend on a probe. Probes hit rate
  // limits and temporary provider outages; the send path reports those
  // honestly. The old gate here made valid models look unselectable.

  try {
    settings = await ironcode.setSettings({ model: id });
    // Do not trust a stale local settings object if another window/task
    // changed it while the picker was open.
    settings = await ironcode.getSettings();
  } catch (err) {
    toast(`Модель не збережено: ${(err as Error).message}`);
    return;
  }
  updateModelButton();
  renderModelMenu();
  renderSettingsModels();
  closeComposerPops();
  await refreshContext();
  toast(`Модель: ${id}`);}

function createModelRow(row: ModelRow): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `model-row${row.id === settings.model ? ' active' : ''}`;
  item.title = row.detail || row.name;

  const mark = document.createElement('span');
  mark.className = `model-dot ${row.verdict}`;
  const name = document.createElement('span');
  name.className = 'model-name';
  name.textContent = row.id === 'auto'
    ? 'auto, роутер'
    : row.provider
      ? row.name
      : row.id;
  const sub = document.createElement('span');
  sub.className = 'model-sub';
  const speed = row.ms !== null && row.verdict === 'ok' ? `, ${row.ms} ms` : '';
  sub.textContent = row.id === 'auto'
    ? `модель на кожен запит, ${formatLimit(row.context)}`
    : `${row.provider ? `${row.provider}, ` : ''}${formatLimit(row.context)}${speed}`;
  const body = document.createElement('span');
  body.className = 'model-body';
  body.append(name, sub);
  const check = icon('i-check');
  check.classList.toggle('hidden', row.id !== settings.model);
  check.classList.add('model-check');

  item.append(mark, body, check);
  item.addEventListener('click', () => void selectModel(row.id));
  return item;
}

/** The model picker lives under the composer, ordered the way people expect:
 *  newest and strongest first, old small models last, the router pinned top. */
function renderModelMenu(): void {
  const usable = usableModels();
  const hidden = models.filter(m => !m.tools || m.verdict === 'dead').length;
  el.modelList.innerHTML = '';

  if (!usable.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = 'Каталог порожній. Додай API-ключ у Провайдерах.';
    el.modelList.append(empty);
  }

  for (const row of usable) el.modelList.append(createModelRow(row));

  const spacer = document.createElement('div');
  spacer.className = 'model-spacer';
  el.modelList.append(spacer);
  const note = document.createElement('div');
  note.className = 'model-note';
  note.textContent = hidden
    ? `Приховано ${hidden}: без tools або не відповідають.`
    : 'Показано всі живі моделі.';
  el.modelList.append(note);
  el.probeBtn.title = hidden
    ? `Перевірити моделі. Приховано ${hidden}: без tools або не відповідають.`
    : 'Перевірити, які моделі справді відповідають';
}

function formatUsage(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

async function refreshUsage(): Promise<void> {
  usageSnapshot = await ironcode.getUsage();
  el.usageTotal.textContent = `За місяць: ${formatUsage(usageSnapshot.total)} токенів`;
}

function renderSettingsModels(): void {
  if (!el.settingsModelList) return;
  const visible = sortByStrategy(models.filter(m =>
    m.tools
    && !m.slot
    && m.verdict !== 'dead'
    && m.provider !== 'orcarouter'));
  const disabled = new Set(settings.disabledModels ?? []);
  el.settingsModelList.innerHTML = '';
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = 'Каталог порожній. Перевір підключення.';
    el.settingsModelList.append(empty);
    return;
  }
  for (const row of visible) {
    const wrap = document.createElement('div');
    wrap.className = 'settings-model-item';
    const item = createModelRow(row);
    item.classList.add('settings-model-row');
    const usage = usageSnapshot?.models[row.id];
    const meta = document.createElement('span');
    meta.className = 'settings-model-meta';
    meta.textContent = usage?.total ? `${formatUsage(usage.total)} токенів` : 'без використання';
    const toggle = document.createElement('label');
    toggle.className = 'model-toggle';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !disabled.has(row.id);
    check.title = check.checked ? 'Вимкнути модель' : 'Увімкнути модель';
    check.addEventListener('change', async e => {
      e.stopPropagation();
      const next = new Set(settings.disabledModels ?? []);
      if (check.checked) next.delete(row.id);
      else next.add(row.id);
      settings = await ironcode.setSettings({ disabledModels: [...next] });
      if (!check.checked && settings.model === row.id) {
        const fallback = usableModels().find(m => m.id === 'auto')?.id ?? usableModels()[0]?.id ?? 'auto';
        settings = await ironcode.setSettings({ model: fallback });
      }
      updateModelButton();
      renderModelMenu();
      renderSettingsModels();
      await refreshContext();
    });
    toggle.append(check, meta);
    wrap.append(item, toggle);
    el.settingsModelList.append(wrap);
  }
}

async function chooseFallbackIfNeeded(): Promise<void> {
  // The backend does the real check before a turn; this only keeps the button
  // honest when settings.model points at a slot the picker hides.
  if (!models.length) return;
  const usable = usableModels();
  if (settings.model && !usable.some(m => m.id === settings.model)) {
    const next = usable.find(m => m.id === 'auto')?.id ?? usable[0]?.id ?? 'auto';
    settings = await ironcode.setSettings({ model: next });
  }
}

async function refreshModels(): Promise<void> {
  try {
    const res = await ironcode.listModels();
    models = res.models;
    await chooseFallbackIfNeeded();
    updateModelButton();
    renderModelMenu();
    renderSettingsModels();
    await refreshContext();
  } catch {
    models = [];
    updateModelButton();
    renderModelMenu();
    renderSettingsModels();
    void refreshContext();
  }
}

ironcode.onModelProgress(({ done, total }) => {
  const label = `Перевіряю моделі: ${done}/${total}`;
  el.probeBtn.title = label;
  el.settingsProbe.title = label;
});

async function probeModels(): Promise<void> {
  if (el.probeBtn.classList.contains('spinning')) return;
  el.probeBtn.classList.add('spinning');
  el.settingsProbe.classList.add('spinning');
  addSystem('Перевіряю, які моделі справді відповідають…');
  try {
    const { summary, models: next } = await ironcode.probeModels();
    models = next;
    await chooseFallbackIfNeeded();
    updateModelButton();
    renderModelMenu();
    renderSettingsModels();
    await refreshContext();
    const withTools = models.filter(m => m.tools && m.verdict === 'ok').length;
    addSystem(
      `Перевірено ${summary.total}: відповіли ${summary.ok}, не відповіли ${summary.dead}. `
      + `Для агента придатні ${withTools}.`,
      'model',
    );
  } catch (err) {
    addSystem(`перевірка не вдалась: ${(err as Error).message}`, 'err');
  } finally {
    el.probeBtn.classList.remove('spinning');
    el.settingsProbe.classList.remove('spinning');
  }
}

el.probeBtn.addEventListener('click', () => void probeModels());

/* ── context meter ── */

async function refreshContext(): Promise<void> {
  try {
    contextState = await ironcode.context();
  } catch {
    contextState = null;
  }
  renderContext();
}

function contextRow(color: string, label: string, value: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ctx-row';
  const dot = document.createElement('i');
  dot.className = 'ctx-dot';
  dot.style.background = color;
  const name = document.createElement('span');
  name.textContent = label;
  const amount = document.createElement('b');
  amount.textContent = `~${formatTokens(value)}`;
  row.append(dot, name, amount);
  return row;
}

function renderContext(): void {
  const limit = contextLimit();
  const snapshot = contextState;
  const total = snapshot?.total ?? 0;
  const rawPercent = limit ? (total / limit) * 100 : 0;
  const percent = Math.min(999, Math.round(rawPercent));
  const shown = limit ? percent : 0;

  const circumference = 2 * Math.PI * 12.5;
  const known = Boolean(limit);
  el.contextBtn.classList.toggle('hidden', !known);
  el.contextPercent.classList.toggle('hidden', !known);
  const filled = Math.min(1, Math.max(0, rawPercent / 100));
  el.ctxArc.style.strokeDasharray = `${circumference}`;
  el.ctxArc.style.strokeDashoffset = `${circumference * (1 - filled)}`;
  el.contextPercent.textContent = known ? `${shown}%` : '';
  el.contextBtn.classList.toggle('warn', Boolean(limit) && rawPercent >= 80 && rawPercent < 100);
  el.contextBtn.classList.toggle('bad', Boolean(limit) && rawPercent >= 100);
  el.contextBtn.title = limit
    ? `Контекст: ~${formatTokens(total)} із ${formatLimit(limit)} (${shown}%)`
    : 'Ліміт контексту вибраної моделі невідомий';

  el.ctxModelName.textContent = `${settings.model}, ${formatLimit(limit)}`;
  el.ctxPercentBig.textContent = limit ? `${shown}%` : '...';
  el.ctxTotal.textContent = `~${formatTokens(total)} / ${formatLimit(limit)}`;
  el.ctxFill.style.width = `${Math.min(100, rawPercent)}%`;
  el.ctxFill.className = rawPercent >= 100 ? 'bad' : rawPercent >= 80 ? 'warn' : '';

  el.ctxRows.innerHTML = '';
  if (!snapshot || total === 0) {
    const empty = document.createElement('div');
    empty.className = 'ctx-empty';
    empty.textContent = 'Даних ще немає. Надішли перше повідомлення.';
    el.ctxRows.append(empty);
  } else {
    el.ctxRows.append(
      contextRow('#8a8071', 'Системний промт', snapshot.system),
      contextRow('#b6421e', 'Інструменти', snapshot.tools),
      contextRow('#5f574b', `Повідомлення, ${snapshot.messageCount}`, snapshot.messages),
    );
  }
}

function closeComposerPops(): void {
  el.modelPop.classList.add('hidden');
  el.contextPop.classList.add('hidden');
  el.effortPop.classList.add('hidden');
}

el.effortBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = el.effortPop.classList.contains('hidden');
  closeComposerPops();
  if (!open) return;
  updateEffortControl();
  el.effortPop.classList.remove('hidden');
});

for (const option of document.querySelectorAll<HTMLElement>('[data-effort]')) {
  option.addEventListener('click', () => {
    void setChatReasoning(option.dataset.effort as ReasoningEffort);
  });
}

el.modelBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = el.modelPop.classList.contains('hidden');
  closeComposerPops();
  if (open) {
    renderModelMenu();
    el.modelPop.classList.remove('hidden');
  }
});

el.contextBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = el.contextPop.classList.contains('hidden');
  closeComposerPops();
  if (open) {
    void refreshContext().then(() => el.contextPop.classList.remove('hidden'));
  }
});

document.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  if (target.closest('#modelPop, #contextPop, #effortPop, #modelBtn, #contextBtn, #effortBtn')) return;
  closeComposerPops();
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeComposerPops();
});

function closeModePop(): void {
  el.modePop.classList.add('hidden');
  el.modeBtn.setAttribute('aria-expanded', 'false');
}

function updateModeButton(): void {
  const meta = {
    ask: { title: 'Звичайний', icon: 'i-lock' },
    auto: { title: 'Авто', icon: 'i-shield' },
    turbo: { title: 'Турбо', icon: 'i-bolt' },
  }[settings.approvalMode] ?? { title: 'Звичайний', icon: 'i-lock' };

  el.modeBtnLabel.textContent = meta.title;
  el.modeBtnUse.setAttribute('href', `#${meta.icon}`);
  for (const option of el.modePop.querySelectorAll<HTMLElement>('[data-mode]')) {
    const active = option.dataset.mode === settings.approvalMode;
    option.classList.toggle('active', active);
    option.setAttribute('aria-selected', String(active));
  }
}

el.modeBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = el.modePop.classList.contains('hidden');
  closeComposerPops();
  closeModePop();
  if (open) {
    updateModeButton();
    el.modePop.classList.remove('hidden');
    el.modeBtn.setAttribute('aria-expanded', 'true');
  }
});

for (const option of el.modePop.querySelectorAll<HTMLElement>('[data-mode]')) {
  option.addEventListener('click', async e => {
    e.stopPropagation();
    const mode = option.dataset.mode as Settings['approvalMode'];
    settings = await ironcode.setSettings({ approvalMode: mode });
    updateModeButton();
    closeModePop();
  });
}

document.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  if (!target.closest('.mode-wrap')) closeModePop();
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeComposerPops();
    closeModePop();
  }
});

/* ───────────── skills ───────────── */

let editingSkill: string | null = null;
/** Serialized form state as last loaded or saved, for the dirty check. */
let skillBaseline = '';

function skillFormSnapshot(): string {
  return JSON.stringify([
    el.skillName.value.trim(),
    el.skillDesc.value.trim(),
    el.skillAlways.checked,
    el.skillBody.value,
  ]);
}

/**
 * An always-live Save button invites saving over a skill the user only clicked
 * to read, so it stays disabled until something actually changed.
 */
function updateSkillButtons(): void {
  const named = el.skillName.value.trim().length > 0;
  el.skillSave.disabled = !named || skillFormSnapshot() === skillBaseline;
  el.skillDelete.disabled = editingSkill === null;
}

function syncPluginCounts(): void {
  el.pluginInstructionCount.textContent = String(skills.length);
  el.pluginToolCount.textContent = String(connectors.length);
  el.pluginCount.textContent = String(skills.length + connectors.length);
}

function renderSkills(): void {
  el.pluginInstructionCount.textContent = String(skills.length);
  syncPluginCounts();
  el.skillsList.innerHTML = '';
  for (const skill of skills) {
    const item = document.createElement('div');
    item.className = `skill-item${skill.name === editingSkill ? ' active' : ''}`;
    const name = document.createElement('b');
    name.textContent = skill.name;
    const desc = document.createElement('span');
    desc.textContent = skill.description || '(без опису)';
    item.append(name, desc);
    if (skill.always) {
      const flag = document.createElement('span');
      flag.className = 'always';
      flag.textContent = 'завжди';
      item.append(flag);
    }
    item.addEventListener('click', () => loadSkillIntoForm(skill));
    el.skillsList.append(item);
  }
}

function loadSkillIntoForm(skill: Skill | null): void {
  editingSkill = skill?.name ?? null;
  el.skillName.value = skill?.name ?? '';
  el.skillDesc.value = skill?.description ?? '';
  el.skillAlways.checked = skill?.always ?? false;
  el.skillBody.value = skill?.body ?? '';
  skillBaseline = skillFormSnapshot();
  renderSkills();
  updateSkillButtons();
}

for (const field of [el.skillName, el.skillDesc, el.skillBody]) {
  field.addEventListener('input', updateSkillButtons);
}
el.skillAlways.addEventListener('change', updateSkillButtons);

async function refreshSkills(): Promise<void> {
  skills = await ironcode.listSkills();
  renderSkills();
  renderExtensionCatalog();
}

el.skillNew.addEventListener('click', e => {
  e.preventDefault();
  loadSkillIntoForm(null);
  el.skillName.focus();
});

el.skillSave.addEventListener('click', async e => {
  e.preventDefault();
  if (el.skillSave.disabled) return;
  const name = el.skillName.value.trim();
  if (!name) return;
  const res = await ironcode.saveSkill({
    name,
    description: el.skillDesc.value.trim(),
    always: el.skillAlways.checked,
    body: el.skillBody.value,
  });
  if (!res.ok) return;
  await refreshSkills();
  loadSkillIntoForm(skills.find(s => s.name === res.skill?.name) ?? null);
});

el.skillDelete.addEventListener('click', async e => {
  e.preventDefault();
  if (el.skillDelete.disabled || !editingSkill) return;
  if (!window.confirm(`Видалити скіл «${editingSkill}»?`)) return;
  await ironcode.deleteSkill(editingSkill);
  await refreshSkills();
  loadSkillIntoForm(skills[0] ?? null);
});

el.skillImport.addEventListener('click', async e => {
  e.preventDefault();
  const res = await ironcode.importSkill();
  if (!res.ok) return;
  await refreshSkills();
  loadSkillIntoForm(skills.find(s => s.name === res.skill?.name) ?? null);
});

el.skillReveal.addEventListener('click', e => {
  e.preventDefault();
  void ironcode.revealSkills();
});


/* ───────────── connectors ───────────── */

let connectors: ConnectorSummary[] = [];
let editingConnector: string | null = null;
let connectorBaseline = '';

/** "KEY=VALUE" lines <-> object, the shape env vars and headers are entered in. */
function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function connectorSnapshot(): string {
  return JSON.stringify([
    el.connName.value.trim(),
    el.connDesc.value.trim(),
    el.connTransport.value,
    el.connCommand.value.trim(),
    el.connArgs.value,
    el.connEnv.value,
    el.connUrlField.value.trim(),
    el.connHeaders.value,
    el.connEnabled.checked,
    el.connScope.value,
  ]);
}

function updateConnectorButtons(): void {
  const named = el.connName.value.trim().length > 0;
  el.connectorSave.disabled = !named || connectorSnapshot() === connectorBaseline;
  el.connectorDelete.disabled = editingConnector === null;
  el.connectorTest.disabled = editingConnector === null;
}

function syncTransportFields(): void {
  const stdio = el.connTransport.value === 'stdio';
  el.stdioFields.classList.toggle('hidden', !stdio);
  el.httpFields.classList.toggle('hidden', stdio);
}

function renderConnectors(): void {
  el.pluginToolCount.textContent = String(connectors.length);
  syncPluginCounts();
  el.connectorsList.innerHTML = '';

  if (!connectors.length) {
    const empty = document.createElement('div');
    empty.className = 'quick-empty';
    empty.textContent = 'Конекторів ще немає';
    el.connectorsList.append(empty);
    return;
  }

  for (const connector of connectors) {
    const item = document.createElement('div');
    item.className = 'skill-item conn-item' + (connector.id === editingConnector ? ' active' : '');

    const name = document.createElement('b');
    name.textContent = connector.name;
    const desc = document.createElement('span');
    desc.textContent = connector.description || connector.command || connector.url || '';
    item.append(name, desc);

    const state = document.createElement('span');
    if (!connector.enabled) {
      state.className = 'state off';
      state.textContent = 'вимкнено';
    } else if (connector.status === 'ready') {
      state.className = 'state ready';
      state.textContent = connector.toolCount + ' інструментів';
    } else if (connector.status === 'error') {
      state.className = 'state error';
      state.textContent = 'помилка';
    } else {
      state.className = 'state idle';
      state.textContent = 'не перевірено';
    }
    item.append(state);

    item.addEventListener('click', () => loadConnectorIntoForm(connector));
    el.connectorsList.append(item);
  }
}

function loadConnectorIntoForm(connector: ConnectorSummary | null): void {
  editingConnector = connector?.id ?? null;
  el.connName.value = connector?.name ?? '';
  el.connDesc.value = connector?.description ?? '';
  el.connTransport.value = connector?.transport ?? 'stdio';
  el.connCommand.value = connector?.command ?? '';
  el.connArgs.value = (connector?.args ?? []).join('\n');
  el.connUrlField.value = connector?.url ?? '';
  el.connEnabled.checked = connector?.enabled ?? true;
  el.connScope.value = connector?.scope ?? 'all';

  // Secret values never leave the main process, so only their names come back.
  const secrets = connector?.secretKeys ?? [];
  const placeholder = secrets.length
    ? secrets.map(k => k + '=(збережено)').join('\n')
    : '';
  el.connEnv.value = '';
  el.connHeaders.value = '';
  el.connEnv.placeholder = connector?.transport === 'stdio' && placeholder
    ? placeholder
    : 'GITHUB_TOKEN=...';
  el.connHeaders.placeholder = connector?.transport === 'http' && placeholder
    ? placeholder
    : 'Authorization=Bearer ...';

  el.connectorHealth.textContent = connector?.statusDetail ?? '';
  el.connectorHealth.className = 'dlg-health' + (connector?.status === 'error' ? ' bad' : '');

  syncTransportFields();
  connectorBaseline = connectorSnapshot();
  renderConnectors();
  updateConnectorButtons();
}

for (const field of [el.connName, el.connDesc, el.connCommand, el.connArgs, el.connEnv, el.connUrlField, el.connHeaders]) {
  field.addEventListener('input', updateConnectorButtons);
}
for (const field of [el.connTransport, el.connScope]) {
  field.addEventListener('change', () => {
    syncTransportFields();
    updateConnectorButtons();
  });
}
el.connEnabled.addEventListener('change', updateConnectorButtons);

async function refreshConnectors(): Promise<void> {
  connectors = await ironcode.listConnectors();
  renderConnectors();
  renderExtensionCatalog();
}

el.connectorNew.addEventListener('click', e => {
  e.preventDefault();
  loadConnectorIntoForm(null);
  el.connName.focus();
});

el.connectorSave.addEventListener('click', async e => {
  e.preventDefault();
  if (el.connectorSave.disabled) return;

  const env = parsePairs(el.connEnv.value);
  const headers = parsePairs(el.connHeaders.value);
  const payload: Record<string, unknown> = {
    id: editingConnector ?? undefined,
    name: el.connName.value.trim(),
    description: el.connDesc.value.trim(),
    transport: el.connTransport.value,
    command: el.connCommand.value.trim(),
    args: el.connArgs.value.split('\n').map(a => a.trim()).filter(Boolean),
    url: el.connUrlField.value.trim(),
    enabled: el.connEnabled.checked,
    scope: el.connScope.value,
    projects: el.connScope.value === 'selected' && state.activeProjectId ? [state.activeProjectId] : [],
  };
  // Omitting the maps means "keep what is stored", so a blank field cannot
  // silently erase a token the user never retyped.
  if (Object.keys(env).length) payload.env = env;
  if (Object.keys(headers).length) payload.headers = headers;

  const res = await ironcode.saveConnector(payload);
  if (!res.ok) {
    el.connectorHealth.textContent = res.error ?? 'Не вдалося зберегти';
    el.connectorHealth.className = 'dlg-health bad';
    return;
  }
  await refreshConnectors();
  loadConnectorIntoForm(connectors.find(c => c.id === res.connector?.id) ?? null);
});

el.connectorDelete.addEventListener('click', async e => {
  e.preventDefault();
  if (el.connectorDelete.disabled || !editingConnector) return;
  const current = connectors.find(c => c.id === editingConnector);
  if (!window.confirm('Видалити конектор «' + (current?.name ?? '') + '»?')) return;
  await ironcode.deleteConnector(editingConnector);
  await refreshConnectors();
  loadConnectorIntoForm(connectors[0] ?? null);
});

el.connectorTest.addEventListener('click', async e => {
  e.preventDefault();
  if (!editingConnector) return;
  el.connectorHealth.textContent = 'підключаюсь…';
  el.connectorHealth.className = 'dlg-health';
  const res = await ironcode.testConnector(editingConnector);
  el.connectorHealth.textContent = res.ok
    ? res.detail + (res.tools.length ? ', ' + res.tools.slice(0, 8).join(', ') : '')
    : res.detail;
  el.connectorHealth.className = 'dlg-health ' + (res.ok ? 'ok' : 'bad');
  await refreshConnectors();
});

/* ───────────── shortcuts ───────────── */

window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();

  if (key === 's') { e.preventDefault(); void saveEditor(); }
  else if (key === 'p') { e.preventDefault(); openQuick(); }
  else if (key === 'b') { e.preventDefault(); void togglePanel('left'); }
  else if (key === '\\') { e.preventDefault(); void togglePanel('right'); }
});

/* ───────────── boot ───────────── */

const chatShell = document.querySelector<HTMLElement>('.chat');
const composerShell = document.querySelector<HTMLElement>('.composer-shell');
function syncComposerSpace(): void {
  if (!chatShell || !composerShell) return;
  const height = Math.ceil(composerShell.getBoundingClientRect().height);
  // The composer is a normal block now; the measured height only places the
  // "jump to the last message" button just above it.
  chatShell.style.setProperty('--composer-space', `${height + 12}px`);
}
if (chatShell && composerShell) {
  new ResizeObserver(syncComposerSpace).observe(composerShell);
  window.addEventListener('resize', syncComposerSpace);
  syncComposerSpace();
}

(async function init(): Promise<void> {
  settings = await ironcode.getSettings();  state = await ironcode.state();

  applyTheme();
  applyLayout();
  dragSplitter(el.splitLeft, 'left');
  dragSplitter(el.splitRight, 'right');

  updateModeButton();
  el.routingStrategy.value = settings.routingStrategy ?? 'balanced';
  showTab('files');
  renderRail();
  syncProjectLabel();
  syncChatHeader();

  if (state.activeChatId) {
    try {
      const res = await ironcode.selectChat(state.activeProjectId, state.activeChatId);
      state = res.state;
      renderRail();
      syncChatHeader();
      renderHistory(res.messages);
      setRunning(Boolean(res.running));
    } catch (err) {
      // A locked/corrupt chat file must not abort the rest of boot. Models,
      // providers, permissions and appearance still have to work.
      addSystem(`Не вдалося відкрити чат: ${(err as Error).message}`, 'err');
      showEmptyChat();
    }
  } else {
    showEmptyChat();
  }
  restoreQueues();
  renderQueue();

  await refreshTree();
  await refreshModels();
  await refreshSkills();

  if (!settings.apiKey) {
    addSystem('Free LLM API не налаштовано. Відкрий Налаштування → Free LLM API.', 'err');
  }
  el.input.focus();

  // Printed with --enable-logging; the single signal that the whole boot path
  // completed rather than throwing midway.
  console.log(
    `Vela ready | projects=${state.projects.length} | models=${models.length} | skills=${skills.length} | connectors=${connectors.length}`,
  );
})();
