"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { joinUrl, wifiQrPayload } from "@/lib/jam/join";
import type { TransportInfo } from "@/lib/jam/transport";

function Qr({ text, label }: { text: string; label: string }) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: 192, color: { dark: "#000", light: "#fff" } })
      .then((url) => live && setSrc(url))
      .catch(() => live && setSrc(""));
    return () => {
      live = false;
    };
  }, [text]);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt={label} width={160} height={160} className="jam__qr" /> : <div className="jam__qr" />;
}

export default function JoinPanel({ info, code }: { info: TransportInfo; code: string }) {
  const urls = info.urls.map((u) => joinUrl(u, code));
  const [active, setActive] = useState(0);
  const url = urls[Math.min(active, urls.length - 1)];

  return (
    <div className="jam__join">
      {info.hotspotError && (
        <p className="jam__error" style={{ width: "100%" }}>
          No jam hotspot: {info.hotspotError} Connect every device to the same Wi-Fi or your phone&apos;s own hotspot
          instead — the link below still works.
        </p>
      )}
      {info.hotspot && (
        <div className="jam__join-step">
          <p className="jam__step-label">1 · Join the Wi-Fi</p>
          <Qr text={wifiQrPayload(info.hotspot.ssid, info.hotspot.password)} label="Wi-Fi QR code" />
          <p className="jam__mono">{info.hotspot.ssid}</p>
          <p className="jam__mono">{info.hotspot.password}</p>
        </div>
      )}
      <div className="jam__join-step">
        <p className="jam__step-label">{info.hotspot ? "2 · Open the jam" : "Open the jam"}</p>
        {url ? <Qr text={url} label="Jam link QR code" /> : <p className="jam__muted">No network address found.</p>}
        <p className="jam__mono">{url}</p>
        {urls.length > 1 && (
          <select value={active} onChange={(e) => setActive(Number(e.target.value))} aria-label="Network address">
            {urls.map((u, i) => (
              <option key={u} value={i}>
                {new URL(u).host}
              </option>
            ))}
          </select>
        )}
        <p className="jam__code">
          Code <strong>{code}</strong>
        </p>
      </div>
    </div>
  );
}
