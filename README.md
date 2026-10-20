# @woksin/pi-orch — lean MVP

Local, dependency-free Node 26 TypeScript package. Files + git + GitHub are truth; no
ledger, terminal typing, automatic gates, auto-merge, or credential isolation.
Nothing is installed or enrolled merely by checking out this package.

## Identity and activation

Set these **before launching** pi/pi-session; wrapper relaunches retain them:

| Variable | Meaning |
|---|---|
| `PI_ORCH_ID` | `L0`, `R-<Repo>` owner, or lane (e.g. `L3`). Unset: extension registers nothing. |
| `PI_REPO` | Repo key for owners/lanes, e.g. `Studio`. |
| `ORCH_HOME` | Defaults to `/Volumes/sourcecode/repos/cratis/.ai-work/orch`. Tests always use a temporary home. |
| `ORCH_NODE` | Optional executable override for bin scripts; default is the pilot's Node 26.8.1 absolute path. |
| `PI_SESSION_WRAPPER_PID` | Optional pi-session-provided wrapper PID, recorded for continuity. |

Only the first UI session in a process delivers messages and writes heartbeats.
Non-UI sessions and other session IDs stay passive, but still cannot publish.
This guard is an accidental-publication barrier, **not a sandbox**. Existing
extensions may block tools independently (notably context-budget during handoff).

The bus scans at session start, watches inbox, polls every 20s and heartbeats every
30s. Messages use followUp delivery (idle starts a turn; streaming queues). A
context-budget status file in `~/.pi/agent/context-budget/status/<sessionId>.json`
defers delivery during active handoff; missing/unreadable status permits delivery.
Receipts are durable. Delivery is at-least-once across a crash between send and
receipt, not exactly-once. One deadline reminder; poller escalates after +15 min.
L0 receives questions/escalations/idle and ack-required reports immediately; other
messages are combined at most once per ten minutes (digest time persists).

Tools: `order_ack {id,plan}`, `order_decline {id,reason}`,
`order_done {id,evidence}`, `orch_send {to,kind,subject,body,requiresAck?,deadlineMin?}`,
`orch_status {repo?}`. Send recipients: session ID, `ALL`, `owners`, `lanes` (groups
use registered sessions). Default acknowledgment false, deadline 30 minutes.

Lane/worker bash and job command/check fields deny git push, gh pr
create/merge/ready/close, gh release, gh workflow run. Owner holds deny only their
listed push/pr-create/pr-merge operations. Everyone must use orch_status instead
of gh run watch / gh pr checks --watch. No changing system prompt.

## ORCH_HOME

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

- `sessions/<id>.json`: current identity, repo, sessionId, pid, wrapperPid, cwd, startedAt.
- `heartbeats/<id>.json`: overwritten liveness/state, last turn end, unacked IDs.
- `inbox/<id>/<msgId>.json`: immutable message; ID `yyyymmddThhmmss-from-xxxx`.
- `receipts/<id>/<msgId>.<state>.json`: immutable delivered/acked/declined/done/reminded/escalated transitions.
- `deliveries/<Repo>/<dId>.json`: immutable delivery with issue/branch/SHA/deps/notes/intent/gate log.
- `deliveries/<Repo>/<dId>.status.<n>.json`: append-only status; highest number wins.
- `cands/<Repo>/<name>.json`: candidate; members freeze at build, head advances only via sync.
- `gh/<Repo>.json`: overwritten poller cache, `at` and `prs` (state/head/CI).
- `bus/<id>.digest.json`, `poller-state.json`: digest/backoff timestamps.
- `locks/<Repo>.lock`, `poller.lock`, transient `*.lock` and `*.tmp`: exclusive locks/atomic writes.

No lock is stolen on PID/age assumptions. After a crash, inspect for live owners
before an operator removes a stale lock. Git integration worktrees are locked and
retained. Express uses `<integrationWorktree>-express` and daily admission limits.
Candidate manifests additionally record gateSha (evidence binding) and, on rebuild,
supersededBy. Holds are ordered repo/block events, not cleared by acknowledgment.

## CLI

`bin/orch` and `bin/orch-poll` are direct native-TS launchers. `gh` and `git` must
be on PATH. Repo-mutating CLI commands serialize with an exclusive repo lock.
Exit codes: **0** success, **1** usage, **2** named precondition failed,
**3** partial build (bounced deliveries), **4** nothing to do.

```sh
orch send R-Studio --kind order --subject 'Next batch' --ack --deadline 30 --body-file order.txt
# Without --body-file, body comes from stdin. Sender PI_ORCH_ID, or operator L0.
orch send R-Studio --kind hold --subject 'Pause' --repo Studio --blocks push,pr-merge --body-file hold.txt
# release uses same repo and blocks. Kinds: order/info/question/report/idle/rule/hold/release/ci/escalation.
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
Intents: no-release, patch, minor, major. PR label is `release:<max-intent>`;
major is refused with "park for woksin". Notes preserves bullet references and
writes `<integrationWorktree>/.ai-work/cand-<NAME>-body.md`.

Deliver validates a local branch and tip/ancestor SHA, notes and a gate log whose
last nonempty line contains `pi-phase:` and `exit=0`. Build fetches origin/main,
merges dependency-first using --no-ff, aborts conflicts, bounces dependents and
continues. Explicit --ids must contain dependency closure (shipped deps excluded).
Plan freezes at count min or oldest ageHours, caps max without splitting closure.
Names use UTC minute plus a collision suffix when necessary.

Build prints gateCmd but **does not run it**. Owner runs the repo's gate using
job_start/pi-phase in the integration worktree, then registers evidence at the
recorded head. Capture the **runner output**, not just its producer-only --log:

```sh
pi-phase run --kind build --label candidate-gate --timeout 300 --queue-timeout 300 -- YOUR_GATE > gate.log 2>&1
orch cand gate --repo Studio --cand NAME --log /absolute/gate.log
```

Sync records owner fixes, refuses merges importing nonmember deliveries, and
invalidates prior gate evidence. Push requires current branch/head and valid gate;
it creates one PR with body, label and assignee woksin, later only pushes.
Land requires cached OPEN PR, matching head and all checks successful; uses
`gh pr merge --merge`, never admin/auto. Run owners' `orch reconcile` at session
start and after interrupted operations to recover PR/status truth idempotently.
Rebuild never reverts: build anew minus drops/dependents, then close the old
unmerged PR with a link to the replacement candidate **branch** (no new PR exists
until its gate/push). Candidate build/gate alone do not mark members in-cand;
push does. Closed unmerged PRs reconcile back to pending unless superseded.

## Poller and pilot installation (operator steps — not performed here)

1. Add `"./local-packages/pi-orch"` to `packages` in `~/.pi/agent/settings.json`.
2. Add this package's `bin/` to PATH (or create operator-managed symlinks).
3. Create/edit ORCH_HOME/repos.json, checking absolute paths and batch rules.
4. Set role/repo/home before launching the pilot's pi-session. Owners reconcile
   at each session start. Do not enable this in an existing live session.
5. Review `docs/com.woksin.orch-poll.plist`, replace paths/home/log locations and
   manually install/bootstrap it with launchd when ready. Package/tests never run
   launchctl. Only one poller should target an ORCH_HOME.

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
Use pi-phase for both checks under agent execution policy.
