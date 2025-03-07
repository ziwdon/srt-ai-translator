![SRT AI Translator - Preview](/preview.png)

# SRT AI Translator

Translate SRT files to any language, using AI magic ✨

Say goodbye to subpar auto-generated captions and elevate the user experience with high-quality translations! 🎉

> **Disclaimer:** This is originally a fork of [yazinsai/srt-ai](https://github.com/yazinsai/srt-ai).<br>
> This version highlights three main selectable languages: English, Spanish (Spain), and Portuguese (Portugal).<br>
> It also includes a custom field where users can manually enter any other language for translation.<br>
> Additionally, the AI prompt has been improved to ensure consistent person and register across translations.

## Overview

SRT AI Translator leverages the power of AI to provide accurate and natural-sounding translations for SRT subtitle files in any language. This easy-to-use tool ensures that viewers can enjoy video content without the frustration of poorly-translated captions.

## Getting Started

Follow these simple steps to set up SRT AI Translator and start enjoying better translations:

### Prerequisites

- A Gemini AI Key (grab it [here](https://aistudio.google.com/), if you don't have one already)
  - You can use Gemini API Free Tier (see [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits#free-tier)).
- Node.js and npm installed on your machine

### Installation

1. Clone the repo `git clone https://github.com/ziwdon/srt-ai-translator.git`
2. Rename `.env.example` to `.env.local` and paste your API Key.
3. Install dependencies using `npm install`
4. Start locally using `npm run dev`

You should now be able to access the repo at [`http://localhost:3000/`](http://localhost:3000/) in your browser.