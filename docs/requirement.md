# ゴール

QEMU（qmenu）で起動し、kernel console を提供し、自動検証付きで安全に反復開発できる  
最小かつ拡張可能な RISC-V OS baseline を構築する。

## 背景

openTiger による継続的な自律開発フローで RISC-V OS を育てることを想定する。  
自律反復の安定化のため、最初のマイルストーンはフル機能 OS ではなく、  
小さく検証可能な kernel baseline に限定する。

## 制約

- 既存リポジトリで採用済みの言語/ツールチェーン選定を維持する
- 対象は RISC-V 64-bit 仮想環境（`qemu-system-riscv64`, `virt` machine）
- boot/kernel 挙動は CI/ローカル自動検証で扱える程度に deterministic を保つ
- 厳密に必要な場合を除き、重い外部 runtime dependency を追加しない
- 一括大改修より、段階的でテスト可能な小さな slice を優先する

## 受け入れ基準

- [ ] プロジェクト標準 build command で kernel image を生成できる
- [ ] QEMU 起動で kernel entry 到達と serial console への boot banner 出力を確認できる
- [ ] UART console 入出力が最低限 line-based command で動作する
- [ ] trap/exception handler が配線され、unexpected trap の cause 情報を log 出力できる
- [ ] timer interrupt が有効化され、周期 tick を log で少なくとも 1 回確認できる
- [ ] 4KiB page 単位の simple physical page allocator があり、allocation/free の基本テストが通る
- [ ] 基本 kernel task 実行（少なくとも 2 task の round-robin scheduling）ができる
- [ ] 最小 kernel command interface（`help`, `echo`, `meminfo`）がある
- [ ] QEMU boot と log marker 検証を行う自動 smoke test が少なくとも 1 本ある
- [ ] 実現可能な範囲で kernel 主要変更に unit/integration test を付与し、必須 checks が通る

## スコープ

## 対象範囲（In Scope）

- RISC-V `virt` machine 向け boot path と early initialization
- UART 経由の kernel console
- trap/interrupt 初期化と timer tick 処理
- 基本的な physical memory page allocator
- kernel task 用 minimal scheduler 基盤
- serial console 上の最小 command interface
- ローカル/CI で再現可能な build/test script
- setup/run command に関する必須ドキュメント更新

## 対象外（Out of Scope）

- user-space process 分離を含む完全な virtual memory subsystem
- 完全な POSIX 互換
- 最小 stub を超える file system 実装
- network stack
- multi-core SMP scheduling
- baseline correctness を超える security hardening

## 許可パス（Allowed Paths）

- `arch/riscv/**`
- `boot/**`
- `kernel/**`
- `drivers/**`
- `include/**`
- `lib/**`
- `tests/**`
- `scripts/**`
- `docs/**`
- `README.md`
- `Makefile`

## リスク評価

| Risk | Impact | Mitigation |
| --- | --- | --- |
| QEMU 上で boot sequence が不安定になり非決定的失敗が起きる | high | 初期 boot log を明示的に保ち、boot marker 用 smoke test を追加する |
| Trap/interrupt 設定ミスで後続 kernel 実装が詰まる | high | trap setup を段階的に実装し、分離テストで早期検証する |
| Scheduler bug が starvation/deadlock を隠れ発生させる | medium | 最小 round-robin から開始し deterministic task test を追加する |
| Memory allocator 破損で障害が連鎖する | high | allocator invariant と targeted allocation/free test を追加する |
| Scope 拡張で自律反復速度が落ちる | medium | 本マイルストーンを baseline に固定し高度機能は後続へ送る |

## 補足

milestone-first 戦略で進める:

1. boot + console
2. trap/timer
3. allocator
4. scheduler
5. command interface
6. smoke tests + docs

openTiger 運用では、非対話で安定実行できる verification command を必ず用意する。  
（例: headless QEMU 実行 + log marker 検証の smoke test script）

## 共通逆引き導線（状態語彙 -> 遷移 -> 担当 -> 実装、要件更新後）

要件を更新した後に停滞や想定外挙動が出た場合は、状態語彙 -> 遷移 -> 担当 -> 実装の順で確認する。

1. `docs/state-model.md`（状態語彙）
2. `docs/flow.md`（遷移と回復経路）
3. `docs/operations.md`（API 手順と運用ショートカット）
4. `docs/agent/README.md`（担当 agent と実装追跡）
