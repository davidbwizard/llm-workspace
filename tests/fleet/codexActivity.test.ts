import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { openSessionsLive } from '../../src/fleet/state.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';
import type { LiveProcess } from '../../src/discovery/parse.ts';
import type { CodexPrompt } from '../../src/core/codexPrompt.ts';

const NOW = Date.parse('2026-10-09T16:33:00Z');
function fixture(provider: 'codex' | 'claude' = 'codex', agentId: string | null = null) {
  const db = openDb(':memory:');
  const event = (kind: NormalizedEvent['kind'], ts: string, n: number): NormalizedEvent => ({
    provider, sessionId:'root', runId:null, agentId:null, ts, kind,
    payload:kind === 'session.started' ? {cwd:'/repo'} : {}, nativeId:null,
    sourceFile:'/rollout',sourceOffset:n,contentHash:String(n),subIndex:0,parserVersion:1,
  });
  insertEvents(db,[event('session.started','2026-10-09T16:10:00Z',0),event('prompt.submitted','2026-10-09T16:30:00Z',1)]);
  db.prepare(`INSERT INTO signal_events
    (event_id,occurred_at,ingested_at,provider,session_id,agent_id,kind,payload)
    VALUES (?,?,?,?,?,?,?,?)`).run('approval','2026-10-09T16:32:00Z','2026-10-09T16:32:00Z','claude','root',agentId,
      'PermissionRequest',JSON.stringify({tool_name:'Bash',tool_input:{command:'already approved'}}));
  const process: LiveProcess = {pid:11,provider,cwd:'/repo',tty:null,host:'iterm2',ageSeconds:3600,rssBytes:null};
  return {db,process};
}
const command: CodexPrompt = {key:'request',kind:'command',threadId:'root',turnId:'turn',itemId:'item',
  reason:null,command:'npm test',cwd:'/repo',details:null,questions:null,decisions:['accept','decline']};

describe('Codex card activity authority',()=>{
  it.each([null,'child-agent'])('uses the ready exact observer over old root and child hooks (agent: %s)',agentId=>{
    const {db,process}=fixture('codex',agentId);
    expect(openSessionsLive(db,[process],NOW,{codexSnapshot:()=>({state:'ready',prompts:[]})})[0]?.activity).toBe('working');
  });
  it.each([null, {state:'unavailable' as const,prompts:[]}])('keeps legacy protection without a ready native observer (%s)',snapshot=>{
    const {db,process}=fixture();
    expect(openSessionsLive(db,[process],NOW,{codexSnapshot:()=>snapshot})[0]?.activity).toBe('waiting_permission');
  });
  it('retains the Claude hook gate for Claude cards',()=>{
    const {db,process}=fixture('claude');
    expect(openSessionsLive(db,[process],NOW)[0]?.activity).toBe('waiting_permission');
  });
  it('shows a real pending native Codex command approval',()=>{
    const {db,process}=fixture();
    db.prepare('DELETE FROM signal_events').run();
    expect(openSessionsLive(db,[process],NOW,{codexSnapshot:()=>({state:'ready',prompts:[command]})})[0]?.activity)
      .toBe('waiting_permission');
  });
  it('keeps an asynchronous native question from marking the running turn blocked',()=>{
    const {db,process}=fixture();
    expect(openSessionsLive(db,[process],NOW,{codexSnapshot:()=>({state:'ready',prompts:[{...command,kind:'questions',isBlocking:false}]})})[0]?.activity)
      .toBe('working');
  });
  it('uses an empty ready native list over stale same-provider hooks',()=>{
    const {db,process}=fixture();
    db.prepare("UPDATE signal_events SET provider='codex'").run();
    expect(openSessionsLive(db,[process],NOW,{codexSnapshot:()=>({state:'ready',prompts:[]})})[0]?.activity)
      .toBe('working');
  });
});
