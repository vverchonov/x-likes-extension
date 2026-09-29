import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const env = loadEnv(resolve(root, ".env"));
for (const key of ["BE_ENDPOINT", "X_PROFILE_URL", "WEBSITE_URL"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
const beEndpoint = requireHttpUrl(env, "BE_ENDPOINT");
const xProfileUrl = requireHttpUrl(env, "X_PROFILE_URL");
const websiteUrl = requireHttpUrl(env, "WEBSITE_URL");
const backendUrl = new URL(beEndpoint);
if (backendUrl.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(backendUrl.hostname)) {
  throw new Error("BE_ENDPOINT must use HTTPS outside local development");
}
const beOrigin = backendUrl.origin;

const define = {
  __BE_ENDPOINT__: JSON.stringify(beEndpoint),
  __X_PROFILE_URL__: JSON.stringify(xProfileUrl),
  __WEBSITE_URL__: JSON.stringify(websiteUrl),
};

const entries = [
  ["src/background.ts", "background.js"],
  ["src/content.ts", "content.js"],
  ["src/page-hook.ts", "page-hook.js"],
  ["src/popup/popup.ts", "popup.js"],
];

const manifest = {
  manifest_version: 3,
  name: "ScrollX",
  short_name: "ScrollX",
  version: "0.1.0",
  description: "Shows posts you engaged with on X and lets you claim SOL rewards from their coins.",
  homepage_url: new URL(websiteUrl).origin + "/",
  action: {
    default_popup: "popup.html",
    default_icon: iconPaths(),
  },
  background: {
    service_worker: "background.js",
  },
  permissions: ["storage", "sidePanel"],
  side_panel: {
    default_path: "sidepanel.html",
  },
  host_permissions: hostPermissions(beOrigin),
  content_scripts: [
    {
      matches: ["https://x.com/*"],
      js: ["page-hook.js"],
      run_at: "document_start",
      world: "MAIN",
    },
    {
      matches: ["https://x.com/*"],
      js: ["content.js"],
      run_at: "document_start",
    },
  ],
  icons: iconPaths(),
};

for (const browser of ["chrome", "brave"]) {
  const outdir = resolve(root, "dist", browser);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(resolve(outdir, "icons"), { recursive: true });

  for (const [entry, outfile] of entries) {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: resolve(outdir, outfile),
      bundle: true,
      format: "iife",
      target: "chrome120",
      define,
    });
  }

  const popupHtml = readFileSync(resolve(root, "src/popup/popup.html"), "utf8");
  writeFileSync(resolve(outdir, "popup.html"), popupHtml);
  writeFileSync(resolve(outdir, "sidepanel.html"), popupHtml.replace("<html lang=\"en\">", "<html lang=\"en\" class=\"is-docked\">"));
  cpSync(resolve(root, "src/popup/popup.css"), resolve(outdir, "popup.css"));
  for (const size of [16, 32, 48, 128]) {
    cpSync(resolve(root, "icons", `icon${size}.png`), resolve(outdir, "icons", `icon${size}.png`));
  }
  writeFileSync(resolve(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function hostPermissions(origin) {
  const permissions = ["https://x.com/*"];
  if (new URL(origin).hostname !== "example.com") permissions.push(`${origin}/*`);
  return permissions;
}

function iconPaths() {
  return {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  };
}

function requireHttpUrl(values, key) {
  const value = values[key];
  if (!value) throw new Error(`Missing ${key} (set it in .env or the build environment)`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${key} must use http or https`);
  }
  return url.href;
}

function loadEnv(path) {
  const values = {};
  if (!existsSync(path)) return values;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
