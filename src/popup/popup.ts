import { X_PROFILE_URL, WEBSITE_URL } from "../config.ts";
import { acceptDisclaimer, isDisclaimerAccepted } from "../lib/consent.ts";
import { formatSol } from "../lib/private-data.ts";
import { isSolanaAddress } from "../lib/solana.ts";
import { allAccountsSelection, clearClaimHistory, currentSelection, mountPrivateView, noteVerification, refreshClaimHistory, refreshClaimStatus, refreshPrivateView, revealFeed, rowSelection, selectClaim, setClaim } from "./private-view.ts";

const toggle = document.querySelector("#capture-toggle");
const settings = document.querySelector("#settings");
const settingsPanel = document.querySelector("#settings-panel");
const identityBackup = document.querySelector("#identity-backup");
const identityReveal = document.querySelector("#identity-reveal");
const identityBackupString = document.querySelector("#identity-backup-string");
const identityCopy = document.querySelector("#identity-copy");
const identityImport = document.querySelector("#identity-import");
const identityImportButton = document.querySelector("#identity-import-button");
const identityStatus = document.querySelector("#identity-status");
const identityPublicKey = document.querySelector("#identity-public-key");
const home = document.querySelector("#home");
const accounts = document.querySelector("#accounts");
const activity = document.querySelector("#activity");
const confirmRemove = document.querySelector("#confirm-remove");
const confirmAccount = document.querySelector("#confirm-account");
const confirmCancel = document.querySelector("#confirm-cancel");
const confirmRemoveButton = document.querySelector("#confirm-remove-button");
const navHome = document.querySelector("#nav-home");
const navFeed = document.querySelector("#nav-feed");
const navActivity = document.querySelector("#nav-activity");
const footer = document.querySelector(".footer");
const claim = document.querySelector("#claim");
const claimBack = document.querySelector("#claim-back");
const claimForm = document.querySelector("#claim-form");
const wallet = document.querySelector("#wallet");
const walletError = document.querySelector("#wallet-error");
const claimButton = document.querySelector("#claim-button");
const claimStatus = document.querySelector("#claim-status");
const processing = document.querySelector("#processing");
const processingDone = document.querySelector("#processing-done");
const dock = document.querySelector("#dock");
const xLink = document.querySelector("#x-link");
const siteLink = document.querySelector("#site-link");

if (xLink instanceof HTMLAnchorElement) xLink.href = X_PROFILE_URL;
if (siteLink instanceof HTMLAnchorElement) siteLink.href = WEBSITE_URL;
const docsLink = document.querySelector("#docs-link");
if (docsLink instanceof HTMLAnchorElement) docsLink.href = new URL("/docs", WEBSITE_URL).href;

const disclaimerAgree = document.querySelector("#disclaimer-agree");
const disclaimerContinue = document.querySelector("#disclaimer-continue");
let opened = false;

void openPopup();
void prepareDock();

const docked = location.pathname.endsWith("/sidepanel.html");
let browserWindowId: number | null = null;

async function prepareDock(): Promise<void> {
  if (!(dock instanceof HTMLButtonElement) || typeof chrome === "undefined" || !chrome.sidePanel?.open || !chrome.windows?.getCurrent) return;
  browserWindowId = await browserWindow();
  dock.hidden = false;
  dock.disabled = browserWindowId === null;
  dock.setAttribute("aria-pressed", String(docked));
  dock.setAttribute("aria-label", docked ? "Back to popup" : "Open beside the page");
  dock.addEventListener("click", () => {
    if (browserWindowId === null || !chrome.sidePanel) return;
    const windowId = browserWindowId;
    if (docked) {
      void chrome.sidePanel.close({ windowId });
      return;
    }
    void chrome.sidePanel.open({ windowId }).then(() => window.close());
  });
}

async function browserWindow(): Promise<number | null> {
  const current = await chrome.windows.getCurrent();
  if (current.type !== "popup" && current.id !== undefined) return current.id;
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
  const browser = windows.find((entry) => entry.focused && entry.id !== undefined) ?? windows.find((entry) => entry.id !== undefined);
  if (browser?.id !== undefined) return browser.id;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return tab?.windowId ?? null;
}

async function openPopup(): Promise<void> {
  if (await isDisclaimerAccepted()) {
    unlockApp();
    return;
  }
  if (!(disclaimerAgree instanceof HTMLInputElement) || !(disclaimerContinue instanceof HTMLButtonElement)) return;
  disclaimerAgree.addEventListener("change", () => {
    disclaimerContinue.disabled = !disclaimerAgree.checked;
  });
  disclaimerContinue.addEventListener("click", () => {
    if (!disclaimerAgree.checked) return;
    disclaimerContinue.disabled = true;
    void acceptDisclaimer().then(() => {
      unlockApp();
    });
  });
}

