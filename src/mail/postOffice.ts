import chokidar from 'chokidar';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readAgentInstructions } from './agent.ts';
import { writeFileAtomic, type LetterStatus, type MailPaths, type OutFile } from './files.ts';
import { checkLetter } from './letter.ts';
import {
  cancelOrphans, createLoop, getLetter, getLoop, insertLetter, latestPass, letterExists, lettersInLast24h,
  updateLetter, updateLoop, type MailDb, type NewLetter,
} from './log.ts';
import { followUpProblem, loopStatusAfter } from './loop.ts';
import { loadMailConfig } from './mailConfig.ts';
import { buildCommand, buildPrompt, parseReply, REPLY_SCHEMA, type Command, type RunHandle } from './runner.ts';

export interface PostOfficeDeps {
  paths: MailPaths;
  db: MailDb;
  home: string;
  now: () => number;
  pid: number;
  isAlive: (pid: number) => boolean;
  run: (cmd: Command, stdin: string, timeoutMs: number, env: NodeJS.ProcessEnv) => RunHandle;
  listCodexMcpServers: () => Promise<string[]>;
  notify: (title: string, body: string) => void;
  log: (message: string) => void;
}

export interface PostOffice {
  /** Claims and handles one inbox file. The watcher calls it; tests call it directly. */
  receive: (file: string) => void;
  /** Resolves once nothing is queued or running. For tests. */
  idle: () => Promise<void>;
  stop: () => void;
}

const INBOX_NAME = /^[0-9a-f]{32}\.json$/;
// A letter is a 20 KB body plus a few paths; anything this big is refused unread.
const MAX_LETTER_FILE = 256_000;

