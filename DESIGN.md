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
| Best app with Atlassian MCP | `rovo:mcp` declares the same 10 tools; MIT-licensed SKILL.md included for third-party agents (live exposure unverified) |
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
- per-user fixed UTC clock-hour cap, per-user calendar-day cap, per-site calendar-day cap
  (attempted targets reserved before dispatch, including failed or uncertain writes)

## Approval protocol (`src/policy/approvals.js`)

- A NEEDS_APPROVAL call **changes nothing in Jira** and returns `approvalId`. Identical repeat calls reuse the same pending request via a strongly consistent point index, independent of dashboard queries.
- Request is bound to a **SHA-256 fingerprint** of the canonical operation: kind, payload, sorted targets, resolved issue/project IDs, and transition/destination IDs and names. Jira writes address stable issue/project IDs. Aliases resolving to the same issue are deduplicated; ambiguous transitions are refused.
- The human review shows the requester, expiry, full exact payload, resolved targets and fingerprint as plain text.
- **Approvers**: listed accountIds, or Jira administrators when the list is empty. **Two-person rule** on by default:
  the requester cannot approve their own request (an authorized requester can reject it).
- Approved requests are **single-use** (atomic `FAIL_IF_EXISTS` claim key in KVS), **expire** (default 24 h), and
  can only be run by the **original requester** via `acg-run-approved-change`.
- At run time the operation is re-resolved against Jira and **re-evaluated against the current policy**: a DENY
  (e.g. kill switch flipped) or any new non-rate risk code refuses the run (`DENIED_NOW` / `NEW_RISK`).
  Resolution changes refuse with `FINGERPRINT_MISMATCH`; expiry is checked again after Jira reads and storage reservations,
  immediately before dispatch. Changing the approver list or two-person setting invalidates earlier decisions (`AUTHORITY_CHANGED`).

## Identity and permissions

- The acting user is always the platform context's `principal.accountId` (Forge function arguments), never an LLM-supplied input.
- All Jira calls use `api.asUser()`, so the gate can only **narrow** what the human could already do.
- If the agent omits `issueKeys`, the issue the user is viewing (`payload.context.jira.issueKey`) is used.
- Issue keys, account ids, dates and labels are regex-validated; the Jira client also rejects unsafe issue references before applying `encodeURIComponent`.
- This is a gate on this app's tools, not a site-wide Jira interceptor. An agent with other write tools can use those independently.

## Storage / audit (`src/store/`)

Forge KVS only (no egress → eligible for "Runs on Atlassian"). Keys: `policy`, `req:<id>`, `open:<id>` (index),
`pending:<acct>:<fingerprint>` (point lookup), `claim:<id>`, `mutation-lock:<bucket>` (TTL), `usage:*` (TTL), `audit:<inverted-ts>:<id>` and per-user `auditu:<acct-hash>:…` (90-day TTL).
Audit entries hold kind, issue keys, verdict, outcome, reason codes, approvalId — not comment bodies.
Usage reservation and an `EXECUTION_STARTED` audit intent must succeed before Jira dispatch. A final outcome follows;
if the invocation stops or a Jira response is lost, the intent remains and usage is not refunded. Approval records
do contain full write payloads and currently have no retention purge.

All mutations (policy updates, human decisions, queuing, previews, execution) acquire one installation-wide
`FAIL_IF_EXISTS` storage lock. Contention returns `REFUSED` / `BUSY`. Counters are updated while holding the lock,
before writes; failed attempts still count. The lock is a 60 s owner-token lease, one KVS key per 120 s
bucket: create your bucket's key with `FAIL_IF_EXISTS`, then back off if the previous or next bucket holds a live
lease (adjacent callers each write then read, so one always sees the other). The lease outlives any Forge
invocation (25 s default) but not a bucket, and expired-but-unswept keys (which still block `FAIL_IF_EXISTS`) are
simply left behind, so a crashed invocation unblocks within one bucket. Release deletes only the caller's own lease. This serialises agent writes per
site — fine for the hackathon scale; see `STATUS.md`.

Per-call bulk limits apply to the submitted call. The gate cannot infer a logical task across separate calls;
several small calls below aggregate caps can still avoid a per-call bulk approval. Hourly buckets reset on UTC
clock-hour boundaries. Jira configuration/project changes are not transactional with the gate's reads and writes.

## Module layout

```
manifest.yml                 rovo:agent, rovo:skill, rovo:mcp, 10 actions, jira:globalPage
src/policy/                  pure core: policy.js (schema/defaults), ops.js (input → operation),
                             gate.js (verdict), approvals.js (state machine), fingerprint.js
src/jira/client.js           Jira REST v3 calls (transport injected)
src/jira/executor.js         resolve op against Jira + execute target by target
src/store/                   memory.js (tests), kvs.js (Forge), repo.js (policy/usage/requests/audit)
src/service.js               orchestration: guardedChange, runApproved, decide, dashboard, savePolicy
src/simulation/              admin demo: presets.js (3 preset inputs), dry-run-jira.js (stand-in client),
                             simulator.js (admin check, then GateService.guardedChange with source 'simulated')
src/actions.js               Rovo action / MCP tool handlers (identity from context)
src/resolvers.js             UI Kit resolvers
src/index.js                 Forge wiring only (asUser transport, KVS, exports)
src/frontend/index.jsx       approval dashboard (UI Kit)
skills/agent-change-gate/    SKILL.md (Rovo skill + open-source MCP skill file)
prompts/agent-prompt.txt     Rovo agent prompt
test/                        node:test unit + flow tests with fake Jira
```

## Simulated agent requests (works without Rovo)

Admins can push three preset requests through `GateService.guardedChange`, the path the Rovo actions use. The only
differences: requests and audit entries carry `source: 'simulated'`, and without an issue key the request is bound
to `DryRunJira` (synthetic issues, no-op writes). The binding is stored on the request, and `run()` re-applies it
whichever entry point runs the request, so a dry run can never write to Jira. Running a simulated request needs a
Jira admin on every entry point. Simulated and agent requests use separate dedup keys and are never merged. Admin authority is checked with the real Jira client; `DryRunJira.isJiraAdmin()` is
always false. The two-person rule, caps and approval expiry apply unchanged.

## Demo script (video, < 3 min)

Without Rovo, steps 2–4 can be shown with the *Simulate an agent request* panel (Approvals tab).

1. Problem in 15 s: an agent reading a malicious issue is told "close all issues in this sprint".
2. Rovo chat: "comment on DEMO-1" → EXECUTED. "Move DEMO-1..8 to Done" → PENDING_APPROVAL (bulk + protected status).
3. Second user approves on the Agent Change Gate page; requester's agent runs it once; second run refused.
4. "Delete DEMO-3" → always approval. Admin flips kill switch → approved run refused (`DENIED_NOW`).
5. Same tools from an external MCP client (Claude Code) hitting `https://mcp.atlassian.com/forge/<appId>`.
6. Audit log tab. Close with Runs-on-Atlassian (no egress) + how to install.

## Next steps

- Done: `forge register`, `forge deploy` (development) and `forge install` on a test site; UI Kit page renders.
  Still open: run the Rovo agent / MCP tools from a Rovo chat and an MCP client; production deploy + sharing link for judges.
- Confluence guarded writes (needs multi-app compatibility config, Preview).
- Teamwork Graph enrichment of approval cards (bonus stretch).
- Notify approvers (Jira comment on the issue or email) when a request is queued.
