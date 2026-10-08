# DSH phase 2 implementation

## Accepted scope

Single-owner cloud control plane, optional local-only mode, macOS/Linux workers,
Windows workers (with WSL2 as the recommended deployment), multi-provider DSH runs, durable agent mailboxes,
isolated development directories, skills/MCP/plugin capabilities, schedules and
monitoring. Existing roles, sessions, tasks and knowledge remain readable.

## Implementation Milestones

These checkboxes track implementation and deterministic local validation.
They are not sign-off for the separate real deployment gates below.

- [x] P0: versioned SQLite migrations, consistent backups, modular management UI.
- [x] P1: encrypted vault, provider routes and probes, projects and server resources.
- [x] P2: owner authentication, worker pairing, durable leases and reconciliation.
- [x] P3: task groups, dependencies, instance-scoped mailboxes and checkpoints.
- [x] P4: isolated worktrees/snapshots, artifacts, acceptance evidence and revisions.
- [x] P5: primary capability sources, installation, compatibility and pinned versions.
- [x] P6: interval/Cron schedules, monitors, notifications, budgets and backups.

| Batch | Delivered behavior                                                                                                                   | Evidence                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| P0    | Versioned transactional migration, pre-upgrade consistent backup, modular views                                                      | Migration success/failure, WAL and historical-record tests                                                                 |
| P1    | Four provider protocols, real capability probes, ordered routing and failure fallback, encrypted vault, resources                    | Native DSH calls against three deterministic wire protocols; API and credential boundary tests                             |
| P2    | Environment-bootstrapped owner auth, outbound workers, pairing/revocation, durable claims, leases and result ACK                     | Real loopback HTTP worker and authenticated MCP tests; lost lease and late-result rejection                                |
| P3    | Logical jobs and attempts, parent/peer messages, mailbox IDs, versions, checkpoints, board and operation grants                      | Persistent inbox, duplicate delivery, requirement ACK, descendant permissions, pause/resume tests                          |
| P4    | Managed worktrees, no-HEAD snapshots, reserved ports, commits, integration, verification evidence and knowledge history              | Large/unusual diffs, source preservation, conflict retention, budget and composite scenario tests                          |
| P5    | SkillsMP, ClawHub, official MCP Registry, custom repos; skills, MCP tools, plugin commands/templates and supported sync Hooks        | Live read-only search of all three markets; local plugin fixtures and real MCP tool gateway tests                          |
| P6    | Explicit timezone, interval and Cron preview, misfire policies, no overlap, deduped notifications/Webhook, usage and offline restore | Injected-clock DST/cadence tests; replacement-attempt scheduling, notification retry, encrypted restore and rollback tests |

## Validation

- [x] Existing regression suite plus new deterministic integration tests: 264/264, no skips.
- [x] Lint, typecheck and production build.
- [x] Browser workflows at desktop and mobile sizes, including real backend forms.
- [x] Cross-platform CI matrix is configured to run formatting, file-size checks, lint, typecheck, backend/CLI tests, `ggb doctor` and production build on Ubuntu, macOS and Windows with Node.js 22/24; Ubuntu also runs the desktop/mobile browser baseline.
- [x] Combined parent/frontend/backend/reviewer scenario using real orchestration MCP,
      a local external MCP, pinned Skill, isolated Git worktrees, peer messages,
      checkpoints, pause/change-provider/resume, automatic summary and a tested integration.
- [x] Original local data upgraded and checked against pre-upgrade table hashes.
- [ ] Linux worker integration on a real Linux execution environment.
- [ ] Windows/WSL2 worker integration on a real Windows execution environment.
- [ ] Real cloud deployment and HTTPS pairing (requires configured infrastructure).
- [ ] Real cloud continues scheduled work while the owner's computer is offline.

## Local Release Record

Model setup guidance on 2026-10-08: recruitment now distinguishes absent chat
models, disabled providers, empty model lists, decision-only configurations,
unsupported protocols and unavailable credentials. The selected provider's
credential problem takes precedence over another configured provider. Unlocking,
credential deletion and model changes refresh the guidance; configuration trips
retain the recruitment draft. Legacy default models show their configured ID.
The check reads credential metadata only and does not claim connectivity or
make paid probes. TypeSafe and capability extensions remain optional.

The three new backend/HTTP tests cover configuration states and the real vault
lifecycle without returning credential references or secret values. The full
backend suite passed 264/264. Six desktop/mobile scenarios passed, including
real unlock/delete actions, alternative model selection and 320px controls.
Focused-run fixture failures were corrected by adding the required team goal
and JSON request bodies; product assertions and timeouts were not relaxed.
Existing conversation context and composer layout scenarios passed 16/16.
Evidence is retained in `/tmp/ggb-setup-evidence`. The full desktop/mobile
browser regression passed 260/260 in 13.2 minutes without skips or retries.
Whole-repository formatting, Lint, typecheck, the 320-source line gate and
production build passed. Local production was restarted only after confirming
zero active tasks/jobs; the original 11 tasks, 10 jobs and 2 unconfirmed spaces
retained their IDs. Five UI/API smoke endpoints returned 200. A 393px production
browser check showed the selected provider’s locked-credential message without
horizontal overflow. Real device, cross-platform and paid-model quality
acceptance remain separate gates.

Whole-chain owner review on 2026-10-08: the collaboration graph now has an
explicit all-request preview and complete/end/reopen actions. Preview includes
unexpanded history, every verified delegation and all participating source
teams. Incomplete provenance blocks bulk actions. Each action checks its own
eligibility; completion requires current accepted delivery and a terminal task,
ending requires terminal work and a reason, and reopening never schedules work.
Existing decisions are retained when the action does not need to change them.

A fresh fingerprint binds the topology, content, shared replies, task/delivery
state, review versions and source-team eligibility. Changed scope rejects the
whole batch. Review records, per-source audit events, an immutable receipt and
versioned draft consumption commit together. A repeated request returns its
original receipt without closing a newly added branch or undoing a later reopen.
Drafts support cross-device continuation, conflict resolution and per-tab receipt
recovery; changing the action, note or preview invalidates the UI confirmation.

Seven new backend/HTTP scenarios cover 23 requests beyond the first page,
three-team onward delegation, acceptance, stale work, scope changes, archived
sources, authentication, required reasons, draft conflicts, late receipts and
injected transaction rollback without notifications. The complete backend suite
passed 261/261. The first focused browser run passed 7 cases and timed out on the
last mobile sync case during system sleep (45-second test elapsed about 17
minutes). Evidence is retained in `/tmp/ggb-chain-close-evidence/first-focused`.
The same 8 cases passed unchanged in 27.2 seconds with process-scoped AC system
sleep prevention. No assertion or timeout was relaxed. A further desktop/mobile
case now rejects malformed preview data while retaining the note and retry path.
The complete desktop/mobile suite passed 254/254 in 13.0 minutes without skips
or retries. Format, Lint, typecheck and the 315-source line gate passed.

