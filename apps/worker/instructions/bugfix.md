# Bug Fix Instructions

This document defines guidelines for fixing bugs in the openTiger worker flow.

## Core Principles

### 1. Reproduce first

Before changing code, confirm the bug is reproducible.

```typescript
// Write a failing test first.
it("throws when name is empty", () => {
  expect(() => createUser({ name: "" })).toThrow(ValidationError);
});
```

### 2. Find the root cause

Do not patch symptoms only. Identify why the issue happens.

```text
Symptom: user creation fails
Bad fix: swallow errors in try/catch
Good fix: identify failing validation rule and correct it
```

### 3. Keep the fix minimal

Only change what is required to resolve the bug. Move unrelated cleanup to a separate task.

## Bug Fix Workflow

### Step 1: Understand the failure

Inspect error messages, stack traces, and logs.

```text
Error: Cannot read property 'id' of undefined
    at getUserName (src/services/user.ts:42:15)
    at processRequest (src/api/handler.ts:23:10)
```

### Step 2: Add a reproduction test

```typescript
describe("getUserName", () => {
  it("throws when user does not exist", async () => {
    await expect(getUserName("missing-id")).rejects.toThrow(UserNotFoundError);
  });
});
```

### Step 3: Inspect the source

```typescript
// Problematic code
async function getUserName(userId: string): Promise<string> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return user.name; // crashes when user is undefined
}
```

### Step 4: Implement a targeted fix

```typescript
async function getUserName(userId: string): Promise<string> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

  if (!user) {
    throw new UserNotFoundError(userId);
  }

  return user.name;
}
```

### Step 5: Run required verification

Run all verification commands required by the task.

### Step 6: Add nearby regression coverage

Check for similar failure patterns and add tests if needed.

## Common Bug Patterns

### Missing null or undefined checks

```typescript
// Before
function getFirstItem<T>(items: T[]): T {
  return items[0];
}

// After
function getFirstItem<T>(items: T[]): T {
  if (items.length === 0) {
    throw new Error("Array is empty");
  }
  return items[0];
}
```

### Async error handling mistakes

```typescript
// Before
async function fetchData() {
  try {
    return fetch("/api/data");
  } catch (error) {
    console.error(error);
  }
}

// After
async function fetchData() {
  try {
    return await fetch("/api/data");
  } catch (error) {
    console.error(error);
    throw error;
  }
}
```

### Race conditions

```typescript
// Before
let counter = 0;

async function increment() {
  const current = counter;
  await someAsyncOperation();
  counter = current + 1;
}
```

Use atomic updates or proper locking primitives where needed.

### Boundary value bugs

```typescript
// Before
function getPage(items: Item[], page: number, pageSize: number) {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}

// After
function getPage(items: Item[], page: number, pageSize: number) {
  if (page < 1) throw new Error("Page must be >= 1");
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
```

## Checklist

Before finishing:

- [ ] Added a test that reproduces the bug
- [ ] Confirmed the test fails before the fix
- [ ] Identified the root cause
- [ ] Applied a minimal, focused fix
- [ ] Confirmed required tests pass
- [ ] Confirmed typecheck and lint pass
- [ ] Reviewed nearby code for similar issues

## Anti-Patterns

- Swallowing errors
- Fixing without a reproduction test
- Symptom-only patching without root cause analysis
- Mixing feature work with bug fix work
- Skipping verification
