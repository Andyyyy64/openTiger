import { createNodeConfig } from "../../tsup.config.base";

export default createNodeConfig({
  entry: ["src/index.ts", "src/db.ts", "src/manifest.ts"],
  dts: true,
  externalizeDeps: true,
});
