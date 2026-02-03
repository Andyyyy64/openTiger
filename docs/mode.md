# 運用モード

---

## 目的

リポジトリの運用形態を定義し、実行経路を明確にする。

---

## モード一覧

### git（PRベース）

- `REPO_MODE=git` を指定する
- リモートリポジトリをクローンし、作業ブランチを作成する
- コミット後にプッシュし、PRを作成する

### local（worktreeベース）

- `REPO_MODE=local` を指定する
- `LOCAL_REPO_PATH` を基点に `git worktree` を作成する
- ローカルでコミットし、プッシュとPR作成は行わない

---

## 使い分けの目安

- git: GitHubのPR運用やCI連携を前提にする場合
- local: ローカルリポジトリでの検証や閉域環境での運用

---

## 必須設定

- `REPO_MODE`
- `LOCAL_REPO_PATH`（localのみ）
- `LOCAL_WORKTREE_ROOT`（localのみ）
- `GITHUB_TOKEN`（gitのみ）

---

最終更新: 2026/2/3