Repository formatting gate completed on 2026-10-08: cleared the 50-file tracked
formatting backlog. The CLI now separates provider configuration, session
persistence and diagnostics. Capability bundle parsing is separate from the
installation/connection service, with the existing public inspectBundle export
preserved. Control/MCP/worker, team isolation and HTTP integration tests are split
by responsibility and share their original setup helpers.

The five extracted files retain all 125 original declarations and test bodies,
checked against their formatted pre-extraction TypeScript AST. The remaining 45
files match formatter output from HEAD byte-for-byte. No model defaults, API
contracts, assertions or source-size exclusions changed. The CLI entry is 918
lines and the capability service is 834; all 308 scanned source files are below
1000 lines. CI now checks whole-repository formatting across its existing
Ubuntu/macOS/Windows and Node.js 22/24 matrix. Playwright reports are ignored as
generated output. This is local configuration, not evidence of a remote CI run.

Whole-repository formatting, Lint, typecheck and production build passed.
Backend/CLI regression passed 254/254 without skips. Desktop/mobile browser
regression passed 244/244 in 11.1 minutes with no retries or skipped cases.
Verification logs, browser artifacts and AST comparison results are retained
under `/tmp/ggb-format-evidence/` locally. After verifying no active tasks/jobs,
the production build was refreshed and the local service restarted. UI, API
health, proxied state, both collaborator endpoints and CLI doctor passed. The
original 11 task IDs, 10 job IDs and two unconfirmed spaces remained unchanged;
there are still no confirmed production teams. No paid model calls, remote push
or deployment occurred.

Collaboration draft continuity on 2026-10-07: handoff targets, requirements,
acceptance criteria and follow-up references now persist by source team; closure
notes persist by source request. Owner-only draft endpoints enforce revision CAS
and source-message scope. Empty records retain their revision. The browser keeps
an offline fallback plus a per-tab recovery copy, retries on reconnection and
shows complete local/server versions when both have changed. It does not merge
unrelated targets and request text. A remote pending request must be confirmed
before replacing it with a conflicting local version.

Submission first saves the fixed pending ID and then includes its draft revision
in the business request. Handoff/review writes and matching draft consumption are
atomic; stale versions or failed cleanup roll back the action. Lost business
receipts retain the initiating tab's immutable request across reload, even if
another device has consumed the server draft. Replaying it returns the original
result and cannot erase a newer draft. Closing a component prevents late draft
callbacks from overwriting its replacement.

Four new backend tests plus existing handoff/review tests passed 14/14. Full backend
regression passed 254/254 without skips. The existing desktop/mobile collaboration
recovery suite passed 14/14 in 32.5s. Four new scenarios across independent browser
contexts and shared-browser tabs passed 8/8 in 47.4s, including offline reload,
version choice, cross-device confirmation, review-note synchronization and unique
business records. Screenshots were inspected at desktop/mobile sizes. Evidence is
retained under `/tmp/ggb-collab-draft-evidence`. Initial test fixture names exceeded
the role-name limit and were shortened; development also fixed lost-receipt
retention, rather than weakening the existing retry assertions. The first full
browser run passed 243 cases and failed one mobile node-lifecycle lookup: accumulated
fixtures moved the target off the first 12-row page. The test now uses the existing
node search before opening each detail, retaining every lifecycle/notification/
repair assertion. Its desktop/mobile rerun passed 2/2 in 17.8s. Failure traces are
retained in `first-full`, with the focused rerun in `node-search`. A fresh full
browser run passed 244/244 in 11.3m with unchanged application code, retained in
`final-full`. Lint, typecheck and the 297-source file-size gate passed; all changed
files pass targeted formatting. The tracked format backlog remains 50 files.
Production build passed. The local service restarted only after verifying zero
active tasks/jobs; UI, API health, proxied state and collaborator endpoints passed.
Both original spaces return empty revision-zero drafts without writing records,
and reject an unmatched review-draft scope with 404. Existing IDs remain unchanged:
11 tasks, 10 jobs and two unconfirmed spaces. Browser/MCP test data stayed isolated;
no paid model calls, remote push or deployment occurred.

Verified onward team delegation on 2026-10-07: the owner collaboration view
now follows authenticated task origins across product, development and operations
teams, including a return handoff. Both follow-up references and initiating-task
relationships are retained. Multiple starting requests are explicitly identified;
a shared successor is counted once. Each request shows source/target teams and
links to its initiating task when verified. Agent MCP read permissions remain
limited to their existing authorized direct collaborations.

New handoffs atomically save versioned origin records with task/job/paired messages.
MCP origins come from the execution lease; owner submissions are recorded explicitly.
Member tasks and retry attempts require verified logical-job ancestry. Free-form
context and client-supplied origin fields cannot create graph edges. Legacy records
without provenance are marked incomplete rather than reconstructed; duplicate
submission does not backfill them. Broken origins are excluded with an incomplete
notice, and graph topology changes invalidate pagination cursors.

Six new real HTTP/MCP tests cover multi-team traversal, descendant/retry origins,
atomic rollback with no success events, idempotency, multiple roots, missing or
forged associations and agent permission boundaries. Focused backend regressions
passed 26/26; the complete backend suite passed 250/250 with no skips.

Visual inspection exposed a mobile overflow outside the chain itself: long team
names widened the cross-team timeline grid, allowing automatic horizontal scrolling
to clip the collaboration panel. A long-name regression failed before the CSS fix.
The grid and flex children now constrain their width; assertions cover the page's
scroll width, scroll position and chain viewport bounds. The related desktop/mobile
suite passed 22/22 in 43.0s. Before/after evidence is retained in
`/tmp/ggb-onward-evidence/layout-red` and `layout-focused`. An earlier full browser
run was deliberately interrupted before changing the layout, so it is not counted
as full verification. The final full browser regression passed 236/236 in 10.2m;
evidence is retained under `/tmp/ggb-onward-evidence/full`. Lint, typecheck,
the 292-file size gate and all 16 changed files' targeted format checks passed.
Formatting the team-page CSS and mobile interaction guide reduced the tracked
formatting backlog from 52 to 50; the repository-wide format gate remains open. Production
build passed. The local service restarted after confirming no active tasks/jobs;
UI, API health, proxied state and both collaborator lists returned 200. Both
existing spaces reject unmatched chain entries with the new route's 404. Original
IDs remain unchanged: 11 tasks, 10 jobs and two unconfirmed spaces. New multi-team
flows were tested with isolated fixtures and real local HTTP/MCP services, not
paid models or production confirmed teams. No remote push or deployment occurred.

