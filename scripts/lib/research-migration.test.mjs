import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, fingerprint } from './virtual-autonomy.mjs';
import { reservationGenesis } from './research-reservations.mjs';
import { planLegacyReservationMigration, inspectResearchLedger } from './research-migration.mjs';
import { planMigrationFiles, main } from '../plan-research-migration.mjs';
const ledgerId = 'migration-test-ledger';
const config = { ledgerId, repository: 'owner/private-state', branch: 'research-state', path: 'ledger/reservations.json' };
const event = (suffix = 'a', start = 10, end = 20) => ({ type: 'holdout-reserved', at: 200,
  cycleId: fingerprint(`cycle-${suffix}`), requestHash: fingerprint(`request-${suffix}`), engineHash: fingerprint('engine'),
  testHash: fingerprint(`test-${suffix}`), start, end });
const source = (sourceId = 'host_a', events = [event()]) => ({ sourceId, events: events.reduce((acc,e) => appendAudit(acc,e), []) });
const run = (sources = [source()], missingSources = []) => planLegacyReservationMigration({ ledgerId, sources, missingSources });
const inspect = (overrides = {}) => {
  const document = reservationGenesis(ledgerId), readFile = vi.fn(async () => ({ content: JSON.stringify(document), sha: 'a'.repeat(40) }));
  const inspectRepository = vi.fn(async () => ({ repository_full_name: config.repository, visibility: 'private', permissions: { pull: true, push: true } }));
  return { config, inspectRepository, readFile, ...overrides };
};
const temp = async fn => { const root = mkdtempSync(join(tmpdir(), 'migration-')); try { return await fn(root); } finally { rmSync(root,{recursive:true,force:true}); } };

