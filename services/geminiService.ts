import { GoogleGenAI, LiveServerMessage, Modality, Tool, Type } from "@google/genai";
import { Category } from '../types';
import {
  getWikimediaImage,
  normalizeFoodInput,
  NEUTRAL_PLACEHOLDER_IMAGE_URL,
  isImageSourceRelevantToKeyword,
} from './wikimediaService';

let liveClient: GoogleGenAI | null = null;

const isDirectLiveEnabled = (): boolean => {
  return String(import.meta.env.VITE_ENABLE_DIRECT_GEMINI_LIVE || '').toLowerCase() === 'true';
};

const getBrowserGeminiKey = (): string | undefined => {
  const sharedKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  // Backward compatibility for older local setups.
  const legacyLiveKey = import.meta.env.VITE_GEMINI_LIVE_API_KEY as string | undefined;
  return sharedKey || legacyLiveKey;
};

export const isLiveAssistantConfigured = (): boolean => {
  if (!isDirectLiveEnabled()) {
    return false;
  }
  return Boolean(getBrowserGeminiKey());
};

const getLiveClient = (): GoogleGenAI => {
  if (!isDirectLiveEnabled()) {
    throw new Error('Direct Gemini Live is disabled. Use worker-backed voice mode.');
  }

  const apiKey = getBrowserGeminiKey();

  if (!apiKey) {
    throw new Error('Live assistant key is missing. Set VITE_GEMINI_API_KEY and enable VITE_ENABLE_DIRECT_GEMINI_LIVE=true.');
  }

  if (!liveClient) {
    liveClient = new GoogleGenAI({ apiKey });
  }

  return liveClient;
};

const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/$/, '');

const buildApiUrl = (path: string) => `${apiBase}/api/gemini/${path}`;

