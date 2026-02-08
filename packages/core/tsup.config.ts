import { createNodeConfig } from "../../tsup.config.base";

export default createNodeConfig({
  entry: ["src/index.ts", "src/process-logging.ts", "src/domain/index.ts"],
  dts: true,
  externalizeDeps: true,
});
