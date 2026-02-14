# Goal

Build an internal purchase request and approval web application called "FlowProcure".
The product must support request creation, multi-step approval, rejection with reasons, and final purchasing records with auditable history.

## Background

Purchase requests are currently handled through spreadsheets and chat threads, causing missing approvals, unclear ownership, and delayed processing.
We need a minimal but reliable approval baseline that can be operated daily and extended later.

## Constraints

- Keep Monorepo (pnpm workspaces)
- Backend: Hono
- Frontend: React + Tailwind CSS
- Database: PostgreSQL + Drizzle ORM
- Do not change the technology stack above

## Acceptance Criteria

- [ ] Users can create a purchase request with title, description, amount, currency, requester name, and department
- [ ] Request list view supports filtering by status, requester, and date range
- [ ] Approval flow supports at least two stages (`manager` -> `finance`) before final approval
- [ ] Approvers can approve or reject, and rejection requires a reason
- [ ] Request status transitions are validated server-side and invalid transitions are rejected
- [ ] Approved requests are marked as purchasable and stored with approval metadata (who, when, stage)
- [ ] UI shows a full request timeline (created, approved/rejected, comments)
- [ ] API and UI validation return clear user-understandable error messages for missing/invalid fields
- [ ] Critical-path E2E tests exist (create request -> manager approval -> finance approval -> finalize, plus rejection path)
- [ ] Unit and integration tests exist using Vitest

## Scope

## In Scope

- Purchase request and approval-related DB schema definitions
- API implementation for request lifecycle and transitions
- Frontend implementation for requester and approver workflows
- Validation implementation (both API and frontend)
- Audit timeline implementation
- Test implementation (E2E, Vitest unit, Vitest integration)

## Out of Scope

- External ERP/accounting integrations
- Authentication with SSO providers
- Email/Slack notification integrations
- Budget forecasting and analytics dashboards
- Mobile native applications

## Allowed Paths

- packages/db/**
- apps/api/**
- apps/web/**

## Risk Assessment

- Approval transition bugs can allow unauthorized state changes
- Race conditions may create inconsistent approval stage states
- Validation mismatch between API and UI can confuse users
- Timeline/audit data gaps can reduce traceability in operations

## Notes

Keep the initial implementation simple but extendable.
Model state transitions explicitly so future policy changes remain low-risk.
Prefer deterministic tests around lifecycle transitions and concurrent approvals.
