import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const downloads = resolve(root, "../frontend/public/downloads");
const manifest = JSON.parse(readFileSync(resolve(root, "dist/chrome/manifest.json"), "utf8"));

mkdirSync(downloads, { recursive: true });

for (const browser of ["chrome", "brave"]) {
  const filename = `scrollx-${browser}.zip`;
  const versioned = resolve(root, "dist", `scrollx-${manifest.version}-${browser}.zip`);
  const latest = resolve(downloads, filename);
  execFileSync("zip", ["-r", "-X", versioned, ".", "-x", "*.DS_Store"], {
    cwd: resolve(root, "dist", browser),
  });
  cpSync(versioned, latest);
  console.log(latest);
}
