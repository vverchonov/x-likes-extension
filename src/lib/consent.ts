export const DISCLAIMER_ACCEPTED_KEY = "disclaimerAcceptedV2";
export const SETUP_READY_KEY = "setupReadySeen";
export const CAPTURE_CONSENT_ATTR = "data-likes-capture";

export async function isDisclaimerAccepted(): Promise<boolean> {
  if (hasChromeStorage()) {
    const stored = await chrome.storage.local.get({ [DISCLAIMER_ACCEPTED_KEY]: false });
    return stored[DISCLAIMER_ACCEPTED_KEY] === true;
  }
  return localStorage.getItem(DISCLAIMER_ACCEPTED_KEY) === "true";
}

export async function acceptDisclaimer(): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [DISCLAIMER_ACCEPTED_KEY]: true });
    return;
  }
  localStorage.setItem(DISCLAIMER_ACCEPTED_KEY, "true");
}

export async function isSetupReadySeen(): Promise<boolean> {
  if (hasChromeStorage()) {
    const stored = await chrome.storage.local.get({ [SETUP_READY_KEY]: false });
    return stored[SETUP_READY_KEY] === true;
  }
  return localStorage.getItem(SETUP_READY_KEY) === "true";
}

export async function markSetupReadySeen(): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [SETUP_READY_KEY]: true });
    return;
  }
  localStorage.setItem(SETUP_READY_KEY, "true");
}

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}
