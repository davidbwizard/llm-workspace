/** Shared prompt types for Quick answers. Spec: docs/superpowers/specs/
 *  2026-09-17-quick-answers-design.md sections 3, 6-8.
 *  These mirror the brief's interfaces verbatim -- do not rename fields
 *  without updating the design doc and every consumer. */

export type PromptKind = 'question' | 'permission' | 'plan';

export type PromptQuestion = {
  question: string; header: string; multiSelect: boolean;
  options: { label: string; description: string }[];
};

export type PromptChoice = { key: string; label: string; takesText: boolean };

export type PromptView = {
  id: string; kind: PromptKind; answerable: boolean;
  reason: null | 'not_tmux' | 'screen_unread';
  questions?: PromptQuestion[];
  toolName?: string; command?: string; filePath?: string; description?: string;
  plan?: string;
  choices?: PromptChoice[];
};

export type Answer =
  | { kind: 'choice'; key: string }
  | { kind: 'choice_text'; key: string; text: string }
  | { kind: 'questions'; picks: { options: number[]; other?: string }[] }
  | { kind: 'chat' };

export type ScreenExpect =
  | { kind: 'permission'; toolName: string; anchor: string }  // command, file basename, or tool name
  | { kind: 'plan' }
  | { kind: 'question'; headers: string[]; questions: string[] };  // questions: the hook's question texts, same order as headers

export type ScreenRead =
  | { match: true; kind: 'permission' | 'plan'; choices: PromptChoice[]; cursor: string | null; textRow: string | null }
  // headerOnly: read from the one-question layout (a header line, no tab row)
  | { match: true; kind: 'question'; current: number; answered: boolean[]; options: string[]; headerOnly?: true }
  | { match: true; kind: 'review'; answers: { question: string; answer: string }[] }
  | { match: false; why: string };
