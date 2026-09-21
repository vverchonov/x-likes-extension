export async function isCaptureEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get({ captureEnabled: true });
  return stored.captureEnabled !== false;
}
