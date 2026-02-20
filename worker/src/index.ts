import { generateAIResponse } from './ai/gateway';
import { AIProviderError } from './ai/types';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

interface D1LikeDatabase {
  prepare(query: string): D1PreparedStatement;
}

interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_TIMEOUT_MS?: string;
  GEMINI_USAGE_MODE?: string;
  GEMINI_MAX_REQUESTS_PER_MINUTE?: string;
  GEMINI_MAX_CONCURRENT?: string;
  GEMINI_RATE_LIMIT_COOLDOWN_MS?: string;
  HUGGINGFACE_API_KEY?: string;
  HUGGINGFACE_TEXT_MODEL?: string;
  HUGGINGFACE_IMAGE_MODEL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_STORAGE_BUCKET?: string;
  ALLOWED_ORIGIN?: string;
  SYNC_DEBUG_LOGS?: string;
  DB?: D1LikeDatabase;
}

type JsonRecord = Record<string, unknown>;

type HouseRole = 'owner' | 'member';

class HttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const HOUSE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const categoryEnum = ['Produce', 'Fruits', 'Dairy', 'Meat', 'Pantry', 'Beverages', 'Frozen', 'Other'] as const;
type Category = (typeof categoryEnum)[number];
const GEMINI_PRIMARY_MODEL = 'gemini-3-pro-preview';
const GEMINI_MODEL_FALLBACKS = ['gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];
const SUPABASE_DEFAULT_BUCKET = 'food-images';

const cleanJson = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.startsWith('```json')) {
    return trimmed.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  }
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return trimmed;
};

const statusFromAIError = (error: AIProviderError): number => {
  switch (error.code) {
    case 'invalid_input':
    case 'schema_error':
      return 400;
    case 'authentication':
      return 500;
    case 'timeout':
    case 'rate_limited':
    case 'quota_exceeded':
    case 'server_error':
    case 'network_error':
    case 'provider_unavailable':
      return 503;
    default:
      return 500;
  }
};

const corsHeaders = (origin: string | null, env: Env): HeadersInit => {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const allowOrigin = allowed === '*' ? '*' : origin || allowed;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    Vary: 'Origin',
  };
};

const json = (data: unknown, status: number, origin: string | null, env: Env): Response => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, env),
    },
  });
};

const readJson = async (request: Request): Promise<JsonRecord> => {
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === 'object') {
      return parsed as JsonRecord;
    }
    return {};
  } catch {
    return {};
  }
};

const ensureDb = (env: Env): D1LikeDatabase => {
  if (!env.DB) {
    throw new HttpError(500, 'Cloud database is not configured. Attach D1 binding "DB" in wrangler.toml.');
  }
  return env.DB;
};

const toStringOrEmpty = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const toNumberOrDefault = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const encodeStoragePath = (path: string): string => {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
};

const sanitizeStorageKey = (value: string): string => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
  return cleaned || 'food';
};

const mimeTypeToExtension = (mimeType: string): string => {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
  };
  return known[mimeType] || 'jpg';
};

const guessMimeTypeFromUrl = (url: string): string => {
  const lower = url.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
};

const normalizeCategory = (value: unknown): Category => {
  if (typeof value === 'string' && (categoryEnum as readonly string[]).includes(value)) {
    return value as Category;
  }
  return 'Other';
};

const normalizeHouseState = (value: unknown, fallbackHouseName: string): JsonRecord => {
  const source = value && typeof value === 'object' ? (value as JsonRecord) : {};
  const name = toStringOrEmpty(source.houseName) || fallbackHouseName;
  const currency = toStringOrEmpty(source.currency) || '$';

  return {
    inventory: Array.isArray(source.inventory) ? source.inventory : [],
    shoppingList: Array.isArray(source.shoppingList) ? source.shoppingList : [],
    recipes: Array.isArray(source.recipes) ? source.recipes : [],
    expenses: Array.isArray(source.expenses) ? source.expenses : [],
    updatedAt: toNumberOrDefault(source.updatedAt, Date.now()),
    houseName: name,
    currency,
  };
};

const shouldLogSyncDebug = (env: Env): boolean => {
  return toStringOrEmpty(env.SYNC_DEBUG_LOGS).toLowerCase() === 'true';
};

const summarizeStateForLog = (state: JsonRecord): JsonRecord => {
  const inventory = Array.isArray(state.inventory) ? state.inventory : [];
  const recipes = Array.isArray(state.recipes) ? state.recipes : [];
  const shoppingList = Array.isArray(state.shoppingList) ? state.shoppingList : [];
  const expenses = Array.isArray(state.expenses) ? state.expenses : [];

  const inventoryHead = inventory
    .slice(0, 5)
    .map(entry => {
      const item = entry && typeof entry === 'object' ? (entry as JsonRecord) : {};
      return {
        id: toStringOrEmpty(item.id),
        name: toStringOrEmpty(item.name),
        imageUrl: toStringOrEmpty(item.imageUrl),
      };
    });

  return {
    updatedAt: toNumberOrDefault(state.updatedAt, 0),
    inventoryCount: inventory.length,
    shoppingCount: shoppingList.length,
    recipeCount: recipes.length,
    expenseCount: expenses.length,
    inventoryHead,
  };
};

const logSyncEvent = (env: Env, event: string, payload: JsonRecord): void => {
  if (!shouldLogSyncDebug(env)) return;
  console.log(JSON.stringify({ event, ...payload }));
};

const parseStoredState = (payload: string, houseName: string, updatedAt: number): JsonRecord => {
  try {
    const parsed = JSON.parse(payload) as unknown;
    const normalized = normalizeHouseState(parsed, houseName);
    normalized.updatedAt = updatedAt;
    normalized.houseName = houseName;
    if (!toStringOrEmpty(normalized.currency)) {
      normalized.currency = '$';
    }
    return normalized;
  } catch {
    return normalizeHouseState({}, houseName);
  }
};

const randomHouseCode = (): string => {
  let value = '';
  for (let i = 0; i < 6; i += 1) {
    const index = Math.floor(Math.random() * HOUSE_CODE_ALPHABET.length);
    value += HOUSE_CODE_ALPHABET[index];
  }
  return value;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
};

const createSalt = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
};

const createPasswordHash = async (password: string): Promise<string> => {
  const salt = createSalt();
  const digest = await sha256Hex(`${salt}:${password}`);
  return `${salt}:${digest}`;
};

const verifyPasswordHash = async (password: string, storedHash: string): Promise<boolean> => {
  if (!storedHash) return false;
  if (storedHash.includes(':')) {
    const [salt, digest] = storedHash.split(':');
    if (!salt || !digest) return false;
    const computed = await sha256Hex(`${salt}:${password}`);
    return computed === digest;
  }

  // Backward compatibility for legacy unsalted hashes.
  const legacy = await sha256Hex(password);
  return legacy === storedHash;
};

const generateSessionToken = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
};

const generateUniqueHouseCode = async (db: D1LikeDatabase): Promise<string> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = randomHouseCode();
    const existing = await db
      .prepare('SELECT id FROM houses WHERE id = ? LIMIT 1')
      .bind(candidate)
      .first<{ id: string }>();

    if (!existing) {
      return candidate;
    }
  }

  throw new HttpError(500, 'Unable to allocate house code. Please try again.');
};

let authSchemaReady = false;
let imageCacheSchemaReady = false;

const ensureImageCacheSchema = async (db: D1LikeDatabase): Promise<void> => {
  if (imageCacheSchemaReady) return;

  const ddlStatements = [
    [
      'CREATE TABLE IF NOT EXISTS product_image_cache (',
      'canonical_key TEXT PRIMARY KEY,',
      'image_url TEXT NOT NULL,',
      'source TEXT NOT NULL,',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL',
      ')',
    ].join(' '),
    'CREATE INDEX IF NOT EXISTS idx_product_image_cache_updated ON product_image_cache(updated_at DESC)',
  ];

  for (const sql of ddlStatements) {
    await db.prepare(sql).run();
  }

  imageCacheSchemaReady = true;
};

const ensureAuthSchema = async (db: D1LikeDatabase): Promise<void> => {
  if (authSchemaReady) return;

  const ddlStatements = [
    [
      'CREATE TABLE IF NOT EXISTS users (',
      'username TEXT PRIMARY KEY,',
      'display_name TEXT NOT NULL,',
      'password_hash TEXT NOT NULL,',
      'created_at INTEGER NOT NULL,',
      'updated_at INTEGER NOT NULL',
      ')',
    ].join(' '),
    [
      'CREATE TABLE IF NOT EXISTS house_members (',
      'house_id TEXT NOT NULL,',
      'username TEXT NOT NULL,',
      "role TEXT NOT NULL CHECK (role IN ('owner', 'member')),",
      'joined_at INTEGER NOT NULL,',
      'PRIMARY KEY (house_id, username)',
      ')',
    ].join(' '),
    [
      'CREATE TABLE IF NOT EXISTS user_sessions (',
      'token_hash TEXT PRIMARY KEY,',
      'username TEXT NOT NULL,',
      'created_at INTEGER NOT NULL,',
      'expires_at INTEGER NOT NULL,',
      'revoked_at INTEGER',
      ')',
    ].join(' '),
    [
      'CREATE TABLE IF NOT EXISTS house_activity (',
      'id INTEGER PRIMARY KEY AUTOINCREMENT,',
      'house_id TEXT NOT NULL,',
      'actor_username TEXT NOT NULL,',
      'action TEXT NOT NULL,',
      'metadata TEXT,',
      'created_at INTEGER NOT NULL',
      ')',
    ].join(' '),
    'CREATE INDEX IF NOT EXISTS idx_house_members_username ON house_members(username)',
    'CREATE INDEX IF NOT EXISTS idx_house_members_house ON house_members(house_id)',
    'CREATE INDEX IF NOT EXISTS idx_user_sessions_username ON user_sessions(username)',
    'CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_house_activity_house_created ON house_activity(house_id, created_at DESC)',
  ];

  for (const sql of ddlStatements) {
    await db.prepare(sql).run();
  }

  authSchemaReady = true;
};

