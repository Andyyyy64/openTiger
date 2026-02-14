# Contributing to openTiger

Thanks for your interest in contributing.

## Before You Start

- Read `README.md` and `docs/README.md`.
- Check open issues before starting new work.
- For major changes, open an issue first to discuss scope and direction.

## Development Setup

```bash
pnpm install
pnpm run up
```

## Development Workflow

1. Create a branch from `main`.
2. Make focused changes.
3. Run checks locally:

   ```bash
   pnpm run check
   pnpm run test
   ```

4. Update docs when behavior, contracts, or operational flow changes.
5. Open a pull request.

## Pull Request Guidelines

- Keep PRs focused and reasonably small.
- Write clear PR descriptions: problem, approach, and verification.
- Include tests for behavior changes.
- Ensure CI is green before requesting review.

## Commit Guidance

- Use clear, imperative commit messages.
- Prefer small atomic commits.

## Documentation Requirements

If you change runtime state transitions, startup behavior, failure handling, or
ownership boundaries, update the corresponding documents in `docs/`.

## Reporting Issues

- Use issue templates when available.
- For security issues, follow `SECURITY.md` and do not report publicly.
