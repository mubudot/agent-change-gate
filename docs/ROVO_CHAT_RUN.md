# Rovo chat runs

## 2026-11-01: full loop in the browser (Confirm → approve on the page → run from chat → replay refused)

In a signed-in Chrome session on the Forge demo site (Enterprise Jira + Rovo), every step clicked in the real Jira and
Rovo UI (no internal APIs), development environment (code e2bbaa4),
policy `allowedProjects: ["MOBL"]`, `requireDistinctApprover: false` (one-person demo). Rovo chat was opened with the
page's **Ask Change Gate Agent** button. Answers below are verbatim (abridged).

| Step | Result |
|---|---|
| Ask | "What could go wrong if you move MOBL-12 to Done?" → *"…it currently blocks 5 open issues (including MOBL-2, MOBL-8, and MC-8)… the change gate will likely require a human to approve the transition."* |
| Write | "OK, move MOBL-12 to Done." → Rovo showed **Please review: Guarded transition issues** (To Status: Done, Issue Keys: MOBL-12) → **Confirm selected** |
| Gate | *"The request to move MOBL-12 to Done is pending approval. Nothing has changed yet… MOBL-12 blocks 5 open issues… Done is a protected status… Approval ID: 4942637f-…"* |
| Page | After **Refresh**: Waiting for approval 1; row *Transition · Move to "Done" · MOBL-12 · Jira: MOBL-12 blocks 5 open issues · moves issues into protected status 'Done' · PENDING*. **Review** showed why, the checked context (sources jira + teamwork-graph) and the exact change → **Approve** → "Request approved." |
| Run from chat | **View** → **Run it from Rovo chat** opened a new chat with *"My approval request 4942637f-… was approved. Check its status, then run it once."* → Rovo's review card *Run an approved change* → Confirm → *"…confirmed as APPROVED. I have successfully executed the change. Issue MOBL-12 has been updated."* |
| Replay | "Run approval 4942637f-… again." → Confirm → *"I cannot run approval request 4942637f-… again. The request has already been EXECUTED, and approvals are single-use only."* |
| Jira | `MOBL-12` status **Done** (it still shows its 5 *blocks* links). Audit log: queued (NEEDS APPROVAL) → approved by human → execution started → executed, reason codes `CONTEXT_BLOCKS_OPEN_WORK, PROTECTED_STATUS`. |

Notes: the replay refusal is the agent's tool result and is not written to the audit log (the audit log records gate
decisions and executions). The page's approval table updates on **Refresh**. This run is in the v3 demo video.

## 2026-10-31: first conversation through the internal chat API


A real Rovo conversation with **Change Gate Agent**, on a Forge demo development site (`forge site provision`,
Enterprise Jira + Rovo, seeded data), development environment (v3.5.0 for the transcript below; re-run on v3.7.0). Rovo's own model (Gemini 3 Flash on this site)
chose the tools; the app's Forge actions ran as the signed-in user and read Jira and Teamwork Graph.

How it was driven: `scripts/rovo-probe.mjs`, run from the `forge` GitHub workflow (`action: rovo-probe`). It sends each
prompt to the same Rovo chat service the Rovo web client uses (internal API, signed in with the developer's API token)
and prints the agent's tool calls and answer. It is a smoke test for our own site, not a supported integration.

### What was verified

| Step | Result |
|---|---|
| Agent registered in Rovo | `Change Gate Agent`, creator type `FORGE`, all 11 `acg-*` actions attached |
| Skill | Rovo loaded the `agent-change-gate` skill before the first write |
| Read-only tools | `Show agent change policy` and `Check issue context` ran and returned live data |
| Context from the site | `MOBL-12 blocks 5 open issues (MOBL-2, MOBL-8, MC-8, …)`; sources `jira`, `teamwork-graph` |
| Write request | For "move MOBL-12 to Done" the agent planned `Guarded - transition issues` with `{"issueKeys":"MOBL-12","toStatus":"Done"}`. Rovo held it for the user's **Confirm** click (UPDATE actions are consequential) |

### Transcript (abridged, verbatim answers)

> **User:** What is the agent change policy here?
> *Tool:* Show agent change policy
> **Agent:** The current agent change policy for Jira is as follows: … Requires Approval: Deleting issues always
> requires a human approver … Protected Statuses: You move an issue to `Done`, `Closed`, or `Won't Do` … Bulk
> Changes: You modify more than 5 issues in a single request … Context Risk: … In a release due within 7 days …

> **User:** What could go wrong if you move MOBL-12 to Done?
> *Tool:* Check issue context `{"issueKeys":"MOBL-12"}` → `BLOCKS_OPEN_WORK`, source `jira`, policy `approve`
> **Agent:** Moving MOBL-12 to **Done** will require human approval because it currently blocks 5 open issues
> (including MOBL-2, MOBL-8, and MC-8). The Agent Change Gate will flag this as risky to ensure that dependent work is
> not negatively impacted.

> **User:** OK, move MOBL-12 to Done.
> *Tool (planned, waiting for Rovo's Confirm):* Guarded - transition issues `{"toStatus":"Done","issueKeys":"MOBL-12"}`

### Not covered by that run (covered on 2026-11-01 above)

- **Clicking Confirm in Rovo.** The confirmation is a UI step; this script does not perform it. After Confirm, the
  action enters the same `GateService.guardedChange` path that the simulator and unit tests exercise.
- **Approving in the page and running from chat.** UI resolvers only accept calls from a rendered page (Forge rejects
  direct calls without a context token), so approval needs a person on the Agent Change Gate page. Then
  *Run it from Rovo chat* (or "it's approved, run it") calls `acg-approval-status` and `acg-run-approved-change`.
- On the demo site the default policy allows writes to no project, so a confirmed write here returns
  `DENIED / PROJECT_NOT_ALLOWED` until an admin adds a project (e.g. `MOBL`) on the Policy tab.

### Reproduce

```text
forge workflow → action: rovo-probe, site: <your-site>.atlassian.net,
prompts: "What could go wrong if you move MOBL-12 to Done?||OK, move MOBL-12 to Done."
```
(`prompts: peek` lists projects and issues to pick test data.)
