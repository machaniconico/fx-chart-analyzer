import { describe,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dailyCronMinute, summarizeScheduleTiming, timingSummary, main } from './report-schedule-timing.mjs';
const run = { id:43781903389,event:'schedule',run_attempt:1,created_at:'2026-11-16T00:41:52Z',run_started_at:'2026-11-16T00:41:52Z' };
const summarize = (patch={}) => summarizeScheduleTiming({run,eventName:'schedule',cron:'0 21 * * *',observedAt:Date.parse('2026-11-16T00:42:04Z'),expectedRunId:String(run.id),...patch});

describe('daily scheduling telemetry',()=>{
  it('separates the reproduced scheduling delay from work after creation',()=>{
    const r=summarize(); expect(r.latestNominalOccurrenceAt).toBe('2026-11-15T21:00:00.000Z');
    expect(r.creationDelayLowerBoundMs).toBe((3*3600+41*60+52)*1000); expect(r.elapsedSinceCreationMs).toBe(12000);
    expect(r.warning).toBe('scheduled_creation_delayed_at_least_30_minutes');
  });
  it('uses the scheduled minute with UTC day rollover',()=>{
    const r=summarize({cron:'17 21 * * *'}); expect(r.latestNominalOccurrenceAt).toBe('2026-11-15T21:17:00.000Z');
    expect(r.creationDelayLowerBoundMs).toBe((3*3600+24*60+52)*1000);
  });
  it('reports on-time creation as zero without a warning',()=>{
    const r=summarize({run:{...run,created_at:'2026-11-15T21:17:00Z',run_started_at:'2026-11-15T21:17:00Z'},cron:'17 21 * * *'});
    expect(r.creationDelayLowerBoundMs).toBe(0);expect(r.warning).toBe(null);
  });
  it('warns at exactly 30 minutes, not below',()=>{
    const timed=(seconds)=>summarize({run:{...run,created_at:`2026-11-15T21:${seconds?'46:59':'47:00'}Z`,run_started_at:'2026-11-15T21:47:00Z'},cron:'17 21 * * *'});
    expect(timed(true).warning).toBe(null);expect(timed(false).warning).not.toBe(null);
  });
  it('does not infer a scheduled deadline for manual runs',()=>{
    const r=summarize({run:{...run,event:'workflow_dispatch'},eventName:'workflow_dispatch',cron:''});
    expect(r.warning).toBe(null);expect(r.creationDelayLowerBoundMs).toBe(null);expect(r.latestNominalOccurrenceAt).toBe(null);
  });
  it('does not mislabel a rerun as a new scheduled occurrence',()=>{
    const r=summarize({run:{...run,run_attempt:2,run_started_at:'2026-11-17T10:00:00Z'},observedAt:Date.parse('2026-11-17T10:01:00Z')});
    expect(r.latestNominalOccurrenceAt).toBe('2026-11-15T21:00:00.000Z');expect(r.elapsedSinceAttemptStartMs).toBe(60000);
  });
  it('explicitly limits claims about dropped and over-24-hour occurrences',()=>{
    const r=summarize();expect(r.timingScope).toMatch(/Lower bound only/);expect(r.timingScope).toMatch(/>24h/);
    expect(timingSummary(r)).toMatch(/No extra run is dispatched/);
  });
  it.each(['* 21 * * *','17 24 * * *','60 21 * * *','17 21 1 * *','17 21 * * 1','17 21 * * *\n','',null])('rejects unsupported cron %s',(cron)=>{
    expect(()=>dailyCronMinute(cron)).toThrow('daily UTC cron');
  });
  it('accepts midnight and last minute daily schedules',()=>{
    expect(dailyCronMinute('0 0 * * *')).toBe(0);expect(dailyCronMinute('59 23 * * *')).toBe(1439);
  });
  it('rejects a different event/run, malformed date, future observation and invalid attempt',()=>{
    for(const patch of [{expectedRunId:'1'},{eventName:'push'},{run:{...run,event:'workflow_dispatch'}},
      {run:{...run,created_at:'2026-02-30T00:00:00Z'}},{run:{...run,created_at:'2026-11-16T00:41:52+00:00'}},
      {run:{...run,run_attempt:0}},{run:{...run,run_started_at:'2026-11-15T00:00:00Z'}},{observedAt:0}]) expect(()=>summarize(patch)).toThrow();
  });
  it('writes only job summary/log telemetry and performs one read',()=>{
    const appendSummary=vi.fn(),log=vi.fn(),readRun=vi.fn(()=>run);
    main({env:{GITHUB_REPOSITORY:'owner/repo',GITHUB_RUN_ID:String(run.id),GITHUB_EVENT_NAME:'schedule',EVENT_SCHEDULE:'0 21 * * *',GITHUB_STEP_SUMMARY:'/tmp/summary'},readRun,now:()=>Date.parse('2026-11-16T00:42:04Z'),appendSummary,log});
    expect(readRun).toHaveBeenCalledTimes(1);expect(readRun).toHaveBeenCalledWith('owner/repo',String(run.id));
    expect(appendSummary).toHaveBeenCalledTimes(1);expect(appendSummary.mock.calls[0][0]).toBe('/tmp/summary');expect(log.mock.calls[1][0]).toMatch(/^::warning/);
  });
  it('does not retry a failed metadata read',()=>{
    const readRun=vi.fn(()=>{throw Error('read unavailable');});
    expect(()=>main({env:{},readRun})).toThrow('read unavailable');expect(readRun).toHaveBeenCalledTimes(1);
  });
});

describe('daily workflow safety contract',()=>{
  const source=readFileSync(new URL('../.github/workflows/update-data.yml',import.meta.url),'utf8');
  it('keeps a single off-hour cron, main-only dispatch and noncancelling serialization',()=>{
    expect([...source.matchAll(/- cron:/g)]).toHaveLength(1);expect(source).toContain('cron: "17 21 * * *"');
    expect(source).toContain("if: ${{ github.ref == 'refs/heads/main' }}");
    expect(source).toMatch(/concurrency:\n  group: fx-production-publish\n  cancel-in-progress: false/);
    expect(source).toMatch(/actions\/checkout@v5\n        with:[\s\S]*?ref: main/);
  });
  it('makes telemetry soft without softening the precommit/final gates',()=>{
    expect(source).toMatch(/name: Report scheduled start delay\n        continue-on-error: true/);
    const steps=source.split(/\n      - /);
    for(const name of ['Verify data freshness before commit','Verify data freshness and persistence']) {
      const step=steps.find(x=>x.includes(`name: ${name}\n`));expect(step).toBeTruthy();expect(step).not.toContain('continue-on-error');
    }
    expect(source.indexOf('Report scheduled start delay')).toBeLessThan(source.indexOf('Fetch latest FX data'));
  });
  it('does not add dispatch, watchdog or autonomous research execution',()=>{
    expect(source).not.toMatch(/gh workflow run|\/dispatches|run-virtual-research|synthetic-outer/);
  });
});
