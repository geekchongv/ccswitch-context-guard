import fs from "node:fs";

const html = fs.readFileSync("src/gui/index.html", "utf8");
const renderer = fs.readFileSync("src/gui/renderer.js", "utf8");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
const rendererRefs = [...new Set([...renderer.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]))];
const missing = rendererRefs.filter((id) => !htmlIds.has(id));
const securityErrors = [];
if (!/<input id="visionApiKey" type="password"/.test(html)) {
  securityErrors.push("visionApiKey must be a password input");
}
if (/next\.vision\.apiKey\s*=/.test(renderer)) {
  securityErrors.push("renderer must not place the API key inside config state");
}

console.log(JSON.stringify({ htmlIds: htmlIds.size, rendererRefs: rendererRefs.length, missing, securityErrors }, null, 2));
if (missing.length > 0 || securityErrors.length > 0) process.exit(1);
