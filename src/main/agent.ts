import type { ConnectorRegistry } from './connectors.js';
import { promises as fs } from 'node:fs';
import type { GatewayClient } from './gateway.js';
import type { SkillRegistry } from './skills.js';
import { findTool, TOOLS, type ToolContext } from './tools/index.js';
import type { Attachment } from './attachments.js';
import { estimateMessageTokens, estimateTokens } from '../shared/tokens.js';
import type { AgentEvent, ChatMessage, ContentPart } from './types.js';
import { WorkspaceGoneError, type Workspace } from './workspace.js';

/** How many tool round-trips one user turn may take before stopping. */
const MAX_STEPS = 30;

/** Tools that cannot change anything on disk. */
export type ApprovalMode = 'ask' | 'auto' | 'turbo';

export interface AgentPermissions {
  internet: boolean;
  files: boolean;
  computer: boolean;
}

const NO_PERMISSIONS: AgentPermissions = { internet: false, files: true, computer: false };

/**
 * Fold attachments into one user message.
 *
 * Text files go inline so any model can use them; images become content parts,
 * which only vision models accept — that is what flips the turn onto the
 * vision chain.
 */
function buildUserContent(text: string, attachments: Attachment[]): string | ContentPart[] {
  if (!attachments.length) return text;

  const notes: string[] = [];
  const images: ContentPart[] = [];

  for (const item of attachments) {
    if (item.kind === 'image') {
      images.push({ type: 'image_url', image_url: { url: item.dataUrl } });
      notes.push(`[зображення: ${item.name}]`);
    } else if (item.kind === 'text') {
      notes.push(`\n--- ${item.name} ---\n${item.text}\n--- кінець ${item.name} ---`);
    } else {
      notes.push(`[не вдалося прикріпити ${item.name}: ${item.message}]`);
    }
  }

  const combined = [text, ...notes].filter(Boolean).join('\n');
  return images.length ? [{ type: 'text', text: combined }, ...images] : combined;
}

export class Agent {
  private history: ChatMessage[] = [];
  /** Which chat `history` belongs to, so a finished turn is saved to the right one. */
  private chatId: string | null = null;
  private pendingApprovals = new Map<string, (ok: boolean) => void>();
  private controller: AbortController | null = null;
  private approvalSeq = 0;
  /**
   * Set when a tool finds the working folder gone. The run then stops at the
   * next safe point instead of letting the model hammer ENOENT for 30 steps.
   */
  private lostWorkspace: WorkspaceGoneError | null = null;
  /** Last context sizes, for the meter under the composer. */
  private lastSystemTokens = 0;
  private lastToolsTokens = 0;
  private lastModelId = '';

  /**
   * Bumped whenever the active chat changes or a run is cancelled.
   *
   * Cancelling is not instant: the stream may already be mid-flight. Without
   * this, an in-flight turn kept appending to `this.history` after it had been
   * swapped for another chat's array — the old conversation's messages
   * reappeared inside the newly opened chat, and its title was rewritten from
   * the wrong first message.
   */
  private generation = 0;

  /** Called when a turn finishes, with the chat it belonged to. */
  onTurnComplete: ((chatId: string | null, history: ChatMessage[]) => void) | null = null;

  /**
   * Called after every step of a turn, not just at the end.
   *
   * A turn can run for minutes; saving only on completion meant closing the
   * window — or just losing power — threw away everything the agent had
   * already done.
   */
  onProgress: ((chatId: string | null, history: ChatMessage[]) => void) | null = null;

  constructor(
    private gateway: GatewayClient,
    private workspace: Workspace,
    private skills: SkillRegistry,
    private connectors: ConnectorRegistry,
    private emit: (event: AgentEvent) => void,
    private openExternal: (url: string) => Promise<void> = async () => undefined,
  ) {}

  get busy(): boolean {
    return this.controller !== null;
  }

  /** True when a turn is still running for this particular chat. */
  isRunningFor(chatId: string | null): boolean {
    return this.controller !== null && this.chatId === chatId && chatId !== null;
  }

