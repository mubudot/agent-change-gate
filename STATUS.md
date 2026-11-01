# Status

Deployed to Forge **production** (v2.1.0, 2026-10-31, the version the judge install link installs) and to the
development environment, which is installed on a free Jira Cloud test site. The global page (approvals, policy,
audit log, kill switch, simulation panel) and the context-aware gate (Jira release facts, Teamwork Graph reads) were
exercised there with live issues. Not submitted to Devpost or the Marketplace. The Rovo agent was run in a real Rovo
conversation on a Forge demo site (development environment, see `docs/ROVO_CHAT_RUN.md`); the Rovo Confirm click, the
approve-in-page → run-from-chat round trip and an external MCP client are not verified. Production is still v2.1.0:
the Rovo hand-off changes of 2026-10-31 and the Guided demo of 2026-11-01 are in development only.

**2026-11-01 (judge onboarding):** admin-only **Guided demo** on the Approvals tab (five steps on sample issues, per-user
storage namespace, no Jira writes, no setup) and a "New here?" banner on a fresh install; live comparison presets pick
the issue's In Progress (or in-progress-category) transition instead of assuming the status name; dashboard labels
"Attempted targets today (site)" and "Teamwork Graph API reachable"; demo progress self-heals from the stored approval if a save is lost, and a failed load offers "Try again". Tests 161 → 199. Deployed to development
(GitHub Actions deploy run 41288358774, success). Not yet seen rendered in a browser.

## Review (2026-10-30)

| Severity | Finding | Resolution |
|---|---|---|
| P1 | Action identity fell back to `payload.context.accountId` and an undocumented principal shape. Missing Forge identity could select another requester's approvals/usage. | Only the platform context's validated `context.principal.accountId` (documented Forge function shape) or flat `context.accountId` is accepted; payload identity is ignored; missing identity refuses writes and personal activity access. |
| P1 | Approval fingerprints omitted resolved issue/project/transition identities. Workflow changes with the same risk code could execute a different destination. | Fingerprints bind resolved IDs and destination names, are recomputed after resolution, and Jira writes use stable IDs. Ambiguous/missing destinations fail closed; issue aliases are deduplicated. |
| P1 | Concurrent decisions could overwrite rejection; parallel writes could race the caps; successful writes with lost responses or storage errors could go uncounted. | Storage-backed serialization covers all gate mutations; usage is reserved before dispatch without refunds, and a pre-dispatch audit intent is mandatory. Single-use claims remain permanent. |
| P1 | Approval expiry was checked before potentially slow Jira/permission reads, and a newly enabled two-person rule did not invalidate an earlier decision. | Fresh expiry checks before decision/dispatch; approver-list or distinct-approver setting changes invalidate old approvals. |
| P2 | Malformed policy booleans/numbers/lists and unknown properties were silently coerced or ignored; malformed usage could lower caps. | Strict schema validation and invalid usage refusal. Invalid stored policies block changes and approval decisions. |
| P2 | Personal audit prefix queries could include another account whose ID extended the prefix with a colon. | Per-user audit indexes use fixed-length SHA-256 account-ID hashes, with isolation regression coverage. |
| P2 | Human approval showed issue names/reasons without the payload or requester. | Review text includes exact full payload, resolved targets, requester, expiry and fingerprint. |
| P2 | Pending deduplication depended on the first 100 eventually consistent query results; expired/other users' entries could hide active requests. | Strong point index for deduplication; queue scans cursor pages and filters expiry/visibility before applying its display limit. |
| P3 | Documentation overstated audit/cap guarantees and deletion always queuing; one scope was unused. | README, DESIGN, prompt and skill now describe dispatch intent, attempted-target counting, fixed buckets, scope of enforcement and refusal codes. Removed `read:jira-user`; documented mypermissions classic scope is `read:jira-work`. |

Local checks: **161 tests passing** (as of 2026-10-31, after the Rovo hand-off review rounds) with `node --test test/*.test.js` on Node 22.23.3;
`FORGE_CLI_DIR=../work/forge-cli node scripts/validate-manifest.cjs` passes against the bundled CLI schema.
Unit tests exercise pure policy, approval flows, deterministic races, storage failures, Jira routing and SDK-adapter contracts.
They do not execute the Forge runtime or mount UI Kit; the Forge runtime was exercised separately by the development deploys (see Live site notes).

## Remaining limits

