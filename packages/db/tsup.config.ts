import { createNodeConfig } from "../../tsup.config.base";

export default createNodeConfig({
  entry: ["src/index.ts", "src/schema.ts"],
  dts: true,
  externalizeDeps: true,
});
