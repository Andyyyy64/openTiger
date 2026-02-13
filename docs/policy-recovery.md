# Policy Recovery と AllowedPaths の自己成長

このドキュメントは、openTiger が policy violation で停止しないための回復手順と、  
回復結果を次回 planning に反映する自己成長の仕組みを説明します。

関連:

- `docs/agent/worker.md`
- `docs/agent/planner.md`
- `docs/flow.md`
- `docs/state-model.md`

## 1. 目的

task が `allowedPaths` 外のファイルを変更した場合でも、openTiger は即座に rework 連鎖へ落とさず、  
まず同一 run 内で回復を試みます。

設計上の狙いは次の 2 点です。

- **Self-recovery**: 現在の Worker run 内で policy violation を解消する
- **Self-growth**: 有効だった回復結果を記録し、Planner の将来 `allowedPaths` に先回り反映する

## 2. In-Run Self-Recovery（Worker）

Worker の verification は、次の回復優先シーケンスで進みます。

1. `verifyChanges` を実行
2. policy violation があれば deterministic path recovery を試行
   - violation の outside path を抽出
   - task context と policy recovery 設定から auto-allow 候補を生成
   - `aggressive` mode では、`commandDrivenAllowedPathRules[].paths`（例: `Makefile`）に一致する violating path も in-run auto-allow 候補として扱う
   - 共有 policy rule から command-driven path を加える
3. `allowedPaths` を調整して再検証
4. violation が残る場合は optional LLM recovery（`allow` / `discard` / `deny`）を実行
   - `discard`: 変更ファイルの一部を破棄して再検証
   - `allow`: `allowedPaths` を拡張して再検証
   - `deny`: 回復試行を打ち切って escalate
5. それでも解決しなければ task を `blocked(needs_rework)` にする

### 2.1 LLM Recovery の入力

LLM には、次の実行文脈を渡します。

- task metadata（`title`, `goal`, `role`, `commands`）
- 現在の `allowedPaths` と `deniedPaths`
- violating paths と violation message
- 現在の changed files
- queued/running task の要約（同時実行状況）

### 2.2 Hard Guardrails

LLM が `allow` を返しても、Worker は次を満たさない path を拒否します。

- path が安全である（path traversal / absolute path / 過剰 glob を含まない）
- 現在の violating path に含まれている
- `deniedPaths` に該当しない（`deniedPaths` が常に優先）

### 2.3 mode 別 deterministic 挙動

deterministic auto-allow の範囲は mode により異なります。

- `conservative`
  - context-file match のみ
  - infra-file 拡張なし
- `balanced`
  - context-file match + infra-file 拡張
  - root-level / command-driven violation auto-allow は行わない
- `aggressive`（既定）
  - `balanced` の挙動に加えて:
    - root-level infra path recovery
    - command-driven rule path recovery（例: make 系 rule 時の `Makefile`）

### 2.4 Generated Artifact Path Auto-Learning

LLM recovery 後も violation が残る場合、Worker は生成物らしい path を破棄対象として最終回復を試みます。

1. `isLikelyGeneratedArtifactPath()` で violating path を抽出  
   - 例: `.dump`, `.log`, `.tmp`, `.trace`  
   - 例: `coverage`, `report`, `artifact`, `build`, `dist` などの path segment
2. 抽出したファイルを discard して再検証
3. 学習結果を `.opentiger/generated-paths.auto.txt` に保存し、次回以降の `verifyChanges` で最初から generated 扱いにする

`generated-paths.txt` を手動編集する必要はありません。  
`GENERATED_PATHS` / `WORKER_EXTRA_GENERATED_PATHS` / `.opentiger/generated-paths.auto.txt` を毎回マージして検証します。

### 2.5 Docser の制約

`docser` には意図的な制約があります。

- deterministic policy auto-allow で追加 path を返さない
- LLM policy recovery を実行しない
- verification command は doc-safe な `check` 系（例: `pnpm run check`）に限定

## 3. Shared Policy Recovery Engine（Core）

共有ロジックは `packages/core/src/policy-recovery.ts` にあり、Worker/Cycle Manager/Planner から再利用されます。

主な責務:

- 設定のロードとマージ
  - built-in default
  - `.opentiger/policy-recovery.json`
  - env override
- command-driven path の解決
- violation path 抽出
- mode 別 deterministic auto-allow candidate 解決
  - `conservative`
  - `balanced`
  - `aggressive`（既定）

## 4. Verification Command Format Recovery

verification command が unsupported format（shell operator / `$()`）や missing script で失敗した場合、  
Cycle Manager は無限 block させず command を調整して requeue します。

