// T-016: M0 acceptance flow on FakeTranslationProvider (TASKS.md "M0
// acceptance (end to end)", docs/TEST-PLAN.md section 3). Three browser contexts
// — teacher Layla (ar), students Marco (en) and Aisha (fr) — against one local
// wrangler-dev origin. Selectors come from the stable data-testid contract
// (docs/TEST-PLAN.md 3.1), never from copy or CSS classes: the UI is RTL and
// multilingual, so text assertions are inherently fragile.
//
// Flow (docs/MIC-CONTROL.md, Zoom/Meet semantics): everyone joins mic-closed.
// The teacher opens their own mic, then Marco opens his while Layla keeps
// talking — two independent per-speaker translation pipes at once (PROTOCOL
// section 2). The teacher force-mutes Marco (a rejected reopen answers
// mic-forced-muted), unmutes him, and finally runs mute-all / unmute-all;
// students always reopen their own mics. Mic control is server-authoritative:
// every visible state change traces back to a DO broadcast.
//
// Audio: `?injectAudio=1` feeds synthetic sine frames straight to
// AudioFrameSender through the existing capture seam, so the run needs no
// microphone and no fake-device WAV. The Chromium fake-media flags in
// playwright.config.ts are backup only (OQ-10: the seam worked first try).
//
// Metrics and captions: the DO broadcasts `{t:"metrics"}` on real traffic, so
// the panel lists live pairs with `data-status` plus real counters. The fake
// provider is launched with FAKE_EMIT_TRANSCRIPTS=1 so the caption panel is
// exercised end to end. Latency stays asserted from the browser-local estimate
// (`data-source="local"`); the DO deliberately reports `e2eLatencyMs: null`.
import { expect, test, type Page } from "@playwright/test";

/** Must match E2E_ORIGIN in playwright.config.ts. */
const ORIGIN = "http://127.0.0.1:8787";

/** Off-origin URLs the sealed network allows: the decorative web fonts in
 *  web/index.html. They are aborted, never fetched; anything else fails. */
const FONT_URL = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

interface AudioCounters {
  readonly pid: string | null;
  readonly sent: number;
  readonly received: number;
  readonly played: number;
}

const NO_COUNTERS: AudioCounters = { pid: null, sent: -1, received: -1, played: -1 };

declare global {
  interface Window {
    __fitraAudio?: {
      pid(): string | null;
      sent(): number;
      received(): number;
      played(): number;
    };
  }
}

/** Live audio counters published by web/src/audio/roomShell.ts. */
async function audio(page: Page): Promise<AudioCounters> {
  return page.evaluate((): AudioCounters => {
    const hooks = window.__fitraAudio;
    if (hooks === undefined) return NO_COUNTERS;
    return {
      pid: hooks.pid(),
      sent: hooks.sent(),
      received: hooks.received(),
      played: hooks.played(),
    };
  });
}

/** Participant indexes currently mic-open, from the mic-banner's JSON attr. */
async function speakingOf(page: Page): Promise<number[]> {
  const raw = await page.getByTestId("mic-banner").getAttribute("data-speaking");
  const parsed: unknown = JSON.parse(raw ?? "[]");
  return Array.isArray(parsed) ? parsed.map(Number) : [];
}

/**
 * Seal the context to the local origin: every off-origin request is aborted and
 * remembered, so the test can prove at the end that nothing but the decorative
 * font links ever left the browser (AGENTS.md rule 3, zero outbound network).
 */
async function sealNetwork(page: Page, origin: string, blocked: string[]): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) {
      await route.continue();
      return;
    }
    blocked.push(url);
    await route.abort();
  });
}

/**
 * Create a room through the real Create screen and land on the prefilled Join
 * screen (the teacher's own path in the product, not a shortcut).
 */
async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto("/?injectAudio=1#/create");
  await page.getByTestId("teacher-name").fill(name);
  await page.getByTestId("consent-confirm").click();
  await page.getByTestId("create-room").click();
  const raw = await page.getByTestId("room-code").textContent();
  const code = (raw ?? "").trim();
  expect(code, "create-room must mint a room code").not.toBe("");
  await page.getByTestId("enter-room").click();
  return code;
}

/** Complete the consent gate and submit, on whichever Join screen is showing. */
async function acceptConsentAndJoin(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("consent-modal")).toBeVisible();
  // PRIVACY rule 3: joining is blocked until consent is accepted.
  await expect(page.getByTestId("join-room")).toBeDisabled();
  await page.getByTestId("consent-accept").click();
  await expect(page.getByTestId("join-room")).toBeEnabled();
  await page.getByTestId("display-name").fill(name);
  await page.getByTestId("join-room").click();
  await expect(page.getByTestId("mic-banner")).toBeVisible();
  await expect(page.getByTestId("room-error")).toHaveCount(0);
}

async function joinFromHash(
  page: Page,
  params: { readonly code: string; readonly role: "teacher" | "student"; readonly lang: string },
): Promise<void> {
  await page.goto(
    `/?injectAudio=1#/join?code=${params.code}&role=${params.role}&lang=${params.lang}`,
  );
}

