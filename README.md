# Agent Change Gate

A Forge app for Jira that lets Rovo agents and external MCP clients make Jira changes **only through a
deterministic policy gate**: project allowlists, per-call / per-hour / per-day caps, protected fields and statuses,
and human approval (two-person rule, single-use, expiring) for bulk or destructive changes. Everything is audited.

Built for Codegeist 2026 (Apps for Software Teams; bonus: Rovo Agents, Atlassian MCP). See `DESIGN.md`.

## What's inside

- `rovo:agent` **Change Gate Agent**, `rovo:skill` **agent-change-gate**, `rovo:mcp` **Agent Change Gate** (same 10 tools)
- Tools: comment, transition, assign, edit (summary/priority/due date/labels), create, delete (approval only),
  run-approved-change, approval-status, my-activity, policy-summary. Every write tool supports `preview: true`.
- Jira global page **Agent Change Gate**: approvals, audit log, policy JSON editor, kill switch.
- Forge KVS storage only, no external egress.

## Run the tests (no Atlassian account needed)

```bash
node --version   # >= 22.23.4 (Forge CLI requirement); tests only need node:test
npm test
node scripts/validate-manifest.cjs   # needs FORGE_CLI_DIR pointing at an @forge/cli install
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
and moves into Done/Closed/Won't Do need approval; 30 writes/user/hour, 100/user/day, 500/site/day.

## Built with

Forge (UI Kit, KVS, Rovo modules), Jira REST v3, Node.js `node:test`. Developed with AI coding assistance; all code reviewed and tested in this repo.

MIT licence.