const tokenize = (value: string): string[] => {
  const cleaned = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];

  const stopWords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'for',
    'with',
    'fresh',
    'organic',
    'recipe',
    'item',
    'food',
  ]);

  return cleaned
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length > 1 && !stopWords.has(token));
};

const semanticScore = (query: string, candidate: string): number => {
  const queryTokens = tokenize(query);
  const candidateTokens = tokenize(candidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  const candidateSet = new Set(candidateTokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (candidateSet.has(token)) matches += 1;
    else if (candidateTokens.some(candidateToken => candidateToken.includes(token) || token.includes(candidateToken))) {
      matches += 0.5;
    }
  }

  return matches / queryTokens.length;
};

const extractJson = (text: string): unknown => {
  const candidate = cleanJson(text);

  try {
    return JSON.parse(candidate);
  } catch {
    // Continue with bracket probing.
  }

  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    const objectSlice = candidate.slice(objectStart, objectEnd + 1);
    try {
      return JSON.parse(objectSlice);
    } catch {
      // Continue.
    }
  }

  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const arraySlice = candidate.slice(arrayStart, arrayEnd + 1);
    return JSON.parse(arraySlice);
  }

  throw new Error('AI returned invalid JSON');
};

const aiJson = async (
  env: Env,
  prompt: string,
  options: {
    model?: string;
    modelFallbacks?: string[];
    maxTokens?: number;
    timeoutMs?: number;
    allowFallback?: boolean;
    parts?: unknown[];
  }
): Promise<unknown> => {
  const response = await generateAIResponse(prompt, {
    task: 'json',
    geminiModel: options.model || GEMINI_PRIMARY_MODEL,
    geminiModelFallbacks: options.modelFallbacks || GEMINI_MODEL_FALLBACKS,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    allowFallback: options.allowFallback,
    parts: (options.parts as never[]) || [],
  }, env);

  return extractJson(response.text);
};

const aiJsonOrDefault = async (
  env: Env,
  prompt: string,
  options: {
    model?: string;
    modelFallbacks?: string[];
    maxTokens?: number;
    timeoutMs?: number;
    allowFallback?: boolean;
    parts?: unknown[];
  },
  fallbackValue: unknown
): Promise<unknown> => {
  try {
    return await aiJson(env, prompt, options);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'ai_json_fallback_value',
        reason: error instanceof Error ? error.message : 'unknown',
      })
    );
    return fallbackValue;
  }
};

const PRODUCT_PHRASE_EQUIVALENTS: Record<string, string> = {
  'whole milk': 'milk',
  'cow milk': 'milk',
  'fresh milk': 'milk',
  'almond milk': 'milk',
  'oat milk': 'milk',
  'goat milk': 'milk',
  'коровье молоко': 'milk',
  'цельное молоко': 'milk',
  sut: 'milk',
  'red apple': 'apple',
  'green apple': 'apple',
};

const PRODUCT_TOKEN_EQUIVALENTS: Record<string, string> = {
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
  banane: 'banana',
  banan: 'banana',
  bananu: 'banana',
  bananlar: 'banana',
  platano: 'banana',
  банан: 'banana',
  бананы: 'banana',

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

const PRODUCT_ADJECTIVE_WORDS = new Set([
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

const KNOWN_PRODUCT_KEYWORDS = new Set<string>([
  ...Object.values(PRODUCT_PHRASE_EQUIVALENTS),
  ...Object.values(PRODUCT_TOKEN_EQUIVALENTS),
]);

const normalizeProductText = (text: string): string => {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const singularizeToken = (token: string): string => {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 2 && token.endsWith('s')) return token.slice(0, -1);
  return token;
};

const tokenizeProduct = (text: string): string[] => {
  const normalized = normalizeProductText(text);
  if (!normalized) return [];

  return normalized
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length > 1 && !PRODUCT_ADJECTIVE_WORDS.has(token));
};

const phraseMatchProduct = (text: string): string | null => {
  const entries = Object.entries(PRODUCT_PHRASE_EQUIVALENTS).sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, canonical] of entries) {
    const escaped = phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      return canonical;
    }
  }
  return null;
};

