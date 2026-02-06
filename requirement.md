# Goal

開発者がコードスニペットを保存・閲覧・削除できるシンプルなWebアプリ「ClipHive」を構築する。

# Background

スニペットを素早くメモし、後で検索できる場所が必要です。

# Constraints

- Monorepo (pnpm workspaces) を維持する
- Backend: Hono
- Frontend: React + Tailwind CSS
- Database: PostgreSQL + Drizzle ORM

# Acceptance Criteria

- [ ] スニペットの保存ができる（タイトル、コード、言語）
- [ ] スニペットの一覧が表示される
- [ ] スニペットの削除ができる

# Scope

## In Scope

- DBスキーマ定義
- APIの実装
- フロントエンドの実装

## Out of Scope

- ユーザー認証（今回は不要）
- 検索機能（今回は不要）

# Allowed Paths

- packages/db/**
- apps/api/**
- apps/web/**

# Risk Assessment

- 特になし

# Notes

モダンなUIで実装してください。
