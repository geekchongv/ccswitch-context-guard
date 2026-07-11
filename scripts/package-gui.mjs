import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outputDirectory = `release-gui-v${metadata.version}`;
const artifactPath = path.join(root, outputDirectory, `CCProxy-Agent-v${metadata.version}.exe`);
const builderCommand = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

try {
  run("npm", ["run", "build:gui"]);
  run(builderCommand, ["--win", "portable", `--config.directories.output=${outputDirectory}`]);
  fs.copyFileSync(path.join(root, "config.json"), path.join(root, outputDirectory, "config.json"));

  const artifact = fs.statSync(artifactPath);
  if (!artifact.isFile() || artifact.size === 0) throw new Error(`missing or empty artifact: ${artifactPath}`);
  console.log(JSON.stringify({ artifactPath, bytes: artifact.size }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
