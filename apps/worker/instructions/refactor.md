# リファクタリング指示

このドキュメントは、sebastian-code Workerが既存コードをリファクタリングする際のガイドラインを定義します。

## リファクタリングの原則

### 1. 動作を変えない

リファクタリングの目的は**コードの品質を向上させること**であり、機能を変更することではありません。

```typescript
// リファクタリング前後で同じテストが通ること
pnpm test
```

### 2. 小さなステップで進める

大きな変更は小さなステップに分割し、各ステップでテストが通ることを確認します。

```
1. 関数を抽出 → テスト
2. 変数名を変更 → テスト
3. 重複を除去 → テスト
```

### 3. 既存のテストを信頼する

テストがある場合は、リファクタリング中もテストが通ることを確認しながら進めます。
テストがない場合は、まずテストを追加してからリファクタリングを行います。

## よくあるリファクタリングパターン

### 関数の抽出

```typescript
// Before: 長い関数
async function processOrder(order: Order) {
  // バリデーション（10行）
  if (!order.items.length) throw new Error("Empty order");
  if (order.total < 0) throw new Error("Invalid total");
  // ... more validation

  // 在庫チェック（15行）
  for (const item of order.items) {
    const stock = await getStock(item.productId);
    if (stock < item.quantity) {
      throw new Error(`Insufficient stock: ${item.productId}`);
    }
  }
  // ... more stock checks

  // 支払い処理（20行）
  // ...
}

// After: 責務ごとに関数を分割
async function processOrder(order: Order) {
  validateOrder(order);
  await checkInventory(order.items);
  await processPayment(order);
}

function validateOrder(order: Order): void {
  if (!order.items.length) throw new Error("Empty order");
  if (order.total < 0) throw new Error("Invalid total");
}

async function checkInventory(items: OrderItem[]): Promise<void> {
  for (const item of items) {
    const stock = await getStock(item.productId);
    if (stock < item.quantity) {
      throw new Error(`Insufficient stock: ${item.productId}`);
    }
  }
}
```

### 条件分岐の簡素化

```typescript
// Before: ネストが深い
function getDiscount(user: User, order: Order): number {
  if (user.isPremium) {
    if (order.total > 10000) {
      return 0.2;
    } else if (order.total > 5000) {
      return 0.15;
    } else {
      return 0.1;
    }
  } else {
    if (order.total > 10000) {
      return 0.1;
    } else {
      return 0;
    }
  }
}

// After: 早期リターンとテーブル駆動
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
  const discounts = user.isPremium ? PREMIUM_DISCOUNTS : REGULAR_DISCOUNTS;
  const discount = discounts.find((d) => order.total >= d.minTotal);
  return discount?.rate ?? 0;
}
```

### 重複の除去

```typescript
// Before: 重複したコード
async function createUser(data: UserInput) {
  const id = crypto.randomUUID();
  const now = new Date();
  return db.insert(users).values({
    id,
    ...data,
    createdAt: now,
    updatedAt: now,
  });
}

async function createTask(data: TaskInput) {
  const id = crypto.randomUUID();
  const now = new Date();
  return db.insert(tasks).values({
    id,
    ...data,
    createdAt: now,
    updatedAt: now,
  });
}

// After: 共通ロジックを抽出
function withTimestamps<T extends object>(data: T) {
  return {
    id: crypto.randomUUID(),
    ...data,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function createUser(data: UserInput) {
  return db.insert(users).values(withTimestamps(data));
}

async function createTask(data: TaskInput) {
  return db.insert(tasks).values(withTimestamps(data));
}
```

### マジックナンバーの定数化

```typescript
// Before
if (retryCount > 3) {
  throw new Error("Max retries exceeded");
}

await sleep(5000);

if (response.status === 429) {
  // rate limited
}

// After
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const HTTP_TOO_MANY_REQUESTS = 429;

if (retryCount > MAX_RETRIES) {
  throw new Error("Max retries exceeded");
}

await sleep(RETRY_DELAY_MS);

if (response.status === HTTP_TOO_MANY_REQUESTS) {
  // rate limited
}
```

## リファクタリング時の注意事項

### やるべきこと

- 変更前にテストが通ることを確認
- 小さな変更ごとにテストを実行
- コミットは小さく、意図が明確なメッセージで
- 公開APIの変更は最小限に

### やってはいけないこと

- テストなしで大規模な変更を行う
- 機能追加とリファクタリングを同時に行う
- 既存の動作を変える変更（それはリファクタリングではない）
- 関係ないファイルを変更する

## チェックリスト

リファクタリング完了前に確認：

- [ ] すべてのテストが通る
- [ ] 型チェックが通る（`pnpm typecheck`）
- [ ] Lintが通る（`pnpm lint`）
- [ ] 動作が変わっていないことを確認
- [ ] コードが読みやすくなったことを確認
