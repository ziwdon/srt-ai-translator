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

### Gotchas

- The dev command uses `next dev --webpack` (webpack bundler, not Turbopack). Build also uses `--webpack`.
- The `/api/config` endpoint returns `{"ok":false,...}` when the API key is missing — this is expected behavior, not a bug.
- `.env.local` is gitignored. Each environment must create its own from `.env.example`.