describe('read-only legacy reservation migration', () => {
  it('retains identity and consumption but never imports completed eligibility', () => {
    const s = source('old', [event(), { type: 'cycle-completed', at: 201, cycleId: event().cycleId, eligible: true }]);
    const p = run([s]); const r = p.proposedLedger.reservations[0];
    expect(r).toMatchObject({ cycleId: event().cycleId, start: 10, end: 20, status: 'reserved', reservedAt: 200 });
    expect(r.attemptId).toMatch(/^legacy_[a-f0-9]{48}$/); expect(r.resultHash).toBeUndefined();
    expect(p.activationReady).toBe(false); expect(p.earliestNewHoldoutStart).toBe(20); expect(p.inventory[0].sourceHash).toBe(fingerprint(s.events));
  });
  it('is deterministic and independent of source input order', () => {
    const a = source(), b = source('host_b', [event('b',30,40)]);
    expect(run([a,b])).toEqual(run([b,a]));
    const before = JSON.stringify(a); run([a]); expect(JSON.stringify(a)).toBe(before);
  });
  it('deduplicates exact copied reservations while retaining both source hashes', () => {
    const p = run([source(),source('copy')]); expect(p.exactReservations).toBe(1); expect(p.inventory).toHaveLength(2);
  });
  it('requires explicit inventory rather than treating absence as empty history', () => {
    expect(() => run([])).toThrow('inventory'); expect(() => run([], [{sourceId:'lost'}])).toThrow('conservative');
  });
  it('blocks all time before the documented missing-source cutoff', () => {
    const p = run([source()], [{sourceId:'missing',consumedBefore:100,evidence:'Preserved prior run record ends by UTC-ms 100.'}]);
    expect(p.proposedLedger.consumedBefore).toBe(100); expect(p.earliestNewHoldoutStart).toBe(100); expect(p.unavailableSources).toBe(1);
  });
  it('rejects duplicate source IDs including missing sources', () => {
    expect(() => run([source(),source()])).toThrow('sourceId');
    expect(() => run([source()],[{sourceId:'host_a',consumedBefore:100,evidence:'record'}])).toThrow('sourceId');
  });
  it('rejects invalid or altered audit chains', () => {
    const s=source(); s.events[0].start=11; expect(() => run([s])).toThrow('audit');
    expect(() => run([{sourceId:'bad',events:[{type:'holdout-reserved'}]}])).toThrow();
  });
  it('does not claim an unanchored valid audit prefix proves inventory completeness', () => {
    const full=source('prefix',[event(),{type:'cycle-completed',at:201,cycleId:event().cycleId}]);
    const p=run([{...full,events:full.events.slice(0,1)}]);
    expect(p.exactReservations).toBe(1); expect(p.activationReady).toBe(false);
    expect(p.blockers).toContain('inventory_completeness_not_proven');
  });
  it('rejects invalid reservation fields even in a valid hash chain', () => {
    for (const patch of [{cycleId:'x'},{start:20},{end:10},{start:1.5},{at:200.1}]) {
      expect(() => run([source('bad',[{...event(),...patch}])])).toThrow(/reservation|cycle identity/);
    }
  });
  it('rejects duplicate same-source cycles and conflicting copied records', () => {
    expect(() => run([source('bad',[event(),event()])])).toThrow('duplicate cycle');
    expect(() => run([source(),source('bad',[{...event(),end:30}])])).toThrow('conflicting');
  });
  it('does not compact overlapping or duplicate-hash histories silently', () => {
    expect(() => run([source(),source('overlap',[event('b',15,25)])])).toThrow('nonmonotonic');
    expect(() => run([source(),source('samehash',[{...event('b',30,40),testHash:event().testHash}])])).toThrow('duplicate');
  });
  it('rejects orphan events instead of assuming missing reservations consumed nothing', () => {
    expect(() => run([source('orphan',[{type:'cycle-completed',at:201,cycleId:event().cycleId}])])).toThrow('orphan');
    expect(() => run([source('orphan',[{type:'request-snapshotted',at:200,cycleId:event('b').cycleId},event()])])).toThrow('orphan');
    expect(() => run([source('no-id',[{type:'cycle-completed',at:200}])])).toThrow('cycle identity');
  });
  it('requires authoritative shared state instead of rebuilding it from local artifacts', () => {
    expect(() => run([source('shared',[{...event(),ledgerId}])])).toThrow('authoritative');
    expect(() => run([source('shared',[{...event(),attemptId:'original-attempt-id'}])])).toThrow('authoritative');
  });
  it('accepts an explicitly verified empty legacy journal without claiming complete inventory', () => {
    const p = run([source('empty',[])]); expect(p.exactReservations).toBe(0); expect(p.blockers).toContain('inventory_completeness_not_proven');
  });
});

