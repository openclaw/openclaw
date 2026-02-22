/** Whether the overview should show device-pairing guidance for this error. */
export function shouldShowPairingHint(connected: boolean, lastError: string | null): boolean {
  if (connected || !lastError) {
    return false;
  }
  return lastError.toLowerCase().includes("pairing required");
}