  setHistory(messages: ChatMessage[], chatId: string | null = null): void {
    this.generation++;
    this.history = messages;
    this.chatId = chatId;
  }

  getHistory(): ChatMessage[] {
    return this.history;
  }

  currentChatId(): string | null {
    return this.chatId;
  }

  /**
   * Estimated window usage, broken down for the context popover. The system
   * prompt and tool schemas are measured when a turn starts; the messages are
   * measured from the transcript each time this is called.
   */
  contextSnapshot(): {
    system: number;
    tools: number;
    messages: number;
    total: number;
    messageCount: number;
    model: string;
  } {
    const messages = this.history.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    return {
      system: this.lastSystemTokens,
      tools: this.lastToolsTokens,
      messages,
      total: this.lastSystemTokens + this.lastToolsTokens + messages,
      messageCount: this.history.length,
      model: this.lastModelId,
    };
  }

  reset(): void {
    this.generation++;
    this.history = [];
  }

  cancel(notify = false): void {
    const wasRunning = this.controller !== null;
    this.generation++;
    this.controller?.abort();
    // Unblock anything waiting on a dialog the user will never answer now.
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
    // A deliberate Stop must reach the UI as a finished turn. The run's own
    // `turn_end` is filtered out by the generation bump above (so a chat switch
    // cannot leak old events into the new chat), which used to leave the
    // thinking dots and the Stop button stuck forever.
    if (notify && wasRunning) this.emit({ kind: 'turn_end', stopReason: 'cancelled' });
  }

  resolveApproval(id: string, ok: boolean): void {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return;
    this.pendingApprovals.delete(id);
    resolve(ok);
  }

  /**
   * Claim the workspace failure found by a tool. This is a method rather than a
   * direct read because TypeScript's flow analysis cannot see a mutation made
   * inside `executeCall` and would otherwise narrow the field to `null`.
   */
  private takeLostWorkspace(): WorkspaceGoneError | null {
    const lost = this.lostWorkspace;
    this.lostWorkspace = null;
    return lost;
  }

