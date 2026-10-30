# Status

Local implementation only. Not registered, deployed, installed, or submitted. No live-site behavior is claimed.

## Review (2026-10-30)

| Severity | Finding | Resolution |
|---|---|---|
| P1 | Action identity fell back to `payload.context.accountId` and an undocumented principal shape. Missing Forge identity could select another requester's approvals/usage. | Only validated `context.accountId` is accepted; missing identity refuses writes and personal activity access. |
| P1 | Approval fingerprints omitted resolved issue/project/transition identities. Workflow changes with the same risk code could execute a different destination. | Fingerprints bind resolved IDs and destination names, are recomputed after resolution, and Jira writes use stable IDs. Ambiguous/missing destinations fail closed; issue aliases are deduplicated. |
| P1 | Concurrent decisions could overwrite rejection; parallel writes could race the caps; successful writes with lost responses or storage errors could go uncounted. | Storage-backed serialization covers all gate mutations; usage is reserved before dispatch without refunds, and a pre-dispatch audit intent is mandatory. Single-use claims remain permanent. |
| P1 | Approval expiry was checked before potentially slow Jira/permission reads, and a newly enabled two-person rule did not invalidate an earlier decision. | Fresh expiry checks before decision/dispatch; approver-list or distinct-approver setting changes invalidate old approvals. |
| P2 | Malformed policy booleans/numbers/lists and unknown properties were silently coerced or ignored; malformed usage could lower caps. | Strict schema validation and invalid usage refusal. Invalid stored policies block changes and approval decisions. |
| P2 | Personal audit prefix queries could include another account whose ID extended the prefix with a colon. | Per-user audit indexes use fixed-length SHA-256 account-ID hashes, with isolation regression coverage. |
| P2 | Human approval showed issue names/reasons without the payload or requester. | Review text includes exact full payload, resolved targets, requester, expiry and fingerprint. |
| P2 | Pending deduplication depended on the first 100 eventually consistent query results; expired/other users' entries could hide active requests. | Strong point index for deduplication; queue scans cursor pages and filters expiry/visibility before applying its display limit. |
| P3 | Documentation overstated audit/cap guarantees and deletion always queuing; one scope was unused. | README, DESIGN, prompt and skill now describe dispatch intent, attempted-target counting, fixed buckets, scope of enforcement and refusal codes. Removed `read:jira-user`; documented mypermissions classic scope is `read:jira-work`. |

Local checks: **87 tests passing** with `node --test test/*.test.js` on Node 22.23.3;
`FORGE_CLI_DIR=../work/forge-cli node scripts/validate-manifest.cjs` passes against the bundled CLI schema.
Unit tests exercise pure policy, approval flows, deterministic races, storage failures, Jira routing and SDK-adapter contracts.
They do not execute the Forge runtime or mount UI Kit. The Forge dependencies are not installed in this checkout.

## Remaining limits

- **P2 — availability (changed after review):** the installation-wide `mutation-lock` is now a 120 s lease
  (owner token + expiry, KVS TTL as backup). Forge invocations are capped at 25 s by default and this app declares
  no long-running functions, so a lease cannot expire under a live owner; a crashed invocation blocks gate mutations
  for at most ~2 minutes instead of until manual cleanup. Release only deletes the caller's own lease. Contention
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
- Submission still requires a deployed, installable app, judge installation link and setup instructions, public demo
  video and Devpost submission. The manifest/skill support the intended Agents/MCP bonus entries; live exposure,
  public source availability and any Runs on Atlassian badge are not verified. Teamwork Graph/Marketplace work is absent.

## Verify on a real site

- Rovo and external MCP handler `(payload, context)` shapes; signed-in identity in `context.accountId`; issue-view
  fallback shape (`payload.context.jira.issueKey`); missing identity must refuse rather than infer an actor.
- `api.asUser().requestJira(assumeTrustedRoute(path))` inside all action invocation modes, consent behavior, and
  Jira permission refusals. The client validates path references, and never passes an account ID to `asUser`.
- Installed `@forge/kvs` version supports `set(key, value, { keyPolicy: 'FAIL_IF_EXISTS', ttl: ... })`;
  concurrent claims really conflict, and the SDK's actual conflict error code/status maps to refusal. Unknown
  storage errors propagate without granting a write. The adapter's conflict recognition remains to be confirmed.
- KVS point-read/conditional-write behavior across separate invocations, `WhereConditions.beginsWith`, cursor pages,
  TTL behavior and the operator recovery procedure. SDK doubles are contract tests, not live evidence.
- Full Forge dependency installation and bundling with root `"type": "module"`, `.js` import extensions,
  `node:crypto`, `@forge/resolver` default import, Node 24 runtime and arm64. Schema validation cannot prove bundler compatibility.
- UI Kit exports/props (`TextArea`, `DynamicTable`, `Lozenge`, `Tabs`, `SectionMessage`, `Button`), native resource
  compilation, `@forge/bridge` invokes, full payload readability and transport-error behavior.
- End to end with two accounts: allow/deny/preview, protected transitions, approve/reject, self-approval refusal,
  concurrent decisions/executions, changed policy/destination, expiry during reads, partial failures, single-use replay
  and audit intent/outcome. Verify create/project resolution and writes addressed by Jira IDs.
- Agent/skill discovery, all ten MCP tools, app exposure toggle, OAuth consent/site selection and endpoint connectivity.
  Check scopes with authenticated Forge lint; no login-dependent Forge commands have been run during this review.

## References checked

- [Action arguments and trusted identity](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/)
- [Agent](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/), [Skill](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-skill/), [MCP](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/), [global page](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-global-page/)
- [KVS options](https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/), [consistency](https://developer.atlassian.com/platform/forge/storage-reference/kvs/), [transactions](https://developer.atlassian.com/platform/forge/storage-reference/kvs-transactions/)
- [Jira request authentication/routing](https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestjira/), [mypermissions scope](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/)
- [UI Kit components](https://developer.atlassian.com/platform/forge/ui-kit/components/), [packaging](https://developer.atlassian.com/platform/forge/manifest-reference/packaging/)
- [Official hackathon rules](https://codegeist2026.devpost.com/rules): installation/video requirements and Agents/MCP bonus paths agree with RULES.md. Rules say `rovo:action`; the current Forge module reference uses `action`. This entry also declares `rovo:agent` directly.