Collaboration follow-up chain inspection on 2026-10-07: each valid shared
request/reply opens a read-only chain for the same source/target pair. The
view connects original requests, nested follow-ups and branches; separates
execution, delivery acceptance and owner closure; shows complete shared request,
reply and closure-note text; and links to the corresponding task conversation.
It supports locating the selected request, 44px mobile controls, focus return,
page retry and refresh of the entire expanded history. Failed reads retain the
accepted view, and switching chains discards stale responses.

`GET /teams/:id/collaboration-chain/:messageId` validates paired messages and
task metadata. Foreign pairs, target-private notes and unshared task results
are excluded. Broken ancestors are marked incomplete; cycles are rejected.
Pages default to 20 (maximum 50); cursors bind team, root and topology revision,
so changing membership/associations invalidates old cursors. This does not close
requests or cover another team's onward delegation to a third team.

Four new real HTTP tests plus existing handoff/review regressions passed 20/20.
The complete backend suite passed 244/244 with no skips. Six new desktop/mobile
browser scenarios passed in 19.6s on stable code; fixture name/timestamp setup
and the expected task-conversation navigation were corrected during development.
Screenshots were inspected and touch sizes/overflow asserted. Evidence remains
under `/tmp/ggb-chain-evidence/focused`. Lint, typecheck and the 288-file size gate
passed; the tracked formatting backlog remains 52. Full desktop/mobile browser
regression passed 232/232 in 9.8m, retained under `/tmp/ggb-chain-evidence/full`.
The final focused check after neutralizing the shared failure label passed 6/6
in 14.1s (`final-focused`). Production build and all 12 changed files' targeted
format checks passed. The local service restarted after verifying zero active
work; UI, API health, proxied state and collaborator-list requests returned 200.
Both existing spaces correctly reject an unmatched chain request with the new
route's 404. Original IDs remain unchanged: 11 tasks, 10 jobs and two unconfirmed
spaces. Successful chain flows were verified in isolated fixtures, not claimed
as production confirmed-team execution. No remote push or deployment occurred.

Control-plane responsibility split on 2026-10-07: execution eligibility, leases
and result submission now live in `server/control/execution-lifecycle.mjs`;
logical jobs and parent summaries in `job-lifecycle.mjs`; Team Charter proposal,
confirmation and roster reading in `team-recruitment.mjs`. The `ControlPlane`
public methods remain forwarding entry points, retaining shared transactions,
permissions and injected services. No product behavior is intentionally changed.

The formatted entry point is 649 lines; the three modules are 266, 391 and 615
lines. A local AST comparison matched all 13 extracted method bodies and
parameter lists after replacing the class context with the explicit plane
parameter; all 28 retained class members also match their original AST.
This structural check supplements the existing regression tests;
it is not an end-to-end behavior guarantee. Focused tests passed 46/46 and the
full backend suite passed 240/240 with no skips. Lint, typecheck and the 284-file
source-size gate passed. The tracked formatting backlog fell from 53 to 52;
full-repository formatting is still an unmet gate.

The first browser run ended at 221 passed / 5 failed in 49.4m. macOS sleep
records align with all five failures: 568s, 454s, 31s, 1005s and 320s sleep
intervals overlap the failing trace timestamps. The same five scenarios passed
on both desktop and mobile in a focused 10/10 rerun (41.2s), without code or
assertion changes. Original screenshots and traces remain under
`/tmp/ggb-control-refactor-evidence/first-full`; the focused rerun is in
`focused-recheck`. A fresh full run uses `caffeinate -i` only for the test
process lifetime; no persistent power setting is changed. The fresh full run
passed 226/226 in 9.0m, with unchanged code and assertions; evidence is retained
under `final-full`. Production build passed. The local service restarted only
after confirming zero active tasks/jobs; UI, API health, proxied state and both
collaborator endpoints returned 200. Existing task, job and space IDs are
unchanged: 11 tasks, 10 jobs and two unconfirmed spaces. Team recruitment and
execution workflows were tested against isolated fixtures, not production
confirmed teams. No remote push or deployment was performed.

Agent collaboration visibility and scoped reading on 2026-10-07: the new
`list_team_collaborations` MCP tool lists the current confirmed team's own
incoming/outgoing requests with open/closed/stale/unlinked filters, bounded
pages, counts, shared reply excerpts and advisory next actions. Cursors are
bound to team/direction/status; equal timestamps use the same code-point ID
ordering as cursor comparisons. Pages reflect current data, not frozen snapshots.
Owner-only closure flags do not grant write authority. Project-manager skill
instructions now cover closed/stale/unlinked handling and safe follow-up.

`read_team_task` previously checked only collaboration access to the target
team, allowing inspection of unrelated target work. It now verifies the actual
source-owned handoff, paired messages and task metadata, and rechecks the live
lease. Its message output contains only the original handoff and matched shared
replies, excluding target-private notes. The list retains locally held request
and reply history after peer access is revoked, but disables detailed reads and
follow-up. New, unshared target output is absent from those historical excerpts.

Five authenticated loopback MCP cases cover foreign/private work rejection,
incoming/outgoing visibility, filter-first pagination with equal timestamps and
mixed-case/non-ASCII IDs, cursor scope, owner closure and result-change freshness,
read-only behavior, revoked access, unlinked records, source-team state and lease
revocation. The focused suite passed 12/12; full backend regression passed
240/240, including a repeat after strengthening cursor ordering. No paid models
or production delegation was used. Evidence is retained in
`/tmp/ggb-collaboration-read-evidence` for this session.
Lint, typecheck and the 281-file source-size gate passed. The new collaboration
reader keeps `server/control.mjs` at 883 lines; that legacy module remains in the
formatting backlog. All ten other changed files pass targeted formatting.
Formatting the project-manager skill reduced the tracked-file backlog to 53.
Full desktop/mobile browser regression passed 226/226 in 9.1m. The five new
authenticated MCP cases also passed after replacing a default-sort expectation
with an explicit mixed-case/Unicode expected order to satisfy the lint rule.
Production build passed. The local service restarted after verifying zero active
tasks/jobs. UI, API health, proxied state and both collaborator-list endpoints
returned 200. Existing data remains 11 tasks, 10 jobs and two unconfirmed spaces;
agent reading was verified with isolated authenticated fixtures, not production
delegations. No remote push or deployment was performed.

