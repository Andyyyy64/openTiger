# Goal

Build a medium-level RISC-V OS that boots on QEMU, provides a window manager with GUI operations, a terminal with Unix-like commands (`ls`, `cat`, etc.), and supports safe iterative development with automated verification. The scope aligns with intermediate OS development milestones: graphics, windows, multitasking, basic shell commands, and file system.

## Background

We want to develop an OS on RISC-V with a workflow that can be continuously driven by openTiger. A medium-level OS extends beyond a minimal kernel to include:

- Window manager for GUI (window drawing, overlap, focus, drag)
- Mouse and keyboard input with event handling
- Unix-like command implementation (`ls`, `cat`, `echo`, `pwd`, `cd`, `mkdir`, etc.)
- Basic file system (e.g., FAT) for file read/write
- Multiple terminal support
- Application layer that can create windows

## Constraints

- Keep the existing language/toolchain choices already used in the repository.
- Target RISC-V 64-bit virtual machine (`qemu-system-riscv64`, `virt` machine).
- Keep boot and kernel behavior deterministic enough for automated verification in CI/local runs.
- Avoid introducing heavy external runtime dependencies unless strictly needed.
- Prioritize incremental, testable slices over large one-shot rewrites.

## Acceptance Criteria

### Kernel Baseline

- [ ] Kernel image builds successfully with the project's standard build command.
- [ ] Running the image on QEMU reaches kernel entry and prints a boot banner to serial console.
- [ ] UART console input/output works for at least line-based command input.
- [ ] Trap/exception handler is wired and logs cause information on unexpected trap.
- [ ] Timer interrupt is enabled and at least one periodic tick is observable in logs.
- [ ] A simple physical page allocator (4KiB pages) is implemented with basic allocation/free tests.
- [ ] Basic kernel task execution is possible (at least two runnable tasks with round-robin scheduling).

### Graphics and Window Manager

- [ ] Pixel-level graphics rendering (framebuffer or equivalent) is working.
- [ ] Window manager can create, draw, and overlap multiple windows (title bar, content area).
- [ ] Window focus and activation work; active window is brought to front.
- [ ] Mouse input is captured and events are delivered to the appropriate window/task.
- [ ] Keyboard input is routed to the focused window/terminal.
- [ ] Overlay/layer management allows correct stacking of windows.

### Shell and Unix-like Commands

- [ ] A terminal shell accepts line-based command input and shows output.
- [ ] At least these commands work: `ls`, `cat`, `echo`, `pwd`, `cd`, `mkdir`, `help`.
- [ ] `ls` lists directory contents (files and subdirectories).
- [ ] `cat` reads and prints file contents.
- [ ] Redirection (`>`, `>>`) and pipes are supported at a basic level (stretch goal).
- [ ] Multiple terminals can run concurrently, each with independent shell state.

### File System

- [ ] A basic file system (e.g., FAT12/FAT32 or minimal custom) is mounted.
- [ ] Files can be read and written through the kernel or shell.
- [ ] Directory listing and traversal work (`ls`, `cd`, `pwd`).

### Verification

- [ ] The project has at least one automated smoke test that boots in QEMU and checks expected boot log markers.
- [ ] Core kernel changes are covered by unit/integration tests where feasible, and all required checks pass.

## Scope

### In Scope

- Boot path and early initialization for RISC-V `virt` machine.
- Kernel console over UART.
- Trap/interrupt initialization and timer tick handling.
- Basic physical memory page allocator.
- Minimal scheduler foundation for kernel tasks.
- Framebuffer or equivalent graphics driver for pixel output.
- Window manager: window creation, drawing, overlap, focus, drag.
- Mouse and PCI (or equivalent) driver for mouse input.
- Keyboard input and event dispatch.
- Basic file system implementation (FAT or minimal FS).
- Terminal shell with Unix-like commands: `ls`, `cat`, `echo`, `pwd`, `cd`, `mkdir`, `help`, `meminfo`.
- Multiple terminal support.
- Application layer that can create windows and handle events.
- Build/test scripts for repeatable local and CI verification.
- Essential documentation updates for setup and run commands.

### Out of Scope

- Full POSIX compatibility.
- Network stack.
- Multi-core SMP scheduling.
- Advanced security hardening (ASLR, privilege separation beyond basic).
- Full C library or dynamic linking.
- Hardware acceleration (GPU).

### Allowed Paths

- `arch/riscv/**`
- `boot/**`
- `kernel/**`
- `drivers/**`
- `fs/**`
- `shell/**`
- `apps/**`
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
| Boot sequence instability causes non-deterministic failures in QEMU   | high   | Keep early boot logging explicit and add smoke tests for boot markers    |
| Trap/interrupt misconfiguration blocks progress in later kernel stages| high   | Implement trap setup with incremental verification and isolated tests    |
| Scheduler bugs create hidden starvation or deadlock                    | medium | Start with minimal round-robin behavior and add deterministic task tests  |
| Memory allocator corruption causes cascading failures                  | high   | Add allocator invariants and targeted allocation/free test cases         |
| Window/event handling becomes too complex for incremental delivery     | medium | Implement in phases: pixel -> single window -> multi-window -> shell      |
| File system bugs corrupt disk image                                   | high   | Use deterministic disk images in tests; add fsck or consistency checks    |
| Scope expansion slows autonomous iteration                             | medium | Use milestone-first delivery; defer advanced features to later phases    |

## Notes

Use a milestone-first strategy:

1. Boot + console + trap/timer + allocator + scheduler (kernel baseline)
2. Graphics: pixel output, framebuffer driver
3. Mouse and keyboard input, event queue (FIFO)
4. Window manager: single window, then multiple windows, overlap, focus, drag
5. File system: mount, read, write, directory operations
6. Shell and commands: `help`, `echo`, `meminfo`, then `ls`, `cat`, `pwd`, `cd`, `mkdir`
7. Multiple terminals
8. Applications that create windows
9. Smoke tests and docs