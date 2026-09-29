// Help, opened over Settings from the Help row at the end of its list.
//
// Option B of the approved "Help button in Settings" mockup
// (claude.ai/artifact/Pm1UjzEWrck2qvkGVjnNri). Its CSS is the mockup's,
// which was itself built from SettingsModal.css, HooksConsent.css,
// DependencyChecks.css and MailBadge.css, so this reuses their classes
// (.settingshead, .settingsclose, .settingsfoot, .hcfacts, .mailbadge)
// rather than restating them.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { MailBadge } from '../../mail/badges.ts';
import { Icon } from './Icon.tsx';
import { MailBadges } from './MailBadge.tsx';
import { useCopy, COPY_LABEL } from '../state/useCopy.ts';
import './HelpModal.css';

/** Locks the Settings panel behind Help (HelpModal.css). Its own class, not
 *  SettingsModal's 'modal-open': Settings is still open underneath, so
 *  closing Help must not take away the lock Settings holds on the app. */
const LOCK_CLASS = 'help-open';

/** One Help topic: a title, a one-line lede, and a body. Adding a topic is
 *  adding an entry to HELP_TOPICS; the topic list appears once there are
 *  two. */
export interface HelpTopic { id: string; title: string; lede: string; Body: () => ReactElement }

/** Non-empty by type, so the modal always has a topic to open on. */
type Topics = readonly [HelpTopic, ...HelpTopic[]];

const REVIEW_REQUEST =
  "Use fleet-mail to have codex-reviewer review docs/my-plan.md. Attach it, set project to this folder's "
  + 'absolute path, then check_mail until it replies and show me the review.';
const FOLLOW_UP =
  'Fix what you agree with in docs/my-plan.md, then send the next pass with re set to the last letter id, '
  + 'saying what you fixed and what you declined. Check mail until it replies.';

/** Examples in the exact shape src/mail/badges.ts produces, drawn by the
 *  component the session cards use, so Help shows what the cards show. */
const SENDER_BADGE: MailBadge = {
  kind: 'sender', count: '×1', state: 'idle', tip: '1 review · codex-reviewer, pass 2 of 4, changes requested',
};
const REVIEWER_BADGE: MailBadge = {
  kind: 'reviewer', count: '2/4', state: 'idle', tip: 'Answered pass 2 of 4 for claude · my-project',
};

/** A section of a topic. The space after the step number is for the
 *  accessible name ("1 Before you start"); the heading is a flex row, so it
 *  adds nothing on screen. */
function Section({ step, title, children }: { step?: number; title: string; children: ReactNode }) {
  return (
    <section className="helpsec">
      <h4 className="helpsectitle">
        {step !== undefined && <><span className="helpstep">{step}</span>{' '}</>}
        {title}
      </h4>
      {children}
    </section>
  );
}

/** An example message and its Copy button. Same hook, labels and states as
 *  DependencyChecks' Copy button: a failed write says so. */
