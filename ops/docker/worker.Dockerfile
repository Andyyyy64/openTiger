# h1ve Worker用Dockerfile
# サンドボックス環境でClaude Codeを使用してタスクを実行

# ==============================
# ベースステージ: 依存関係のインストール
# ==============================
FROM node:20-alpine AS base

# pnpmをインストール
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# 必要なツールをインストール
RUN apk add --no-cache \
    git \
    openssh-client \
    curl \
    bash

# GitHub CLIをインストール
RUN apk add --no-cache github-cli

# 作業ディレクトリを設定
WORKDIR /app

# ==============================
# 依存関係インストールステージ
# ==============================
FROM base AS deps

# pnpm-lock.yamlとworkspace設定をコピー
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# 各パッケージのpackage.jsonをコピー
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/vcs/package.json packages/vcs/
COPY packages/queue/package.json packages/queue/
COPY apps/worker/package.json apps/worker/

# 依存関係をインストール
RUN pnpm install --frozen-lockfile

# ==============================
# ビルドステージ
# ==============================
FROM deps AS builder

# TypeScript設定をコピー
COPY tsconfig.base.json turbo.json ./
COPY packages/core/tsconfig.json packages/core/
COPY packages/db/tsconfig.json packages/db/
COPY packages/llm/tsconfig.json packages/llm/
COPY packages/vcs/tsconfig.json packages/vcs/
COPY packages/queue/tsconfig.json packages/queue/
COPY apps/worker/tsconfig.json apps/worker/

# ソースコードをコピー
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/llm/src packages/llm/src
COPY packages/vcs/src packages/vcs/src
COPY packages/queue/src packages/queue/src
COPY apps/worker/src apps/worker/src
COPY apps/worker/instructions apps/worker/instructions

# ポリシー定義をコピー
COPY packages/policies packages/policies

# Drizzle設定をコピー
COPY packages/db/drizzle.config.ts packages/db/

# ビルド
RUN pnpm build --filter=@h1ve/worker...

# ==============================
# 実行ステージ
# ==============================
FROM base AS runner

# セキュリティ: 非rootユーザーで実行
RUN addgroup --system --gid 1001 h1ve && \
    adduser --system --uid 1001 --ingroup h1ve worker

# Workerの作業ディレクトリを作成
RUN mkdir -p /workspace && chown worker:h1ve /workspace

# ビルド済みアプリケーションをコピー
COPY --from=builder --chown=worker:h1ve /app/node_modules ./node_modules
COPY --from=builder --chown=worker:h1ve /app/packages ./packages
COPY --from=builder --chown=worker:h1ve /app/apps/worker ./apps/worker
COPY --from=builder --chown=worker:h1ve /app/package.json ./
COPY --from=builder --chown=worker:h1ve /app/pnpm-workspace.yaml ./

# Gitの設定（コミット用）
RUN git config --system user.name "h1ve-worker" && \
    git config --system user.email "worker@h1ve.ai"

# 非rootユーザーに切り替え
USER worker

# 環境変数のデフォルト値
ENV NODE_ENV=production
ENV WORKSPACE_PATH=/workspace
ENV LOG_FORMAT=json

# ネットワーク制限のためのラベル（docker-compose/k8sで使用）
LABEL h1ve.network.policy="restricted"
LABEL h1ve.network.allowed="api.anthropic.com,api.github.com,github.com"

# ヘルスチェック
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Worker起動
CMD ["node", "apps/worker/dist/main.js"]
