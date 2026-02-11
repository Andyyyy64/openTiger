export function matchDeniedCommand(command: string, deniedCommands: string[]): string | undefined {
  const target = command.trim();
  const lowerTarget = target.toLowerCase();

  for (const denied of deniedCommands) {
    const pattern = denied.trim();
    if (!pattern) {
      continue;
    }

    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(target)) {
        return denied;
      }
    } catch {
      // Treat as literal, not regex
    }

    if (lowerTarget.includes(pattern.toLowerCase())) {
      return denied;
    }
  }

  return undefined;
}

export function normalizeVerificationCommand(command: string): string {
  return command.trim();
}
