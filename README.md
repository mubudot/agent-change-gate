# Agent Change Gate

A Forge app for Jira that gives Rovo agents and external MCP clients write tools backed by a
**deterministic policy gate**: project allowlists, per-call / per-hour / per-day caps, protected fields and statuses,
and human approval (two-person rule, single-use, expiring) for bulk or destructive changes.
Dispatches have an audit intent recorded before Jira is called, followed by their outcome.
The gate covers this app's tools; it cannot constrain other Jira tools or direct REST calls.

**Local implementation; not registered, deployed, or verified on a real Atlassian site.** See `STATUS.md` for the review and live verification checklist.

Built for Codegeist 2026 (Apps for Software Teams; bonus: Rovo Agents, Atlassian MCP). See `DESIGN.md`.

## What's inside

- `rovo:agent` **Change Gate Agent**, `rovo:skill` **agent-change-gate**, `rovo:mcp` **Agent Change Gate** (same 10 tools)
- Tools: comment, transition, assign, edit (summary/priority/due date/labels), create, delete (approval only),
  run-approved-change, approval-status, my-activity, policy-summary. The six change-request tools support `preview: true`;
  run-approved-change executes an approved request.
- Jira global page **Agent Change Gate**: approvals, audit log, policy JSON editor, kill switch.
- Forge KVS storage only, no external egress.

## Run the tests (no Atlassian account needed)

```bash
node --version   # tests require Node >= 22; the Forge CLI may require a newer patch
node --test test/*.test.js
FORGE_CLI_DIR=../work/forge-cli node scripts/validate-manifest.cjs
```

## Deploy (needs an Atlassian account + developer site with Rovo activated)

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

Forge (UI Kit, KVS, Rovo modules), Jira REST v3, Node.js `node:test`. Developed with AI coding assistance;
local unit and flow tests cover the gate and adapters, with Forge runtime checks still pending.

MIT licence.
