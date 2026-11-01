# Agent Change Gate

> **Same agent. Same command. Different verdict.** Agent Change Gate reads what a Jira issue is *connected to*
> (a release shipping this week, open work it blocks, a company goal, an open pull request, a production deployment)
> before an AI agent is allowed to change it, and pulls in a human only when that context says it matters.

A Forge app for Jira that gives Rovo agents and external MCP clients write tools backed by a
**deterministic, context-aware policy gate**. Context comes from the issue itself (fix versions, priority, "blocks"
links) and from **Teamwork Graph** (linked goals, pull requests and deployments, read as the requesting user).
Around that sit project allowlists, per-call / per-hour / per-day caps, protected fields and statuses,
and human approval (two-person rule, single-use, expiring) for bulk or destructive changes.
Dispatches have an audit intent recorded before Jira is called, followed by their outcome.
The gate covers this app's tools; it cannot constrain other Jira tools or direct REST calls.

**Status:** deployed to the Forge **production** environment (v2.1.0, the version the install link below installs)
and to a development environment installed on a free Jira Cloud test site. On that live site the approval page, policy
editor, audit log, kill switch and the *Simulate an agent request* panel were exercised against real issues, including
the "same command, different context" pair in the demo video (`SHIP-1` allowed and written, `SHIP-2` held for approval
because its fix version ships within the week). The Rovo agent was run in a **real Rovo conversation** on a Forge demo
site (Rovo's model picked the app's tools, which read live Jira and Teamwork Graph context; see
[`docs/ROVO_CHAT_RUN.md`](docs/ROVO_CHAT_RUN.md)). The MCP server has not been run from an external MCP client: see
[Rovo integration](#rovo-integration-and-what-was-verified). Production v2.1.0 was built before the **Guided demo**
and the Rovo hand-off buttons (*Ask Change Gate Agent*, *Run it from Rovo chat*); those are in the development build
until production is redeployed. See `STATUS.md` for the review and the verification checklist.

**Demo video (2:33):** VIDEO_URL_PLACEHOLDER (YouTube; link added when the video is published)

**Install for judges:** [install Agent Change Gate on your Jira Cloud site](https://developer.atlassian.com/console/install/67a2afa4-d23d-4d5b-a9b7-1cf01c63defe?signature=AYABeMOYy2xGI9qOFPG1%2BVhSM6gAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBFvKkfMY5YAWNYqJd8hgr6QAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDJI50drpOZ9v9bcP7wIBEIA7NxXzVOZtJ97Xc86ozCnJZ0jhht3hQ6ltI205vzvhH3xgC2m%2FWatp1YrohFSMezy32gCyGAZq7WtgFtQAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgGditovz04wvrAW6eo87HjoAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMpe9xflk2THfCH94aAgEQgDul26V%2BCSFHrVjcEaGfp9%2BlM5pkgYpAOtUTwYzE2nkjPhyQY9c7LTJSHD8U6%2FtohB5cQCecWp%2FIGrDkDgAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEARLKhYeL0kJmRgzJY9zYmwMAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAwq9n58xSBUNDYXIz8CARCAOx4DWJO0gIHc87DK6ykxOVmRLdEcOlJWUTrJAlBSd3Xq0kQOMqbAuCNbzfBK2Qu%2B8vaZLrmd0CUpbHRYAgAAAAAMAAAQAAAAAAAAAAAAAAAAADSCxVSkn2dDvIV2dK36H7L%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADIPweEaJXk%2B4Sjej3OdKV3kB8%2FPFWQ0r8QJC7tP1V8EBfCvTdpG67tAk58h6kHGoi6W9DcXXkDuVbvc7sE3SjvwiNI%3D&product=jira)
(Forge distribution link, production environment; an org admin must accept the scopes because Teamwork Graph scopes
are organisation-wide. Then follow [Try it in 5 minutes](#try-it-in-5-minutes-judges).)

Built for Codegeist 2026: category **Apps for Software Teams**, bonus **Best Agents (Rovo)**. The app also ships a
`rovo:mcp` server and reads Teamwork Graph. Submission text: [`docs/DEVPOST.md`](docs/DEVPOST.md). Design: `DESIGN.md`.

## Try it in 5 minutes (judges)

Open Jira → Apps → **Agent Change Gate** as a Jira admin (the person who installed the app is one).

1. **No setup, no Rovo, no Jira writes: Guided demo.** Approvals tab → *Guided demo* card (a "New here?" banner points
   to it on a fresh install). Click the five steps in order:
   1. *Routine change*: move `DEMO-1` (no release, no links) to In Progress → **ALLOW**, runs at once.
   2. *Same command, risky context*: the identical move on `DEMO-2`, whose fix version ships in 3 days and which is
      linked to a company goal → **NEEDS APPROVAL** with `CONTEXT_RELEASE_SOON` and `CONTEXT_LINKED_GOAL`.
   3. *Review as the approver*: see what an approver sees (count-only context) → **Approve**.
   4. *Run the approved change once* → **EXECUTED** (dry run); *Try to run it again* → **REFUSED** (single-use).
   5. *Runaway bulk close* of 21 issues → **DENY** (`TOO_MANY_TARGETS`) before any issue is read.

   The card's *Demo audit trail* lists every step. The demo runs the real gate code (policy, context check, approval,
   execution, caps, audit) on two sample issues in its own per-user storage, so your policy, caps, approvals and
   audit log are not touched, and the two-person rule is off only inside the demo. *Reset demo* starts over; demo data
   expires after 24 hours.
2. **On your own issues.** Policy tab → add your project key to `allowedProjects` → **Save policy**. Testing alone?
   Also set `"requireDistinctApprover": false` (set it back afterwards). Then use *Simulate an agent request* with an
   issue key; [Testing with and without Rovo](#testing-with-and-without-rovo) shows how to reproduce the video's
   release-context pair on your own site.
3. **With Rovo** (Rovo-enabled sites only): Rovo chat → **Change Gate Agent** → *"What could go wrong if you move
   KAN-2?"*, *"Move KAN-1 to In Progress"*, *"Close these 25 issues"*.

## Context-aware gating (Jira + Teamwork Graph)

For transitions, edits, assignments and deletions, the gate reads each target's context in the same pass that
resolves it, and each signal can only **raise** the verdict (policy `contextRisk.signals`: `off` / `approve` / `deny`):

| Signal | Reason code | Source |
|---|---|---|
| Unreleased fix version due within `releaseWindowDays` (default 7) or overdue | `CONTEXT_RELEASE_SOON` | Jira issue fields |
| Blocks issues that are not done | `CONTEXT_BLOCKS_OPEN_WORK` | Jira issue links |
| Priority in `highPriorities` (default Highest) | `CONTEXT_HIGH_PRIORITY` | Jira issue fields |
| Linked to an active goal | `CONTEXT_LINKED_GOAL` | Teamwork Graph `jiraWorkItemGoals` |
| Has an open pull request | `CONTEXT_OPEN_PULL_REQUEST` | Teamwork Graph `jiraWorkItemLinkedExternalPullRequests` |
| Part of a production deployment | `CONTEXT_PRODUCTION_DEPLOYMENT` | Teamwork Graph `jiraWorkItemLinkedExternalDeployments` |

- Teamwork Graph is called with `asUser().requestTeamworkGraph()` (Forge **Preview** API since 2026-10-15), using
  curated queries only, one batched request per family. Results are permission-filtered for the requesting user.
- Approvers see count-only texts ("linked to 1 active goal"); goal, PR, deployment and blocked-issue names are returned
  only to the requesting user, whose permissions were used to read them.
- An approval covers the context the approver saw: at run time the gate re-reads context, and any new
  issue + signal pair (for example a second target that joined a release) is a `NEW_RISK` refusal, and so is a
  context outage at run time unless the approver approved exactly that (fail closed).
- Graph errors or more than 25 linked items are reported as gaps; `onGraphUnavailable: "approve"` turns them into a
  human check (default `ignore`: Jira context still applies). Missing Jira facts always need a human.
- New read-only tool **`acg-issue-context`** ("What could go wrong if you move this issue?") shows what the gate sees.
- On a site with nothing connected to Teamwork Graph (e.g. a fresh free dev site) the graph simply returns no links;
  the Jira signals still work, and the dashboard shows whether Teamwork Graph is connected.

## What's inside

- `rovo:agent` **Change Gate Agent**, `rovo:skill` **agent-change-gate**, `rovo:mcp` **Agent Change Gate** (same 11 tools)
- Tools: comment, transition, assign, edit (summary/priority/due date/labels), create, delete (approval only),
  run-approved-change, approval-status, my-activity, policy-summary, issue-context (read-only). The six change-request tools support `preview: true`;
  run-approved-change executes an approved request.
- Jira global page **Agent Change Gate**: approvals, audit log, policy JSON editor, kill switch, an admin-only
  **Guided demo** (sample issues, isolated storage) and an admin-only **Simulate an agent request** panel (see below).
- Forge KVS storage only, no external egress. Teamwork Graph scopes are read-only, per object type
  (`read:graph:issue:jira`, `read:graph:goal:atlassian`, `read:graph:pull-request:external`,
  `read:graph:deployment:external`).

## Testing with and without Rovo

The app installs on any Jira Cloud site. Rovo modules (`rovo:agent`, `rovo:skill`, `rovo:mcp`) only light up where
Rovo is enabled; on other sites installation still succeeds and only the Rovo-specific features are missing
([Atlassian developer community answer](https://community.developer.atlassian.com/t/what-happens-if-a-user-doesnt-use-rovo-tries-to-install-an-marketplace-app-which-use-rovo-agent/86768)).
The approval page, policy, audit log and the simulation panel do not depend on Rovo.

**Setup (both cases):** Jira → Apps → **Agent Change Gate** → **Policy**. Add your project key to `allowedProjects`
(the default policy allows nothing) and save. Doing this as a Jira admin is required for the simulation panel.

**Judges evaluating alone:** the default policy has `"requireDistinctApprover": true` (two-person rule), so the admin
who simulates a request cannot approve it. To try the full approve-and-run flow by yourself, open **Policy**, change
`"requireDistinctApprover": true` to `false` in the Policy JSON editor and click **Save policy** (set it back to `true`
afterwards). Approvals decided before that change are invalidated, by design. Our own demo site keeps it at `false`
so a one-person recording can show the whole flow.

**Reproduce the demo's context pair on your site:** create a version due within 7 days (Project settings → Releases),
put one issue (say `KAN-2`) in that version and leave another (`KAN-1`) without one. In the simulation panel enter
`KAN-1` and click **Move to In Progress** (ALLOW, written to Jira), then enter `KAN-2` and click the same button
(NEEDS APPROVAL, `CONTEXT_RELEASE_SOON`). With no key, the second context button shows the same contrast as a dry run.

**Without Rovo — Simulate an agent request (Jira admins only):** Approvals tab → *Simulate an agent request*.
Each preset is a raw action input, exactly what the Rovo agent would send, and it goes through the same
`GateService.guardedChange` path: policy evaluation, caps, two-person approval, audit. Nothing is faked; the gate
decides the verdict from the current policy.

| Preset | Request | Verdict under the default policy |
|---|---|---|
| Low-risk comment | comment on one issue | ALLOW: runs at once |
| Move to protected status | transition one issue into the first protected status (Done) | NEEDS APPROVAL (`PROTECTED_STATUS`) |
| Runaway bulk close | transition `maxTargetsPerCall + 1` issues | DENY (`TOO_MANY_TARGETS`), before any issue is read |
| Move to In Progress | transition one issue with no links | ALLOW |
| Same move, issue ships this week | the identical transition; in a dry run the synthetic issue is in a release due in 3 days and linked to a goal | NEEDS APPROVAL (`CONTEXT_RELEASE_SOON`, `CONTEXT_LINKED_GOAL`) |

- Leave **Issue key** empty for a **dry run**: the request uses synthetic issues (`<first allowed project>-9001…`)
  and a stand-in Jira client, so no issue is read or written (only the admin permission check calls Jira). Enter a real key (e.g. `KAN-1`) for a **live** run:
  an allowed or approved change really writes to that issue (the approval preset needs the issue's workflow to
  have a transition into Done).
- Simulated entries show **Source: Simulated (dry run / live)** in the audit log and a *Simulated* tag in the
  approvals table. They count toward the caps like agent writes, so caps can be demonstrated too.
- Approvals keep the two-person rule: someone other than the admin who simulated must approve. For a one-person
  demo, set `"requireDistinctApprover": false` in the policy first (approvals decided before that change are
  invalidated, by design). After approval, **Run approved change** in the panel's table executes it once; a dry-run
  request can never write to Jira, whichever entry point runs it. Non-admins cannot simulate or run simulated
  requests, from the page or through `run-approved-change`.

**With Rovo:** open Rovo chat → pick **Change Gate Agent** → e.g. *"What could go wrong if you move KAN-2?"*
(issue-context), *"Move KAN-1 to In Progress"* (runs) vs *"Move KAN-2 to In Progress"* where KAN-2 has a fix version
due this week (PENDING_APPROVAL with `CONTEXT_RELEASE_SOON`), *"Comment 'ready for review' on KAN-1"* (runs),
*"Move KAN-1 to Done"* (returns PENDING_APPROVAL; approve it on the page, then ask the agent to run the approved
change), *"Close these 25 issues"* (denied). Audit entries show **Source: Agent**.

## Rovo integration and what was verified

How the app plugs into Rovo (all declared in `manifest.yml`, deployed with the app):

- **`rovo:agent` "Change Gate Agent"**: a Forge Rovo agent whose prompt (`prompts/`) tells it to make every Jira change
  through the app's guarded actions, never to claim a change unless the action returned `EXECUTED`, and to explain
  `CONTEXT_` reasons (what the issue is connected to) when a change needs a human.
- **`action` modules** (11 tools: comment, transition, assign, edit, create, delete, run-approved-change,
  approval-status, my-activity, policy-summary, issue-context). Each action is a Forge function that calls the same
  `GateService` the Jira page and simulator use; the requester's identity comes from the Forge invocation context
  (`context.principal.accountId`), never from the LLM-written payload.
- **`rovo:skill`** packages the same tools for other Rovo agents, and **`rovo:mcp`** exposes them to external MCP
  clients through Atlassian's remote MCP endpoint.

- **Page ↔ chat hand-off:** when Rovo is enabled, the approval page shows **Ask Change Gate Agent**, and a requester
  looking at their approved request gets **Run it from Rovo chat** (Forge bridge `rovo.open`, pre-filled prompt).
  In the other direction, `PENDING_APPROVAL` and `approval-status` results carry `approvalPage` (a link to this app's
  Jira page, built from the Forge app context) and `approval-status` adds a plain-language `nextStep`.
- Rovo asks the user to **Confirm** write actions before they run (UPDATE/CREATE/DELETE verbs). That is Rovo's
  check, not the gate's approval: the gate still decides after Confirm.

What was verified: the actions' code paths are covered by the unit/flow tests, the manifest passes `forge lint`, and
the modules deploy. **Rovo chat (2026-10-31):** on a Forge demo site (`forge site provision`, Enterprise + Rovo) the
agent is registered with all 11 actions; in a real Rovo conversation it called *Show agent change policy* and *Check
issue context* (live result: `MOBL-12 blocks 5 open issues`, sources Jira + Teamwork Graph) and planned *Guarded -
transition issues* with the right input, which Rovo held for the user's Confirm click. Transcript and limits:
[`docs/ROVO_CHAT_RUN.md`](docs/ROVO_CHAT_RUN.md). Not verified from chat: the Confirm click itself and the
approve-in-page → run-from-chat round trip (both need a person in the browser), and an external MCP client. Rovo chat
is not available on free developer sites; use a Forge demo site (`forge site provision`) to try it.

## Default policy

Nothing allowed until an admin adds projects. Comments/transitions/edits/assign/create allowed in allowed projects;
delete always needs approval; >5 issues per call needs approval, >20 is denied; priority/fixVersions/security/duedate
and moves into Done/Closed/Won't Do need approval; 30 attempted targets/user/UTC clock hour,
100/user/calendar day, 500/site/calendar day (policy timezone). Attempts are reserved before execution and
are not refunded on failure or a lost response. Hourly limits are fixed buckets, not rolling windows.

Concurrent mutations return `REFUSED` / `BUSY`. Mutations take one installation-wide storage lease
(`FAIL_IF_EXISTS` on a per-2-minute bucket key, plus a neighbour-bucket check) so parallel calls cannot race usage,
human decisions, or policy updates. A crashed invocation blocks mutations for at most about two minutes.
See `STATUS.md` for the operational limits of this approach.

## For developers

### Run the tests (no Atlassian account needed)

```bash
node --version   # tests require Node >= 22; the Forge CLI may require a newer patch
npm ci
node --test test/*.test.js        # 185 tests, no Atlassian account or network needed
# optional: validate manifest.yml against the schema bundled with a local Forge CLI checkout
# (npm i -g @forge/cli, then point FORGE_CLI_DIR at its install directory)
FORGE_CLI_DIR=<path-to-@forge/cli> node scripts/validate-manifest.cjs
```

### Deploy (needs an Atlassian account; Rovo is optional, see above)

```bash
npm install
export FORGE_EMAIL=... FORGE_API_TOKEN=...   # scoped API token, app "Forge"
forge register            # writes the real app.id into manifest.yml
forge lint
forge deploy
forge install --site <your-site>.atlassian.net --product jira
```

Then in Jira → Apps → **Agent Change Gate** → Policy, add your project key to `allowedProjects` (the default policy
allows nothing). Open Rovo chat → pick **Change Gate Agent**.

External MCP client: admin enables the app's tools in admin.atlassian.com → Apps → Sites → *site* → Connected apps,
then add `https://mcp.atlassian.com/forge/<appId>` as a remote MCP server and use `skills/agent-change-gate/SKILL.md`.

## Built with

Forge (UI Kit, KVS, Rovo modules), Jira REST v3, Node.js `node:test`. Libraries: `@forge/api`, `@forge/bridge`,
`@forge/kvs`, `@forge/react`, `@forge/resolver`, `react` 18. Developed with AI coding assistance;
local unit and flow tests cover the gate and adapters; the Forge runtime (UI, resolvers, Jira and Teamwork Graph
reads) was exercised on the live development site, and the Rovo agent in a Rovo conversation on a demo site (see above).

MIT licence.