const normalizeFoodTerm = (rawQuery: string): string => {
  const normalized = normalizeProductText(rawQuery);
  if (!normalized) return 'food';

  const phraseMatch = phraseMatchProduct(normalized);
  if (phraseMatch) return phraseMatch;

  const tokens = tokenizeProduct(normalized);
  if (tokens.length === 0) return 'food';

  const canonicalTokens = tokens.map(token => {
    const direct = PRODUCT_TOKEN_EQUIVALENTS[token];
    if (direct) return direct;

    const singular = singularizeToken(token);
    const mapped = PRODUCT_TOKEN_EQUIVALENTS[singular];
    if (mapped) return mapped;
    return singular;
  });

  const known = canonicalTokens.find(token => KNOWN_PRODUCT_KEYWORDS.has(token));
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

const NEUTRAL_PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" fill="#E5E7EB"/>' +
  '<rect x="96" y="128" width="320" height="256" rx="24" fill="#CBD5E1"/>' +
  '<circle cx="196" cy="220" r="34" fill="#94A3B8"/>' +
  '<path d="M132 336l76-76 60 60 48-48 64 64H132z" fill="#64748B"/>' +
  '<text x="256" y="440" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" fill="#475569">No Image</text>' +
  '</svg>';

const DEFAULT_FALLBACK_IMAGE_URL = `data:image/svg+xml;utf8,${encodeURIComponent(NEUTRAL_PLACEHOLDER_SVG)}`;

const isNeutralPlaceholderImage = (source: string): boolean => {
  if (!source) return false;
  if (source === DEFAULT_FALLBACK_IMAGE_URL) return true;
  return source.startsWith('data:image/svg+xml') && source.includes('No%20Image');
};

const logImageMismatch = (payload: {
  input: string;
  normalizedKeyword: string;
  selectedImageSource: string;
  rejectionReason: string;
  metadataTitle?: string;
}) => {
  console.log(JSON.stringify({ event: 'image_mismatch', ...payload }));
};

const titleMatchesKeyword = (title: string, keyword: string): boolean => {
  const normalizedTitle = normalizeProductText(title);
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

const WIKIMEDIA_DIRECT_IMAGE_BY_KEYWORD: Record<string, string> = {
  banana: 'https://upload.wikimedia.org/wikipedia/commons/4/44/Bananas_white_background_DS.jpg',
  milk: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Glass_of_Milk_%2833657535532%29.jpg/1566px-Glass_of_Milk_%2833657535532%29.jpg',
  apple: 'https://upload.wikimedia.org/wikipedia/commons/a/a6/Pink_lady_and_cross_section.jpg',
  bread: 'https://upload.wikimedia.org/wikipedia/commons/c/c7/Korb_mit_Br%C3%B6tchen.JPG',
  egg: 'https://upload.wikimedia.org/wikipedia/commons/3/3f/Huevo_frito.jpg',
  rice: 'https://upload.wikimedia.org/wikipedia/commons/0/0a/20201102.Hengnan.Hybrid_rice_Sanyou-1.6.jpg',
  tomato: 'https://upload.wikimedia.org/wikipedia/commons/8/89/Tomato_je.jpg',
  potato: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Patates.jpg',
  chicken: 'https://upload.wikimedia.org/wikipedia/commons/5/57/Chickens_in_market.jpg',
};

const scoreWikimediaCandidate = (page: WikimediaPage, keyword: string): number => {
  const title = page.title || '';
  const normalizedTitle = normalizeProductText(title);
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
  if (!response.ok) {
    response.body?.cancel();
    return null;
  }

  const payload = (await response.json()) as WikipediaResponse;
  const pages = payload.query?.pages ? Object.values(payload.query.pages) : [];
  for (const page of pages) {
    const title = page.title || '';
    const imageUrl = page.original?.source || page.thumbnail?.source || '';
    if (!title || !imageUrl) continue;
    if (!preferredTitle && !titleMatchesKeyword(title, keyword)) {
      continue;
    }
    if (/\.svg(\?|$)/i.test(imageUrl)) {
      continue;
    }
    return imageUrl;
  }

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titleQuery)}`;
  const summaryResponse = await fetch(summaryUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!summaryResponse.ok) {
    summaryResponse.body?.cancel();
    return null;
  }

  const summary = (await summaryResponse.json()) as {
    title?: string;
    thumbnail?: { source?: string };
    originalimage?: { source?: string };
  };
  const summaryTitle = summary.title || titleQuery;
  const summaryImage = summary.originalimage?.source || summary.thumbnail?.source || '';
  if (!summaryImage) return null;
  if (!preferredTitle && !titleMatchesKeyword(summaryTitle, keyword)) return null;
  if (/\.svg(\?|$)/i.test(summaryImage)) return null;
  return summaryImage;
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
      // Requirement: normalized product keyword is the only retrieval query.
      gsrsearch: `file:${keyword}`,
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      format: 'json',
      origin: '*',
    }).toString();

  const response = await fetch(url);
  if (!response.ok) {
    response.body?.cancel();
    return [];
  }

  const payload = (await response.json()) as WikimediaResponse;
  return payload.query?.pages ? Object.values(payload.query.pages) : [];
};

const getWikimediaImage = async (rawQuery: string): Promise<string | null> => {
  const normalizedQuery = normalizeFoodTerm(rawQuery);
  if (!normalizedQuery || normalizedQuery === 'food') {
    logImageMismatch({
      input: rawQuery,
      normalizedKeyword: normalizedQuery,
      selectedImageSource: 'none',
      rejectionReason: 'normalized_keyword_unusable',
    });
    return null;
  }

  const directImage = WIKIMEDIA_DIRECT_IMAGE_BY_KEYWORD[normalizedQuery];
  if (directImage) {
    return directImage;
  }

  try {
    // Prefer lead image from regular Wikipedia pages for better visual quality and recognizability.
    const wikipediaLeadImage = await fetchWikipediaLeadImage(normalizedQuery);
    if (wikipediaLeadImage) {
      return wikipediaLeadImage;
    }

    let bestImageUrl: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const offsets = [0, 12, 24];
    for (const offset of offsets) {
      const pages = await fetchWikimediaPages(normalizedQuery, offset);
      for (const page of pages) {
        const title = page.title || '';
        const imageUrl = page.imageinfo?.[0]?.url;
        if (!imageUrl) {
          logImageMismatch({
            input: rawQuery,
            normalizedKeyword: normalizedQuery,
            selectedImageSource: 'missing_url',
            rejectionReason: 'missing_image_url',
            metadataTitle: title,
          });
          continue;
        }
        if (!titleMatchesKeyword(title, normalizedQuery)) {
          logImageMismatch({
            input: rawQuery,
            normalizedKeyword: normalizedQuery,
            selectedImageSource: imageUrl,
            rejectionReason: 'title_does_not_contain_keyword',
            metadataTitle: title,
          });
          continue;
        }

        const candidateScore = scoreWikimediaCandidate(page, normalizedQuery);
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
    logImageMismatch({
      input: rawQuery,
      normalizedKeyword: normalizedQuery,
      selectedImageSource: 'none',
      rejectionReason: 'wikimedia_request_failed',
    });
    return null;
  }

  logImageMismatch({
    input: rawQuery,
    normalizedKeyword: normalizedQuery,
    selectedImageSource: DEFAULT_FALLBACK_IMAGE_URL,
    rejectionReason: 'no_verified_match_found',
  });
  return null;
};

interface ProductImageCacheRow {
  canonical_key: string;
  image_url: string;
  source: string;
  created_at: number;
  updated_at: number;
}

interface HousePayloadRow {
  id: string;
  payload: string;
  updated_at: number;
}

const isSupabasePublicImage = (url: string): boolean => {
  return /supabase\.co\/storage\/v1\/object\/public\//i.test(url);
};

const isCatalogSupabaseImage = (url: string): boolean => {
  return /\/storage\/v1\/object\/public\/[^/]+\/catalog\//i.test(url);
};

const inferImageSource = (imageUrl: string): 'gemini' | 'supabase' | 'wikimedia' | 'unknown' => {
  if (!imageUrl) return 'unknown';
  if (imageUrl.startsWith('data:image/')) return 'gemini';
  if (isSupabasePublicImage(imageUrl)) return 'supabase';
  if (/wikimedia\.org|wikipedia\.org/i.test(imageUrl)) return 'wikimedia';
  return 'unknown';
};

const readCachedProductImage = async (
  db: D1LikeDatabase,
  canonicalKey: string
): Promise<ProductImageCacheRow | null> => {
  await ensureImageCacheSchema(db);
  const row = await db
    .prepare('SELECT canonical_key, image_url, source, created_at, updated_at FROM product_image_cache WHERE canonical_key = ? LIMIT 1')
    .bind(canonicalKey)
    .first<ProductImageCacheRow>();
  if (!row) return null;
  const imageUrl = toStringOrEmpty(row.image_url);
  if (!imageUrl) return null;
  return {
    canonical_key: row.canonical_key,
    image_url: imageUrl,
    source: toStringOrEmpty(row.source) || 'cached',
    created_at: toNumberOrDefault(row.created_at, Date.now()),
    updated_at: toNumberOrDefault(row.updated_at, Date.now()),
  };
};

const upsertCachedProductImage = async (
  db: D1LikeDatabase,
  canonicalKey: string,
  imageUrl: string,
  source: 'gemini' | 'wikimedia' | 'cached' | 'supabase'
): Promise<void> => {
  await ensureImageCacheSchema(db);
  const now = Date.now();
  await db
    .prepare(
      [
        'INSERT INTO product_image_cache (canonical_key, image_url, source, created_at, updated_at)',
        'VALUES (?, ?, ?, ?, ?)',
        'ON CONFLICT(canonical_key) DO UPDATE SET',
        'image_url = excluded.image_url,',
        'source = excluded.source,',
        'updated_at = excluded.updated_at',
      ].join(' ')
    )
    .bind(canonicalKey, imageUrl, source, now, now)
    .run();
};

const findPersistedProductImageFromHouses = async (
  db: D1LikeDatabase,
  canonicalKey: string
): Promise<{ imageUrl: string; source: 'supabase' | 'cached' } | null> => {
  const rows = await db
    .prepare('SELECT id, payload, updated_at FROM houses ORDER BY updated_at DESC LIMIT 100')
    .all<HousePayloadRow>();

  const houses = rows.results || [];
  let best: { score: number; imageUrl: string; source: 'supabase' | 'cached' } | null = null;

  for (const house of houses) {
    let payload: JsonRecord;
    try {
      payload = JSON.parse(toStringOrEmpty(house.payload) || '{}') as JsonRecord;
    } catch {
      continue;
    }

    const inventory = Array.isArray(payload.inventory) ? payload.inventory : [];
    for (const entry of inventory) {
      const item = entry && typeof entry === 'object' ? (entry as JsonRecord) : {};
      const imageUrl = toStringOrEmpty(item.imageUrl);
      if (!imageUrl || isNeutralPlaceholderImage(imageUrl)) continue;

      const candidateKey = normalizeFoodTerm(
        toStringOrEmpty(item.canonicalName) || toStringOrEmpty(item.imageKeyword) || toStringOrEmpty(item.name)
      );
      if (candidateKey !== canonicalKey) continue;

      const source: 'supabase' | 'cached' = isSupabasePublicImage(imageUrl) ? 'supabase' : 'cached';
      const score = (source === 'supabase' ? 10 : 5) + Math.floor(toNumberOrDefault(house.updated_at, 0) / 1_000_000_000_000);
      if (!best || score > best.score) {
        best = { score, imageUrl, source };
      }
    }
  }

  if (!best) return null;
  return { imageUrl: best.imageUrl, source: best.source };
};

const decodeBase64 = (raw: string): Uint8Array => {
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const resolveImagePayload = async (source: string): Promise<{ bytes: Uint8Array; mimeType: string }> => {
  if (source.startsWith('data:')) {
    const match = source.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) {
      throw new Error('Invalid data URL image payload.');
    }
    return {
      bytes: decodeBase64(match[2]),
      mimeType: match[1] || 'image/jpeg',
    };
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to fetch image source (${response.status}).`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const contentType = toStringOrEmpty(response.headers.get('content-type')) || guessMimeTypeFromUrl(source);
  return {
    bytes: new Uint8Array(arrayBuffer),
    mimeType: contentType,
  };
};

