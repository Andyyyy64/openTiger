import { describe, expect, it } from "vitest";
import {
  applyPolicyRecoveryPathHints,
  applyTesterCommandPolicy,
  applyVerificationCommandPolicy,
  normalizeGeneratedTasks,
} from "../src/task-policies";
import type { TaskGenerationResult } from "../src/strategies";

function createResult(overrides?: Partial<TaskGenerationResult>): TaskGenerationResult {
  return {
    tasks: [
      {
        title: "default task",
        goal: "default goal",
        role: "tester",
        allowedPaths: ["apps/**"],
        commands: ["pnpm run test"],
      },
    ],
    warnings: [],
    totalEstimatedMinutes: 60,
    ...overrides,
  };
}

describe("applyTesterCommandPolicy", () => {
  it("appends e2e command when tester task explicitly requires e2e", () => {
    const result = createResult({
      tasks: [
        {
          title: "Add E2E for reservation critical path",
          goal: "Cover user flow from create to cancel",
          role: "tester",
          allowedPaths: ["apps/**"],
          commands: ["pnpm run test"],
        },
      ],
    });

    const updated = applyTesterCommandPolicy(result, "pnpm run test:e2e");

    expect(updated.tasks[0]?.commands).toEqual(["pnpm run test", "pnpm run test:e2e"]);
  });

  it("does not append e2e command for tester task without explicit e2e requirement", () => {
    const result = createResult({
      tasks: [
        {
          title: "Add unit tests for parser",
          goal: "Increase branch coverage for parser",
          role: "tester",
          allowedPaths: ["apps/planner/**"],
          commands: ["pnpm run test"],
        },
      ],
    });

    const updated = applyTesterCommandPolicy(result, "pnpm run test:e2e");

    expect(updated.tasks[0]?.commands).toEqual(["pnpm run test"]);
  });

  it("does not append e2e command for non-tester tasks", () => {
    const result = createResult({
      tasks: [
        {
          title: "Implement parser",
          goal: "Support new requirement format",
          role: "worker",
          allowedPaths: ["apps/planner/**"],
          commands: ["pnpm run test"],
        },
      ],
    });

    const updated = applyTesterCommandPolicy(result, "pnpm run test:e2e");

    expect(updated.tasks[0]?.commands).toEqual(["pnpm run test"]);
  });

  it("does not duplicate e2e command when already present", () => {
    const result = createResult({
      tasks: [
        {
          title: "Update E2E tests",
          goal: "Refresh playwright flow",
          role: "tester",
          allowedPaths: ["apps/**"],
          commands: ["pnpm run test", "pnpm run test:e2e"],
        },
      ],
    });

    const updated = applyTesterCommandPolicy(result, "pnpm run test:e2e");

    expect(updated.tasks[0]?.commands).toEqual(["pnpm run test", "pnpm run test:e2e"]);
  });
});

describe("applyVerificationCommandPolicy", () => {
  it("drops verification commands that use unsupported shell operators", () => {
    const result = createResult({
      tasks: [
        {
          title: "Create kernel image",
          goal: "Build kernel/kernel.elf",
          role: "worker",
          allowedPaths: ["**"],
          commands: [
            "make clean && make",
            "file kernel/kernel.elf | grep -q 'ELF 64-bit.*RISC-V'",
            "file kernel/kernel.elf > /tmp/out.txt",
          ],
        },
      ],
    });

    const updated = applyVerificationCommandPolicy(result, false);

    expect(updated.tasks[0]?.commands).toEqual(["make clean && make"]);
  });
});

describe("normalizeGeneratedTasks", () => {
  it("adds command-driven root allowance for make-based worker tasks", () => {
    const result = createResult({
      tasks: [
        {
          title: "Implement UART banner",
          goal: "Kernel prints banner",
          role: "worker",
          allowedPaths: ["arch/**", "kernel/**"],
          commands: ["make && make run"],
        },
      ],
    });

    const updated = normalizeGeneratedTasks(result);

    expect(updated.tasks[0]?.allowedPaths).toContain("Makefile");
  });

  it("does not auto-allow Makefile for docser tasks", () => {
    const result = createResult({
      tasks: [
        {
          title: "Update docs",
          goal: "Docs match implementation",
          role: "docser",
          allowedPaths: ["docs/**", "README.md"],
          commands: ["make"],
        },
      ],
    });

    const updated = normalizeGeneratedTasks(result);

    expect(updated.tasks[0]?.allowedPaths).not.toContain("Makefile");
  });

  it("adds CMakeLists.txt allowance for cmake-based worker tasks", () => {
    const result = createResult({
      tasks: [
        {
          title: "Configure native build",
          goal: "Generate build files with cmake",
          role: "worker",
          allowedPaths: ["src/**"],
          commands: ["cmake -S . -B build"],
        },
      ],
    });

    const updated = normalizeGeneratedTasks(result);

    expect(updated.tasks[0]?.allowedPaths).toContain("CMakeLists.txt");
  });
});

describe("applyPolicyRecoveryPathHints", () => {
  it("proactively adds learned allowed path when task signal matches", () => {
    const result = createResult({
      tasks: [
        {
          title: "Implement linker map handling",
          goal: "Fix kernel linker section layout",
          role: "worker",
          allowedPaths: ["arch/**", "kernel/**"],
          commands: ["make -j4"],
          context: {
            files: ["arch/riscv/kernel.ld"],
          },
        },
      ],
    });

    const updated = applyPolicyRecoveryPathHints(result, [
      {
        path: "arch/riscv/kernel.ld",
        role: "worker",
        count: 1,
        sourceText: "implement physical page allocator make kernel ld",
      },
    ]);

    expect(updated.tasks[0]?.allowedPaths).toContain("arch/riscv/kernel.ld");
    expect(updated.policyRecoveryHintApplications).toEqual([
      {
        taskIndex: 0,
        taskTitle: "Implement linker map handling",
        taskRole: "worker",
        addedAllowedPaths: ["arch/riscv/kernel.ld"],
        matchedHints: [
          {
            path: "arch/riscv/kernel.ld",
            hintRole: "worker",
            hintCount: 1,
            hintSourceText: "implement physical page allocator make kernel ld",
            reason: "context_file_match",
          },
        ],
      },
    ]);
  });

  it("does not apply learned path when role/signal does not match", () => {
    const result = createResult({
      tasks: [
        {
          title: "Update markdown docs",
          goal: "Refresh onboarding document",
          role: "docser",
          allowedPaths: ["docs/**"],
          commands: ["pnpm --filter @openTiger/planner test"],
        },
      ],
    });

    const updated = applyPolicyRecoveryPathHints(result, [
      {
        path: "arch/riscv/kernel.ld",
        role: "worker",
        count: 3,
        sourceText: "implement physical page allocator make kernel ld",
      },
    ]);

    expect(updated.tasks[0]?.allowedPaths).not.toContain("arch/riscv/kernel.ld");
    expect(updated.policyRecoveryHintApplications).toBeUndefined();
  });
});