- `requeue-failed`:
  - `verification_command_unsupported_format` / `verification_command_missing_script`
    - 失敗 command を `commands` から除去して requeue
  - `policy_violation`
    - allowed path 調整を試みて requeue

Worker 側も、残り command がある場合や既に前段が通っている場合（doc-only/no-op など）は、  
同 run 内で explicit command failure を skip します。

## 5. Rework Chain Suppression（Cycle Manager）

Cycle Manager は policy-only failure と rework 連鎖の増幅を抑制します。

- `requeue-failed`:
  - `policy_violation` に対して allowed path 調整 + requeue を試行
- `requeue-blocked`:
  - blocked task が outside-allowed violation を持つ場合:
    - safe path を追加できるなら同一 task を requeue
    - できない場合は `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES` まで抑制再試行し、その後 cancel
    - `policy_violation_rework_suppressed_no_safe_path` または `policy_violation_rework_suppressed_exhausted` を emit
  - 同一 parent に active rework child がある場合は rework split を作らない
  - `[auto-rework] parentTask=` の深さが `AUTO_REWORK_MAX_DEPTH` 以上なら cancel

これにより `[Rework] ...` child の無限増殖を防止します。

## 6. Planner による Self-Growth

Planner は過去の回復結果を利用して、将来 task の `allowedPaths` を先回り拡張します。

流れ:

1. 直近の `task.policy_recovery_applied` event を読み込む
2. role/path の頻度で hint を集約
3. requirement note へ hint を注入して planning 文脈に渡す
4. 一致した hint を生成 task の `allowedPaths` に直接反映

hint の代表 reason:

- `context_file_match`
- `signal_match_strong`
- `signal_match_repeated_weak`

Planner は path 追加理由を次にも記録します。

- `planner.plan_created.payload.policyRecoveryHintApplications`
  - task ごとの追加 path
  - 一致した hint metadata（role, count, reason, source text）

## 7. 設定

### 7.1 リポジトリ設定ファイル

既定ファイル:

- `.opentiger/policy-recovery.json`

テンプレート:

- `templates/policy-recovery.example.json`

主要キー:

- `mode`
- `replaceDefaultCommandDrivenAllowedPathRules`
- `commandDrivenAllowedPathRules`
- `infraSignalTokens`
- `safeInfraFileBasenames`
- `safeInfraFileExtensions`
- `safeHiddenRootFiles`

### 7.2 環境変数

Core:

- `POLICY_RECOVERY_CONFIG_PATH`
- `POLICY_RECOVERY_CONFIG_JSON`
- `POLICY_RECOVERY_MODE`

Worker recovery:

- `WORKER_POLICY_RECOVERY_USE_LLM`
- `WORKER_POLICY_RECOVERY_ATTEMPTS`
- `WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS`
- `WORKER_POLICY_RECOVERY_MODEL`

Cycle Manager の rework 抑制:

- `BLOCKED_POLICY_SUPPRESSION_MAX_RETRIES`（既定: 2）  
  - safe path が見つからないときの最大抑制再試行回数
- `AUTO_REWORK_MAX_DEPTH`（既定: 2）  
  - rework 連鎖深度の上限。超過時は cancel

Worker の verification skip:

- `WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT`（既定: `true`）  
  - 残り command がある場合、missing/unsupported explicit command を skip

## 8. Event Reference

回復観測イベント:

- `task.policy_recovery_decided`
  - LLM decision 要約と raw decision group
- `task.policy_recovery_applied`
  - 適用 action（`allow` / `discard` / `allow+discard`）と結果 path
- `task.policy_recovery_denied`
  - denied decision の詳細

関連 queue 回復イベント:

- `task.requeued`（reason）
  - `policy_allowed_paths_adjusted`
  - `policy_allowed_paths_adjusted_from_blocked`
  - `verification_command_missing_script_adjusted`
  - `verification_command_unsupported_format_adjusted`
  - `cooldown_retry`
- `task.recovery_escalated`（reason）
  - `policy_violation_rework_suppressed_no_safe_path`
  - `policy_violation_rework_suppressed_exhausted`
  - `rework_child_already_exists`
  - `rework_chain_max_depth_reached`

Planner 観測:

- `planner.plan_created.payload.policyRecoveryHintApplications`

## 9. 運用メモ

- 本機構は既存の events/tasks データを利用するため、schema migration は不要です。
- より厳密な挙動が必要な場合は `balanced` または `conservative` へ切り替えます。
- 回復判断を速くしたい場合は Worker の timeout/model を調整します。
- 判断品質を優先する場合は attempts を慎重に増やし、queue 遅延を監視します。
