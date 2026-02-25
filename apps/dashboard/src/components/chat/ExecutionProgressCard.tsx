import React, { useEffect, useRef, useState, useCallback } from "react";
import type { SystemProcess } from "../../lib/api";
import type { Agent } from "@openTiger/core";

interface ExecutionProgressCardProps {
  processes: SystemProcess[];
  agents?: Agent[];
  onViewDetails?: () => void;
  conversationId?: string;
}

/* ── Timeline entry ────────────────────────────────────── */

interface TimelineEntry {
  id: number;
  /** ISO string for serialization */
  ts: string;
  role: string;
  message: string;
  state: "busy" | "done" | "failed" | "idle" | "stopped" | "info";
}

/* ── localStorage helpers ──────────────────────────────── */

const LS_PREFIX = "ot:timeline:";

function lsKey(conversationId: string): string {
  return `${LS_PREFIX}${conversationId}`;
}

function loadEntries(conversationId: string | undefined): TimelineEntry[] {
  if (!conversationId) return [];
  try {
    const raw = localStorage.getItem(lsKey(conversationId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEntries(conversationId: string | undefined, entries: TimelineEntry[]): void {
  if (!conversationId) return;
  try {
    localStorage.setItem(lsKey(conversationId), JSON.stringify(entries));
  } catch {
    // Storage full or unavailable — ignore
  }
}

/** Load snapshot of previous process/agent states */
function loadSnapshot(
  conversationId: string | undefined,
): { procs: Map<string, ProcSnapshot>; agents: Map<string, AgentSnapshot>; busySince: Map<string, number> } | null {
  if (!conversationId) return null;
  try {
    const raw = localStorage.getItem(`${lsKey(conversationId)}:snap`);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return {
      procs: new Map(Object.entries(obj.procs ?? {})),
      agents: new Map(Object.entries(obj.agents ?? {})),
      busySince: new Map(Object.entries(obj.busySince ?? {})),
    };
  } catch {
    return null;
  }
}

function saveSnapshot(
  conversationId: string | undefined,
  procs: Map<string, ProcSnapshot>,
  agents: Map<string, AgentSnapshot>,
  busySince: Map<string, number>,
): void {
  if (!conversationId) return;
  try {
    localStorage.setItem(
      `${lsKey(conversationId)}:snap`,
      JSON.stringify({
        procs: Object.fromEntries(procs),
        agents: Object.fromEntries(agents),
        busySince: Object.fromEntries(busySince),
      }),
    );
  } catch {
    // ignore
  }
}

/* ── Helpers ───────────────────────────────────────────── */

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function fmtDurationMs(ms: number): string {
  if (ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (rem === 0) return `${min}m`;
  return `${min}m ${rem}s`;
}

function fmtDuration(startIso: string | undefined): string {
  if (!startIso) return "";
  return fmtDurationMs(Date.now() - new Date(startIso).getTime());
}

function displayName(processName: string): string {
  if (processName === "cycle-manager") return "CycleMgr";
  if (processName === "dispatcher") return "Dispatcher";
  if (processName === "planner") return "Planner";
  if (processName === "judge") return "Judge";
  if (processName.startsWith("worker-")) return processName.replace("worker-", "Worker-");
  if (processName.startsWith("judge-")) return processName.replace("judge-", "Judge-");
  if (processName.startsWith("planner-")) return processName.replace("planner-", "Planner-");
  if (processName.startsWith("tester-")) return processName.replace("tester-", "Tester-");
  if (processName.startsWith("docser-")) return processName.replace("docser-", "Docser-");
  return processName.charAt(0).toUpperCase() + processName.slice(1);
}

type ProcStatus = SystemProcess["status"];

function findProcessName(agentId: string, processes: SystemProcess[]): string | undefined {
  for (const p of processes) {
    if (agentId === p.name || (agentId.startsWith(p.name) && agentId.charAt(p.name.length) === "-")) {
      return p.name;
    }
  }
  return undefined;
}

function describeAgentBusy(role: string): string {
  if (role === "planner") return "generating tasks from requirements";
  if (role === "worker") return "executing task";
  if (role === "judge") return "reviewing completed work";
  if (role === "tester") return "running tests";
  if (role === "docser") return "generating docs";
  return "working";
}

function describeAgentDone(role: string, dur: string): string {
  const d = dur ? `worked for ${dur}` : "finished";
  if (role === "planner") return `${d} — tasks ready for dispatch`;
  if (role === "worker") return `${d} — task done`;
  if (role === "judge") return `${d} — review done`;
  if (role === "tester") return `${d} — tests done`;
  if (role === "docser") return `${d} — docs done`;
  return d;
}

function describeServiceStart(name: string): string {
  if (name === "dispatcher") return "dispatching tasks to workers";
  if (name === "cycle-manager") return "checking convergence";
  return "started";
}

function describeServiceFinish(_name: string, dur: string): string {
  return dur ? `ran for ${dur}` : "finished";
}

function buildInitialSummary(processes: SystemProcess[]): string {
  const running = processes.filter((p) => p.status === "running");
  if (running.length === 0) return "";
  const groups: Record<string, number> = {};
  for (const p of running) {
    let role: string;
    if (p.name === "planner" || p.name.startsWith("planner-")) role = "Planner";
    else if (p.name === "dispatcher") role = "Dispatcher";
    else if (p.name === "cycle-manager") role = "CycleMgr";
    else if (p.name.startsWith("worker-")) role = "Worker";
    else if (p.name === "judge" || p.name.startsWith("judge-")) role = "Judge";
    else if (p.name.startsWith("tester-")) role = "Tester";
    else if (p.name.startsWith("docser-")) role = "Docser";
    else role = displayName(p.name);
    groups[role] = (groups[role] ?? 0) + 1;
  }
  return Object.entries(groups)
    .map(([role, count]) => (count > 1 ? `${count} ${role}s` : role))
    .join(", ");
}

/* ── State colors ──────────────────────────────────────── */

const STATE_ROLE_COLOR: Record<TimelineEntry["state"], string> = {
  busy: "text-yellow-400",
  done: "text-emerald-400",
  failed: "text-red-400",
  idle: "text-zinc-500",
  stopped: "text-zinc-500",
  info: "text-blue-400",
};

const STATE_MSG_COLOR: Record<TimelineEntry["state"], string> = {
  busy: "text-zinc-300",
  done: "text-zinc-400",
  failed: "text-red-400/80",
  idle: "text-zinc-500",
  stopped: "text-zinc-500",
  info: "text-zinc-400",
};

/* ── Snapshots ─────────────────────────────────────────── */

interface ProcSnapshot {
  status: ProcStatus;
  startedAt?: string;
}

interface AgentSnapshot {
  status: string;
  currentTaskId: string | null;
}

/* ── Component ─────────────────────────────────────────── */

export const ExecutionProgressCard: React.FC<ExecutionProgressCardProps> = ({
  processes,
  agents = [],
  onViewDetails,
  conversationId,
}) => {
  const [entries, setEntries] = useState<TimelineEntry[]>(() => loadEntries(conversationId));
  const prevProcMap = useRef<Map<string, ProcSnapshot> | null>(null);
  const prevAgentMap = useRef<Map<string, AgentSnapshot> | null>(null);
  const agentBusySince = useRef<Map<string, number>>(new Map());
  const idCounter = useRef(0);
  const initialized = useRef(false);

  // Restore snapshot from localStorage on mount or conversation switch
  useEffect(() => {
    const existing = loadEntries(conversationId);
    setEntries(existing);

    const stored = loadSnapshot(conversationId);
    if (stored) {
      prevProcMap.current = stored.procs;
      prevAgentMap.current = stored.agents;
      agentBusySince.current = stored.busySince;
      if (existing.length > 0) {
        idCounter.current = Math.max(...existing.map((e) => e.id)) + 1;
      } else {
        idCounter.current = 0;
      }
      initialized.current = true;
    } else {
      prevProcMap.current = null;
      prevAgentMap.current = null;
      agentBusySince.current = new Map();
      idCounter.current = 0;
      initialized.current = false;
    }
  }, [conversationId]);

  // Persist entries to localStorage whenever they change
  const persistEntries = useCallback(
    (next: TimelineEntry[]) => {
      setEntries(next);
      saveEntries(conversationId, next);
    },
    [conversationId],
  );

  useEffect(() => {
    // ── Build current snapshots ──
    const curProcs = new Map<string, ProcSnapshot>();
    for (const p of processes) {
      curProcs.set(p.name, { status: p.status, startedAt: p.startedAt });
    }
    const curAgents = new Map<string, AgentSnapshot>();
    for (const a of agents) {
      curAgents.set(a.id, { status: a.status, currentTaskId: a.currentTaskId });
    }

    const agentBackedProcs = new Set<string>();
    for (const a of agents) {
      const procName = findProcessName(a.id, processes);
      if (procName) agentBackedProcs.add(procName);
    }

    const prevP = prevProcMap.current;
    const prevA = prevAgentMap.current;

    if (!prevP && !initialized.current) {
      // Very first render with no stored snapshot — seed summary
      prevProcMap.current = curProcs;
      prevAgentMap.current = curAgents;
      initialized.current = true;
      const nowMs = Date.now();
      for (const a of agents) {
        if (a.status === "busy") agentBusySince.current.set(a.id, nowMs);
      }
      saveSnapshot(conversationId, curProcs, curAgents, agentBusySince.current);

      const summary = buildInitialSummary(processes);
      if (summary) {
        const seed: TimelineEntry[] = [
          {
            id: idCounter.current++,
            ts: new Date().toISOString(),
            role: "System",
            message: `execution in progress — ${summary}`,
            state: "info",
          },
        ];
        persistEntries(seed);
      }
      return;
    }

    // If we restored from localStorage but prevP was set in the ref-restore effect
    if (!prevP) {
      // Snapshot was restored from localStorage — just update refs, don't generate entries
      prevProcMap.current = curProcs;
      prevAgentMap.current = curAgents;
      saveSnapshot(conversationId, curProcs, curAgents, agentBusySince.current);
      return;
    }

    const newEntries: TimelineEntry[] = [];
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    // ── Process transitions (services only) ──
    for (const [name, curr] of curProcs) {
      if (agentBackedProcs.has(name)) continue;
      const prev = prevP.get(name);
      const from = prev?.status;
      if (from === curr.status) continue;

      if (curr.status === "running" && from !== "running") {
        newEntries.push({
          id: idCounter.current++,
          ts: nowIso,
          role: displayName(name),
          message: describeServiceStart(name),
          state: "busy",
        });
      }
      if (from === "running" && curr.status !== "running") {
        const dur = fmtDuration(prev?.startedAt);
        if (curr.status === "failed") {
          newEntries.push({
            id: idCounter.current++, ts: nowIso, role: displayName(name),
            message: dur ? `failed after ${dur}` : "failed", state: "failed",
          });
        } else if (curr.status === "stopped") {
          newEntries.push({
            id: idCounter.current++, ts: nowIso, role: displayName(name),
            message: dur ? `stopped after ${dur}` : "stopped", state: "stopped",
          });
        } else {
          newEntries.push({
            id: idCounter.current++, ts: nowIso, role: displayName(name),
            message: describeServiceFinish(name, dur), state: "done",
          });
        }
      }
    }

    // ── Agent transitions ──
    for (const agent of agents) {
      const prev = prevA?.get(agent.id);
      if (!prev) {
        if (agent.status === "busy") {
          const procName = findProcessName(agent.id, processes);
          newEntries.push({
            id: idCounter.current++, ts: nowIso,
            role: displayName(procName ?? agent.role),
            message: describeAgentBusy(agent.role), state: "busy",
          });
          agentBusySince.current.set(agent.id, nowMs);
        }
        continue;
      }
      if (prev.status === agent.status) continue;

      const procName = findProcessName(agent.id, processes);
      const name = displayName(procName ?? agent.role);

      if (agent.status === "busy" && prev.status !== "busy") {
        newEntries.push({
          id: idCounter.current++, ts: nowIso, role: name,
          message: describeAgentBusy(agent.role), state: "busy",
        });
        agentBusySince.current.set(agent.id, nowMs);
      }

      if (prev.status === "busy" && agent.status !== "busy") {
        const busyStart = agentBusySince.current.get(agent.id);
        const dur = busyStart ? fmtDurationMs(nowMs - busyStart) : "";
        agentBusySince.current.delete(agent.id);

        if (agent.status === "offline") {
          newEntries.push({
            id: idCounter.current++, ts: nowIso, role: name,
            message: dur ? `went offline after ${dur}` : "went offline", state: "failed",
          });
        } else {
          newEntries.push({
            id: idCounter.current++, ts: nowIso, role: name,
            message: describeAgentDone(agent.role, dur), state: "done",
          });
        }
      }
    }

    // ── Agents disappeared while busy ──
    if (prevA) {
      for (const [id, prev] of prevA) {
        if (!curAgents.has(id) && prev.status === "busy") {
          const busyStart = agentBusySince.current.get(id);
          const dur = busyStart ? fmtDurationMs(nowMs - busyStart) : "";
          agentBusySince.current.delete(id);
          const procName = findProcessName(id, processes);
          newEntries.push({
            id: idCounter.current++, ts: nowIso,
            role: displayName(procName ?? id),
            message: dur ? `disappeared after ${dur}` : "disappeared", state: "stopped",
          });
        }
      }
    }

    // ── Non-agent-backed processes removed while running ──
    for (const [name, prev] of prevP) {
      if (agentBackedProcs.has(name)) continue;
      if (!curProcs.has(name) && prev.status === "running") {
        const dur = fmtDuration(prev.startedAt);
        newEntries.push({
          id: idCounter.current++, ts: nowIso, role: displayName(name),
          message: dur ? `removed after ${dur}` : "removed", state: "stopped",
        });
      }
    }

    prevProcMap.current = curProcs;
    prevAgentMap.current = curAgents;
    saveSnapshot(conversationId, curProcs, curAgents, agentBusySince.current);

    if (newEntries.length > 0) {
      persistEntries([...entries, ...newEntries]);
    }
  }, [processes, agents, conversationId, entries, persistEntries]);

  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((e) => (
        <div key={e.id} className="px-3 py-0.5">
          <div className="flex items-baseline gap-2 text-xs font-mono">
            <span className="text-zinc-600 shrink-0">{fmtTime(e.ts)}</span>
            <span className={`shrink-0 min-w-[6rem] font-semibold ${STATE_ROLE_COLOR[e.state]}`}>
              {e.role}
            </span>
            <span className={STATE_MSG_COLOR[e.state]}>{e.message}</span>
          </div>
        </div>
      ))}
      {onViewDetails && (
        <div className="px-3 py-0.5">
          <button
            onClick={onViewDetails}
            className="text-[11px] text-zinc-600 hover:text-term-tiger transition-colors cursor-pointer font-mono"
          >
            &gt; view dashboard
          </button>
        </div>
      )}
    </>
  );
};