describe('connected read-only ledger preflight', () => {
  it('verifies destination, identity and two monotonic reads without any write transport', async () => {
    const args=inspect(), result=await inspectResearchLedger(args);
    expect(args.inspectRepository).toHaveBeenCalledWith({repository_full_name:config.repository});
    expect(args.readFile).toHaveBeenCalledTimes(2); expect(result).toMatchObject({activationReady:false,repositoryPrivate:true,revision:0});
    expect(result.blockers).toContain('conditional_remote_writes_not_tested');
  });
  it('rejects public or wrong repositories before reading ledger content', async () => {
    for (const repo of [{repository_full_name:config.repository,visibility:'public'}, {repository_full_name:'other/private',visibility:'private'}]) {
      const args=inspect({inspectRepository:async()=>repo}); await expect(inspectResearchLedger(args)).rejects.toThrow('private'); expect(args.readFile).not.toHaveBeenCalled();
    }
  });
  it('rejects contradictory private/public metadata before reading the ledger', async () => {
    for (const flags of [{visibility:'public',private:true},{visibility:'private',private:false}]) {
      const args=inspect({inspectRepository:async()=>({repository_full_name:config.repository,permissions:{pull:true,push:true},...flags})});
      await expect(inspectResearchLedger(args)).rejects.toThrow('private'); expect(args.readFile).not.toHaveBeenCalled();
    }
  });
  it('rejects conflicting repository-name aliases before reading the ledger', async () => {
    const args=inspect({inspectRepository:async()=>({repository_full_name:config.repository,full_name:'wrong/private',private:true,permissions:{pull:true,push:true}})});
    await expect(inspectResearchLedger(args)).rejects.toThrow('private'); expect(args.readFile).not.toHaveBeenCalled();
  });
  it('does not turn missing permissions into a credential/permission request', async () => {
    const args=inspect({inspectRepository:async()=>({full_name:config.repository,private:true,permissions:{pull:true,push:false}})});
    await expect(inspectResearchLedger(args)).rejects.toThrow('permission'); expect(args.readFile).not.toHaveBeenCalled();
  });
  it('rejects secret-bearing configs, mismatched ledgers, failed reads and rollback', async () => {
    await expect(inspectResearchLedger(inspect({config:{...config,token:'not-a-secret'}}))).rejects.toThrow('only');
    await expect(inspectResearchLedger(inspect({readFile:async()=>({content:JSON.stringify(reservationGenesis('other-ledger-id-123')),sha:'a'.repeat(40)})}))).rejects.toThrow('identity');
    await expect(inspectResearchLedger(inspect({readFile:async()=>({isError:true})}))).rejects.toThrow('read failed');
    let calls=0; const args=inspect({readFile:async()=>({content:JSON.stringify({...reservationGenesis(ledgerId),revision:calls++ ? 0 : 1}),sha:'a'.repeat(40)})});
    await expect(inspectResearchLedger(args)).rejects.toThrow('regressed');
  });
  it('snapshots config before its first async read', async () => {
    const args=inspect(); const original=args.inspectRepository;
    args.config={...config}; args.inspectRepository=async input=>{args.config.path='mutated';return original(input);};
    expect((await inspectResearchLedger(args)).config.path).toBe(config.path);
    expect(args.readFile.mock.calls[0][0].path).toBe(config.path);
  });
});

describe('private local migration CLI', () => {
  const fixture = root => {
    writeFileSync(join(root,'audit.jsonl'),source().events.map(e=>JSON.stringify(e)).join('\n')+'\n');
    writeFileSync(join(root,'manifest.json'),JSON.stringify({ledgerId,sources:[{sourceId:'local',auditPath:'audit.jsonl'}],missingSources:[]}));
    return {manifestPath:join(root,'manifest.json'),output:'reports/migration.json'};
  };
  it('reads relative sources and writes a new private plan without changing them', async () => temp(root=>{
    const args=fixture(root), before=readFileSync(join(root,'audit.jsonl'),'utf8');
    const result=planMigrationFiles(args,{repositoryRoot:root}); expect(result.exactReservations).toBe(1);
    expect(statSync(result.path).mode & 0o777).toBe(0o600); expect(readFileSync(join(root,'audit.jsonl'),'utf8')).toBe(before);
    expect(()=>planMigrationFiles(args,{repositoryRoot:root})).toThrow('exists');
  }));
  it('rejects public outputs and symlink escapes', async () => temp(root=>{
    const args=fixture(root); expect(()=>planMigrationFiles({...args,output:'public/migration.json'},{repositoryRoot:root})).toThrow('private reports');
    mkdirSync(join(root,'outside')); symlinkSync(join(root,'outside'),join(root,'reports'));
    expect(()=>planMigrationFiles(args,{repositoryRoot:root})).toThrow('symlink');
  }));
  it('does not ignore partial or blank journal lines', async () => temp(root=>{
    const args=fixture(root); writeFileSync(join(root,'audit.jsonl'),'{}\n\n');
    expect(()=>planMigrationFiles(args,{repositoryRoot:root})).toThrow('blank');
    writeFileSync(join(root,'audit.jsonl'),'{'); expect(()=>planMigrationFiles(args,{repositoryRoot:root})).toThrow();
  }));
  it('validates CLI options and returns help without making files',()=>{
    expect(main([]).help).toContain('no remote'); expect(()=>main(['--output=x','--output=y'])).toThrow('duplicate');
    expect(()=>main(['--manifest=x'])).toThrow('explicit');
  });
});