test("M0 acceptance: simultaneous speakers, force-mute, unmute", async ({
  browser,
}) => {
  const blocked: string[] = [];
  const teacherCtx = await browser.newContext();
  const enCtx = await browser.newContext();
  const frCtx = await browser.newContext();
  try {
    const teacher = await teacherCtx.newPage();
    const studentEn = await enCtx.newPage();
    const studentFr = await frCtx.newPage();
    const pages = [teacher, studentEn, studentFr];
    for (const page of pages) await sealNetwork(page, ORIGIN, blocked);

    // --- create -> join x3 (consent-accept on every join) --------------------
    const code = await createRoom(teacher, "Layla");
    await acceptConsentAndJoin(teacher, "Layla");
    await joinFromHash(studentEn, { code, role: "student", lang: "en" });
    await acceptConsentAndJoin(studentEn, "Marco");
    await joinFromHash(studentFr, { code, role: "student", lang: "fr" });
    await acceptConsentAndJoin(studentFr, "Aisha");

    // --- roster + RTL + baseline: everyone mic-closed, nobody forced (NFR-004)
    for (const page of pages) {
      await expect(page.getByTestId("roster-count")).toHaveText("3");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(page.getByTestId("mic-banner")).toHaveAttribute("data-speaking", "[]");
      await expect(page.getByTestId("mic-toggle")).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("mic-toggle")).toHaveAttribute("data-forced", "false");
    }
    await expect(teacher.getByTestId("roster")).toContainText("Layla");
    await expect(teacher.getByTestId("roster")).toContainText("Marco");
    await expect(teacher.getByTestId("roster")).toContainText("Aisha");
    const enPid = (await audio(studentEn)).pid;
    expect(enPid, "welcome must publish this tab's participantId").not.toBeNull();
    const frPid = (await audio(studentFr)).pid;
    expect(frPid, "welcome must publish this tab's participantId").not.toBeNull();
    await expect(
      teacher.getByTestId(`roster-row-${enPid as string}`),
    ).toHaveAttribute("data-mic", "false");
    await expect(
      teacher.getByTestId(`roster-row-${enPid as string}`),
    ).toHaveAttribute("data-forced", "false");
    // Students get no teacher controls: no mute-all/unmute-all, no row buttons.
    await expect(studentEn.getByTestId("mute-all")).toHaveCount(0);
    await expect(studentEn.getByTestId("unmute-all")).toHaveCount(0);
    await expect(studentEn.getByTestId(`mute-${enPid as string}`)).toHaveCount(0);
    await expect(studentEn.getByTestId(`unmute-${enPid as string}`)).toHaveCount(0);

    // --- teacher opens their mic: both students hear, the speaker hears nothing
    // FR-015: a speaker never receives the translation of their own speech.
    await teacher.getByTestId("mic-toggle").click();
    for (const page of pages) {
      await expect.poll(() => speakingOf(page)).toEqual([0]);
    }
    await expect(teacher.getByTestId("mic-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await audio(studentEn)).received, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await audio(studentFr)).received, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await audio(studentEn)).played, { timeout: 30_000 }).toBeGreaterThan(0);
    expect((await audio(teacher)).received, "FR-015: speaker gets none of their own speech").toBe(0);
    // Live translation pipes, one per speaker+student-language pair (FR-022):
    // teacher index 0 speaks ar, so 0:ar->en and 0:ar->fr open.
    await expect(teacher.getByTestId("session-0:ar->en")).toBeVisible();
    await expect(teacher.getByTestId("session-0:ar->fr")).toBeVisible();
    // The speaker sees their own original and translated text (FR-034).
    await expect(teacher.getByTestId("caption-live-input")).toContainText(/in\d+/);
    await expect(teacher.getByTestId("caption-live-output")).toContainText(/out\d+/);

    // --- Marco opens his mic while Layla keeps talking: independent pipes -----
    await studentEn.getByTestId("mic-toggle").click();
    for (const page of pages) {
      await expect.poll(() => speakingOf(page)).toEqual([0, 1]);
    }
    const teacherBefore = (await audio(teacher)).received;
    await expect.poll(async () => (await audio(teacher)).received, { timeout: 30_000 }).toBeGreaterThan(teacherBefore);
    await expect(teacher.getByTestId("session-1:en->ar")).toBeVisible({ timeout: 30_000 });

    // --- teacher force-mutes Marco: row flags, notice, rejected reopen --------
    await teacher.getByTestId(`mute-${enPid as string}`).click();
    for (const page of pages) {
      await expect(
        page.getByTestId(`roster-row-${enPid as string}`),
      ).toHaveAttribute("data-forced", "true", { timeout: 30_000 });
      await expect(
        page.getByTestId(`roster-row-${enPid as string}`),
      ).toHaveAttribute("data-mic", "false");
      await expect.poll(() => speakingOf(page)).toEqual([0]);
    }
    await expect(studentEn.getByTestId("forced-muted-notice")).toBeVisible();
    // A closed row offers the teacher the clear-force button instead.
    await expect(teacher.getByTestId(`mute-${enPid as string}`)).toHaveCount(0);
    await expect(teacher.getByTestId(`unmute-${enPid as string}`)).toBeVisible();
    // Marco tries to reopen anyway: the DO answers mic-forced-muted.
    await studentEn.getByTestId("mic-toggle").click();
    await expect(studentEn.getByTestId("room-error")).toBeVisible({ timeout: 30_000 });

    // --- force-mute must silence the pipe ------------------------------------
    const frozen = (await audio(teacher)).received;
    await teacher.waitForTimeout(2_000);
    expect((await audio(teacher)).received, "force-mute must silence the teacher's pipe").toBe(frozen);

    // --- teacher clears the force: banner resets, Marco reopens himself -------
    await teacher.getByTestId(`unmute-${enPid as string}`).click();
    await expect(
      studentEn.getByTestId(`roster-row-${enPid as string}`),
    ).toHaveAttribute("data-forced", "false", { timeout: 30_000 });
    await expect(studentEn.getByTestId("forced-muted-notice")).toHaveCount(0);
    // The roster snapshot the unmute carries also retires the stale error.
    await expect(studentEn.getByTestId("room-error")).toHaveCount(0, { timeout: 30_000 });
    // Unmuting only clears the force; the mic stays closed until Marco opens it.
    await expect(studentEn.getByTestId("mic-toggle")).toHaveAttribute("aria-pressed", "false");
    for (const page of pages) {
      await expect.poll(() => speakingOf(page)).toEqual([0]);
    }
    await studentEn.getByTestId("mic-toggle").click();
    for (const page of pages) {
      await expect.poll(() => speakingOf(page)).toEqual([0, 1]);
    }
    await expect.poll(async () => (await audio(teacher)).received, { timeout: 30_000 }).toBeGreaterThan(frozen);

    // --- mute-all latches everyone but the teacher; unmute-all clears only the
    // force, so each student reopens their own mic (MIC-CONTROL.md).
    await teacher.getByTestId("mute-all").click();
    for (const page of pages) {
      await expect(
        page.getByTestId(`roster-row-${enPid as string}`),
      ).toHaveAttribute("data-forced", "true", { timeout: 30_000 });
      await expect(
        page.getByTestId(`roster-row-${frPid as string}`),
      ).toHaveAttribute("data-forced", "true", { timeout: 30_000 });
      await expect(
        page.getByTestId(`roster-row-${frPid as string}`),
      ).toHaveAttribute("data-mic", "false");
      await expect.poll(() => speakingOf(page)).toEqual([0]);
    }
    await expect(studentEn.getByTestId("forced-muted-notice")).toBeVisible();
    await expect(studentFr.getByTestId("forced-muted-notice")).toBeVisible();
    await teacher.getByTestId("unmute-all").click();
    for (const page of pages) {
      await expect(
        page.getByTestId(`roster-row-${enPid as string}`),
      ).toHaveAttribute("data-forced", "false", { timeout: 30_000 });
      await expect(
        page.getByTestId(`roster-row-${frPid as string}`),
      ).toHaveAttribute("data-forced", "false", { timeout: 30_000 });
      await expect(
        page.getByTestId(`roster-row-${enPid as string}`),
      ).toHaveAttribute("data-mic", "false");
    }
    await studentEn.getByTestId("mic-toggle").click();
    for (const page of pages) {
      await expect.poll(() => speakingOf(page)).toEqual([0, 1]);
    }

    // --- metrics panel: browser latency + real DO session rows ---------------
    await expect(teacher.getByTestId("metrics-panel")).toBeVisible();
    await expect(teacher.getByTestId("metric-latency")).toHaveAttribute("data-latency-ms", /\d+/);
    await expect(teacher.getByTestId("metric-latency")).toHaveAttribute("data-source", "local");
    await expect(teacher.getByTestId("metric-latency")).toHaveAttribute("data-samples", /[1-9]/);
    await expect(teacher.getByTestId("metric-sessions")).toBeVisible();
    await expect(teacher.getByTestId("metric-session-0:ar->en")).toHaveAttribute("data-status", "live", { timeout: 30_000 });
    await expect(teacher.getByTestId("metric-session-0:ar->fr")).toHaveAttribute("data-status", "live", { timeout: 30_000 });
    await expect(teacher.getByTestId("metric-session-1:en->ar")).toHaveAttribute("data-status", "live", { timeout: 30_000 });

    // --- captions: committed turns persist oldest-first ----------------------
    // Marco's turn committed when the teacher force-muted him (mic close is a
    // turn boundary for that speaker only); Layla's turn stays live since she
    // never closed her mic.
    await expect(teacher.getByTestId("captions")).toBeVisible();
    await expect(teacher.getByTestId("caption-history-0")).toContainText(/in\d+/);
    await expect(teacher.getByTestId("caption-history-0")).toContainText(/out\d+/);
    await expect(teacher.getByTestId("caption-live-output")).toHaveAttribute("aria-live", "polite");

    // --- zero outbound network, zero Gemini, zero secrets --------------------
    const stray = blocked.filter((url) => !FONT_URL.test(url));
    expect(stray, "no request may leave localhost").toEqual([]);
  } finally {
    await teacherCtx.close();
    await enCtx.close();
    await frCtx.close();
  }
});
