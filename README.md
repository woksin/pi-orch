# @woksin/pi-orch — lean MVP + discovery

Local, dependency-free Node 26 TypeScript package. Files + git + GitHub are truth; no
ledger, terminal typing, automatic gates, auto-merge, or credential isolation.
Nothing is installed or enrolled merely by checking out this package.

## Identity and activation

Set these **before launching** pi/pi-session; wrapper relaunches retain them:

| Variable | Meaning |
|---|---|
| `PI_ORCH_ID` | `L0`, `R-<Repo>` owner, or lane (e.g. `L3`). Bootstrap ID only when no matching bound assignment/tombstone exists. Enrolment is authoritative. |
| `PI_ORCH_OPTOUT` | `1` disables discovery/delivery; it cannot disable an explicit or previously bound lane guard. |
| `PI_REPO` | Repo key for owners/lanes, e.g. `Studio`. |
| `ORCH_HOME` | Defaults to `/Volumes/sourcecode/repos/cratis/.ai-work/orch`. Tests always use a temporary home. |
| `ORCH_NODE` | Optional executable override for bin scripts; default is the pilot's Node 26.8.1 absolute path. |
| `PI_SESSION_WRAPPER_PID` | pi-session wrapper PID: stable session key `w<PID>`; otherwise `p<host-pid>`. |

Activation requires cwd under a `config.json` root, not under an exclude, and no
opt-out. No config/roots means no discovery/delivery. Explicit lane guards still apply outside roots, under excludes/optout and without config. Malformed config is dormant and reported once, not thrown from load/tool handlers.
The session-start observer re-evaluates roots on new/resume, and re-pins every UI
session ID. Outside roots: no registrations, deliveries or tools; explicit/bound guards remain. Pending or mismatched identities never receive owner privileges.
In-process workers (`ctx.hasUI === false`) never write session/heartbeat files or
deliver messages; assigned workers still cannot publish. This is an accidental-
publication barrier, **not a sandbox**; existing extensions may block independently.

Active sessions register immediately with no process probes on session_start.
Metadata fills via deferred async execFile calls, coalesced/cached for 30s; obsolete
new/resume/shutdown completions are discarded. Metadata adds tty, canonical git
root, origin, branch, and OS host/wrapper start times. Assignments bind to
`{pid,start}` of the wrapper (or host without one), not the reusable numeric key.
/new and same-wrapper host relaunch retain the binding; PID reuse ignores the old
assignment and its stable-key messages. Old assignments without bindings require
re-enrolment. A missing process identity stays pending, not privileged.

Effective identity: matching bound assignment/tombstone, else validated env
bootstrap, else `S-<key>`. Roles must agree with IDs: `R-<Repo>` = owner of that
repo, `L0` = l0, all others = lane. Duplicate IDs held by live bound processes are
refused, including env owner startup. The bus
watches assignments and reads them at each tool call; no restart/env mutation is
needed. Both effective-id and stable-key inboxes are read. Unassigned sessions
receive only ALL broadcasts and addressed orders, with **no publication/watch
guards** except the configured phaseWindow. Assignment starts lane/owner guards. The five tools and status line are activated only for assigned sessions or sessions with an addressed message; active-tool updates hide them from other prompts, preserving unrelated tools.

The bus scans at session start/agent_end, watches inboxes/assignments, polls every
20s and heartbeats every 30s. followUp delivery starts an idle turn or queues while
streaming. Context-budget `~/.pi/agent/context-budget/status/<sessionId>.json`
defers delivery during active handoff; missing/unreadable status permits delivery.
Receipts are claimed **before** send: each delivery/reminder is at-most-once, so a
send throw or crash cannot cause turn spam. A crash between claim and send can
lose that wake; pi offers no transaction with the filesystem. Outstanding acks
remain visible and can remind/escalate. One deadline reminder; escalation after
+15min. L0 questions/escalations/idle and ack-required reports are immediate; other
messages form at most one digest per ten minutes (throttle survives restarts).
Shutdown closes watchers/timers and removes only the session's own heartbeat.