const maybePersistImageInSupabase = async (
  env: Env,
  canonicalKey: string,
  source: string
): Promise<string | null> => {
  const supabaseUrl = toStringOrEmpty(env.SUPABASE_URL).replace(/\/$/, '');
  const authKey = toStringOrEmpty(env.SUPABASE_SERVICE_ROLE_KEY) || toStringOrEmpty(env.SUPABASE_ANON_KEY);
  const bucket = toStringOrEmpty(env.SUPABASE_STORAGE_BUCKET) || SUPABASE_DEFAULT_BUCKET;
  if (!supabaseUrl || !authKey) return null;

  const { bytes, mimeType } = await resolveImagePayload(source);
  const uploadBytes = new Uint8Array(bytes.length);
  uploadBytes.set(bytes);
  const ext = mimeTypeToExtension(mimeType);
  const filePath = `catalog/${sanitizeStorageKey(canonicalKey)}.${ext}`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${encodeStoragePath(filePath)}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authKey}`,
      apikey: authKey,
      'Content-Type': mimeType,
      'x-upsert': 'true',
    },
    body: uploadBytes,
  });

  if (!uploadResponse.ok) {
    const message = await uploadResponse.text().catch(() => '');
    throw new Error(`Supabase image upload failed (${uploadResponse.status}): ${message.slice(0, 240)}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${encodeStoragePath(filePath)}`;
};

const resolveBestImage = async (
  env: Env,
  db: D1LikeDatabase | null,
  prompt: string,
  mode: 'product' | 'recipe' = 'product'
): Promise<string | null> => {
  const safePrompt = toStringOrEmpty(prompt);
  if (!safePrompt) return null;
  const normalizedKeyword = normalizeFoodTerm(safePrompt);
  let cachedWikimediaFallback: string | null = null;

  if (mode === 'product' && db && normalizedKeyword !== 'food') {
    const cached = await readCachedProductImage(db, normalizedKeyword);
    if (cached) {
      const isTrustedCache =
        cached.source === 'gemini' ||
        (cached.source === 'supabase' && isCatalogSupabaseImage(cached.image_url));
      if (isTrustedCache) {
        return cached.image_url;
      }
      if (cached.source === 'wikimedia') {
        cachedWikimediaFallback = cached.image_url;
      }
    }

    // Recover previously generated product images from existing house inventory snapshots.
    // This lets us reuse an already-good image globally instead of locking into Wikimedia fallback.
    const recovered = await findPersistedProductImageFromHouses(db, normalizedKeyword);
    if (recovered && isCatalogSupabaseImage(recovered.imageUrl)) {
      await upsertCachedProductImage(db, normalizedKeyword, recovered.imageUrl, recovered.source);
      return recovered.imageUrl;
    }
  }

  let generatedSource: string | null = null;
  let usedWikimediaFallback = false;
  try {
    const response = await generateAIResponse(
      `Generate an accurate photo-realistic grocery or dish image for: ${safePrompt}`,
      {
        task: 'image',
        geminiModel: 'gemini-2.5-flash-image',
        timeoutMs: 12_000,
        allowFallback: true,
      },
      env
    );

    if (response.text && !isNeutralPlaceholderImage(response.text)) {
      generatedSource = response.text;
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'image_generation_fallback',
        reason: error instanceof Error ? error.message : 'unknown',
      })
    );
  }

  if (!generatedSource) {
    if (mode === 'recipe') {
      // For recipes, avoid showing raw ingredient fallbacks as "dish" images.
      return null;
    }
    usedWikimediaFallback = true;
    generatedSource = await getWikimediaImage(safePrompt);
  }
  if (!generatedSource || isNeutralPlaceholderImage(generatedSource)) {
    return mode === 'product' ? cachedWikimediaFallback : null;
  }

  if (mode === 'product' && db && normalizedKeyword !== 'food') {
    const generatedSourceKind = inferImageSource(generatedSource);

    // Wikimedia is runtime fallback only. Never persist it as global cache.
    if (usedWikimediaFallback || generatedSourceKind === 'wikimedia') {
      return generatedSource;
    }

    let stableSource = generatedSource;
    try {
      const uploaded = await maybePersistImageInSupabase(env, normalizedKeyword, generatedSource);
      if (uploaded) stableSource = uploaded;
    } catch (uploadError) {
      console.log(
        JSON.stringify({
          event: 'image_cache_upload_fallback',
          normalizedKeyword,
          reason: uploadError instanceof Error ? uploadError.message : 'unknown',
        })
      );
    }

    // Persist only canonical catalog URLs to avoid sticky low-quality source reuse.
    if (isCatalogSupabaseImage(stableSource)) {
      await upsertCachedProductImage(db, normalizedKeyword, stableSource, 'supabase');
    }

    return stableSource;
  }

  return generatedSource;
};

interface SanitizedReceiptItem {
  name: string;
  quantity: number;
  unit: string;
  price: number;
  category: Category;
  imageKeyword: string;
  canonicalName: string;
}

const sanitizeReceiptItem = (entry: unknown): SanitizedReceiptItem => {
  const source = entry && typeof entry === 'object' ? (entry as JsonRecord) : {};

  return {
    name: toStringOrEmpty(source.name) || 'Unknown item',
    quantity: toNumberOrDefault(source.quantity, 1),
    unit: toStringOrEmpty(source.unit) || 'pcs',
    price: toNumberOrDefault(source.price, 0),
    category: normalizeCategory(source.category),
    imageKeyword: toStringOrEmpty(source.imageKeyword) || toStringOrEmpty(source.name) || 'food',
    canonicalName: toStringOrEmpty(source.canonicalName) || toStringOrEmpty(source.name).toLowerCase() || 'food',
  };
};

const categoryByKeyword = (keyword: string): Category | null => {
  switch (keyword) {
    case 'milk':
    case 'egg':
      return 'Dairy';
    case 'apple':
    case 'banana':
      return 'Fruits';
    case 'potato':
    case 'tomato':
      return 'Produce';
    case 'chicken':
      return 'Meat';
    case 'bread':
    case 'rice':
      return 'Pantry';
    default:
      return null;
  }
};

const inferCategoryFromKeyword = (item: SanitizedReceiptItem): Category => {
  const keyword = normalizeFoodTerm(item.canonicalName || item.imageKeyword || item.name);
  const inferred = categoryByKeyword(keyword);
  if (inferred) return inferred;
  return normalizeCategory(item.category);
};

const parseVoiceModelResponse = (parsed: unknown): { transcript: string; items: unknown[] } => {
  if (Array.isArray(parsed)) {
    return {
      transcript: '',
      items: parsed,
    };
  }

  const source = parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : {};
  const items = Array.isArray(source.items) ? source.items : [];
  const transcript = toStringOrEmpty(source.transcript);
  return { transcript, items };
};

const transcriptContainsKeyword = (normalizedTranscript: string, keyword: string): boolean => {
  if (!normalizedTranscript || !keyword || keyword === 'food') return false;
  const escaped = keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizedTranscript);
};

const dedupeVoiceItems = (items: SanitizedReceiptItem[]): SanitizedReceiptItem[] => {
  const grouped = new Map<string, SanitizedReceiptItem>();

  for (const item of items) {
    const normalizedKeyword = normalizeFoodTerm(item.canonicalName || item.imageKeyword || item.name);
    if (!item.name || normalizedKeyword === 'food') continue;
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;

    const key = `${normalizedKeyword}::${item.unit || 'pcs'}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        ...item,
        category: inferCategoryFromKeyword(item),
        canonicalName: normalizedKeyword,
        imageKeyword: normalizedKeyword,
      });
      continue;
    }

    grouped.set(key, {
      ...existing,
      quantity: Number((existing.quantity + item.quantity).toFixed(2)),
      price: Math.max(existing.price, item.price),
      category: existing.category === 'Other' ? inferCategoryFromKeyword(item) : existing.category,
    });
  }

  return Array.from(grouped.values());
};

const sanitizeRecipe = (value: unknown): JsonRecord => {
  const source = value && typeof value === 'object' ? (value as JsonRecord) : {};

  const ingredients = Array.isArray(source.ingredients)
    ? source.ingredients.map((ingredient) => {
        const ing = ingredient && typeof ingredient === 'object' ? (ingredient as JsonRecord) : {};
        return {
          name: toStringOrEmpty(ing.name) || 'ingredient',
          quantity: toStringOrEmpty(ing.quantity) || 'to taste',
          canonicalName:
            toStringOrEmpty(ing.canonicalName) || toStringOrEmpty(ing.name).toLowerCase() || 'ingredient',
          category: normalizeCategory(ing.category),
        };
      })
    : [];

  const instructions = Array.isArray(source.instructions)
    ? source.instructions
        .map(step => (typeof step === 'string' ? step.trim() : ''))
        .filter(Boolean)
    : [];

  return {
    title: toStringOrEmpty(source.title) || 'Recipe',
    ingredients,
    instructions,
    imageKeyword: toStringOrEmpty(source.imageKeyword) || 'food',
    cookingTime: Math.max(5, Math.round(toNumberOrDefault(source.cookingTime, 30))),
  };
};

