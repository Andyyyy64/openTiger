# バグ修正指示

このドキュメントは、openTiger Workerがバグを修正する際のガイドラインを定義します。

## バグ修正の原則

### 1. まず再現する

バグを修正する前に、そのバグを再現できることを確認します。

```typescript
// 失敗するテストを書く
it("ユーザー名が空の場合にエラーを投げるべき", () => {
  // このテストが失敗することを確認してから修正に着手
  expect(() => createUser({ name: "" })).toThrow(ValidationError);
});
```

### 2. 根本原因を特定する

表面的な症状ではなく、根本原因を特定してから修正します。

```
症状: ユーザー作成が失敗する
表面的な対処: try-catchでエラーを握りつぶす ← NG
根本原因の調査: なぜ失敗するのか？
- バリデーションエラー？
- DB接続エラー？
- 権限エラー？
根本原因の修正: バリデーションロジックを修正 ← OK
```

### 3. 修正は最小限に

バグ修正に必要な変更のみを行い、「ついでに」のリファクタリングは別のタスクにします。

## バグ修正の手順

### Step 1: バグの理解

エラーメッセージ、スタックトレース、ログを確認します。

```
Error: Cannot read property 'id' of undefined
    at getUserName (src/services/user.ts:42:15)
    at processRequest (src/api/handler.ts:23:10)
```

この場合、`src/services/user.ts`の42行目で`undefined`にアクセスしています。

### Step 2: 再現テストを書く

```typescript
describe("getUserName", () => {
  it("ユーザーが見つからない場合にエラーを投げる", async () => {
    // 存在しないユーザーIDを渡す
    await expect(getUserName("non-existent-id")).rejects.toThrow(UserNotFoundError);
  });
});
```

### Step 3: 原因を特定

コードを読んで原因を特定します。

```typescript
// 問題のあるコード
async function getUserName(userId: string): Promise<string> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  // userがundefinedの場合にエラーが発生
  return user.name; // ← ここでundefinedにアクセス
}
```

### Step 4: 修正を実装

```typescript
// 修正後
async function getUserName(userId: string): Promise<string> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  // nullチェックを追加
  if (!user) {
    throw new UserNotFoundError(userId);
  }

  return user.name;
}
```

### Step 5: テストが通ることを確認

```bash
検証コマンドを実行
```

### Step 6: 関連するテストを追加

類似のバグが他の場所にないか確認し、必要に応じてテストを追加します。

## よくあるバグパターンと修正

### Null/Undefined チェック漏れ

```typescript
// Before: nullチェックなし
function getFirstItem<T>(items: T[]): T {
  return items[0]; // 空配列でundefined
}

// After: 適切なエラーハンドリング
function getFirstItem<T>(items: T[]): T {
  if (items.length === 0) {
    throw new Error("Array is empty");
  }
  return items[0]!;
}

// または、undefinedを返すことを明示
function getFirstItem<T>(items: T[]): T | undefined {
  return items[0];
}
```

### 非同期処理のエラー

```typescript
// Before: awaitなしでPromiseを返す
async function fetchData() {
  try {
    return fetch("/api/data"); // awaitがない
  } catch (error) {
    // このcatchは実行されない
    console.error(error);
  }
}

// After: 適切にawait
async function fetchData() {
  try {
    return await fetch("/api/data");
  } catch (error) {
    console.error(error);
    throw error;
  }
}
```

### 状態の競合

```typescript
// Before: 競合状態の可能性
let counter = 0;

async function increment() {
  const current = counter;
  await someAsyncOperation();
  counter = current + 1; // 競合する可能性
}

// After: アトミックな操作を使用
import { Mutex } from "async-mutex";

const mutex = new Mutex();
let counter = 0;

async function increment() {
  await mutex.runExclusive(async () => {
    counter += 1;
    await someAsyncOperation();
  });
}
```

### 境界値のバグ

```typescript
// Before: off-by-oneエラー
function getPage(items: Item[], page: number, pageSize: number) {
  const start = page * pageSize;
  const end = start + pageSize;
  return items.slice(start, end); // page=1で最初のページではない
}

// After: 1-indexedを考慮
function getPage(items: Item[], page: number, pageSize: number) {
  if (page < 1) throw new Error("Page must be >= 1");
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}
```

## チェックリスト

バグ修正完了前に確認：

- [ ] バグを再現するテストを書いた
- [ ] そのテストが修正前に失敗することを確認した
- [ ] 根本原因を特定した
- [ ] 最小限の変更で修正した
- [ ] 修正後にテストが通る
- [ ] 既存のすべてのテストも通る
- [ ] 型チェックが通る（`pnpm typecheck`）
- [ ] Lintが通る（`pnpm lint`）
- [ ] 類似のバグがないか確認した

## やってはいけないこと

- エラーを握りつぶす
- 再現テストなしで修正する
- 根本原因を調べずに対症療法的な修正をする
- 修正と同時に無関係なリファクタリングをする
- テストをスキップする
