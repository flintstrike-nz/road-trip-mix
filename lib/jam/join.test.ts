import { describe, expect, it } from "vitest";
import { joinUrl, wifiQrPayload } from "./join";

describe("join helpers", () => {
  it("puts the code in the URL", () => {
    expect(joinUrl("http://192.168.43.1:8787", "AB3K")).toBe("http://192.168.43.1:8787/?code=AB3K");
  });
  it("escapes Wi-Fi QR fields", () => {
    const out = wifiQrPayload("My;Net", String.raw`p:a\ss"w,rd`);
    expect(out).toBe(String.raw`WIFI:T:WPA;S:My\;Net;P:p\:a\\ss\"w\,rd;;`);
  });
});