Owner collaboration closure on 2026-10-07: source-team history now exposes
processing controls and shared closure status. Completing a request requires
the existing current owner-approved delivery; ending follow-up instead requires
a settled task and a reason, and never changes delivery acceptance. Reopening
requires a reason and starts no task. Each follow-up request remains independent.
Closed requests block new HTTP/MCP follow-ups, while previously accepted sends
can still recover their original receipts. Only the owner can write decisions.

Review state and audit events commit atomically before source/target live
refreshes. Revision and task/evidence fingerprints prevent stale overwrites;
fingerprints include result/error contents, so external writes that retain a
timestamp still invalidate old closure. These fingerprints are memoized only
inside a synchronous read projection. History retains all audit events, showing
the newest 20. Local processing drafts and pending request IDs survive reload;
unknown outcomes preserve immutable retries, explicit rejection preserves the
reason and allows fresh review. Chain-wide summaries/closure and cross-device
processing-draft sync remain outstanding.

Five new backend cases cover accepted evidence, stale output/evidence, reasons,
reopening, authenticated-instance rejection, team scope, active/unknown-task
rejection, duplicate receipts, revision conflicts and late-audit rollback with
no success events. Full backend regression passed 235/235. The focused
desktop/mobile browser suite passed 14/14, exercising actual owner acceptance,
real closure POSTs with dropped responses, reload/retry, audit uniqueness,
draft recovery, reopening and conflicting decisions. Mobile screenshots were
inspected. Evidence is retained in `/tmp/ggb-review-evidence` for this session.
Full browser regression passed 226/226 in 9.1m. Lint, typecheck, all 279
hand-written source-file size limits and targeted formatting for all 18 changed
files passed. The full repository format gate still reports 54 legacy files.
After including output contents in fingerprints, the full backend suite again
passed 235/235; a fresh desktop/mobile run of closure/reopen/conflict/receipt
scenarios passed 4/4 against the final implementation.
Production build passed. After confirming zero active tasks/jobs, the local
service restarted. UI, health, proxied state and collaborator-list smoke checks
passed; nonexistent review references correctly returned 404. Existing data
remains 11 tasks, 10 jobs and two unconfirmed spaces, so no production closure
was written. Functional decisions were exercised only in isolated fixtures.
No remote push or deployment was performed.

Linked collaboration follow-up on 2026-10-07: the collaboration history now
expands complete messages and loads earlier records beyond the initial eight.
For settled original tasks, the source team can prepare a follow-up from either
its handoff or the returned reply. Existing drafts require an explicit keep or
replace choice; the linked target remains fixed until the reference is removed.
References survive reload alongside the draft and appear in the send preview.
Pending sends retain the existing immutable request/recovery behavior.

Both owner HTTP and authenticated MCP accept `followupMessageId`, identifying
the source-side original handoff. The server checks team ownership, the paired
message, task metadata and settled status, then loads historical content itself.
Running/queued/unknown tasks and foreign or mismatched references are rejected.
New work gets its own task/session and a persisted link in both team traces;
retries return the existing task. This does not approve the original delivery.
Source-team acceptance, collaboration closure and cross-device form sync remain
outstanding.

Backend regression passed 230/230; three added HTTP/MCP tests cover contextual
follow-up, stable replay, linkage, session isolation and invalid references.
The focused desktop/mobile suite passed 10/10 with real HTTP persistence on an
isolated offline node. It verifies full reading, earlier history, 44px actions,
no horizontal overflow, draft replacement choices, refresh recovery and the
actual saved task prompt/link. Desktop and mobile screenshots were inspected.
The first browser attempt exposed a fixture missing the required team goal;
the fixture was corrected without relaxing assertions. Session evidence lives
in `/tmp/ggb-followup-evidence`.
The full browser suite subsequently passed 222/222 in 8.8m. Lint, typecheck,
all 276 hand-written source-file line limits and formatting for all 19 changed
files passed. Formatting the touched MCP interface reduced the remaining
repository formatting backlog from 55 to 54 files; the full format gate is
still not clean.
Production build passed. The local service restarted after confirming zero
active tasks/jobs. UI, API health, proxied state and both existing spaces'
collaborator endpoints returned 200; 11 tasks and 10 jobs remain. Neither
existing space is confirmed, so the live check did not send follow-up work;
real persistence was verified only in isolated fixtures. No remote push or
deployment was performed.

Shared HTTP/MCP team handoff persistence on 2026-10-07: both adapters now
use one atomic commit/recovery module. MCP message identities include the source
task, so identical keys from different callers no longer overwrite each other.
Each new delegation creates an independent target conversation and task group,
using the target team's model and workspace. An identical retry returns the
existing task. Legacy rows are reused only when request and team identities
match; existing task metadata repairs a missing link. Conflicting associations
are rejected. Completed jobs no longer exhaust the MCP active-job limit.
Live lease, confirmed/active-team, whitelist and auto-handoff checks remain.

Five new tests use an authenticated loopback MCP client with actual instance
leases and isolated offline target nodes. They cover same-key source isolation,
independent sessions/groups, late-write rollback with no success events, stable
replay, legacy recovery, active capacity and revoked/disabled access. No paid
models or production data are used. Backend regression passed 227/227 with no
skips; the focused desktop/mobile collaboration/timeline suite passed 28/28.
The subsequent full browser regression passed 218/218 in 8.6m. Lint,
typecheck and the 274-file source-size gate passed. Ten new/updated files pass
targeted formatting; the existing 55-file formatting backlog includes
`server/control.mjs`, whose delegation extraction reduced it to 910 lines.
Production build passed. After checking zero active tasks/jobs, the local
service restarted; UI, API health, proxied `/api/state` and both existing spaces'
collaborator lists returned 200. Existing data remains 11 tasks and 10 jobs.
Neither existing space is a confirmed team, so live checks were read-only;
delegation was tested using isolated fixtures. No remote push or deployment.
Evidence is retained in `/tmp/ggb-mcp-handoff-evidence` for this session.
Cross-device collaboration-form synchronization and source-team follow-up after
results return remain future work.

Recoverable cross-team handoff on 2026-10-07: collaboration forms persist the
selected target, goal, criteria and pending request ID per source team in the
current browser. This is separate from server-synced conversation drafts;
cross-device collaboration-form synchronization remains outstanding. Targets
are explicitly selected and are never silently replaced. Editing a preview
requires review again. Target-list loading has timeout, stale-response isolation
and in-place retry. Unknown send outcomes lock the original payload and keep its
ID across navigation/reload; retry confirms the original request. Missing task
receipts cannot clear the draft. Explicit 4xx rejection restores editing;
success clears only the matching pending request, preserving newer input.

