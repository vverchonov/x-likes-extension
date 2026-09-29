import { isAddress } from "@solana/addresses";

export function isSolanaAddress(value: string): boolean {
  return isAddress(value.trim());
}
