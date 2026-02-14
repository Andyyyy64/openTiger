export interface CycleManagerPlugin {
  id: string;
  runMonitorTick?: () => Promise<void>;
}
