import type { CodexFormField, CodexFormValue } from './codexForm.ts';
export type CodexQuestion = {
  id: string; header: string; question: string; isSecret: boolean; isOther: boolean;
  options: { label: string; description: string }[] | null;
};
export type CodexPrompt = {
  key: string;
  kind: 'command' | 'file' | 'permissions' | 'questions' | 'elicitation' | 'fallback';
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  details: string | null;
  questions: CodexQuestion[] | null;
  isBlocking?: boolean;
  actions?: { id: string; label: string }[];
  fields?: CodexFormField[];
  fallback?: string;
  decisions: ('accept' | 'acceptForSession' | 'decline' | 'cancel')[];
};
export type CodexSnapshot = { state: 'connecting' | 'ready' | 'unavailable'; prompts: CodexPrompt[] };

export type CodexPromptAnswer = string | Record<string, string> | {
  action: 'accept' | 'acceptForSession' | 'decline' | 'cancel'; content?: Record<string, CodexFormValue>;
};
