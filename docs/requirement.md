# Goal

Build a minimal, extensible RISC-V OS baseline that boots under QEMU (qemu-system-riscv64),  
provides a kernel console, and enables safe iterative development with automated verification.

## Background

Intended for growing a RISC-V OS via openTiger's continuous autonomous development flow.  
To stabilize autonomous iteration, the first milestone is limited to a small, verifiable kernel baseline,  
not a full-featured OS.

## Constraints

- Keep existing language and toolchain choices in the repo
- Target RISC-V 64-bit virtual environment (`qemu-system-riscv64`, `virt` machine)
- Boot/kernel behavior remains deterministic enough for CI/local automated verification
- Avoid heavy external runtime dependencies except when strictly necessary
- Prefer incremental, testable slices over large one-off changes

## Acceptance Criteria

- [ ] Kernel image can be built with project-standard build command
- [ ] Boot banner appears on serial console when booting with QEMU
- [ ] UART console I/O works for minimal line-based commands
- [ ] Trap/exception handlers are wired; unexpected trap cause info can be logged
- [ ] Timer interrupt enabled; at least one periodic tick visible in logs
- [ ] Simple physical page allocator (4KiB pages) with basic allocation/free tests
- [ ] Basic kernel task execution (at least 2 tasks round-robin scheduled)
- [ ] Minimal kernel command interface (`help`, `echo`, `meminfo`)
- [ ] At least one automated smoke test that runs QEMU boot and verifies log markers
- [ ] Unit/integration tests for major kernel changes where feasible; required checks pass

## Scope

## In Scope

- Boot path and early initialization for RISC-V `virt` machine
- Kernel console via UART
- Trap/interrupt init and timer tick handling
- Basic physical memory page allocator
- Minimal scheduler for kernel tasks
- Minimal command interface on serial console
- Build/test scripts reproducible in local/CI
- Required documentation updates for setup/run commands

## Out of Scope

- Full virtual memory subsystem including user-space process isolation
- Full POSIX compatibility
- File system beyond minimal stub
- Network stack
- Multi-core SMP scheduling
- Security hardening beyond baseline correctness

## Allowed Paths

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

## Risk Assessment

| Risk                                                       | Impact | Mitigation                                                       |
| ---------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| Boot sequence unstable on QEMU, non-deterministic failures | high   | Keep explicit boot logs; add smoke test for boot markers         |
| Trap/interrupt misconfiguration blocks later kernel work   | high   | Implement trap setup incrementally; validate with isolated tests |
| Scheduler bugs hide starvation/deadlock                    | medium | Start with minimal round-robin; add deterministic task tests     |
| Memory allocator corruption cascades failures              | high   | Add allocator invariant and allocation/free tests                |
| Scope creep slows autonomous iteration                     | medium | Lock this milestone as baseline; defer advanced features         |

## Notes

Milestone-first strategy:

1. boot + console
2. trap/timer
3. allocator
4. scheduler
5. command interface
6. smoke tests + docs

For openTiger operation, always provide non-interactive, stable verification commands.  
(e.g. headless QEMU run + smoke script that verifies log markers)

## Common Lookup Path (State Vocabulary -> Transition -> Owner -> Implementation, After Requirement Update)

If stalls or unexpected behavior appear after requirement updates, follow: state vocabulary -> transition -> owner -> implementation.

1. `docs/state-model.md` (state vocabulary)
2. `docs/flow.md` (transitions and recovery paths)
3. `docs/operations.md` (API procedures and operation shortcuts)
4. `docs/agent/README.md` (owning agent and implementation tracing)
