const contractions: Record<string, string> = {
  "youre": "you are", "youve": "you have", "youll": "you will",
  "were": "we are", "weve": "we have", "well": "we will",
  "im": "i am", "ive": "i have", "ill": "i will",
  "hes": "he is", "shes": "she is", "its": "it is",
  "dont": "do not", "doesnt": "does not", "didnt": "did not",
  "cant": "cannot", "wont": "will not", "isnt": "is not",
  "arent": "are not", "thats": "that is", "theres": "there is",
};
// Unapostrophized were/well/ill/its are meaningful words; leave them intact.
const ambiguous = new Set(["were", "well", "ill", "its"]);

export function normalizeLyrics(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^\s*\[(?:verse|chorus|bridge|repeat|instrumental|tag|outro)[^\]]*\]\s*$/gim, " ")
    .replace(/[\p{L}]+(?:'[\p{L}]+)?/gu, word => {
      const key = word.replaceAll("'", "");
      return contractions[key] && (word.includes("'") || !ambiguous.has(key)) ? contractions[key]! : word;
    })
    .replace(/\bthru\b/g, "through")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function words(text: string): string[] {
  const normalized = normalizeLyrics(text);
  return normalized ? normalized.split(" ") : [];
}