const capitalizeFirst = (value: string): string => {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const buildPracticalFallbackRecipe = (ingredientName: string): JsonRecord => {
  const normalizedIngredient = normalizeFoodTerm(ingredientName);
  const displayIngredient = capitalizeFirst(toStringOrEmpty(ingredientName) || 'Main Ingredient');

  if (normalizedIngredient === 'banana') {
    return {
      title: 'Banana Oat Pancakes',
      ingredients: [
        { name: 'Banana', quantity: '1 ripe', canonicalName: 'banana' },
        { name: 'Egg', quantity: '1', canonicalName: 'egg' },
        { name: 'Rolled Oats', quantity: '1/2 cup', canonicalName: 'oat' },
        { name: 'Milk', quantity: '1/4 cup', canonicalName: 'milk' },
      ],
      instructions: [
        'Mash the banana in a bowl and whisk in egg and milk.',
        'Stir in rolled oats and let the batter rest for 3 minutes.',
        'Cook small pancakes on a lightly oiled pan over medium heat until golden on both sides.',
      ],
      imageKeyword: 'banana oat pancakes',
      cookingTime: 15,
    };
  }

  if (normalizedIngredient === 'apple') {
    return {
      title: 'Cinnamon Apple Oatmeal',
      ingredients: [
        { name: 'Apple', quantity: '1 diced', canonicalName: 'apple' },
        { name: 'Rolled Oats', quantity: '1/2 cup', canonicalName: 'oat' },
        { name: 'Milk', quantity: '3/4 cup', canonicalName: 'milk' },
        { name: 'Ground Cinnamon', quantity: '1/4 tsp', canonicalName: 'cinnamon' },
      ],
      instructions: [
        'Simmer diced apple with a splash of water for 2 minutes.',
        'Add oats, milk, and cinnamon; cook while stirring until creamy.',
        'Serve warm with extra apple slices on top.',
      ],
      imageKeyword: 'cinnamon apple oatmeal',
      cookingTime: 12,
    };
  }

  return {
    title: `${displayIngredient} Skillet Bowl`,
    ingredients: [
      { name: displayIngredient, quantity: '1 cup', canonicalName: normalizedIngredient },
      { name: 'Olive Oil', quantity: '1 tbsp', canonicalName: 'oil' },
      { name: 'Onion', quantity: '1/2 chopped', canonicalName: 'onion' },
      { name: 'Salt', quantity: 'to taste', canonicalName: 'salt' },
    ],
    instructions: [
      'Heat oil in a skillet and saute onion until soft.',
      `Add ${displayIngredient.toLowerCase()} and cook until tender and fragrant.`,
      'Season with salt and serve warm as a simple bowl.',
    ],
    imageKeyword: `${normalizedIngredient} skillet bowl`,
    cookingTime: 20,
  };
};

const isWeakRecipeOutput = (recipe: JsonRecord, ingredientName: string): boolean => {
  const ingredientKeyword = normalizeFoodTerm(ingredientName);
  const title = normalizeProductText(toStringOrEmpty(recipe.title));
  const ingredients = Array.isArray(recipe.ingredients) ? (recipe.ingredients as JsonRecord[]) : [];
  const instructions = Array.isArray(recipe.instructions)
    ? recipe.instructions.filter(step => typeof step === 'string' && step.trim().length > 0)
    : [];

  const hasMainIngredient = ingredients.some(ingredient => {
    const candidateKeyword = normalizeFoodTerm(
      toStringOrEmpty(ingredient.canonicalName) || toStringOrEmpty(ingredient.name)
    );
    return candidateKeyword === ingredientKeyword;
  });

  const isGenericTitle =
    !title ||
    title === ingredientKeyword ||
    title === `${ingredientKeyword} dish` ||
    title === `${ingredientKeyword} recipe` ||
    title.startsWith(`cooked ${ingredientKeyword}`) ||
    title.startsWith(`${ingredientKeyword} cooked`);

  return isGenericTitle || ingredients.length < 3 || instructions.length < 3 || !hasMainIngredient;
};

const applyParsedRecipeQualityFallbacks = (recipe: JsonRecord, rawInput: string): JsonRecord => {
  const sourceTitle = toStringOrEmpty(recipe.title);
  const sourceImageKeyword = toStringOrEmpty(recipe.imageKeyword);
  const sourceIngredients = Array.isArray(recipe.ingredients) ? (recipe.ingredients as JsonRecord[]) : [];
  const sourceInstructions = Array.isArray(recipe.instructions)
    ? recipe.instructions.filter(step => typeof step === 'string' && step.trim().length > 0) as string[]
    : [];

  const inferredIngredient =
    normalizeFoodTerm(sourceImageKeyword) !== 'food'
      ? normalizeFoodTerm(sourceImageKeyword)
      : normalizeFoodTerm(sourceTitle || rawInput);
  const primaryIngredient = inferredIngredient === 'food' ? 'meal' : inferredIngredient;

  const ingredients = sourceIngredients.length > 0
    ? sourceIngredients
    : [{ name: capitalizeFirst(primaryIngredient), quantity: 'to taste', canonicalName: primaryIngredient, category: 'Other' }];

  const titleNormalized = normalizeProductText(sourceTitle);
  const isGenericTitle =
    !titleNormalized ||
    titleNormalized === primaryIngredient ||
    titleNormalized === `${primaryIngredient} recipe` ||
    titleNormalized === `${primaryIngredient} dish`;
  const title = isGenericTitle ? `${capitalizeFirst(primaryIngredient)} Home Recipe` : sourceTitle;

  const instructions = sourceInstructions.length >= 2
    ? sourceInstructions
    : [
        'Prepare all ingredients and measure portions.',
        'Cook using your preferred method until the main ingredient is done and flavors combine well.',
        'Plate and serve warm.',
      ];

  const imageKeyword = normalizeFoodTerm(sourceImageKeyword) === 'food'
    ? `${primaryIngredient} plated dish`
    : sourceImageKeyword;

  return {
    ...recipe,
    title,
    ingredients,
    instructions,
    imageKeyword,
    cookingTime: Math.max(10, toNumberOrDefault(recipe.cookingTime, 30)),
  };
};

interface HouseRow {
  id: string;
  name: string;
  password_hash: string;
  payload: string;
  updated_at: number;
}

interface AuthContext {
  username: string;
  displayName: string;
  sessionToken: string;
}

interface MemberRow {
  username: string;
  display_name: string;
  role: string;
  joined_at: number;
}

interface ActivityRow {
  id: number;
  actor_username: string;
  action: string;
  metadata: string | null;
  created_at: number;
}

const normalizeUsername = (value: string): string => value.trim().toLowerCase();

const assertValidUsername = (username: string): void => {
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3-40 chars and use letters, numbers, dot, underscore, or dash.');
  }
};

const sanitizeDisplayName = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 80);
};

const getHouseRow = async (db: D1LikeDatabase, houseId: string): Promise<HouseRow> => {
  const row = await db
    .prepare('SELECT id, name, password_hash, payload, updated_at FROM houses WHERE id = ? LIMIT 1')
    .bind(houseId)
    .first<HouseRow>();

  if (!row) {
    throw new HttpError(404, 'House not found');
  }

  return row;
};

const validateHousePassword = async (row: { password_hash: string }, password: string): Promise<void> => {
  const isValid = await verifyPasswordHash(password, row.password_hash);
  if (!isValid) {
    throw new HttpError(401, 'Invalid house credentials');
  }
};

const issueSession = async (db: D1LikeDatabase, username: string): Promise<string> => {
  const now = Date.now();
  const sessionToken = generateSessionToken();
  const tokenHash = await sha256Hex(sessionToken);
  const expiresAt = now + SESSION_TTL_MS;

  await db
    .prepare('INSERT INTO user_sessions (token_hash, username, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)')
    .bind(tokenHash, username, now, expiresAt)
    .run();

  return sessionToken;
};

const getSessionUser = async (
  db: D1LikeDatabase,
  sessionToken: string
): Promise<{ username: string; displayName: string }> => {
  if (!sessionToken) {
    throw new HttpError(401, 'Missing session token');
  }

  const tokenHash = await sha256Hex(sessionToken);
  const now = Date.now();
  const row = await db
    .prepare(
      [
        'SELECT u.username AS username, u.display_name AS displayName',
        'FROM user_sessions s',
        'JOIN users u ON u.username = s.username',
        'WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?',
        'LIMIT 1',
      ].join(' ')
    )
    .bind(tokenHash, now)
    .first<{ username: string; displayName: string }>();

  if (!row) {
    throw new HttpError(401, 'Session expired or invalid');
  }

  return row;
};

const resolveAuthContext = async (db: D1LikeDatabase, body: JsonRecord): Promise<AuthContext> => {
  await ensureAuthSchema(db);
  const authRaw = body.auth && typeof body.auth === 'object' ? (body.auth as JsonRecord) : {};
  const sessionToken = toStringOrEmpty(authRaw.sessionToken);

  if (sessionToken) {
    const sessionUser = await getSessionUser(db, sessionToken);
    return {
      username: sessionUser.username,
      displayName: sessionUser.displayName,
      sessionToken,
    };
  }

  const username = normalizeUsername(toStringOrEmpty(authRaw.username));
  const displayNameInput = toStringOrEmpty(authRaw.displayName);
  const password = toStringOrEmpty(authRaw.password);

  if (!username || !password) {
    throw new HttpError(400, 'Either sessionToken or username/password is required.');
  }

  assertValidUsername(username);

  const now = Date.now();
  const existingUser = await db
    .prepare('SELECT username, display_name, password_hash FROM users WHERE username = ? LIMIT 1')
    .bind(username)
    .first<{ username: string; display_name: string; password_hash: string }>();

  let displayName = sanitizeDisplayName(displayNameInput, username);

  if (existingUser) {
    const validPassword = await verifyPasswordHash(password, existingUser.password_hash);
    if (!validPassword) {
      throw new HttpError(401, 'Invalid account credentials');
    }
    displayName = existingUser.display_name || displayName;
  } else {
    if (!displayNameInput) {
      throw new HttpError(400, 'displayName is required for new accounts');
    }
    const passwordHash = await createPasswordHash(password);
    await db
      .prepare('INSERT INTO users (username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(username, displayName, passwordHash, now, now)
      .run();
  }

  const nextToken = await issueSession(db, username);
  return { username, displayName, sessionToken: nextToken };
};

const requireSessionContext = async (db: D1LikeDatabase, body: JsonRecord): Promise<AuthContext> => {
  await ensureAuthSchema(db);
  const sessionToken = toStringOrEmpty(body.sessionToken);
  const sessionUser = await getSessionUser(db, sessionToken);
  return {
    username: sessionUser.username,
    displayName: sessionUser.displayName,
    sessionToken,
  };
};

const readHouseRole = async (db: D1LikeDatabase, house: HouseRow, username: string): Promise<HouseRole | null> => {
  const membership = await db
    .prepare('SELECT role FROM house_members WHERE house_id = ? AND username = ? LIMIT 1')
    .bind(house.id, username)
    .first<{ role: string }>();

  if (membership?.role === 'owner') return 'owner';
  if (membership?.role === 'member') return 'member';

  const existingOwner = await db
    .prepare('SELECT username FROM house_members WHERE house_id = ? AND role = ? LIMIT 1')
    .bind(house.id, 'owner')
    .first<{ username: string }>();

  if (!existingOwner) {
    await db
      .prepare('INSERT OR IGNORE INTO house_members (house_id, username, role, joined_at) VALUES (?, ?, ?, ?)')
      .bind(house.id, username, 'owner', Date.now())
      .run();
    return 'owner';
  }

  return null;
};

const requireHouseRole = async (
  db: D1LikeDatabase,
  houseId: string,
  username: string
): Promise<{ house: HouseRow; role: HouseRole }> => {
  const house = await getHouseRow(db, houseId);
  const role = await readHouseRole(db, house, username);
  if (!role) {
    throw new HttpError(403, 'You do not have access to this house');
  }
  return { house, role };
};

const requireHouseOwner = async (db: D1LikeDatabase, houseId: string, username: string): Promise<HouseRow> => {
  const { house, role } = await requireHouseRole(db, houseId, username);
  if (role !== 'owner') {
    throw new HttpError(403, 'Only house owners can perform this action');
  }
  return house;
};

const logHouseActivity = async (
  db: D1LikeDatabase,
  houseId: string,
  actorUsername: string,
  action: string,
  metadata?: JsonRecord
): Promise<void> => {
  const meta = metadata ? JSON.stringify(metadata) : null;
  try {
    await db
      .prepare('INSERT INTO house_activity (house_id, actor_username, action, metadata, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(houseId, actorUsername, action, meta, Date.now())
      .run();
  } catch {
    // Activity logs should never break primary request flows.
  }
};

const toHouseSummary = (house: HouseRow, role: HouseRole): JsonRecord => {
  const state = parseStoredState(house.payload, house.name, house.updated_at);
  return {
    id: house.id,
    name: house.name,
    currency: toStringOrEmpty(state.currency) || '$',
    role,
  };
};

const listUserHouses = async (db: D1LikeDatabase, username: string): Promise<JsonRecord[]> => {
  const rows = await db
    .prepare(
      [
        'SELECT h.id, h.name, h.payload, h.updated_at, hm.role',
        'FROM house_members hm',
        'JOIN houses h ON h.id = hm.house_id',
        'WHERE hm.username = ?',
        'ORDER BY h.updated_at DESC',
      ].join(' ')
    )
    .bind(username)
    .all<HouseRow & { role: string }>();

  const results = rows.results || [];
  const summaries = results.map(row => {
    const role: HouseRole = row.role === 'owner' ? 'owner' : 'member';
    return toHouseSummary(row, role);
  });

  return summaries;
};

const handleAuthSession = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houses = await listUserHouses(db, auth.username);
  return {
    account: {
      username: auth.username,
      displayName: auth.displayName,
    },
    houses,
  };
};

const handleAuthLogin = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await resolveAuthContext(db, body);
  const houses = await listUserHouses(db, auth.username);

  return {
    account: auth,
    houses,
  };
};

