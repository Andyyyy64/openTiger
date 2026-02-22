// Scheduler module exports

export {
  acquireLease,
  releaseLease,
  extendLease,
  cleanupExpiredLeases,
  cleanupDanglingLeases,
  recoverOrphanedRunningTasks,
  getAgentLeases,
  getAllActiveLeases,
  type LeaseResult,
} from "./lease";

export {
  getAvailableTasks,
  buildDependencyGraph,
  detectCycles,
  type AvailableTask,
} from "./priority";

export {
  launchWorker,
  stopWorker,
  stopAllWorkers,
  getActiveWorkerCount,
  getActiveWorkers,
  type LaunchMode,
  type WorkerLaunchConfig,
  type LaunchResult,
} from "./worker-launcher";

export {
  checkAgentHealth,
  checkAllAgentsHealth,
  getAvailableAgents,
  getBusyAgentCount,
  reclaimDeadAgentLeases,
  recordHeartbeat,
  registerAgent,
  getAgentStats,
  type AgentHealth,
} from "./heartbeat";