- **P2 — availability (changed after review):** the installation-wide lock is a 60 s owner-token lease stored
  under one key per 120 s time bucket (`mutation-lock:<bucket>`). A caller creates its bucket key with
  `FAIL_IF_EXISTS`, then backs off if the previous or next bucket holds a live lease. Reason: the Forge Storage team
  confirmed an expired-but-unswept KVS key still blocks `FAIL_IF_EXISTS` (sweeps take up to 48 h) and KVS has no
  conditional delete, so a single key can neither expire reliably nor be taken over safely. A crashed invocation
  blocks gate mutations for at most the rest of its bucket (≤ 2 min); stale keys are never deleted, only ignored.
  Relies on KVS read-after-write consistency and roughly synchronised server clocks. Release only deletes the
  caller's own lease. Contention
  still returns `REFUSED/BUSY` (serialises all agent writes per site — fine for a hackathon, a scaling limit later).
  An `EXECUTING` request with a claim is never retried: inspect Jira and request a new approval for remaining work.
  Do not delete single-use claim keys. Verify the lease reasoning against the real invocation limit on a site.
- **P2 — Jira read/write race:** Jira issue moves and workflow configuration changes are external to the app's
  storage lock. Stable issue IDs prevent key reuse from redirecting writes, but Jira does not provide a transaction
  spanning gate resolution and mutation. A configuration/project change between the final read and dispatch remains possible.
- **P3 — policy boundary:** the gate covers this app's tools. It cannot intercept other Jira tools or infer one
  logical bulk task from several calls. Per-call bulk thresholds can be avoided by separate small calls until aggregate
  caps are reached; prompt instructions are not an enforcement mechanism. Clock-hour caps are not rolling windows.
- **P3 — lifecycle:** approval records contain full payloads and have no retention purge; audit has a 90-day TTL.
  KVS TTL removal is asynchronous. Audit intent survives uncertain execution, but the final outcome may be missing
  after termination/storage failure. Queue scans can grow with expired index entries; UI shows at most 50 active entries.
- Jira-admin authority is checked at decision time as the invoking human. The app invalidates decisions when its
  approver configuration changes; it does not recheck a past approver's Jira-admin membership as another user at run time.
- Submission still requires a public demo video and the Devpost submission (a public repository is optional under the rules). The production
  deploy and the judge installation link exist (setup steps in README). The manifest/skill support the intended
  Agents/MCP bonus entries; a Rovo chat run is verified for read tools and write planning (see `docs/ROVO_CHAT_RUN.md`),
  an external MCP client run is not. Teamwork Graph
  context is implemented (curated queries, read as the user). A Marketplace listing is drafted but deliberately not
  submitted (submitting would replace the private distribution link judges use).

## Live site notes (a free Jira Cloud test site, development)

- 2026-10-30: global page showed only loading skeletons. Cause: root `react@19` while `@forge/react@12` renders
  with `react-reconciler@0.29` and its own nested `react@18`; the dashboard's hooks ran on a different React copy,
  so the UI Kit app threw before its first render and no `getDashboard` resolver invocation was ever logged.
  Fixed by pinning `react@^18.3.1` (single deduped copy) and committing `package-lock.json`; `test/deps.test.js`
  guards the React major. Deployed as development v2.2.0 (same scopes, no reinstall). The `logs` workflow action
  (`forge logs -e development --since 1h --limit 200`) is how to read resolver errors.
- 2026-10-30 16:31: page rendered but every resolver call failed: `TypeError: resolver_out_namespaceObject is not a
  constructor at buildResolver (src/resolvers.js:14)`, thrown while loading `src/index.js`, so every function in the
  bundle (UI resolver and all Rovo/MCP actions) failed at module load. Cause: `@forge/resolver` is CommonJS
  (`exports.default = Resolver`); with `"type": "module"` both Node and the Forge webpack bundle resolve a default
  import to the whole `module.exports` object. Fixed with named imports only (`makeResolver`, `asUser`) in 45c3493;
  `test/runtime.test.js` reproduces the crash on the old code and bans default/namespace `@forge/*` imports in backend
  code. Deployed development v2.3.0. `"type": "module"` stays (tests run as native ESM; `.jsx` keeps webpack interop).
