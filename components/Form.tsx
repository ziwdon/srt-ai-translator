'use client';

import React, { FormEvent, useState } from "react";
import Image from "next/image";

interface Props {
  onSubmit: (content: string, language: string, filename: string) => void;
}
function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(" ");
}

// Limited set of predefined languages in specific order (without sorting)
const PREDEFINED_LANGUAGES = [
  'English',
  'Portuguese (Portugal)', 
  'Spanish (Spain)'
];

// Special value to indicate custom language selection
const CUSTOM_LANGUAGE_OPTION = "custom";

const readFileContents = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const content = e.target?.result as string;
      resolve(content);
    };

    reader.onerror = (e) => {
      reject(e);
    };

    reader.readAsText(file);
  });
};

const SrtForm: React.FC<Props> = ({ onSubmit }) => {
  const [file, setFile] = useState<File>();
  const [selectedOption, setSelectedOption] = useState<string>("");
  const [customLanguage, setCustomLanguage] = useState<string>("");
  const [dragging, setDragging] = useState<boolean>(false);

  // Get the final language value (either selected from dropdown or custom input)
  const getLanguage = () => {
    return selectedOption === CUSTOM_LANGUAGE_OPTION
      ? customLanguage.trim()
      : selectedOption;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const language = getLanguage();
    if (file && language) {
      const content = await readFileContents(file);
      onSubmit(content, language, file.name);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0];

      // Make sure the file extension is ".srt"
      const fileName = droppedFile.name;
      const fileExtension = fileName.split(".").pop()?.toLowerCase();
      if (fileExtension !== "srt") {
        alert("Please upload a .srt file");
        return;
      }

      setFile(droppedFile);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col px-4 mt-6 w-full md:px-0"
    >
      <label
        htmlFor="srt-file"
        className="block font-bold py-4 md:pl-8 text-lg text-[#444444]"
      >
        {file ? "✅" : "👉"} Step 1: Choose your SRT file
      </label>
      <div
        id="srt-file"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`w-full border-2 ${dragging ? "border-blue-300" : "border-transparent"
          } md:rounded-lg bg-[#EFEFEF] px-12 relative`}
      >
        <input
          type="file"
          accept=".srt"
          onChange={(e) => setFile(e.target.files?.[0])}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <div
          className={classNames(
            "grid items-center",
            file ? "md:py-4" : "md:grid-cols-2"
          )}
        >
          {!file && (
            <div className="hidden relative -bottom-8 mx-auto md:block">
              <Image
                src="/fire-chicken.png"
                alt="Chicken on fire"
                width={256}
                height={400}
                priority
              />
            </div>
          )}
          <div>
            <div className="text-center py-4 md:py-0 text-[#444444]">
              {file ? (
                `📂 ${file.name}`
              ) : (
                <>
                  <div className="hidden md:block">
                    <div>Drop it like it&lsquo;s hot</div>
                    <div className="my-3 text-sm">- or -</div>
                  </div>
                  <div className="rounded-sm bg-[#d9d9d9] py-2 px-2">
                    Browse for SRT file&hellip;
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="md:h-6"></div>

      {file && (
        <>
          <div>
            <label
              htmlFor="srt-file"
              className="block font-bold md:pl-8 mt-6 md:mt-2 py-4 text-lg text-[#444444]"
            >
              {getLanguage() ? "✅" : "👉"} Step 2: Select a Target language
            </label>
            <div className="rounded-lg bg-[#fafafa] text-[#444444] py-4 md:py-8 md:px-8 relative md:flex flex-wrap items-center text-center md:text-left">
              <div>Translate this SRT file to</div>
              
              <div className="flex flex-col md:flex-row items-center mt-4 md:mt-0 md:ml-2 w-full md:w-auto">
                <select
                  id="language"
                  value={selectedOption}
                  onChange={(e) => setSelectedOption(e.target.value)}
                  className="px-4 py-2 bg-white rounded-lg border border-gray-300 w-full md:w-auto"
                >
                  <option value="">Choose language&hellip;</option>
                  {PREDEFINED_LANGUAGES.map((lang, i) => (
                    <option key={i} value={lang}>
                      {lang}
                    </option>
                  ))}
                  <option value={CUSTOM_LANGUAGE_OPTION}>Custom language...</option>
                </select>
                
                {/* Show custom language input only when "Custom language..." is selected */}
                {selectedOption === CUSTOM_LANGUAGE_OPTION && (
                  <input
                    type="text"
                    id="customLanguage"
                    value={customLanguage}
                    onChange={(e) => setCustomLanguage(e.target.value)}
                    placeholder="Enter language name..."
                    className="px-4 py-2 mt-2 md:mt-0 md:ml-2 bg-white rounded-lg border border-gray-300 w-full md:w-auto"
                    autoFocus
                  />
                )}
              </div>
            </div>
            <div className="h-2"></div>
          </div>
          <button
            disabled={!file || !getLanguage()}
            className="bg-[#444444] hover:bg-[#3a3a3a] text-white mt-6 font-bold py-2 px-6 rounded-lg disabled:bg-[#eeeeee] disabled:text-[#aaaaaa]"
          >
            Translate {getLanguage() ? `to ${getLanguage()}` : `SRT`} &rarr;
          </button>
        </>
      )}
    </form>
  );
};

export default SrtForm;
