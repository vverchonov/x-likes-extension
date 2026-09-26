import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const chromeDir = resolve(root, "dist", "chrome");
const manifest = JSON.parse(readFileSync(resolve(chromeDir, "manifest.json"), "utf8"));
const zipPath = resolve(root, "dist", `likes-${manifest.version}-chrome.zip`);

execFileSync("zip", ["-r", "-X", zipPath, ".", "-x", "*.DS_Store"], { cwd: chromeDir });
console.log(zipPath);
