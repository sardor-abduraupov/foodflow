// Wikimedia fallback service focused on strict product-image relevance.
// Wrong image is worse than no image, so unmatched results are rejected.

const PHRASE_EQUIVALENTS: Record<string, string> = {
  'whole milk': 'milk',
  'cow milk': 'milk',
  'fresh milk': 'milk',
  'almond milk': 'milk',
  'oat milk': 'milk',
  'goat milk': 'milk',
  'коровье молоко': 'milk',
  'цельное молоко': 'milk',
  'sut': 'milk',
  'red apple': 'apple',
  'green apple': 'apple',
};

const TOKEN_EQUIVALENTS: Record<string, string> = {
  milk: 'milk',
  milks: 'milk',
  молоко: 'milk',
  sut: 'milk',
  leche: 'milk',
  lait: 'milk',

  apple: 'apple',
  apples: 'apple',
  яблоко: 'apple',
  olma: 'apple',

  banana: 'banana',
  bananas: 'banana',
  bananu: 'banana',
  bananlar: 'banana',
  banan: 'banana',
  банан: 'banana',
  бананы: 'banana',
  platano: 'banana',

  egg: 'egg',
  eggs: 'egg',
  яйцо: 'egg',

  potato: 'potato',
  potatoes: 'potato',
  картофель: 'potato',
  картошка: 'potato',

  tomato: 'tomato',
  tomatoes: 'tomato',
  помидор: 'tomato',
  томат: 'tomato',

  bread: 'bread',
  хлеб: 'bread',

  chicken: 'chicken',
  курица: 'chicken',

  rice: 'rice',
  рис: 'rice',
  guruch: 'rice',
};

const ADJECTIVE_STOP_WORDS = new Set([
  'fresh',
  'organic',
  'cheap',
  'premium',
  'small',
  'medium',
  'large',
  'raw',
  'frozen',
  'canned',
  'dried',
  'sweet',
  'sour',
  'hot',
  'spicy',
  'brand',
  'item',
  'food',
  'grocery',
]);

const KNOWN_CANONICAL_KEYWORDS = new Set<string>([
  ...Object.values(PHRASE_EQUIVALENTS),
  ...Object.values(TOKEN_EQUIVALENTS),
]);

const NEUTRAL_PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" fill="#E5E7EB"/>' +
  '<rect x="96" y="128" width="320" height="256" rx="24" fill="#CBD5E1"/>' +
  '<circle cx="196" cy="220" r="34" fill="#94A3B8"/>' +
  '<path d="M132 336l76-76 60 60 48-48 64 64H132z" fill="#64748B"/>' +
  '<text x="256" y="440" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" fill="#475569">No Image</text>' +
  '</svg>';

export const NEUTRAL_PLACEHOLDER_IMAGE_URL = `data:image/svg+xml;utf8,${encodeURIComponent(NEUTRAL_PLACEHOLDER_SVG)}`;

const normalizeText = (text: string): string => {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const singularize = (token: string): string => {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 2 && token.endsWith('s')) return token.slice(0, -1);
  return token;
};

const tokenize = (text: string): string[] => {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  return normalized
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length > 1 && !ADJECTIVE_STOP_WORDS.has(token));
};

const getPhraseMatch = (text: string): string | null => {
  const entries = Object.entries(PHRASE_EQUIVALENTS).sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, canonical] of entries) {
    const pattern = new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(text)) {
      return canonical;
    }
  }
  return null;
};

export const normalizeFoodInput = (text: string): string => {
  const normalized = normalizeText(text);
  if (!normalized) return 'food';

  const phraseMatch = getPhraseMatch(normalized);
  if (phraseMatch) return phraseMatch;

  const tokens = tokenize(normalized);
  if (tokens.length === 0) return 'food';

  const canonicalTokens = tokens.map(token => {
    const direct = TOKEN_EQUIVALENTS[token];
    if (direct) return direct;

    const singular = singularize(token);
    const singularMapped = TOKEN_EQUIVALENTS[singular];
    if (singularMapped) return singularMapped;

    return singular;
  });

  const known = canonicalTokens.find(token => KNOWN_CANONICAL_KEYWORDS.has(token));
  return known || canonicalTokens[0] || 'food';
};

