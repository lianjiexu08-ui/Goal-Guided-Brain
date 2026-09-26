# DSH phase 2 implementation

## Accepted scope

Single-owner cloud control plane, optional local-only mode, macOS/Linux workers,
Windows workers through WSL2, multi-provider DSH runs, durable agent mailboxes,
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

| Batch | Delivered behavior | Evidence |
| --- | --- | --- |
| P0 | Versioned transactional migration, pre-upgrade consistent backup, modular views | Migration success/failure, WAL and historical-record tests |
| P1 | Four provider protocols, real capability probes, ordered routing and failure fallback, encrypted vault, resources | Native DSH calls against three deterministic wire protocols; API and credential boundary tests |
| P2 | Environment-bootstrapped owner auth, outbound workers, pairing/revocation, durable claims, leases and result ACK | Real loopback HTTP worker and authenticated MCP tests; lost lease and late-result rejection |
| P3 | Logical jobs and attempts, parent/peer messages, mailbox IDs, versions, checkpoints, board and operation grants | Persistent inbox, duplicate delivery, requirement ACK, descendant permissions, pause/resume tests |
| P4 | Managed worktrees, no-HEAD snapshots, reserved ports, commits, integration, verification evidence and knowledge history | Large/unusual diffs, source preservation, conflict retention, budget and composite scenario tests |
| P5 | SkillsMP, ClawHub, official MCP Registry, custom repos; skills, MCP tools, plugin commands/templates and supported sync Hooks | Live read-only search of all three markets; local plugin fixtures and real MCP tool gateway tests |
| P6 | Explicit timezone, interval and Cron preview, misfire policies, no overlap, deduped notifications/Webhook, usage and offline restore | Injected-clock DST/cadence tests; replacement-attempt scheduling, notification retry, encrypted restore and rollback tests |

## Validation

- [x] Existing regression suite plus new deterministic integration tests: 134/134, no skips.
- [x] Lint, typecheck and production build.
- [x] Browser workflows at desktop and mobile sizes, including real backend forms.
- [x] Combined parent/frontend/backend/reviewer scenario using real orchestration MCP,
  a local external MCP, pinned Skill, isolated Git worktrees, peer messages,
  checkpoints, pause/change-provider/resume, automatic summary and a tested integration.
- [x] Original local data upgraded and checked against pre-upgrade table hashes.
- [ ] Linux worker integration on a real Linux execution environment.
- [ ] Windows/WSL2 worker integration on a real Windows execution environment.
- [ ] Real cloud deployment and HTTPS pairing (requires configured infrastructure).
- [ ] Real cloud continues scheduled work while the owner's computer is offline.

## Local Release Record

Validated on 2026-09-10 using macOS, Node.js 26.8.1 and DSH 0.1.2-rc.1.
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

The current deterministic suite contains 134 passing tests. The repeatable
Playwright baseline contains twelve passing desktop/mobile runs covering team
recruitment navigation, draft restoration across views, binary drag-and-drop
attachments, Team Charter confirmation, team renaming, two-team context
switching, cross-team model selection and failed-task recovery against the
real API. Team tasks now default to isolated execution directories, and task
details expose the selected model, routing candidates and fallback events when
they exist. The confirmation fixture exercises the deterministic approval
boundary; multi-turn model quality, sustained 20-switch isolation, real
provider fallback quality and cross-platform environment gates remain open.

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
