import { createNodeConfig } from "../../tsup.config.base";

export default createNodeConfig({
  entry: ["src/index.ts"],
  dts: true,
  externalizeDeps: true,
});
