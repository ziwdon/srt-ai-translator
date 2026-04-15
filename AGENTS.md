## Cursor Cloud specific instructions

This is a **Next.js 16** app (SRT AI Translator) that translates subtitle files using Google Gemini AI. It also has a client-side Time Offset tool that needs no API key.

### Services

| Service | Command | Notes |
|---------|---------|-------|
| Dev server | `npm run dev` | Runs on `http://localhost:3000`. Serves both frontend and API routes. |

### Key commands

See `package.json` scripts. Summary:

- **Lint:** `npm run lint`
- **Build:** `npm run build`
- **Dev:** `npm run dev`

### Environment variables

Copy `.env.example` to `.env.local`. The only required secret for full functionality is `GOOGLE_GENERATIVE_AI_API_KEY` (Gemini API key). Without it the app loads but translation requests fail; the Time Offset feature still works.

### Hello world task

Without a Gemini API key, use the **Time Offset** feature as the hello world task: upload any `.srt` file, apply a millisecond offset, and verify the downloaded file has shifted timestamps. This exercises the app's core SRT-processing logic entirely client-side.

### Gotchas

- The dev command uses `next dev --webpack` (webpack bundler, not Turbopack). Build also uses `--webpack`.
- The `/api/config` endpoint returns `{"ok":false,...}` when the API key is missing — this is expected behavior, not a bug.
- `.env.local` is gitignored. Each environment must create its own from `.env.example`.
- When no `GOOGLE_GENERATIVE_AI_API_KEY` is set, the UI may show a config error banner on the Translate tab. This is expected — dismiss or ignore it and use the Time Offset tab instead.
