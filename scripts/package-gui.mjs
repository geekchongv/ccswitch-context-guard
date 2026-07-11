import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outputDirectory = `release-gui-v${metadata.version}`;
const artifactPath = path.join(root, outputDirectory, `CCProxy-Agent-v${metadata.version}.exe`);
const builderCli = path.join(root, "node_modules", "electron-builder", "cli.js");
const npmCli = process.env.npm_execpath;

function run(command, args, shell = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

try {
  if (!npmCli) throw new Error("npm_execpath is unavailable; run packaging through npm run package:gui");
  run(process.execPath, [npmCli, "run", "build:gui"]);
  run(process.execPath, [builderCli, "--win", "portable", `--config.directories.output=${outputDirectory}`]);
  fs.copyFileSync(path.join(root, "config.json"), path.join(root, outputDirectory, "config.json"));

  const artifact = fs.statSync(artifactPath);
  if (!artifact.isFile() || artifact.size === 0) throw new Error(`missing or empty artifact: ${artifactPath}`);
  console.log(JSON.stringify({ artifactPath, bytes: artifact.size }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
