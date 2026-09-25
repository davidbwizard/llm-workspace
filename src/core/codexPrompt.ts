export type CodexQuestion = {
  id: string; header: string; question: string; isSecret: boolean; isOther: boolean;
  options: { label: string; description: string }[] | null;
};
export type CodexPrompt = {
  key: string;
  kind: 'command' | 'file' | 'permissions' | 'questions';
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  details: string | null;
  questions: CodexQuestion[] | null;
  decisions: ('accept' | 'acceptForSession' | 'decline' | 'cancel')[];
};
export type CodexSnapshot = { state: 'connecting' | 'ready' | 'unavailable'; prompts: CodexPrompt[] };
