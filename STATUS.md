# Status

Local only. Not registered, not deployed, not submitted.

- Policy gate, approvals, storage, service, actions, resolvers, UI Kit page, manifest, SKILL.md, agent prompt: written.
- `npm test`: see latest run in the commit log / review notes.
- Manifest validates against the JSON schema bundled in @forge/cli 15.0.0 (`scripts/validate-manifest.cjs`).

## Blocked on an Atlassian login
- `forge register` (real app.id), `forge lint` (needs login even offline), `forge deploy`, `forge install`,
  installation link for judges, Rovo/MCP live test, UI Kit render check, video.
- `npm install` of @forge/* deps timed out in the sandbox; unit tests don't need them.

## To verify on a real site
- action handler `context.accountId` and `payload.context.jira.issueKey` shapes
- `api.asUser().requestJira` inside action functions
- KVS error code for `keyPolicy: FAIL_IF_EXISTS` conflicts (src/store/kvs.js)
- scopes: `read:jira-user` needed for mypermissions? (lint will tell)
