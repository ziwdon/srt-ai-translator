import React, { FC } from "react";
import type { Chunk } from "@/types";

const Timestamp: FC<Chunk & { originalText?: string }> = ({
	index,
	start,
	end,
	text,
	originalText,
}) => {
	const formatTimestamp = (timestamp: string) => {
		const [, minutes = "00", secondsWithMs = "00,000"] = timestamp.split(":");
		const [seconds = "00", ms = "000"] = secondsWithMs.split(",");

		return `${minutes}:${seconds}.${ms[0]}`;
	};

	return (
		<article className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
					<span>{formatTimestamp(start)}</span>
					<span className="text-slate-400">-&gt;</span>
					<span>{formatTimestamp(end)}</span>
				</div>
				<div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-500">
					Segment {index}
				</div>
			</div>

			<div
				className={`mt-3 grid gap-3 ${originalText ? "md:grid-cols-2" : "grid-cols-1"}`}
			>
				{originalText && (
					<div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
						<p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
							Original
						</p>
						<p className="whitespace-pre-wrap text-sm text-slate-600">{originalText}</p>
					</div>
				)}

				<div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3">
					<p className="mb-2 text-xs font-semibold uppercase tracking-wide text-indigo-500">
						Translated
					</p>
					<p className="whitespace-pre-wrap text-sm text-slate-700">{text}</p>
				</div>
			</div>
		</article>
	);
};

export default Timestamp;