const handleAuthLogout = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  await ensureAuthSchema(db);
  const sessionToken = toStringOrEmpty(body.sessionToken);
  if (!sessionToken) {
    throw new HttpError(400, 'sessionToken is required');
  }

  const tokenHash = await sha256Hex(sessionToken);
  await db
    .prepare('UPDATE user_sessions SET revoked_at = ? WHERE token_hash = ?')
    .bind(Date.now(), tokenHash)
    .run();

  return { success: true };
};

const handleHouseCreate = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await resolveAuthContext(db, body);

  const houseName = toStringOrEmpty(body.houseName);
  const housePassword = toStringOrEmpty(body.housePassword);
  const rawState = body.state;
  if (!houseName || !housePassword) {
    throw new HttpError(400, 'houseName and housePassword are required');
  }

  const houseId = await generateUniqueHouseCode(db);
  const passwordHash = await createPasswordHash(housePassword);
  const now = Date.now();
  const state = normalizeHouseState(rawState, houseName);
  state.updatedAt = now;
  state.houseName = houseName;

  await db
    .prepare(
      'INSERT INTO houses (id, name, password_hash, payload, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(houseId, houseName, passwordHash, JSON.stringify(state), now, now)
    .run();

  await db
    .prepare('INSERT INTO house_members (house_id, username, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind(houseId, auth.username, 'owner', now)
    .run();

  await logHouseActivity(db, houseId, auth.username, 'house_created', { houseName });

  return {
    account: auth,
    house: {
      id: houseId,
      name: houseName,
      currency: toStringOrEmpty(state.currency) || '$',
      role: 'owner',
    },
    state,
  };
};

const handleHouseJoin = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await resolveAuthContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  const housePassword = toStringOrEmpty(body.housePassword);
  if (!houseId || !housePassword) {
    throw new HttpError(400, 'houseId and housePassword are required');
  }

  const house = await getHouseRow(db, houseId);
  await validateHousePassword(house, housePassword);

  let role = await readHouseRole(db, house, auth.username);
  if (!role) {
    role = 'member';
    await db
      .prepare('INSERT OR IGNORE INTO house_members (house_id, username, role, joined_at) VALUES (?, ?, ?, ?)')
      .bind(houseId, auth.username, role, Date.now())
      .run();
  }

  const refreshedHouse = await getHouseRow(db, houseId);
  const state = parseStoredState(refreshedHouse.payload, refreshedHouse.name, refreshedHouse.updated_at);
  await logHouseActivity(db, houseId, auth.username, 'house_joined');

  return {
    account: auth,
    house: toHouseSummary(refreshedHouse, role),
    state,
  };
};

const handleHouseFetch = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  if (!houseId) {
    throw new HttpError(400, 'houseId is required');
  }

  const { house, role } = await requireHouseRole(db, houseId, auth.username);
  const state = parseStoredState(house.payload, house.name, house.updated_at);
  logSyncEvent(env, 'house_fetch', {
    houseId,
    actorUsername: auth.username,
    role,
    ...summarizeStateForLog(state),
  });
  return {
    house: toHouseSummary(house, role),
    state,
  };
};

const handleHouseUpdate = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  const nextState = body.state;
  const baseUpdatedAt = toNumberOrDefault(body.baseUpdatedAt, 0);

  if (!houseId || !nextState || typeof nextState !== 'object') {
    throw new HttpError(400, 'houseId and state are required');
  }

  const { house } = await requireHouseRole(db, houseId, auth.username);
  if (baseUpdatedAt > 0 && house.updated_at > baseUpdatedAt) {
    logSyncEvent(env, 'house_update_conflict', {
      houseId,
      actorUsername: auth.username,
      baseUpdatedAt,
      currentUpdatedAt: house.updated_at,
    });
    throw new HttpError(409, 'state_conflict');
  }

  const parsed = normalizeHouseState(nextState, house.name);
  const clientUpdatedAt = toNumberOrDefault(parsed.updatedAt, Date.now());
  const now = Math.max(clientUpdatedAt, house.updated_at + 1);
  const nextHouseName = toStringOrEmpty(parsed.houseName) || house.name;
  parsed.updatedAt = now;
  parsed.houseName = nextHouseName;

  await db
    .prepare('UPDATE houses SET name = ?, payload = ?, updated_at = ? WHERE id = ?')
    .bind(nextHouseName, JSON.stringify(parsed), now, houseId)
    .run();

  logSyncEvent(env, 'house_update_applied', {
    houseId,
    actorUsername: auth.username,
    baseUpdatedAt,
    previousUpdatedAt: house.updated_at,
    storedUpdatedAt: now,
    ...summarizeStateForLog(parsed),
  });

  await logHouseActivity(db, houseId, auth.username, 'house_state_updated');
  return { success: true, updatedAt: now };
};

const handleHouseRename = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  const houseName = toStringOrEmpty(body.houseName);
  if (!houseId || !houseName) {
    throw new HttpError(400, 'houseId and houseName are required');
  }

  const house = await requireHouseOwner(db, houseId, auth.username);
  const state = parseStoredState(house.payload, house.name, house.updated_at);
  state.houseName = houseName;
  state.updatedAt = Date.now();

  await db
    .prepare('UPDATE houses SET name = ?, payload = ?, updated_at = ? WHERE id = ?')
    .bind(houseName, JSON.stringify(state), state.updatedAt, houseId)
    .run();

  await logHouseActivity(db, houseId, auth.username, 'house_renamed', { houseName });

  return {
    house: {
      id: houseId,
      name: houseName,
      currency: toStringOrEmpty(state.currency) || '$',
      role: 'owner',
    },
  };
};

const handleHouseChangePassword = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  const newPassword = toStringOrEmpty(body.newPassword);
  if (!houseId || !newPassword) {
    throw new HttpError(400, 'houseId and newPassword are required');
  }

  await requireHouseOwner(db, houseId, auth.username);
  const passwordHash = await createPasswordHash(newPassword);

  await db
    .prepare('UPDATE houses SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(passwordHash, Date.now(), houseId)
    .run();

  await logHouseActivity(db, houseId, auth.username, 'house_password_changed');
  return { success: true };
};

const handleHouseDelete = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  if (!houseId) {
    throw new HttpError(400, 'houseId is required');
  }

  await requireHouseOwner(db, houseId, auth.username);
  await logHouseActivity(db, houseId, auth.username, 'house_deleted');

  await db.prepare('DELETE FROM house_members WHERE house_id = ?').bind(houseId).run();
  await db.prepare('DELETE FROM house_activity WHERE house_id = ?').bind(houseId).run();
  await db.prepare('DELETE FROM houses WHERE id = ?').bind(houseId).run();

  return { success: true };
};

