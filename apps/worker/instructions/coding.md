# コーディング規約

このドキュメントは、openTiger Workerが新しいコードを実装する際に従うべき規約を定義します。

## 基本原則

### 1. 型安全性を最優先

```typescript
// NG: any型や型アサーションで無理やり通す
const data = response as any;
const user = data.user as User;

// OK: 適切な型ガードを使用
function isUser(data: unknown): data is User {
  return (
    typeof data === "object" &&
    data !== null &&
    "id" in data &&
    "name" in data
  );
}

if (isUser(data)) {
  // ここでdataはUser型として扱える
}
```

### 2. 明示的なエラーハンドリング

```typescript
// NG: エラーを握りつぶす
try {
  await doSomething();
} catch {
  // 何もしない
}

// OK: エラーを適切に処理
try {
  await doSomething();
} catch (error) {
  logger.error("Failed to do something", { error });
  throw new ApplicationError("Operation failed", { cause: error });
}
```

### 3. 早期リターン

```typescript
// NG: ネストが深い
function process(data: Data | null) {
  if (data) {
    if (data.isValid) {
      if (data.items.length > 0) {
        // 処理
      }
    }
  }
}

// OK: 早期リターンでフラットに
function process(data: Data | null) {
  if (!data) return;
  if (!data.isValid) return;
  if (data.items.length === 0) return;

  // 処理
}
```

## TypeScript スタイルガイド

### 命名規則

| 種類 | 規則 | 例 |
|------|------|-----|
| 変数・関数 | camelCase | `getUserById`, `isValid` |
| 定数 | UPPER_SNAKE_CASE | `MAX_RETRIES`, `DEFAULT_TIMEOUT` |
| 型・インターフェース | PascalCase | `User`, `TaskConfig` |
| Enumの値 | PascalCase | `Status.Running`, `Role.Admin` |
| ファイル名 | kebab-case | `user-service.ts`, `api-client.ts` |

### 型定義

```typescript
// Zodスキーマを使用してランタイム検証と型を統合
import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  createdAt: z.date(),
});

export type User = z.infer<typeof UserSchema>;
```

### 関数定義

```typescript
// 引数が多い場合はオブジェクトで受け取る
// NG
function createTask(
  title: string,
  goal: string,
  priority: number,
  allowedPaths: string[],
  commands: string[],
  dependencies?: string[]
) {}

// OK
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

### 非同期処理

```typescript
// async/awaitを使用
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch user: ${response.status}`);
  }
  
  const data = await response.json();
  return UserSchema.parse(data);
}

// 並列実行が可能な場合はPromise.allを使用
const [user, tasks] = await Promise.all([
  fetchUser(userId),
  fetchTasks(userId),
]);
```

## コメント規約

### 日本語でコメントを記述

```typescript
// ユーザーのセッションを検証し、有効期限が切れている場合は更新する
async function validateSession(sessionId: string): Promise<Session> {
  const session = await getSession(sessionId);
  
  // セッションが存在しない場合はエラー
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  
  // 有効期限が近い場合は更新
  if (isExpiringSoon(session)) {
    return await refreshSession(session);
  }
  
  return session;
}
```

### JSDocは公開APIにのみ

```typescript
/**
 * タスクを作成してキューに追加する
 * @param options タスク作成オプション
 * @returns 作成されたタスク
 * @throws {ValidationError} 入力が不正な場合
 */
export async function createTask(
  options: CreateTaskOptions
): Promise<Task> {
  // 実装
}
```

## テスト規約

### テストファイルの配置

```
src/
  services/
    user-service.ts
test/
  services/
    user-service.test.ts
```

### テストの構造

```typescript
describe("UserService", () => {
  describe("createUser", () => {
    it("有効な入力でユーザーを作成できる", async () => {
      // Arrange
      const input = { name: "Test", email: "test@example.com" };
      
      // Act
      const user = await userService.createUser(input);
      
      // Assert
      expect(user.name).toBe("Test");
      expect(user.id).toBeDefined();
    });

    it("無効なメールアドレスでエラーを投げる", async () => {
      const input = { name: "Test", email: "invalid" };
      
      await expect(userService.createUser(input)).rejects.toThrow(
        ValidationError
      );
    });
  });
});
```

## 禁止事項

- `any`型の使用
- 型アサーション（`as`）の乱用
- `// @ts-ignore` や `// @ts-expect-error` の使用
- `console.log` のコミット（ロガーを使用すること）
- テストのスキップ（`it.skip`, `describe.skip`）のコミット
- 未使用のインポート・変数
- ハードコードされた秘密情報（環境変数を使用）
