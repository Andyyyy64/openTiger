# Goal

Build a minimal but extensible RISC-V OS baseline that boots on QEMU (qmenu), provides a kernel console, and supports safe iterative development with automated verification.

## Background

We want to develop an OS on RISC-V with a workflow that can be continuously driven by openTiger.
To make autonomous iteration stable, the first milestone must focus on a small, verifiable kernel baseline instead of full-featured OS scope.

## Constraints

- Keep the existing language/toolchain choices already used in the repository.
- Target RISC-V 64-bit virtual machine (`qemu-system-riscv64`, `virt` machine).
- Keep boot and kernel behavior deterministic enough for automated verification in CI/local runs.
- Avoid introducing heavy external runtime dependencies unless strictly needed.
- Prioritize incremental, testable slices over large one-shot rewrites.

## Acceptance Criteria

- [ ] Kernel image builds successfully with the project's standard build command.
- [ ] Running the image on QEMU reaches kernel entry and prints a boot banner to serial console.
- [ ] UART console input/output works for at least line-based command input.
- [ ] Trap/exception handler is wired and logs cause information on unexpected trap.
- [ ] Timer interrupt is enabled and at least one periodic tick is observable in logs.
- [ ] A simple physical page allocator (4KiB pages) is implemented with basic allocation/free tests.
- [ ] Basic kernel task execution is possible (at least two runnable tasks with round-robin scheduling).
- [ ] A minimal kernel command interface exists with `help`, `echo`, and `meminfo`.
- [ ] The project has at least one automated smoke test that boots in QEMU and checks expected boot log markers.
- [ ] Core kernel changes are covered by unit/integration tests where feasible, and all required checks pass.

## Scope

## In Scope

- Boot path and early initialization for RISC-V `virt` machine.
- Kernel console over UART.
- Trap/interrupt initialization and timer tick handling.
- Basic physical memory page allocator.
- Minimal scheduler foundation for kernel tasks.
- Minimal command interface on serial console.
- Build/test scripts for repeatable local and CI verification.
- Essential documentation updates for setup and run commands.

## Out of Scope

- Full virtual memory subsystem with user-space process isolation.
- Full POSIX compatibility.
- File system implementation beyond minimal stubs.
- Network stack.
- Multi-core SMP scheduling.
- Security hardening beyond baseline correctness.

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

| Risk                                                                   | Impact | Mitigation                                                               |
| ---------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| Boot sequence instability causes non-deterministic failures in QEMU    | high   | Keep early boot logging explicit and add smoke tests for boot markers    |
| Trap/interrupt misconfiguration blocks progress in later kernel stages | high   | Implement trap setup with incremental verification and isolated tests    |
| Scheduler bugs create hidden starvation or deadlock                    | medium | Start with minimal round-robin behavior and add deterministic task tests |
| Memory allocator corruption causes cascading failures                  | high   | Add allocator invariants and targeted allocation/free test cases         |
| Scope expansion slows autonomous iteration                             | medium | Keep this milestone strictly baseline and defer advanced OS features     |

## Notes

Use a milestone-first strategy:

1. boot + console,
2. trap/timer,
3. allocator,
4. scheduler,
5. command interface,
6. smoke tests and docs.

For openTiger operation, ensure there is a stable non-interactive verification command (for example a smoke test script that runs QEMU headless and validates log output).
