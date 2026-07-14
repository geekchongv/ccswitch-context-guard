import fs from "node:fs";

interface PackageMetadata {
  version?: string;
}

function readPackageVersion(): string {
  try {
    const packageUrl = new URL("../package.json", import.meta.url);
    const metadata = JSON.parse(fs.readFileSync(packageUrl, "utf8")) as PackageMetadata;
    return metadata.version?.trim() || "dev";
  } catch {
    return "dev";
  }
}

/** Single runtime source of truth for CLI, dashboard, and packaged GUI status. */
export const APP_VERSION = readPackageVersion();
