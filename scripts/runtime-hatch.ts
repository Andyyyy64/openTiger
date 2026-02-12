import { db, closeDb, sql } from "../packages/db/src/client.ts";

const RUNTIME_HATCH_ENTITY_ID = "00000000-0000-0000-0000-000000000001";
const RUNTIME_HATCH_ARMED_EVENT = "system.runtime_hatch_armed";
const RUNTIME_HATCH_DISARMED_EVENT = "system.runtime_hatch_disarmed";

function getSourceArg(args: string[]): string {
  const sourceArg = args.find((arg) => arg.startsWith("--source="));
  if (!sourceArg) {
    return "runtime-hatch-script";
  }
  const value = sourceArg.slice("--source=".length).trim();
  return value.length > 0 ? value : "runtime-hatch-script";
}

async function readCurrentState(): Promise<{
  armed: boolean;
  updatedAt?: string;
}> {
  const result = await db.execute(sql`
    SELECT type, created_at
    FROM events
    WHERE entity_type = 'system'
      AND entity_id = ${RUNTIME_HATCH_ENTITY_ID}::uuid
      AND (type = ${RUNTIME_HATCH_ARMED_EVENT} OR type = ${RUNTIME_HATCH_DISARMED_EVENT})
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const latest = extractExecuteFirstRow(result);

  if (!latest) {
    return { armed: false };
  }
  const updatedAt = toIsoString(latest.created_at);
  return {
    armed: latest.type === RUNTIME_HATCH_ARMED_EVENT,
    updatedAt,
  };
}

async function writeState(armed: boolean, source: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO events (type, entity_type, entity_id, payload)
    VALUES (
      ${armed ? RUNTIME_HATCH_ARMED_EVENT : RUNTIME_HATCH_DISARMED_EVENT},
      'system',
      ${RUNTIME_HATCH_ENTITY_ID}::uuid,
      ${JSON.stringify({ source })}::jsonb
    )
  `);
}

function extractExecuteFirstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) {
    const first = result[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }

  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      const first = rows[0];
      return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
    }
  }

  return undefined;
}

function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const [, , command = "status", ...rest] = process.argv;
  const source = getSourceArg(rest);

  if (command !== "status" && command !== "arm" && command !== "disarm") {
    console.error("Usage: tsx scripts/runtime-hatch.ts [status|arm|disarm] [--source=label]");
    process.exitCode = 1;
    return;
  }

  if (command === "status") {
    const state = await readCurrentState();
    const suffix = state.updatedAt ? ` (${state.updatedAt})` : "";
    console.log(`runtime_hatch=${state.armed ? "armed" : "disarmed"}${suffix}`);
    return;
  }

  const targetArmed = command === "arm";
  const current = await readCurrentState();
  if (current.armed !== targetArmed) {
    await writeState(targetArmed, source);
  }
  const updated = await readCurrentState();
  const suffix = updated.updatedAt ? ` (${updated.updatedAt})` : "";
  console.log(`runtime_hatch=${updated.armed ? "armed" : "disarmed"}${suffix}`);
}

main()
  .catch((error) => {
    console.error(
      `[runtime-hatch] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => undefined);
  });
