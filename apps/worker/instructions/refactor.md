# Refactoring Instructions

This document defines guidelines for refactoring existing code in openTiger worker tasks.

## Refactoring Principles

### 1. Do not change behavior

The objective of refactoring is better code quality, not feature changes.
Existing behavior must remain intact.

### 2. Work in small steps

Break large changes into small safe steps and verify after each step.

```text
1. Extract a function -> verify
2. Rename for clarity -> verify
3. Remove duplication -> verify
```

### 3. Trust tests, and add them when missing

If tests exist, keep them green through the refactor.
If tests are missing, add coverage before major structural changes.

## Common Refactor Patterns

### Extract function by responsibility

```typescript
// Before
async function processOrder(order: Order) {
  if (!order.items.length) throw new Error("Empty order");
  if (order.total < 0) throw new Error("Invalid total");

  for (const item of order.items) {
    const stock = await getStock(item.productId);
    if (stock < item.quantity) {
      throw new Error(`Insufficient stock: ${item.productId}`);
    }
  }

  await processPayment(order);
}

// After
async function processOrder(order: Order) {
  validateOrder(order);
  await checkInventory(order.items);
  await processPayment(order);
}
```

### Simplify conditionals

```typescript
const PREMIUM_DISCOUNTS = [
  { minTotal: 10000, rate: 0.2 },
  { minTotal: 5000, rate: 0.15 },
  { minTotal: 0, rate: 0.1 },
];

const REGULAR_DISCOUNTS = [
  { minTotal: 10000, rate: 0.1 },
  { minTotal: 0, rate: 0 },
];

function getDiscount(user: User, order: Order): number {
  const table = user.isPremium ? PREMIUM_DISCOUNTS : REGULAR_DISCOUNTS;
  return table.find((d) => order.total >= d.minTotal)?.rate ?? 0;
}
```

### Remove duplication

```typescript
function withTimestamps<T extends object>(data: T) {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    ...data,
    createdAt: now,
    updatedAt: now,
  };
}
```

### Replace magic numbers with constants

```typescript
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const HTTP_TOO_MANY_REQUESTS = 429;
```

## Safety Rules During Refactoring

### Do

- Verify before and after refactor
- Keep public API changes minimal
- Isolate refactor from feature development
- Keep change scope narrow and intentional

### Do not

- Perform large refactors without tests
- Mix feature additions with structural cleanup
- Change behavior unintentionally
- Edit unrelated files

## Completion Checklist

- [ ] All required tests pass
- [ ] Typecheck passes
- [ ] Lint passes
- [ ] Behavior remains unchanged
- [ ] Readability/maintainability is improved
