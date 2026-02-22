import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

type PackageJson = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type TsupConfigInput = {
  entry: string[];
  dts?: boolean;
  externalizeDeps?: boolean;
};

const readPackageJson = (): PackageJson => {
  const pkgPath = resolve(process.cwd(), "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  return JSON.parse(raw) as PackageJson;
};

const getExternalDeps = (): string[] => {
  // Externalize dependencies to minimize bundle diff
  const pkg = readPackageJson();
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
};

export const createNodeConfig = ({
  entry,
  dts = false,
  externalizeDeps = false,
}: TsupConfigInput) =>
  defineConfig({
    entry,
    format: ["esm"],
    target: "es2022",
    platform: "node",
    sourcemap: true,
    clean: true,
    dts,
    splitting: true,
    external: externalizeDeps ? getExternalDeps() : undefined,
  });
