# ワーカー（Worker）Agent 仕様

関連:

- `docs/agent/README.md`
- `docs/policy-recovery.md`
- `docs/verification.md`

## 1. 役割

Worker 実行環境（runtime）は `AGENT_ROLE` に応じて実行モードを切り替えます。

- `worker`: 実装変更
- `tester`: テスト中心変更
- `docser`: ドキュメント変更

このページは Worker runtime の**共通動作**を説明します。  
Tester/Docser 固有差分は以下を参照してください。

- `docs/agent/tester.md`
- `docs/agent/docser.md`

責務外:

- 全体 backlog の再計画判断
- PR の approve/reject 判定

## 2. 標準実行フロー

1. runtime lock 取得
2. checkout / branch 準備
3. LLM 実行（`opencode` または `claude_code`）
4. expected-file 検証
5. 検証フェーズ（verification phase）実行
6. commit/push + PR 作成（`git` mode）
7. run/task/artifact 更新
8. lease 解放 + agent を idle へ復帰

## 3. 検証フェーズ（Verification Phase）

検証フェーズは単純な command 実行だけではなく、複数の回復処理（recovery）を含みます。

- 明示 command（explicit command）実行
- no-change failure の再試行
- no-op 判定（検証 pass 前提）
- policy violation の deterministic 回復
- optional LLM policy recovery (`allow|discard|deny`)
- generated artifact の discard + 学習
- verification recovery 実行（失敗 command を軸に再試行）

解決不可の場合:

- policy/verification failure -> `blocked(needs_rework)`

## 4. State Transitions

成功:

- review 必要 -> `blocked(awaiting_judge)`
- review 不要 -> `done`

失敗:

- quota 系 -> `blocked(quota_wait)`
- verification/policy -> `blocked(needs_rework)`
- その他 -> `failed`

## 5. 安全性とガードレール

- denied command の事前検査
- shell operator を含む command は実行対象外
- runtime lock + queue guard による重複実行防止
- expected-file mismatch 時は警告（warning）/失敗へ反映

## 6. 検証コマンドの制約

command は shell ではなく spawn 実行です。  
以下はサポートされません。

- `$()`
- `|`, `&&`, `||`, `;`, `<`, `>`, `` ` ``

## 7. 主要設定

- `AGENT_ID`, `AGENT_ROLE`
- `WORKER_MODEL`, `TESTER_MODEL`, `DOCSER_MODEL`
- `REPO_MODE`, `REPO_URL`, `BASE_BRANCH`
- `LOCAL_REPO_PATH`, `LOCAL_WORKTREE_ROOT`
- `WORKER_AUTO_VERIFY_MODE`
- `WORKER_VERIFY_CONTRACT_PATH`
- `WORKER_VERIFY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
