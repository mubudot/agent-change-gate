# Agent Change Gate — design

## Problem

Teams are handing Jira to AI agents: Rovo agents in chat and automation, and — since `rovo:mcp` — any third-party
MCP client (Claude, Cursor, ChatGPT…) connected to the site. An agent acting as a user can do everything that user
can: bulk-close a sprint, rewrite priorities, delete issues. It can also be steered by text inside the issues it
reads (prompt injection). Jira permissions answer *"may this person do X?"*, not *"should an agent do X, this
much, this fast, without a second human?"*.

**Who it is for:** Jira admins and engineering leads who want agents to do the boring writes (comments, triage
transitions, labels) but never a silent mass change.

## Concept

A Forge app that offers **guarded write tools** for Jira and puts a **deterministic policy gate** in front of every
one of them. The same tools are exposed three ways:

1. a **Rovo agent** (`rovo:agent`, "Change Gate Agent") with a safety prompt,
2. a **reusable Rovo skill** (`rovo:skill`, SKILL.md) + **actions** (`action`) any other Rovo agent can use,
3. an **MCP server** (`rovo:mcp`) so external AI clients get the same guarded tools — and the SKILL.md doubles as
   an open-source skill file for those clients.

Humans work in a **Jira global page** (UI Kit): approval queue (approve/reject), audit log, policy editor, kill switch.

The gate is the idea reused from our sibling repos (paypal-guardrail-buyer: per-order/daily caps + human approval;
near-agent-spend-guard: per-agent policy, pending requests, audit). Here the "money" is **issue writes**.

## Bonus-prize fit

| Prize | How we qualify |
|---|---|
| Best Agents (Rovo) | `rovo:agent` + reusable `rovo:skill` + 10 `action` modules other agents can invoke |
| Best app with Atlassian MCP | `rovo:mcp` exposes the same 10 tools; SKILL.md published in the repo for third-party agents |
| Teamwork Graph (stretch) | approval cards enriched with related work/owners from the Teamwork Graph API — not built yet |
| Marketplace (stretch, user decision) | "submitted for listing" would qualify; needs a partner profile, privacy policy, support page |

A submission can win only one bonus prize, so we select Agents + MCP and let judges place it.
Category: **Apps for Software Teams** (dev-team triage/hygiene by agents).

## Policy gate (pure, `src/policy/`)

`evaluate(policy, op, usage) → { verdict: ALLOW | NEEDS_APPROVAL | DENY, reasons[] }`. No LLM, no I/O.
DENY always wins over NEEDS_APPROVAL.

DENY (no human can override from the agent side):
- kill switch `agentWritesPaused`; stored policy invalid (fail closed)
- operation mode `deny`, or unknown operation
- project not on `allowedProjects` (default empty = nothing allowed) or on `blockedProjects` — the project is
  **read from Jira** for each issue, never inferred from the key prefix
- more than `maxTargetsPerCall` issues in one call (default 20); comment longer than `maxCommentLength`

NEEDS_APPROVAL (a human approver can say yes):
- operation mode `approve`; **delete is floored to `approve`** even if a policy says `allow`
- bulk: more than `bulkApprovalThreshold` issues (default 5)
- protected fields (priority, fixVersions, security, duedate) / transitions into protected statuses (Done, Closed, Won't Do)
- per-user hourly cap, per-user daily cap, per-site daily cap (counted in issues, so splitting a bulk change into
  many small calls doesn't help)

## Approval protocol (`src/policy/approvals.js`)

- A NEEDS_APPROVAL call **changes nothing** and returns `approvalId`. Identical repeat calls reuse the same pending request.
- Request is bound to a **SHA-256 fingerprint** of the canonical operation (kind, sorted targets, payload).
- **Approvers**: listed accountIds, or Jira administrators when the list is empty. **Two-person rule** on by default:
  the requester cannot approve their own request (they can reject it).
- Approved requests are **single-use** (atomic `FAIL_IF_EXISTS` claim key in KVS), **expire** (default 24 h), and
  can only be run by the **original requester** via `acg-run-approved-change`.
- At run time the operation is re-resolved against Jira and **re-evaluated against the current policy**: a DENY
  (e.g. kill switch flipped) or any new non-rate risk code refuses the run (`DENIED_NOW` / `NEW_RISK`).

## Identity and permissions

- The acting user is always `context.accountId` from Forge, never an LLM-supplied input (per Rovo action docs).
- All Jira calls use `api.asUser()`, so the gate can only **narrow** what the human could already do.
- If the agent omits `issueKeys`, the issue the user is viewing (`payload.context.jira.issueKey`) is used.
- Issue keys, account ids, dates and labels are regex-validated; path segments are `encodeURIComponent`-ed.

## Storage / audit (`src/store/`)

Forge KVS only (no egress → eligible for "Runs on Atlassian"). Keys: `policy`, `req:<id>`, `open:<id>` (index),
`claim:<id>`, `usage:*` (TTL), `audit:<inverted-ts>:<id>` and per-user `auditu:<acct>:…` (90-day TTL).
Audit entries hold kind, issue keys, verdict, outcome, reason codes, approvalId — not comment bodies.

Known limitation: KVS has no atomic increment, so usage counters are last-write-wins under heavy concurrency
(caps are approximate; single-use approval claims are exact).

## Module layout

```
manifest.yml                 rovo:agent, rovo:skill, rovo:mcp, 10 actions, jira:globalPage
src/policy/                  pure core: policy.js (schema/defaults), ops.js (input → operation),
                             gate.js (verdict), approvals.js (state machine), fingerprint.js
src/jira/client.js           Jira REST v3 calls (transport injected)
src/jira/executor.js         resolve op against Jira + execute target by target
src/store/                   memory.js (tests), kvs.js (Forge), repo.js (policy/usage/requests/audit)
src/service.js               orchestration: guardedChange, runApproved, decide, dashboard, savePolicy
src/actions.js               Rovo action / MCP tool handlers (identity from context)
src/resolvers.js             UI Kit resolvers
src/index.js                 Forge wiring only (asUser transport, KVS, exports)
src/frontend/index.jsx       approval dashboard (UI Kit)
skills/agent-change-gate/    SKILL.md (Rovo skill + open-source MCP skill file)
prompts/agent-prompt.txt     Rovo agent prompt
test/                        node:test unit + flow tests with fake Jira
```

## Demo script (video, < 3 min)

1. Problem in 15 s: an agent reading a malicious issue is told "close all issues in this sprint".
2. Rovo chat: "comment on DEMO-1" → EXECUTED. "Move DEMO-1..8 to Done" → PENDING_APPROVAL (bulk + protected status).
3. Second user approves on the Agent Change Gate page; requester's agent runs it once; second run refused.
4. "Delete DEMO-3" → always approval. Admin flips kill switch → approved run refused (`DENIED_NOW`).
5. Same tools from an external MCP client (Claude Code) hitting `https://mcp.atlassian.com/forge/<appId>`.
6. Audit log tab. Close with Runs-on-Atlassian (no egress) + how to install.

## Next steps

- Login-dependent: `forge register`, `forge deploy`, `forge install` on a dev site with Rovo enabled; verify
  action payload/context shape, `asUser()` inside actions, KVS `FAIL_IF_EXISTS` error code, UI Kit rendering.
- Confluence guarded writes (needs multi-app compatibility config, Preview).
- Teamwork Graph enrichment of approval cards (bonus stretch).
- Notify approvers (Jira comment on the issue or email) when a request is queued.