The workbench HTTP endpoint atomically commits the handoff, task, job, metadata and both team
traces. Live notifications are deferred and coalesced until commit; rollback
publishes no success. Legacy taskless handoffs can recover, and existing task
metadata repairs a lost message link without duplicating work. Completed jobs
no longer consume the active-task limit. Three new backend tests cover late
write failure after task creation, rollback/event isolation, idempotent replay,
legacy link repair and terminal-job capacity. Full backend regression is 222/222.
The six-run desktop/mobile feature suite passed. Its lost-receipt scenario
creates a real task on an isolated offline fixture node, drops the HTTP response,
reloads, retries the identical request and verifies one job/two team traces.
No paid model or real execution node is used. Other cases cover scoped draft
recovery, preview invalidation, target-list retry and editable validation failure.
Initial fixture failures used the wrong role creation API and lacked a provider
configuration; the fixture now creates a role with a generated ID and a disabled
loopback provider. Screenshots were inspected, including the mobile error state.
Evidence is retained in `/tmp/ggb-handoff-evidence` for this session.
The 34-run collaboration/task-recovery/timeline integration suite also passed.
The first full run exposed fixture contamination: an intentionally offline queued
task changed navigation counts and shared-team history. Recovery cases now create
unique teams and settle their queued fixture work after each case; existing
business assertions remain intact. The final full suite passed 218/218
desktop/mobile runs in 8.6m. Backend regression passed 222/222, including
explicit metadata rollback and committed-message event checks.
Lint, typecheck, all 271 source-file line limits, formatting for the 13 changed
files and production build passed. The local service restarted after confirming
zero active work among 11 tasks and 10 jobs. UI, API health, proxied state and
both existing spaces' collaborator-list endpoints passed read-only smoke checks; the
11 existing tasks remained present. No production handoff was sent, and no
remote push or deployment was performed. The existing 55-file formatting
backlog remains open.

Team activity loading on 2026-10-07: the web client negotiates
`X-GGB-State-View: workbench`, deferring each space's messages/timeline while
retaining all task text, metadata and counts. The response explicitly marks
`teamActivityDeferred`; default API consumers retain the original full state.
Only the mounted team activity panel requests a scoped timeline, with filters
applied before cursor pagination (120 initial rows, 60 older rows). Switching
teams/filters isolates stale success and error responses. Initial failure,
refresh failure and older-page failure have distinct recovery states; retry
preserves the failed cursor and accepted content. SSE-triggered refresh and
five-second polling re-read the entire expanded window so older edits and
deletions remain visible. Offscreen panels stop polling. The recent-collaboration
panel independently
loads the latest eight handoffs/replies using a server-side collaboration filter,
with retained error/retry state and reload persistence. Unexpanded windows stay
bounded; only explicitly expanded history is re-read to its prior oldest row.
Failed task previews prioritize the error over partial output. Confirmed-team guidance describes
ongoing collaboration rather than recruiting the same team again. Mobile
filter and refresh controls have at least 44px touch targets.

Isolated five-sample fixtures compared each compact response against the full
state excluding only the deferred activity fields. At 10 teams/200 tasks,
initial state bodies were 483,069 versus 1,158,429 bytes; at 20 teams/800 tasks,
1,883,589 versus 3,457,309 bytes. Timings vary under concurrent test load and
are not mobile UX measurements. Initial task text is still complete; task-level
server pagination/search remains outstanding. Backend regression passed 219/219.
The initial 20-run focused browser suite passed, including delayed responses, failures,
older evidence, expanded-history edits/deletions, SSE messages and 20 alternating
team switches. Screenshots were inspected at desktop and mobile sizes. An initial
failure exposed partial task output masking its error; the renderer now prioritizes
the error. The final 10-run feature suite also verifies recent collaboration
recovery, persistence and bounded refresh. Its first run exposed a test setup
that reset the route on every reload; the setup now seeds the route only once
per browser session so reload tests exercise real route persistence.
Evidence is retained in `/tmp/ggb-lazy-evidence` for this session.
The final full browser regression passed 212/212 desktop/mobile runs in 8.3m,
including the updated collaboration history. Lint, typecheck, all 267 source-file
line limits and formatting for all 34 changed files passed. The existing
55-file formatting backlog remains explicitly open. Production build passed.
The local service restarted only after confirming all 11 tasks and 10 jobs
were inactive. UI, health, legacy state and workbench state returned 200;
compact-state 304 and unknown-baseline fallback passed through the production
proxy, as did all/evidence/collaboration timeline reads. Existing tasks and team
metadata were preserved. No remote push or deployment was performed.

Changed-state transport on 2026-10-07: background reads opt into entity deltas
against the exact accepted ETag. The server still authorizes, reads and hashes
fresh public state; a per-workbench cache only retains diff bases, capped at
8 entries, 8 MiB of serialized bodies and 60 seconds. This bounds serialized
cache content, not total process heap. Missing/evicted bases and restarts fall
back to full responses; deltas are only sent when smaller than the full body.
The client preserves unchanged row identity, applies insertions/updates/deletions
and order atomically, and checks the base version and overall state shape.
Malformed or late responses cannot replace the accepted snapshot; explicit
retry remains a full read. The UI proxy forwards negotiation/format headers.
Backup response streaming was extracted to keep the request handler below the
1000-line gate with no route behavior change.

In isolated five-sample runs, 10 teams/200 tasks used a 1,158,429-byte full state
and a 70,936-byte median changed-state body. At 20 teams/800 tasks those sizes
were 3,457,309 and 82,099 bytes. Every merged response was compared against an
independent full read. The corresponding changed-state HTTP medians were 12.27ms
and 44.07ms; full HTTP medians in those runs were 11.26ms and 34.8ms. Diffing adds
compute cost; these are local transport measurements, not mobile UX timings.
Unchanged request bodies remain empty. First load, explicit refresh and full
fallback still transfer all history; server pagination remains outstanding.
Backend regression passed 217/217, plus lint, types, all 262 source-file limits
and formatting for the 16 changed files. The 30-run desktop/mobile focused suite
passed, covering real proxied deltas, isolated teams, retained reading/drafts,
malformed responses, delayed responses and full retry. Initial browser failures
were incorrect test selectors for the existing background-error banner; tests
now use its actual retained-content message and Retry action. The full final
desktop/mobile suite passed 202/202. Production build passed and the local
service restarted after confirming zero active tasks/jobs. UI, API health and
proxied state returned 200; delta-opted unchanged reads returned empty 304s,
and unknown bases returned complete matching state. All 11 local tasks remained
present. No remote changes were made.