Tools: `order_ack {id,plan}`, `order_decline {id,reason}`,
`order_done {id,evidence}`, `orch_send {to,kind,subject,body,requiresAck?,deadlineMin?}`,
`orch_status {repo?}`. Send recipients: session ID, `ALL`, `owners`, `lanes` (groups
use fresh, rooted, instrumented sessions). Default acknowledgment false, deadline 30 minutes.

Lane/worker bash and job command/check fields deny git push, gh pr
create/merge/ready/close, gh release, gh workflow run, and orch cand push/land/rebuild and orch enrol/unenrol. Owner holds deny only their
listed push/pr-create/pr-merge operations. Everyone must use orch_status instead
of gh run watch / gh pr checks --watch. CLI push/land/rebuild enforce the same role/hold checks using verified wrapper/registered ancestry before considering env. A lane cannot change its own authority by setting PI_ORCH_ID=L0, changing wrapper env, opting out, or calling enrol/unenrol. Standalone/unassigned callers retain operator access. gh api writes remain advisory/unparsed; this is not credential isolation. The role note is sent once per session/role revision, never each turn or in workers.

## ORCH_HOME

`config.json` controls discovery and optional temporary phase admission:

```json
{
  "roots": ["/Volumes/sourcecode/repos/cratis"],
  "excludes": ["/Volumes/sourcecode/repos/Mesta"],
  "phaseWindow": {
    "until": "2026-10-22T12:00:00Z",
    "requirePriority": "low",
    "exempt": ["L0"]
  }
}
```

Omit phaseWindow when unused. While active, assigned and unassigned sessions must
use `pi-phase run --priority low`; expired/exempt windows do not block. Paths use
realpaths, including symlinks and macOS /var vs /private/var aliases.

`repos.json` is an operator-edited mapping of repo keys to config, for example:

```json
{
  "Studio": {
    "slug": "Cratis/Studio",
    "mainCheckout": "/absolute/Studio",
    "integrationWorktree": "/absolute/integration-studio",
    "gateCmd": "<repo's CI-equivalent gate command>",
    "batch": { "min": 2, "max": 8, "ageHours": 24 },
    "expressPerDay": 1,
    "enrolled": true
  }
}
```

- `assignments/<key>.json`: `{key,id,role,repo,assignedAt,by,rev,binding:{pid,start}}`. Enrol writes a validated assignment; unenrol writes a bound null-role tombstone so the old env role cannot reappear.
- `sessions/<key>.json`: current identity, repo, sessionId, pid, wrapperPid, cwd, startedAt, hostStart and processIdentity.
- `heartbeats/<key>.json`: overwritten liveness/state, last turn end, unacked IDs.
- `inbox/<id>/<msgId>.json`: immutable message; ID `yyyymmddThhmmss-from-xxxx`.
- `receipts/<id>/<msgId>.<state>.json`: immutable delivered/acked/declined/done/reminded/escalated transitions.
- `deliveries/<Repo>/<dId>.json`: immutable delivery with issue/branch/SHA/deps/notes/intent/gate log.
- `deliveries/<Repo>/<dId>.status.<n>.json`: append-only status; highest number wins.
- `cands/<Repo>/<name>.json`: candidate; members freeze at build, head advances only via sync.
- `gh/<Repo>.json`: overwritten poller cache, `at` and `prs` (state/head/CI).
- `bus/<key>.digest.json`, `poller-state.json`: digest/backoff timestamps.
- `locks/<Repo>.lock`, `poller.lock`, transient `*.lock` and `*.tmp`: exclusive locks/atomic writes.

Mutable writes use tmp+rename; immutable facts use tmp+hard-link (concurrent
writers cannot overwrite a fact). They do not acquire per-file locks. Remaining
repo/status/poller/enrol leases contain pid/time/token; dead PID or lease mtime
older than 60s is recoverable. Timers renew every 15s and bounded git/gh calls
renew on entry/exit. Release checks its token before unlinking. Git integration
worktrees stay locked and retained; express uses `<integrationWorktree>-express`.
Candidate manifests record gate snapshot metadata and supersededBy on rebuild.
Holds remain repo/block-scoped events, not cleared by acknowledgments.

