import chokidar from 'chokidar';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readAgentInstructions } from './agent.ts';
import { writeFileAtomic, type LetterStatus, type MailPaths, type OutFile } from './files.ts';
import { checkLetter } from './letter.ts';
import {
  cancelOrphans, createLoop, getLetter, getLoop, getLoopSession, insertLetter, latestLoopSession, latestPass, letterExists, lettersInLast24h,
  setLoopSession, updateLetter, updateLoop, type MailDb, type NewLetter,
} from './log.ts';
import { followUpProblem, loopStatusAfter } from './loop.ts';
import { loadMailConfig } from './mailConfig.ts';
import { buildPrompt } from './runner.ts';
import {
  codexSessionId, firstMessage, openCommand, passLine, resumeCommand, sessionName, VERDICT_RULE, writePassFile,
  type Reply, type SessionDriver, type SessionSpec,
} from './session.ts';

export interface PostOfficeDeps {
  paths: MailPaths;
  db: MailDb;
  home: string;
  now: () => number;
  pid: number;
  isAlive: (pid: number) => boolean;
  session: SessionDriver;
  sleep: (ms: number) => Promise<void>;
  /** A fresh UUID for a new Claude session. */
  newSessionId: () => string;
  notify: (title: string, body: string) => void;
  log: (message: string) => void;
  /** Called after every status write, so the window's badges can refresh. */
  onChange?: () => void;
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

const POLL_MS = 2000;

export function createPostOffice(d: PostOfficeDeps): PostOffice {
  const { paths, db } = d;
  for (const dir of [paths.dir, paths.inbox, paths.out, paths.work, paths.letters]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  const queue: string[] = [];
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
    try {
      d.onChange?.();
    } catch (e) {
      d.log(`could not refresh the mail badges: ${(e as Error).message}`);
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
        id, loopId, pass, fromTool: letter.from.tool, fromPid: letter.from.pid ?? null,
        fromMeta: letter.from.meta ? JSON.stringify(letter.from.meta) : null, project: letter.from.project, to: letter.to, subject: letter.subject,
        body: letter.body, attachments, status: 'queued', reason: null, ownerPid: d.pid, createdAt: now,
      });
    })();
    queue.push(id);
    return null;
  };

  const runLetter = async (id: string): Promise<void> => {
    const row = getLetter(db, id);
    if (!row || row.status !== 'queued' || row.loopId === null || row.pass === null || !row.project || !row.to || !row.fromTool) return;
    const { loopId, pass, project, to } = { loopId: row.loopId, pass: row.pass, project: row.project, to: row.to };
    const finish = (status: LetterStatus, reason: string): void => {
      updateLetter(db, id, { status, reason, finishedAt: d.now() });
      updateLoop(db, loopId, 'failed', pass, d.now());
      publishFromLog(id);
    };
    const cfg = loadMailConfig(paths.config);
    if (!cfg.ok || !cfg.config.enabled) return finish('cancelled', 'mail was turned off before this ran');
    const config = cfg.config;
    const specialist = config.specialists[to];
    if (!specialist) return finish('failed', `specialist "${to}" is no longer configured`);
    const instructions = readAgentInstructions(d.home, specialist);
    if (!instructions.ok) return finish('failed', instructions.reason);
    const { runsOn } = specialist;

    const letterDir = join(paths.letters, loopId);
    const file = writePassFile(letterDir, pass, `${buildPrompt({
      instructions: instructions.text, to, fromTool: row.fromTool, project, subject: row.subject ?? '', body: row.body ?? '',
      attachments: row.attachments.map(a => a.path), pass, passLimit: config.passesPerLoop,
    })}\n\n${VERDICT_RULE}`);
    let sess = getLoopSession(db, loopId);
    // One reviewer per project and specialist: a new review goes to the
    // session that already reviewed there (reopened with resume if closed).
    if (sess.tmux === null) {
      const prior = latestLoopSession(db, to, project, loopId);
      if (prior) {
        sess = prior;
        setLoopSession(db, loopId, sess);
      }
    }
    const spec: SessionSpec = {
      runsOn, project, loopId, name: sessionName(to, row.subject ?? ''), sessionId: sess.sessionId ?? '', letterDir,
    };
    const startedAt = d.now();
    let fromOffset: number;
    if (sess.tmux && d.session.alive(sess.tmux)) {
      // The reviewer keeps its context: the next pass goes into the same session.
      let queue = false;
      try {
        fromOffset = sess.transcript ? d.session.size(sess.transcript) : 0;
        // A busy Codex does not submit on Enter; Tab queues the pass instead.
        queue = runsOn === 'codex' && sess.transcript !== null && d.session.codexBusy(sess.transcript);
      } catch (e) {
        return finish('failed', `could not read the session transcript: ${(e as Error).message}`);
      }
      const err = d.session.typeLine(sess.tmux, passLine(pass, file), queue);
      if (err) return finish('failed', `could not type into the session: ${err}`);
    } else {
      const resuming = sess.sessionId !== null;
      if (runsOn === 'claude' && !resuming) spec.sessionId = d.newSessionId();
      const tmux = sess.tmux ?? `llmws-${runsOn}-mail-${loopId.slice(0, 8)}`;
      const command = resuming ? resumeCommand(spec, passLine(pass, file)) : openCommand(spec, firstMessage(file));
      // Logged so a session that dies on startup can be reproduced by hand.
      d.log(`opened ${tmux}: ${command}`);
      const err = d.session.open(runsOn, project, command, tmux);
      if (err) return finish('failed', `could not open the session: ${err}`);
      const transcript = runsOn === 'claude' ? d.session.claudeTranscript(project, spec.sessionId) : sess.transcript;
      fromOffset = transcript ? d.session.size(transcript) : 0;
      sess = { sessionId: spec.sessionId || null, tmux, transcript };
      setLoopSession(db, loopId, sess);
    }
    updateLetter(db, id, { status: 'running', startedAt, transcriptOffset: fromOffset });
    publishFromLog(id);

    const deadline = startedAt + config.runMinutes * 60_000;
    const tmux = sess.tmux!;
    let lastSize = -1;
    while (!stopped) {
      if (!sess.transcript && runsOn === 'codex') {
        let found: string | null;
        try {
          found = d.session.findCodexRollout(file, startedAt - 5_000);
        } catch (e) {
          return finish('failed', `could not find the session transcript: ${(e as Error).message}`);
        }
        if (found) {
          sess = { ...sess, transcript: found, sessionId: codexSessionId(found) };
          setLoopSession(db, loopId, sess);
        }
      }
      let reply: Reply | null = null;
      if (sess.transcript) {
        try {
          // Re-read only when the transcript has grown since the last look.
          const size = d.session.size(sess.transcript);
          if (size !== lastSize) {
            lastSize = size;
            reply = d.session.readReply(runsOn, sess.transcript, fromOffset);
          }
        } catch (e) {
          return finish('failed', `could not read the session transcript: ${(e as Error).message}`);
        }
      }
      if (reply) {
        const loopStatus = loopStatusAfter(reply.verdict, pass, config.passesPerLoop);
        updateLetter(db, id, { status: 'replied', verdict: reply.verdict, review: reply.review, finishedAt: d.now() });
        updateLoop(db, loopId, loopStatus, pass, d.now());
        publishFromLog(id);
        if (loopStatus === 'limit') d.notify('Review loop hit its limit', `${row.subject}: ${to} still wants changes after ${pass} passes.`);
        return;
      }
      if (!d.session.alive(tmux)) return finish('failed', 'the session closed before replying');
      if (d.now() >= deadline) return finish('timed_out', `no VERDICT line within ${config.runMinutes} minutes; the session is still open in Fleet`);
      await d.sleep(POLL_MS);
    }
    // Fleet is quitting: the next start marks this letter cancelled. The session stays open.
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
      // Specialist sessions are David's; Fleet never kills them.
      stopped = true;
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
