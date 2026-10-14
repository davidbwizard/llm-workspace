export const REMOTE_VERSION = 1;
export type ClientId = string;
export type SessionHandle = string;
export type ProjectHandle = string;
export type OperationResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid' | 'stale' | 'unavailable' | 'unsupported' | 'busy' | 'uncertain'; message?: string };
export type RemoteOperation = 'send' | 'answerClaude' | 'answerCodex' | 'launch' | 'close';
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export const MOBILE_IMAGE_LIMIT = 4;
export const MOBILE_IMAGE_BYTES = 10 * 1024 * 1024;
