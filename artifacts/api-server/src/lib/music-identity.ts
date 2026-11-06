function stripTitleDecorations(value: string): string {
  let title = value
    .replace(/^(?:play|stream|listen to)\s+/i, "")
    .trim();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cleaned = title
      .replace(/\s*[\[(]\s*(?:official\b[^)\]]*|(?:music\s+)?(?:audio|video|lyrics|visualizer|topic)\b[^)\]]*)[\])]\s*$/i, "")
      .replace(/\s*[-–]\s*(?:official\s+(?:audio|video)|(?:music\s+)?(?:audio|video|lyrics|visualizer|topic))\s*$/i, "")
      .replace(/\s+[\[(]?\s*(?:feat(?:uring)?\.?|ft\.?)\s+[^)\]]+[\])]?\s*$/i, "")
      .trim();
    if (cleaned === title) break;
    title = cleaned;
  }

  return title;
}

function normalizeIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function matchesMusicTitle(expected: string, actual: string): boolean {
  const expectedTitle = normalizeIdentity(stripTitleDecorations(expected));
  const actualTitle = normalizeIdentity(stripTitleDecorations(actual));
  return Boolean(expectedTitle && actualTitle && expectedTitle === actualTitle);
}

function artistCredits(value: string): string[] {
  return value
    .replace(/\b(?:feat(?:uring)?|ft\.?|with|and)\b/gi, ",")
    .split(/[,;/&+]|\bx\b/gi)
    .map(normalizeIdentity)
    .filter(Boolean);
}

export function matchesMusicArtist(expected: string, actual: string): boolean {
  const expectedCredits = artistCredits(expected);
  const actualCredits = artistCredits(actual);
  return expectedCredits.some((expectedCredit) => actualCredits.includes(expectedCredit));
}
