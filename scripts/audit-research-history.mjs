#!/usr/bin/env node
/** Read-only checkpoint audit. Output contains identities and counts, not quotes. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditResearchHistory } from './lib/research-history-audit.mjs';

export function main(argv = process.argv.slice(2)) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) return {
    help: 'node scripts/audit-research-history.mjs --checkpoint=PRIVATE_DIRECTORY --ledger-id=LEDGER_ID [--manifest-sha256=EXTERNALLY_PINNED_HASH]. Read-only; no remote calls, repair, fitting or activation. Keep output private.',
  };
  const args = {};
  for (const arg of argv) {
    const match = /^--(checkpoint|ledger-id|manifest-sha256)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(args, match[1])) throw new Error('research-history: invalid or duplicate argument');
    args[match[1]] = match[2];
  }
  if (!args.checkpoint || !args['ledger-id']) throw new Error('research-history: checkpoint and ledger-id required');
  return auditResearchHistory({ checkpointRoot: args.checkpoint, ledgerId: args['ledger-id'],
    expectedManifestHash: args['manifest-sha256'] ?? null });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = main(); console.log(JSON.stringify(result, null, 2));
    if (!result.help) process.exitCode = 3; // Successful integrity check, activation still blocked.
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
