export const dynamic = "force-dynamic";

export async function GET() {
	const hasKey = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
	return new Response(
		JSON.stringify({
			ok: hasKey,
			message: hasKey
				? null
				: "Missing GOOGLE_GENERATIVE_AI_API_KEY. Set it in Netlify env or .env.local.",
		}),
		{
			headers: { "Content-Type": "application/json" },
		},
	);
}