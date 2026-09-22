const DEFAULT_SPLIT_THRESHOLD = 520;
const DEFAULT_MAX_PARTS = 9;
const DEFAULT_MAX_PART_CHARS = 1000;

export function splitWhatsAppMessage(
  content: string,
  splitThreshold = DEFAULT_SPLIT_THRESHOLD,
  maxParts = DEFAULT_MAX_PARTS,
  maxPartChars = DEFAULT_MAX_PART_CHARS,
): string[] {
  const text = content.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  if (!text) return [text];
  if (maxParts < 1 || maxPartChars < 1 || splitThreshold < 1) {
    throw new Error('Invalid WhatsApp message splitting limits');
  }
  if (text.length <= splitThreshold && text.length <= maxPartChars) {
    return [text];
  }

  const target = Math.min(
    maxPartChars,
    Math.max(splitThreshold, Math.ceil(text.length / maxParts)),
  );
  let parts = packUnits(sentenceUnits(text), target);
  if (parts.length > maxParts) {
    parts = splitLongUnit(text, maxPartChars);
  }

  if (
    parts.length > maxParts ||
    parts.some((part) => part.length > maxPartChars)
  ) {
    throw new Error('WhatsApp message exceeds configured part limits');
  }
  return parts;
}

function sentenceUnits(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).filter(Boolean);
}

function packUnits(units: string[], limit: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const unit of units.flatMap((value) => splitLongUnit(value, limit))) {
    const candidate = current ? `${current} ${unit}` : unit;
    if (current && candidate.length > limit) {
      parts.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function splitLongUnit(value: string, limit: number): string[] {
  if (value.length <= limit) return [value];
  const words = value.split(/\s+/);
  const parts: string[] = [];
  let current = '';
  for (const word of words) {
    if (word.length > limit) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let index = 0; index < word.length; index += limit) {
        parts.push(word.slice(index, index + limit));
      }
      continue;
    }
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
