/** Shared shapes between the gateway, the agent loop and the renderer. */

export interface ModelInfo {
  id: string;
  name?: string;
  context_window?: number;
  context_length?: number;
  available?: boolean;
  unavailable_reason?: string | null;
  supported_parameters?: string[];
  /** Set for direct-provider models, absent for FreeLLMAPI entries. */
  provider?: string;
  /** Router advertised zero input and output pricing. */
  free?: boolean;
  /** Provider/model accepts a reasoning-effort control. */
  reasoning?: boolean;
}

/** A model is only usable by the agent if it can call tools. */
export function supportsTools(m: ModelInfo): boolean {
  // Router slots (`auto`, `fusion`, the claude-* slots) ship no parameter
  // metadata but do forward tool calls, so absence of the field is not a "no".
  return m.supported_parameters ? m.supported_parameters.includes('tools') : true;
}

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Multimodal message content, as the OpenAI chat API expects it. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** When the message was created, for the timestamp under a chat bubble. */
  at?: number;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** Events the agent loop streams to the renderer. */
export type AgentEvent =
  | { kind: 'status'; text: string }
  | { kind: 'model'; model: string; note?: string }
  | { kind: 'model_switch'; model: string; reason: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'text'; delta: string }
  | { kind: 'tool_start'; id: string; name: string; args: unknown }
  | { kind: 'tool_end'; id: string; ok: boolean; result: string }
  | { kind: 'approval'; id: string; name: string; args: unknown; detail: string }
  | {
      /** The folder the turn needs is gone: moved, renamed, or on a drive that left. */
      kind: 'workspace_missing';
      path: string;
      /** A project id when the missing folder belongs to a project. */
      projectId: string | null;
      scope: 'project' | 'chats';
      message: string;
    }
  | {
      /** The folder disappeared in the middle of a turn. */
      kind: 'workspace_lost';
      path: string;
      projectId: string | null;
      message: string;
    }
  | { kind: 'turn_end'; stopReason: string }
  | { kind: 'computer_active'; active: boolean }
  | { kind: 'usage'; model: string; prompt: number; completion: number; total: number }
  | { kind: 'error'; message: string };
