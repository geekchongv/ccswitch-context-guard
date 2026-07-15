import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outputDirectory = `release-gui-v${metadata.version}`;
const target = process.argv.includes("--mac") ? "mac" : "win";
const builderCli = path.join(root, "node_modules", "electron-builder", "cli.js");
const npmCli = process.env.npm_execpath;
const secretValidator = path.join(root, "scripts", "validate-package-secrets.mjs");

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
  const resolvedOutput = path.resolve(root, outputDirectory);
  if (!resolvedOutput.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing unsafe output directory: ${resolvedOutput}`);
  }
  fs.rmSync(resolvedOutput, { recursive: true, force: true });
  run(process.execPath, [npmCli, "run", "build:gui"]);
  const builderArgs = target === "mac"
    ? ["--mac", "dmg", "zip", "--x64", "--arm64", `--config.directories.output=${outputDirectory}`]
    : ["--win", "portable", `--config.directories.output=${outputDirectory}`];
  run(process.execPath, [builderCli, ...builderArgs, "--publish", "never"]);
  fs.copyFileSync(path.join(root, "config.example.json"), path.join(root, outputDirectory, "config.example.json"));
  run(process.execPath, [secretValidator, "--release-dir", outputDirectory]);

  const extensions = target === "mac" ? new Set([".dmg", ".zip"]) : new Set([".exe"]);
  const artifacts = fs.readdirSync(path.join(root, outputDirectory))
    .filter((name) => name.startsWith(`CCProxy-Agent-v${metadata.version}`) && extensions.has(path.extname(name)))
    .map((name) => path.join(root, outputDirectory, name));
  if (artifacts.length === 0) throw new Error(`missing ${target} artifacts in ${outputDirectory}`);
  for (const artifactPath of artifacts) {
    const artifact = fs.statSync(artifactPath);
    if (!artifact.isFile() || artifact.size === 0) throw new Error(`missing or empty artifact: ${artifactPath}`);
  }
  const checksums = artifacts.map((artifactPath) => {
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
    return `${sha256}  ${path.basename(artifactPath)}`;
  });
  const checksumPath = path.join(root, outputDirectory, "SHA256SUMS.txt");
  fs.writeFileSync(checksumPath, `${checksums.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ target, artifacts, checksumPath }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
