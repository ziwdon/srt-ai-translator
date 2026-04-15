# Parallel Bulk Translation — Implementation Plan

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture](#2-current-architecture)
3. [Target Architecture](#3-target-architecture)
4. [New Environment Variable](#4-new-environment-variable)
5. [Implementation Changes by File](#5-implementation-changes-by-file)
   - [5.1 `lib/translation-config.ts`](#51-libtranslation-configts)
   - [5.2 `app/api/config/route.ts`](#52-appapiconfigroutets)
   - [5.3 `app/page.tsx`](#53-apppagetsx)
   - [5.4 `components/Form.tsx`](#54-componentsformtsx)
   - [5.5 `components/Timestamp.tsx`](#55-componentstimestampts)
   - [5.6 `.env.example`](#56-envexample)
   - [5.7 `README.md`](#57-readmemd)
6. [Files That Require No Changes](#6-files-that-require-no-changes)
7. [Detailed Change Specifications](#7-detailed-change-specifications)
   - [7.1 Concurrency Engine in `handleBulkSubmit`](#71-concurrency-engine-in-handlebulksubmit)
   - [7.2 Per-File Progress Tracking State Model](#72-per-file-progress-tracking-state-model)
   - [7.3 UI Simplification — Remove Real-Time Translation Preview](#73-ui-simplification--remove-real-time-translation-preview)
   - [7.4 UI Simplification — Remove SRT Editor Links](#74-ui-simplification--remove-srt-editor-links)
   - [7.5 Progress UI — Per-File Progress Bars](#75-progress-ui--per-file-progress-bars)
   - [7.6 Error Handling & Network Resilience Reinforcement](#76-error-handling--network-resilience-reinforcement)
   - [7.7 Retry Failed Files](#77-retry-failed-files)
8. [Concurrency Control — Implementation Pattern](#8-concurrency-control--implementation-pattern)
9. [Risk Assessment & Mitigations](#9-risk-assessment--mitigations)
10. [Post-Implementation Review Checklist](#10-post-implementation-review-checklist)

---

## 1. Executive Summary

This plan converts the bulk SRT translation pipeline from **sequential** (one file at a time) to **parallel** (up to N files simultaneously), where N is configurable via the Netlify environment variable `TRANSLATION_MAX_PARALLEL` (default: `5`).

The UI is simplified to focus on per-file progress bars, removing the real-time line-by-line translation preview and the third-party SRT editor link. All existing features (single file translation, retry failed, ZIP download, time-offset mode) remain fully functional.

---

## 2. Current Architecture

### Translation Flow (Sequential)

```
User uploads files → Form.tsx reads files → handleBulkSubmit()
  → for each file (sequentially):
      → translateSingleFile()
        → parse SRT, group segments by token length
        → for each segment group:
            → requestTranslationBatch() → POST /api
            → handleStream() → update translatedChunks + progress
      → mark file success/failed
  → finalizeBulkRun() → ZIP download or single file download
```

### Key State Variables (Current)

| State | Purpose |
|-------|---------|
| `status` | `"idle" \| "busy" \| "done"` — global app status |
| `progress` | `TranslationProgress` — segments/requests for the **single active file** |
| `bulkProgress` | `BulkProgress` — overall file count progress |
| `fileResults` | `FileResult[]` — per-file status, content, errors |
| `translatedChunks` | `Chunk[]` — live preview of segments for the active file |
| `originalChunks` | `Chunk[]` — original segments for the active file's preview |

### Problem

With sequential processing, translating 10 files that each take 60 seconds requires ~10 minutes. With 5-way parallelism, the same batch completes in ~2 minutes.

---

## 3. Target Architecture

### Translation Flow (Parallel)

```
User uploads files → Form.tsx reads files → handleBulkSubmit()
  → create concurrency pool (size = maxParallel from config)
  → launch up to N translateSingleFile() calls in parallel
  → each file independently:
      → parse SRT, group segments, loop batches
      → update its own entry in fileResults[] (with per-file progress)
      → mark success/failed when done
  → when a slot frees, start next pending file
  → when all files done → finalizeBulkRun()
```

### Key Differences

1. **Multiple `translateSingleFile` calls run concurrently** — each operates independently.
2. **Per-file progress tracking** — each `FileResult` carries its own batch-level progress (`completedBatches / totalBatches`) instead of a single global `progress` state.
3. **No shared mutable live preview** — the `translatedChunks`/`originalChunks` state and the `Translating` component are removed.
4. **Concurrency limit** — a semaphore/pool pattern controls how many files translate simultaneously.
5. **Independent error isolation** — one file's failure does not affect other in-flight translations.

---

## 4. New Environment Variable

### `TRANSLATION_MAX_PARALLEL`

| Property | Value |
|----------|-------|
| Name | `TRANSLATION_MAX_PARALLEL` |
| Type | Integer |
| Default | `5` |
| Valid range | `1` to `20` |
| Where set | Netlify site environment variables, or `.env.local` for local dev |
| Server-side access | `process.env.TRANSLATION_MAX_PARALLEL` in `lib/translation-config.ts` |
| Client-side access | Exposed via `GET /api/config` response payload |

---

## 5. Implementation Changes by File

### 5.1 `lib/translation-config.ts`

**Changes:**
- Add constant `DEFAULT_MAX_PARALLEL = 5`, `MIN_MAX_PARALLEL = 1`, `MAX_MAX_PARALLEL = 20`.
- Add `maxParallel: number` field to the `TranslationRuntimeConfig` type.
- In `resolveTranslationRuntimeConfig()`, read `process.env.TRANSLATION_MAX_PARALLEL`, parse it as an integer, validate the range, and include it in the returned config. If parsing fails or the value is out of range, default to `5` (do **not** treat this as a fatal config error — just clamp or fall back to the default).

**Specific code location:**
- After the `maxTokensPerRequest` resolution block (line ~88), add similar logic for `TRANSLATION_MAX_PARALLEL`.
- Add `maxParallel` to the returned `config` object in the final `return` statement (line ~91–99).
- Add `maxParallel` to the `TranslationRuntimeConfig` type definition (line ~10–15).

### 5.2 `app/api/config/route.ts`

**Changes:**
- Include `maxParallel: config.maxParallel` in the JSON response body so the client can read the configured parallelism limit.

**Specific code location:**
- Add `maxParallel: config.maxParallel` to the `JSON.stringify()` object (line ~13–19).

### 5.3 `app/page.tsx`

This is the largest and most complex set of changes. See Section 7 for detailed specifications.

**Summary of changes:**

1. **New state: `maxParallel`** — fetched from `/api/config`, defaults to `5`.
2. **Expanded `FileResult` type** — add per-file batch-level progress fields: `totalBatches`, `completedBatches`.
3. **Remove state variables**: `translatedChunks`, `originalChunks`, `progress` (the global single-file `TranslationProgress`).
4. **Remove components/sections**: `Translating` component, live preview section, SRT editor links (both bulk and single-file done views).
5. **Refactor `translateSingleFile`** — instead of setting global `progress`/`translatedChunks` state, accept an `onProgress` callback and a file index. Update the corresponding `fileResults[index]` entry with per-file progress.
6. **Simplify `handleStream`** — remove `setTranslatedChunks` calls and the `appendChunkToPreview` logic. The function still reads the response body stream, accumulates the full `content` string, and counts `translatedSegmentCount` (used to validate batch completeness). It no longer parses individual chunks into `Chunk` objects or pushes to any preview state. Accept an `onTranslatedSegment` callback for segment counting only.
7. **Refactor `handleBulkSubmit`** — replace the sequential `for` loop with a concurrency-limited parallel executor (see Section 8).
8. **Update busy UI** — replace the current stat tiles and progress bars (which show single-file segment/request progress) with a consistent per-file progress list showing one batch-level progress bar per file. Use the same layout for both single-file and multi-file translations (remove the `showBulkProgress` conditional).
9. **Update done UI** — remove the "Open SRT editor" `<a>` link from both the bulk results section and the single-file done section. Unify the done view: use the same results layout (table with filename/status/error, action buttons) for both single-file and multi-file translations, removing the `showBulkProgress` branching in the done state. For a single file, the table has one row — this is simple and consistent.
10. **Keep**: elapsed timer, file queue status list (enhanced with per-file progress bars), ZIP download, retry failed, reset to idle.

### 5.4 `components/Form.tsx`

**Changes:**
- Update the help text on line 194 from `"Queued files are translated one by one."` to `"Queued files are translated in parallel."` (or similar wording).

No structural changes needed — the `Form` component's interface (`onSubmit` signature) does not change.

### 5.5 `components/Timestamp.tsx`

**Changes:**
- No code changes needed to the component itself.
- After implementation is complete, if `Timestamp.tsx` is no longer imported anywhere, **delete the file** entirely. Since the live preview is being removed, and `Timestamp` was only used by the `Translating` component in `page.tsx`, this file will become dead code.

### 5.6 `.env.example`

**Changes:**
- Add the new variable: `TRANSLATION_MAX_PARALLEL=5`

### 5.7 `README.md`

**Changes:**
- Add documentation for the new `TRANSLATION_MAX_PARALLEL` environment variable in the "Environment variables" section (after line ~41):
  ```
  - Optional parallel translations: `TRANSLATION_MAX_PARALLEL` (default: `5`, range: `1-20`)
  ```

---

## 6. Files That Require No Changes

| File | Reason |
|------|--------|
| `app/api/route.ts` | The server-side translation endpoint is stateless per-request. Multiple concurrent POST requests are already supported — each request has its own `runId`, segments, stream. No changes needed. |
| `lib/srt.ts` | Pure function (`groupSegmentsByTokenLength`). Called independently per file. No shared state. |
| `lib/client.ts` | Pure parsing functions (`parseSegment`, `parseTimestamp`, etc.). No shared state. |
| `lib/zip.ts` | Called once at the end with all results. No change needed. |
| `types.ts` | `Chunk` and `Segment` types remain unchanged. |
| `components/OffsetForm.tsx` | Offset mode is unrelated to translation parallelism. |
| `app/layout.tsx` | Layout/metadata only. |
| `app/globals.css` | No CSS changes required (Tailwind utility classes handle all styling). |
| `netlify.toml` | Edge function config unchanged. |
| `netlify/edge-functions/basic-auth.js` | Auth logic unchanged. |
| `next.config.js` | Build config unchanged. |
| `tailwind.config.ts` | No new Tailwind customizations needed. |
| `fonts/index.ts` | Font registration unchanged. |

---

## 7. Detailed Change Specifications

### 7.1 Concurrency Engine in `handleBulkSubmit`

**Current code (sequential loop, `app/page.tsx` lines 709–759):**
```typescript
for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    // ... mark file as "translating"
    // ... await translateSingleFile(...)
    // ... mark file as "success" or "failed"
    // ... increment completedFiles
}
```

**New code (parallel with concurrency limit):**

Replace the `for` loop with a concurrency-limited parallel executor. The pattern:

```typescript
async function handleBulkSubmit(queue: QueueItem[], language: string) {
    // ... existing setup (initialResults, status, timer, bulkProgress) ...

    const nextResults = [...initialResults];
    let completedFiles = initialCompletedFiles;
    let nextPendingIndex = 0;

    async function processFile(queueIndex: number) {
        const queueItem = queue[queueIndex];
        const targetIndex = queueItem.resultIndex ?? queueIndex;
        // ... guard against invalid targetIndex ...

        // Mark as translating
        nextResults[targetIndex] = { ...nextResults[targetIndex], status: "translating", error: undefined };
        setFileResults([...nextResults]);

        try {
            const { translatedContent, outputFilename } = await translateSingleFile(
                queueItem.content,
                language,
                queueItem.filename,
                targetIndex, // pass index so progress updates target the right entry
            );
            nextResults[targetIndex] = {
                ...nextResults[targetIndex],
                status: "success",
                translatedContent,
                outputFilename,
                error: undefined,
            };
        } catch (error) {
            nextResults[targetIndex] = {
                ...nextResults[targetIndex],
                status: "failed",
                error: error instanceof Error ? error.message : "Unknown translation error.",
            };
        }

        completedFiles += 1;
        setFileResults([...nextResults]);
        setBulkProgress((prev) => ({ ...prev, completedFiles }));
    }

    // Launch parallel workers up to maxParallel
    const workers: Promise<void>[] = [];
    
    async function worker() {
        while (true) {
            const index = nextPendingIndex;
            if (index >= queue.length) break;
            nextPendingIndex += 1;
            await processFile(index);
        }
    }

    const workerCount = Math.min(maxParallel, queue.length);
    for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    await finalizeBulkRun(nextResults, language);
}
```

**Important considerations:**
- `nextPendingIndex` acts as an atomic-like counter (safe in single-threaded JS — no race condition since the `while` check and increment happen synchronously before any `await`).
- Each worker takes the next available file index, translates it, then loops for the next one.
- `setFileResults` calls are safe from React's perspective — each call creates a new array snapshot.
- `nextResults` is a shared mutable array, but only one worker writes to any given `targetIndex` at a time (each file has a unique index), so there are no data races.

### 7.2 Per-File Progress Tracking State Model

**Current `FileResult` type:**
```typescript
type FileResult = {
    filename: string;
    content: string;
    status: FileResultStatus;
    translatedContent?: string;
    outputFilename?: string;
    error?: string;
};
```

**New `FileResult` type:**
```typescript
type FileResult = {
    filename: string;
    content: string;
    status: FileResultStatus;
    translatedContent?: string;
    outputFilename?: string;
    error?: string;
    // Per-file batch-level progress (populated during translation)
    totalBatches: number;
    completedBatches: number;
};
```

Initialize `totalBatches` and `completedBatches` to `0` when creating entries.

**Why batch-level, not segment-level:** With multiple files translating in parallel, segment-level updates (`translatedSegments` incremented on every streamed segment across all files) would cause a high volume of concurrent React state updates. Batch-level progress is coarser but sufficient — each file typically has a handful of batches, so the progress bar moves in visible increments. This keeps state update frequency manageable and the UI responsive.

**Remove the global `TranslationProgress` state entirely:**
- Delete the `progress` state variable and its `EMPTY_PROGRESS` constant.
- Delete the `TranslationProgress` type.
- Delete all `setProgress` calls throughout `translateSingleFile`.
- Delete the derived values `segmentProgress` and `requestProgress` (lines ~835–842).

**Refactor `translateSingleFile`:**

The function currently sets global state (`setProgress`, `setTranslatedChunks`, `setOriginalChunks`, `setActiveFilename`, `setActiveLanguage`). Refactor it to:

1. Accept an additional parameter: `fileIndex: number` (the index in `fileResults`).
2. Instead of calling `setProgress(...)`, call a helper that updates `fileResults[fileIndex]` with batch-level progress.
3. Remove all `setTranslatedChunks`, `setOriginalChunks` calls.
4. Remove `setActiveFilename` / `setActiveLanguage` calls from inside the function (set `activeLanguage` once in `handleBulkSubmit` before the parallel loop, as it's the same for all files).
5. Keep `setActiveFilename` removed — with parallel files, there's no single "active" file name. The UI will show progress per file in the file list.

**Progress update helper:**
```typescript
function updateFileProgress(
    fileIndex: number,
    updates: Partial<Pick<FileResult, "totalBatches" | "completedBatches">>,
) {
    setFileResults((prev) => {
        const next = [...prev];
        next[fileIndex] = { ...next[fileIndex], ...updates };
        return next;
    });
}
```

Call this from within `translateSingleFile` at two points:
- **After computing `requestGroups`**: `updateFileProgress(fileIndex, { totalBatches: requestGroups.length })`.
- **After each batch completes** (after `handleStream` + validation): `updateFileProgress(fileIndex, { completedBatches: requestIndex + 1 })`.

The `handleStream` function's `onTranslatedSegment` callback is no longer needed for UI progress updates. It is still used internally for the segment count validation (`translatedSegmentCount`) that verifies each batch returned the expected number of segments — this validation logic is unchanged.

### 7.3 UI Simplification — Remove Real-Time Translation Preview

**Remove the `Translating` component** (lines 264–280 in `page.tsx`):
```typescript
// DELETE this entire function
function Translating({ chunks }: { chunks: Chunk[] }) { ... }
```

**Remove the live preview section** from the busy-state JSX (lines 1145–1163 in `page.tsx`):
```html
<!-- DELETE this entire <section> -->
<section className="rounded-3xl border border-slate-200 bg-white/85 p-6 shadow-xl backdrop-blur md:p-8">
    <div className="flex flex-col gap-2">
        <p>Live preview</p>
        ...
    </div>
    <Translating chunks={...} />
</section>
```

**Remove associated state variables:**
- `translatedChunks` and `setTranslatedChunks`
- `originalChunks` and `setOriginalChunks`

**Remove the `Timestamp` import** from `page.tsx` (line 8):
```typescript
// DELETE
import Timestamp from "@/components/Timestamp";
```

**Remove the `Chunk` import** from `page.tsx` (line 10) if no longer used:
```typescript
// Check if Chunk is still referenced; if not, remove from the import
import type { Chunk, Segment } from "@/types";
// May become:
import type { Segment } from "@/types";
```

**Delete `components/Timestamp.tsx`** entirely if it has no remaining imports anywhere in the codebase.

**Simplify `handleStream`:**

The current `handleStream` function (lines 375–452) does two things: (a) accumulates the full response content string, and (b) parses individual SRT blocks into `Chunk` objects and pushes them to `translatedChunks` for the live preview. With the preview removed, simplify it:

- Remove the `appendChunkToPreview` inner function entirely.
- Remove all `setTranslatedChunks` calls.
- Keep the stream reading loop (`while (true) { reader.read()... }`) that accumulates `content`.
- Keep the `translatedSegmentCount` logic (counting blank-line-separated blocks) — this is needed for the batch validation check in `translateSingleFile` (`batchResult.translatedSegmentCount !== requestGroup.length`).
- The `onTranslatedSegment` callback parameter can be removed if it was only used to increment the global `progress.translatedSegments` — since that state no longer exists. The segment counting is now internal to `handleStream` only for validation purposes.
- The function signature simplifies to: `async function handleStream(response: Response): Promise<{ content: string; translatedSegmentCount: number }>`.

### 7.4 UI Simplification — Remove SRT Editor Links

**Location 1 — Bulk done view** (lines 1273–1280 in `page.tsx`):
```html
<!-- DELETE this entire <a> element -->
<a href="https://www.veed.io/subtitle-tools/edit?locale=en&source=/tools/subtitle-editor/srt-editor"
   target="_blank" rel="noreferrer" ...>
    Open SRT editor
</a>
```

**Location 2 — Single-file done view** (lines 1338–1345 in `page.tsx`):
```html
<!-- DELETE this entire <a> element -->
<a href="https://www.veed.io/subtitle-tools/edit?locale=en&source=/tools/subtitle-editor/srt-editor"
   target="_blank" rel="noreferrer" ...>
    Open SRT editor
</a>
```

**Also update the descriptive text** in the single-file done view (line ~1300) that says *"Use the action buttons to run another translation or edit your SRT file before continuing."* — change to: *"Use the button below to run another translation whenever you are ready."*

Similarly for the offset mode text (line ~1301): *"Use the action buttons to process another file or edit your SRT file."* — change to: *"Use the button below to process another file whenever you are ready."*

### 7.5 Progress UI — Per-File Progress Bars

**Replace the current busy-state UI** (the stat tiles + global progress bars at lines 999–1163) with a simpler layout:

#### New Busy-State Layout Structure

```
┌──────────────────────────────────────────────────────┐
│  [Overall Progress Section]                           │
│                                                       │
│  Overall progress bar (completedFiles / totalFiles)   │
│  Elapsed: MM:SS                                       │
│                                                       │
│  ┌──────────────────────────────────────────────────┐│
│  │ [Per-File Progress List]                         ││
│  │                                                  ││
│  │  file1.srt  [████████████░░░░] 3/4 batches  Translating  ││
│  │  file2.srt  [████████░░░░░░░░] 2/4 batches  Translating  ││
│  │  file3.srt  [████████████████] 100%          ✓ Success    ││
│  │  file4.srt  [░░░░░░░░░░░░░░░░] —             Pending     ││
│  │  file5.srt  [                ] —             Failed ✗     ││
│  │  ...                                             ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

#### Specific UI Elements

**1. Overall progress section:**
- Show `ProgressRow` for file-level progress: `completedFiles / totalFiles`.
- Show elapsed time as a small stat tile or inline text.
- Show the "Auto-download will start when complete" pill (keep existing).

**2. Per-file progress list:**
- Map `fileResults` to a scrollable list.
- For each file, show:
  - **Filename** (truncated).
  - **Progress bar** based on `completedBatches / totalBatches` for that file. If `totalBatches === 0` and status is `"pending"`, show an empty/grey bar. If status is `"translating"` and `totalBatches > 0`, show the gradient bar with percentage. If status is `"success"`, show a full green bar.
  - **Status badge** — reuse `getFileStatusLabel`/`getFileStatusClasses`.
- The list should be `max-h-[28rem] overflow-y-auto` (scrollable for many files).

**3. Consistent UI for single-file and multi-file translations:**
- Always show the same layout regardless of whether 1 file or 20 files are queued. When only 1 file is uploaded, the overall progress bar shows `0/1 → 1/1`, and the per-file list has one entry. This keeps the code simple (no branching on file count) and gives the user a consistent experience.
- Remove the existing `showBulkProgress` conditional (`bulkProgress.totalFiles > 1`). The progress UI is always the same.

#### Implementation in JSX

Create a new helper component (inline in `page.tsx`, like `ProgressRow`):

```typescript
function FileProgressRow({ result }: { result: FileResult }) {
    const percentage = result.totalBatches > 0
        ? toPercent(result.completedBatches, result.totalBatches)
        : 0;
    const isDone = result.status === "success";
    const isFailed = result.status === "failed";

    return (
        <li className="flex items-center gap-4 px-4 py-3">
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
                {result.filename}
            </p>
            <div className="w-32 shrink-0">
                <div className="h-2 rounded-full bg-slate-200">
                    <div
                        className={classNames(
                            "h-full rounded-full transition-all duration-300",
                            isFailed
                                ? "bg-rose-400"
                                : isDone
                                    ? "bg-emerald-500"
                                    : "bg-gradient-to-r from-cyan-500 to-indigo-500",
                        )}
                        style={{ width: `${isDone ? 100 : percentage}%` }}
                    />
                </div>
            </div>
            <span
                className={classNames(
                    "shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold",
                    getFileStatusClasses(result.status),
                )}
            >
                {getFileStatusLabel(result.status)}
            </span>
        </li>
    );
}
```

### 7.6 Error Handling & Network Resilience Reinforcement

With parallel translations, multiple API calls happen simultaneously. The existing retry logic in `requestTranslationBatch` (5 retries with exponential backoff + jitter) is per-batch and already robust. However, the following reinforcements should be made:

**1. Ensure per-file error isolation:**
- Each `translateSingleFile` call is wrapped in its own `try/catch` inside the `processFile` worker function (see Section 7.1).
- A failure in one file must **never** cause the `Promise.all(workers)` to reject — the `processFile` function handles errors internally and records them in `nextResults`.

**2. Abort signal propagation (optional enhancement):**
- Consider adding an `AbortController` per file. If the user navigates away or if a global abort is needed in the future, each in-flight `fetch` can be cancelled.
- For the initial implementation, this is optional. The existing pattern (no abort) will work — in-flight requests simply complete or timeout.

**3. Rate limiting awareness:**
- With 5 parallel translations, and each file having multiple batches, the Gemini API could receive a burst of concurrent requests.
- The existing `INTER_BATCH_DELAY_MS = 150` between batches within a single file helps, but batches from different files can overlap.
- **Recommendation**: Keep the existing per-file inter-batch delay. The server-side retry logic in `retrieveTranslation` (3 retries with 1s backoff) handles 429/rate-limit responses from Gemini. The client-side `requestTranslationBatch` also retries on 429. This double-layer retry is sufficient.
- If rate limiting becomes an issue, the operator can reduce `TRANSLATION_MAX_PARALLEL` to a lower value.

**4. `setFileResults` concurrency:**
- Multiple parallel `translateSingleFile` calls will call `setFileResults` concurrently.
- React state updates via the **functional updater form** (`setFileResults(prev => ...)`) are safe: React queues these and applies them in order, each receiving the latest state.
- **Critical**: All `setFileResults` calls inside `translateSingleFile` and `processFile` **must** use the functional updater form `setFileResults(prev => { const next = [...prev]; next[fileIndex] = ...; return next; })` — **not** the direct-value form with a captured `nextResults` array.
- This is a key change from the current implementation, which uses a shared mutable `nextResults` array and calls `setFileResults([...nextResults])`. With parallel writes, the shared mutable array approach would cause race conditions where one worker's update overwrites another's.

**5. Stream reading resilience:**
- `handleStream` reads the response body stream. If the connection drops mid-stream, the `reader.read()` call will throw. This is already caught by the `try/catch` in `translateSingleFile` → the file is marked as `failed`.
- No additional changes needed for stream handling.

### 7.7 Retry Failed Files

**Current behavior** (`handleRetryFailed`, lines 774–793): Builds a queue of failed files with `resultIndex` set, then calls `handleBulkSubmit` again.

**Required changes**: None to the retry logic itself. The new parallel `handleBulkSubmit` will automatically process the retry queue in parallel, just like the initial run. The `resultIndex` mechanism ensures the retried files update the correct entries in `fileResults`.

One consideration: when retrying, already-succeeded files should not be disturbed. The current `hasIndexedItems` branching logic (lines 664–689) already handles this correctly by preserving existing `success` entries and only re-processing entries with matching `resultIndex`.

---

## 8. Concurrency Control — Implementation Pattern

The recommended pattern is a **worker pool** using plain `async`/`await`:

```typescript
async function runWithConcurrencyLimit<T>(
    tasks: (() => Promise<T>)[],
    maxConcurrent: number,
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const index = nextIndex;
            if (index >= tasks.length) return;
            nextIndex += 1;
            results[index] = await tasks[index]();
        }
    }

    const workerCount = Math.min(maxConcurrent, tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}
```

This utility can either be:
- Defined as a standalone function at the top of `page.tsx`, or
- Inlined directly in `handleBulkSubmit`.

For this codebase (all logic in `page.tsx`), defining it as a top-level utility function in `page.tsx` is the cleanest approach.

**No external dependencies needed** — this pattern uses only native JavaScript.

---

## 9. Risk Assessment & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| React state race conditions from concurrent `setFileResults` calls | Medium | High | Use functional updater form exclusively; never share a mutable array across workers |
| Gemini API rate limiting with multiple concurrent requests | Medium | Medium | Existing retry logic handles 429s; operator can lower `TRANSLATION_MAX_PARALLEL` |
| Memory pressure from many large files in memory simultaneously | Low | Medium | Files are already loaded into memory upfront; parallel doesn't change peak memory |
| Browser network connection limit (~6 concurrent per domain) | Low | Low | Each `translateSingleFile` issues sequential batch requests; typically only `maxParallel` concurrent HTTP requests at any moment |
| `nextResults` shared mutable array causing stale reads | High (if not addressed) | High | **Must** switch to functional updater pattern for `setFileResults` instead of shared array (see Section 7.6 point 4) |
| UI becoming unresponsive with many rapid state updates | Low | Low | Batch-level progress (not segment-level) keeps update frequency low; React batches state updates in async boundaries |

---

## 10. Post-Implementation Review Checklist

After implementation, the AI model should verify each of the following items by code inspection:

### Functional Correctness

- [ ] **1.** The `TRANSLATION_MAX_PARALLEL` environment variable is read in `lib/translation-config.ts`, with a default of `5`, min of `1`, max of `20`, and invalid/missing values gracefully fall back to the default.
- [ ] **2.** The `GET /api/config` endpoint includes `maxParallel` in its JSON response.
- [ ] **3.** The client (`app/page.tsx`) reads `maxParallel` from the config response on mount and stores it in state with a default fallback of `5`.
- [ ] **4.** `handleBulkSubmit` uses a concurrency-limited parallel pattern (not a sequential `for` loop) to process files.
- [ ] **5.** The concurrency limit used in `handleBulkSubmit` matches the `maxParallel` state value from config.
- [ ] **6.** Each `translateSingleFile` call is independently wrapped in `try/catch` so one file's failure doesn't abort others.
- [ ] **7.** `FileResult` type includes `totalBatches` and `completedBatches` fields (both initialized to `0`).
- [ ] **8.** `translateSingleFile` updates per-file batch progress via the functional updater form of `setFileResults`, targeting the correct `fileIndex`.
- [ ] **9.** No global `progress` (`TranslationProgress`) state remains — all progress is per-file within `fileResults`. The derived values `segmentProgress` and `requestProgress` are also removed.
- [ ] **10.** `bulkProgress.completedFiles` is correctly incremented as each file finishes (success or failure).

### UI Changes

- [ ] **11.** The `Translating` component (live preview of streamed segments) is fully removed from the JSX and its function definition deleted.
- [ ] **12.** The `translatedChunks` and `originalChunks` state variables are removed.
- [ ] **13.** The `Timestamp` component import is removed from `page.tsx`. If `Timestamp.tsx` is no longer imported anywhere, the file is deleted.
- [ ] **14.** Both "Open SRT editor" links (`<a href="https://www.veed.io/...">`) are removed — one from the bulk done view and one from the single-file/offset done view.
- [ ] **15.** The busy-state UI shows a per-file progress list with a progress bar per file based on `completedBatches / totalBatches`.
- [ ] **16.** The busy-state UI shows an overall file progress bar (`completedFiles / totalFiles`).
- [ ] **17.** The same consistent busy-state UI is shown regardless of whether 1 file or N files are being translated (no `showBulkProgress` conditional branching).
- [ ] **18.** The elapsed timer still functions correctly during the busy state.
- [ ] **19.** The "Auto-download will start when complete" pill is still shown during the busy state.

### Downloads & Results

- [ ] **20.** Single-file translation still triggers a direct `.srt` file download upon completion.
- [ ] **21.** Multi-file translation still creates a ZIP archive and triggers download, with `zipDownload` state for re-download.
- [ ] **22.** The "Download ZIP again" button still works in the done state.
- [ ] **23.** The bulk results table (filename, status, error) is still shown in the done state.

### Retry & Reset

- [ ] **24.** The "Retry failed" button still works: it builds a queue of failed files and passes them to `handleBulkSubmit` with `resultIndex` set.
- [ ] **25.** Retried files are processed in parallel (using the same concurrency limit).
- [ ] **26.** Succeeded files are preserved during retry — their entries in `fileResults` are not overwritten.
- [ ] **27.** `resetToIdle` properly clears all state and returns to the idle form view.

### Error Handling & Resilience

- [ ] **28.** All `setFileResults` calls inside `translateSingleFile` and the worker function use the **functional updater** form `setFileResults(prev => ...)` — never setting state with a captured mutable array.
- [ ] **29.** `requestTranslationBatch` retry logic (5 retries, exponential backoff, jitter, retriable status codes) is unchanged and functional.
- [ ] **30.** Server-side `retrieveTranslation` retry logic (3 retries, 55s timeout) is unchanged.
- [ ] **31.** A file failing mid-translation does not prevent other in-flight or pending files from completing.
- [ ] **32.** If **all** files fail, the app shows an alert and resets to idle (existing behavior preserved).

### Configuration & Environment

- [ ] **33.** `.env.example` includes `TRANSLATION_MAX_PARALLEL=5`.
- [ ] **34.** `README.md` documents the `TRANSLATION_MAX_PARALLEL` variable.
- [ ] **35.** The `app/api/route.ts` file is **unchanged** — verify no modifications were made to the server-side translation endpoint.
- [ ] **36.** The `lib/srt.ts`, `lib/client.ts`, `lib/zip.ts` files are **unchanged**.

### Preserved Features (No Regressions)

- [ ] **37.** Single-file translation works (upload 1 file → translate → download `.srt`).
- [ ] **38.** Time-offset mode (`activeMode === "offset"`) is fully functional and **completely unmodified** — no code in `handleOffset`, `OffsetForm.tsx`, or the offset-related done view has been touched.
- [ ] **39.** Language selection (predefined + custom) works as before.
- [ ] **40.** File upload drag-and-drop, file validation (`.srt` only), duplicate detection, clear/remove all work as before.
- [ ] **41.** The configuration error screen still shows when `GOOGLE_GENERATIVE_AI_API_KEY` is missing.
- [ ] **42.** The "Translate" / "Time Offset" mode toggle in the idle state still works.
- [ ] **43.** The `Chunk` type in `types.ts` is unchanged (or, if the import is removed from `page.tsx`, verify it's still exported for any other consumer — currently `Timestamp.tsx` uses it, so if that file is deleted, `Chunk` may be orphaned but harmless).
- [ ] **44.** The output filename logic (`.eng`, `.spa`, `.pop` suffixes) in `translateSingleFile` is unchanged.

### Code Quality

- [ ] **45.** No unused imports remain in any modified file.
- [ ] **46.** No unused state variables, functions, or type definitions remain.
- [ ] **47.** TypeScript types are consistent — `FileResult` uses the new shape everywhere it's created or referenced.
- [ ] **48.** The `Form.tsx` help text reflects parallel processing (not "one by one").
- [ ] **49.** No `console.log` debugging statements were accidentally left in (existing `console.info`, `console.warn`, `console.error` for structured logging are fine).
