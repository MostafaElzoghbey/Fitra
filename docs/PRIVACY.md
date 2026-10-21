# Fitra — Privacy & Consent Requirements

## 1. Hard rules (normative, all milestones)

1. **No recording or storage by default.** Audio is streamed translation-only:
   browser → DO → Gemini → DO → listeners. No audio persisted in the DO
   (memory only), Workers, D1, or the browser (beyond the ~500 ms playback
   jitter buffer). Session summaries (M3) store text only, batched.
2. **Free-tier Gemini is dev/test only.** On the Gemini free tier, "Google uses
   the content you submit … to provide, improve, and develop Google products"
   and "human reviewers may read, annotate, and process your API input and
   output" (source: `https://ai.google.dev/gemini-api/terms`; pricing page
   marks Free tier "Used to improve our products: Yes" —
   `https://ai.google.dev/gemini-api/docs/pricing`). **Production requires the
   paid Gemini tier**, where prompts/responses are not used for training.
3. **Consent before joining.** A blocking notice (Arabic + participant
   language) must be accepted before mic access: live voice is translated by
   an AI service; on free-tier test deployments it may be reviewed/used by
   Google; no recording by Fitra; leave anytime. Minors: the notice addresses
   a parent/guardian and the teacher must confirm consent was obtained
   (checkbox at room creation).
4. **Minimal PII.** M0 stores: display name, role, language, room code —
   in DO memory/SQLite only, purged on room close. No emails, no device IDs,
   no analytics in M0.
5. **Key hygiene.** Gemini key in Worker secret only; token minting
   server-side; ephemeral-token browser-direct mode is rejected for M0 (would
   expose quota-bearing credentials to clients).
6. **Captions/M3 data.** Transcripts are text: batch-write to D1 (never
   per-chunk), retention default 30 days, teacher-visible delete button.

## 2. UI strings required (M0)

- Pre-join consent modal (ar + en + fr + es), accept/decline.
- "Teacher confirms student consent" checkbox at room creation.
- Footer badge in-room: "Test deployment — AI-translated, not recorded by us."