Conversation search on 2026-10-07: the header now opens a search dialog scoped to
the current conversation, including turns outside the rendered history window.
Literal case-insensitive matching covers prompts, answers and titles; result
snippets identify the matched field and highlight the term as escaped React text.
Results show newest first in batches of 20 with access to every match. Selecting
a result expands history as needed, anchors and marks the original message, and
returns keyboard focus to the message itself. Drafts remain intact, and switching
team or member session resets search state. Empty, clear, close and no-match
states are included. The mobile dialog uses a top-aligned constrained viewport
and shares the workbench overlay history: system Back closes search while
retaining the current workspace. A reduced-height viewport check covers control
visibility, but does not replace physical-device keyboard testing.
The first browser pass exposed overlapping translation styles on mobile and the
dialog library preferring a child action for return focus; both were corrected.
A full run also exposed reduced desktop reading space when long configured-model
controls combined with the new search action. Compact recruitment guidance now
spans the entire header below its title/actions, preserving the existing >180px
message-area requirement without hiding instructions.
This searches the current in-memory conversation; server-side pagination and
search indexing remain outstanding. The final scoped regression passed 34/34
across desktop/mobile search, long configured-model layouts, history anchoring,
team/member isolation, mobile Back and offline draft recovery. Backend tests
passed 212/212; lint, typecheck, all 258 source-file line limits and formatting
for the 13 changed files passed. An earlier scoped run had a draft API timeout;
the unchanged case passed in the subsequent scoped run. The final full browser
regression passed 192/192 on the complete change. Production build passed; the
local service was restarted only after confirming zero active tasks/jobs. UI,
API health and proxied state returned 200; all 11 local tasks remained present
and an unchanged state request returned an empty 304. No remote was updated.

Conversation history on 2026-10-07: the initial conversation window renders
30 recent turns and exposes an explicit earlier-history control. Scrolling up
pins the window start; loading earlier turns and growing content above the
viewport preserve a task-and-offset reading anchor. Resize observation handles
later layout changes, while programmatic adjustments do not replace the anchor.
Jumping to latest restores the recent window and follow mode. Member session
identity now scopes the history component independently of the team and role.
Unchanged Markdown answers are memoized. Existing-history conversations use a
compact header and mobile composer hints, extending the prior recruitment-only
layout to team/member discussions without hiding file or draft-sync controls.
The scoped 12/12 browser regression covers full expansion of 95 unique turns,
updates above the viewport, new tasks while following, retained drafts, switching
35-turn member sessions, and prior recruitment/history scrolling. The 320px phone
fixture retains more than 180px of message viewport. The first checks exposed
insufficient reading space and automatic scrolling to a clipped load button;
layout was corrected and anchor measurement now starts with the button reachable.
The first full run passed 187/188; the narrow mobile fixture hit the 180px
reading-space boundary. Keeping the compact title and status badge on one line
reclaims the extra row, and a geometric alignment assertion now prevents that
regression. The reading-height assertion waits for layout to settle without
reducing its threshold. The final full desktop/mobile regression passed 188/188.
Backend regression passed 212/212; lint, typecheck and the 255-source-file line
limit check also passed. Formatting passed for all 14 changed files; the
production build and restarted local UI/API smoke checks passed, with no active
tasks or jobs before restart. The proxied state endpoint retained all 11 tasks
and returned an empty 304 for an unchanged snapshot. The existing 55-file
formatting backlog remains. This is client rendering pagination: changed
state responses still include full history, so server-side pagination and history
search remain outstanding.

Conditional state refresh on 2026-10-07: state responses now carry a SHA-256
ETag of the current public JSON. Background requests send If-None-Match; matching
responses return 304 with no body. Authentication still runs first, and no-store
remains in force on both API and UI proxy. The browser retains only its in-memory
snapshot and validator, reuses the confirmed object on 304, and reconciles interim
recruitment updates. Initial reads, manual retries and post-action refreshes are
unconditional; superseded responses cannot replace the snapshot or validator.
Malformed initial 304 responses surface a recoverable error instead of a blank
workbench. Successful background polls no longer toggle the foreground loading
indicator.
Three HTTP tests cover conditional/unconditional reads, authorization, external
writers, deletion and time-based knowledge expiry. Eight scoped desktop/mobile
runs cover the real proxy path, scroll/draft retention, external rename, a late
304 after rename, invalid initial validators and reconciliation of a stale
incremental recruitment phase. Backend regression passed 212/212; full browser regression
passed 184/184. Lint, typecheck, 251 source file line limits and all 16 changed
files' formatting passed. The tracked formatting backlog is now 55 files. Initial new
browser fixtures were corrected to match headings containing status badges and
to use an actually rendered recruitment phase for the incremental-update case.
The 200-task benchmark still returns 1,158,429 bytes for a complete snapshot;
five unchanged conditional requests return zero body bytes in total (headers
excluded). The server still computes/serializes current state to observe external
writes and expiry, and changed snapshots still contain complete history. This
reduces idle transfer and client parsing; it does not yet solve active-session
payload growth or replace the planned conversation-history loading work.
Production build passed. Local services were restarted after checking there were
no active tasks or jobs. Both the direct API and production UI proxy returned
200 for initial reads and 304 with a matching ETag and zero body bytes for
unchanged reads; API health and the UI returned 200. No remote push or deployment
was performed.

State read performance on 2026-10-07: a request-scoped index now reads each
shared task/team collection once and reuses delivery calculations. It is discarded
at the end of each synchronous projection, so writes through another SQLite
connection appear on the next request. Timeline assembly and team validation
were extracted into domain modules; the formatted Store is 919 lines.
On macOS arm64 with Node.js 26.8.1, an isolated 10-team/200-task benchmark reduced
state-generation median from
698.81ms to 4.68ms and local HTTP median from 713.4ms to 10.41ms. Artifact scans
fell from 811 to 1, with the same 1,158,429-byte response size. A 20-team/800-task
run measured 18.09ms generation and 30.35ms HTTP. These are local five-sample
medians, not browser interaction or remote-network latency guarantees.
Serialized state and timeline pagination matched the pre-change response exactly
on the same 72-task database. Three new tests cover constant collection-read
counts as history grows, external-connection writes/deletes, acceptance invalidation,
team isolation and equal-timestamp pagination. Backend regression passed 209/209.
All 13 changed files pass formatting; the tracked-file backlog decreased from
62 to 56 files after formatting the edited source and documentation.
The first full browser run passed 174/176. Both failures overlapped macOS sleep
intervals confirmed in power logs (11-minute trace gaps); traces were retained.
A fresh full run with a process-scoped idle-sleep assertion passed 176/176 with
unchanged tests. The previously failing cases passed in 4.8s and 3.7s. The
20-cycle switching scenario took 5.0s on desktop and 10.6s on mobile; the previous
full mobile run took 46.0s. Browser timings describe whole fixture scenarios,
not individual clicks or model response latency.
Full-state payload growth and browser rendering still need separate measurement;
no history was truncated to achieve this improvement.
Lint, typecheck, all 247 hand-written source file line limits, changed-file
formatting and production build passed. Local services were restarted after
confirming 11 tasks and 10 jobs had no active execution; API health, UI and
proxied state requests returned HTTP 200. No remote push or deployment occurred.

