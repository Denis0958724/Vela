/**
 * End-to-end smoke test of the agent core, with Electron out of the picture.
 *
 *   npm run smoke
 *
 * Drives a real task against the real gateway in a throwaway folder and then
 * asserts on the filesystem, so a regression in the streaming parser, the tool
 * dispatch or the approval path fails here rather than in the UI.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/main/agent.js';
import { GatewayClient } from '../src/main/gateway.js';
import { Workspace } from '../src/main/workspace.js';
import { PathEscapeError } from '../src/main/workspace.js';
import type { AgentEvent } from '../src/main/types.js';
import type { SkillRegistry } from '../src/main/skills.js';
import type { ConnectorRegistry } from '../src/main/connectors.js';
import type { Attachment } from '../src/main/attachments.js';

/**
 * The real registry reads Electron's userData path, which does not exist in a
 * plain Node process. The agent only ever calls `list` and `get`, so a stub
 * keeps this harness Electron-free while exercising the same code path.
 */
const noSkills = {
  list: async () => [],
  get: async () => null,
} as unknown as SkillRegistry;

/** No connectors in the harness: the agent only needs these three members. */
const noConnectors = {
  toolsFor: async () => [],
  owns: () => false,
  describe: (n: string) => n,
  call: async () => '',
} as unknown as ConnectorRegistry;

const URL = process.env.IRONCODE_GATEWAY_URL ?? 'http://127.0.0.1:31415';
const KEY = process.env.IRONCODE_API_KEY ?? '';

let failures = 0;
function check(label: string, pass: boolean, extra = ''): void {
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!pass) failures++;
}

async function testPathSafety(): Promise<void> {
  console.log('\n[1] Пісочниця шляхів');
  const ws = new Workspace(join(tmpdir(), 'ironcode-smoke'));
  for (const bad of ['../../Windows/System32/drivers/etc/hosts', 'C:/Windows/win.ini', '..']) {
    let blocked = false;
    try {
      ws.safe(bad);
    } catch (err) {
      blocked = err instanceof PathEscapeError;
    }
    check(`відхилено «${bad}»`, blocked);
  }
  check('дозволено «src/app.ts»', ws.safe('src/app.ts').includes('ironcode-smoke'));
}

async function testGateway(): Promise<void> {
  console.log('\n[2] Шлюз');
  const gw = new GatewayClient(URL, KEY);
  const health = await gw.health();
  check('шлюз відповідає', health.ok, health.detail);
  if (!health.ok) return;
  const models = await gw.listModels();
  const withTools = models.filter(m => m.supported_parameters?.includes('tools'));
  check('є моделі з tools', withTools.length > 0, `${withTools.length} із ${models.length}`);
}

async function testAgentLoop(): Promise<void> {
  console.log('\n[3] Агентний цикл (реальна задача)');
  const dir = await fs.mkdtemp(join(tmpdir(), 'ironcode-agent-'));
  const ws = new Workspace(dir);
  const gw = new GatewayClient(URL, KEY);

  const toolsUsed: string[] = [];
  let text = '';
  let error = '';
  let stopReason = '';

  const agent = new Agent(gw, ws, noSkills, noConnectors, (e: AgentEvent) => {
    if (e.kind === 'tool_start') toolsUsed.push(e.name);
    if (e.kind === 'text') text += e.delta;
    if (e.kind === 'error') error = e.message;
    if (e.kind === 'turn_end') stopReason = e.stopReason;
    if (e.kind === 'model' && e.note) console.log(`    (${e.note})`);
  });

  // Closing the app mid-turn used to throw away everything done so far, so the
  // checkpoints are asserted, not assumed.
  const checkpoints: number[] = [];
  agent.onProgress = (_chatId, history) => checkpoints.push(history.length);
  let completedWith = -1;
  agent.onTurnComplete = (_chatId, history) => { completedWith = history.length; };
  agent.setHistory([], 'chat-under-test');

  console.log(`    робоча папка: ${dir}`);
  const task = 'Створи файл hello.txt із текстом "Ironcode працює", потім прочитай його і підтверди вміст.';
  await agent.run(task, 'auto', 'auto');

  check('без помилок', !error, error);
  check('цикл завершився нормально', stopReason === 'stop' || stopReason === 'end_turn', stopReason);
  check('інструменти викликались', toolsUsed.length > 0, toolsUsed.join(', ') || 'жодного');
  check('write_file використано', toolsUsed.includes('write_file'));

  const content = await fs.readFile(join(dir, 'hello.txt'), 'utf8').catch(() => null);
  check('файл hello.txt створено', content !== null);
  check('вміст правильний', Boolean(content?.includes('Ironcode')), content?.trim().slice(0, 60) ?? '—');
  check('модель дала фінальну відповідь', text.trim().length > 0, `${text.trim().length} символів`);

  check('прогрес зберігався ПІД ЧАС ходу', checkpoints.length >= 2,
    `${checkpoints.length} контрольних точок: ${checkpoints.join(' → ')}`);
  check('перша точка — одразу після промту', checkpoints[0] === 1, String(checkpoints[0]));
  check('фінальне збереження не менше останньої точки',
    completedWith >= (checkpoints.at(-1) ?? 0), `${completedWith} повідомлень`);

  await fs.rm(dir, { recursive: true, force: true });
}

