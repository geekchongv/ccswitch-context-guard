import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const releaseArgIndex = process.argv.indexOf("--release-dir");
const releaseDirectory = releaseArgIndex >= 0
  ? process.argv[releaseArgIndex + 1]
  : `release-gui-v${metadata.version}`;
const releasePath = path.resolve(root, releaseDirectory);

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return filesBelow(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function collectSensitiveValues(value, key = "") {
  if (Array.isArray(value)) return value.flatMap((item) => collectSensitiveValues(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([nestedKey, nestedValue]) =>
      collectSensitiveValues(nestedValue, nestedKey));
  }
  if (typeof value !== "string" || value.length < 8 || /env$/i.test(key)) return [];
  return /(api.?key|token|secret|password|authorization)/i.test(key) ? [value] : [];
}

const localConfigPath = path.join(root, "config.json");
const localSecrets = fs.existsSync(localConfigPath)
  ? collectSensitiveValues(JSON.parse(fs.readFileSync(localConfigPath, "utf8")))
  : [];
const sentinels = [...new Set([
  ...localSecrets,
  process.env.CCPROXY_SECRET_SENTINEL ?? "",
].filter(Boolean))];
const releaseFiles = filesBelow(releasePath);
const forbiddenConfigs = releaseFiles.filter((filePath) => path.basename(filePath).toLowerCase() === "config.json");

if (forbiddenConfigs.length > 0) {
  throw new Error(`release contains private config.json: ${forbiddenConfigs.join(", ")}`);
}

const leaks = [];
for (const filePath of releaseFiles) {
  const content = fs.readFileSync(filePath);
  for (const secret of sentinels) {
    if (content.includes(Buffer.from(secret))) {
      leaks.push(path.relative(root, filePath));
      break;
    }
  }
}

if (leaks.length > 0) {
  throw new Error(`release contains configured secret bytes: ${leaks.join(", ")}`);
}

console.log(JSON.stringify({
  releasePath,
  filesScanned: releaseFiles.length,
  configuredSecretsChecked: sentinels.length,
  privateConfigFiles: forbiddenConfigs.length,
  leaks: leaks.length,
}, null, 2));
