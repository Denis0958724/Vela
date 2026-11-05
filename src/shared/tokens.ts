/**
 * A token estimate good enough for a context meter.
 *
 * It intentionally does not pretend to be a tokenizer: the gateway serves many
 * different models, and pulling a tokenizer per family would add megabytes to
 * the app. Latin text averages ~4 characters per token, Cyrillic and CJK are
 * closer to 2, so the estimate counts those separately.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 4 + wide / 2.2);
}

export interface TokenContent {
  type: string;
  text?: string;
  image_url?: { url?: string };
}

/** Content parts, tool calls and tool results all occupy the window. */
export function estimateMessageTokens(message: {
  content: string | TokenContent[] | null;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}): number {
  let total = 0;
  if (typeof message.content === 'string') {
    total += estimateTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') total += estimateTokens(part.text ?? '');
      else if (part.type === 'image_url') total += 900;
    }
  }
  for (const call of message.tool_calls ?? []) {
    total += estimateTokens(call.function.name) + estimateTokens(call.function.arguments);
  }
  return total;
}
