/** pg_trgm-style unique, word-padded trigrams; punctuation separates words. */
export function trigrams(value: string): string[] {
  const grams = new Set<string>();
  for (const word of value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    const chars = Array.from(`  ${word} `);
    for (let i = 0; i < chars.length - 2; i++)
      grams.add(chars.slice(i, i + 3).join(""));
  }
  return [...grams].sort();
}
