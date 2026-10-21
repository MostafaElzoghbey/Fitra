import { describe, expect, it } from "vitest";
import app from "../src/index.js";

describe("GET /api/health", () => {
  it("responds {ok:true}", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