interface WikimediaImageInfo {
  url?: string;
  width?: number;
  height?: number;
  mime?: string;
}

interface WikimediaPage {
  title?: string;
  imageinfo?: WikimediaImageInfo[];
}

interface WikimediaResponse {
  query?: {
    pages?: Record<string, WikimediaPage>;
  };
}

interface WikipediaPageImageInfo {
  source?: string;
  width?: number;
  height?: number;
}

interface WikipediaPage {
  title?: string;
  thumbnail?: WikipediaPageImageInfo;
  original?: WikipediaPageImageInfo;
}

interface WikipediaResponse {
  query?: {
    pages?: Record<string, WikipediaPage>;
  };
}

const logMismatch = (payload: {
  input: string;
  normalizedKeyword: string;
  selectedImageSource: string;
  rejectionReason: string;
  metadataTitle?: string;
}) => {
  console.warn('[ImageMismatch]', payload);
};

const titleHasKeyword = (title: string, keyword: string): boolean => {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle || !keyword) return false;

  const titleTokens = normalizedTitle.split(' ').filter(Boolean);
  if (titleTokens.some(token => token === keyword || token.startsWith(keyword))) {
    return true;
  }

  const escaped = keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizedTitle);
};

const NON_PHOTO_HINTS = [
  'icon',
  'logo',
  'symbol',
  'diagram',
  'illustration',
  'clipart',
  'drawing',
  'vector',
  'coat of arms',
  'flag',
  'map',
];

const WIKIPEDIA_TOPIC_BY_KEYWORD: Record<string, string> = {
  milk: 'Milk',
  apple: 'Apple',
  banana: 'Banana',
  egg: 'Eggs as food',
  bread: 'Bread',
  rice: 'Rice',
  tomato: 'Tomato',
  potato: 'Potato',
  chicken: 'Chicken as food',
};

const scoreCandidate = (page: WikimediaPage, keyword: string): number => {
  const title = page.title || '';
  const normalizedTitle = normalizeText(title);
  const info = page.imageinfo?.[0];
  const width = typeof info?.width === 'number' ? info.width : 0;
  const height = typeof info?.height === 'number' ? info.height : 0;
  const area = width * height;
  const mime = (info?.mime || '').toLowerCase();

  let score = 0;
  if (normalizedTitle === keyword) score += 12;
  if (normalizedTitle.startsWith(`${keyword} `) || normalizedTitle.endsWith(` ${keyword}`)) score += 4;

  if (area > 0) {
    score += Math.min(Math.log10(area), 7);
  }

  if (mime === 'image/jpeg' || mime === 'image/webp') score += 3;
  else if (mime === 'image/png') score += 1;

  if (NON_PHOTO_HINTS.some(term => normalizedTitle.includes(term))) {
    score -= 8;
  }

  return score;
};

const fetchWikipediaLeadImage = async (keyword: string): Promise<string | null> => {
  const preferredTitle = WIKIPEDIA_TOPIC_BY_KEYWORD[keyword];
  const titleQuery = preferredTitle || keyword;
  const url =
    'https://en.wikipedia.org/w/api.php?' +
    new URLSearchParams({
      action: 'query',
      format: 'json',
      redirects: '1',
      prop: 'pageimages|info',
      piprop: 'original|thumbnail|name',
      pithumbsize: '1200',
      inprop: 'url',
      titles: titleQuery,
      origin: '*',
    }).toString();

  const response = await fetch(url);
  if (!response.ok) return null;

  const payload = (await response.json()) as WikipediaResponse;
  const pages = payload.query?.pages ? Object.values(payload.query.pages) : [];
  for (const page of pages) {
    const title = page.title || '';
    const imageUrl = page.original?.source || page.thumbnail?.source || '';
    if (!title || !imageUrl) continue;
    if (!preferredTitle && !titleHasKeyword(title, keyword)) {
      continue;
    }
    if (/\.svg(\?|$)/i.test(imageUrl)) {
      continue;
    }
    return imageUrl;
  }

  return null;
};