const postJson = async <T>(path: string, payload: unknown): Promise<T> => {
  const response = await fetch(buildApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
};

interface ReceiptItem {
  name: string;
  quantity: number;
  unit: string;
  price: number;
  category: Category;
  imageKeyword: string;
  canonicalName: string;
}

export const analyzeReceipt = async (imageBase64: string): Promise<ReceiptItem[]> => {
  return postJson<ReceiptItem[]>('analyze-receipt', { imageBase64 });
};

export const parseVoiceInput = async (audioBase64: string, mimeType: string = 'audio/wav'): Promise<ReceiptItem[]> => {
  return postJson<ReceiptItem[]>('parse-voice', { audioBase64, mimeType });
};

export const getSmartItemDetails = async (itemName: string): Promise<{ category: Category, imageKeyword: string, canonicalName: string }> => {
  try {
    return await postJson<{ category: Category, imageKeyword: string, canonicalName: string }>('smart-item', { itemName });
  } catch (error) {
    console.error('Smart identification failed', error);
    return { category: 'Other', imageKeyword: 'grocery', canonicalName: itemName.toLowerCase() };
  }
};

export const generateRecipeForIngredient = async (ingredientName: string): Promise<{
  title: string;
  ingredients: Array<{ name: string; quantity: string; canonicalName: string }>;
  instructions: string[];
  imageKeyword: string;
  cookingTime: number;
}> => {
  return postJson('generate-recipe', { ingredientName });
};

export const parseRecipe = async (input: string): Promise<{
  title: string;
  ingredients: Array<{ name: string; quantity: string; canonicalName: string; category?: Category }>;
  instructions: string[];
  imageKeyword: string;
  cookingTime: number;
  imageUrl?: string | null;
}> => {
  return postJson('parse-recipe', { input });
};

const isLikelyImageSource = (value: string): boolean => {
  if (!value) return false;
  if (value.startsWith('data:image/')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

const isNeutralPlaceholderImage = (value: string): boolean => {
  if (!value) return false;
  if (value === NEUTRAL_PLACEHOLDER_IMAGE_URL) return true;
  return value.startsWith('data:image/svg+xml') && value.includes('No%20Image');
};

export const generateGroceryImage = async (prompt: string): Promise<string | null> => {
  const normalizedKeyword = normalizeFoodInput(prompt);
  const isLikelyRecipePrompt = /\b(dish|meal|recipe|plated|serving|cooked)\b/i.test(prompt);
  const requestPrompt = isLikelyRecipePrompt ? prompt.trim() : normalizedKeyword;

  try {
    const response = await postJson<{
      image: string | null;
      cacheKey?: string | null;
      mode?: 'product' | 'recipe' | null;
      source?: 'gemini' | 'supabase' | 'wikimedia' | 'unknown' | null;
    }>('generate-image', {
      prompt: requestPrompt,
      mode: isLikelyRecipePrompt ? 'recipe' : 'product',
    });
    if (response.image && isNeutralPlaceholderImage(response.image)) {
      console.warn('[ImageMismatch] Backend returned neutral placeholder; using verified Wikimedia fallback.', {
        input: prompt,
        normalizedKeyword,
      });
    } else if (response.image && isLikelyImageSource(response.image)) {
      const backendCacheKey = normalizeFoodInput(response.cacheKey || normalizedKeyword);
      const cacheKeyMatches = !isLikelyRecipePrompt && backendCacheKey === normalizedKeyword;
      const backendSource = response.source || 'unknown';

      // Trust backend-global cache decisions for product images when cache key matches.
      // This prevents false client-side rejections of reused Supabase URLs.
      if (cacheKeyMatches || backendSource === 'supabase' || backendSource === 'gemini') {
        return response.image;
      }

      const isVerifiableSource = !response.image.startsWith('data:');
      if (
        !isLikelyRecipePrompt &&
        isVerifiableSource &&
        !isImageSourceRelevantToKeyword(response.image, normalizedKeyword)
      ) {
        console.warn('[ImageMismatch] Rejected mismatched generated image from backend.', {
          input: prompt,
          normalizedKeyword,
          selectedImageSource: response.image,
          rejectionReason: 'backend_generated_source_not_relevant_for_keyword',
        });
      } else {
        return response.image;
      }
    } else if (response.image) {
      console.warn('[ImageMismatch] Rejected malformed image source from backend.', {
        input: prompt,
        normalizedKeyword,
        selectedImageSource: response.image,
        rejectionReason: 'backend_returned_non_image_source',
      });
    }
  } catch (error) {
    console.warn(`Image generation failed for "${normalizedKeyword}". Falling back to verified Wikimedia search.`);
  }

  if (isLikelyRecipePrompt) {
    // For recipes, a wrong raw ingredient image is worse than no image.
    return null;
  }

  const wikiImage = await getWikimediaImage(normalizedKeyword);
  return wikiImage || NEUTRAL_PLACEHOLDER_IMAGE_URL;
};

export const categorizeBatch = async (itemNames: string[]): Promise<Record<string, Category>> => {
  try {
    return await postJson<Record<string, Category>>('categorize-batch', { itemNames });
  } catch (error) {
    console.error('Batch categorize failed', error);
    return {};
  }
};

export interface RankContentItem {
  id: string;
  text: string;
}

export interface RankedContentItem {
  id: string;
  score: number;
}

export const rankContentByIntent = async (
  intent: string,
  contentType: 'products' | 'recipes' | 'search',
  items: RankContentItem[]
): Promise<RankedContentItem[]> => {
  if (items.length === 0) return [];

  try {
    const response = await postJson<{
      ranked?: RankedContentItem[];
    }>('rank-content', { intent, contentType, items });

    const ranked = Array.isArray(response.ranked) ? response.ranked : [];
    return ranked
      .filter(item => typeof item.id === 'string' && typeof item.score === 'number')
      .map(item => ({
        id: item.id,
        score: Number.isFinite(item.score) ? item.score : 0,
      }));
  } catch (error) {
    console.error('AI ranking failed', error);
    return [];
  }
};

export const connectToLiveChef = (
  onAudioData: (base64: string) => void,
  onTranscription: (text: string, isUser: boolean) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  onClose: () => void
) => {
  const ai = getLiveClient();
  const tools: Tool[] = [{
    functionDeclarations: [
      {
        name: "updateInventory",
        description: "Update grocery item quantity.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            itemName: { type: Type.STRING, description: "Item name" },
            quantityChange: { type: Type.NUMBER },
            unit: { type: Type.STRING }
          },
          required: ["itemName", "quantityChange"]
        }
      },
      {
        name: "addToShoppingList",
        description: "Add to shopping list.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            item: { type: Type.STRING, description: "Item name" },
            quantity: { type: Type.NUMBER },
          },
          required: ["item"]
        }
      },
      {
        name: "saveRecipe",
        description: "Save a recipe.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            ingredients: { type: Type.ARRAY, items: { type: Type.STRING } },
            instructions: { type: Type.STRING },
            cookingTime: { type: Type.NUMBER }
          },
          required: ["title", "ingredients", "instructions"]
        }
      }
    ]
  }];

  const sessionPromise = ai.live.connect({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    callbacks: {
      onopen: () => console.log('Live session connected'),
      onmessage: async (msg: LiveServerMessage) => {
        const toolCalls = msg.toolCall?.functionCalls ?? [];
        if (toolCalls.length > 0) {
          for (const fc of toolCalls) {
            if (!fc.name) continue;
            const args = fc.args && typeof fc.args === 'object' ? (fc.args as Record<string, unknown>) : {};
            const result = await onToolCall(fc.name, args);
            sessionPromise.then(s => s.sendToolResponse({
              functionResponses: { id: fc.id, name: fc.name, response: { result } }
            }));
          }
        }

        const serverContent = msg.serverContent as unknown as {
          modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
          outputTranscription?: { text?: string };
          inputTranscription?: { text?: string };
          turnComplete?: boolean;
        };

        const audioData = serverContent.modelTurn?.parts?.[0]?.inlineData?.data;
        if (audioData) {
          onAudioData(audioData);
        }
        const outputText = serverContent.outputTranscription?.text;
        if (outputText) {
          onTranscription(outputText, false);
        }
        const inputText = serverContent.inputTranscription?.text;
        if (inputText && serverContent.turnComplete) {
          onTranscription(inputText, true);
        }
      },
      onclose: onClose,
      onerror: (e) => { console.error(e); onClose(); }
    },
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      systemInstruction: { parts: [{ text: "You are a helpful kitchen assistant. Manage inventory, shopping lists, and recipes." }] },
      tools: tools
    }
  });

  return sessionPromise;
};
