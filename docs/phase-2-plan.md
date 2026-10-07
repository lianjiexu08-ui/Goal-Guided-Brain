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

- [x] Existing regression suite plus new deterministic integration tests: 212/212, no skips.
- [x] Lint, typecheck and production build.
- [x] Browser workflows at desktop and mobile sizes, including real backend forms.
- [x] Cross-platform CI matrix runs lint, typecheck, backend/CLI tests, `ggb doctor` and production build on Ubuntu, macOS and Windows with Node.js 22/24; Ubuntu also runs the desktop/mobile browser baseline.
- [x] Combined parent/frontend/backend/reviewer scenario using real orchestration MCP,
      a local external MCP, pinned Skill, isolated Git worktrees, peer messages,
      checkpoints, pause/change-provider/resume, automatic summary and a tested integration.
- [x] Original local data upgraded and checked against pre-upgrade table hashes.
- [ ] Linux worker integration on a real Linux execution environment.
- [ ] Windows/WSL2 worker integration on a real Windows execution environment.
- [ ] Real cloud deployment and HTTPS pairing (requires configured infrastructure).
- [ ] Real cloud continues scheduled work while the owner's computer is offline.

## Local Release Record

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

Latest full local regression on 2026-10-07: `npm test` 212/212 and Playwright
desktop/mobile baseline 188/188 passed on macOS. `npm run lint`,
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

The current deterministic suite contains 212 passing tests. The latest
full Playwright baseline passed 188 desktop/mobile runs covering team
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
