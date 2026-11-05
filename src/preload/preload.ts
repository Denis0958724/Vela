import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * The renderer's only path to the Node side. Everything is an explicit named
 * call — no generic `invoke(channel, ...)` escape hatch — so the preview tab
 * rendering model-authored HTML cannot reach arbitrary main-process handlers.
 */
const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  listModels: () => ipcRenderer.invoke('models:list'),
  probeModels: () => ipcRenderer.invoke('models:probe'),
  probeModel: (id: string) => ipcRenderer.invoke('models:probe-one', id),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  saveFreeLlmApi: (url: string, key: string) => ipcRenderer.invoke('freellmapi:save', url, key),
  testFreeLlmApi: () => ipcRenderer.invoke('freellmapi:test'),
  saveProvider: (id: string, key: string, enabled: boolean) =>
    ipcRenderer.invoke('providers:save', id, key, enabled),
  testProvider: (id: string) => ipcRenderer.invoke('providers:test', id),
  setProviderEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('providers:setEnabled', id, enabled),
  removeProvider: (id: string) => ipcRenderer.invoke('providers:remove', id),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  onModelProgress: (handler: (p: unknown) => void) => {
    ipcRenderer.on('models:progress', (_e, payload) => handler(payload));
  },

  state: () => ipcRenderer.invoke('ui:state'),

  createProject: (name: string, folder?: string) => ipcRenderer.invoke('project:create', name, folder),
  pickFolder: (purpose: 'project' | 'chats' | 'chat') => ipcRenderer.invoke('folder:pick', purpose),
  setChatsFolder: (path: string) => ipcRenderer.invoke('chats:setFolder', path),
  setChatFolder: (path: string) => ipcRenderer.invoke('chat:setFolder', path),
  setChatReasoning: (chatId: string, effort: string) => ipcRenderer.invoke('chat:setReasoning', chatId, effort),
  togglePin: (targetId: string) => ipcRenderer.invoke('pin:toggle', targetId),
  renameProject: (id: string, name: string) => ipcRenderer.invoke('project:rename', id, name),
  deleteProject: (id: string) => ipcRenderer.invoke('project:delete', id),
  revealProject: (id: string) => ipcRenderer.invoke('project:reveal', id),
  relocateProject: (id: string, path?: string) => ipcRenderer.invoke('project:relocate', id, path),
  findProjectFolder: (id: string) => ipcRenderer.invoke('project:find', id),
  setProjectInstructions: (id: string, text: string) =>
    ipcRenderer.invoke('project:instructions', id, text),

  createChat: (projectId: string | null) => ipcRenderer.invoke('chat:create', projectId),
  selectChat: (projectId: string | null, chatId: string) => ipcRenderer.invoke('chat:select', projectId, chatId),
  renameChat: (chatId: string, title: string) => ipcRenderer.invoke('chat:rename', chatId, title),
  deleteChat: (chatId: string) => ipcRenderer.invoke('chat:delete', chatId),
  clearChat: () => ipcRenderer.invoke('chat:clear'),

  listSkills: () => ipcRenderer.invoke('skills:list'),
  saveSkill: (input: unknown) => ipcRenderer.invoke('skills:save', input),
  deleteSkill: (name: string) => ipcRenderer.invoke('skills:delete', name),
  importSkill: () => ipcRenderer.invoke('skills:import'),
  installSkillFromGithub: (url: string) => ipcRenderer.invoke('skills:install-github', url),
  revealSkills: () => ipcRenderer.invoke('skills:reveal'),

  listConnectors: () => ipcRenderer.invoke('connectors:list'),
  saveConnector: (input: unknown) => ipcRenderer.invoke('connectors:save', input),
  deleteConnector: (id: string) => ipcRenderer.invoke('connectors:delete', id),
  testConnector: (id: string) => ipcRenderer.invoke('connectors:test', id),
  disconnectConnector: (id: string) => ipcRenderer.invoke('connectors:disconnect', id),

  tree: () => ipcRenderer.invoke('workspace:tree'),
  readFile: (path: string) => ipcRenderer.invoke('file:read', path),
  readImage: (path: string) => ipcRenderer.invoke('image:read', path),
  saveFile: (path: string, content: string) => ipcRenderer.invoke('file:save', path, content),
  runShell: (command: string) => ipcRenderer.invoke('shell:run', command),

  send: (text: string, attachments: unknown[] = []) =>
    ipcRenderer.invoke('agent:send', text, attachments),
  retryLast: () => ipcRenderer.invoke('agent:retry'),
  context: () => ipcRenderer.invoke('agent:context'),
  pickAttachments: () => ipcRenderer.invoke('attach:pick'),
  attachPaths: (paths: string[]) => ipcRenderer.invoke('attach:paths', paths),
  attachBytes: (name: string, bytes: Uint8Array) => ipcRenderer.invoke('attach:bytes', name, bytes),
  videoSupport: () => ipcRenderer.invoke('attach:videoSupport'),
  // Electron 32 removed File.path; this is the supported replacement, and it
  // has to be called here because the renderer has no access to webUtils.
  filePath: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  cancel: () => ipcRenderer.send('agent:cancel'),
  approve: (id: string, ok: boolean) => ipcRenderer.send('agent:approve', id, ok),

  startPreview: () => ipcRenderer.invoke('preview:start'),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),

  onAgentEvent: (handler: (event: unknown) => void) => {
    ipcRenderer.on('agent:event', (_e, payload) => handler(payload));
  },
};

contextBridge.exposeInMainWorld('ironcode', api);

export type IroncodeApi = typeof api;