async function testApprovalDenial(): Promise<void> {
  console.log('\n[4] Відмова у дозволі блокує запис');
  const dir = await fs.mkdtemp(join(tmpdir(), 'ironcode-deny-'));
  const ws = new Workspace(dir);
  const gw = new GatewayClient(URL, KEY);

  let denied = false;
  const toolsUsed: string[] = [];
  let text = '';
  const agent = new Agent(gw, ws, noSkills, noConnectors, (e: AgentEvent) => {
    if (e.kind === 'tool_start') toolsUsed.push(e.name);
    if (e.kind === 'text') text += e.delta;
    if (e.kind === 'approval') {
      denied = true;
      // Answer the dialog the way a user clicking "Відмовити" would.
      agent.resolveApproval(e.id, false);
    }
  });

  await agent.run('Створи файл secret.txt з будь-яким текстом.', 'auto', 'ask');

  // A model that never attempted the write is a flaky model, not a broken
  // approval gate — the two are reported apart so a green run means something.
  const attempted = toolsUsed.includes('write_file');
  if (!attempted) {
    console.log(`  SKIP  модель не спробувала запис — інструменти: ${toolsUsed.join(', ') || 'жодного'}`);
    console.log(`        відповідь: ${text.trim().slice(0, 100)}`);
  } else {
    check('дозвіл справді запитувався', denied);
  }
  const exists = await fs.access(join(dir, 'secret.txt')).then(() => true, () => false);
  check('файл НЕ створено після відмови', !exists);

  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * An attached image has to reach a model that can actually see it.
 *
 * Most tool-capable models on this gateway have no vision, so the turn is
 * expected to be routed onto the vision chain — this proves both the routing
 * and the encoding, end to end.
 */
async function testVisionAttachment(): Promise<void> {
  console.log('\n[5] Вкладене зображення доходить до моделі');
  const dir = await fs.mkdtemp(join(tmpdir(), 'ironcode-vision-'));
  const ws = new Workspace(dir);
  const gw = new GatewayClient(URL, KEY);

  // The app icon: an unmistakable purple "<I>" on white.
  const iconPath = join(process.cwd(), 'assets', 'icon.png');
  const png = await fs.readFile(iconPath).catch(() => null);
  if (!png) {
    console.log('  SKIP  assets/icon.png не знайдено');
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }

  const attachment: Attachment = {
    kind: 'image',
    name: 'icon.png',
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  };

  let text = '';
  let error = '';
  let routed = '';
  const agent = new Agent(gw, ws, noSkills, noConnectors, (e: AgentEvent) => {
    if (e.kind === 'text') text += e.delta;
    if (e.kind === 'error') error = e.message;
    if (e.kind === 'model' && e.note) routed = e.note;
  });

  await agent.run(
    'Що зображено на картинці? Відповідай одним коротким реченням.',
    // a deliberately vision-less model, to exercise the automatic re-routing
    'gpt-oss-120b',
    'readonly',
    null,
    [attachment],
  );

  const lower = text.toLowerCase();
  // Stem-matched: Ukrainian inflects (дужки / дужок / дужками).
  const describesIt = /дуж|bracket|фіолет|purple|код|code|символ/.test(lower);

  check('без помилок', !error, error);
  check('перемкнуло на модель із зором', routed.includes('не читає зображення'), routed || '(не перемикало)');
  check('модель описала зображення', describesIt, text.trim().slice(0, 90) || '(порожньо)');

  await fs.rm(dir, { recursive: true, force: true });
}

(async function main(): Promise<void> {
  console.log('Ironcode smoke test');
  console.log(`шлюз: ${URL}`);
  if (!KEY) {
    console.log('\nIRONCODE_API_KEY не задано — вкажи ключ у змінній середовища.');
    process.exit(1);
  }

  await testPathSafety();
  await testGateway();
  await testAgentLoop();
  await testApprovalDenial();
  await testVisionAttachment();

  console.log(`\n${failures === 0 ? 'Усі перевірки пройдено.' : `${failures} перевірок провалено.`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