Conversation context on 2026-10-07: new team-member tasks now inherit the team's
project directory. Existing member sessions keep their original directory; PM
messages create a new session after the team's directory changes. Composer
directory labels follow the same rule and open the corresponding team's settings.
Runtime fixtures read marker files from two different projects and verify that
isolated execution copies the correct source without rewriting history.
Recruitment with existing messages uses an expandable context summary; phone
composers remove duplicate hints while preserving file controls and sync state.
The scoped 6/6 browser run checks directories, refresh, historical member sessions,
more than 180px of reading space, disclosure toggles and live-update scroll
retention at 1280×720 and 393×851. Backend regression passed 206/206.
The PM session rule was extracted from the request handler so both edited server
files can pass formatting while remaining under 1000 lines; the backend suite
passed 206/206 again after extraction. All 14 changed source files pass formatting.
The tracked-file formatting backlog decreased from 64 to 62 files.
The initial browser run passed 175/176; the 20-cycle mobile switching scenario
reached its 45-second aggregate limit during the final model refresh after 19
successful sends. Its dedicated budget is now 90 seconds, retaining every model,
message, draft and reload assertion. A 6/6 focused rerun passed including all 20
cycles. This budget correction is not a claim that heavy-state performance is fixed.
The subsequent full regression passed 176/176; its mobile stress scenario
completed all assertions in 46.0 seconds.
Production build and local API/UI health checks passed. The actual 1280×720
production page has a 140px recruitment header and 211px message reading area;
the directory button opens that team's settings with the correct project path.
The local services were restarted only after confirming no active tasks/jobs.
No remote push or deployment was performed.

Composer usability on 2026-10-07: model selection and the send action now occupy
separate grid columns with a fixed 44px send target. Probe status sits below the
controls; failed probes expose details on demand without an overlay. Obsolete
competing desktop/mobile rules were consolidated in one stylesheet. Ten focused
browser runs passed across 320/390/1024/1280/1440px, checking containment, pointer
hit targets, model persistence and outgoing model parameters after switching.
The submission check intercepts the request and verifies draft retention after a
503 without invoking a paid provider. Changed source formatting, typecheck, Lint
and the 1000-line gate pass. The tracked-file formatting audit still reports 64
files requiring cleanup; the global formatting gate is not yet satisfied.
The full browser regression passed 170/170, alongside the 204/204 backend
baseline established by the recruitment identity change.
A subsequent 10/10 scoped run explicitly supplied a long visible directory in
the state snapshot. Production build and local API/UI health checks passed;
the actual 3088 page shows recruitment identity, readable draft names and the
unclipped model/send controls. No remote push or deployment was performed.

Recruitment identity on 2026-10-07: new data directories seed a single discovery
draft with only the project manager, rather than a pre-confirmed default team.
Existing confirmed teams retain their identity and members. Startup and cached
conversation routes follow the actual recruitment phase, while management views
remain independent; archived spaces cannot become fallback conversations.
Cross-device confirmation updates the page identity without dropping composer
drafts, and empty workspaces require an explicit action to create a new draft.
Choice controls display names instead of raw internal IDs. Backend tests verify
first-run delegation denial, restart idempotence and preservation of existing
confirmed teams. Established-team tests now explicitly seed a confirmed fixture.
Validation passed 204/204 backend tests and 160/160 desktop/mobile browser runs.

Startup recovery on 2026-10-07: the workbench now waits for the first valid
snapshot before exposing team and recruitment actions. Connection failures and
15-second timeouts provide a retry screen; later failures preserve the existing
workspace and drafts with a freshness notice. Polls share an in-flight read,
while explicit refreshes supersede older requests. The focused desktop/mobile
suite passed 32/32, covering slow startup, cached team recovery, timeout/retry,
offline draft retention and stale success/error responses after a real rename.
Recruitment helpers no longer rely on fixed startup/navigation delays. Loading
and retry layouts were visually checked, including a 320px mobile viewport.
The final full regression passed 202/202 backend tests and 146/146 browser runs;
typecheck, lint, file-size checks and production build also passed.

Agent plan maintenance on 2026-10-07: confirmed team members can read a live
plan through MCP; only the active team's project manager can upsert a milestone
with the latest revision and a reason. Completion requires nonempty task links
with current-version owner acceptance. Protected settings, foreign links,
paused plans and revoked actors are rejected, and failed writes roll back both
plan and audit. Runtime context contains a bounded starting plan snapshot and
now correctly scopes checkpoint/board records even without a job ID. The UI
prompts to load new plan revisions, preserves edits and shows the last project
manager update. The focused desktop/mobile suite passed 10/10 with a real HTTP
MCP client, owner acceptance through the execution inspector and persisted UI
state. This is deterministic orchestration evidence, not a real-model quality
claim. Mobile navigation regression helpers now wait for the closing drawer
state instead of adding 350 ms to every switch, and archive tests wait for the
confirmed result before opening the drawer. The focused navigation suite passed
10/10 without increasing timeouts or reducing the 20-switch assertions. The
subsequent full regression passed 202/202 backend tests and 134/134 browser runs.

Milestone-to-delivery workflow on 2026-10-07: milestones now link to up to 40
existing tasks in their own team. The browser separates manual phase progress
from current task acceptance, opens the execution inspector for evidence and
owner decisions, and updates acceptance counts after requirements change.
Failed saves retain goal, milestone, boundary and task-selection edits; stale
revision conflicts require reloading and reviewing before another save. HTTP
tests reject foreign/missing/malformed links without partial writes, while
browser scenarios use real task evidence and acceptance endpoints. Mobile
linked-task cards are checked at 320px with no horizontal overflow. The full
local regression passed 196/196 backend tests and 132/132 desktop/mobile runs.

