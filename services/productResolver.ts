import { getWikimediaImage, NEUTRAL_PLACEHOLDER_IMAGE_URL } from './wikimediaService';
import { Category } from '../types';

// --- Types ---

export interface CanonicalResult {
  canonicalId: string;
  canonicalName: string; // English, singular
  variantType: string;   // e.g., 'cow', 'almond', 'green'
  confidence: number;    // 0 to 1
  isNew: boolean;        // Helper to know if we created a record on the fly
  category: string;
}

interface ProductDefinition {
  baseName: string;      // English singular (e.g., "apple")
  variant: string;       // (e.g., "default", "green", "almond")
  category: string;      // broad category for ID namespacing
  synonyms: string[];    // Multilingual list: ['apple', 'яблоко', 'olma']
}

interface ImageRecord {
  url: string;
  createdAt: number;
}

// --- Configuration ---

const FUZZY_THRESHOLD = 3; // Max edit distance for a match

// --- 1. The Knowledge Database (In-Memory) ---
// Categories MUST match the App's Category type (Fruits, Dairy, Produce, etc.)
const PRODUCT_KNOWLEDGE_GRAPH: ProductDefinition[] = [
  {
    baseName: 'apple',
    variant: 'default',
    category: 'Fruits',
    synonyms: ['apple', 'apples', 'green apple', 'red apple', 'fuji apple', 'яблоко', 'olma', 'apfel', 'manzana']
  },
  {
    baseName: 'banana',
    variant: 'default',
    category: 'Fruits',
    synonyms: ['banana', 'bananas', 'банан', 'banan', 'plátano']
  },
  {
    baseName: 'milk',
    variant: 'cow',
    category: 'Dairy',
    synonyms: ['milk', 'whole milk', 'cow milk', '2% milk', 'молоко', 'sut', 'leche', 'lait']
  },
  {
    baseName: 'milk',
    variant: 'almond',
    category: 'Dairy', // Mapped to Dairy for simplicity
    synonyms: ['almond milk', 'nut milk', 'миндальное молоко']
  },
  {
    baseName: 'milk',
    variant: 'oat',
    category: 'Dairy',
    synonyms: ['oat milk', 'oatmilk', 'овсяное молоко']
  },
  {
    baseName: 'bread',
    variant: 'default',
    category: 'Pantry',
    synonyms: ['bread', 'loaf', 'white bread', 'wheat bread', 'sourdough', 'хлеб', 'non', 'pan']
  },
  {
    baseName: 'egg',
    variant: 'default',
    category: 'Dairy',
    synonyms: ['egg', 'eggs', 'large eggs', 'brown eggs', 'яйцо', 'yumurta', 'huevo']
  },
  {
    baseName: 'chicken',
    variant: 'breast',
    category: 'Meat',
    synonyms: ['chicken', 'chicken breast', 'chicken fillet', 'курица', 'tovuq', 'pollo']
  },
  {
    baseName: 'rice',
    variant: 'default',
    category: 'Pantry',
    synonyms: ['rice', 'white rice', 'jasmine rice', 'рис', 'guruch', 'arroz']
  },
  {
    baseName: 'potato',
    variant: 'default',
    category: 'Produce',
    synonyms: ['potato', 'potatoes', 'russet potato', 'картофель', 'kartoshka', 'papa']
  },
  {
    baseName: 'tomato',
    variant: 'default',
    category: 'Produce',
    synonyms: ['tomato', 'tomatoes', 'tomat', 'помидор', 'pomidor']
  }
];

// --- 2. Caching Layer (In-Memory) ---
const imageCache = new Map<string, ImageRecord>();

// --- 3. Core Logic Class ---
export class ProductCanonicalizer {

  /**
   * Step 1: Normalize Input
   * Removes accents, lowercases, trims, handles standard punctuation.
   */
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
      .replace(/[^a-z0-9\s]/g, '') // Remove special chars
      .replace(/\s+/g, ' ') // Collapse whitespace
      .trim();
  }

  /**
   * Levenshtein Distance for fuzzy matching typos
   */
  private getEditDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            Math.min(
              matrix[i][j - 1] + 1, // insertion
              matrix[i - 1][j] + 1  // deletion
            )
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * Step 2 & 3: Match Canonical Product
   * Scans the Knowledge Graph for exact matches, then fuzzy matches.
   */
  public resolveProduct(rawInput: string): CanonicalResult {
    const normalized = this.normalizeText(rawInput);
    
    let bestMatch: ProductDefinition | null = null;
    let bestScore = Infinity; // Lower is better (0 is exact)

    // A. Direct Synonym Lookup
    for (const def of PRODUCT_KNOWLEDGE_GRAPH) {
      for (const syn of def.synonyms) {
        // 1. Exact Match
        if (syn === normalized) {
          return this.formatResult(def, 1.0, false);
        }

        // 2. Fuzzy Match (Only if not exact)
        const distance = this.getEditDistance(normalized, syn);
        if (distance < bestScore && distance <= FUZZY_THRESHOLD) {
          // Additional check: Don't fuzzy match very short words easily (e.g. "pot" vs "pet")
          if (normalized.length > 3 || distance === 1) {
             bestScore = distance;
             bestMatch = def;
          }
        }
      }
    }

    // B. Handle Fuzzy Result
    if (bestMatch && bestScore !== Infinity) {
      const confidence = 1 - (bestScore / Math.max(normalized.length, 1));
      return this.formatResult(bestMatch, parseFloat(confidence.toFixed(2)), false);
    }

    // C. No Match
    return this.createCanonicalProductIfMissing(normalized);
  }

  /**
   * Helper to format the output JSON
   */
  private formatResult(def: ProductDefinition, confidence: number, isNew: boolean): CanonicalResult {
    // Generate Stable ID: category-basename-variant
    const cleanVariant = def.variant === 'default' ? '' : `-${def.variant}`;
    const canonicalId = `${def.category}-${def.baseName}${cleanVariant}`.toLowerCase(); // Ensure ID is URL safe/lowercase
    
    return {
      canonicalId: canonicalId,
      canonicalName: def.baseName,
      variantType: def.variant,
      confidence,
      isNew,
      category: def.category
    };
  }

  /**
   * Step 4: Handle Unknown Products
   * Categorizes as "unknown" initially.
   */
  public createCanonicalProductIfMissing(normalizedInput: string, category: string = 'unknown'): CanonicalResult {
    const fallbackId = `${category}-${normalizedInput.replace(/\s/g, '-')}`.toLowerCase();
    
    return {
      canonicalId: fallbackId,
      canonicalName: normalizedInput,
      variantType: 'default',
      confidence: 0.0,
      isNew: true,
      category
    };
  }

  /**
   * Step 5: Image Caching & Retrieval
   */
  public async getOrGenerateImage(product: CanonicalResult): Promise<string | null> {
    const { canonicalId, canonicalName } = product;

    // 1. Check Cache
    if (imageCache.has(canonicalId)) {
      return imageCache.get(canonicalId)!.url;
    }

    // 2. Generate image using strict verified retrieval only.
    // Requirement: normalized entity keyword must be the only retrieval query,
    // and mismatched results must be rejected.
    const imageUrl = (await getWikimediaImage(canonicalName)) || NEUTRAL_PLACEHOLDER_IMAGE_URL;

    if (imageUrl) {
        // 3. Store in Cache
        imageCache.set(canonicalId, {
        url: imageUrl,
        createdAt: Date.now()
        });
    }

    return imageUrl;
  }
}

export const productResolver = new ProductCanonicalizer();
