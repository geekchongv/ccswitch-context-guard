import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const preloadSource = fs.readFileSync(path.join(root, "src", "gui-preload.ts"), "utf8");
const preload = ts.transpileModule(preloadSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
  fileName: "gui-preload.ts",
});
fs.writeFileSync(path.join(root, "dist", "gui-preload.cjs"), preload.outputText, "utf8");
const guiSource = path.join(root, "src", "gui");
const guiTarget = path.join(root, "dist", "gui");
fs.mkdirSync(guiTarget, { recursive: true });
for (const name of fs.readdirSync(guiSource)) {
  fs.copyFileSync(path.join(guiSource, name), path.join(guiTarget, name));
}
