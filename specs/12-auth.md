# Module 12 — Authentication & Identity

Depends on: none structurally, but is a prerequisite for the "actor" identity that
`04-evidence-timeline.md`, `06-human-collaboration.md`, `07-slack-interface.md`,
`09-remediation.md`, and `10-teams-org.md` all assume exists.

## Purpose

Give every person interacting with Tracely — through the web dashboard or through Slack — a
real, authenticated identity, so "who did this" is never null or anonymous anywhere the rest
of the system needs an actor (audit logging, approvals, team-scoped access).

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-41 | A user can sign up and log in to the web dashboard via OAuth (Google or GitHub) — no separate password is stored or handled by Tracely. | MUST |
| FR-42 | A successful login establishes a session that resolves to one unique, persistent user id — this is the `actor` value NFR-10's audit logging and `09-remediation.md`'s approval gate require. | MUST |
| FR-43 | No unauthenticated request can read investigation data, query the Brain, or trigger any action on the web dashboard. | MUST |
| FR-44 | A Slack user's identity can be linked to their Tracely web account, so actions taken via Slack (FR-32/FR-33) and the web view (FR-34) attribute to the same actor for audit purposes. | SHOULD |
| FR-45 | First-time OAuth sign-in auto-provisions a user record; it does not require a manual admin-invite step for the MVP's single-company context. | SHOULD |

## Relevant NFRs

- NFR-7: session tokens/cookies encrypted in transit (existing NFR, applies here directly).
- NFR-8: this module is the identity prerequisite `10-teams-org.md`'s team/role-based
  authorization is built on top of — it does not itself implement team scoping.
- NFR-10: this module is where the `actor` value populated in every audit log entry comes
  from — before this module, `actor` had no real source (see `src/brain/index.ts`'s hook
  scaffold, which currently always passes `actor: undefined`).
- NFR-20 (new): session lifetime and invalidation policy — TBD, do not fill with a
  plausible-sounding number; a short default (e.g. browser-session cookie) is acceptable to
  start, but the actual expiry policy is a product decision, not an engineering guess.

## Out of scope for this module

- Building Tracely's own password storage/reset flow — OAuth-only for the MVP, per this
  repo's recurring "don't over-build enterprise scope" pattern (see `10-teams-org.md`'s Out of
  scope).
- Full RBAC/permission granularity — `10-teams-org.md` owns team-scoped access; this module
  only establishes *who* someone is, not what they're allowed to see.
- Enterprise SSO/SAML, multi-org identity federation, org invitation workflows beyond
  auto-provisioning a single-company user record (FR-45).
- Gating Slack usage itself on having a linked web account — `07-slack-interface.md`'s FR-32
  already assumes Slack workspace membership is sufficient authorization to initiate an
  investigation from Slack; this module adds an optional link for cross-surface actor
  attribution (FR-44), it does not add a new barrier to the Slack path.

## Test cases required

- An unauthenticated request to any protected web route is rejected, not silently served with
  partial/anonymous data.
- A successful OAuth login creates a new user record on first sign-in, or resolves to the same
  existing user record on a later sign-in with the same provider identity — never duplicates a
  user.
- The resulting session's actor id is the value that appears in a subsequent NFR-10 audit log
  entry for an action that user takes — not null, not a placeholder.
- OAuth provider unreachable or token exchange fails → a clear, explicit failure surfaced to
  the user, not a silent broken/half-authenticated state.
- An expired session prompts re-authentication rather than being granted continued access.
- A Slack user who links their account is subsequently attributed as the same actor for both a
  Slack-initiated action and a web-dashboard action (FR-44).

## Definition of Done

- A user can complete OAuth sign-in on the web dashboard and reach an authenticated view for
  at least one provider (Google or GitHub).
- An authenticated actor id flows into NFR-10's audit hook and is available to
  `09-remediation.md`'s approval gate — no module downstream of this one still has a
  null/placeholder actor.
- All required test cases pass.

## Suggested first Claude Code session

Pick one provider (GitHub is the more natural fit given this is an engineering-tool audience)
and get end-to-end OAuth login working — "log in, see your own real user id in a test
request" — before wiring session-to-actor propagation into the NFR-10 audit hook or touching
Slack account linking (FR-44), which can come after the core login path is solid.
