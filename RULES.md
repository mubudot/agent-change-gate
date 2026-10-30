# Codegeist 2026 — rules digest

Sources (read 2026-10-30): https://codegeist2026.devpost.com/ , https://codegeist2026.devpost.com/rules ,
https://codegeist2026.devpost.com/resources , module docs on developer.atlassian.com (linked below).
Updates page: no announcements yet. Where this digest and the Official Rules differ, the Official Rules win.

## Key dates

| What | Pacific (official) | UTC+8 |
|---|---|---|
| Registration + submission open | Tue 2026-10-27 09:00 PDT | Wed 2026-10-28 00:00 |
| **Submission deadline** (also registration close) | **Tue 2026-12-22 12:00 PST** | **Wed 2026-12-23 04:00** |
| Judging | 2027-01-05 13:00 PT – 2027-02-03 17:00 PT | |
| Winners announced | ~2027-02-15 09:00 PT | |

Drafts can be saved on Devpost; after the deadline the submission cannot be changed.

## What must be built (Project Requirements)

- An app on **Atlassian Forge** that integrates with at least one of: Jira, Confluence, Jira Service Management, Bitbucket, Teamwork Graph, Rovo.
- Must fit one **category**: Apps for Software Teams / Apps for Business Teams / Apps for Specialized Industries.
- Must be **installable in a judge's test environment via an installation link**, run consistently, and work as shown in the video/text.
- New projects, or existing ones updated/rebuilt on Forge after 2026-10-27 with a Forge manifest and ≥1 Forge module.
- Third-party SDKs/APIs/data only if we are authorized to use them.
- Not developed with financial/preferential support from Atlassian or Devpost.

**Not required by the rules** (checked): "Runs on Atlassian" badge, Rovo usage, a public code repo, an
open-source license. "Runs on Atlassian" is only a Marketplace badge (no egress except analytics); our design
is eligible anyway because it uses only Forge compute + KVS and no egress. Rovo is only needed for the Agents/MCP bonus prizes.

## What must be submitted (Devpost form)

1. **Installation link** for judges + "all necessary instructions" (every config step) — created via the developer
   console "Start sharing your app" flow: https://developer.atlassian.com/platform/forge/distribute-your-apps/#start-sharing-your-app
   (requires a deployed app → needs an Atlassian login and `forge deploy` to production or the env we share).
2. **Demo video**: should be **< 5 minutes** (judges need not watch past **3 minutes**), show the project working
   on its platform, **uploaded publicly to YouTube**, no third-party trademarks / copyrighted music without permission.
3. **Text description** of features and functionality.
4. **Explanation of how it meets the main technology requirement** (Forge + Atlassian product).
5. **Category + bonus prizes selected**, plus any bonus-prize write-up/materials.
6. Everything in **English** (or with English translations).

A source repo URL is not listed as required (Devpost may have an optional field). We will still keep a clean repo.

## Prizes

| Prize | Amount | Qty |
|---|---|---|
| 1st place (1 per category) | $15,000 + 2 Team '27 tickets (no travel), blog, swag | 3 |
| 2nd place (1 per category) | $8,000 | 3 |
| 3rd place (1 per category) | $5,000 | 3 |
| Best Agents – Rovo/Assignable agents | $1,500 | 6 |
| Best app with Atlassian MCP | $1,500 | 6 |
| Best apps with Teamwork Graph integration | $1,500 | 6 |
| Best Marketplace published app | $1,500 | 6 |
| Participation: Atlassian developer swag pack | first 300 eligible entrants | 300 |

**One submission can win at most one Grand Prize AND one Bonus Prize.** One entrant may submit several
substantially different projects. Participation prize max one per entrant.

### Bonus-prize eligibility (exact)

- **Best Agents**: Forge app with the `rovo:agent` module, the `rovo:agentConnector` module, **or** reusable `rovo:skill` and `rovo:action` modules other agents can invoke as tools.
- **Best app with Atlassian MCP**: Forge app that exposes tools via the Atlassian (Rovo) MCP server using the **`rovo:mcp`** module; may be combined with open-source `skill.md` files users add to third-party agents.
- **Best Teamwork Graph**: connects data into the graph (Teamwork Graph connector) and/or consumes data from the Teamwork Graph API.
- **Best Marketplace published app**: published to the Marketplace **or submitted for listing**; give the listing link or the Marketplace review ticket link.

Sponsor may move a project between categories/bonus prizes.

## Judging

Stage 1 pass/fail: fits theme and reasonably uses the required APIs/SDKs.
Stage 2, equal weight (20 % each): **Technological implementation** (thorough, non-trivial use of Forge + product),
**Design** (complete coherent product, not a PoC), **Potential impact** (credible real problem/audience, shown solved),
**Innovation/idea**, **Presentation** (video shows it end-to-end; problem/who/why clear).
Ties broken by the criteria in that order.

## Eligibility (solo entrant)

- Individuals at or above the age of majority where they live.
- Excluded: Brazil, Quebec, Russia, Belarus, Crimea, Cuba, Iran, North Korea, Syria, Sudan, Myanmar, other OFAC-sanctioned places; sanctioned-list persons; Atlassian/Devpost staff, judges, their families. Solo entry is allowed.
- Winners must complete an **identity/role verification + affidavit** within 10 business days, and a tax form (W-9 or W-8BEN). Prize by mail or bank transfer; winner pays fees/taxes; sponsor may withhold tax.

## AI tools

The Official Rules contain **no clause on AI-assisted coding and no AI-disclosure requirement.** Relevant constraints:
the submission must be the entrant's original work and solely owned (third-party technical assistance is allowed if
the result is the entrant's own work and they own all rights); the Rovo pages require compliance with the Atlassian
Acceptable Use Policy (AI section), and Atlassian may safety-screen agents. We will still add a short, honest
"Built with" note (AI-assisted development) in the README/Devpost text — voluntary, not mandated.

## IP / publicity

- Submission stays the entrant's IP. Atlassian gets a non-exclusive, fully paid licence to use it **for judging**;
  Atlassian and Devpost may promote it and use the entrant's name, likeness, voice and image for 3 years.
- Open-source components allowed if licences are respected and our work builds on them.
- Content must not infringe third-party rights; video must not use unlicensed music/trademarks.
- Disputes: AAA arbitration, New York law.

## Accounts the user must create / own

| Account | Needed for | Cost / ID |
|---|---|---|
| **Devpost** | register ("Join hackathon"), submission form | free; already exists (mubudot, via GitHub). Registration itself not done yet. |
| **Atlassian account** (id.atlassian.com) | Forge CLI login (API token with Forge scopes), developer console, sites | free; email + password; no ID |
| **Atlassian Cloud developer site** (https://go.atlassian.com/cloud-dev, or `forge install --demo-site` → 90-day seeded demo site) | install/test the app, record the video; **Rovo must be activated on the site** to use agents/MCP tools | free developer licence; no payment card stated |
| Atlassian **API token with scopes** (Forge) | `forge login` / `FORGE_EMAIL` + `FORGE_API_TOKEN` env vars (no keychain here) | free |
| **YouTube** (Google account) | public demo video | free |
| Atlassian **Marketplace partner/vendor profile** | only if we go for the Marketplace bonus | free to create; listing needs privacy policy, support contact, security questionnaire — not planned yet |

Payment / ID: **no purchase or payment is needed to enter or win** (Official Rules). ID verification applies **only to
potential winners** (affidavit). Unverified: whether Atlassian asks for a card on the developer site or for Rovo
on the dev site — the free developer licence page did not mention one; check when signing up.
