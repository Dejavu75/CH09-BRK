import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const builtAt = new Date();
const buildNumber = builtAt
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "Z");

function optionalGit(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const gitSha = optionalGit(["rev-parse", "--short=12", "HEAD"]);
const gitDirty = optionalGit(["status", "--porcelain"]).length > 0;
const version = `${packageJson.version}+${buildNumber}${gitSha ? `.${gitSha}` : ""}${gitDirty ? ".dirty" : ""}`;
const output = resolve(root, "src/generated/build_info.ts");

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `export const BROKER_BUILD_INFO = ${JSON.stringify(
    {
      name: "CH09-BRK",
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      version,
      buildNumber,
      builtAt: builtAt.toISOString(),
      gitSha,
      gitDirty
    },
    null,
    2
  )} as const;\n`,
  "utf8"
);

console.log(`Generated ${output}: ${version}`);