const extractWikimediaTitleFromUrl = (source: string): string | null => {
  try {
    const parsed = new URL(source);
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.includes('wikimedia.org')) return null;
    const filename = parsed.pathname.split('/').pop();
    if (!filename) return null;
    return decodeURIComponent(filename).replace(/_/g, ' ');
  } catch {
    return null;
  }
};

export const isImageSourceRelevantToKeyword = (source: string, rawQuery: string): boolean => {
  if (!source) return false;
  if (source.startsWith('data:')) return true;

  const keyword = normalizeFoodInput(rawQuery);
  if (!keyword || keyword === 'food') return true;

  const wikimediaTitle = extractWikimediaTitleFromUrl(source);
  if (!wikimediaTitle) return true;
  return titleHasKeyword(wikimediaTitle, keyword);
};

const fetchWikimediaPages = async (keyword: string, offset: number): Promise<WikimediaPage[]> => {
  const url =
    'https://commons.wikimedia.org/w/api.php?' +
    new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrnamespace: '6',
      gsrlimit: '12',
      gsroffset: String(offset),
      // Requirement: use normalized keyword as the ONLY image retrieval query.
      gsrsearch: `file:${keyword}`,
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      format: 'json',
      origin: '*',
    }).toString();

  const response = await fetch(url);
  if (!response.ok) return [];

  const payload = (await response.json()) as WikimediaResponse;
  return payload.query?.pages ? Object.values(payload.query.pages) : [];
};

export const getWikimediaImage = async (rawQuery: string): Promise<string | null> => {
  const normalizedKeyword = normalizeFoodInput(rawQuery);
  if (!normalizedKeyword || normalizedKeyword === 'food') {
    logMismatch({
      input: rawQuery,
      normalizedKeyword,
      selectedImageSource: 'none',
      rejectionReason: 'normalized_keyword_unusable',
    });
    return null;
  }

  const offsets = [0, 12, 24];

  try {
    // Prefer article lead image from regular Wikipedia for clearer, more recognizable visuals.
    const wikipediaLeadImage = await fetchWikipediaLeadImage(normalizedKeyword);
    if (wikipediaLeadImage) {
      return wikipediaLeadImage;
    }

    let bestImageUrl: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const offset of offsets) {
      const pages = await fetchWikimediaPages(normalizedKeyword, offset);
      for (const page of pages) {
        const imageUrl = page.imageinfo?.[0]?.url;
        const title = page.title || '';

        if (!imageUrl) {
          logMismatch({
            input: rawQuery,
            normalizedKeyword,
            selectedImageSource: 'missing_url',
            rejectionReason: 'missing_image_url',
            metadataTitle: title,
          });
          continue;
        }

        if (!titleHasKeyword(title, normalizedKeyword)) {
          logMismatch({
            input: rawQuery,
            normalizedKeyword,
            selectedImageSource: imageUrl,
            rejectionReason: 'title_does_not_contain_keyword',
            metadataTitle: title,
          });
          continue;
        }

        const candidateScore = scoreCandidate(page, normalizedKeyword);
        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          bestImageUrl = imageUrl;
        }
      }
    }

    if (bestImageUrl) {
      return bestImageUrl;
    }
  } catch {
    logMismatch({
      input: rawQuery,
      normalizedKeyword,
      selectedImageSource: 'none',
      rejectionReason: 'wikimedia_request_failed',
    });
    return null;
  }

  logMismatch({
    input: rawQuery,
    normalizedKeyword,
    selectedImageSource: NEUTRAL_PLACEHOLDER_IMAGE_URL,
    rejectionReason: 'no_verified_match_found',
  });
  return null;
};
