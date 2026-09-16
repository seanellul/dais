"use client";

import { useId, useState } from "react";
import { decodeHandoff } from "@/judge/handoff";

/** Decode checked hand-off pixels locally without receiving a sheet. */
export async function scanHandoffPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string> {
  const { default: jsQR } = await import("jsqr");
  const code = jsQR(pixels, width, height, { inversionAttempts: "attemptBoth" });
  if (!code) throw new Error("No QR code was found. Choose a clear image showing the whole code.");
  try {
    decodeHandoff(code.data);
  } catch {
    throw new Error("This is not a complete Dais hand-off. Choose the judge’s hand-off QR image.");
  }
  return code.data;
}

async function scanImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a QR image or photo.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image smaller than 20 MB.");
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    try {
      await image.decode();
    } catch {
      throw new Error("This photo could not be opened. Try a screenshot, JPEG or PNG image.");
    }
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new Error("This browser cannot read the image. Paste the full hand-off text instead.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return scanHandoffPixels(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
    );
  } finally {
    URL.revokeObjectURL(source);
  }
}

/** Photo/file scan: fills the existing text field for an explicit organiser decision. */
export function HandoffScanner({ onDecoded }: { onDecoded: (text: string) => void }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  return (
    <div>
      <label className="org-field" htmlFor={id}>
        Choose a hand-off QR image or photo
      </label>
      <input
        id={id}
        className="org-input"
        type="file"
        accept="image/*"
        capture="environment"
        disabled={busy}
        aria-describedby={`${id}-help`}
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          setBusy(true);
          setError("");
          setMessage("");
          try {
            onDecoded(await scanImage(file));
            setMessage(
              "QR read. Review the hand-off text and judge seat, then choose Receive hand-off.",
            );
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "The QR image could not be read. Paste the full hand-off text instead.",
            );
          } finally {
            setBusy(false);
          }
        }}
      />
      <p id={`${id}-help`} className="org-muted">
        Use a clear photo or screenshot of the whole hand-off QR. The image is read on this device
        and is not uploaded.
      </p>
      <p role="status">{busy ? "Reading the QR image…" : message}</p>
      {error && (
        <p role="alert" className="org-error">
          {error}
        </p>
      )}
    </div>
  );
}
