import React, { FC } from "react";
import "tailwindcss/tailwind.css";
import type { Chunk } from "@/types";

const Timestamp: FC<Chunk & { originalText?: string }> = ({
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
		<div className="flex">
			<div className="flex flex-col items-center">
				<div className="flex items-center mb-1">
					<span className="text-xl">⏲</span>
					<p className="ml-2 text-gray-400">{formatTimestamp(start)}</p>
				</div>
				<div className="flex items-center">
					<span className="text-xl">⏲</span>
					<p className="ml-2 text-gray-400">{formatTimestamp(end)}</p>
				</div>
			</div>
			<div className="flex-grow flex gap-4 ml-4">
				{originalText && (
					<textarea
						className="flex-grow h-full bg-gray-100 p-2 rounded-lg text-gray-500"
						value={originalText}
						readOnly
					/>
				)}
				<textarea
					className="flex-grow h-full bg-gray-200 p-2 rounded-lg"
					value={text}
					readOnly
				/>
			</div>
		</div>
	);
};

export default Timestamp;
