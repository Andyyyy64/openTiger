# Goal

Build an internal meeting-room reservation web application called "RoomFlow".
The product must support availability lookup, reservation creation, reservation updates, and cancellation, while reliably preventing booking conflicts.

## Background

Meeting-room reservations are currently managed through chat and verbal coordination, which causes double bookings and poor visibility.
We need a minimal but robust reservation baseline that works reliably in daily operations.

## Constraints

- Keep Monorepo (pnpm workspaces)
- Backend: Hono
- Frontend: React + Tailwind CSS
- Database: PostgreSQL + Drizzle ORM
- Do not change the technology stack above

## Acceptance Criteria

- [ ] A room list is displayed (name, capacity, equipment)
- [ ] Users can check availability by date and room
- [ ] Users can create reservations (meeting title, start time, end time, organizer name)
- [ ] Users can update existing reservations
- [ ] Users can cancel reservations (with confirmation to prevent accidental actions)
- [ ] The API rejects overlapping reservations for the same room and time window
- [ ] The list view supports filtering by room and date
- [ ] Missing required fields return validation errors in both API and UI
- [ ] API errors are shown with user-understandable messages
- [ ] Critical-path E2E tests exist (availability check -> reservation create -> overlap rejection -> reservation update -> reservation cancel)
- [ ] Unit and integration tests exist using Vitest

## Scope

## In Scope

- Room and reservation DB schema definitions
- API implementation
- Frontend implementation
- Validation implementation (both API and frontend)
- Consistency implementation for conflict prevention
- Test implementation (E2E, Vitest unit, Vitest integration)

## Out of Scope

- Authentication and authorization
- External calendar integrations (Google Calendar, etc.)
- Notification features (email, Slack)
- Real-time sync

## Allowed Paths

- packages/db/\*\*
- apps/api/\*\*
- apps/web/\*\*

## Risk Assessment

- Validation mismatch between API and UI
- Missing conflict handling during concurrent updates
- Test flakiness caused by timing dependencies

## Notes

Use a modern UI.
A minimal implementation is acceptable, but keep the design testable through clear responsibility separation.
For reservation conflict control, apply safeguards at both DB and API layers.