Cross-team overview recovery on 2026-10-07: risk inbox and unified timeline
share scoped, abortable pagination. Changing filters immediately hides old cards;
late success and failure responses cannot replace the selected team's results.
Initial read failures show an unknown state with retry, same-filter refresh
failures retain the last successful page with a freshness warning, and failed
pagination retries the original cursor without duplicating cards. The focused
desktop/mobile suite passed 30/30, including attention resolution and existing
team timeline/navigation scenarios. The full desktop/mobile suite then passed
126/126; recovery layout checks cover 320px and 393px mobile widths, no
horizontal overflow and a retry target of at least 44px height.

Mobile metrics refinement on 2026-10-07: the scoped desktop/mobile metrics
suite passed 14/14, including advanced-filter retention, individual removal,
reset, delayed responses and refresh recovery. Layout checks cover 320px and
393px mobile widths and 1280px desktop, with at least 44px select targets and
no page overflow. On the local production build at 393px, the combined filter
and summary content height decreased from 879px to 430px. Typecheck, lint,
format checks for changed code, file-size checks and production build passed.
The subsequent full 126-run browser regression includes this mobile refinement,
the ordinary attention-resolution workflow and cross-team overview recovery.

Latest full local regression on 2026-10-08: `npm test` 264/264 and Playwright
desktop/mobile baseline 260/260 passed on macOS. `npm run lint`,
`npm run typecheck`, `npm run quality:lines`, `npm run build` and
`git diff --check` also passed. The model metrics regression includes task-type
runtime comparisons, alias filtering, delayed response isolation, retry and
background refresh failure recovery. Attention-resolution tests cover taskless
items, linked notification updates, idempotence, validation, transaction rollback
and separation from task retry and acceptance. Desktop/mobile browser tests
verify risk-list refresh, notification read state and persisted resolution notes.
The UI and API smoke endpoints returned
200 and `{"ok":true}` respectively. This is local evidence only; the real Linux,
Windows/WSL2, HTTPS and owner-offline gates below remain open.

Validated on 2026-09-27 using macOS, Node.js 26.8.1 and DSH 0.1.2-rc.1.
The current production service runs at `http://127.0.0.1:3088/`, with the API at
`http://127.0.0.1:3089`. The previous service had no active tasks at upgrade time.

The pre-upgrade backup is:
`~/.dsh-workbench/backups/2026-09-09T19-25-46-717Z-phase-2-upgrade-4f82e80f.sqlite`.
Both the backup and upgraded database passed `PRAGMA integrity_check`.
All rows of roles (3), knowledge (1), settings (1), sessions (0) and tasks (0)
retained their original SHA-256 table hashes. Schema version is now 1.

No paid provider was called during the test suite. Native adapter tests use a
deterministic HTTP model; the combined scenario uses a deterministic executor
and real workbench services. This verifies orchestration behavior, not the
quality of a production model's reasoning.

The current deterministic suite contains 264 passing tests. The latest
full Playwright baseline passed 260 desktop/mobile runs covering team
recruitment navigation, the recruitment cursor sync status, the unified team timeline filters and pagination, the cross-team unified timeline, the cross-team risk inbox, batch delivery review, local and server-backed
draft restoration, team-scoped draft isolation, multi-device draft auto-merge and explicit conflict choice, team template copying with history/task isolation, utility-view route restoration,
binary drag-and-drop attachments, conversation scroll recovery, evidence quality summaries, Team Charter confirmation and high-risk
capability binding review, team renaming, team
settings editing, two-team context switching, cross-team model selection,
provider probe status feedback, sustained 20-switch isolation and failed-task
recovery against the real API, including the mobile bottom navigation and
explicit mobile drawer close action, plus execution-node pairing onboarding with
cross-platform worker commands, offline/restored node connection events, task-event SSE streams and team-activity SSE streams. Team
tasks now default to isolated execution
directories, and task details expose the selected model, routing candidates and
fallback events when they exist. A local API fixture also alternates between
two teams for 20 messages and checks task, message, model and route ownership.
The confirmation fixture exercises the deterministic approval boundary. A live
loopback probe on
2026-09-27 used the unlocked encrypted vault and sent minimal `Reply with OK.`
requests to each configured provider, with one additional configured model
checked for the two failures. GPT `gpt-5.6` and DeepSeek `deepseek-flash`
returned valid text responses; Gemini returned upstream HTTP 405 and Kimi
returned upstream HTTP 503 across their tested models. These results are
connectivity evidence only, not a model-quality score; the saved health state
now informs automatic routing while explicit model choices remain available. A
second real task explicitly selected the Gemini candidate, received the
upstream 405, recorded a `routing/fallback` event, and completed through
DeepSeek with the result `OK`; the original failed attempt remains preserved
for audit. `ggb doctor --node-config <path> --strict --json` now validates a
portable node configuration (HTTPS or local loopback control URL, existing
workspace mappings and a writable node data directory) without exposing node
identity or token fields. Broader multi-turn model quality and cross-platform environment
gates remain open.

## Remaining Compatibility And Release Gates

- Authenticated Skills.sh and Smithery source adapters remain optional follow-up work.
- External stdio MCP servers run on the control plane. Worker-local stdio MCP
  placement is not implemented in this release.
- MCP Resources/Prompts, LSP, platform-specific interfaces, native fork-command
  behavior, host shell preprocessing and unsupported Hooks stay explicitly unsupported.
- Skill/plugin execution is trusted code with an explicit compatibility report;
  third-party read-only annotations are not a security boundary.
- Database backup includes the encrypted vault companion when present. Project
  code, worktrees and installed capability files require separate file backups.
- Production dependency audit reports zero known entries. Seven development-only
  Cloudflare-toolchain entries and the bundled build-time image-parser limitation
  are documented in `docs/dependency-security.md`.
- Follow `deploy/README.md`, `deploy/backup-restore.md` and
  `deploy/PLUGIN-COMPATIBILITY.md` for deployment and compatibility details.
- Do not mark the overall cloud/platform acceptance complete until the real
  Linux, Windows/WSL2, HTTPS and offline-owner scenarios have been exercised.

## Operational invariants

Only one control plane owns a database. A role ID identifies an assistant; a task
ID identifies an execution attempt. Stop acknowledgement follows process exit.
Expired instances cannot publish current results. Unknown external-operation
results need reconciliation, never blind retries. Incoming messages do not grant
permissions. Secrets are encrypted separately from public configuration. Runtime
snapshots pin all provider and capability settings. A checkpoint resumes through
a new instance rather than pretending to restore the native DSH session.
