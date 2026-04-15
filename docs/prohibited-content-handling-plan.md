# Implementation Plan: PROHIBITED_CONTENT Handling in Translation Pipeline

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Codebase Inventory & Impact Map](#2-codebase-inventory--impact-map)
3. [Error Taxonomy](#3-error-taxonomy)
4. [Architecture Changes](#4-architecture-changes)
5. [Algorithm: Adaptive Chunk-Splitting Fallback](#5-algorithm-adaptive-chunk-splitting-fallback)
6. [Irreducible Block Policy (Configurable)](#6-irreducible-block-policy-configurable)
7. [Retry Logic Updates](#7-retry-logic-updates)
8. [API Contract Updates](#8-api-contract-updates)
9. [Configuration Flags](#9-configuration-flags)
10. [Observability & Logging](#10-observability--logging)
11. [Client-Side Changes](#11-client-side-changes)
12. [Test Plan](#12-test-plan)
13. [Open Questions](#13-open-questions)
14. [Implementation Order & File Change Map](#14-implementation-order--file-change-map)
15. [Code Review Checklist](#15-code-review-checklist)

---

## 1. Problem Statement

When translating SRT subtitle content via the Gemini API (`@ai-sdk/google` + Vercel AI SDK's `generateText`), the upstream provider may return a response with `promptFeedback.blockReason = "PROHIBITED_CONTENT"` and **zero candidates/content**. This is a non-configurable safety block that cannot be resolved by adjusting safety threshold settings.

**Current failure mode:**

1. `generateText()` in `app/api/route.ts:166` throws an error (typically a parsing/validation error from the AI SDK because no candidate text is present in the response).
2. The `retrieveTranslation` retry loop (`app/api/route.ts:149-255`) catches this as a generic error and retries the identical payload up to `MAX_RETRIES=3` times, which will fail identically every time.
3. The stream controller errors out (`controller.error(streamError)` at line 425), producing a broken response or empty 500 to the client.
4. The client retries the entire batch (`requestTranslationBatch` in `app/page.tsx:92-154`) up to 5 times with exponential backoff, but since the payload is unchanged, every retry fails identically.
5. The file is marked as "failed" with a generic error message that gives no indication of content blocking.

**Root cause:** The code has no detection path for `PROHIBITED_CONTENT` responses, no mechanism to reduce payload granularity on content-dependent failures, and no way to preserve partial results when only a subset of segments triggers the block.

---

## 2. Codebase Inventory & Impact Map

### Files requiring changes

| File | Current Role | Changes Needed |
|------|-------------|----------------|
| `app/api/route.ts` | Translation API route: model calls, retry loop, streaming response | Error detection, adaptive splitting, partial-success response format, new logging |
| `lib/translation-config.ts` | Runtime config from env vars | New config flags for blocked-content policy |
| `app/api/config/route.ts` | Config probe endpoint for UI | Expose new config flags to client |
| `app/page.tsx` | Client orchestration: batching, retries, stream parsing, UI | Handle new response headers/status, display blocked-segment info, skip non-retryable batches |
| `types.ts` | Shared types (`Segment`, `Chunk`) | New error/status types, extended segment metadata |
| `lib/srt.ts` | Token estimation, segment grouping | Possibly expose sub-group splitting utility |

### Files NOT requiring changes

| File | Reason |
|------|--------|
| `lib/client.ts` | SRT parsing logic is unaffected |
| `lib/zip.ts` | ZIP archive logic is unaffected |
| `components/Form.tsx` | Upload form is unaffected |
| `components/OffsetForm.tsx` | Offset feature is unaffected |

### External dependencies (no changes expected)

- `@ai-sdk/google` (v3.0.30) / `ai` (v6.0.92): We need to understand how these surface `PROHIBITED_CONTENT` errors. The AI SDK wraps the Gemini REST API response and may throw an `AISDKError` or similar typed error containing the provider's `promptFeedback`. We will detect this via error inspection, not by modifying these packages.

---

## 3. Error Taxonomy

Define a structured classification for all errors in the translation path. This replaces the current catch-all approach.

### 3.1 Error Categories

```
TranslationError (base)
├── ProhibitedContentError        # promptFeedback.blockReason = PROHIBITED_CONTENT
│   ├── groupLevel                # A multi-segment group was blocked
│   └── segmentLevel              # A single (minimal) segment was blocked (irreducible)
├── SafetyFilterError             # Standard harm-category blocks (configurable thresholds)
├── SegmentCountMismatchError     # Model returned wrong number of segments
├── ModelTimeoutError             # AbortController timeout (55s)
├── TransientProviderError        # 429, 500, 502, 503, 504 from upstream
├── NetworkError                  # Fetch/connection failures
└── UnknownTranslationError       # Catch-all for unrecognized errors
```

### 3.2 Error Properties

Each error type should carry:

```typescript
type TranslationErrorInfo = {
  category: "prohibited_content" | "safety_filter" | "segment_mismatch"
           | "timeout" | "transient" | "network" | "unknown";
  retryable: boolean;          // Can identical payload be retried?
  splittable: boolean;         // Should we try smaller chunks?
  blockReason?: string;        // Raw provider block reason
  affectedSegmentIds?: number[]; // Which segment IDs are involved
  message: string;
};
```

### 3.3 Detection Logic

The AI SDK (`@ai-sdk/google`) processes Gemini REST responses internally. When `promptFeedback.blockReason` is present with no candidates, the SDK throws an error. We need to detect `PROHIBITED_CONTENT` from the thrown error:

**Detection approach (inspect the error object):**

```
1. Check error.message for strings like "PROHIBITED_CONTENT", "blocked", "promptFeedback"
2. Check error.cause or error.data for structured provider response data
3. Check error.name / error.constructor for AI SDK-specific error types
4. If the error contains a response body, parse it for promptFeedback.blockReason
```

**Implementation note:** We should add a `classifyTranslationError(error: unknown): TranslationErrorInfo` function that centralizes this detection. This function should be tested against real error shapes from the AI SDK (captured during development/testing).

### 3.4 Why errors need to be inspected, not intercepted at the HTTP level

The `generateText()` call from the AI SDK handles the HTTP request/response internally. We don't have access to the raw Gemini API response before the SDK processes it. The SDK throws on non-standard responses, so we must classify the thrown error after the fact.

If SDK inspection proves unreliable, an alternative approach is to make direct REST calls to the Gemini API (bypassing the SDK) for retry/fallback attempts, giving us full access to the raw response shape. This is a fallback option and should only be pursued if the SDK error inspection approach is insufficient.

---

## 4. Architecture Changes

### 4.1 Current Flow (simplified)

```
POST /api
  → parse SRT → group by tokens → for each group:
      → retrieveTranslation (up to 3 retries, same payload)
          → generateText() → split by delimiter → validate count → return segments
      → stream SRT blocks to client
```

### 4.2 Proposed Flow

```
POST /api
  → parse SRT → group by tokens → for each group:
      → retrieveTranslationWithFallback(group)
          → try retrieveTranslation(group)
          → on ProhibitedContentError:
              → if group.length > 1: binary-split group → recurse on each half
              → if group.length === 1: apply irreducible-block policy
          → on TransientError: retry with backoff (existing behavior)
          → on other errors: propagate
      → collect results (translated OR fallback text) preserving order
      → stream SRT blocks with optional blocked-segment headers
  → return response with partial-success metadata
```

### 4.3 New Module: `lib/content-block-handler.ts`

Create a dedicated module to encapsulate:

- `classifyTranslationError(error: unknown): TranslationErrorInfo`
- `handleBlockedGroup(group, language, context, depth): TranslationGroupResult`
- `applyIrreducibleBlockPolicy(segment, policy): string`

This keeps the main route handler focused on orchestration and keeps the splitting/fallback logic testable in isolation.

### 4.4 Data Flow Diagram

```
                                    retrieveTranslationWithFallback(group)
                                    ┌─────────────────────────────────────┐
                                    │                                     │
                              ┌─────┴──────┐                              │
                              │ Try normal  │                              │
                              │ translation │                              │
                              └─────┬──────┘                              │
                                    │                                     │
                         ┌──────────┼──────────┐                          │
                         │          │          │                          │
                    ✅ Success  ⚠️ Prohibited  ❌ Other                   │
                         │      Content       Error                      │
                         │          │          │                          │
                    Return      ┌───┴───┐   Propagate                    │
                    segments    │ N > 1 │   error                        │
                                │ segs? │                                 │
                                └───┬───┘                                │
                              ┌─────┼─────┐                              │
                           Yes│           │No (single segment)           │
                              │           │                              │
                        ┌─────┴─────┐  ┌──┴──────────────┐              │
                        │ Split in  │  │ Apply irreducible│              │
                        │ two halves│  │ block policy     │              │
                        └─────┬─────┘  └──┬──────────────┘              │
                              │           │                              │
                        Recurse on     Return original/                  │
                        each half      placeholder/redact                │
                              │           │                              │
                              └───────────┘                              │
                                    │                                    │
                              Merge results                              │
                              preserving order                           │
                                    │                                    │
                              ┌─────┴──────┐                             │
                              │  Return    │                             │
                              │  results + │                             │
                              │  metadata  │                             │
                              └────────────┘                             │
```

### 4.5 Result Type for Group Translation

```typescript
type TranslatedSegmentResult = {
  text: string;
  blocked: boolean;
  originalSegmentId: number;
  blockPolicy?: "keep_original" | "placeholder" | "redact";
};

type TranslationGroupResult = {
  segments: TranslatedSegmentResult[];
  hasBlockedSegments: boolean;
  blockedSegmentIds: number[];
  splitDepth: number;
};
```

---

## 5. Algorithm: Adaptive Chunk-Splitting Fallback

### 5.1 Overview

When a multi-segment group triggers `PROHIBITED_CONTENT`, we recursively split it into smaller sub-groups and retry each independently. This isolates the specific segment(s) causing the block while allowing the rest to translate normally.

### 5.2 Algorithm Steps

```
function retrieveTranslationWithFallback(
  segments: Segment[],
  language: string,
  context: TranslationRequestContext,
  depth: number = 0,
  maxSplitDepth: number = configurable (default 5)
): TranslationGroupResult

  1. Try normal translation for the full segment group
     → call existing retrieveTranslation() with the joined text

  2. On success:
     → return { segments: translated, hasBlockedSegments: false, splitDepth: depth }

  3. On ProhibitedContentError:
     a. Log: "[translate][{runId}] Prohibited content detected at depth {depth},
              segments [{segmentIds}], splitting"
     b. If segments.length === 1:
        → This is an irreducible block
        → Apply configured policy (see §6)
        → Return result with blocked: true
     c. If depth >= maxSplitDepth:
        → Safety limit: too many splits
        → Apply irreducible policy to all remaining segments
        → Log warning
     d. Split segments into two halves:
        → left  = segments[0 .. mid-1]
        → right = segments[mid .. end]
        where mid = Math.ceil(segments.length / 2)
     e. Recurse:
        → leftResult  = retrieveTranslationWithFallback(left,  ..., depth+1)
        → rightResult = retrieveTranslationWithFallback(right, ..., depth+1)
     f. Merge results preserving original order
     g. Return merged result with hasBlockedSegments, blockedSegmentIds aggregated

  4. On TransientError (429, 5xx, timeout):
     → These are already handled by the existing retry loop inside retrieveTranslation()
     → If all retries exhausted, propagate the error (do NOT split—splitting won't help)

  5. On other errors:
     → Propagate (no splitting)
```

### 5.3 Splitting Strategy: Binary Split

Binary split is chosen over linear (one-at-a-time peeling) for efficiency:

- **Worst case (1 blocked segment in N):** Binary split requires O(log N) model calls to isolate it. Linear peeling requires O(N) calls.
- **Multiple blocked segments:** Binary split naturally handles clusters and still converges efficiently.
- **Split depth limit:** With `maxSplitDepth = 5`, we can handle groups of up to 32 segments (2^5), which is well beyond typical group sizes at the default 350-token limit.

### 5.4 Ordering Guarantee

The recursive split always operates on contiguous sub-arrays of the original segment list. Results are concatenated in the same left-right order, so the final output maintains the exact original ordering without any sort or reindex step.

### 5.5 Performance Considerations

- **Best case (no blocked content):** Zero overhead—single successful call, identical to current behavior.
- **Typical blocked case (1 blocked segment in a group of ~8):** ~7 additional model calls (3 levels of binary split). At ~2-3 seconds per call, adds ~15-20 seconds for that group.
- **Worst case (all segments blocked):** Degenerates to N individual calls plus the split overhead, but each call is small and fast-failing (blocked responses return quickly).
- **Mitigation:** The split path only triggers after an initial block, so it never adds latency to clean content. Groups that succeed normally are unaffected.

---

## 6. Irreducible Block Policy (Configurable)

When a single segment (minimal unit) is blocked by `PROHIBITED_CONTENT`, we cannot split further. The system applies a configurable policy.

### 6.1 Policy Options

| Policy | Behavior | Use Case |
|--------|----------|----------|
| `keep_original` | Keep the original source-language text | Preserves all content; viewer sees untranslated segment |
| `placeholder` | Replace with configurable placeholder text | Clearly marks blocked content; avoids confusion |
| `redact` | Replace with empty/redaction marker | Removes blocked content from output |

### 6.2 Configuration

```
PROHIBITED_CONTENT_POLICY=keep_original|placeholder|redact  (default: keep_original)
PROHIBITED_CONTENT_PLACEHOLDER=[Content not available]      (default, only used when policy=placeholder)
```

### 6.3 Implementation

```typescript
function applyIrreducibleBlockPolicy(
  segment: Segment,
  policy: ProhibitedContentPolicy,
  placeholder: string,
): TranslatedSegmentResult {
  let text: string;
  switch (policy) {
    case "placeholder":
      text = placeholder;
      break;
    case "redact":
      text = "";
      break;
    case "keep_original":
    default:
      text = segment.text;
      break;
  }
  return {
    text,
    blocked: true,
    originalSegmentId: segment.id,
    blockPolicy: policy,
  };
}
```

### 6.4 Output Structure Preservation

Regardless of policy, the output SRT always contains the same number of segments as the input, with original IDs and timestamps. Only the text content of blocked segments is affected. This ensures:

- Segment count validation on both server and client continues to pass.
- Subtitle timing is preserved.
- Downstream tools (video players, subtitle editors) receive a well-formed SRT file.

---

## 7. Retry Logic Updates

### 7.1 Server-Side (`retrieveTranslation` in `app/api/route.ts`)

**Current behavior:** 3 retries with 1-second fixed delay for all errors.

**Proposed changes:**

| Error Category | Retry? | Action |
|---|---|---|
| `prohibited_content` | **No retry** at same payload | Immediately return to caller for splitting/policy |
| `safety_filter` | **No retry** at same payload | Same as prohibited_content (content-dependent, won't resolve on retry) |
| `segment_mismatch` | **1 retry** (model may produce correct count on retry) | Existing behavior, but limited to 1 retry for this class |
| `timeout` | **Retry** (up to MAX_RETRIES) | Existing behavior |
| `transient` (429, 5xx) | **Retry with backoff** (up to MAX_RETRIES) | Upgrade from fixed 1s to exponential backoff with jitter |
| `network` | **Retry with backoff** | Same as transient |
| `unknown` | **1 retry** | Conservative retry in case of transient weirdness |

**Key change:** `retrieveTranslation` should throw a typed/tagged error that the caller can inspect to decide whether to split or propagate. The function itself should NOT retry `prohibited_content` errors.

```typescript
// Pseudo-code for the updated retry loop
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    return await callModel(...);
  } catch (error) {
    const classified = classifyTranslationError(error);

    if (!classified.retryable) {
      // Attach classification metadata to the error and re-throw immediately
      throw tagError(error, classified);
    }

    if (attempt < MAX_RETRIES) {
      const delay = getRetryDelay(attempt, classified.category);
      await sleep(delay);
      continue;
    }

    throw tagError(error, classified);
  }
}
```

### 7.2 Server-Side Backoff Upgrade

Replace the fixed 1-second delay with exponential backoff + jitter, consistent with the client-side approach:

```
attempt 1 → 1000ms + jitter(0-250ms)
attempt 2 → 2000ms + jitter(0-250ms)
attempt 3 → 4000ms + jitter(0-250ms)
```

### 7.3 Client-Side (`requestTranslationBatch` in `app/page.tsx`)

**Current behavior:** 5 retries with exponential backoff for network errors and retriable HTTP statuses (408, 425, 429, 500, 502, 503, 504).

**Proposed changes:**

- Add `422` to non-retriable statuses (will be used for `prohibited_content` partial-success responses if we choose that status code; see §8).
- Actually: if the server handles splitting internally and returns a 200 with partial-success metadata, the client needs no retry changes for blocked content specifically. The client should only surface the metadata to the user.
- If the server returns the new structured error response (§8) indicating all segments were blocked, the client should NOT retry that batch. Detection: check for a specific header or JSON error code in the non-200 response.

**New header-based detection:**

```typescript
// In requestTranslationBatch, after checking response.ok:
if (!response.ok) {
  const errorBody = await response.json().catch(() => null);
  if (errorBody?.code === "PROHIBITED_CONTENT") {
    // Do not retry—content-dependent block
    throw new ProhibitedContentClientError(errorBody);
  }
  // ... existing retry logic for transient errors
}
```

---

## 8. API Contract Updates

### 8.1 Success Response (200) — Enhanced

**Current:** `Content-Type: text/plain; charset=utf-8` streaming SRT blocks.

**Proposed:** Same streaming format, but with additional response headers:

```
x-translation-run-id: <uuid>
x-translation-blocked-segments: <comma-separated segment IDs>  (only if any blocked)
x-translation-status: complete | partial                         (always present)
```

The streamed SRT body format is unchanged—each block is still `id\ntimestamp\ntext\n\n`. Blocked segments appear with their policy-applied text (original, placeholder, or redacted).

**Rationale:** Headers can be read before the stream completes, allowing the client to show a warning as soon as it knows some segments were blocked. The SRT body itself remains a valid, well-formed file regardless.

### 8.2 Error Response — New Structured Format

**Current:** `{ error: string, runId: string }` with status 400 or 500.

**Proposed:** Extend with optional machine-readable fields:

```json
{
  "error": "Human-readable error message",
  "code": "PROHIBITED_CONTENT" | "SAFETY_FILTER" | "TRANSLATION_ERROR" | "INVALID_REQUEST" | "CONFIG_ERROR",
  "runId": "uuid",
  "blockedSegmentIds": [3, 7, 12],
  "totalSegments": 25,
  "translatedSegments": 22
}
```

- `code` field enables programmatic client-side handling.
- `blockedSegmentIds` is only present for content-block errors.
- Backward compatibility: existing clients that only read `error` and `runId` continue to work.

### 8.3 Full-Block Scenario

If **all** segments in a request are blocked and the configured policy is `keep_original`, the server still returns 200 with the original text (nothing was actually translated, but the output structure is valid). The `x-translation-status: partial` and `x-translation-blocked-segments` headers indicate this.

If the configured policy is `redact` and all segments are blocked, the server returns 200 with empty text segments but valid SRT structure.

### 8.4 Config Endpoint Updates (`GET /api/config`)

Add new fields to the config response:

```json
{
  "ok": true,
  "modelName": "...",
  "maxTokensPerRequest": 350,
  "maxParallel": 5,
  "thinkingLevel": "low",
  "isGemini3Model": true,
  "prohibitedContentPolicy": "keep_original",
  "prohibitedContentPlaceholder": "[Content not available]"
}
```

---

## 9. Configuration Flags

### 9.1 New Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PROHIBITED_CONTENT_POLICY` | `"keep_original"` \| `"placeholder"` \| `"redact"` | `"keep_original"` | What to do with irreducibly blocked segments |
| `PROHIBITED_CONTENT_PLACEHOLDER` | string | `"[Content not available]"` | Placeholder text when policy is `placeholder` |
| `PROHIBITED_CONTENT_MAX_SPLIT_DEPTH` | number (1-10) | `5` | Maximum recursion depth for binary splitting |

### 9.2 Config Resolution

Add to `resolveTranslationRuntimeConfig()` in `lib/translation-config.ts`:

```typescript
// New fields on TranslationRuntimeConfig
type TranslationRuntimeConfig = {
  // ... existing fields ...
  prohibitedContentPolicy: "keep_original" | "placeholder" | "redact";
  prohibitedContentPlaceholder: string;
  maxSplitDepth: number;
};
```

Validation:
- `PROHIBITED_CONTENT_POLICY`: must be one of the three valid values; invalid → fall back to `"keep_original"` with a warning log (not a hard error, to avoid blocking all translations).
- `PROHIBITED_CONTENT_MAX_SPLIT_DEPTH`: must be 1-10; invalid → fall back to `5`.
- `PROHIBITED_CONTENT_PLACEHOLDER`: any non-empty string; empty → fall back to default.

### 9.3 `.env.example` Updates

```
# Prohibited content handling (non-configurable safety blocks)
# PROHIBITED_CONTENT_POLICY=keep_original    # keep_original | placeholder | redact
# PROHIBITED_CONTENT_PLACEHOLDER=[Content not available]
# PROHIBITED_CONTENT_MAX_SPLIT_DEPTH=5
```

---

## 10. Observability & Logging

### 10.1 Log Events

All log events use the existing `[translate][{runId}]` prefix pattern.

| Event | Level | When | Fields |
|-------|-------|------|--------|
| `prohibited content detected` | `warn` | Error classified as PROHIBITED_CONTENT | `runId`, `batchLabel`, `groupIndex`, `segmentIds`, `segmentCount`, `splitDepth` |
| `splitting group` | `info` | Starting binary split on a blocked group | `runId`, `batchLabel`, `groupIndex`, `originalSize`, `leftSize`, `rightSize`, `depth` |
| `irreducible block` | `warn` | Single segment blocked, applying policy | `runId`, `batchLabel`, `segmentId`, `policy`, `originalTextLength` |
| `split fallback succeeded` | `info` | All sub-groups resolved (some may be blocked) | `runId`, `batchLabel`, `totalSegments`, `blockedCount`, `splitDepth`, `durationMs` |
| `translation partial success` | `info` | Batch completed with some blocked segments | `runId`, `batchLabel`, `totalSegments`, `translatedCount`, `blockedCount`, `blockedSegmentIds` |
| `error classified` | `info` | Any error goes through classification | `runId`, `category`, `retryable`, `splittable`, `message` (truncated) |

### 10.2 Correlation

All log entries in a request lifecycle already share `runId` and `batchLabel`. The splitting path adds `splitDepth` and preserves the same `runId`/`batchLabel`, so log aggregation can trace the full splitting tree for any request.

### 10.3 Metrics (Future)

If a metrics system is added later, the following counters/histograms would be valuable:

- `translation_prohibited_content_total` (counter): number of PROHIBITED_CONTENT occurrences
- `translation_split_depth` (histogram): how deep the splitting went
- `translation_blocked_segments_total` (counter): total irreducibly blocked segments
- `translation_split_fallback_duration_ms` (histogram): time spent in the split/retry path

---

## 11. Client-Side Changes

### 11.1 `app/page.tsx` Updates

**Response header reading:**

After `response.ok` in `handleStream`, read the new headers:

```typescript
const blockedSegmentsHeader = response.headers.get("x-translation-blocked-segments");
const translationStatus = response.headers.get("x-translation-status");

const blockedSegmentIds = blockedSegmentsHeader
  ? blockedSegmentsHeader.split(",").map(Number).filter(Number.isFinite)
  : [];
```

**Return type of `handleStream`:** Extend to include `blockedSegmentIds`:

```typescript
async function handleStream(response: Response): Promise<{
  content: string;
  translatedSegmentCount: number;
  blockedSegmentIds: number[];
  isPartial: boolean;
}>;
```

**UI feedback:**

- When `blockedSegmentIds.length > 0`, show a warning in the file result row: "N segment(s) could not be translated due to content restrictions."
- In the completion summary, aggregate blocked segment counts across all batches.
- On the "done" screen, include a note if any files had blocked segments.

**Non-retryable error detection:**

If the server returns a non-200 response with `code: "PROHIBITED_CONTENT"`, the client should mark the batch as failed with a descriptive message rather than retrying:

```typescript
if (!response.ok) {
  const errorBody = await response.json().catch(() => null);
  if (errorBody?.code === "PROHIBITED_CONTENT") {
    throw new Error(
      `Translation blocked: ${errorBody.blockedSegmentIds?.length ?? "unknown"} segment(s) ` +
      `contain content that cannot be translated by the provider.`
    );
  }
}
```

Note: With the server-side splitting approach, this path should rarely be hit (only if something unexpected happens during splitting). The normal path is a 200 with partial-success metadata.

### 11.2 `FileResult` Type Extension

```typescript
type FileResult = {
  // ... existing fields ...
  blockedSegmentIds?: number[];
  isPartialTranslation?: boolean;
};
```

### 11.3 Retry Behavior

The client's `handleRetryFailed()` should NOT retry files that failed solely due to `PROHIBITED_CONTENT` (since the content hasn't changed). Options:

1. **Preferred:** Since the server handles splitting internally, most blocked-content scenarios result in partial success (200), not failure. Files are marked "success" with a warning.
2. **Edge case:** If a file is entirely blocked content, it still succeeds (with original text / placeholders). Only catastrophic errors (server crash during splitting) would produce a failure that's worth retrying.

---

## 12. Test Plan

### 12.1 Unit Tests (new file: future test infrastructure)

Since the project currently has no test runner, tests should be added alongside a minimal test setup (recommend `vitest` given the Next.js/TypeScript stack).

**Error classification tests:**

| Test | Input | Expected |
|------|-------|----------|
| Detect PROHIBITED_CONTENT from AI SDK error | Mocked error with "PROHIBITED_CONTENT" in message | `{ category: "prohibited_content", retryable: false, splittable: true }` |
| Detect PROHIBITED_CONTENT from cause chain | Error with nested cause containing blockReason | Same as above |
| Detect transient 429 error | Error with statusCode 429 | `{ category: "transient", retryable: true, splittable: false }` |
| Detect timeout | AbortError | `{ category: "timeout", retryable: true, splittable: false }` |
| Detect segment mismatch | Error message matching pattern | `{ category: "segment_mismatch", retryable: true, splittable: false }` |
| Unknown error | Generic Error("something") | `{ category: "unknown", retryable: true, splittable: false }` |

**Irreducible block policy tests:**

| Test | Policy | Input Segment | Expected Output |
|------|--------|---------------|-----------------|
| Keep original | `keep_original` | `{ id: 1, text: "bad content" }` | `{ text: "bad content", blocked: true }` |
| Placeholder | `placeholder` | `{ id: 1, text: "bad content" }` | `{ text: "[Content not available]", blocked: true }` |
| Redact | `redact` | `{ id: 1, text: "bad content" }` | `{ text: "", blocked: true }` |

**Adaptive splitting tests:**

| Test | Scenario | Input | Expected Behavior |
|------|----------|-------|-------------------|
| No block | 4 segments, all clean | Normal translation | Single call, no splitting |
| 1 blocked in 4 | Segment 3 triggers block | Split → [1,2] succeeds, [3,4] → [3] blocked + [4] succeeds | 4 model calls total, 1 blocked result |
| All blocked | 2 segments, both trigger block | Split → [1] blocked, [2] blocked | 3 model calls, 2 blocked results |
| Max depth reached | Deep nesting | Segments keep blocking | Stops at maxSplitDepth, applies policy |
| Large group | 16 segments, #8 blocked | Binary search isolates #8 | ~8 model calls (4 levels), 1 blocked |

**Config resolution tests:**

| Test | Env Vars | Expected Config |
|------|----------|-----------------|
| Default policy | None set | `{ prohibitedContentPolicy: "keep_original", maxSplitDepth: 5 }` |
| Valid policy | `PROHIBITED_CONTENT_POLICY=redact` | `{ prohibitedContentPolicy: "redact" }` |
| Invalid policy | `PROHIBITED_CONTENT_POLICY=invalid` | Falls back to `"keep_original"`, no error |
| Valid split depth | `PROHIBITED_CONTENT_MAX_SPLIT_DEPTH=3` | `{ maxSplitDepth: 3 }` |
| Out of range depth | `PROHIBITED_CONTENT_MAX_SPLIT_DEPTH=99` | Falls back to `5` |

### 12.2 Integration Tests

These require a live or mocked Gemini API. Options:

1. **Mock approach:** Create a test harness that intercepts `generateText` calls and returns PROHIBITED_CONTENT-shaped errors for specific input patterns.
2. **Live approach (manual):** Use known content patterns that reliably trigger PROHIBITED_CONTENT blocks (must be documented in a private test guide, not committed to repo).

**Integration test scenarios:**

| Test | Description | Expected |
|------|-------------|----------|
| Clean file E2E | Upload a normal SRT file | 200, all segments translated, no blocked headers |
| File with 1 blocked segment | SRT where one segment triggers block | 200, partial status, blocked segment uses policy text, rest translated |
| File where all content blocked | SRT where every segment triggers block | 200, all segments use policy text, appropriate headers |
| Mixed batch | Multiple files, some clean, some with blocks | Each file handled independently, correct per-file status |
| Server timeout during split | Model times out during split retry | Appropriate error propagation, no infinite loops |

### 12.3 Regression Tests

Ensure existing behavior is preserved:

| Test | Description | Expected |
|------|-------------|----------|
| Normal translation flow | Standard SRT file, no blocks | Identical output to current implementation |
| Segment count validation | Model returns wrong count | Same retry + error behavior as current |
| Network error retry | Simulated network failure | Same exponential backoff behavior |
| Config validation | Invalid env vars | Same error messages as current |
| Stream format | Output SRT structure | Identical `id\ntimestamp\ntext\n\n` format |

### 12.4 Manual Testing Checklist

- [ ] Upload a clean SRT file → verify normal translation (no regressions).
- [ ] Upload a file known to trigger PROHIBITED_CONTENT → verify:
  - [ ] No 500 error or generic failure.
  - [ ] Blocked segments identified in response headers.
  - [ ] Output SRT has correct segment count and structure.
  - [ ] Blocked segments contain policy-appropriate text.
  - [ ] Console logs show splitting path with segment IDs and depths.
- [ ] Test each policy (`keep_original`, `placeholder`, `redact`) → verify correct text in blocked segments.
- [ ] Upload a multi-file batch with one blocked file and one clean file → verify:
  - [ ] Clean file completes normally.
  - [ ] Blocked file completes with partial status.
  - [ ] ZIP download contains both files.
- [ ] Verify retry behavior: blocked content is NOT retried; transient errors ARE retried.
- [ ] Verify `GET /api/config` returns new config fields.

---

## 13. Open Questions

### 13.1 AI SDK Error Shape

**Question:** What is the exact error object shape thrown by `@ai-sdk/google` / `ai` SDK when the Gemini API returns `promptFeedback.blockReason = PROHIBITED_CONTENT`?

**Action:** During implementation, capture and log the full error object (including `name`, `message`, `cause`, any custom properties) from a real PROHIBITED_CONTENT response. Build the `classifyTranslationError` function based on this real shape.

**Risk mitigation:** If the SDK doesn't expose the block reason in a stable way, we can fall back to string matching on the error message. If that's also unreliable, we should consider making direct REST calls to the Gemini API for the retry/split path (bypassing the SDK).

### 13.2 Streaming vs. Buffered Response for Partial Success

**Question:** The current implementation streams SRT blocks as each group completes. With the splitting fallback, should we continue streaming (sending blocks as they're ready, including blocked ones), or buffer until all groups are resolved?

**Recommendation:** Continue streaming. The splitting fallback operates within a single group's processing, so from the stream's perspective, each group still produces its segments in order. The only difference is that some segments may have fallback text. The response headers (`x-translation-blocked-segments`) can be set before streaming begins since they're part of the initial `Response` constructor. However, since we don't know which segments will be blocked until we process them, we have two options:

- **Option A (simpler):** Set headers after all groups are processed (buffer the full response). This changes the streaming behavior.
- **Option B (streaming-preserving):** Use trailing headers or include blocked-segment metadata as a final "metadata block" in the stream (e.g., a special delimiter-prefixed JSON line at the end).
- **Option C (hybrid, recommended):** Stream segments as they complete, but include a `x-translation-has-blocked-content: true` header optimistically if any block is detected (set before the response starts for the group that was split). Detailed blocked segment IDs are included in a final metadata block appended after the last SRT segment.

### 13.3 Alternate Provider Fallback

**Question:** Should we implement an optional alternate model/provider path for blocked segments?

**Recommendation:** Defer to a follow-up. The current plan handles the problem with splitting + policy. An alternate provider path adds significant complexity (different API keys, different prompt formats, different error shapes) and should be a separate feature if needed.

### 13.4 Client-Side Splitting as Alternative

**Question:** Should the client perform the splitting instead of the server?

**Recommendation:** Server-side splitting is preferred because:
- The server already has the segments parsed and grouped.
- Server-side splitting avoids additional HTTP round-trips for each sub-group.
- The client doesn't need to understand the splitting algorithm.
- Error classification requires inspecting provider-specific error shapes, which is better done server-side.

---

## 14. Implementation Order & File Change Map

### Phase 1: Error Detection & Classification (Foundation)

1. **`lib/content-block-handler.ts`** (new file)
   - `TranslationErrorInfo` type
   - `classifyTranslationError()` function
   - Unit test stubs (or companion test file)

2. **`app/api/route.ts`**
   - Import `classifyTranslationError`
   - Update `retrieveTranslation` catch block to classify errors
   - Add non-retryable error short-circuit
   - Improve logging with classification metadata

### Phase 2: Configuration

3. **`lib/translation-config.ts`**
   - Add `prohibitedContentPolicy`, `prohibitedContentPlaceholder`, `maxSplitDepth` to `TranslationRuntimeConfig`
   - Add env var resolution with validation and fallbacks
   - Update `.env.example`

4. **`app/api/config/route.ts`**
   - Expose new config fields in GET response

### Phase 3: Adaptive Splitting

5. **`lib/content-block-handler.ts`** (extend)
   - `applyIrreducibleBlockPolicy()` function
   - `TranslatedSegmentResult` and `TranslationGroupResult` types

6. **`app/api/route.ts`**
   - New `retrieveTranslationWithFallback()` function wrapping `retrieveTranslation`
   - Update stream loop to use `retrieveTranslationWithFallback`
   - Handle `TranslationGroupResult` in the streaming output
   - Add `x-translation-status` and `x-translation-blocked-segments` headers

### Phase 4: Retry Logic Refinement

7. **`app/api/route.ts`**
   - Upgrade fixed 1s delay to exponential backoff in `retrieveTranslation`
   - Differentiate retry behavior by error category

8. **`app/page.tsx`**
   - Detect non-retryable errors in `requestTranslationBatch`
   - Skip retry for PROHIBITED_CONTENT errors

### Phase 5: Client Updates & UI

9. **`app/page.tsx`**
   - Read new response headers in `handleStream`
   - Extend `FileResult` with blocked segment info
   - Update UI to show blocked segment warnings
   - Update retry logic to not retry content-blocked files

10. **`types.ts`**
    - Add new shared types if needed

### Phase 6: API Contract & Error Responses

11. **`app/api/route.ts`**
    - Structured error responses with `code` field
    - Ensure backward compatibility

### Phase 7: Observability

12. **`app/api/route.ts`** + **`lib/content-block-handler.ts`**
    - Comprehensive logging for all new paths
    - Correlation IDs through the splitting tree

---

## 15. Code Review Checklist

After implementation, verify each of these items:

### Correctness

- [ ] `classifyTranslationError` correctly identifies PROHIBITED_CONTENT from real AI SDK error shapes (tested with actual provider responses).
- [ ] Binary split always produces two non-empty halves (no off-by-one in `Math.ceil(segments.length / 2)`).
- [ ] Split recursion terminates: depth limit enforced, single-segment base case handled.
- [ ] Output segment count always matches input segment count (critical invariant for both server and client validation).
- [ ] Original segment IDs and timestamps are preserved in all paths (normal, split, blocked).
- [ ] Blocked segments carry the correct policy-applied text.
- [ ] The `x-translation-blocked-segments` header contains valid comma-separated integers.

### No Regressions

- [ ] Clean content (no blocks) follows the exact same code path as before, producing identical output.
- [ ] Transient error retries still work (429, 5xx, timeout, network errors).
- [ ] Segment count mismatch still throws after retries.
- [ ] `parsePayload`, `splitTranslatedSegments`, `normalizeTranslatedSegmentCount` are unchanged.
- [ ] Client-side `handleStream` still correctly counts SRT blocks from the stream.
- [ ] Config endpoint still returns all existing fields with correct types.
- [ ] Existing env vars (`GEMINI_MODEL_NAME`, `GEMINI_BATCH_TOKENS`, etc.) behave identically.

### Error Handling

- [ ] No unhandled promise rejections in the split recursion path.
- [ ] `controller.error()` is still called on fatal errors (after all recovery attempts are exhausted).
- [ ] `clearTimeout(timeoutId)` is still called in all paths (finally block preserved).
- [ ] Errors thrown from `retrieveTranslationWithFallback` include sufficient context for logging.

### Performance

- [ ] No unnecessary model calls: splitting only occurs after a PROHIBITED_CONTENT detection.
- [ ] `maxSplitDepth` prevents runaway recursion.
- [ ] No new `await` points in the hot path for clean content.
- [ ] Memory: split recursion depth is bounded; no large intermediate arrays.

### Security

- [ ] Error messages exposed to the client do not leak raw provider error details or internal paths.
- [ ] The `classifyTranslationError` function does not log full segment text (which may contain the prohibited content).
- [ ] New config values are validated and bounded.

### Compatibility

- [ ] New response headers don't break existing clients (headers are additive).
- [ ] JSON error response includes new `code` field alongside existing `error` and `runId` (additive).
- [ ] New env vars are all optional with sensible defaults.
- [ ] TypeScript types compile cleanly (`npm run build`).
- [ ] ESLint passes (`npm run lint`).

### Observability

- [ ] Every new code path has at least one log statement.
- [ ] All log statements include `runId` and `batchLabel`.
- [ ] Split path logs include `splitDepth` and affected segment IDs.
- [ ] No sensitive content (subtitle text) is logged at `info` level. Only lengths/counts.
- [ ] Error logs include the classified error category.
