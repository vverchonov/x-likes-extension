import { X_PROFILE_URL, WEBSITE_URL } from "../config.ts";
import { SIGNED_IN_ACCOUNTS_KEY, sameAccounts } from "../lib/accounts.ts";
import { acceptDisclaimer, isDisclaimerAccepted } from "../lib/consent.ts";
import { formatPayout } from "../lib/likes.ts";
import { isSolanaAddress } from "../lib/solana.ts";
import { clearEarnings, currentPayout, homePayout, mountTimeline, refreshEarnings, selectClaim } from "./timeline.ts";

const timeline = document.querySelector("#timeline");
const refresh = document.querySelector("#refresh");
const payoutButton = document.querySelector("#payout-button");
const home = document.querySelector("#home");
const accounts = document.querySelector("#accounts");
const confirmRemove = document.querySelector("#confirm-remove");
const confirmAccount = document.querySelector("#confirm-account");
const confirmCancel = document.querySelector("#confirm-cancel");
const confirmRemoveButton = document.querySelector("#confirm-remove-button");
const navHome = document.querySelector("#nav-home");
const navAccounts = document.querySelector("#nav-accounts");
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
  document.body.classList.remove("is-locked");
  if (timeline instanceof HTMLElement) {
    mountTimeline(timeline, refresh instanceof HTMLButtonElement ? refresh : null);
  }
}

type Screen = "home" | "accounts" | "claim" | "processing";

let claimOrigin: Screen = "home";

if (
  payoutButton instanceof HTMLButtonElement &&
  home instanceof HTMLElement &&
  accounts instanceof HTMLElement &&
  navHome instanceof HTMLButtonElement &&
  navAccounts instanceof HTMLButtonElement &&
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
  navAccounts.addEventListener("click", () => {
    closeRemoveConfirm();
    showScreen("accounts");
  });

  payoutButton.addEventListener("click", () => {
    const payout = homePayout();
    if (!payout) return;
    claimOrigin = "home";
    selectClaim(payout);
    openClaim();
  });

  accounts.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    const username = button.dataset.username;
    if (!username) return;
    if (button.dataset.action === "remove") {
      askToRemove(username);
      return;
    }
    if (button.dataset.action !== "claim") return;
    const balance = Number(button.dataset.balance);
    if (!Number.isFinite(balance)) return;
    claimOrigin = "accounts";
    selectClaim({ username, balance, accounts: [username] });
    openClaim();
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
    const payout = currentPayout();
    if (!payout || !isSolanaAddress(wallet.value)) return;
    claimButton.disabled = true;
    void claimPayout(payout.username, wallet.value.trim(), payout.balance, payout.accounts).then((ok) => {
      claimStatus.hidden = false;
      claimStatus.textContent = ok ? "Claim sent" : "Couldn't send claim";
      claimButton.disabled = ok || !isSolanaAddress(wallet.value);
      if (!ok) return;
      clearEarnings();
      void refreshEarnings();
    });
  });

  processingDone.addEventListener("click", () => {
    showScreen(claimOrigin);
  });

  const homeView = home;
  const accountsView = accounts;
  const claimView = claim;
  const processingView = processing;
  const footerView = footer;
  const walletInput = wallet;
  const walletMessage = walletError;
  const claimSubmit = claimButton;
  const claimMessage = claimStatus;
  const homeTab = navHome;
  const accountsTab = navAccounts;

  function openClaim(): void {
    const payout = currentPayout();
    if (!payout) return;
    walletInput.value = "";
    walletInput.setAttribute("aria-invalid", "false");
    walletMessage.hidden = true;
    const label = `Claim ${formatPayout(payout.balance)}`;
    claimSubmit.textContent = label;
    claimSubmit.title = label;
    claimSubmit.disabled = true;
    claimMessage.hidden = true;
    claimMessage.textContent = "";
    showScreen("claim");
    walletInput.focus();
  }

  function showScreen(screen: Screen): void {
    homeView.hidden = screen !== "home";
    accountsView.hidden = screen !== "accounts";
    claimView.hidden = screen !== "claim";
    processingView.hidden = screen !== "processing";
    footerView.hidden = screen === "claim" || screen === "processing";
    markTab(homeTab, screen === "home");
    markTab(accountsTab, screen === "accounts");
  }
}

watchAccountList();

let pendingRemoval = "";

function watchAccountList(): void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(SIGNED_IN_ACCOUNTS_KEY in changes)) return;
    const change = changes[SIGNED_IN_ACCOUNTS_KEY];
    if (!change || sameAccounts(change.oldValue, change.newValue)) return;
    void refreshEarnings();
  });
}

function askToRemove(username: string): void {
  if (!(confirmRemove instanceof HTMLElement) || !(confirmAccount instanceof HTMLElement)) return;
  pendingRemoval = username;
  confirmAccount.textContent = `@${username}`;
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
    const username = pendingRemoval;
    closeRemoveConfirm();
    if (!username) return;
    void forgetAccount(username).then(() => refreshEarnings());
  });
}

function markTab(button: HTMLButtonElement, current: boolean): void {
  if (current) button.setAttribute("aria-current", "page");
  else button.removeAttribute("aria-current");
}

async function forgetAccount(username: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  await chrome.runtime.sendMessage({ type: "forget-account", username });
}

async function claimPayout(
  username: string,
  walletAddress: string,
  balance: number,
  accounts: string[],
): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return false;
  const response: unknown = await chrome.runtime.sendMessage({
    type: "claim-payout",
    username,
    usernames: accounts,
    wallet: walletAddress,
    balance,
  });
  return Boolean(response) && typeof response === "object" && (response as { ok?: unknown }).ok === true;
}