function unlockApp(): void {
  if (opened) return;
  opened = true;
  if (hasExtensionStorage()) {
    void chrome.runtime.sendMessage({ type: "identity-setup" }).then((response: { ok?: boolean; publicKey?: string }) => {
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = response.ok && response.publicKey
        ? "Identity ready on this device" : "Identity setup unavailable";
      if (response.ok && response.publicKey && identityPublicKey instanceof HTMLElement) identityPublicKey.textContent = response.publicKey;
    }).catch(() => {
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Identity setup unavailable";
    });
  }
  document.body.classList.remove("is-locked");
  mountPrivateView();
}

if (identityBackup instanceof HTMLButtonElement && identityBackupString instanceof HTMLTextAreaElement && identityCopy instanceof HTMLButtonElement) {
  identityBackup.addEventListener("click", () => {
    if (!identityBackupString.hidden) {
      hideRecoveryKey();
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Recovery key hidden";
      return;
    }
    void (async () => {
      if (!(await confirmAction("Reveal recovery key?", "Anyone with this key can access your ScrollX identity. Only reveal it in private.", "Reveal key"))) return;
      const response = await chrome.runtime.sendMessage({ type: "identity-backup" }) as { ok?: boolean; backup?: string };
      if (!response.ok || !response.backup) throw new Error("Backup unavailable");
      identityBackupString.value = response.backup;
      if (identityReveal instanceof HTMLElement) identityReveal.hidden = false;
      identityBackupString.hidden = false;
      identityCopy.hidden = false;
      identityBackup.textContent = "Hide";
      identityBackupString.focus();
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Recovery key revealed. Store it somewhere safe.";
    })().catch(() => {
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Backup failed";
    });
  });
  identityCopy.addEventListener("click", () => {
    if (!navigator.clipboard?.writeText) {
      identityBackupString.select();
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Select and copy the recovery key manually.";
      return;
    }
    void navigator.clipboard.writeText(identityBackupString.value).then(() => {
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Recovery key copied. Store it securely.";
    }).catch(() => {
      identityBackupString.select();
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Select and copy the recovery key manually.";
    });
  });
}

if (identityImport instanceof HTMLTextAreaElement && identityImportButton instanceof HTMLButtonElement) {
  identityImport.addEventListener("input", () => { identityImportButton.disabled = !identityImport.value.trim(); });
  identityImportButton.addEventListener("click", () => {
    const backup = identityImport.value.trim();
    if (!backup) return;
    void (async () => {
      if (!(await confirmAction("Replace this identity?", "Your current history may no longer be accessible without its recovery key. Your saved account list will be replaced.", "Import key"))) return;
      if (backup.length > 16_384) throw new Error("Backup too large");
      const response = await chrome.runtime.sendMessage({ type: "identity-import", backup }) as { ok?: boolean; publicKey?: string };
      if (!response.ok || !response.publicKey) throw new Error("Import failed");
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Identity restored on this device";
      if (identityPublicKey instanceof HTMLElement) identityPublicKey.textContent = response.publicKey;
      hideRecoveryKey();
      clearClaimHistory();
      await refreshPrivateView(true);
      void refreshClaimHistory().then(() => refreshClaimStatus());
    })().catch(() => {
      if (identityStatus instanceof HTMLElement) identityStatus.textContent = "Import failed: check the recovery key";
    }).finally(() => { identityImport.value = ""; identityImportButton.disabled = true; });
  });
}

type Screen = "home" | "feed" | "activity" | "settings" | "claim" | "processing";

let claimOrigin: "home" = "home";

