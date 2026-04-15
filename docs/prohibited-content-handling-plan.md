# Implementation Plan: PROHIBITED_CONTENT Handling in Translation Pipeline

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Behavioral Walkthrough](#2-behavioral-walkthrough)
3. [Codebase Inventory & Impact Map](#3-codebase-inventory--impact-map)
4. [Error Taxonomy](#4-error-taxonomy)
5. [Architecture Changes](#5-architecture-changes)
6. [Algorithm: Adaptive Chunk-Splitting Fallback](#6-algorithm-adaptive-chunk-splitting-fallback)
7. [Irreducible Block Policy (Configurable)](#7-irreducible-block-policy-configurable)
8. [Retry Logic Updates](#8-retry-logic-updates)
9. [API Contract Updates](#9-api-contract-updates)
10. [Configuration Flags](#10-configuration-flags)
11. [Observability & Logging](#11-observability--logging)
12. [Client-Side Changes](#12-client-side-changes)
13. [Test Plan](#13-test-plan)
14. [Resolved Design Decisions](#14-resolved-design-decisions)
15. [Implementation Order & File Change Map](#15-implementation-order--file-change-map)
16. [Code Review Checklist](#16-code-review-checklist)

---

## 1. Problem Statement

When translating SRT subtitle content via the Gemini API (`@ai-sdk/google` + Vercel AI SDK's `generateText`), the upstream provider may return a response with `promptFeedback.blockReason = "PROHIBITED_CONTENT"` and **zero candidates/content**. This is a non-configurable safety block that cannot be resolved by adjusting safety threshold settings.

**Current failure mode:**

1. `generateText()` in `app/api/route.ts:166` throws an `AI_APICallError` with message `"Invalid JSON response"` and `statusCode: 200`. The root cause is an `AI_TypeValidationError` — the SDK's Zod schema expects a `candidates` array in the response, but the provider returned none.
2. The `retrieveTranslation` retry loop (`app/api/route.ts:149-255`) catches this as a generic error and retries the identical payload up to `MAX_RETRIES=3` times, which will fail identically every time (each attempt ~200ms, just wasting API quota).
3. The stream controller errors out (`controller.error(streamError)` at line 425), producing a broken response or empty 500 to the client.
4. The client retries the entire batch (`requestTranslationBatch` in `app/page.tsx:92-154`) up to 5 times with exponential backoff, but since the payload is unchanged, every retry fails identically.
5. The file is marked as "failed" with the generic error message `"Error during translation"` that gives no indication of content blocking.

**Confirmed error shape from production logs (Netlify):**

```
Error: AI_APICallError: Invalid JSON response
  statusCode: 200
  responseBody: {
    "promptFeedback": { "blockReason": "PROHIBITED_CONTENT" },
    "usageMetadata": { "promptTokenCount": 2130, "totalTokenCount": 2130, ... },
    "modelVersion": "gemini-3-flash-preview",
    "responseId": "..."
  }
  isRetryable: false
  cause: AI_TypeValidationError: Type validation failed
    value.promptFeedback.blockReason = "PROHIBITED_CONTENT"
    ZodError: candidates - expected "array", received invalid input
```

**Root cause:** The code has no detection path for `PROHIBITED_CONTENT` responses, no mechanism to reduce payload granularity on content-dependent failures, and no way to preserve partial results when only a subset of segments triggers the block.

---

## 2. Behavioral Walkthrough

This section explains, in plain terms, what will happen after this implementation when blocked content is encountered. It covers the full lifecycle from detection through final output.

### 2.1 The Happy Path (No Blocked Content — Unchanged)

Nothing changes for files that translate cleanly. The existing flow is identical:

1. Client sends a batch of SRT segments to `POST /api`.
2. Server groups them, calls the model, gets translated text back, streams SRT blocks.
3. Client receives the stream, counts segments, appends to the output file.
4. File downloads with all segments translated.

### 2.2 What Happens When PROHIBITED_CONTENT Is Detected

**Scenario:** An SRT file has 20 segments. The client groups them into 3 batches based on token limits (e.g., batch 1 = segments 1-8, batch 2 = segments 9-15, batch 3 = segments 16-20). Segment 12 (inside batch 2) contains text that triggers the provider's `PROHIBITED_CONTENT` block.

#### Step-by-step:

**Batch 1 (segments 1-8):** Sent to the server. The model translates all 8 segments normally. Streamed back to the client. No issues.

**Batch 2 (segments 9-15):** Sent to the server. The server groups these into a single model call. The model returns `PROHIBITED_CONTENT` because segment 12 is in the payload.

Here is where the new behavior kicks in:

1. **Detection:** The server catches the `AI_APICallError`, inspects its `responseBody` property, finds `promptFeedback.blockReason = "PROHIBITED_CONTENT"`, and classifies it as a non-retryable, content-dependent error. It does NOT retry with the same payload.

2. **First split:** The server splits the 7 segments into two halves:
   - Left half: segments 9, 10, 11 (3 segments)
   - Right half: segments 12, 13, 14, 15 (4 segments)

3. **Left half succeeds:** The server sends segments 9-11 to the model. They translate successfully, producing 3 translated segments.

4. **Right half fails:** The server sends segments 12-15 to the model. Blocked again (segment 12 is still in the payload).

5. **Second split on right half:**
   - Left: segments 12, 13 (2 segments)
   - Right: segments 14, 15 (2 segments)

6. **Segments 14-15 succeed:** Translated normally.

7. **Segments 12-13 fail:** Blocked again.

8. **Third split:**
   - Left: segment 12 alone (1 segment)
   - Right: segment 13 alone (1 segment)

9. **Segment 13 succeeds:** Translated normally.

10. **Segment 12 alone fails:** This is the **irreducible case**. A single segment cannot be split further. The configured policy is applied:
    - `keep_original` (default): The original source text is kept as the "translation."
    - `placeholder`: The text is replaced with `"[Content not available]"`.
    - `redact`: The text is replaced with an empty string.

11. **Merge:** All results are merged back in order: 9✅ 10✅ 11✅ 12⚠️ 13✅ 14✅ 15✅. The server streams all 7 SRT blocks to the client, with segment 12 carrying its policy-applied text.

**Batch 3 (segments 16-20):** Sent to the server. Translates normally. No issues.

**Final output:** The client receives all 20 segments. 19 are translated, 1 (segment 12) has its policy-applied text. The output SRT file is complete and well-formed — same segment count, same IDs, same timestamps, same structure as the input.

#### Model calls made for this scenario:

| Call | Segments | Result |
|------|----------|--------|
| 1 | 9-15 (original group) | BLOCKED |
| 2 | 9-11 (left split) | Success |
| 3 | 12-15 (right split) | BLOCKED |
| 4 | 12-13 (left split) | BLOCKED |
| 5 | 14-15 (right split) | Success |
| 6 | 12 (single) | BLOCKED → policy applied |
| 7 | 13 (single) | Success |

Total: 7 model calls for this group (instead of 1 for a clean group). Blocked responses return in ~200ms, so the overhead is modest.

### 2.3 What the Output File Looks Like

Given the scenario above with `keep_original` policy, the output SRT:

```
1
00:00:01,000 --> 00:00:03,000
[translated text for segment 1]

...

12
00:01:05,000 --> 00:01:08,500
[original source text — untranslated, because it was blocked]

13
00:01:08,500 --> 00:01:11,000
[translated text for segment 13]

...

20
00:02:30,000 --> 00:02:33,000
[translated text for segment 20]
```

With `placeholder` policy, segment 12 would read:

```
12
00:01:05,000 --> 00:01:08,500
[Content not available]
```

With `redact` policy, segment 12 would have empty text:

```
12
00:01:05,000 --> 00:01:08,500

```

In all cases: **20 segments in, 20 segments out. Same IDs, same timestamps, valid SRT.**

### 2.4 What the User Sees in the UI

- The file completes (not marked as "failed").
- A warning appears: "1 segment could not be translated due to content restrictions."
- The response headers carry `x-translation-status: partial` and `x-translation-blocked-segments: 12`.
- The file can still be downloaded and used — the SRT is structurally valid.

### 2.5 Edge Cases

**All segments in a batch blocked:** The splitting recurses to each individual segment, applies the policy to each one. The batch still "succeeds" (200 response) with all segments carrying policy-applied text. The UI shows a warning.

**Multiple non-adjacent blocked segments (e.g., 3 and 12 in the same group):** The binary split will find both. Some sub-groups may succeed on one side and fail on the other. Each blocked segment is independently isolated and gets the policy applied. Order is preserved.

**Different batches with blocked content:** Each batch is independent. Batch 1 might have 2 blocked segments, batch 2 might be clean, batch 3 might have 1 blocked. Each is handled in isolation. The final file merges all batches.

**Transient error during split:** If a sub-group fails with a 429 or 5xx during the split recursion, the normal retry logic applies to that specific sub-call. Only `PROHIBITED_CONTENT` triggers further splitting; transient errors are retried as usual.

---

## 3. Codebase Inventory & Impact Map

### Files requiring changes

| File | Current Role | Changes Needed |
|------|-------------|----------------|
| `app/api/route.ts` | Translation API route: model calls, retry loop, streaming response | Error detection, adaptive splitting, partial-success response format, new logging, buffered response approach |
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

- `@ai-sdk/google` (v3.0.30) / `ai` (v6.0.92): The SDK throws `AI_APICallError` with the full `responseBody` string on `PROHIBITED_CONTENT` responses. We detect block reasons by inspecting this error shape (see §4.3 for confirmed details). No SDK modifications needed.

---

## 4. Error Taxonomy

Define a structured classification for all errors in the translation path, informed by the official Gemini API documentation on [unsafe responses and finish reasons](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/configure-safety-filters#unsafe_responses).

### 4.1 Gemini Provider Block/Finish Reasons (Complete Reference)

The Gemini API can block or terminate responses at two levels, each with distinct response shapes:

#### Prompt-Level Blocks (`promptFeedback.blockReason`)

These block the entire prompt — **no candidates are returned**. The response has `promptFeedback.blockReason` set and the `candidates` array is absent.

| `blockReason` | Filter Type | Description | Configurable? |
|----------------|-------------|-------------|---------------|
| `PROHIBITED_CONTENT` | Non-configurable safety filter | Prompt flagged for prohibited content (typically CSAM) | **No** |
| `BLOCKED_REASON_UNSPECIFIED` | N/A | Reason for blocking is unspecified | No |
| `OTHER` | N/A | All other block reasons (e.g., unsupported language) | No |

#### Candidate-Level Finish Reasons (`candidates[].finishReason`)

These stop token generation on a specific candidate. A `candidates` array IS present, but `content` may be empty/voided if the finish reason indicates blocking.

| `finishReason` | Filter Type | Description | Has Content? | Configurable? |
|----------------|-------------|-------------|--------------|---------------|
| `STOP` | N/A | Natural stop or stop sequence reached | Yes | N/A |
| `MAX_TOKENS` | N/A | Hit maximum output token limit | Yes (partial) | N/A |
| `SAFETY` | Configurable content filter | Response flagged for safety (harm categories) | **No** (voided) | **Yes** (thresholds) |
| `RECITATION` | Citation filter | Potential copyright/recitation violation | **No** (voided) | No |
| `SPII` | Non-configurable safety filter | Sensitive PII detected in response | **No** (voided) | **No** |
| `PROHIBITED_CONTENT` | Non-configurable safety filter | Response contains prohibited content | **No** (voided) | **No** |
| `BLOCKLIST` | N/A | Response contains forbidden terms | **No** (voided) | No |
| `MALFORMED_FUNCTION_CALL` | N/A | Invalid function call generated | Partial | No |
| `MODEL_ARMOR` | N/A | Blocked by Model Armor | **No** (voided) | No |
| `OTHER` | N/A | Other reasons (e.g., unsupported language) | Varies | No |
| `FINISH_REASON_UNSPECIFIED` | N/A | Unspecified | Varies | No |

#### Key Distinction: Prompt Block vs. Candidate Finish

- **Prompt block:** The entire request is rejected before generation starts. No `candidates` array exists. The SDK throws `AI_APICallError` → `AI_TypeValidationError` because it expects `candidates` to be an array.
- **Candidate finish with content voided:** The `candidates` array exists but `content` is empty/null. The SDK may return an empty string or throw depending on the finish reason. The AI SDK may surface these differently (potentially as empty `text` or as an error).

Both categories need handling, but they manifest differently in the AI SDK error shapes.

### 4.2 Error Categories for This Implementation

```
TranslationError (base)
├── ProhibitedContentError          # promptFeedback.blockReason = PROHIBITED_CONTENT
│   │                               # OR finishReason = PROHIBITED_CONTENT
│   ├── groupLevel                  # A multi-segment group was blocked
│   └── segmentLevel                # A single (minimal) segment was blocked (irreducible)
├── SafetyFilterError               # finishReason = SAFETY (configurable harm-category block)
│   └── (same split/policy behavior as ProhibitedContentError)
├── ContentFilterError              # finishReason = RECITATION | SPII | BLOCKLIST | MODEL_ARMOR
│   └── (same split/policy behavior as ProhibitedContentError)
├── PromptBlockedError              # promptFeedback.blockReason = BLOCKED_REASON_UNSPECIFIED | OTHER
│   └── (same split/policy behavior — prompt was rejected for unknown/other reason)
├── SegmentCountMismatchError       # Model returned wrong number of segments
├── ModelTimeoutError               # AbortController timeout (55s)
├── TransientProviderError          # 429, 500, 502, 503, 504 from upstream
├── NetworkError                    # Fetch/connection failures
└── UnknownTranslationError         # Catch-all for unrecognized errors
```

### 4.3 Error Properties

Each error type carries structured classification metadata:

```typescript
type TranslationErrorCategory =
  | "prohibited_content"     // PROHIBITED_CONTENT at prompt or candidate level
  | "safety_filter"          // finishReason = SAFETY (configurable harm categories)
  | "content_filter"         // RECITATION, SPII, BLOCKLIST, MODEL_ARMOR
  | "prompt_blocked"         // BLOCKED_REASON_UNSPECIFIED, OTHER at prompt level
  | "segment_mismatch"       // Wrong segment count in model output
  | "timeout"                // AbortController / model timeout
  | "transient"              // 429, 5xx HTTP errors
  | "network"                // Connection/fetch failures
  | "unknown";               // Catch-all

type TranslationErrorInfo = {
  category: TranslationErrorCategory;
  retryable: boolean;           // Can identical payload be retried?
  splittable: boolean;          // Should we try smaller chunks?
  blockReason?: string;         // Raw provider block reason or finish reason
  providerResponseId?: string;  // Gemini responseId for correlation
  message: string;
};
```

**Classification rules:**

| Category | `retryable` | `splittable` | Rationale |
|----------|-------------|--------------|-----------|
| `prohibited_content` | `false` | `true` | Content-dependent, won't change on retry. Splitting isolates the offending segment. |
| `safety_filter` | `false` | `true` | Content-dependent (configurable thresholds, but still content-triggered). Splitting may isolate it. |
| `content_filter` | `false` | `true` | RECITATION/SPII/BLOCKLIST/MODEL_ARMOR — content-dependent, splitting may isolate. |
| `prompt_blocked` | `false` | `true` | Unknown/other prompt block — splitting may help if only part of content triggers it. |
| `segment_mismatch` | `true` | `false` | Model output format issue — retry may fix it, splitting won't help. |
| `timeout` | `true` | `false` | Transient infrastructure issue. |
| `transient` | `true` | `false` | Temporary provider overload/error. |
| `network` | `true` | `false` | Temporary connectivity issue. |
| `unknown` | `true` | `false` | Conservative: assume transient until proven otherwise. |

### 4.4 Confirmed AI SDK Error Shape (from Production)

From Netlify production logs, the error thrown by `@ai-sdk/google` on `PROHIBITED_CONTENT` has this structure:

```typescript
{
  name: "AI_APICallError",
  message: "Invalid JSON response",
  statusCode: 200,
  isRetryable: false,
  responseBody: '{\n  "promptFeedback": {\n    "blockReason": "PROHIBITED_CONTENT"\n  }, ...\n}',
  responseHeaders: { ... },
  cause: {
    name: "AI_TypeValidationError",
    message: "Type validation failed: ...",
    value: {
      promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
      usageMetadata: { promptTokenCount: 2130, totalTokenCount: 2130, ... },
      modelVersion: "gemini-3-flash-preview",
      responseId: "urXfab2RMdCW1MkP7fSQ8Q0"
    },
    cause: {
      name: "ZodError",
      // candidates expected array, got undefined
    }
  }
}
```

### 4.5 Detection Logic

Based on the confirmed error shape, `classifyTranslationError` should use a multi-layered detection strategy:

```typescript
function classifyTranslationError(error: unknown): TranslationErrorInfo {
  // Layer 1: Check for AI_APICallError with responseBody containing block reasons
  //   → Parse responseBody JSON string
  //   → Check promptFeedback.blockReason
  //   → Check candidates[].finishReason

  // Layer 2: Check error.cause for AI_TypeValidationError with .value
  //   → Inspect .value.promptFeedback.blockReason
  //   → This is the most reliable path for prompt-level blocks

  // Layer 3: Check error.cause.cause for ZodError on "candidates" path
  //   → Confirms the SDK expected candidates but got none

  // Layer 4: String matching on error.message as fallback
  //   → Look for "PROHIBITED_CONTENT", "SAFETY", "RECITATION", "SPII", etc.

  // Layer 5: Check statusCode for transient errors (429, 5xx)
  // Layer 6: Check error.name for "AbortError" (timeout)
  // Layer 7: Check error.name/message for network errors
}
```

**Priority order:** Layer 2 (cause.value) is the most reliable because it gives us the parsed response object directly. Layer 1 (responseBody string parsing) is the fallback. Layer 4 (string matching) is the last resort.

**Detection for candidate-level blocks:**

For `finishReason`-based blocks (SAFETY, RECITATION, SPII, etc.), the AI SDK behavior may differ — it might return empty text instead of throwing. We need to handle both:

1. If `generateText()` throws with a finish-reason-related error → classify from the error.
2. If `generateText()` returns but with empty/missing text → check if the response metadata indicates a non-STOP finish reason. The AI SDK `generateText` return value includes `finishReason` — check it before proceeding to segment splitting.

```typescript
const { text, finishReason, response } = await generateText({ ... });

if (finishReason && finishReason !== "stop" && finishReason !== "length") {
  // Non-normal finish: classify and handle
  throw new ContentBlockError(finishReason, response);
}

if (!text || text.trim().length === 0) {
  // Empty response — may indicate a blocked response that didn't throw
  throw new EmptyResponseError(finishReason, response);
}
```

---

## 5. Architecture Changes

### 5.1 Current Flow (simplified)

```
POST /api
  → parse SRT → group by tokens → for each group:
      → retrieveTranslation (up to 3 retries, same payload)
          → generateText() → split by delimiter → validate count → return segments
      → stream SRT blocks to client
```

### 5.2 Proposed Flow

The key architectural decisions are:
- **Splitting happens server-side** within `retrieveTranslationWithFallback`.
- **Response is buffered** (not streamed) to ensure we know all blocked segment IDs before sending headers. This trades streaming latency for reliability and consistency — the client receives a complete, validated response with accurate metadata.

```
POST /api
  → parse SRT → group by tokens → for each group:
      → retrieveTranslationWithFallback(group)
          → try retrieveTranslation(group)
          → on splittable error (PROHIBITED_CONTENT, SAFETY, RECITATION, SPII, etc.):
              → if group.length > 1: binary-split group → recurse on each half
              → if group.length === 1: apply irreducible-block policy
          → on retryable error: retry with backoff (existing behavior inside retrieveTranslation)
          → on other errors: propagate
      → collect ALL results (translated OR fallback text) preserving order
  → after ALL groups complete:
      → set response headers (x-translation-status, x-translation-blocked-segments)
      → write buffered SRT blocks to response body
  → return response with accurate metadata
```

### 5.3 Why Buffered Instead of Streaming

The current implementation streams SRT blocks as each group completes. With the splitting fallback, we switch to a buffered approach:

**Rationale:**
- **Header accuracy:** Response headers (`x-translation-blocked-segments`, `x-translation-status`) must reflect the final state of ALL groups. With streaming, headers are sent before group processing begins, so we cannot know which segments will be blocked.
- **Consistency:** If a group fails catastrophically mid-stream (e.g., the model service goes down during a split), a streamed response has already sent partial data that cannot be retracted. A buffered approach can return a proper error instead.
- **Validation:** We can validate the total segment count and structure before sending anything.
- **Trade-off:** Slightly higher time-to-first-byte. For typical batch sizes (~350 tokens per group, ~8 segments), the delay is negligible. For very large files, the delay is bounded by the number of groups × model call time, which is the same total time regardless of buffering.

### 5.4 New Module: `lib/content-block-handler.ts`

Create a dedicated module to encapsulate:

- `classifyTranslationError(error: unknown): TranslationErrorInfo`
- `applyIrreducibleBlockPolicy(segment, policy, placeholder): TranslatedSegmentResult`
- Types: `TranslationErrorInfo`, `TranslatedSegmentResult`, `TranslationGroupResult`

This keeps the main route handler focused on orchestration and keeps the splitting/fallback logic testable in isolation.

### 5.5 Data Flow Diagram

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
                    ✅ Success  ⚠️ Splittable  ❌ Other                   │
                         │      Error         Error                      │
                         │     (content       (transient/                │
                         │      block)        timeout/etc)               │
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

### 5.6 Result Type for Group Translation

```typescript
type TranslatedSegmentResult = {
  text: string;
  blocked: boolean;
  originalSegmentId: number;
  blockReason?: string;
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

## 6. Algorithm: Adaptive Chunk-Splitting Fallback

### 6.1 Overview

When a multi-segment group triggers a content block (PROHIBITED_CONTENT, SAFETY, RECITATION, SPII, BLOCKLIST, MODEL_ARMOR, or other prompt-level blocks), we recursively split it into smaller sub-groups and retry each independently. This isolates the specific segment(s) causing the block while allowing the rest to translate normally.

### 6.2 Algorithm Steps

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
     → ALSO check finishReason on success: if non-normal (SAFETY, RECITATION, etc.),
       treat as a content block error

  2. On success (finishReason = STOP or equivalent):
     → return { segments: translated, hasBlockedSegments: false, splitDepth: depth }

  3. On splittable error (any content-block category):
     a. Log: "[translate][{runId}] Content blocked at depth {depth},
              category {category}, blockReason {reason},
              segments [{segmentIds}], splitting"
     b. If segments.length === 1:
        → This is an irreducible block
        → Apply configured policy (see §7)
        → Return result with blocked: true, blockReason set
     c. If depth >= maxSplitDepth:
        → Safety limit: too many splits
        → Apply irreducible policy to all remaining segments
        → Log warning about depth limit
     d. Split segments into two halves:
        → left  = segments[0 .. mid-1]
        → right = segments[mid .. end]
        where mid = Math.ceil(segments.length / 2)
     e. Recurse:
        → leftResult  = retrieveTranslationWithFallback(left,  ..., depth+1)
        → rightResult = retrieveTranslationWithFallback(right, ..., depth+1)
     f. Merge results preserving original order
     g. Return merged result with hasBlockedSegments, blockedSegmentIds aggregated

  4. On retryable error (429, 5xx, timeout, network):
     → These are already handled by the retry loop inside retrieveTranslation()
     → If all retries exhausted, propagate the error (do NOT split—splitting won't help)

  5. On other non-splittable errors:
     → Propagate (no splitting)
```

### 6.3 Splitting Strategy: Binary Split

Binary split is chosen over linear (one-at-a-time peeling) for efficiency:

- **Worst case (1 blocked segment in N):** Binary split requires O(log N) model calls to isolate it. Linear peeling requires O(N) calls.
- **Multiple blocked segments:** Binary split naturally handles clusters and still converges efficiently.
- **Split depth limit:** With `maxSplitDepth = 5`, we can handle groups of up to 32 segments (2^5), which is well beyond typical group sizes at the default 350-token limit.

### 6.4 Ordering Guarantee

The recursive split always operates on contiguous sub-arrays of the original segment list. Results are concatenated in the same left-right order, so the final output maintains the exact original ordering without any sort or reindex step.

### 6.5 Performance Considerations

- **Best case (no blocked content):** Zero overhead — single successful call, identical to current behavior.
- **Typical blocked case (1 blocked segment in a group of ~8):** ~7 additional model calls (3 levels of binary split). Blocked responses return in ~200ms (confirmed from production logs), so the overhead is ~1-2 seconds.
- **Worst case (all segments blocked):** Degenerates to N individual calls plus the split overhead, but each call is small and fast-failing (~200ms per blocked response).
- **Mitigation:** The split path only triggers after an initial block, so it never adds latency to clean content. Groups that succeed normally are completely unaffected.

---

## 7. Irreducible Block Policy (Configurable)

When a single segment (minimal unit) is blocked by any content filter, we cannot split further. The system applies a configurable policy.

### 7.1 Policy Options

| Policy | Behavior | Use Case |
|--------|----------|----------|
| `keep_original` | Keep the original source-language text | Preserves all content; viewer sees untranslated segment |
| `placeholder` | Replace with configurable placeholder text | Clearly marks blocked content; avoids confusion |
| `redact` | Replace with empty/redaction marker | Removes blocked content from output |

### 7.2 Configuration

```
PROHIBITED_CONTENT_POLICY=keep_original|placeholder|redact  (default: keep_original)
PROHIBITED_CONTENT_PLACEHOLDER=[Content not available]      (default, only used when policy=placeholder)
```

### 7.3 Implementation

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

### 7.4 Output Structure Preservation

Regardless of policy, the output SRT always contains the same number of segments as the input, with original IDs and timestamps. Only the text content of blocked segments is affected. This ensures:

- Segment count validation on both server and client continues to pass.
- Subtitle timing is preserved.
- Downstream tools (video players, subtitle editors) receive a well-formed SRT file.
- The output SRT is structurally identical to what a fully successful translation would produce.

---

## 8. Retry Logic Updates

### 8.1 Server-Side (`retrieveTranslation` in `app/api/route.ts`)

**Current behavior:** 3 retries with 1-second fixed delay for all errors.

**Proposed changes:**

| Error Category | Retry? | Action |
|---|---|---|
| `prohibited_content` | **No retry** at same payload | Immediately return to caller for splitting/policy |
| `safety_filter` | **No retry** at same payload | Same as above |
| `content_filter` | **No retry** at same payload | Same (RECITATION, SPII, BLOCKLIST, MODEL_ARMOR) |
| `prompt_blocked` | **No retry** at same payload | Same (BLOCKED_REASON_UNSPECIFIED, OTHER at prompt level) |
| `segment_mismatch` | **1 retry** (model may produce correct count on retry) | Existing behavior, but limited to 1 retry for this class |
| `timeout` | **Retry** (up to MAX_RETRIES) | Existing behavior |
| `transient` (429, 5xx) | **Retry with backoff** (up to MAX_RETRIES) | Upgrade from fixed 1s to exponential backoff with jitter |
| `network` | **Retry with backoff** | Same as transient |
| `unknown` | **1 retry** | Conservative retry in case of transient weirdness |

**Key change:** `retrieveTranslation` should throw a typed/tagged error that the caller (`retrieveTranslationWithFallback`) can inspect to decide whether to split or propagate. The function itself should NOT retry content-block errors.

```typescript
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    const result = await callModel(...);
    // Check finishReason even on "success"
    if (isContentBlockFinishReason(result.finishReason)) {
      throw createContentBlockError(result.finishReason, result);
    }
    return result;
  } catch (error) {
    const classified = classifyTranslationError(error);

    if (!classified.retryable) {
      throw tagError(error, classified);
    }

    if (attempt < MAX_RETRIES) {
      const delay = getServerRetryDelay(attempt);
      await sleep(delay);
      continue;
    }

    throw tagError(error, classified);
  }
}
```

### 8.2 Server-Side Backoff Upgrade

Replace the fixed 1-second delay with exponential backoff + jitter, consistent with the client-side approach:

```
attempt 1 → 1000ms + jitter(0-250ms)
attempt 2 → 2000ms + jitter(0-250ms)
attempt 3 → 4000ms + jitter(0-250ms)
```

### 8.3 Client-Side (`requestTranslationBatch` in `app/page.tsx`)

**Current behavior:** 5 retries with exponential backoff for network errors and retriable HTTP statuses (408, 425, 429, 500, 502, 503, 504).

**Proposed changes:**

Since the server handles splitting internally and returns a 200 with partial-success metadata for blocked content, the client mostly needs to handle the metadata — not change retry behavior for blocked content.

However, if the server returns a non-200 error response with the new `code` field indicating a content block (edge case — only if something catastrophic happens during the split itself), the client should NOT retry:

```typescript
if (!response.ok) {
  const errorBody = await response.json().catch(() => null);
  const isContentBlock = errorBody?.code && [
    "PROHIBITED_CONTENT",
    "SAFETY_FILTER",
    "CONTENT_FILTER",
    "PROMPT_BLOCKED",
  ].includes(errorBody.code);

  if (isContentBlock) {
    throw new Error(
      errorBody.error || "Translation blocked due to content restrictions."
    );
  }
  // ... existing retry logic for transient errors
}
```

---

## 9. API Contract Updates

### 9.1 Success Response (200) — Enhanced

**Current:** `Content-Type: text/plain; charset=utf-8` streaming SRT blocks.

**Proposed:** Same format but **buffered** (complete body sent at once after all groups are processed), with additional response headers:

```
x-translation-run-id: <uuid>
x-translation-status: complete | partial                         (always present)
x-translation-blocked-segments: <comma-separated segment IDs>   (only if any blocked)
x-translation-blocked-reasons: <comma-separated reasons>        (only if any blocked, e.g. "PROHIBITED_CONTENT,SAFETY")
```

The body format is unchanged — each block is still `id\ntimestamp\ntext\n\n`. Blocked segments appear with their policy-applied text (original, placeholder, or empty depending on configured policy).

**Rationale for buffered approach:** Headers are set AFTER all groups are processed, ensuring `x-translation-blocked-segments` is accurate and complete. The body is a single write of the fully assembled SRT content.

### 9.2 Error Response — New Structured Format

**Current:** `{ error: string, runId: string }` with status 400 or 500.

**Proposed:** Extend with optional machine-readable fields:

```json
{
  "error": "Human-readable error message",
  "code": "PROHIBITED_CONTENT" | "SAFETY_FILTER" | "CONTENT_FILTER" | "PROMPT_BLOCKED" | "TRANSLATION_ERROR" | "INVALID_REQUEST" | "CONFIG_ERROR",
  "runId": "uuid",
  "blockedSegmentIds": [3, 7, 12],
  "blockReasons": ["PROHIBITED_CONTENT"],
  "totalSegments": 25,
  "translatedSegments": 22
}
```

- `code` field enables programmatic client-side handling.
- `blockedSegmentIds` and `blockReasons` are only present for content-block errors.
- Backward compatibility: existing clients that only read `error` and `runId` continue to work.

### 9.3 Full-Block Scenario

If **all** segments in a request are blocked and the configured policy is `keep_original`, the server still returns 200 with the original text (nothing was actually translated, but the output structure is valid). The `x-translation-status: partial` and `x-translation-blocked-segments` headers indicate this.

If the configured policy is `redact` and all segments are blocked, the server returns 200 with empty text segments but valid SRT structure.

### 9.4 Config Endpoint Updates (`GET /api/config`)

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

## 10. Configuration Flags

### 10.1 New Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PROHIBITED_CONTENT_POLICY` | `"keep_original"` \| `"placeholder"` \| `"redact"` | `"keep_original"` | What to do with irreducibly blocked segments |
| `PROHIBITED_CONTENT_PLACEHOLDER` | string | `"[Content not available]"` | Placeholder text when policy is `placeholder` |
| `PROHIBITED_CONTENT_MAX_SPLIT_DEPTH` | number (1-10) | `5` | Maximum recursion depth for binary splitting |

### 10.2 Config Resolution

Add to `resolveTranslationRuntimeConfig()` in `lib/translation-config.ts`:

```typescript
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

### 10.3 `.env.example` Updates

```
# Prohibited content handling (non-configurable safety blocks)
# PROHIBITED_CONTENT_POLICY=keep_original    # keep_original | placeholder | redact
# PROHIBITED_CONTENT_PLACEHOLDER=[Content not available]
# PROHIBITED_CONTENT_MAX_SPLIT_DEPTH=5
```

---

## 11. Observability & Logging

### 11.1 Log Events

All log events use the existing `[translate][{runId}]` prefix pattern.

| Event | Level | When | Fields |
|-------|-------|------|--------|
| `content blocked` | `warn` | Error classified as any content-block category | `runId`, `batchLabel`, `groupIndex`, `category`, `blockReason`, `segmentIds`, `segmentCount`, `splitDepth`, `providerResponseId` |
| `splitting group` | `info` | Starting binary split on a blocked group | `runId`, `batchLabel`, `groupIndex`, `originalSize`, `leftSize`, `rightSize`, `depth` |
| `irreducible block` | `warn` | Single segment blocked, applying policy | `runId`, `batchLabel`, `segmentId`, `category`, `blockReason`, `policy`, `originalTextLength` |
| `split fallback complete` | `info` | All sub-groups resolved (some may be blocked) | `runId`, `batchLabel`, `totalSegments`, `blockedCount`, `splitDepth`, `durationMs` |
| `batch partial success` | `info` | Batch completed with some blocked segments | `runId`, `batchLabel`, `totalSegments`, `translatedCount`, `blockedCount`, `blockedSegmentIds`, `blockReasons` |
| `error classified` | `info` | Any error goes through classification | `runId`, `category`, `retryable`, `splittable`, `blockReason`, `providerResponseId`, `message` (truncated) |
| `finishReason non-normal` | `warn` | generateText returned non-STOP finishReason | `runId`, `batchLabel`, `finishReason`, `segmentCount` |

### 11.2 Correlation

All log entries in a request lifecycle share `runId` and `batchLabel`. The splitting path adds `splitDepth` and preserves the same `runId`/`batchLabel`, so log aggregation can trace the full splitting tree for any request. The `providerResponseId` (from Gemini's `responseId`) enables cross-referencing with provider-side logs.

### 11.3 Metrics (Future)

If a metrics system is added later, the following counters/histograms would be valuable:

- `translation_content_blocked_total{category}` (counter): content blocks by category
- `translation_split_depth` (histogram): how deep the splitting went
- `translation_blocked_segments_total` (counter): total irreducibly blocked segments
- `translation_split_fallback_duration_ms` (histogram): time spent in the split/retry path

---

## 12. Client-Side Changes

### 12.1 `app/page.tsx` Updates

**Response header reading:**

After `response.ok` in `handleStream`, read the new headers:

```typescript
const blockedSegmentsHeader = response.headers.get("x-translation-blocked-segments");
const translationStatus = response.headers.get("x-translation-status");

const blockedSegmentIds = blockedSegmentsHeader
  ? blockedSegmentsHeader.split(",").map(Number).filter(Number.isFinite)
  : [];
const isPartial = translationStatus === "partial";
```

**Return type of `handleStream`:** Extend to include blocked-segment metadata:

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

If the server returns a non-200 response with a content-block `code`, the client should mark the batch as failed with a descriptive message rather than retrying:

```typescript
if (!response.ok) {
  const errorBody = await response.json().catch(() => null);
  const isContentBlock = errorBody?.code && [
    "PROHIBITED_CONTENT", "SAFETY_FILTER", "CONTENT_FILTER", "PROMPT_BLOCKED",
  ].includes(errorBody.code);

  if (isContentBlock) {
    throw new Error(
      errorBody.error || "Translation blocked due to content restrictions."
    );
  }
  // ... existing retry logic for transient errors
}
```

Note: With the server-side splitting approach, this error path should rarely be hit (only if something catastrophic happens during the split itself). The normal path is a 200 with partial-success metadata.

### 12.2 `FileResult` Type Extension

```typescript
type FileResult = {
  // ... existing fields ...
  blockedSegmentIds?: number[];
  isPartialTranslation?: boolean;
};
```

### 12.3 Retry Behavior

The client's `handleRetryFailed()` should NOT retry files that failed solely due to content blocks (since the content hasn't changed). With the server-side splitting approach:

1. **Normal case:** Most blocked-content scenarios result in partial success (200), not failure. Files are marked "success" with a warning.
2. **Edge case:** If a file is entirely blocked content, it still succeeds (with original text / placeholders). Only catastrophic server errors during splitting would produce a failure that's worth retrying.

---

## 13. Test Plan

### 13.1 Unit Tests (new file: future test infrastructure)

Since the project currently has no test runner, tests should be added alongside a minimal test setup (recommend `vitest` given the Next.js/TypeScript stack).

**Error classification tests:**

| Test | Input | Expected |
|------|-------|----------|
| Detect PROHIBITED_CONTENT from AI SDK error (prompt block) | Mocked `AI_APICallError` with `responseBody` containing `promptFeedback.blockReason: "PROHIBITED_CONTENT"` (exact shape from production logs) | `{ category: "prohibited_content", retryable: false, splittable: true }` |
| Detect PROHIBITED_CONTENT from cause chain | Error with `cause.value.promptFeedback.blockReason: "PROHIBITED_CONTENT"` | Same as above |
| Detect SAFETY finishReason (configurable filter) | Error/response with `finishReason: "SAFETY"` | `{ category: "safety_filter", retryable: false, splittable: true }` |
| Detect RECITATION finishReason | Error/response with `finishReason: "RECITATION"` | `{ category: "content_filter", retryable: false, splittable: true }` |
| Detect SPII finishReason | Error/response with `finishReason: "SPII"` | `{ category: "content_filter", retryable: false, splittable: true }` |
| Detect BLOCKLIST finishReason | Error/response with `finishReason: "BLOCKLIST"` | `{ category: "content_filter", retryable: false, splittable: true }` |
| Detect MODEL_ARMOR finishReason | Error/response with `finishReason: "MODEL_ARMOR"` | `{ category: "content_filter", retryable: false, splittable: true }` |
| Detect prompt blocked (unspecified) | `promptFeedback.blockReason: "BLOCKED_REASON_UNSPECIFIED"` | `{ category: "prompt_blocked", retryable: false, splittable: true }` |
| Detect prompt blocked (other) | `promptFeedback.blockReason: "OTHER"` | `{ category: "prompt_blocked", retryable: false, splittable: true }` |
| Detect transient 429 error | Error with `statusCode: 429` | `{ category: "transient", retryable: true, splittable: false }` |
| Detect transient 500 error | Error with `statusCode: 500` | `{ category: "transient", retryable: true, splittable: false }` |
| Detect timeout | `AbortError` | `{ category: "timeout", retryable: true, splittable: false }` |
| Detect segment mismatch | Error message matching `"Expected N segments, received M"` | `{ category: "segment_mismatch", retryable: true, splittable: false }` |
| Detect network error | `TypeError: fetch failed` | `{ category: "network", retryable: true, splittable: false }` |
| Unknown error | Generic `Error("something")` | `{ category: "unknown", retryable: true, splittable: false }` |
| String fallback detection | Error with `"PROHIBITED_CONTENT"` only in message string | `{ category: "prohibited_content", retryable: false, splittable: true }` |

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

### 13.2 Integration Tests

These require a live or mocked Gemini API. Options:

1. **Mock approach:** Create a test harness that intercepts `generateText` calls and returns PROHIBITED_CONTENT-shaped errors for specific input patterns. Mock both prompt-level blocks (no candidates) and candidate-level blocks (finishReason = SAFETY, etc.).
2. **Live approach (manual):** Use known content patterns that reliably trigger PROHIBITED_CONTENT blocks (must be documented in a private test guide, not committed to repo).

**Integration test scenarios:**

| Test | Description | Expected |
|------|-------------|----------|
| Clean file E2E | Upload a normal SRT file | 200, all segments translated, no blocked headers |
| File with 1 blocked segment (PROHIBITED_CONTENT) | SRT where one segment triggers prompt block | 200, partial status, blocked segment uses policy text, rest translated |
| File with SAFETY finishReason block | SRT where one segment triggers SAFETY block | Same behavior as PROHIBITED_CONTENT |
| File with RECITATION block | SRT where one segment triggers recitation | Same behavior |
| File where all content blocked | SRT where every segment triggers block | 200, all segments use policy text, appropriate headers |
| Mixed batch | Multiple files, some clean, some with blocks | Each file handled independently, correct per-file status |
| Server timeout during split | Model times out during split retry | Appropriate error propagation, no infinite loops |
| Transient error during split | 429 during a sub-group retry | Normal retry logic applies to the sub-group, then splitting continues |

### 13.3 Regression Tests

Ensure existing behavior is preserved:

| Test | Description | Expected |
|------|-------------|----------|
| Normal translation flow | Standard SRT file, no blocks | Identical output to current implementation |
| Segment count validation | Model returns wrong count | Same retry + error behavior as current |
| Network error retry | Simulated network failure | Same exponential backoff behavior |
| Config validation | Invalid env vars | Same error messages as current |
| SRT output format | Output structure | Identical `id\ntimestamp\ntext\n\n` format |
| Buffered response equivalence | Compare buffered output to previous streamed output for clean files | Byte-identical SRT body content |

### 13.4 Manual Testing Checklist

- [ ] Upload a clean SRT file → verify normal translation (no regressions).
- [ ] Upload a file known to trigger PROHIBITED_CONTENT → verify:
  - [ ] No 500 error or generic failure.
  - [ ] Blocked segments identified in response headers.
  - [ ] Output SRT has correct segment count and structure.
  - [ ] Blocked segments contain policy-appropriate text.
  - [ ] Console logs show splitting path with segment IDs, block reasons, and depths.
- [ ] Test each policy (`keep_original`, `placeholder`, `redact`) → verify correct text in blocked segments.
- [ ] Upload a multi-file batch with one blocked file and one clean file → verify:
  - [ ] Clean file completes normally.
  - [ ] Blocked file completes with partial status.
  - [ ] ZIP download contains both files.
- [ ] Verify retry behavior: blocked content is NOT retried; transient errors ARE retried.
- [ ] Verify `GET /api/config` returns new config fields.
- [ ] Verify logs contain `providerResponseId` from Gemini for correlation.

---

## 14. Resolved Design Decisions

### 14.1 AI SDK Error Shape (Confirmed)

**Decision:** The error shape is confirmed from production Netlify logs. The AI SDK throws `AI_APICallError` with:

- `name: "AI_APICallError"`
- `message: "Invalid JSON response"`
- `statusCode: 200`
- `isRetryable: false`
- `responseBody`: a JSON string containing the full Gemini response including `promptFeedback.blockReason`
- `cause`: an `AI_TypeValidationError` whose `.value` property contains the parsed response object with `promptFeedback.blockReason` directly accessible

**Detection strategy:** Primary detection via `error.cause.value.promptFeedback.blockReason`. Fallback via parsing `error.responseBody` as JSON. Last resort via string matching on `error.message` or `error.responseBody`.

For candidate-level finish reasons (SAFETY, RECITATION, SPII, etc.), the `generateText()` return value's `finishReason` field should be checked after every successful call. If `finishReason` indicates a content block, it should be treated the same as a prompt-level block.

### 14.2 Streaming vs. Buffered Response

**Decision:** Buffered. The response is assembled in full before being sent to the client. This ensures:

- Response headers (`x-translation-blocked-segments`, `x-translation-status`) are accurate.
- The client receives a complete, validated response.
- No partial/broken streams if errors occur during the split recursion.
- The SRT output is structurally validated before delivery.

**Trade-off:** Slightly higher time-to-first-byte, but total request time is the same. For typical file sizes, the difference is negligible.

### 14.3 Alternate Provider Fallback

**Decision:** Not implementing in this iteration. The splitting + policy approach handles the problem. An alternate provider path adds significant complexity (different API keys, prompt formats, error shapes, billing) and should be a separate feature if needed in the future.

### 14.4 Client-Side vs. Server-Side Splitting

**Decision:** Server-side splitting. The splitting algorithm runs within the API route handler, not in the client. Rationale:

- **Fewer HTTP round-trips:** The server makes additional model calls internally rather than requiring the client to send multiple HTTP requests for each sub-group.
- **Simpler client logic:** The client sends one request per batch and gets back a complete result with metadata. It doesn't need to implement the splitting algorithm.
- **Better error classification:** The server has direct access to the AI SDK error objects with their full cause chains, making detection more reliable than trying to communicate error types through HTTP responses.
- **Atomicity:** Each batch request either fully resolves (with some segments potentially using fallback text) or fails entirely. The client never sees a half-split batch.

---

## 15. Implementation Order & File Change Map

### Phase 1: Error Detection & Classification (Foundation)

1. **`lib/content-block-handler.ts`** (new file)
   - `TranslationErrorInfo` type and `TranslationErrorCategory` type
   - `classifyTranslationError()` function with multi-layered detection
   - Detection for both prompt-level blocks and candidate-level finish reasons
   - Unit test stubs (or companion test file)

2. **`app/api/route.ts`**
   - Import `classifyTranslationError`
   - Update `retrieveTranslation` catch block to classify errors
   - Add `finishReason` check after successful `generateText()` calls
   - Add non-retryable error short-circuit
   - Improve logging with classification metadata and `providerResponseId`

### Phase 2: Configuration

3. **`lib/translation-config.ts`**
   - Add `prohibitedContentPolicy`, `prohibitedContentPlaceholder`, `maxSplitDepth` to `TranslationRuntimeConfig`
   - Add env var resolution with validation and fallbacks
   - Update `.env.example`

4. **`app/api/config/route.ts`**
   - Expose new config fields in GET response

### Phase 3: Adaptive Splitting & Buffered Response

5. **`lib/content-block-handler.ts`** (extend)
   - `applyIrreducibleBlockPolicy()` function
   - `TranslatedSegmentResult` and `TranslationGroupResult` types

6. **`app/api/route.ts`**
   - New `retrieveTranslationWithFallback()` function wrapping `retrieveTranslation`
   - Convert stream-based response to buffered response (collect all results first, then write)
   - Handle `TranslationGroupResult` in the output assembly
   - Add `x-translation-status` and `x-translation-blocked-segments` headers (set from final results)

### Phase 4: Retry Logic Refinement

7. **`app/api/route.ts`**
   - Upgrade fixed 1s delay to exponential backoff in `retrieveTranslation`
   - Differentiate retry behavior by error category (skip retries for all content-block categories)

8. **`app/page.tsx`**
   - Detect non-retryable content-block errors in `requestTranslationBatch`
   - Skip retry for all content-block error codes

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
    - Structured error responses with `code` field covering all content-block categories
    - Ensure backward compatibility

### Phase 7: Observability

12. **`app/api/route.ts`** + **`lib/content-block-handler.ts`**
    - Comprehensive logging for all new paths including block reasons and provider response IDs
    - Correlation IDs through the splitting tree

---

## 16. Code Review Checklist

After implementation, verify each of these items:

### Correctness

- [ ] `classifyTranslationError` correctly identifies all prompt-level block reasons: `PROHIBITED_CONTENT`, `BLOCKED_REASON_UNSPECIFIED`, `OTHER`.
- [ ] `classifyTranslationError` correctly identifies all candidate-level finish reasons: `SAFETY`, `RECITATION`, `SPII`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `MODEL_ARMOR`.
- [ ] Detection works with the confirmed AI SDK error shape (`AI_APICallError` → `AI_TypeValidationError` → `ZodError` chain, with `cause.value.promptFeedback.blockReason`).
- [ ] Detection works with the `responseBody` string parsing fallback.
- [ ] `finishReason` is checked after every successful `generateText()` call, catching candidate-level blocks that don't throw.
- [ ] Binary split always produces two non-empty halves (no off-by-one in `Math.ceil(segments.length / 2)`).
- [ ] Split recursion terminates: depth limit enforced, single-segment base case handled.
- [ ] Output segment count always matches input segment count (critical invariant for both server and client validation).
- [ ] Original segment IDs and timestamps are preserved in all paths (normal, split, blocked).
- [ ] Blocked segments carry the correct policy-applied text.
- [ ] The `x-translation-blocked-segments` header contains valid comma-separated integers.
- [ ] The `x-translation-blocked-reasons` header contains the distinct block reasons encountered.
- [ ] Buffered response produces byte-identical SRT body content compared to the previous streaming approach for non-blocked content.

### No Regressions

- [ ] Clean content (no blocks) follows the same logic, producing identical output.
- [ ] Transient error retries still work (429, 5xx, timeout, network errors).
- [ ] Segment count mismatch still throws after retries.
- [ ] `parsePayload`, `splitTranslatedSegments`, `normalizeTranslatedSegmentCount` are unchanged.
- [ ] Client-side `handleStream` still correctly counts SRT blocks from the response body.
- [ ] Config endpoint still returns all existing fields with correct types.
- [ ] Existing env vars (`GEMINI_MODEL_NAME`, `GEMINI_BATCH_TOKENS`, etc.) behave identically.
- [ ] Buffered response does not cause timeout issues for large files (check against `maxDuration = 300`).

### Error Handling

- [ ] No unhandled promise rejections in the split recursion path.
- [ ] Fatal errors (after all recovery attempts exhausted) still return proper HTTP error responses.
- [ ] `clearTimeout(timeoutId)` is still called in all paths (finally block preserved).
- [ ] Errors thrown from `retrieveTranslationWithFallback` include sufficient context for logging.
- [ ] All content-block categories (`prohibited_content`, `safety_filter`, `content_filter`, `prompt_blocked`) are handled consistently.

### Performance

- [ ] No unnecessary model calls: splitting only occurs after a content-block detection.
- [ ] `maxSplitDepth` prevents runaway recursion.
- [ ] No new `await` points in the hot path for clean content.
- [ ] Memory: split recursion depth is bounded; no large intermediate arrays.
- [ ] Buffered response memory usage is proportional to segment count (bounded).

### Security

- [ ] Error messages exposed to the client do not leak raw provider error details or internal paths.
- [ ] The `classifyTranslationError` function does not log full segment text (which may contain the prohibited content).
- [ ] New config values are validated and bounded.
- [ ] Block reasons logged are the enum values only, not content.

### Compatibility

- [ ] New response headers don't break existing clients (headers are additive).
- [ ] JSON error response includes new `code` field alongside existing `error` and `runId` (additive).
- [ ] New env vars are all optional with sensible defaults.
- [ ] TypeScript types compile cleanly (`npm run build`).
- [ ] ESLint passes (`npm run lint`).

### Observability

- [ ] Every new code path has at least one log statement.
- [ ] All log statements include `runId` and `batchLabel`.
- [ ] Split path logs include `splitDepth`, affected segment IDs, and block reasons.
- [ ] `providerResponseId` from Gemini is included in content-block logs for provider correlation.
- [ ] No sensitive content (subtitle text) is logged at `info` level. Only lengths/counts.
- [ ] Error logs include the classified error category and block reason.
