/**
 * Preview harness preload: a static `window.ironcode` so the real renderer can
 * boot outside Electron's main process. Nothing here touches the OS — it exists
 * only to render the UI for design review.
 */
const { contextBridge } = require('electron');

const NOW = Date.now();
const MIN = 60_000;

const settings = {
  model: 'google::gemini-3.5-flash',
  projectsRoot: 'C:\\Users\\Admin\\VelaProjects',
  approvalMode: 'auto',
  instructions: '',
  allowInternet: true,
  allowFiles: true,
  allowComputer: true,
  theme: 'indigo',
  disabledModels: [],
  routingStrategy: 'balanced',
  leftWidth: 268,
  rightWidth: 0,
  rightCollapsed: true,
  leftCollapsed: false,
};

const chat1 = { id: 'c_1', title: 'Рефакторинг парсера', createdAt: NOW - 90 * MIN, updatedAt: NOW - 2 * MIN };
const chat2 = { id: 'c_2', title: 'Дизайн головної', createdAt: NOW - 240 * MIN, updatedAt: NOW - 60 * MIN };
const chat3 = { id: 'c_3', title: 'Telegram-бот на Python', createdAt: NOW - 480 * MIN, updatedAt: NOW - 300 * MIN };

const project = {
  id: 'p_1',
  name: 'vela-app',
  path: 'C:\\Users\\Admin\\VelaProjects\\vela-app',
  createdAt: NOW - 500 * MIN,
  chats: [chat1, chat2],
};

const state = {
  projects: [project],
  chats: [chat3],
  chatsFolder: 'C:\\Users\\Admin',
  activeProjectId: 'p_1',
  activeChatId: 'c_1',
  pinned: [],
  runningChatId: null,
  missingProjects: [],
  projectProblems: [],
  chatsFolderMissing: false,
  chatsFolderProblem: 'ok',
  maxChats: 200,
  workspaceRoot: 'C:\\Users\\Admin\\VelaProjects\\vela-app',
  activeChatFolder: null,
  loadError: null,
};