  /**
   * Built fresh each turn: a workspace switch or an edited skill must not leave
   * the model acting on a stale picture of its own environment.
   */
  private async systemPrompt(
    mode: ApprovalMode,
    connectorCount: number,
    instructions: string[],
    permissions: AgentPermissions = NO_PERMISSIONS,
  ): Promise<string> {
    const parts = [
      'Ти Vela, агент-програміст. Працюєш на комп\'ютері користувача через інструменти.',
      '',
      `Робоча папка: ${this.workspace.root}`,
      'Платформа: Windows. run_shell працює в PowerShell. ls, cat і rm там алієси.',
      '',
      'Як працювати:',
      '- Шляхи вказуй відносно робочої папки. За її межі не виходь.',
      '- Перед правкою прочитай файл через read_file.',
      '- edit_file потребує old_str, який зустрічається рівно один раз. Додай контекст.',
      '- Нові файли створюй через write_file, точкові зміни роблять через edit_file.',
      '- Не вигадуй файли й структуру. Перевіряй через list_dir, read_file і search_files.',
      '- Незалежні інструменти можна викликати одночасно.',
      '',
      'Якість:',
      '- Не віддавай неперевірену роботу. Запусти код або перечитай записаний файл.',
      '- Не лишай TODO і заглушок, якщо просили готове.',
      '- Роби задачу повністю, а не найлегшу частину.',
      '- Обробляй порожні значення, межові випадки й помилки.',
      '- Якщо щось не вийшло, скажи прямо. Не подавай неперевірене як готове.',
      '',
      'Показ результату в чаті:',
      '- Файл зроби посиланням: [назва](шлях) або [назва](шлях:12) для рядка.',
      '- Зображення з робочої папки показуй як ![опис](шлях).',
      '- Для картинки з файлу можна викликати show_image з її шляхом.',
      '- Знімок екрана вже повертається зображенням. Не дублюй його шлях сирим текстом.',
    ];

    if (permissions.internet) {
      parts.push(
        '',
        'Інтернет дозволено користувачем.',
        '- open_url відкриває сторінку в типовому браузері.',
        '- web_fetch читає текст сторінки, web_search шукає в інтернеті.',
        '  Кожен виклик у режимі «питати» потребує підтвердження.',
      );
    }

    if (permissions.computer) {
      parts.push(
        '',
        'Керування комп\'ютером дозволено користувачем і працює автономно.',
        '- computer: open_app відкриває програму, windows показує вікна, focus перемикає',
        '  фокус, screenshot робить знімок екрана, move/click/double_click/scroll',
        '  рухають мишу, type/key вводять текст і клавіші.',
        '  Поки ти дієш, краї екрана світяться, а в чаті видно статус.',
        '  Не роби руйнівних дій без прямого прохання.',
        '- Якщо просять відкрити програму, натиснути кнопку, змінити налаштування',
        '  або взаємодіяти з вікном Windows, це задача computer, а не текстова відповідь.',
        '  Спочатку подивись на екран через screenshot, потім дій, потім перевір',
        '  результат на новому скріншоті. Не кажи «зроблено», доки не перевірив.',
        '- Координати для click бери лише з останнього скріншота: у відповіді вказано',
        '  розмір екрана. Точка поза цими межами відхиляється — не вгадуй навмання.',
        '- Клавіатура й текст ідуть в активне вікно. Якщо потрібне вікно не в фокусі,',
        '  спершу виклич focus із частиною заголовка, а не посилай текст навздогін.',
        '- Кожна дія повертає «Перевірка: екран змінився» або «екран НЕ змінився».',
        '  Якщо не змінився — дія не спрацювала: подивись на скріншот і спробуй інакше,',
        '  а не повторюй той самий виклик.',
      );
    }

    const skills = await this.skills.list();
    const onDemand = skills.filter(s => !s.always);
    const always = skills.filter(s => s.always);

    if (onDemand.length) {
      parts.push(
        '',
        'Доступні плагіни:',
        'Якщо плагін підходить до задачі, завантаж його через use_skill перед роботою:',
        ...onDemand.map(s => `- ${s.name}: ${s.description || '(без опису)'}`),
      );
    }

    for (const skill of always) {
      parts.push('', `# Плагін «${skill.name}». Застосовується завжди.`, skill.body);
    }

    // Rebuilt every turn, so editing instructions mid-session takes effect on
    // the very next message rather than after a restart.
    for (const block of instructions.filter(Boolean)) {
      parts.push('', '# Вказівки користувача', block);
    }

    if (connectorCount > 0) {
      parts.push(
        '',
        `Інструменти з префіксом mcp__ належать зовнішнім конекторам (${connectorCount} доступно).`,
        'Вони виходять за межі комп\'ютера. Бери їх лише коли задача справді цього потребує.',
      );
    }

    parts.push(
      '',
      'Відповідай українською, коротко. Не переказуй вивід інструментів, підсумовуй.',
      'Наприкінці скажи, що саме зроблено.',
    );

    return parts.join('\n');
  }