- Codex review (work/codex_codegeist_review.md) round 1 fixes: actions read `context.principal.accountId` (the
  documented Forge function context; the old flat-only check would have refused every Rovo/MCP call); stale-lock
  takeover is claimed per dead lease so two callers cannot both delete-and-reacquire; KVS conflicts read
  `err.responseDetails.status`; comment/description/label sizes bounded below the 240 KiB KVS value limit; policy
  save shows transport errors and disables its buttons while saving.
- UI polish (a7e31e4, development v2.5.0): UI Kit only. Summary cards (Badge counts, Lozenge state), approvals
  and audit DynamicTables with clear columns, `User` avatars and locale timestamps plus relative time, a review
  Modal with the exact untruncated payload (CodeBlock) and Approve (primary) / Reject (danger) + optional note,
  SectionMessage empty/error states, Spinner on first load, background refresh keeps data visible. UI Kit `Tab`
  labels must be plain strings, so the pending count is in the label text and Badges sit on the summary cards.
  Components: `src/frontend/components/{Summary,Approvals,AuditLog,PolicyPanel,ui}.jsx`, helpers in
  `src/frontend/format.js` (unit-tested).
- Page speed: still one resolver call per load (`getDashboard`). `dashboard()` now does policy+Jira admin check in
  parallel, then requests/audit/usage in parallel (2 stages instead of 6 sequential round-trips) and calls
  `mypermissions` once instead of twice. Known remaining cost: `listOpenRequests` fetches each open request by id
  (parallel per page of 50) because the `open:` index stores only `createdAt`.
- Final Codex pass (work/codex_codegeist_final.md) fixes: approval requests are size-checked on the full serialized
  UTF-8 value before KVS writes (32k escaped text + 200 resolved targets could exceed 240 KiB); more field length
  bounds; policy editor no longer silently overwrites a newer stored policy (conflict warning, save disabled until
  discard); stale overlapping reloads ignored; double submits blocked in review and policy save; MemoryStore models
  TTL. Its lock change (TTL-only, no takeover) was replaced by the bucketed lease above because unswept keys block
  `FAIL_IF_EXISTS` for up to 48 h.
- 2026-10-30: user confirmed the page works on dev v2.6.0.
- 2026-10-30 17:59 (bb63a07, dev v2.7.0, forge lint clean, no reinstall): **Simulate an agent request** (admin-only card on the Approvals tab) so the page shows real gate
  data without Rovo. Three presets (low-risk comment → ALLOW, transition into first protected status →
  NEEDS_APPROVAL, `maxTargetsPerCall + 1` bulk transition → DENY) go through `GateService.guardedChange` with
  `source: 'simulated'` on requests and audit entries. No issue key = dry run bound to `DryRunJira` (synthetic
  `<project>-9001` issues, no-op writes), re-applied in `run()` on every entry point. Running a simulated request needs
  a Jira admin on every entry point (incl. Rovo `run-approved-change`). Separate dedup keys per origin; approved
  simulations stay listed (`simok:` index) until run. Two-person rule unchanged: solo demos set
  `requireDistinctApprover: false`. Codex review: work/codex_codegeist_demo.md (3 P2 + 1 P3, all fixed with tests).
  115 tests. Manifest/scopes unchanged.
- 2026-10-30 19:35 (6e20084, dev deploy run 41049159787): UI copy fixes found while recording the demo.
  Policy caps now say "More than N issues in one call need approval" (gate uses units > threshold);
  running an approved simulated request says "Approved change ran once (dry run): Jira was not changed."
  instead of "Gate verdict ALLOW"; the simulator's NEEDS APPROVAL banner is replaced once the request is
  approved/rejected/expired/executed. 118 tests. Manifest/scopes unchanged.
- Rovo off: installation succeeds and only Rovo features are missing (Atlassian dev-community answer, linked in
  README); confirmed by our own install on the test site. The global page, policy, audit and simulation panel do not use Rovo.

## Verify on a real site

- Rovo and external MCP handler `(payload, context)` shapes; signed-in identity in `context.principal.accountId`; issue-view
  fallback shape (`payload.context.jira.issueKey`); missing identity must refuse rather than infer an actor.
- `api.asUser().requestJira(assumeTrustedRoute(path))` inside all action invocation modes, consent behavior, and
  Jira permission refusals. The client validates path references, and never passes an account ID to `asUser`.