if (
  home instanceof HTMLElement &&
  accounts instanceof HTMLElement &&
  activity instanceof HTMLElement &&
  navHome instanceof HTMLButtonElement &&
  navFeed instanceof HTMLButtonElement &&
  navActivity instanceof HTMLButtonElement &&
  settings instanceof HTMLButtonElement &&
  settingsPanel instanceof HTMLElement &&
  footer instanceof HTMLElement &&
  claim instanceof HTMLElement &&
  claimBack instanceof HTMLButtonElement &&
  claimForm instanceof HTMLFormElement &&
  wallet instanceof HTMLInputElement &&
  walletError instanceof HTMLElement &&
  claimButton instanceof HTMLButtonElement &&
  claimStatus instanceof HTMLElement &&
  processing instanceof HTMLElement &&
  processingDone instanceof HTMLButtonElement
) {
  navHome.addEventListener("click", () => {
    closeRemoveConfirm();
    showScreen("home");
  });
  navFeed.addEventListener("click", () => {
    closeRemoveConfirm();
    showScreen("feed");
  });
  navActivity.addEventListener("click", () => {
    closeRemoveConfirm();
    showScreen("activity");
    void refreshClaimHistory().then(() => refreshClaimStatus());
  });
  settings.addEventListener("click", () => {
    closeRemoveConfirm();
    showScreen(settingsPanel.hidden ? "settings" : "home");
  });

  accounts.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.dataset.action === "claim-all") {
      const selection = allAccountsSelection();
      if (!selection) return;
      void checkClaim(selection.xUserIds).then((allowed) => {
        if (!allowed) return;
        claimOrigin = "home";
        selectClaim(selection);
        openClaim();
      });
      return;
    }
    const xUserId = button.dataset.xUserId;
    if (!xUserId) return;
    if (button.dataset.action === "remove") {
      askToRemove(xUserId, button.closest("article")?.querySelector(".label")?.textContent ?? xUserId);
      return;
    }
    if (button.dataset.action === "verify") {
      button.disabled = true;
      void chrome.runtime.sendMessage({ type: "verify-account", xUserId }).then((response: { ok?: boolean; reason?: string }) => {
        noteVerification(xUserId, response?.ok ? "" : response?.reason || "Verification failed");
        void refreshPrivateView(true);
      });
      return;
    }
    if (button.dataset.action !== "claim") return;
    const selection = rowSelection(xUserId);
    if (!selection) return;
    void checkClaim(selection.xUserIds).then((allowed) => {
      if (!allowed) return;
      claimOrigin = "home";
      selectClaim(selection);
      openClaim();
    });
  });

  claimBack.addEventListener("click", () => {
    showScreen(claimOrigin);
  });

  wallet.addEventListener("input", () => {
    const valid = isSolanaAddress(wallet.value);
    const showError = wallet.value.trim().length > 0 && !valid;
    claimButton.disabled = !valid;
    walletError.hidden = !showError;
    wallet.setAttribute("aria-invalid", showError ? "true" : "false");
    claimStatus.hidden = true;
  });

  claimForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const payout = currentSelection();
    if (claimButton.disabled || !payout || !isSolanaAddress(wallet.value)) return;
    const destination = wallet.value.trim();
    claimButton.disabled = true;
    void confirmAction("Confirm SOL destination", "Review the wallet receiving your claim.", "Submit claim", destination).then(async (confirmed) => {
      if (!confirmed) { claimButton.disabled = false; return; }
      const result = await claimPayout(payout.xUserIds, destination);
      claimButton.disabled = Boolean(result?.ok);
      if (!result?.ok || !result.claim) {
        claimStatus.hidden = false;
        claimStatus.textContent = result?.reason ?? "Couldn't submit claim; retry with the same destination";
        return;
      }
      setClaim(result.claim);
      showScreen("activity");
      void refreshPrivateView(true);
      void refreshClaimHistory().then(() => refreshClaimStatus());
    }).catch(() => { claimStatus.hidden = false; claimStatus.textContent = "Couldn't submit claim; retry with the same destination"; claimButton.disabled = false; });
  });

  processingDone.addEventListener("click", () => {
    showScreen(claimOrigin);
  });

  const homeView = home;
  const accountsView = accounts;
  const activityView = activity;
  const settingsView = settingsPanel;
  const settingsButton = settings;
  const claimView = claim;
  const processingView = processing;
  const footerView = footer;
  const walletInput = wallet;
  const walletMessage = walletError;
  const claimSubmit = claimButton;
  const claimMessage = claimStatus;
  const homeTab = navHome;
  const feedTab = navFeed;
  const activityTab = navActivity;

  function openClaim(): void {
    const payout = currentSelection();
    if (!payout) return;
    walletInput.value = "";
    walletInput.setAttribute("aria-invalid", "false");
    walletMessage.hidden = true;
    const label = `Claim ${formatSol(payout.balance)}`;
    claimSubmit.textContent = label;
    claimSubmit.title = label;
    claimSubmit.disabled = true;
    claimMessage.hidden = true;
    claimMessage.textContent = "";
    showScreen("claim");
    walletInput.focus();
  }

  function showScreen(screen: Screen): void {
    if (screen !== "settings") {
      hideRecoveryKey();
      if (identityImport instanceof HTMLTextAreaElement) identityImport.value = "";
      if (identityImportButton instanceof HTMLButtonElement) identityImportButton.disabled = true;
    }
    homeView.hidden = screen !== "feed";
    if (screen === "feed") revealFeed();
    accountsView.hidden = screen !== "home";
    activityView.hidden = screen !== "activity";
    settingsView.hidden = screen !== "settings";
    settingsButton.setAttribute("aria-expanded", String(screen === "settings"));
    claimView.hidden = screen !== "claim";
    processingView.hidden = screen !== "processing";
    footerView.hidden = screen === "claim" || screen === "processing";
    markTab(homeTab, screen === "home");
    markTab(feedTab, screen === "feed");
    markTab(activityTab, screen === "activity");
  }
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

