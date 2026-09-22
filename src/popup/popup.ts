import { X_PROFILE_URL, WEBSITE_URL } from "../config.ts";
import { mountTimeline } from "./timeline.ts";

const toggle = document.querySelector("#capture-toggle");
const timeline = document.querySelector("#timeline");
const refresh = document.querySelector("#refresh");
const xLink = document.querySelector("#x-link");
const siteLink = document.querySelector("#site-link");

if (xLink instanceof HTMLAnchorElement) xLink.href = X_PROFILE_URL;
if (siteLink instanceof HTMLAnchorElement) siteLink.href = WEBSITE_URL;
if (timeline instanceof HTMLElement) {
  mountTimeline(timeline, refresh instanceof HTMLButtonElement ? refresh : null);
}

if (toggle instanceof HTMLButtonElement) {
  void readEnabled().then((enabled) => {
    render(toggle, enabled);
  });

  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-checked") !== "true";
    render(toggle, next);
    void writeEnabled(next);
  });
}

function render(button: HTMLButtonElement, enabled: boolean): void {
  button.setAttribute("aria-checked", enabled ? "true" : "false");
}

async function readEnabled(): Promise<boolean> {
  if (hasExtensionStorage()) {
    const stored = await chrome.storage.local.get({ captureEnabled: true });
    return stored.captureEnabled !== false;
  }
  return localStorage.getItem("captureEnabled") !== "false";
}

async function writeEnabled(enabled: boolean): Promise<void> {
  if (hasExtensionStorage()) {
    await chrome.storage.local.set({ captureEnabled: enabled });
    return;
  }
  localStorage.setItem("captureEnabled", String(enabled));
}

function hasExtensionStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}
