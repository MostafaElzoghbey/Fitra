import { describe, expect, it } from "vitest";
import { FITRA_AUDIO_HEADER_BYTES } from "../src/index.js";

describe("shared stub", () => {
  it("exposes the audio header size constant", () => {
    expect(FITRA_AUDIO_HEADER_BYTES).toBe(8);
  });
});