function CopyMessage({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopy();
  return (
    <div className="helpmsg">
      <p className="helpmsgtext">{text}</p>
      <button
        type="button"
        className="helpcopy"
        data-state={state}
        aria-label={state === 'idle' ? label : COPY_LABEL[state]}
        onClick={() => copy(text)}
      >
        {COPY_LABEL[state]}
      </button>
    </div>
  );
}

function FleetMailHelp() {
  return (
    <>
      <Section step={1} title="Before you start">
        <ul className="helplist">
          <li>Fleet must be running.</li>
          <li>Use a Claude or Codex session opened after mail was set up. To use an older session, resume it and it picks mail up.</li>
        </ul>
      </Section>

      <Section step={2} title="Ask for a review">
        <p className="helptext">Send your session a message like this:</p>
        <CopyMessage text={REVIEW_REQUEST} label="Copy the review request" />
        <p className="helpnote">Codex sessions can ask <code>claude-reviewer</code> the same way.</p>
      </Section>

      <Section step={3} title="Keep going">
        <p className="helptext">When the review comes back, send:</p>
        <CopyMessage text={FOLLOW_UP} label="Copy the follow-up" />
      </Section>

      <Section title="What you'll see">
        <ul className="helplist">
          <li>The reviewer opens as a live session in that project. If the project already has a reviewer, that one gets the letter.</li>
          <li>The reply comes back marked approved or changes requested.</li>
        </ul>
        <div className="helpbadges">
          <div className="helpbadge">
            <MailBadges badges={[SENDER_BADGE]} />
            <span>On the session that asked: how many reviews it has started.</span>
          </div>
          <div className="helpbadge">
            <MailBadges badges={[REVIEWER_BADGE]} />
            <span>On the reviewer: which pass it is on.</span>
          </div>
        </div>
      </Section>

      <Section title="Limits">
        <dl className="hcfacts">
          <dt>Passes per review</dt><dd>4 by default. After that you get a notification.</dd>
          <dt>Letters</dt><dd>40 in any 24 hours.</dd>
          <dt>Attachments</dt><dd>Files inside the project only. Anything that looks like a secret, such as a key file or .env, is refused.</dd>
          <dt>Settings file</dt><dd>To change the limits or add specialists, edit <code>~/.llm-workspace/mail/config.json</code>.</dd>
        </dl>
      </Section>
    </>
  );
}

export const HELP_TOPICS: Topics = [
  {
    id: 'fleet-mail',
    title: 'Fleet Mail',
    lede: 'Have another agent review a file for you. It writes back by mail, and you trade passes until it approves.',
    Body: FleetMailHelp,
  },
];

/** The panel inside the dialog. Mounted only while Help is open, so it
 *  opens on the first topic with its Copy buttons reset each time. */
function HelpPanel({ topics, onClose }: { topics: Topics; onClose: () => void }) {
  const [currentId, setCurrentId] = useState(topics[0].id);
  const topic = topics.find(t => t.id === currentId) ?? topics[0];
  const { Body } = topic;
  const article = (
    <article className="helptopic">
      <header className="helptopichead">
        <h3 className="helptitle">{topic.title}</h3>
        <p className="helplede">{topic.lede}</p>
      </header>
      <Body />
    </article>
  );
  return (
    <div className="helppanel">
      <header className="settingshead helphead">
        <span className="helpmark" aria-hidden="true"><Icon name="info" size={18} /></span>
        <h2>Help</h2>
        <button type="button" className="settingsclose" aria-label="Close help" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {topics.length > 1 ? (
        <div className="helpsplit">
          <nav className="helpnav" aria-label="Help topics">
            {topics.map(t => (
              <button key={t.id} type="button" aria-current={t.id === topic.id} onClick={() => setCurrentId(t.id)}>
                {t.title}
              </button>
            ))}
          </nav>
          {article}
        </div>
      ) : article}
      <div className="settingsfoot">
        <p className="settingscaption">Done or Escape goes back to Settings.</p>
        <button type="button" className="settingsdone" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** A native <dialog> shown with showModal() over Settings' own, for the
 *  same reasons SettingsModal gives: top layer, focus trap and an inert
 *  background for free. Rendered beside Settings' dialog, not inside it, so
 *  none of Help's events (a backdrop click, the cancel React bubbles through
 *  its tree) reach Settings' handlers. */
export function HelpModal({ open, onClose, topics = HELP_TOPICS }: {
  open: boolean;
  onClose: () => void;
  topics?: Topics;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Same jsdom fallback as SettingsModal: no showModal/close there.
  useEffect(() => {
    const el = dialogRef.current;
    if (el === null) return;
    if (open) {
      if (typeof el.showModal === 'function') { if (!el.open) el.showModal(); }
      else el.setAttribute('open', '');
    } else {
      if (typeof el.close === 'function') { if (el.open) el.close(); }
      else el.removeAttribute('open');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.documentElement.classList.add(LOCK_CLASS);
    return () => { document.documentElement.classList.remove(LOCK_CLASS); };
  }, [open]);

  // SettingsModal stops listening while Help is open, so this is the only
  // Escape handler then, and one press closes Help alone.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <dialog
      ref={dialogRef}
      className={`settingsdlg helpdlg${topics.length > 1 ? ' helpdlg-split' : ''}`}
      aria-label="Help"
      onCancel={e => { e.preventDefault(); onClose(); }}
      onClick={e => { if (e.target === dialogRef.current) onClose(); }}
    >
      {open && <HelpPanel topics={topics} onClose={onClose} />}
    </dialog>
  );
}