## CLI

`bin/orch` and `bin/orch-poll` are direct native-TS launchers. `gh` and `git` must
be on PATH. Repo-mutating CLI commands serialize with an exclusive repo lock.
Exit codes: **0** success, **1** usage, **2** named precondition failed,
**3** partial build (bounced deliveries), **4** nothing to do.

```sh
orch send R-Studio --kind order --subject 'Next batch' --ack --deadline 30 --body-file order.txt
# Without --body-file, body comes from stdin. Sender is effective identity, or outside operator L0.
orch send R-Studio --kind hold --subject 'Pause' --repo Studio --blocks push,pr-merge --body-file hold.txt
# release uses same repo and blocks. Kinds: order/info/question/report/idle/rule/hold/release/ci/escalation.
orch sessions [--json] [--all]
orch enrol w12345 --id L3 --role lane --repo Studio [--rules-file rules.txt]
# Target may also be an unambiguous tty, e.g. ttys003 or /dev/ttys003.
orch unenrol w12345   # or assigned id
orch owners
orch board [--json]
orch deliver --repo Studio --branch d/fix --issue 123 --notes-file notes.json --intent patch --gate-log gate.log \
  [--sha SHA] [--deps id1,id2] [--paths src/a src/b]
orch cand plan --repo Studio
orch cand build --repo Studio --ids id1,id2 [--express]
orch cand sync --repo Studio --cand NAME
orch cand gate --repo Studio --cand NAME --log gate.log
orch cand notes --repo Studio --cand NAME
orch cand push --repo Studio --cand NAME
orch cand land --repo Studio --cand NAME
orch cand rebuild --repo Studio --cand NAME --drop id1,id2
orch reconcile --repo Studio
orch-poll [--once]
```

Notes input is a nonempty JSON array, for example
`[{"section":"Fixed","bullets":["Corrected navigation (#123)"]}]`.
Sections: Added, Changed, Fixed, Removed, Security, Deprecated (that output order).
Intents: no-release, patch, minor, major. PR label is the plain max intent (`patch`, `minor`, `no-release`);
major is refused with "park for woksin". Every bullet must be single-line with a bare `(#n)` reference; Closes/Fixes/Refs directives are rejected. Only nonempty ordered `##` release-note sections are emitted (no issue-closing lines). Notes preserves references and
writes `<integrationWorktree>/.ai-work/cand-<NAME>-body.md`.

Deliver validates a local branch and tip/ancestor SHA, notes and a gate log whose
last nonempty line contains `pi-phase:` and `exit=0`. Build fetches origin/main,
merges dependency-first using --no-ff, aborts conflicts, bounces dependents and
continues. Explicit --ids must contain dependency closure (shipped deps excluded).
Plan freezes at count min or oldest ageHours, caps max without splitting closure.
Names use UTC minute plus a collision suffix when necessary.

Build prints gateCmd but **does not run it**. Owner runs the repo's gate using
job_start/pi-phase in the integration worktree, then registers evidence at the
recorded head. Candidate gate evidence requires a **new log path**, strictly newer
than the last build/sync, never a delivery log or previous gate path. Registration
verifies integration HEAD equals headSha and snapshots canonical path, mtime, size,
SHA-256 and HEAD. Push/land verify that unchanged snapshot; sync invalidates it.
Old manifests need a new gate. This is cooperative evidence, not tamper isolation.
Capture the **runner output**, not just its producer-only --log:

```sh
pi-phase run --kind build --priority low --label candidate-gate --timeout 300 --queue-timeout 300 -- YOUR_GATE > gate-NAME-1.log 2>&1
orch cand gate --repo Studio --cand NAME --log /absolute/gate-NAME-1.log
```

