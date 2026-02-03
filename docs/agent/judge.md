# Judge

---

## 役割

実装結果を評価し、採否を決定する。

---

## 入力

- CI結果
- ポリシー違反の有無
- LLMレビュー結果

---

## 出力

- 判定結果（approve / request_changes / needs_human）
- PRへのコメント

---

## 重要な方針

- 自動マージは低リスクかつ機械判定が満たされた場合のみ
- 高リスクは人間レビューへ切り替える

---

## 主要な設定

- `JUDGE_MODE`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY_CONFIDENCE`
- `JUDGE_LOCAL_BASE_REPO_RECOVERY_DIFF_LIMIT`

---

## 失敗時の扱い

- 判定不能な場合は `needs_human` として扱う
- 差分が大きい場合はタスク分割を要求する

---

最終更新: 2026/2/3
