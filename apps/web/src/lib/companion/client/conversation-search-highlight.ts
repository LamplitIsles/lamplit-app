export interface HighlightPart {
  text: string;
  matched: boolean;
}

/** Highlight a literal query inside the expanded source text. */
export function textParts(value: string, query: string): HighlightPart[] {
  if (!query) return [{ text: value, matched: false }];
  const haystack = value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const result: HighlightPart[] = [];
  let offset = 0;
  while (result.length < 200) {
    const at = haystack.indexOf(needle, offset);
    if (at < 0) break;
    if (at > offset)
      result.push({ text: value.slice(offset, at), matched: false });
    result.push({ text: value.slice(at, at + query.length), matched: true });
    offset = at + query.length;
  }
  if (offset < value.length)
    result.push({ text: value.slice(offset), matched: false });
  return result;
}

export function contextTargetIndex(
  targetSourceRecordIndex: number,
  items: Array<{ sourceRecordIndex: number }>,
): number {
  return items.findIndex(
    (item) => item.sourceRecordIndex === targetSourceRecordIndex,
  );
}