const handleHouseMembers = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  if (!houseId) {
    throw new HttpError(400, 'houseId is required');
  }

  await requireHouseOwner(db, houseId, auth.username);
  const rows = await db
    .prepare(
      [
        'SELECT hm.username AS username, u.display_name AS display_name, hm.role AS role, hm.joined_at AS joined_at',
        'FROM house_members hm',
        'JOIN users u ON u.username = hm.username',
        'WHERE hm.house_id = ?',
        'ORDER BY CASE hm.role WHEN "owner" THEN 0 ELSE 1 END, hm.joined_at ASC',
      ].join(' ')
    )
    .bind(houseId)
    .all<MemberRow>();

  return {
    members: (rows.results || []).map(member => ({
      username: member.username,
      displayName: member.display_name,
      role: member.role === 'owner' ? 'owner' : 'member',
      joinedAt: member.joined_at,
    })),
  };
};

const handleHouseRemoveMember = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  const targetUsername = normalizeUsername(toStringOrEmpty(body.username));
  if (!houseId || !targetUsername) {
    throw new HttpError(400, 'houseId and username are required');
  }

  await requireHouseOwner(db, houseId, auth.username);
  const targetMembership = await db
    .prepare('SELECT role FROM house_members WHERE house_id = ? AND username = ? LIMIT 1')
    .bind(houseId, targetUsername)
    .first<{ role: string }>();
  if (targetMembership?.role === 'owner') {
    throw new HttpError(400, 'Owner cannot be removed from the house');
  }

  await db.prepare('DELETE FROM house_members WHERE house_id = ? AND username = ?').bind(houseId, targetUsername).run();
  await logHouseActivity(db, houseId, auth.username, 'member_removed', { username: targetUsername });
  return { success: true };
};

const handleHouseActivity = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const auth = await requireSessionContext(db, body);
  const houseId = toStringOrEmpty(body.houseId).toUpperCase();
  const limit = Math.max(1, Math.min(100, Math.round(toNumberOrDefault(body.limit, 25))));
  if (!houseId) {
    throw new HttpError(400, 'houseId is required');
  }

  await requireHouseOwner(db, houseId, auth.username);
  const rows = await db
    .prepare(
      [
        'SELECT id, actor_username, action, metadata, created_at',
        'FROM house_activity',
        'WHERE house_id = ?',
        'ORDER BY created_at DESC',
        'LIMIT ?',
      ].join(' ')
    )
    .bind(houseId, limit)
    .all<ActivityRow>();

  return {
    events: (rows.results || []).map(event => ({
      id: event.id,
      actorUsername: event.actor_username,
      action: event.action,
      metadata: event.metadata,
      createdAt: event.created_at,
    })),
  };
};

const handleAnalyzeReceipt = async (env: Env, body: JsonRecord) => {
  const imageBase64 = toStringOrEmpty(body.imageBase64);
  if (!imageBase64) return [];

  const prompt = [
    'Analyze the grocery receipt image and return JSON only.',
    'Output format: [{"name":"","quantity":1,"unit":"pcs","price":0,"category":"Other","imageKeyword":"","canonicalName":""}]',
    'Rules: names in English, canonicalName singular English, category must be one of Produce,Fruits,Dairy,Meat,Pantry,Beverages,Frozen,Other.',
  ].join('\n');

  let parsed: unknown;
  try {
    parsed = await aiJson(env, prompt, {
      model: GEMINI_PRIMARY_MODEL,
      modelFallbacks: GEMINI_MODEL_FALLBACKS,
      allowFallback: true,
      maxTokens: 1800,
      timeoutMs: 12_000,
      parts: [{ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }],
    });
  } catch (error) {
    if (error instanceof AIProviderError) {
      throw new HttpError(503, `Receipt analysis unavailable (${error.code}).`);
    }
    throw error;
  }

  const list = Array.isArray(parsed) ? parsed : [];
  return list.map(sanitizeReceiptItem);
};

const handleParseVoice = async (env: Env, body: JsonRecord) => {
  const audioBase64 = toStringOrEmpty(body.audioBase64);
  const mimeType = toStringOrEmpty(body.mimeType) || 'audio/wav';
  if (!audioBase64) return [];

  const prompt = [
    'Transcribe this grocery voice command, then extract grocery items.',
    'Return JSON only in this exact format:',
    '{"transcript":"","items":[{"name":"","quantity":1,"unit":"pcs","price":0,"category":"Other","imageKeyword":"","canonicalName":""}]}',
    'Rules:',
    '- transcript must contain what was actually spoken',
    '- items must include ONLY products explicitly mentioned in transcript',
    '- no inferred/default examples',
    '- names in English, canonicalName singular English',
    '- category must be one of Produce,Fruits,Dairy,Meat,Pantry,Beverages,Frozen,Other',
  ].join('\n');

  let parsed: unknown;
  try {
    parsed = await aiJson(env, prompt, {
      model: GEMINI_PRIMARY_MODEL,
      modelFallbacks: GEMINI_MODEL_FALLBACKS,
      allowFallback: true,
      maxTokens: 1600,
      timeoutMs: 14_000,
      parts: [{ inlineData: { mimeType, data: audioBase64 } }],
    });
  } catch (error) {
    if (error instanceof AIProviderError) {
      throw new HttpError(503, `Voice parsing unavailable (${error.code}).`);
    }
    throw error;
  }

  const voicePayload = parseVoiceModelResponse(parsed);
  const normalizedTranscript = normalizeProductText(voicePayload.transcript);
  if (!normalizedTranscript) {
    console.log(
      JSON.stringify({
        event: 'voice_parse_rejected',
        reason: 'empty_transcript',
      })
    );
    return [];
  }

  const sanitizedItems = voicePayload.items.map(sanitizeReceiptItem);
  const verifiedItems = sanitizedItems.filter(item => {
    const keyword = normalizeFoodTerm(item.canonicalName || item.imageKeyword || item.name);
    const matched = transcriptContainsKeyword(normalizedTranscript, keyword);
    if (!matched) {
      console.log(
        JSON.stringify({
          event: 'voice_item_rejected',
          transcript: normalizedTranscript,
          itemName: item.name,
          normalizedKeyword: keyword,
          reason: 'keyword_not_found_in_transcript',
        })
      );
    }
    return matched;
  });

  return dedupeVoiceItems(verifiedItems);
};

const handleSmartItem = async (env: Env, body: JsonRecord) => {
  const itemName = toStringOrEmpty(body.itemName);
  if (!itemName) {
    return { category: 'Other', imageKeyword: 'grocery', canonicalName: 'item' };
  }

  const prompt = [
    `Analyze grocery item: "${itemName}"`,
    'Return JSON only: {"category":"Other","imageKeyword":"","canonicalName":""}',
    'Rules: canonicalName must be singular English noun; imageKeyword must be concise food keyword.',
  ].join('\n');

  const parsed = await aiJsonOrDefault(env, prompt, {
    model: GEMINI_PRIMARY_MODEL,
    modelFallbacks: GEMINI_MODEL_FALLBACKS,
    allowFallback: true,
    maxTokens: 400,
  }, {
    category: 'Other',
    imageKeyword: itemName,
    canonicalName: itemName.toLowerCase(),
  });

  const source = parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : {};
  return {
    category: normalizeCategory(source.category),
    imageKeyword: toStringOrEmpty(source.imageKeyword) || itemName,
    canonicalName: toStringOrEmpty(source.canonicalName) || itemName.toLowerCase(),
  };
};

const handleGenerateRecipe = async (env: Env, body: JsonRecord) => {
  const ingredientName = toStringOrEmpty(body.ingredientName);
  if (!ingredientName) throw new HttpError(400, 'ingredientName is required');

  const prompt = [
    `Create one practical, appetizing home-cook recipe centered on: ${ingredientName}`,
    'Return JSON only with this schema:',
    '{"title":"","ingredients":[{"name":"","quantity":"","canonicalName":""}],"instructions":[""],"imageKeyword":"","cookingTime":30}',
    'Rules:',
    '- title must be a specific finished dish name (not "<ingredient> recipe" and not "cooked <ingredient>")',
    '- include the requested ingredient plus at least 2 additional ingredients',
    '- include at least 3 cooking instruction steps',
    '- ingredient names in English, canonicalName singular English',
    '- imageKeyword must describe the finished plated dish in 2-5 words',
    '- if ingredient is usually eaten raw, still provide a prepared dish or drink',
  ].join('\n');

  const parsed = await aiJsonOrDefault(env, prompt, {
    model: GEMINI_PRIMARY_MODEL,
    modelFallbacks: GEMINI_MODEL_FALLBACKS,
    allowFallback: true,
    maxTokens: 1400,
  }, {
    title: `${capitalizeFirst(ingredientName)} Dish`,
    ingredients: [
      { name: ingredientName, quantity: '1 cup', canonicalName: normalizeFoodTerm(ingredientName) },
      { name: 'Onion', quantity: '1/2 chopped', canonicalName: 'onion' },
      { name: 'Olive Oil', quantity: '1 tbsp', canonicalName: 'oil' },
    ],
    instructions: ['Prep ingredients.', 'Cook in a pan until tender.', 'Serve warm.'],
    imageKeyword: `${normalizeFoodTerm(ingredientName)} cooked dish`,
    cookingTime: 20,
  });

  let recipe = sanitizeRecipe(parsed);
  if (isWeakRecipeOutput(recipe, ingredientName)) {
    recipe = sanitizeRecipe(buildPracticalFallbackRecipe(ingredientName));
  }

  return {
    title: recipe.title,
    ingredients: (recipe.ingredients as JsonRecord[]).map(ingredient => ({
      name: toStringOrEmpty(ingredient.name),
      quantity: toStringOrEmpty(ingredient.quantity),
      canonicalName: toStringOrEmpty(ingredient.canonicalName),
    })),
    instructions: recipe.instructions,
    imageKeyword: recipe.imageKeyword,
    cookingTime: recipe.cookingTime,
  };
};

