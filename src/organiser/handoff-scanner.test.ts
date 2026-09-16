import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { encodeHandoff, decodeHandoff } from "@/judge/handoff";
import { fixturePayload, judgeFixture } from "../../tests/unit/judge/fixtures";
import { scanHandoffPixels } from "./handoff-scanner";

function qrPixels(text: string) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const scale = 4,
    margin = 4;
  const width = (qr.modules.size + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < qr.modules.size; y++)
    for (let x = 0; x < qr.modules.size; x++)
      if (qr.modules.get(y, x))
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const at = (((y + margin) * scale + dy) * width + (x + margin) * scale + dx) * 4;
            pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
          }
  return { pixels, width };
}

describe("organiser hand-off QR image", () => {
  it("decodes an actual generated full hand-off QR and preserves checked request identity", async () => {
    const judge = judgeFixture();
    const input = {
      assignmentId: judge.assignments[0].id,
      judgeId: judge.judge.id,
      requestId: "qr-image-fixture",
      baseVersion: 0,
      payload: fixturePayload(),
    };
    const encoded = encodeHandoff(input).text;
    const image = qrPixels(encoded);
    const result = await scanHandoffPixels(image.pixels, image.width, image.width);
    expect(result).toBe(encoded);
    expect(decodeHandoff(result)).toMatchObject({
      assignmentId: input.assignmentId,
      judgeId: input.judgeId,
      requestId: input.requestId,
    });
  });
  it("refuses a QR containing an unrelated URL", async () => {
    const image = qrPixels("https://example.test/unrelated");
    await expect(scanHandoffPixels(image.pixels, image.width, image.width)).rejects.toThrow(
      /complete Dais hand-off/,
    );
  });
  it("reports an image without a QR without producing a hand-off", async () => {
    await expect(
      scanHandoffPixels(new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100),
    ).rejects.toThrow(/No QR code/);
  });
});
