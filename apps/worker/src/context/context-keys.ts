export const CONTEXT_KEYS_PRIORITY = [
  "host.os",
  "host.kernel",
  "host.arch",
  "host.shell",
  "host.terminal",
  "host.cpu",
  "host.memory",
  "host.uptime",
  "tools.node",
  "tools.pnpm",
  "tools.docker",
  "tools.qemu",
] as const;

export type ContextKey = (typeof CONTEXT_KEYS_PRIORITY)[number];

export const CONTEXT_KEY_LABELS: Record<ContextKey, string> = {
  "host.os": "OS",
  "host.kernel": "Kernel",
  "host.arch": "Arch",
  "host.shell": "Shell",
  "host.terminal": "Terminal",
  "host.cpu": "CPU",
  "host.memory": "Memory",
  "host.uptime": "Uptime",
  "tools.node": "Node",
  "tools.pnpm": "pnpm",
  "tools.docker": "Docker",
  "tools.qemu": "QEMU",
};

export function isSupportedContextKey(value: string): value is ContextKey {
  return (CONTEXT_KEYS_PRIORITY as readonly string[]).includes(value);
}
