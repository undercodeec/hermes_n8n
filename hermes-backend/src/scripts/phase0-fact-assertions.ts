/** Narrow, deterministic checks for the synthetic user-count fixtures. */
function normalize(text: string): string {
  return text
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/\s+/gu, ' ');
}

const USER_COUNT_NOUN = /\b(?:usuarios?|personas?|accesos?|cuentas?)\b/u;
const QUANTITY_QUESTION = /\b(?:cuantos?|cuantas?|cantidad|numero)\b/u;

export function asksForKnownUserCount(text: string): boolean {
  return text
    .split('?')
    .slice(0, -1)
    .some((part) => {
      const question = normalize(part.split(/[¿.!]/u).at(-1) ?? '');
      return QUANTITY_QUESTION.test(question) && USER_COUNT_NOUN.test(question);
    });
}

export function usesLatestCorrectedUserCount(
  text: string,
  previous: number,
  current: number,
): boolean {
  const value = normalize(text);
  const currentToken = new RegExp(`(?<!\\d)${current}(?!\\d)`, 'u');
  if (!currentToken.test(value)) return false;
  const previousToken = new RegExp(`(?<!\\d)${previous}(?!\\d)`, 'u');
  if (!previousToken.test(value)) return true;
  // An explicit "de 8 a 15" acknowledgement is not a stale current fact.
  const acknowledged = new RegExp(
    `\\b(?:de|antes(?: eran?)?)\\s+${previous}\\b.{0,45}\\b(?:a|ahora|son|seran)\\s+${current}\\b`,
    'u',
  );
  return acknowledged.test(value);
}

const NEXT_TOPIC = {
  integration:
    /\b(?:integraci[oó]n|integraciones|conectar|conexi[oó]n|sistema existente)\b/u,
  workflow: /\b(?:proceso|flujo|operaci[oó]n|tarea|[aá]rea)\b/u,
  next_step: /\b(?:siguiente paso|avanzar|coordinar|propuesta|reuni[oó]n)\b/u,
} as const;

export type NextTopic = keyof typeof NEXT_TOPIC;

export function advancesToUnansweredTopic(
  text: string,
  topics: NextTopic[],
): boolean {
  const value = normalize(text);
  const progress =
    /\?|\b(?:podemos|propongo|sigamos|avanzar|coordinar|preparar|priorizar)\b/u.test(
      value,
    );
  return progress && topics.some((topic) => NEXT_TOPIC[topic].test(value));
}