const messages = [
  {
    role: 'user',
    content: 'Перепиши парсер так, щоб він не падав на битих рядках. Поясни, що саме змінив.',
    at: NOW - 12 * MIN,
  },
  {
    role: 'assistant',
    content: 'Прочитав `src/parse.ts` і тести. Проблема в тому, що `JSON.parse` кидає на першому ж битому рядку і тягне за собою весь пакет.\n\n**Що змінив:**\n\n- обгорнув розбір рядка в `try/catch` і збираю помилки в масив;\n- додав ліміт на кількість збоїв, щоб цикл не жив вічно;\n- повертаю `{ rows, failed }` замість кидка.\n\n| Було | Стало |\n| --- | --- |\n| падіння на першому рядку | рядок пропускається, решта читається |\n| без діагностики | `failed[]` з номером і причиною |\n',
    at: NOW - 11 * MIN,
  },
  {
    role: 'assistant',
    content: null,
    at: NOW - 10 * MIN,
    tool_calls: [
      { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/parse.ts"}' } },
      { id: 't2', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src/parse.ts"}' } },
      { id: 't3', type: 'function', function: { name: 'run_shell', arguments: '{"command":"npm test"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 't1', name: 'read_file', content: 'src/parse.ts (48 рядків)' },
  { role: 'tool', tool_call_id: 't2', name: 'edit_file', content: 'відредаговано: src/parse.ts' },
  { role: 'tool', tool_call_id: 't3', name: 'run_shell', content: 'exit code 0\n\nstdout:\n✓ 14 тестів пройдено' },
  {
    role: 'assistant',
    content: 'Готово. Тести проходять: 14 із 14.\n\n```ts\nexport function parse(text: string): Parsed {\n  const rows: Row[] = [];\n  const failed: Failure[] = [];\n\n  for (const [index, line] of text.split("\\n").entries()) {\n    if (!line.trim()) continue;\n    try {\n      rows.push(JSON.parse(line));\n    } catch (err) {\n      failed.push({ index, reason: (err as Error).message });\n    }\n  }\n\n  return { rows, failed };\n}\n```\n\nБитий рядок більше не зупиняє обробку, а причина потрапляє в `failed`.',
    at: NOW - 9 * MIN,
  },
  {
    role: 'user',
    content: 'Добре. Ще додай, будь ласка, лічильник у лог.',
    at: NOW - 3 * MIN,
  },
  {
    role: 'assistant',
    content: 'Додав: наприкінці розбору пише `parsed=128 failed=2`. Зміна в одному місці, без нових залежностей.',
    at: NOW - 2 * MIN,
  },
];

const models = [
  { id: 'google::gemini-3.5-flash', name: 'Gemini 3.5 Flash', context: 1_000_000, tools: true, provider: 'google', slot: false, verdict: 'ok', ms: 2093, detail: '' },
  { id: 'google::gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', context: 2_000_000, tools: true, provider: 'google', slot: false, verdict: 'ok', ms: 2513, detail: '' },
  { id: 'groq::llama-3.3-70b', name: 'Llama 3.3 70B', context: 131_072, tools: true, provider: 'groq', slot: false, verdict: 'ok', ms: 890, detail: '' },
  { id: 'openrouter::anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context: 200_000, tools: true, provider: 'openrouter', slot: false, verdict: 'ok', ms: 1724, detail: '' },
  { id: 'nvidia::deepseek-r1', name: 'DeepSeek R1', context: 128_000, tools: true, provider: 'nvidia', slot: false, verdict: 'dead', ms: 20005, detail: 'таймаут 20000ms' },
];

const providers = [
  { id: 'google', name: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hint: 'Gemini API key з aistudio.google.com', docs: 'https://aistudio.google.com/apikey', configured: true, enabled: true, keyMask: 'AIz…9f2c', status: 'ok', detail: 'Підключено, 50 моделей', checkedAt: NOW - 30 * MIN, modelCount: 50 },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai', hint: 'Ключ з console.groq.com', docs: 'https://console.groq.com/keys', configured: true, enabled: true, keyMask: 'gsk…71ab', status: 'ok', detail: 'Підключено, 11 моделей', checkedAt: NOW - 40 * MIN, modelCount: 11 },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', hint: 'Ключ з openrouter.ai/keys', docs: 'https://openrouter.ai/keys', configured: true, enabled: true, keyMask: 'sk-…4d0e', status: 'ok', detail: 'Підключено, 416 моделей', checkedAt: NOW - 50 * MIN, modelCount: 416 },
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com', hint: 'Ключ з build.nvidia.com', docs: 'https://build.nvidia.com', configured: false, enabled: false, keyMask: '', status: 'unknown', detail: '', checkedAt: null, modelCount: null },
];

const skills = [
  { name: 'static-site', description: 'Структура й вимоги до статичного сайту', always: false, body: '' },
  { name: 'code-review', description: 'Огляд коду: що перевіряти і в якому порядку', always: false, body: '' },
  { name: 'writing-style', description: 'Живий розмовний стиль', always: true, body: '' },
];

const connectors = [
  { id: 'conn_1', name: 'github', description: 'Репозиторії, issues, pull requests', transport: 'http', url: 'https://github.com/', enabled: true, scope: 'all', projects: [], secretKeys: ['Authorization'], status: 'ready', statusDetail: '3 інструментів', toolCount: 3 },
];

const treeNodes = [
  { name: 'src', path: 'src', dir: true, children: [
    { name: 'parse.ts', path: 'src/parse.ts', dir: false },
    { name: 'agent.ts', path: 'src/agent.ts', dir: false },
    { name: 'tools', path: 'src/tools', dir: true, children: [
      { name: 'index.ts', path: 'src/tools/index.ts', dir: false },
    ] },
  ] },
  { name: 'scripts', path: 'scripts', dir: true, children: [
    { name: 'preview.cjs', path: 'scripts/preview.cjs', dir: false },
  ] },
  { name: 'README.md', path: 'README.md', dir: false },
  { name: 'package.json', path: 'package.json', dir: false },
];

const usage = {
  month: new Date().toISOString().slice(0, 7),
  models: { 'google::gemini-3.5-flash': { prompt: 184_320, completion: 42_180, total: 226_500, requests: 64 } },
  total: 226_500,
};

const context = { system: 2_400, tools: 1_860, messages: 5_120, total: 9_380, messageCount: messages.length, model: 'google::gemini-3.5-flash' };

let agentHandler = null;

contextBridge.exposeInMainWorld('ironcode', {
  getSettings: async () => settings,
  setSettings: async patch => Object.assign(settings, patch),
  state: async () => state,
  selectChat: async () => ({ state, messages, running: false }),
  createChat: async () => state,
  selectProject: async () => state,
  tree: async () => ({ root: state.workspaceRoot, nodes: treeNodes }),
  listModels: async () => ({ models, checkedAt: NOW }),
  listProviders: async () => providers,
  listSkills: async () => skills,
  listConnectors: async () => connectors,
  getUsage: async () => usage,
  context: async () => context,
  readFile: async () => ({ ok: true, content: '// preview' }),
  readImage: async () => ({ ok: false, error: 'preview' }),
  saveFile: async () => ({ ok: true }),
  send: async () => ({ ok: true }),
  retryLast: async () => ({ ok: true }),
  cancel: () => {},
  approve: () => {},
  onAgentEvent: handler => { agentHandler = handler; },
  onModelProgress: () => {},
  filePath: () => '',
  videoSupport: async () => false,
  pickAttachments: async () => ({ ok: false, items: [] }),
  attachPaths: async () => ({ ok: true, items: [] }),
  attachBytes: async () => ({ ok: true, items: [] }),
  startPreview: async () => ({ ok: false }),
  openExternal: async () => ({ ok: true }),
  __emit: event => agentHandler && agentHandler(event),
});
