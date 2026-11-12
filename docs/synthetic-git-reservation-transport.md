# Inactive synthetic Git reservation transport

`createGitCommitReservationStore` in `scripts/lib/research-git-store.mjs` is an
injected-connector prototype, not an activated backend. Its frozen
`syntheticOnly: true` flag prevents observed-data research through the existing
runner. No CLI, job, credentials, repository bootstrap, or production migration
is supplied. Existing project records are unchanged.

## Trusted configuration and connector contract

Supply an existing dedicated private synthetic repository, existing branch and
JSON path, ledger identity, and `minimumCommit`: the last independently trusted
high-water commit. Never reset this checkpoint to a convenient older commit.
Persist newly verified checkpoints through a separately authorized mechanism.
The adapter does not prove repository privacy, retention, access controls or
checkpoint durability. Those require separate verification before activation.

`connector` exposes these async functions. Every call includes
`repository_full_name`. Every normalized result must include `repository`, equal
to the configured exact full name. Wrappers must validate the actual API URL or
repository identity before supplying that field, rather than blindly echoing the
requested identity. They must reject connector error envelopes and truncated,
redirected, cached, missing, or ambiguous responses. Disable automatic transport
retries. No wrapper is installed by this module.

- `getRef({branch_name})`: `{repository, ref, object:{type:'commit',sha}}`.
- `getCommit({sha})`: `{repository,sha,tree:{sha},parents:[{sha}]}`. Retrieve the
  exact immutable Git commit, not a branch alias. Merge commits are rejected.
- `getTree({sha,recursive:true})`: `{repository,sha,truncated:false,tree:[...]}`.
  Entries have `path`, `mode`, `type`, `sha`. Return the complete recursive tree.
  The ledger entry must be a normal `100644` blob at exactly the pinned path.
- `readFile({path,ref})`: `{repository,commitSha,treeSha,path,type:'file',
  mode:'100644',sha,content,size}`. `ref` is an immutable commit SHA. Verify and
  decode UTF-8 strictly. Supply byte size, blob SHA, and identities established
  from that exact commit/tree. Never fetch content from a mutable download URL.
- `createBlob({content,encoding:'utf-8'})`: `{repository,sha}`.
- `createTree({base_tree_sha,tree_elements})`: `{repository,sha}`.
- `createCommit({tree_sha,parent_sha,additional_parent_shas:[],message})`:
  `{repository,sha}`.
- `updateRef({branch_name,sha,force:false,expected_sha})`:
  `{repository,ref,object:{type:'commit',sha}}`. If the tool returns only success,
  the wrapper must fetch and validate the ref before constructing this result.
  If another writer has already advanced it, fail uncertain, not successful.

The current tool catalog has no direct getRef/getTree methods. An authorized
exact-URL read wrapper is still required; this source does not supply that
integration. Raw connector envelopes are intentionally not accepted. Wrappers may parse an
exact API response from connector structured content, but must never convert an
error to success or invent missing verification fields. The adapter snapshots
function references and JSON results to avoid mutation across asynchronous calls.

## Atomicity and recovery

A coherent read resolves the ref once, then reads immutable commit, tree and
content. Before an update it also verifies that unrelated tree entries remain
unchanged. It checks the Git blob hash, identities, ledger schema, and byte limit
(1 MiB). Version is the commit SHA, never the blob SHA. Each read must descend
from the pinned/in-memory high-water commit using at most 1,024 single-parent
links. Older/unrelated heads fail closed; long history requires an independently
verified checkpoint update, not an automatic reset.

A write requires a version observed by that instance and a monotonic document
with exactly one revision increment. It creates a blob/tree and exactly one
commit whose sole parent is the expected commit. It then rereads the immutable
commit/tree/file to validate the candidate before requesting a non-force ref
update with the expected SHA. Independent contenders create siblings, which
cannot both fast-forward the same branch even if the connector implements its
expected-SHA check separately from the actual ref update. This relies on Git's
atomic non-force ref semantics and no out-of-band force rewinds.

Only a verified changed head discovered **before creating objects** is classified
as `ReservationConflict`. All connector/update errors, including status 409/422
or an unknown error code, remain uncertain. The controller always rereads and
requires its exact receipt. Lost acknowledgements can therefore reconcile
without another write. Otherwise stop. Do not retry uncertain operations,
resume detached commits, or reuse an interrupted process's reservation attempt.
A fresh process starts with a trusted checkpoint and a new attempt identifier.
Unreferenced candidate objects are left alone; no cleanup/deletion is attempted.

Ancestry alone cannot protect against a compromised Git service, lost checkpoints,
or authorized force rewinds before the last known checkpoint. Controller
monotonic checks also protect previously observed ledger contents. This source
is included in the research engine hash so changing it changes engine identity.

## Verification

`npm test` includes credential-free, in-memory Git-service adversarial tests:
independent clients, sibling commits, lost acknowledgements, unknown/no-op update
results, detached-object restart, consumed holdout restart, pinned rollback,
stale versions, wrong parent/tree/path, content/hash/encoding/size failures, and
unsafe configuration. These are protocol tests, not proof of real connector
availability or production durability. Run `npm run build` separately.
