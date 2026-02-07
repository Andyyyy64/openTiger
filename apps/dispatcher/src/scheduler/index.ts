// スケジューラーモジュールのエクスポート

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
} from "./lease.js";

export {
  getAvailableTasks,
  buildDependencyGraph,
  detectCycles,
  type AvailableTask,
} from "./priority.js";

export {
  launchWorker,
  stopWorker,
  stopAllWorkers,
  getActiveWorkerCount,
  getActiveWorkers,
  type LaunchMode,
  type WorkerLaunchConfig,
  type LaunchResult,
} from "./worker-launcher.js";

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
} from "./heartbeat.js";
