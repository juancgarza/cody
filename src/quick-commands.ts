import type { EditorContext, EditorToolName } from "./types.js";

export type QuickCommand = {
  name: EditorToolName;
  arguments: Record<string, unknown>;
  label: string;
};

const NUMBER_WORDS = new Map<string, number>([
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
  ["sixty", 60],
  ["seventy", 70],
  ["eighty", 80],
  ["ninety", 90],
]);

function parseSpokenNumber(input: string): number | undefined {
  const directNumber = Number.parseInt(input, 10);
  if (Number.isFinite(directNumber)) {
    return directNumber;
  }

  const words = input
    .toLowerCase()
    .replaceAll("-", " ")
    .split(/\s+/)
    .filter(Boolean);

  let total = 0;
  let current = 0;
  let sawNumber = false;

  for (const word of words) {
    if (NUMBER_WORDS.has(word)) {
      current += NUMBER_WORDS.get(word) ?? 0;
      sawNumber = true;
    } else if (word === "hundred") {
      current = Math.max(current, 1) * 100;
      sawNumber = true;
    } else {
      return undefined;
    }
  }

  total += current;
  return sawNumber ? total : undefined;
}

export function parseQuickCommand(text: string, context: EditorContext | undefined): QuickCommand | undefined {
  const normalizedText = text.trim().replace(/\s+/g, " ");
  const lowerText = normalizedText.toLowerCase();

  if (/^(stop listening|stop voice(?: mode)?|end voice session)$/.test(lowerText)) {
    return {
      name: "cody_stop_voice_session",
      arguments: {},
      label: "stop voice",
    };
  }

  const lineMatch = lowerText.match(/^(?:go to |jump to |goto |go )?line\s+(.+)$/);
  if (lineMatch) {
    const line = parseSpokenNumber(lineMatch[1]);
    if (line && line > 0) {
      return {
        name: "editor_go_to_line",
        arguments: { line },
        label: `line ${line}`,
      };
    }
  }

  const fileMatch = normalizedText.match(/^(?:go to file|open file|edit file|open)\s+(.+)$/i);
  if (fileMatch) {
    return {
      name: "editor_go_to_file",
      arguments: { path: fileMatch[1].trim() },
      label: fileMatch[1].trim(),
    };
  }

  const replaceLineMatch = normalizedText.match(
    /^(?:edit|change|replace)\s+(?:this\s+)?line\s+(?:to|with)\s+([\s\S]+)$/i,
  );
  if (replaceLineMatch) {
    return {
      name: "editor_replace_line",
      arguments: {
        line: context?.cursor.line,
        text: replaceLineMatch[1],
      },
      label: "current line",
    };
  }

  return undefined;
}
