import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { writeFileAtomic } from './fsx.js';
import type { ChatMessage } from './types.js';

/** A project groups a handful of parallel conversations, not an archive. */
export const MAX_CHATS = 5;

/** Id of the container that older versions used for project-less chats. */
const LEGACY_SCRATCH_ID = '__scratch';

export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** A project-less chat can be pointed at its own folder. */
  folder?: string;
  /** Per-chat reasoning effort, chosen in the composer. */
  reasoning?: 'low' | 'medium' | 'high';
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  chats: ChatMeta[];
  /** Extra standing instructions for the agent while this project is open. */
  instructions?: string;
}

interface StoreData {
  projects: Project[];
  /** Chats that belong to no project; they all work in `chatsFolder`. */
  chats: ChatMeta[];
  chatsFolder: string;
  /** null when a project-less chat is active. */
  activeProjectId: string | null;
  activeChatId: string | null;
  /** Ids of pinned chats and projects, in the order they were pinned. */
  pinned: string[];
}

function emptyData(chatsFolder: string): StoreData {
  return {
    projects: [],
    chats: [],
    chatsFolder,
    activeProjectId: null,
    activeChatId: null,
    pinned: [],
  };
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Projects, loose chats and each chat's transcript, persisted under the app
 * profile. The index and the transcripts are separate files so switching chats
 * never has to parse every message in every conversation.
 *
 * Writes keep one backup, and a damaged index is moved aside rather than
 * silently replaced with an empty one — losing the list without saying so is
 * the worst thing this class could do.
 */
export class Store {
  private data: StoreData;
  private loaded = false;
  private lastLoadError: string | null = null;

  constructor(private defaultChatsFolder: string) {
    this.data = emptyData(defaultChatsFolder);
  }

  private indexFile(): string {
    return join(app.getPath('userData'), 'projects.json');
  }

  private chatFile(chatId: string): string {
    return join(app.getPath('userData'), 'chats', `${chatId}.json`);
  }

  async load(): Promise<void> {
    const file = this.indexFile();
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      this.data = emptyData(this.defaultChatsFolder);
      this.loaded = true;
      return;
    }

    try {
      this.adopt(JSON.parse(raw) as Partial<StoreData> & { projects?: Project[] });
      this.loaded = true;
    } catch (err) {
      // Keep the damaged file: overwriting it would destroy the only copy.
      const aside = `${file}.corrupt-${Date.now()}`;
      await fs.rename(file, aside).catch(() => undefined);
      await this.restoreBackup();
      this.lastLoadError = `Файл проєктів пошкоджено (${(err as Error).message}). Копію збережено: ${aside}`;
      this.loaded = true;
    }

    if (this.migrateLegacyScratch()) await this.persist();
    this.repair();
  }

  private adopt(parsed: Partial<StoreData> & { projects?: Project[] }): void {
    this.data = {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      chats: Array.isArray(parsed.chats) ? parsed.chats : [],
      chatsFolder: parsed.chatsFolder || this.defaultChatsFolder,
      activeProjectId: parsed.activeProjectId ?? null,
      activeChatId: parsed.activeChatId ?? null,
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
    };
  }

  /**
   * Earlier versions kept project-less chats inside a reserved project, which
   * is why the sidebar showed a "Домашня папка" folder row above them. Lift
   * those chats to the top level and drop the container.
   */
  private migrateLegacyScratch(): boolean {
    const index = this.data.projects.findIndex(p => p.id === LEGACY_SCRATCH_ID);
    if (index === -1) return false;

    const legacy = this.data.projects[index];
    this.data.chats = [...legacy.chats, ...this.data.chats];
    this.data.chatsFolder = legacy.path || this.data.chatsFolder;
    this.data.projects.splice(index, 1);
    if (this.data.activeProjectId === LEGACY_SCRATCH_ID) this.data.activeProjectId = null;
    return true;
  }

  private async restoreBackup(): Promise<void> {
    try {
      this.adopt(JSON.parse(await fs.readFile(`${this.indexFile()}.bak`, 'utf8')));
    } catch {
      this.data = emptyData(this.defaultChatsFolder);
    }
  }

  loadError(): string | null {
    return this.lastLoadError;
  }

  /** Never leave the UI pointing at a chat or project that no longer exists. */
  private repair(): void {
    const known = new Set([
      ...this.data.chats.map(c => c.id),
      ...this.data.projects.flatMap(p => [p.id, ...p.chats.map(c => c.id)]),
    ]);
    this.data.pinned = this.data.pinned.filter(pinId => known.has(pinId));

    if (this.data.activeProjectId) {
      const project = this.data.projects.find(p => p.id === this.data.activeProjectId);
      if (!project) {
        this.data.activeProjectId = null;
        this.data.activeChatId = null;
      } else if (!project.chats.some(c => c.id === this.data.activeChatId)) {
        this.data.activeChatId = project.chats[0]?.id ?? null;
      }
      return;
    }

    if (!this.data.chats.some(c => c.id === this.data.activeChatId)) {
      this.data.activeChatId = this.data.chats[0]?.id ?? null;
    }
  }

  private async persist(): Promise<void> {
    if (!this.loaded) throw new Error('Store.persist() до Store.load()');
    const file = this.indexFile();
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.copyFile(file, `${file}.bak`).catch(() => undefined);
    await writeFileAtomic(file, JSON.stringify(this.data, null, 2));
  }

  snapshot(): StoreData {
    return JSON.parse(JSON.stringify(this.data)) as StoreData;
  }

  /** The folder the agent works in for the current selection. */
  activeWorkspacePath(): string {
    const project = this.data.projects.find(p => p.id === this.data.activeProjectId);
    if (project) return project.path;
    const chat = this.data.chats.find(c => c.id === this.data.activeChatId);
    return chat?.folder || this.data.chatsFolder;
  }

  /** The custom folder of the active loose chat, if it has one. */
  activeChatFolder(): string | null {
    if (this.data.activeProjectId) return null;
    return this.data.chats.find(c => c.id === this.data.activeChatId)?.folder ?? null;
  }

  activeChatReasoning(): 'low' | 'medium' | 'high' {
    const chat = this.data.chats.find(c => c.id === this.data.activeChatId)
      ?? this.data.projects.flatMap(p => p.chats).find(c => c.id === this.data.activeChatId);
    return chat?.reasoning ?? 'medium';
  }

  /** Only loose chats may be pointed at another folder. */
  async setChatFolder(chatId: string, path: string): Promise<boolean> {
    if (this.projectOf(chatId)) return false;
    const chat = this.data.chats.find(c => c.id === chatId);
    if (!chat) return false;
    chat.folder = path;
    await this.persist();
    return true;
  }

  /** Reasoning effort is a chat-level preference, not a global one. */
  async setChatReasoning(chatId: string, effort: 'low' | 'medium' | 'high'): Promise<boolean> {
    const chat = this.data.chats.find(c => c.id === chatId)
      ?? this.data.projects.flatMap(p => p.chats).find(c => c.id === chatId);
    if (!chat) return false;
    chat.reasoning = effort;
    await this.persist();
    return true;
  }

  /** Keep project paths valid after a default folder is renamed. */
  async rebaseProjectPaths(from: string, to: string): Promise<number> {
    let changed = 0;
    for (const project of this.data.projects) {
      if (project.path === from) {
        project.path = to;
        changed++;
      } else if (project.path.startsWith(`${from}\\`) || project.path.startsWith(`${from}/`)) {
        project.path = `${to}${project.path.slice(from.length)}`;
        changed++;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  activeChatId(): string | null {
    return this.data.activeChatId;
  }

  activeProjectId(): string | null {
    return this.data.activeProjectId;
  }

  hasSelection(): boolean {
    return this.data.activeChatId !== null;
  }

  chatsFolder(): string {
    return this.data.chatsFolder;
  }

  async setChatsFolder(path: string): Promise<void> {
    this.data.chatsFolder = path;
    await this.persist();
  }

  /** Make sure there is always something to type into on a fresh profile. */
  async ensureSomeChat(): Promise<void> {
    if (this.data.chats.length || this.data.projects.length) {
      this.repair();
      if (this.data.activeChatId) return;
    }
    if (!this.data.chats.length) {
      await this.createChat(null);
      return;
    }
    this.data.activeProjectId = null;
    this.data.activeChatId = this.data.chats[0].id;
    await this.persist();
  }

  /** `projectId` null creates a loose chat. */
  async createChat(projectId: string | null): Promise<ChatMeta | null> {
    const now = Date.now();
    const list = projectId
      ? this.data.projects.find(p => p.id === projectId)?.chats
      : this.data.chats;
    if (!list) return null;
    if (projectId && list.length >= MAX_CHATS) return null;

    const chat: ChatMeta = {
      id: id('c'),
      title: `Чат ${list.length + 1}`,
      createdAt: now,
      updatedAt: now,
    };
    list.push(chat);
    this.data.activeProjectId = projectId;
    this.data.activeChatId = chat.id;
    await this.persist();
    return chat;
  }

  /** Creates the folder too: a project without a directory has nothing to work on. */
  async createProject(name: string, path: string): Promise<Project> {
    await fs.mkdir(path, { recursive: true });
    const project: Project = {
      id: id('p'),
      name: name.trim() || basename(path) || 'Без назви',
      path,
      createdAt: Date.now(),
      chats: [],
    };
    this.data.projects.push(project);
    await this.createChat(project.id);
    await this.persist();
    return project;
  }

  async renameProject(projectId: string, name: string): Promise<void> {
    const project = this.data.projects.find(p => p.id === projectId);
    if (!project) return;
    project.name = name.trim() || project.name;
    await this.persist();
  }

  /** Standing instructions are editable at any time, including mid-session. */
  async setProjectInstructions(projectId: string, text: string): Promise<void> {
    const project = this.data.projects.find(p => p.id === projectId);
    if (!project) return;
    project.instructions = text.trim();
    await this.persist();
  }

  projectInstructions(projectId: string | null): string {
    if (!projectId) return '';
    return this.data.projects.find(p => p.id === projectId)?.instructions ?? '';
  }

  /**
   * Repoint a project at a folder that has moved.
   *
   * The chats stay: a conversation is about the work, not about the path it
   * happened to live at.
   */
  async relocateProject(projectId: string, path: string): Promise<void> {
    const project = this.data.projects.find(p => p.id === projectId);
    if (!project) return;
    project.path = path;
    await this.persist();
  }

  /** Removes the project from Vela only — the folder on disk is left alone. */
  async deleteProject(projectId: string): Promise<void> {
    const project = this.data.projects.find(p => p.id === projectId);
    if (!project) return;
    for (const chat of project.chats) await fs.rm(this.chatFile(chat.id), { force: true });
    this.data.projects = this.data.projects.filter(p => p.id !== projectId);
    this.repair();
    await this.persist();
  }

  async deleteChat(chatId: string): Promise<void> {
    this.data.chats = this.data.chats.filter(c => c.id !== chatId);
    for (const project of this.data.projects) {
      project.chats = project.chats.filter(c => c.id !== chatId);
    }
    await fs.rm(this.chatFile(chatId), { force: true });
    this.repair();
    await this.persist();
  }

  async renameChat(chatId: string, title: string): Promise<void> {
    const chat = this.findChat(chatId);
    if (!chat) return;
    chat.title = title.trim().slice(0, 60) || chat.title;
    chat.updatedAt = Date.now();
    await this.persist();
  }

  async togglePin(targetId: string): Promise<void> {
    const at = this.data.pinned.indexOf(targetId);
    if (at === -1) this.data.pinned.push(targetId);
    else this.data.pinned.splice(at, 1);
    await this.persist();
  }

  async setActive(projectId: string | null, chatId: string | null): Promise<void> {
    this.data.activeProjectId = projectId;
    this.data.activeChatId = chatId;
    this.repair();
    await this.persist();
  }

  /** Startup should land on the welcome screen, not reopen the last chat. */
  async clearActive(): Promise<void> {
    this.data.activeProjectId = null;
    this.data.activeChatId = null;
    await this.persist();
  }

  private findChat(chatId: string): ChatMeta | undefined {
    return this.data.chats.find(c => c.id === chatId)
      ?? this.data.projects.flatMap(p => p.chats).find(c => c.id === chatId);
  }

  /** Which project, if any, owns this chat. */
  projectOf(chatId: string): string | null {
    return this.data.projects.find(p => p.chats.some(c => c.id === chatId))?.id ?? null;
  }

  async readHistory(chatId: string): Promise<ChatMessage[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.chatFile(chatId), 'utf8')) as ChatMessage[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async writeHistory(chatId: string, messages: ChatMessage[]): Promise<void> {
    await fs.mkdir(join(app.getPath('userData'), 'chats'), { recursive: true });
    await writeFileAtomic(this.chatFile(chatId), JSON.stringify(messages, null, 2));

    const chat = this.findChat(chatId);
    if (!chat) return;
    chat.updatedAt = Date.now();
    // The first thing the user said is a better label than "Чат 2".
    if (/^Чат \d+$/.test(chat.title)) {
      const firstUser = messages.find(m => m.role === 'user' && typeof m.content === 'string');
      if (firstUser?.content) {
        chat.title = String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 48);
      }
    }
    await this.persist();
  }
}