const handleParseRecipe = async (env: Env, body: JsonRecord) => {
  const input = toStringOrEmpty(body.input);
  if (!input) throw new HttpError(400, 'input is required');

  const prompt = [
    'Parse this recipe-like text into normalized JSON.',
    `Input: ${input}`,
    'Return JSON only with this schema:',
    '{"title":"","ingredients":[{"name":"","quantity":"","canonicalName":"","category":"Other"}],"instructions":[""],"imageKeyword":"","cookingTime":45}',
    'Rules: normalize multilingual text to English ingredient names when possible.',
  ].join('\n');

  const parsed = await aiJsonOrDefault(env, prompt, {
    model: GEMINI_PRIMARY_MODEL,
    modelFallbacks: GEMINI_MODEL_FALLBACKS,
    allowFallback: true,
    maxTokens: 1600,
  }, {
    title: 'Recipe',
    ingredients: [],
    instructions: ['Follow your provided recipe text.'],
    imageKeyword: 'food',
    cookingTime: 45,
  });

  const parsedRecipe = sanitizeRecipe(parsed);
  const recipe = sanitizeRecipe(applyParsedRecipeQualityFallbacks(parsedRecipe, input));
  const dishSubject = toStringOrEmpty(recipe.title) || toStringOrEmpty(recipe.imageKeyword) || 'prepared meal';
  const imagePrompt = `${dishSubject} plated cooked dish`;
  const imageUrl = await resolveBestImage(env, null, imagePrompt, 'recipe');

  return {
    ...recipe,
    imageUrl,
  };
};

const handleCategorizeBatch = async (env: Env, body: JsonRecord) => {
  const itemNames = Array.isArray(body.itemNames)
    ? body.itemNames.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  if (itemNames.length === 0) return {};

  const prompt = [
    'Categorize grocery item names.',
    `Names: ${JSON.stringify(itemNames)}`,
    'Return JSON only in this format:',
    '{"mapping":[{"name":"","category":"Other"}]}',
    'Category must be one of Produce,Fruits,Dairy,Meat,Pantry,Beverages,Frozen,Other.',
  ].join('\n');

  const parsed = await aiJsonOrDefault(env, prompt, {
    model: GEMINI_PRIMARY_MODEL,
    modelFallbacks: GEMINI_MODEL_FALLBACKS,
    allowFallback: true,
    maxTokens: 900,
  }, { mapping: [] });

  const record = parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : {};
  const mapping = Array.isArray(record.mapping) ? record.mapping : [];

  const out: Record<string, string> = {};
  for (const entry of mapping) {
    const source = entry && typeof entry === 'object' ? (entry as JsonRecord) : {};
    const name = toStringOrEmpty(source.name);
    if (!name) continue;
    out[name] = normalizeCategory(source.category);
  }

  return out;
};

const handleGenerateImage = async (env: Env, body: JsonRecord) => {
  const db = ensureDb(env);
  const prompt = toStringOrEmpty(body.prompt);
  const mode = toStringOrEmpty(body.mode).toLowerCase() === 'recipe' ? 'recipe' : 'product';
  const normalizedKeyword = normalizeFoodTerm(prompt);
  if (!prompt || (mode === 'product' && normalizedKeyword === 'food')) return { image: null };
  const imagePrompt = mode === 'recipe' ? prompt : normalizedKeyword;

  const image =
    (await resolveBestImage(env, db, imagePrompt, mode)) ||
    (mode === 'product' ? await getWikimediaImage(normalizedKeyword || prompt) : null) ||
    null;
  return {
    image,
    cacheKey: mode === 'product' ? normalizedKeyword : null,
    mode,
    source: image ? inferImageSource(image) : 'unknown',
  };
};

const fallbackRank = (intent: string, items: Array<{ id: string; text: string }>) => {
  const ranked = items
    .map(item => ({
      id: item.id,
      score: semanticScore(intent, item.text),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked;
};

const handleRankContent = async (env: Env, body: JsonRecord) => {
  const intent = toStringOrEmpty(body.intent);
  const contentType = toStringOrEmpty(body.contentType) || 'content';
  const itemsInput = Array.isArray(body.items) ? body.items : [];

  const items = itemsInput
    .map(entry => {
      const source = entry && typeof entry === 'object' ? (entry as JsonRecord) : {};
      const id = toStringOrEmpty(source.id);
      const text = toStringOrEmpty(source.text);
      return { id, text };
    })
    .filter(entry => entry.id && entry.text)
    .slice(0, 200);

  if (items.length === 0) {
    return { ranked: [] };
  }

  const fallback = fallbackRank(intent, items);

  try {
    const prompt = [
      `Rank ${contentType} candidates for user intent with semantic understanding.`,
      `Intent: ${intent || 'general relevance'}`,
      'Candidates JSON:',
      JSON.stringify(items),
      'Return JSON only with this schema:',
      '{"ranked":[{"id":"candidate-id","score":0.0}]}',
      'Rules: score in [0,1], include only known ids, multilingual and plural variants should map semantically.',
    ].join('\n');

    const ai = await generateAIResponse(
      prompt,
      {
        task: 'json',
        geminiModel: GEMINI_PRIMARY_MODEL,
        geminiModelFallbacks: GEMINI_MODEL_FALLBACKS,
        allowFallback: true,
        timeoutMs: 9000,
        maxTokens: 1200,
      },
      env
    );

    const parsed = extractJson(ai.text);
    const record = parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : {};
    const ranked = Array.isArray(record.ranked) ? record.ranked : [];

    const allowedIds = new Set(items.map(item => item.id));
    const scoreById: Record<string, number> = {};

    for (const entry of ranked) {
      const source = entry && typeof entry === 'object' ? (entry as JsonRecord) : {};
      const id = toStringOrEmpty(source.id);
      if (!allowedIds.has(id)) continue;
      const score = Math.max(0, Math.min(1, toNumberOrDefault(source.score, 0)));
      scoreById[id] = score;
    }

    const merged = items
      .map(item => ({
        id: item.id,
        score: scoreById[item.id] ?? semanticScore(intent, item.text),
      }))
      .sort((a, b) => b.score - a.score);

    return { ranked: merged };
  } catch {
    return { ranked: fallback };
  }
};

const router = async (request: Request, env: Env): Promise<Response> => {
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(origin, env) });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, origin, env);
  }

  const body = await readJson(request);

  try {
    switch (url.pathname) {
      case '/api/auth/login':
        return json(await handleAuthLogin(env, body), 200, origin, env);
      case '/api/auth/session':
        return json(await handleAuthSession(env, body), 200, origin, env);
      case '/api/auth/logout':
        return json(await handleAuthLogout(env, body), 200, origin, env);
      case '/api/houses/create':
        return json(await handleHouseCreate(env, body), 200, origin, env);
      case '/api/houses/join':
        return json(await handleHouseJoin(env, body), 200, origin, env);
      case '/api/houses/fetch':
        return json(await handleHouseFetch(env, body), 200, origin, env);
      case '/api/houses/update':
        return json(await handleHouseUpdate(env, body), 200, origin, env);
      case '/api/houses/rename':
        return json(await handleHouseRename(env, body), 200, origin, env);
      case '/api/houses/change-password':
        return json(await handleHouseChangePassword(env, body), 200, origin, env);
      case '/api/houses/delete':
        return json(await handleHouseDelete(env, body), 200, origin, env);
      case '/api/houses/members':
        return json(await handleHouseMembers(env, body), 200, origin, env);
      case '/api/houses/remove-member':
        return json(await handleHouseRemoveMember(env, body), 200, origin, env);
      case '/api/houses/activity':
        return json(await handleHouseActivity(env, body), 200, origin, env);
      case '/api/gemini/analyze-receipt':
        return json(await handleAnalyzeReceipt(env, body), 200, origin, env);
      case '/api/gemini/parse-voice':
        return json(await handleParseVoice(env, body), 200, origin, env);
      case '/api/gemini/smart-item':
        return json(await handleSmartItem(env, body), 200, origin, env);
      case '/api/gemini/generate-recipe':
        return json(await handleGenerateRecipe(env, body), 200, origin, env);
      case '/api/gemini/parse-recipe':
        return json(await handleParseRecipe(env, body), 200, origin, env);
      case '/api/gemini/categorize-batch':
        return json(await handleCategorizeBatch(env, body), 200, origin, env);
      case '/api/gemini/generate-image':
        return json(await handleGenerateImage(env, body), 200, origin, env);
      case '/api/gemini/rank-content':
        return json(await handleRankContent(env, body), 200, origin, env);
      default:
        return json({ error: 'Not found' }, 404, origin, env);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status, origin, env);
    }

    if (error instanceof AIProviderError) {
      return json(
        {
          error: error.message,
          code: error.code,
          provider: error.provider,
          retryable: error.retryable,
        },
        statusFromAIError(error),
        origin,
        env
      );
    }

    const message = error instanceof Error ? error.message : 'Unexpected server error';
    return json({ error: message }, 500, origin, env);
  }
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return router(request, env);
  },
};
