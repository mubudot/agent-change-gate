# Agent Change Gate

A Forge app for Jira that gives Rovo agents and external MCP clients write tools backed by a
**deterministic policy gate**: project allowlists, per-call / per-hour / per-day caps, protected fields and statuses,
and human approval (two-person rule, single-use, expiring) for bulk or destructive changes.
Dispatches have an audit intent recorded before Jira is called, followed by their outcome.
The gate covers this app's tools; it cannot constrain other Jira tools or direct REST calls.

**Status:** deployed to a Forge development environment and installed on a Jira Cloud test site. The approval page,
policy editor, audit log, kill switch and the *Simulate an agent request* panel were exercised on that live site
(the demo video is recorded there). The Rovo agent and MCP tools are deployed with the app but have not yet been run
from a Rovo chat or an external MCP client on a live site. See `STATUS.md` for the review and the verification checklist.

**Demo video (2:58):** VIDEO_URL_PLACEHOLDER (YouTube; link added when the video is published)

**Install for judges:** INSTALL_LINK_PLACEHOLDER (Forge "Start sharing your app" link; then follow
[Testing with and without Rovo](#testing-with-and-without-rovo))

Built for Codegeist 2026 (Apps for Software Teams; bonus: Rovo Agents, Atlassian MCP). See `DESIGN.md`.

## What's inside

- `rovo:agent` **Change Gate Agent**, `rovo:skill` **agent-change-gate**, `rovo:mcp` **Agent Change Gate** (same 10 tools)
- Tools: comment, transition, assign, edit (summary/priority/due date/labels), create, delete (approval only),
  run-approved-change, approval-status, my-activity, policy-summary. The six change-request tools support `preview: true`;
  run-approved-change executes an approved request.
- Jira global page **Agent Change Gate**: approvals, audit log, policy JSON editor, kill switch, and an admin-only
  **Simulate an agent request** panel (see below).
- Forge KVS storage only, no external egress.

## Run the tests (no Atlassian account needed)

```bash
node --version   # tests require Node >= 22; the Forge CLI may require a newer patch
npm ci
node --test test/*.test.js        # 118 tests, no Atlassian account or network needed
# optional: validate manifest.yml against the schema bundled with a local Forge CLI checkout
# (npm i -g @forge/cli, then point FORGE_CLI_DIR at its install directory)
FORGE_CLI_DIR=<path-to-@forge/cli> node scripts/validate-manifest.cjs
```

## Deploy (needs an Atlassian account; Rovo is optional, see below)

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

## Testing with and without Rovo

The app installs on any Jira Cloud site. Rovo modules (`rovo:agent`, `rovo:skill`, `rovo:mcp`) only light up where
Rovo is enabled; on other sites installation still succeeds and only the Rovo-specific features are missing
([Atlassian developer community answer](https://community.developer.atlassian.com/t/what-happens-if-a-user-doesnt-use-rovo-tries-to-install-an-marketplace-app-which-use-rovo-agent/86768)).
The approval page, policy, audit log and the simulation panel do not depend on Rovo.

**Setup (both cases):** Jira → Apps → **Agent Change Gate** → **Policy**. Add your project key to `allowedProjects`
(the default policy allows nothing) and save. Doing this as a Jira admin is required for the simulation panel.

**Without Rovo — Simulate an agent request (Jira admins only):** Approvals tab → *Simulate an agent request*.
Each preset is a raw action input, exactly what the Rovo agent would send, and it goes through the same
`GateService.guardedChange` path: policy evaluation, caps, two-person approval, audit. Nothing is faked; the gate
decides the verdict from the current policy.

| Preset | Request | Verdict under the default policy |
|---|---|---|
| Low-risk comment | comment on one issue | ALLOW: runs at once |
| Move to protected status | transition one issue into the first protected status (Done) | NEEDS APPROVAL (`PROTECTED_STATUS`) |
| Runaway bulk close | transition `maxTargetsPerCall + 1` issues | DENY (`TOO_MANY_TARGETS`), before any issue is read |

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

**With Rovo:** open Rovo chat → pick **Change Gate Agent** → e.g. *"Comment 'ready for review' on KAN-1"* (runs),
*"Move KAN-1 to Done"* (returns PENDING_APPROVAL; approve it on the page, then ask the agent to run the approved
change), *"Close these 25 issues"* (denied). Audit entries show **Source: Agent**.

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

## Built with

Forge (UI Kit, KVS, Rovo modules), Jira REST v3, Node.js `node:test`. Libraries: `@forge/api`, `@forge/bridge`,
`@forge/kvs`, `@forge/react`, `@forge/resolver`, `react` 18. Developed with AI coding assistance;
local unit and flow tests cover the gate and adapters, with Forge runtime checks still pending.

MIT licence.
