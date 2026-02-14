import { createNodeConfig } from "../../tsup.config.base";

export default createNodeConfig({
  entry: ["src/index.ts", "src/schema.ts", "src/plugins/tiger-research.ts"],
  dts: true,
  externalizeDeps: true,
});
