import { tigerResearchCyclePlugin } from "./tiger-research";
import type { CycleManagerPlugin } from "./types";

const cyclePlugins: CycleManagerPlugin[] = [tigerResearchCyclePlugin];

export async function runCycleManagerPluginMonitorTicks(): Promise<void> {
  for (const plugin of cyclePlugins) {
    if (!plugin.runMonitorTick) {
      continue;
    }
    await plugin.runMonitorTick();
  }
}