watchAccountList();

let pendingRemoval = "";

function watchAccountList(): void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("trackedXAccounts" in changes)) return;
    void refreshPrivateView(true);
  });
}

function askToRemove(xUserId: string, label: string): void {
  if (!(confirmRemove instanceof HTMLElement) || !(confirmAccount instanceof HTMLElement)) return;
  pendingRemoval = xUserId;
  confirmAccount.textContent = label;
  confirmRemove.hidden = false;
}

function closeRemoveConfirm(): void {
  pendingRemoval = "";
  if (confirmRemove instanceof HTMLElement) confirmRemove.hidden = true;
}

if (confirmCancel instanceof HTMLButtonElement) {
  confirmCancel.addEventListener("click", closeRemoveConfirm);
}

if (confirmRemoveButton instanceof HTMLButtonElement) {
  confirmRemoveButton.addEventListener("click", () => {
    const xUserId = pendingRemoval;
    closeRemoveConfirm();
    if (!xUserId) return;
    void forgetAccount(xUserId).then(() => refreshPrivateView(true));
  });
}

function markTab(button: HTMLButtonElement, current: boolean): void {
  if (current) button.setAttribute("aria-current", "page");
  else button.removeAttribute("aria-current");
}

async function forgetAccount(xUserId: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  await chrome.runtime.sendMessage({ type: "forget-account", xUserId });
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

async function claimPayout(
  xUserIds: string[],
  walletAddress: string,
): Promise<{ ok?: boolean; reason?: string; claim?: import("../lib/private-data.ts").Claim } | null> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return null;
  const response: unknown = await chrome.runtime.sendMessage({
    type: "claim-payout",
    xUserIds,
    destination: walletAddress,
    confirmedDestination: true,
  });
  return response && typeof response === "object" ? response as { ok?: boolean; reason?: string; claim?: import("../lib/private-data.ts").Claim } : null;
}

async function checkClaim(xUserIds: string[]): Promise<boolean> {
  const status = document.querySelector("#claim-eligibility");
  try {
    const result = await chrome.runtime.sendMessage({ type: "check-claim", xUserIds }) as { ok?: boolean; eligible?: boolean; reason?: string };
    if (result.ok && result.eligible) return true;
    if (status) status.textContent = result.reason ? `Claim unavailable: ${result.reason.replaceAll("_", " ")}` : "Couldn't check claim eligibility";
  } catch { if (status) status.textContent = "Couldn't check claim eligibility"; }
  return false;
}

function hasExtensionStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

function hideRecoveryKey(): void {
  if (identityBackupString instanceof HTMLTextAreaElement) { identityBackupString.value = ""; identityBackupString.hidden = true; }
  if (identityCopy instanceof HTMLButtonElement) identityCopy.hidden = true;
  if (identityReveal instanceof HTMLElement) identityReveal.hidden = true;
  if (identityBackup instanceof HTMLButtonElement) identityBackup.textContent = "Reveal";
}

function confirmAction(title: string, detail: string, action: string, destination?: string): Promise<boolean> {
  const dialog = document.querySelector("#confirm-action");
  const heading = document.querySelector("#confirm-action-title");
  const description = document.querySelector("#confirm-action-detail");
  const button = document.querySelector("#confirm-action-button");
  const wallet = document.querySelector("#confirm-action-wallet");
  const address = document.querySelector("#confirm-action-address");
  if (!(dialog instanceof HTMLDialogElement) || dialog.open || !(heading instanceof HTMLElement) || !(description instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || !(wallet instanceof HTMLElement) || !(address instanceof HTMLElement)) return Promise.resolve(false);
  heading.textContent = title;
  description.textContent = detail;
  button.textContent = action;
  wallet.hidden = !destination;
  address.textContent = destination ?? "";
  dialog.setAttribute("aria-describedby", destination ? "confirm-action-detail confirm-action-wallet" : "confirm-action-detail");
  dialog.returnValue = "";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}