- Installed `@forge/kvs` version supports `set(key, value, { keyPolicy: 'FAIL_IF_EXISTS', ttl: ... })`;
  concurrent claims really conflict, and the SDK's actual conflict error code/status maps to refusal. Unknown
  storage errors propagate without granting a write. The adapter's conflict recognition remains to be confirmed.
- KVS point-read/conditional-write behavior across separate invocations, `WhereConditions.beginsWith`, cursor pages,
  TTL behavior and the operator recovery procedure. SDK doubles are contract tests, not live evidence.
- (Done since: dependencies installed, `forge lint` clean, bundled and deployed to development; `@forge/resolver` switched to named imports.)
- UI Kit exports/props (`TextArea`, `DynamicTable`, `Lozenge`, `Tabs`, `SectionMessage`, `Button`), native resource
  compilation, `@forge/bridge` invokes, full payload readability and transport-error behavior.
- End to end with two accounts: allow/deny/preview, protected transitions, approve/reject, self-approval refusal,
  concurrent decisions/executions, changed policy/destination, expiry during reads, partial failures, single-use replay
  and audit intent/outcome. Verify create/project resolution and writes addressed by Jira IDs.
- Agent/skill discovery, all eleven MCP tools, app exposure toggle, OAuth consent/site selection and endpoint connectivity.
  Check scopes with authenticated Forge lint; no login-dependent Forge commands have been run during this review.

## References checked

- [Action arguments and trusted identity](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/)
- [Agent](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/), [Skill](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-skill/), [MCP](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/), [global page](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-global-page/)
- [KVS options](https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/), [consistency](https://developer.atlassian.com/platform/forge/storage-reference/kvs/), [transactions](https://developer.atlassian.com/platform/forge/storage-reference/kvs-transactions/)
- [Jira request authentication/routing](https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestjira/), [mypermissions scope](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/)
- [UI Kit components](https://developer.atlassian.com/platform/forge/ui-kit/components/), [packaging](https://developer.atlassian.com/platform/forge/manifest-reference/packaging/)
- [Official hackathon rules](https://codegeist2026.devpost.com/rules): installation/video requirements and Agents/MCP bonus paths agree with RULES.md. Rules say `rovo:action`; the current Forge module reference uses `action`. This entry also declares `rovo:agent` directly.

## Context-aware gating review (2026-10-31)

Codex reviewed the Teamwork Graph / context feature over five rounds (`cffc313..HEAD`). Round 1–3 findings (count-only
context text for approvers, per-issue NEW_RISK, outage tolerance only for reviewed context, no fact truncation, graph
pagination gaps, bounded graph reads, run-time context outage is NEW_RISK unless approved) were fixed with tests.
Round 4: no material issues, one P3 (Teamwork Graph listed as a checked source when no Graph query succeeded), fixed by
returning per-family `answered` coverage from the client and deriving `sources` from it (+2 regression tests).
Round 5: no findings; 149 tests passing.

## Rovo chat and page hand-off (2026-10-31)

- Forge demo site (`forge site provision`: Enterprise Jira + Rovo, 90 days) with the development app installed.
  `scripts/rovo-probe.mjs` (workflow `action: rovo-probe`) checks the agent is this app's `change-gate-agent` module in
  the development environment with all 11 actions, then chats with it through Rovo's chat service. Verified: policy
  summary and issue context answered from live data (`MOBL-12 blocks 5 open issues`, Jira + Teamwork Graph), and a
  transition planned with the right input and held by Rovo for the user's Confirm. Details: `docs/ROVO_CHAT_RUN.md`.
- New: `PENDING_APPROVAL` / `approval-status` carry `approvalPage` (link to this app's Jira page from the Forge app
  context, `src/rovo/links.js`) and `nextStep`; the page has **Ask Change Gate Agent** and, for the requester's own
  approved request, **Run it from Rovo chat** (Forge bridge `rovo.open`, hidden when Rovo is off). Requesters now see
  their approved, not-yet-run requests (`okreq:` index, newest first, pruned when expired, bounded scan of 20 pages).
- Not possible from CI: UI resolvers reject calls without a Forge context token, so approvals need a person on the page.
- Codex review: round 1 (2 P1: probe could send credentials to any host; the run-from-chat button was unreachable
  because approved requests left the dashboard), round 2 (index pagination, probe identity, empty finals, prod/dev
  mismatch), round 3 (index ordering/pruning, test that did not paginate, tool errors passing the probe). All fixed
  with tests. Further rounds: see `work/` review logs referenced in the project STATE.