Sync records owner fixes, refuses merges importing nonmember deliveries, and
invalidates prior gate evidence. Push requires current branch/head and valid gate;
it pushes explicit `headSha:refs/heads/<branch>` and creates one PR with body, plain intent label and assignee woksin (no reviewer), later only pushes.
Land requires bound gate evidence, cache <=5min old, OPEN non-draft/non-major PR, matching head and all checks successful; uses
`gh pr merge <n> --merge --match-head-commit <headSha>`, never admin/auto. Run owners' `orch reconcile` at session
start and after interrupted operations to recover PR/status truth idempotently.
Rebuild never reverts: build anew minus drops/dependents, then close the old
unmerged PR with a link to the replacement candidate **branch** (no new PR exists
until its gate/push). Candidate build/gate alone do not mark members in-cand;
push does. Already superseded candidates cannot be rebuilt again, and in-cand deliveries cannot enter a different batch. Unknown cand branches are reconstructed without baseline/shipped deliveries. Closed unmerged PRs reconcile back to pending unless superseded.

## Poller and pilot installation (operator steps — not performed here)

1. Add `"./local-packages/pi-orch"` to `packages` in `~/.pi/agent/settings.json`.
2. Add this package's `bin/` to PATH (or create operator-managed symlinks).
3. Create/edit ORCH_HOME/config.json and repos.json, checking roots/excludes, paths and batch rules.
4. Set ORCH_HOME before launching pi-session. Roles may be pinned by env or assigned
   live using sessions/enrol; owners reconcile at each session start. Enable the
   installed extension only in an operator-controlled new/reloaded session.
5. Review `docs/com.woksin.orch-poll.plist`, replace paths/home/log locations and
   manually install/bootstrap it with launchd when ready. Package/tests never run
   launchctl. Only one poller should target an ORCH_HOME.

Live enrolment: `sessions` lists registrations; `--all` also reads uninstrumented
pi processes via pgrep/ps/lsof cwd, and attaches cached open PRs matching branches.
Discovery is injectable for tests. Only live processes under roots/outside excludes are listed. Dead or identity-mismatched registrations are pruned; stale heartbeats are excluded from broadcasts and tty matching. Uninstrumented processes under roots are marked explicitly by --all; enrol refuses them until the extension has registered a verified process identity. `enrol`
writes the assignment and an ack-required rules message to the stable-key inbox;
`unenrol` writes a bound tombstone and returns to S-<key>, suppressing even a previous env role. Enrol/unenrol require effective L0, or a standalone operator outside registered session ancestry who is managing a different session. Owners, lanes and unassigned in-session callers cannot administer enrolment. Discovery happens before taking the assignment lease; bounded CLI probes renew leases.
`owners` shows live repo owners, session IDs and heartbeat ages. A live owner has a
heartbeat <=90s old and a verified live process start identity. An assignment reserves its ID while that process/wrapper remains alive even with a stale heartbeat, so a slow relaunch cannot create two owners: use L0/outside operator to demote/unenrol the old owner before promoting its replacement.

Each 120s tick performs one open-PR list per enrolled repo, plus one view for a
candidate PR newly missing from the open list. Cache CI transitions SUCCESS,
FAILURE, MERGED wake the owner. No-check rollups remain UNKNOWN (not landable).
Rate 403/429 backs off that repo ten minutes. Escalations and stale (>10min,
regardless of PID) heartbeat digests continue; stale digests at most every 30min.
`orch-poll --once` runs one tick; exit 1 usage, 2 lock/poll errors, 0 success.

## Verification

No npm install/build required. Use the pinned Node or any Node 26 with TS stripping:

```sh
node test/check.ts
node --test --test-timeout=30000 'test/*.test.ts'
```

All tests use temporary ORCH_HOME and local bare git origins; fake gh precedes
PATH. Unit tests exercise pure decisions without pi, and a fake-pi factory test
verifies dormant/active loading without any live session or model request. Git
integration cases run in this same suite. `test/check.ts` syntax-checks all TS and
rejects trailing whitespace; there is no compiler/linter dependency or CI workflow.
Use pi-phase for both checks under agent execution policy. Regression tests explicitly place worktree aliases in native OS temporary paths, so managed-output paths cannot mask macOS realpath failures. The native package has no configured CI workflow or compiler build gate; local git/fake-gh integrations do not replace live pilot verification.
