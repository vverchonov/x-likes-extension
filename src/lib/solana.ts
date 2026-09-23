const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function isSolanaAddress(value: string): boolean {
  const bytes = decodeBase58(value.trim());
  return bytes?.length === 32;
}

function decodeBase58(value: string): Uint8Array | null {
  if (!value) return null;
  let num = 0n;
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    num = num * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }

  let zeros = 0;
  for (const char of value) {
    if (char !== "1") break;
    zeros += 1;
  }

  const decoded = new Uint8Array(zeros + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    decoded[decoded.length - 1 - index] = bytes[index] ?? 0;
  }
  return decoded;
}