  /** Run one user turn to completion, streaming events as it goes. */
  async run(
    userText: string,
    model: string,
    mode: ApprovalMode,
    projectId: string | null = null,
    attachments: Attachment[] = [],
    instructions: string[] = [],
    /** Preferred fallback order, built from the live catalogue by the caller. */
    fallbacks: string[] = [],
    permissions: AgentPermissions = NO_PERMISSIONS,
    retry = false,
    reasoning: 'low' | 'medium' | 'high' = 'medium',
  ): Promise<void> {
    if (this.controller) {
      this.emit({ kind: 'error', message: 'Агент уже працює.' });
      return;
    }
    this.controller = new AbortController();
    const runController = this.controller;
    const signal = runController.signal;
    this.lostWorkspace = null;

    // Everything this turn touches is captured now. If the user switches chats
    // mid-turn, the work keeps landing in the conversation it started in and
    // stops reaching the screen, instead of bleeding into the new one.
    const generation = ++this.generation;
    const history = this.history;
    const chatId = this.chatId;
    const isCurrent = () => this.generation === generation;
    const emit = (event: AgentEvent) => {
      if (isCurrent()) this.emit(event);
    };

    // Read-only means read-only: an outbound connector call is a side effect,
    // so connectors are withheld entirely in that mode.
    const connectorTools = await this.connectors.toolsFor(projectId);

    const userContent = retry
      ? history[history.length - 1]?.content ?? ''
      : buildUserContent(userText, attachments);
    const hasImages = Array.isArray(userContent)
      && userContent.some(part => part.type === 'image_url');
    let turnHasImages = hasImages;

    // A retry reuses the last user turn already present in history. Without
    // this guard a broken UI call could run with an empty prompt.
    if (retry && !history.length) throw new Error('Немає повідомлення для повтору.');

    const tools = TOOLS
      .filter(tool => {
        if (tool.permission === 'internet' && !permissions.internet) return false;
        if (tool.permission === 'files' && !permissions.files) return false;
        if (tool.permission === 'computer' && !permissions.computer) return false;
        return true;
      })
      .map(tool => tool.schema)
      .concat(connectorTools);

    const systemText = await this.systemPrompt(mode, connectorTools.length, instructions, permissions);
    // These two numbers are what the context meter shows before the model
    // consumes them; recomputing the prompt on every frame would be wasteful.
    this.lastSystemTokens = estimateTokens(systemText);
    this.lastToolsTokens = estimateTokens(JSON.stringify(tools));
    this.lastModelId = model;

    const userMessage: ChatMessage = retry
      ? history[history.length - 1]
      : { role: 'user', content: userContent, at: Date.now() };
    const messages: ChatMessage[] = retry
      ? [{ role: 'system', content: systemText }, ...history]
      : [
          { role: 'system', content: systemText },
          ...history,
          userMessage,
        ];
    if (!retry) {
      history.push(userMessage);
      if (isCurrent()) this.onProgress?.(chatId, history);
    }

    const ctx: ToolContext = {
      workspace: this.workspace,
      signal,
      requireApproval: (name, args, detail, highRisk) =>
        this.askApproval(name, args, detail, mode, isCurrent, highRisk),
      loadSkill: name => this.skills.get(name),
      skillNames: async () => (await this.skills.list()).map(s => s.name),
      openExternal: this.openExternal,
    };

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted || !isCurrent()) break;

        const result = await this.gateway.streamChat({
          model,
          messages,
          tools,
          signal,
          requireVision: turnHasImages,
          reasoning,
          fallbacks,
          handlers: {
            onModel: (m, note) => emit({ kind: 'model', model: m, note }),
            onText: delta => emit({ kind: 'text', delta }),
            onReasoning: delta => emit({ kind: 'reasoning', delta }),
          },
        });

