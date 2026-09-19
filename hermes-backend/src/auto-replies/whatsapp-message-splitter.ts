const DEFAULT_SPLIT_THRESHOLD = 520;
const DEFAULT_MAX_PARTS = 3;

export function splitWhatsAppMessage(
  content: string,
  splitThreshold = DEFAULT_SPLIT_THRESHOLD,
  maxParts = DEFAULT_MAX_PARTS,
): string[] {
  const text = content
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!text || text.length <= splitThreshold || maxParts <= 1) return [text];

  const desiredParts = Math.min(
    maxParts,
    Math.max(2, Math.ceil(text.length / splitThreshold)),
  );
  const units = sentenceUnits(text);
  const parts: string[] = [];
  let cursor = 0;

  for (let partIndex = 0; partIndex < desiredParts; partIndex += 1) {
    const partsLeft = desiredParts - partIndex;
    if (partsLeft === 1) {
      parts.push(units.slice(cursor).join(' ').trim());
      break;
    }

    const remaining = units.slice(cursor).join(' ').length;
    const target = Math.ceil(remaining / partsLeft);
    const maxUnitIndex = units.length - (partsLeft - 1);
    let selected: string[] = [];

    while (cursor < maxUnitIndex) {
      const candidate = [...selected, units[cursor]].join(' ');
      if (selected.length && candidate.length > target * 1.2) break;
      selected.push(units[cursor]);
      cursor += 1;
      if (candidate.length >= target * 0.8) break;
    }
    if (!selected.length) {
      selected = [units[cursor]];
      cursor += 1;
    }
    parts.push(selected.join(' ').trim());
  }

  return parts.filter(Boolean).slice(0, maxParts);
}

function sentenceUnits(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const sentences = paragraphs.flatMap(
    (paragraph) =>
      paragraph
        .match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/gu)
        ?.map((part) => part.trim()) || [paragraph],
  );
  return sentences.flatMap((sentence) => splitLongUnit(sentence, 430));
}

function splitLongUnit(value: string, limit: number): string[] {
  if (value.length <= limit) return [value];
  const words = value.split(/\s+/);
  const parts: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > limit) {
      parts.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}
