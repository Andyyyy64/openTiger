# Coding Guidelines

This document defines coding standards for openTiger workers implementing new code.

## Core Principles

### 1. Prioritize type safety

```typescript
// Bad
const data = response as any;

// Good
function isUser(data: unknown): data is User {
  return typeof data === "object" && data !== null && "id" in data && "name" in data;
}
```

Avoid forcing type errors away with `any` or unsafe assertions.

### 2. Handle errors explicitly

```typescript
// Bad
try {
  await doSomething();
} catch {}

// Good
try {
  await doSomething();
} catch (error) {
  logger.error("Failed to do something", { error });
  throw new ApplicationError("Operation failed", { cause: error });
}
```

### 3. Prefer early returns

```typescript
function process(data: Data | null) {
  if (!data) return;
  if (!data.isValid) return;
  if (data.items.length === 0) return;

  // main path
}
```

## TypeScript Style Guide

### Naming

| Item              | Rule             | Example                              |
| ----------------- | ---------------- | ------------------------------------ |
| variables/functions | camelCase      | `getUserById`, `isValid`             |
| constants         | UPPER_SNAKE_CASE | `MAX_RETRIES`, `DEFAULT_TIMEOUT`     |
| types/interfaces  | PascalCase       | `User`, `TaskConfig`                 |
| enum values       | PascalCase       | `Status.Running`, `Role.Admin`       |
| file names        | kebab-case       | `user-service.ts`, `api-client.ts`   |

### Runtime validation + types

```typescript
import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  createdAt: z.date(),
});

export type User = z.infer<typeof UserSchema>;
```

### Function signatures

When argument count grows, use an options object.

```typescript
interface CreateTaskOptions {
  title: string;
  goal: string;
  priority?: number;
  allowedPaths: string[];
  commands: string[];
  dependencies?: string[];
}

function createTask(options: CreateTaskOptions) {}
```

### Async conventions

```typescript
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch user: ${response.status}`);
  }

  const data = await response.json();
  return UserSchema.parse(data);
}
```

Use `Promise.all` when operations are independent.

## Comment and API Doc Guidelines

### Keep comments clear and intentional

Explain intent or non-obvious tradeoffs. Do not describe trivial assignments.

```typescript
// Refresh sessions that are close to expiration to reduce mid-request failures.
if (isExpiringSoon(session)) {
  return await refreshSession(session);
}
```

### Use JSDoc only for public APIs

```typescript
/**
 * Create a task and enqueue it.
 * @throws {ValidationError} when input is invalid
 */
export async function createTask(options: CreateTaskOptions): Promise<Task> {
  // implementation
}
```

## Testing Guidelines

### Placement

```
src/
  services/
    user-service.ts
test/
  services/
    user-service.test.ts
```

### Structure

```typescript
describe("UserService", () => {
  describe("createUser", () => {
    it("creates a user with valid input", async () => {
      const input = { name: "Test", email: "test@example.com" };
      const user = await userService.createUser(input);

      expect(user.name).toBe("Test");
      expect(user.id).toBeDefined();
    });
  });
});
```

## Prohibited Patterns

- Using `any`
- Overusing assertions (`as`)
- Using `// @ts-ignore` or `// @ts-expect-error`
- Committing `console.log` (use logger utilities)
- Committing skipped tests (`it.skip`, `describe.skip`)
- Leaving unused imports or variables
- Hardcoding secrets (use environment variables)