/** Whether a process exists. EPERM means it does, under another user. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const lastLine = (s: string): string => s.trim().split('\n').pop()?.slice(0, 300) ?? '';

export function createPostOffice(d: PostOfficeDeps): PostOffice {
  const { paths, db } = d;
  for (const dir of [paths.dir, paths.inbox, paths.out, paths.work]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  writeFileAtomic(paths.schema, JSON.stringify(REPLY_SCHEMA));

  const queue: string[] = [];
  let current: RunHandle | null = null;
  let running = false;
  let stopped = false;
  let broken: string | null = null;

  // Never throws: a status file failing to write must not take the post
  // office down. The log still holds the truth.
  const publish = (out: OutFile): void => {
    try {
      writeFileAtomic(join(paths.out, `${out.id}.json`), JSON.stringify(out));
    } catch (e) {
      d.log(`could not write the status of ${out.id}: ${(e as Error).message}`);
    }
  };
  const publishFinal = (id: string, status: LetterStatus, reason: string): void => publish({
    id, status, reason, specialist: null, project: null, pass: null, passLimit: null, verdict: null, review: null, loopStatus: null,
  });
  const removeQuietly = (path: string): void => {
    try {
      rmSync(path, { force: true });
    } catch (e) {
      d.log(`could not remove ${path}: ${(e as Error).message}`);
    }
  };
  const publishFromLog = (id: string): void => {
    const l = getLetter(db, id);
    if (!l) return;
    const loop = l.loopId ? getLoop(db, l.loopId) : null;
    const cfg = loadMailConfig(paths.config);
    publish({
      id, status: l.status, reason: l.reason, specialist: l.to, project: l.project, pass: l.pass,
      passLimit: cfg.ok ? cfg.config.passesPerLoop : null, verdict: l.verdict, review: l.review, loopStatus: loop?.status ?? null,
    });
  };
  // Nothing runs unrecorded: a failure to use the log turns mail off, and
  // every letter in hand is told so. Status files need no log.
  const breakMail = (e: unknown, inFlight: string | null = null): void => {
    broken = (e as Error).message;
    d.log(`mail stopped: ${broken}`);
    const reason = `mail is off: ${broken}`;
    if (inFlight) publishFinal(inFlight, 'failed', reason);
    for (const id of queue.splice(0)) publishFinal(id, 'cancelled', reason);
    try {
      d.notify('Fleet Mail stopped', broken);
    } catch (err) {
      d.log(`could not notify: ${(err as Error).message}`);
    }
  };
  const refusedRow = (id: string, reason: string): NewLetter => ({
    id, loopId: null, pass: null, fromTool: null, project: null, to: null, subject: null, body: null,
    attachments: [], status: 'refused', reason, ownerPid: d.pid, createdAt: d.now(),
  });

  /** Validates a claimed letter and queues it. Returns why it was refused, or null. */
  const accept = (id: string, raw: unknown): string | null => {
    const cfg = loadMailConfig(paths.config);
    if (!cfg.ok) return `mail is off: ${cfg.reason}`;
    const config = cfg.config;
    if (!config.enabled) return 'mail is off';
    const checked = checkLetter(raw, d.now(), Object.keys(config.specialists));
    if (!checked.ok) return checked.reason;
    const { letter, attachments } = checked;
    if (letter.id !== id) return 'letter id does not match its file name';
    if (lettersInLast24h(db, d.now()) >= config.lettersPerDay) return `daily limit of ${config.lettersPerDay} letters reached`;
    let loopId = id;
    let pass = 1;
    if (letter.re) {
      const prev = getLetter(db, letter.re);
      const loop = prev?.loopId ? getLoop(db, prev.loopId) : null;
      const problem = followUpProblem(loop, loop ? latestPass(db, loop.id) : null, letter, attachments);
      if (problem) return problem;
      loopId = loop!.id;
      pass = loop!.passes + 1;
    }
    const now = d.now();
    db.transaction(() => {
      if (pass === 1) {
        createLoop(db, { id: loopId, specialist: letter.to, project: letter.from.project, fromTool: letter.from.tool, status: 'open', passes: 1 }, now);
      } else {
        updateLoop(db, loopId, 'open', pass, now);
      }
      insertLetter(db, {
        id, loopId, pass, fromTool: letter.from.tool, project: letter.from.project, to: letter.to, subject: letter.subject,
        body: letter.body, attachments, status: 'queued', reason: null, ownerPid: d.pid, createdAt: now,
      });
    })();
    queue.push(id);
    return null;
  };

  const runLetter = async (id: string): Promise<void> => {
    const row = getLetter(db, id);
    if (!row || row.status !== 'queued' || row.loopId === null || row.pass === null) return;
    const loopId = row.loopId;
    const pass = row.pass;
    const finish = (status: LetterStatus, reason: string, stderrTail: string | null = null): void => {
      updateLetter(db, id, { status, reason, stderrTail, finishedAt: d.now() });
      updateLoop(db, loopId, 'failed', pass, d.now());
      publishFromLog(id);
    };
    const cfg = loadMailConfig(paths.config);
    if (!cfg.ok || !cfg.config.enabled) return finish('cancelled', 'mail was turned off before this ran');
    const config = cfg.config;
    const specialist = config.specialists[row.to ?? ''];
    if (!specialist) return finish('failed', `specialist "${row.to}" is no longer configured`);
    const instructions = readAgentInstructions(d.home, specialist);
    if (!instructions.ok) return finish('failed', instructions.reason);
    let mcpServers: string[] = [];
    if (specialist.runsOn === 'codex') {
      try {
        mcpServers = await d.listCodexMcpServers();
      } catch (e) {
        return finish('failed', `could not list Codex MCP servers: ${(e as Error).message}`);
      }
    }
    const replyFile = join(paths.work, `${id}.reply.json`);
    const cmd = buildCommand(specialist.runsOn, row.project!, paths.schema, replyFile, mcpServers);
    const prompt = buildPrompt({
      instructions: instructions.text, to: row.to!, fromTool: row.fromTool!, project: row.project!,
      subject: row.subject ?? '', body: row.body ?? '', attachments: row.attachments.map(a => a.path),
      pass, passLimit: config.passesPerLoop,
    });
    updateLetter(db, id, { status: 'running', startedAt: d.now() });
    publishFromLog(id);
    current = d.run(cmd, prompt, config.runMinutes * 60_000, { ...process.env, FLEET_MAIL_SPECIALIST: id });
    const result = await current.done;
    current = null;
    if (stopped) return;   // Fleet is quitting; the next start marks this cancelled
    let replyText: string | null = null;
    try {
      replyText = readFileSync(replyFile, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        removeQuietly(replyFile);
        return finish('failed', `could not read the reply (${code})`, result.stderrTail);
      }
    }
    removeQuietly(replyFile);
    if (result.timedOut) return finish('timed_out', `ran past ${config.runMinutes} minutes`, result.stderrTail);
    if (result.exitCode !== 0) {
      return finish('failed', `${specialist.runsOn} exited with ${result.exitCode ?? 'an error'}: ${lastLine(result.stderrTail)}`, result.stderrTail);
    }
    const parsed = parseReply(specialist.runsOn, result.stdout, replyText);
    if (!parsed.ok) return finish('failed', parsed.reason, result.stderrTail);
    const loopStatus = loopStatusAfter(parsed.reply.verdict, pass, config.passesPerLoop);
    updateLetter(db, id, { status: 'replied', verdict: parsed.reply.verdict, review: parsed.reply.review, stderrTail: result.stderrTail, finishedAt: d.now() });
    updateLoop(db, loopId, loopStatus, pass, d.now());
    publishFromLog(id);
    if (loopStatus === 'limit') d.notify('Review loop hit its limit', `${row.subject}: ${row.to} still wants changes after ${pass} passes.`);
  };

  // One specialist at a time.
  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0 && !stopped && !broken) {
        const id = queue.shift()!;
        try {
          await runLetter(id);
        } catch (e) {
          breakMail(e, id);
        }
      }
    } finally {
      running = false;
    }
  };

  const receive = (file: string): void => {
    const name = basename(file);
    if (!INBOX_NAME.test(name)) return;   // the slot's temp files, strays
    const id = name.slice(0, 32);
    const claimed = join(paths.work, `${id}.letter.json`);
    try {
      renameSync(file, claimed);          // atomic claim: another Fleet may be watching too
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') d.log(`could not claim ${name}: ${(e as Error).message}`);
      return;
    }
    let raw: unknown = null;
    let problem: string | null = null;
    try {
      if (statSync(claimed).size > MAX_LETTER_FILE) problem = 'letter file is over 256 KB';
      else raw = JSON.parse(readFileSync(claimed, 'utf8'));
    } catch (e) {
      problem = `letter could not be read: ${(e as Error).message}`;
    } finally {
      removeQuietly(claimed);
    }
    if (broken) return publishFinal(id, 'refused', `mail is off: ${broken}`);
    try {
      if (letterExists(db, id)) return;
      problem ??= accept(id, raw);
      if (problem) insertLetter(db, refusedRow(id, problem));
      publishFromLog(id);
    } catch (e) {
      breakMail(e);
      return publishFinal(id, 'refused', `mail is off: ${broken}`);
    }
    void pump();
  };

  for (const id of cancelOrphans(db, d.now(), d.pid, d.isAlive)) publishFromLog(id);

  return {
    receive,
    idle: async () => {
      while (running || (queue.length > 0 && !stopped && !broken)) await new Promise(r => setTimeout(r, 5));
    },
    stop: () => {
      stopped = true;
      current?.kill();
    },
  };
}

export function startPostOffice(d: PostOfficeDeps): PostOffice {
  const office = createPostOffice(d);
  const watcher = chokidar.watch(d.paths.inbox, { depth: 0, ignoreInitial: false });
  // Nothing may escape into Electron's main process from here.
  watcher.on('add', file => {
    try {
      office.receive(file);
    } catch (e) {
      d.log(`could not handle ${file}: ${(e as Error).message}`);
    }
  });
  watcher.on('error', e => d.log(`inbox watcher: ${(e as Error).message}`));
  return {
    ...office,
    stop: () => {
      office.stop();
      void watcher.close();
    },
  };
}
