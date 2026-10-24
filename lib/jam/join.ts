// Helpers for the "how do people get in" panel on the host.

export function joinUrl(base: string, code: string): string {
  const u = new URL(base);
  u.searchParams.set("code", code);
  return u.toString();
}

// Payload for the standard Wi-Fi QR code (Android/iOS cameras offer to join).
// Special characters in SSID/password must be backslash-escaped.
export function wifiQrPayload(ssid: string, password: string): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`;
}