        emit({ kind: 'model', model: result.servedModel });
        if (result.usage) {
          emit({
            kind: 'usage',
            model: result.servedModel,
            prompt: result.usage.prompt,
            completion: result.usage.completion,
            total: result.usage.total,
          });
        } else if (result.content) {
          // Some free gateways omit usage on streamed responses. Keep a local
          // estimate so the monthly counter is still useful instead of zero.
          const prompt = estimateTokens(JSON.stringify(messages));
          const completion = estimateTokens(result.content);
          emit({
            kind: 'usage',
            model: result.servedModel,
            prompt,
            completion,
            total: prompt + completion,
          });
        }

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: result.content || null,
          at: Date.now(),
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        };
        messages.push(assistantMsg);
        history.push(assistantMsg);

        if (!result.toolCalls.length) {
          emit({ kind: 'turn_end', stopReason: result.finishReason });
          return;
        }

        // Tool calls in one response are independent by contract, so run them
        // together — a read_file fan-out finishes in one round trip, not five.
        const outcomes = await Promise.all(
          result.toolCalls.map(call => this.executeCall(call, ctx, emit)),
        );

        for (const { call, output } of outcomes) {
          const toolMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: output,
          };
          messages.push(toolMsg);
          history.push(toolMsg);

          // Tool results are text-only in the API, so a screenshot has to go
          // back as a user image message. Without this the model is acting
          // blind and the computer loop degenerates into a chat reply.
          if (call.function.name === 'computer') {
            const screenshot = await this.screenshotMessage(output);
            if (screenshot) {
              messages.push(screenshot);
              turnHasImages = true;
            }
          }
        }

        // Checkpoint: whatever has been done so far survives a crash or a quit.
        if (isCurrent()) this.onProgress?.(chatId, history);

        // Once the folder is gone there is nothing left to try: every further
        // tool call would fail the same way, and the user needs to relink it.
        const gone = this.takeLostWorkspace();
        if (gone) {
          emit({
            kind: 'workspace_lost',
            path: gone.root,
            projectId,
            message: `Робочу папку втрачено під час роботи: ${gone.root}. Хід зупинено, щоб не сипати помилками.`,
          });
          emit({ kind: 'turn_end', stopReason: 'workspace' });
          return;
        }

        if (signal.aborted || !isCurrent()) break;
      }

      if (signal.aborted || !isCurrent()) {
        emit({ kind: 'turn_end', stopReason: 'cancelled' });
      } else {
        emit({ kind: 'status', text: `Досягнуто ліміт ${MAX_STEPS} кроків. Спинився.` });
        emit({ kind: 'turn_end', stopReason: 'max_steps' });
      }
    } catch (err) {
      if (signal.aborted || !isCurrent()) {
        emit({ kind: 'turn_end', stopReason: 'cancelled' });
      } else {
        emit({ kind: 'error', message: (err as Error).message });
        emit({ kind: 'turn_end', stopReason: 'error' });
      }
    } finally {
      // A stale run must not clear the controller or transcript of the run that
      // replaced it. This matters most right after Stop: the renderer can start
      // a queued prompt before the aborted run reaches its `finally`.
      if (this.controller === runController) {
        this.controller = null;
        this.pendingApprovals.clear();
      }
      // Save to the chat this turn started in, but only if the turn is still
      // the current one: clearing a chat or switching away must not resurrect
      // the old transcript with a late write.
      if (isCurrent()) this.onTurnComplete?.(chatId, history);
    }
  }

  /** Feed a computer screenshot back to the model as actual image input. */
  private async screenshotMessage(output: string): Promise<ChatMessage | null> {
    const match = /!\[[^\]]*\]\(([^)]+)\)/.exec(output);
    if (!match) return null;
    const path = match[1].replace(/^<|>$/g, '');
    if (!/\.(png|jpe?g|webp|gif)$/i.test(path)) return null;
    try {
      const abs = this.workspace.safe(path);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return null;
      // A 4K desktop screenshot can outgrow the image budget. Dropping it is
      // correct, but silently leaving the model blind is not: say so.
      if (stat.size > 8 * 1024 * 1024) {
        console.log(`[ComputerUse] Screenshot Feedback Failed: файл ${Math.round(stat.size / 1024)} КБ завеликий для моделі`);
        return null;
      }
      const lower = path.toLowerCase();
      const mime = lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'image/jpeg'
        : lower.endsWith('.webp')
          ? 'image/webp'
          : lower.endsWith('.gif')
            ? 'image/gif'
            : 'image/png';
      const data = await fs.readFile(abs);
      console.log('[ComputerUse] Screenshot Captured');
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Скріншот після дії. Подивись на нього, перевір, що змінилося, і продовжуй. Не вигадуй елементів, яких не видно на екрані.',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } },
        ],
      };
    } catch (err) {
      console.log(`[ComputerUse] Screenshot Feedback Failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async executeCall(
    call: { id: string; function: { name: string; arguments: string } },
    ctx: ToolContext,
    emit: (event: AgentEvent) => void,
  ): Promise<{ call: typeof call; output: string }> {
    const name = call.function.name;
    const tool = findTool(name);
    const isConnector = this.connectors.owns(name);

    let args: any = {};
    let parseError: string | null = null;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      parseError = `ПОМИЛКА: аргументи не є валідним JSON: ${call.function.arguments.slice(0, 200)}`;
    }

    emit({ kind: 'tool_start', id: call.id, name, args: parseError ? call.function.arguments : args });

    if (!tool && !isConnector) {
      const output = `ПОМИЛКА: інструмента «${name}» не існує.`;
      emit({ kind: 'tool_end', id: call.id, ok: false, result: output });
      return { call, output };
    }
    if (parseError) {
      emit({ kind: 'tool_end', id: call.id, ok: false, result: parseError });
      return { call, output: parseError };
    }

    if (isConnector) {
      // Every outbound call is confirmed: this is the one place where data can
      // leave the machine.
      const detail = `Зовнішній виклик: ${this.connectors.describe(name)}`;
      const allowed = await ctx.requireApproval(name, args, detail, true);
      if (!allowed) {
        const output = 'ВІДМОВЛЕНО: користувач не дозволив зовнішній виклик.';
        emit({ kind: 'tool_end', id: call.id, ok: false, result: output });
        return { call, output };
      }
      const output = await this.connectors.call(name, args);
      emit({ kind: 'tool_end', id: call.id, ok: !output.startsWith('ПОМИЛКА'), result: output });
      return { call, output };
    }

    try {
      // A project on an unplugged drive must fail once, with an explanation,
      // not once per tool call until the step budget runs out.
      await this.workspace.check();
    } catch (err) {
      if (err instanceof WorkspaceGoneError) {
        this.lostWorkspace ??= err;
        const output = `ПОМИЛКА: ${err.message}. Папку переміщено або від'єднано. Роботу зупинено.`;
        emit({ kind: 'tool_end', id: call.id, ok: false, result: output });
        return { call, output };
      }
      throw err;
    }

    try {
      // Path validation happens inside approvalDetail too, so an escape attempt
      // is reported before the user is ever asked to approve it.
      const detail = tool!.approvalDetail?.(args, ctx) ?? null;
      if (detail && !tool!.autonomous) {
        const allowed = await ctx.requireApproval(name, args, detail, tool!.risk === 'high');
        if (!allowed) {
          const output = 'ВІДМОВЛЕНО: користувач не дозволив цю дію. Запропонуй інший підхід.';
          emit({ kind: 'tool_end', id: call.id, ok: false, result: output });
          return { call, output };
        }
      }

      // The approval dialog can sit open for a while; the project may have been
      // renamed or its drive unplugged in the meantime.
      try {
        await this.workspace.check();
      } catch (err) {
        if (err instanceof WorkspaceGoneError) {
          this.lostWorkspace ??= err;
          const output = `ПОМИЛКА: ${err.message}. Папку переміщено або від'єднано. Роботу зупинено.`;
          emit({ kind: 'tool_end', id: call.id, ok: false, result: output });
          return { call, output };
        }
        throw err;
      }

      const isComputer = tool!.permission === 'computer';
      if (isComputer) emit({ kind: 'computer_active', active: true });
      try {
        const output = await tool!.run(args, ctx);
        const ok = !output.startsWith('ПОМИЛКА');
        emit({ kind: 'tool_end', id: call.id, ok, result: output });
        return { call, output };
      } finally {
        if (isComputer) emit({ kind: 'computer_active', active: false });
      }
    } catch (err) {
      const output = `ПОМИЛКА: ${(err as Error).message}`;
      emit({ kind: 'tool_end', id: call.id, ok: false, result: output });
      return { call, output };
    }
  }

  private askApproval(
    name: string,
    args: unknown,
    detail: string,
    mode: ApprovalMode,
    isCurrent: () => boolean,
    highRisk = false,
  ): Promise<boolean> {
    if (mode === 'turbo') return Promise.resolve(true);
    if (mode === 'auto' && !highRisk) return Promise.resolve(true);
    // A stale turn must not raise a dialog over a chat the user has moved on to.
    if (!isCurrent()) return Promise.resolve(false);
    const id = `ap_${++this.approvalSeq}`;
    return new Promise<boolean>(resolve => {
      this.pendingApprovals.set(id, resolve);
      this.emit({ kind: 'approval', id, name, args, detail });
    });
  }
}
