import React, { useState, useEffect, useRef } from 'react';
import {
  Refrigerator,
  PlusCircle,
  ShoppingCart,
  PieChart,
  Scan,
  Mic,
  Trash2,
  CheckCircle2,
  ChefHat,
  Sparkles,
  X,
  Search,
  BookOpen,
  ArrowRight,
  Utensils,
  AlertCircle,
  LayoutGrid,
  Bot,
  Beef,
  Carrot,
  Milk,
  Coffee,
  Cookie,
  IceCream,
  Package,
  Apple,
  Minus,
  Plus,
  Cloud,
  WifiOff,
  Edit2,
  Wand2,
  Lightbulb,
  Clock,
  Star,
  Loader2,
  Image as ImageIcon,
  Moon,
  Sun,
  LogOut,
  Copy,
  Home,
  User,
  Wallet,
  Settings,
  Lock,
  KeyRound,
  Check,
  Crown,
  Users,
  UserMinus
} from 'lucide-react';
import { InventoryItem, AppTab, ShoppingItem, Category, ExpenseRecord, Recipe, RecipeIngredient, UserSettings, SavedHouse, UserAccount } from './types';
import {
  analyzeReceipt,
  parseVoiceInput,
  generateRecipeForIngredient,
  parseRecipe,
  categorizeBatch,
  getSmartItemDetails,
  generateGroceryImage,
  rankContentByIntent
} from './services/geminiService';
import { productResolver, CanonicalResult } from './services/productResolver';
import {
  normalizeFoodInput,
  NEUTRAL_PLACEHOLDER_IMAGE_URL,
  isImageSourceRelevantToKeyword,
} from './services/wikimediaService';
import {
  createFamilyDatabase,
  fetchFamilyData,
  updateFamilyData,
  loginAccount,
  joinFamilyHouse,
  validateSession,
  logoutSession,
  renameHouse,
  changeHousePassword,
  deleteHouse as deleteHouseFromCloud,
  fetchHouseMembers,
  removeHouseMember,
  fetchHouseActivity,
  AppState,
  AuthSeed,
  HouseMember,
  HouseActivityEvent,
} from './services/storageService';
import { ExpenseAnalytics } from './components/Charts';
import LiveAssistant from './components/LiveAssistant';
import { uploadImage, UploadImageError } from './services/uploadImage';

function useStickyState<T>(defaultValue: T, key: string): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState(() => {
    try {
      const stickyValue = window.localStorage.getItem(key);
      return stickyValue !== null ? JSON.parse(stickyValue) : defaultValue;
    } catch (error) {
      return defaultValue;
    }
  });
  React.useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`[StickyState] Failed to persist key "${key}"`, error);
    }
  }, [key, value]);
  return [value, setValue];
}

const compressImage = async (base64Str: string, maxWidth = 300, quality = 0.7): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = base64Str;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(maxWidth / img.width, 1);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } else {
        resolve(base64Str);
      }
    };
    img.onerror = () => resolve(base64Str);
  });
};

// Image upload pipeline:
// - Keep UI instant by rendering the current imageUrl immediately.
// - Convert source -> data URL -> compress -> upload to Supabase Storage.
// - Only the anon key is used on the client; service role + Gemini keys stay server-side.
const isDataUrl = (value: string): boolean => value.startsWith('data:');

const blobToDataUrl = async (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Failed to convert blob to data URL.'));
    };
    reader.onerror = () => reject(new Error('Failed to convert blob to data URL.'));
    reader.readAsDataURL(blob);
  });
};

const sourceToDataUrl = async (source: string): Promise<string> => {
  if (isDataUrl(source)) {
    return source;
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to fetch image source: ${response.status}`);
  }
  const blob = await response.blob();
  return blobToDataUrl(blob);
};

const prepareAndUploadImage = async (source: string, maxWidth: number, quality: number): Promise<string> => {
  const dataUrl = await sourceToDataUrl(source);
  const compressedDataUrl = await compressImage(dataUrl, maxWidth, quality);
  return uploadImage(compressedDataUrl);
};

const blobToBase64Payload = async (blob: Blob): Promise<string> => {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Failed to encode payload.'));
    };
    reader.onerror = () => reject(new Error('Failed to encode payload.'));
    reader.readAsDataURL(blob);
  });

  const payload = dataUrl.split(',')[1];
  if (!payload) {
    throw new Error('Failed to encode payload.');
  }
  return payload;
};

const createUploadJobId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const resolveProductKeyword = (name: string, canonicalName?: string, imageKeyword?: string): string => {
  return normalizeFoodInput(imageKeyword || canonicalName || name);
};

const isNeutralPlaceholderImage = (value: string | undefined): boolean => {
  if (!value) return false;
  if (value === NEUTRAL_PLACEHOLDER_IMAGE_URL) return true;
  return value.startsWith('data:image/svg+xml') && value.includes('No%20Image');
};

const buildVoiceItemId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `voice-${crypto.randomUUID()}`;
  }
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const createShoppingItemId = (prefix = 'shop'): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const sanitizeShoppingList = (value: unknown): ShoppingItem[] => {
  if (!Array.isArray(value)) return [];

  const usedIds = new Set<string>();
  const normalized: ShoppingItem[] = [];

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const source = entry as Record<string, unknown>;
    const rawName = typeof source.name === 'string' ? source.name.trim() : '';
    if (!rawName) return;

    const rawQuantity =
      typeof source.quantity === 'number'
        ? source.quantity
        : typeof source.quantity === 'string'
          ? Number.parseFloat(source.quantity)
          : 1;
    const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0
      ? Number(rawQuantity.toFixed(2))
      : 1;
    const checked = Boolean(source.checked);

    const rawId = source.id;
    let id = '';
    if (typeof rawId === 'string' && rawId.trim()) id = rawId.trim();
    else if (typeof rawId === 'number' && Number.isFinite(rawId)) id = String(rawId);
    else {
      const fallbackKeyword = normalizeFoodInput(rawName) || 'item';
      id = `legacy-${fallbackKeyword}-${index + 1}`;
    }

    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}-${suffix}`)) {
        suffix += 1;
      }
      id = `${id}-${suffix}`;
    }

    usedIds.add(id);
    normalized.push({
      id,
      name: rawName,
      quantity,
      checked,
    });
  });

  return normalized;
};

const isCanonicalShoppingList = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;

  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return false;
    const source = entry as Record<string, unknown>;

    if (typeof source.id !== 'string' || source.id.trim().length === 0) return false;
    if (seen.has(source.id)) return false;
    seen.add(source.id);

    if (typeof source.name !== 'string' || source.name.trim().length === 0) return false;
    if (typeof source.checked !== 'boolean') return false;
    if (typeof source.quantity !== 'number' || !Number.isFinite(source.quantity) || source.quantity <= 0) {
      return false;
    }
  }

  return true;
};

interface VoiceItemInput {
  name: string;
  quantity: number;
  unit: string;
  category: Category;
  canonicalName?: string;
  imageKeyword?: string;
}

const findInventoryIndexByKeyword = (items: InventoryItem[], rawName: string): number => {
  const incomingKeyword = normalizeFoodInput(rawName);
  if (!incomingKeyword || incomingKeyword === 'food') {
    return items.findIndex(item => item.name.toLowerCase() === rawName.toLowerCase());
  }

  return items.findIndex(item => {
    const itemKeyword = resolveProductKeyword(item.name, item.canonicalName, item.imageKeyword);
    return itemKeyword === incomingKeyword;
  });
};

const mergeVoiceItemsIntoInventory = (
  prev: InventoryItem[],
  parsedItems: VoiceItemInput[],
  addedItemsCollector: Array<{ id: string; name: string; category: Category }>
): InventoryItem[] => {
  const next = [...prev];

  for (const parsed of parsedItems) {
    const trimmedName = parsed.name.trim();
    if (!trimmedName) continue;
    if (!Number.isFinite(parsed.quantity) || parsed.quantity <= 0) continue;

    const matchIndex = findInventoryIndexByKeyword(next, parsed.canonicalName || trimmedName);
    if (matchIndex >= 0) {
      const existing = next[matchIndex];
      const combinedQuantity = Number((existing.quantity + parsed.quantity).toFixed(2));
      next[matchIndex] = {
        ...existing,
        quantity: combinedQuantity,
        unit: existing.unit || parsed.unit || 'pcs',
        category: existing.category === 'Other' ? parsed.category : existing.category,
        canonicalName: existing.canonicalName || parsed.canonicalName,
        imageKeyword: existing.imageKeyword || parsed.imageKeyword,
      };
      continue;
    }

    const newItemId = buildVoiceItemId();
    const newItem: InventoryItem = {
      id: newItemId,
      name: trimmedName,
      quantity: parsed.quantity,
      unit: parsed.unit || 'pcs',
      category: parsed.category || 'Other',
      addedDate: new Date().toISOString().split('T')[0],
      canonicalName: parsed.canonicalName || trimmedName.toLowerCase(),
      imageKeyword: parsed.imageKeyword || normalizeFoodInput(trimmedName),
    };
    next.push(newItem);
    addedItemsCollector.push({ id: newItem.id, name: newItem.name, category: newItem.category });
  }

  return next;
};

const sanitizeInventoryImageSources = (items: InventoryItem[]): InventoryItem[] => {
  return items.map((item) => {
    if (!item.imageUrl || item.imageUrl.startsWith('data:')) return item;
    const keyword = resolveProductKeyword(item.name, item.canonicalName, item.imageKeyword);
    if (keyword === 'food') return item;
    if (isImageSourceRelevantToKeyword(item.imageUrl, keyword)) return item;

    console.warn('[ImageMismatch] Rejected stale product image from state restore.', {
      input: item.name,
      normalizedKeyword: keyword,
      selectedImageSource: item.imageUrl,
      rejectionReason: 'restored_source_not_relevant_for_keyword',
    });

    return { ...item, imageUrl: NEUTRAL_PLACEHOLDER_IMAGE_URL };
  });
};

const buildCloudStateFingerprint = (state: Omit<AppState, 'updatedAt'>): string => {
  return JSON.stringify({
    inventory: state.inventory,
    shoppingList: state.shoppingList,
    recipes: state.recipes,
    expenses: state.expenses,
    houseName: state.houseName || '',
    currency: state.currency || '$',
  });
};

const isSupabasePublicUrl = (url: string) => {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  return Boolean(base && url.startsWith(base));
};

// --- Matching Helpers ---

const parseQuantity = (qtyStr: string): number => {
  // Handle fractions like 1/2
  if (qtyStr.includes('/')) {
    const [num, den] = qtyStr.split('/').map(n => parseFloat(n));
    if (!isNaN(num) && !isNaN(den) && den !== 0) return num / den;
  }
  const match = qtyStr.match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[0]) : 1;
};

const isIngredientMatch = (item: InventoryItem, ing: RecipeIngredient) => {
  if (item.canonicalName && ing.canonicalName && item.canonicalName.toLowerCase() === ing.canonicalName.toLowerCase()) return true;
  const iName = item.name.toLowerCase();
  const rName = ing.name.toLowerCase();
  return iName === rName || rName.includes(iName) || iName.includes(rName);
};

const normalizeRecipeText = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const recipeIngredientSignature = (recipe: Pick<Recipe, 'ingredients'>): string => {
  return recipe.ingredients
    .map(ingredient => normalizeFoodInput(ingredient.canonicalName || ingredient.name))
    .filter(token => token && token !== 'food')
    .sort()
    .join('|');
};

const findDuplicateRecipe = (existing: Recipe[], candidate: Recipe): Recipe | null => {
  const candidateTitle = normalizeRecipeText(candidate.title);
  const candidateSignature = recipeIngredientSignature(candidate);

  return (
    existing.find(recipe => {
      const titleMatches = normalizeRecipeText(recipe.title) === candidateTitle && candidateTitle.length > 0;
      const signatureMatches =
        candidateSignature.length > 0 && recipeIngredientSignature(recipe) === candidateSignature;
      return titleMatches && (signatureMatches || candidateSignature.length === 0);
    }) || null
  );
};

const dedupeRecipes = (recipes: Recipe[]): Recipe[] => {
  const seenKeys = new Set<string>();
  const unique: Recipe[] = [];

  for (const recipe of recipes) {
    const key = `${normalizeRecipeText(recipe.title)}::${recipeIngredientSignature(recipe)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(recipe);
  }

  return unique;
};

const CATEGORY_ORDER: Category[] = [
  'Dairy',
  'Produce',
  'Fruits',
  'Meat',
  'Frozen',
  'Beverages',
  'Pantry',
  'Other'
];

const CATEGORY_ICONS: Record<Category, React.ElementType> = {
  'Produce': Carrot,
  'Fruits': Apple,
  'Dairy': Milk,
  'Meat': Beef,
  'Pantry': Cookie,
  'Beverages': Coffee,
  'Frozen': IceCream,
  'Other': Package
};

const CATEGORY_THEMES: Record<Category, string> = {
  Produce: 'from-emerald-300/40 to-emerald-100/10 text-emerald-700 dark:text-emerald-300',
  Fruits: 'from-rose-300/40 to-rose-100/10 text-rose-700 dark:text-rose-300',
  Dairy: 'from-sky-300/40 to-sky-100/10 text-sky-700 dark:text-sky-300',
  Meat: 'from-red-300/40 to-red-100/10 text-red-700 dark:text-red-300',
  Pantry: 'from-amber-300/40 to-amber-100/10 text-amber-700 dark:text-amber-300',
  Beverages: 'from-teal-300/40 to-teal-100/10 text-teal-700 dark:text-teal-300',
  Frozen: 'from-indigo-300/40 to-indigo-100/10 text-indigo-700 dark:text-indigo-300',
  Other: 'from-slate-300/40 to-slate-100/10 text-slate-700 dark:text-slate-300',
};

// Global liquid-wave background shared across app screens.
const GlobalBackground = () => (
  <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden bg-[#EDF1FF] dark:bg-[#02010A] transition-colors duration-700">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(169,145,255,0.18),transparent_46%),linear-gradient(180deg,#F4F7FF_0%,#E9EEFF_100%)] dark:bg-[radial-gradient(circle_at_50%_42%,rgba(173,99,255,0.24),transparent_44%),linear-gradient(180deg,#02010A_0%,#050414_100%)]" />
    <div className="ff-liquid-aurora-sweep absolute -left-[40%] top-[14%] h-[62%] w-[42%] bg-gradient-to-r from-transparent via-white/55 to-transparent dark:via-cyan-300/30" />
    <div className="ff-liquid-core ff-liquid-core-a absolute left-1/2 top-1/2 h-[58vh] w-[58vh] rounded-full bg-violet-400/20 blur-[96px] dark:bg-violet-500/24" />
    <div className="ff-liquid-core ff-liquid-core-b absolute left-1/2 top-1/2 h-[44vh] w-[44vh] rounded-full bg-cyan-300/16 blur-[84px] dark:bg-cyan-400/18" />
    <div className="ff-liquid-orbit absolute left-1/2 top-1/2 h-[46vh] w-[46vh] rounded-full border border-white/20 dark:border-cyan-300/12">
      <span className="ff-liquid-orbit-dot absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-cyan-300/80 dark:bg-cyan-300/70" />
    </div>
    <div className="ff-liquid-orbit reverse absolute left-1/2 top-1/2 h-[58vh] w-[58vh] rounded-full border border-white/12 dark:border-violet-300/10">
      <span className="ff-liquid-orbit-dot absolute right-[10%] top-[22%] h-2 w-2 rounded-full bg-violet-300/85 dark:bg-violet-300/70" />
    </div>
    <div
      className="ff-liquid-top-right absolute -right-[22%] -top-[28%] h-[58vh] w-[78vw] bg-gradient-to-bl from-indigo-300 via-blue-300 to-cyan-200 opacity-[0.82] dark:from-indigo-500 dark:via-blue-500 dark:to-cyan-400 dark:opacity-95"
    />
    <div
      className="ff-liquid-right-blob absolute -right-[12%] top-[38%] h-[45vh] w-[34vw] bg-gradient-to-bl from-cyan-200 via-sky-200 to-teal-200 opacity-[0.78] dark:from-cyan-400 dark:via-sky-400 dark:to-teal-300 dark:opacity-90"
    />
    <div
      className="ff-liquid-bottom-wave absolute -bottom-[24%] left-1/2 h-[34vh] w-[72vw] -translate-x-1/2 bg-gradient-to-r from-violet-300 via-fuchsia-300 to-indigo-300 opacity-80 dark:from-violet-600 dark:via-fuchsia-500 dark:to-indigo-500 dark:opacity-[0.92]"
    />
    <div
      className="ff-liquid-left-ribbon absolute -left-[11%] -top-[8%] h-[112vh] w-[20vw] bg-gradient-to-b from-violet-300 via-purple-300 to-indigo-300 opacity-[0.72] dark:from-violet-600 dark:via-purple-600 dark:to-indigo-600 dark:opacity-[0.88]"
    />
    <div className="ff-liquid-left-line absolute left-[5.4vw] top-[7%] h-[56vh] w-[1px] bg-cyan-400/75 dark:bg-cyan-300/80" />
    <div className="ff-liquid-ambient ff-liquid-ambient-a absolute -left-24 top-[30%] h-60 w-60 rounded-full bg-violet-400/22 blur-[90px] dark:bg-violet-600/35" />
    <div className="ff-liquid-ambient ff-liquid-ambient-b absolute right-[16%] top-[14%] h-64 w-64 rounded-full bg-cyan-300/20 blur-[88px] dark:bg-cyan-400/25" />
    <div className="ff-auth-vignette absolute inset-0" />
  </div>
);

const Header: React.FC<{
  title: string;
  onAssistant: () => void;
  onSmartOrganize: () => void;
  onRetrySync: () => void;
  onOpenMenu: () => void;
  syncStatus: 'synced' | 'syncing' | 'offline';
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  houseName: string;
}> = ({ title, onAssistant, onSmartOrganize, onRetrySync, onOpenMenu, syncStatus, theme, toggleTheme, houseName }) => (
  <header className="fixed top-0 left-0 right-0 z-20 px-6 py-2 pointer-events-none">
    <div className="absolute inset-0 bg-gradient-to-r from-white/24 via-white/14 to-white/24 dark:from-black/42 dark:via-black/26 dark:to-black/42 backdrop-blur-2xl border-b border-white/28 dark:border-white/10 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.7)]" />
    
    <div className="relative z-10 flex justify-between items-center h-16 max-w-md mx-auto">
      <div className="pointer-events-auto flex items-center gap-3">
        <button
          onClick={onOpenMenu}
          className="w-10 h-10 liquid-bubble rounded-full flex items-center justify-center text-slate-700 dark:text-slate-200 relative transition-transform active:scale-95"
        >
          <Refrigerator size={20} />
          <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border border-white dark:border-slate-800 shadow-sm transition-colors ${syncStatus === 'synced' ? 'bg-emerald-400' : syncStatus === 'syncing' ? 'bg-amber-400' : 'bg-slate-300'}`}>
            {syncStatus === 'syncing' && <div className="absolute inset-0 rounded-full animate-ping bg-amber-400 opacity-75"></div>}
          </div>
        </button>
        <div onClick={onOpenMenu} className="flex flex-col cursor-pointer group">
          <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider text-glass truncate max-w-[120px] flex items-center gap-1 group-hover:text-cyan-500 transition-colors">
             {houseName || "My Home"} <ArrowRight size={8} className="rotate-90" />
          </span>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight leading-none text-glass">{title}</h1>
        </div>
      </div>

      <div className="pointer-events-auto flex gap-3">
        <button onClick={toggleTheme} className="liquid-bubble w-10 h-10 rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 transition-transform">
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        <button onClick={onSmartOrganize} className="liquid-bubble w-10 h-10 rounded-full flex items-center justify-center text-violet-600 dark:text-violet-400 transition-transform">
          <Wand2 size={18} />
        </button>
        <button onClick={onAssistant} className="liquid-bubble w-10 h-10 rounded-full flex items-center justify-center text-slate-700 dark:text-slate-200 relative transition-transform">
          <Bot size={18} />
          <span className="absolute top-2 right-2.5 w-1.5 h-1.5 bg-emerald-500 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse"></span>
        </button>
        <button onClick={onOpenMenu} className="liquid-bubble w-10 h-10 rounded-full flex items-center justify-center text-slate-500 hover:text-slate-800 dark:hover:text-white transition-transform">
           <Settings size={18} />
        </button>
      </div>
    </div>
  </header>
);

const LoadingOverlay: React.FC<{ message: string }> = ({ message }) => (
  <div className="fixed inset-0 bg-white/20 dark:bg-black/30 z-50 flex items-center justify-center backdrop-blur-2xl animate-in fade-in duration-300">
    <div className="liquid-glass p-8 rounded-[2rem] flex flex-col items-center space-y-5 max-w-xs w-full mx-4 shadow-2xl">
      <div className="relative">
        <div className="w-14 h-14 border-[5px] border-cyan-100/50 dark:border-cyan-900/50 border-t-cyan-500 dark:border-t-cyan-400 rounded-full animate-spin"></div>
        <div className="absolute inset-0 flex items-center justify-center">
            <Sparkles size={16} className="text-cyan-500 animate-pulse" />
        </div>
      </div>
      <p className="font-bold text-slate-700 dark:text-slate-200 text-center text-glass">{message}</p>
    </div>
  </div>
);

const AccountAuth: React.FC<{
  onAuthenticated: (result: { account: UserAccount; houses: SavedHouse[] }) => void;
  theme: 'light' | 'dark';
  onThemeSelect: (nextTheme: 'light' | 'dark') => void;
}> = ({ onAuthenticated, theme, onThemeSelect }) => {
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  const [rememberMe, setRememberMe] = useStickyState<boolean>(true, 'foodflow-auth-remember-me');
  const [rememberedUsername, setRememberedUsername] = useStickyState<string>('', 'foodflow-auth-username');
  const [username, setUsername] = useState(() => (rememberMe ? rememberedUsername : ''));
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRememberMeChange = (checked: boolean) => {
    setRememberMe(checked);
    if (!checked) {
      if (rememberedUsername) setRememberedUsername('');
      return;
    }
    const trimmed = username.trim();
    if (trimmed) setRememberedUsername(trimmed);
  };

  const handleSubmit = async () => {
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    if (!trimmedUsername || !trimmedPassword) {
      return alert('Please enter username and password.');
    }
    if (mode === 'create' && !displayName.trim()) {
      return alert('Please enter display name for new account.');
    }

    setLoading(true);
    const result = await loginAccount(
      trimmedUsername,
      trimmedPassword,
      mode === 'create' ? displayName.trim() : undefined
    );
    setLoading(false);

    if (!result) {
      alert(mode === 'create' ? 'Account creation/sign in failed.' : 'Invalid account credentials.');
      return;
    }

    if (rememberMe) {
      setRememberedUsername(trimmedUsername);
    } else if (rememberedUsername) {
      setRememberedUsername('');
    }
    onAuthenticated(result);
  };

  const handleForgotPassword = () => {
    alert('Password reset is not available yet. Please contact your house owner or create a new account.');
  };

  return (
    <div className={`fixed inset-0 z-50 overflow-hidden transition-colors duration-700 ${theme === 'dark' ? 'bg-[#02010A]' : 'bg-[#EEF3FF]'}`}>
      <GlobalBackground />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="ff-liquid-auth-focus absolute left-1/2 top-1/2 h-[56vh] w-[56vh] rounded-full bg-violet-400/18 blur-[100px] dark:bg-violet-500/26" />
        <div className="ff-liquid-auth-focus ff-liquid-auth-focus-b absolute left-1/2 top-1/2 h-[42vh] w-[42vh] rounded-full bg-cyan-300/16 blur-[86px] dark:bg-cyan-400/18" />
      </div>

      <div className="relative z-10 flex min-h-full items-center justify-center px-4 py-6 sm:px-6">
        <div className="relative w-full max-w-md animate-fade-in-up">
          <div className="pointer-events-none absolute -inset-1 rounded-[2rem] bg-gradient-to-br from-violet-400/45 via-cyan-300/30 to-fuchsia-400/45 blur-sm dark:from-violet-600/40 dark:via-cyan-500/25 dark:to-fuchsia-500/35" />
          <section className="relative overflow-hidden rounded-[2rem] border border-white/35 bg-white/30 p-6 shadow-[0_30px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-[24px] dark:border-white/16 dark:bg-black/42 sm:p-8">
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/24 via-transparent to-white/8 dark:from-white/8 dark:to-black/30" />
            <div className="ff-auth-beam pointer-events-none absolute -left-1/2 top-0 h-full w-1/2 bg-gradient-to-r from-transparent via-white/35 to-transparent dark:via-violet-200/20" />

            <div className="relative">
              <div className="flex items-start justify-between gap-4">
                <div className="inline-flex items-center gap-3 rounded-full border border-white/45 bg-white/24 px-3 py-2 dark:border-white/18 dark:bg-white/5">
                  <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-tr from-cyan-400 to-violet-500 text-white shadow-[0_0_24px_rgba(34,211,238,0.5)]">
                    <Refrigerator size={18} />
                    <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.75)]" />
                  </div>
                  <div className="leading-tight">
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-cyan-900 dark:text-cyan-300">FoodFlow</p>
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">Secure access portal</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1 rounded-full border border-white/35 bg-white/22 p-1 backdrop-blur-md dark:border-white/15 dark:bg-white/5">
                  <button
                    type="button"
                    onClick={() => onThemeSelect('light')}
                    aria-pressed={theme === 'light'}
                    className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/80 ${theme === 'light' ? 'bg-white text-slate-900 shadow-[0_4px_12px_-7px_rgba(2,6,23,0.8)]' : 'text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'}`}
                  >
                    <Sun size={12} /> Light
                  </button>
                  <button
                    type="button"
                    onClick={() => onThemeSelect('dark')}
                    aria-pressed={theme === 'dark'}
                    className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/80 ${theme === 'dark' ? 'bg-slate-900 text-white shadow-[0_4px_12px_-7px_rgba(2,6,23,0.9)] dark:bg-white dark:text-slate-900' : 'text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'}`}
                  >
                    <Moon size={12} /> Dark
                  </button>
                </div>
              </div>

              <h1 className="mt-6 text-3xl font-black tracking-tight text-slate-900 dark:text-white">
                {mode === 'signin' ? 'Login' : 'Create account'}
              </h1>
              <p className="mt-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                {mode === 'signin'
                  ? 'Access your home inventory and kitchen intelligence.'
                  : 'Set up your credentials to start managing your home.'}
              </p>

              <div className="mt-6 grid grid-cols-2 gap-2 rounded-[18px] bg-black/6 p-1.5 dark:bg-white/5">
                <button
                  type="button"
                  onClick={() => setMode('signin')}
                  className={`rounded-[14px] px-4 py-2.5 text-sm font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${mode === 'signin' ? 'bg-white text-slate-900 shadow-[0_12px_24px_-14px_rgba(2,6,23,0.95)] dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => setMode('create')}
                  className={`rounded-[14px] px-4 py-2.5 text-sm font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${mode === 'create' ? 'bg-white text-slate-900 shadow-[0_12px_24px_-14px_rgba(2,6,23,0.95)] dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}
                >
                  Sign Up
                </button>
              </div>

              <form
                className="mt-5 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleSubmit();
                }}
              >
                <div>
                  <label htmlFor="auth-username" className="mb-2 ml-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Username
                  </label>
                  <div className="relative">
                    <input
                      id="auth-username"
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      autoFocus
                      placeholder="chef.john"
                      className="w-full rounded-full border border-white/45 bg-white/14 py-3.5 pl-4 pr-11 text-[15px] font-medium text-slate-900 transition-all duration-200 placeholder:text-slate-500 hover:border-cyan-200/80 focus:border-cyan-300 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.18)] focus:outline-none dark:border-white/15 dark:bg-black/25 dark:text-white dark:placeholder:text-slate-500 dark:hover:border-cyan-600/50 dark:focus:border-cyan-400"
                    />
                    <User className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  </div>
                </div>

                {mode === 'create' && (
                  <div>
                    <label htmlFor="auth-display-name" className="mb-2 ml-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Display Name
                    </label>
                    <div className="relative">
                      <input
                        id="auth-display-name"
                        value={displayName}
                        onChange={e => setDisplayName(e.target.value)}
                        autoComplete="name"
                        placeholder="Chef John"
                        className="w-full rounded-full border border-white/45 bg-white/14 py-3.5 pl-4 pr-11 text-[15px] font-medium text-slate-900 transition-all duration-200 placeholder:text-slate-500 hover:border-cyan-200/80 focus:border-cyan-300 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.18)] focus:outline-none dark:border-white/15 dark:bg-black/25 dark:text-white dark:placeholder:text-slate-500 dark:hover:border-cyan-600/50 dark:focus:border-cyan-400"
                      />
                      <Crown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                    </div>
                  </div>
                )}

                <div>
                  <label htmlFor="auth-password" className="mb-2 ml-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="auth-password"
                      value={password}
                      type="password"
                      autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="Account password"
                      className="w-full rounded-full border border-white/45 bg-white/14 py-3.5 pl-4 pr-11 text-[15px] font-medium text-slate-900 transition-all duration-200 placeholder:text-slate-500 hover:border-cyan-200/80 focus:border-cyan-300 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.18)] focus:outline-none dark:border-white/15 dark:bg-black/25 dark:text-white dark:placeholder:text-slate-500 dark:hover:border-cyan-600/50 dark:focus:border-cyan-400"
                    />
                    <KeyRound className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <label htmlFor="auth-remember" className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                    <span className={`flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors ${rememberMe ? 'border-cyan-500 bg-cyan-500 text-white' : 'border-slate-400/70 bg-white/40 dark:border-slate-500 dark:bg-slate-800/60'}`}>
                      {rememberMe && <Check size={12} strokeWidth={3} />}
                    </span>
                    <input
                      id="auth-remember"
                      type="checkbox"
                      checked={rememberMe}
                      onChange={event => handleRememberMeChange(event.target.checked)}
                      className="sr-only"
                    />
                    Remember me
                  </label>

                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-sm font-semibold text-cyan-700 transition-colors hover:text-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white/30 dark:text-cyan-300 dark:hover:text-cyan-200 dark:focus-visible:ring-offset-slate-900/60"
                  >
                    Forgot password?
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-white px-4 py-3.5 text-base font-bold text-slate-900 shadow-[0_16px_32px_-14px_rgba(255,255,255,0.75)] transition-all duration-200 hover:bg-slate-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90 focus-visible:ring-offset-2 focus-visible:ring-offset-black/20 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:focus-visible:ring-offset-black/55"
                >
                  {loading ? (
                    <>
                      <Loader2 className="animate-spin" size={18} />
                      Processing...
                    </>
                  ) : (
                    <>
                      {mode === 'signin' ? 'Login' : 'Create Account'}
                    </>
                  )}
                </button>
              </form>

              <div className="mt-5 flex items-center justify-between gap-2 text-sm">
                <span className="font-medium text-slate-600 dark:text-slate-300">
                  {mode === 'signin' ? 'No account yet?' : 'Already registered?'}
                </span>
                <button
                  type="button"
                  onClick={() => setMode(mode === 'signin' ? 'create' : 'signin')}
                  className="font-bold text-cyan-700 underline decoration-cyan-400/50 underline-offset-4 transition-colors hover:text-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white/30 dark:text-cyan-300 dark:hover:text-cyan-200 dark:focus-visible:ring-offset-slate-900/60"
                >
                  {mode === 'signin' ? 'Register' : 'Sign in'}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

// --- Login / Onboarding Component ---
const Onboarding: React.FC<{
  account: UserAccount | null;
  onComplete: (result: { account: UserAccount; house: SavedHouse; state: AppState }) => void;
  onCancel?: () => void;
  isAddingMore?: boolean;
}> = ({ account, onComplete, onCancel, isAddingMore }) => {
  const [step, setStep] = useState<'welcome' | 'create' | 'join'>('welcome');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [houseName, setHouseName] = useState('');
  const [housePassword, setHousePassword] = useState('');
  const [currency, setCurrency] = useState('$');
  const [houseCode, setHouseCode] = useState('');
  const [loading, setLoading] = useState(false);

  const currencies = ['$', '€', '£', '¥', '₽', '₴', '₹', '₩', 'Fr', 'kr', 'Uzs'];
  const hasSession = Boolean(account?.sessionToken);

  const buildAuthSeed = (): AuthSeed => {
    if (account?.sessionToken) {
      return { sessionToken: account.sessionToken };
    }
    return {
      username: username.trim(),
      displayName: displayName.trim(),
      password: accountPassword,
    };
  };

  const handleCreate = async () => {
    if (!houseName.trim() || !housePassword.trim()) {
      return alert('Please fill in house name and house password.');
    }
    if (!hasSession && (!username.trim() || !displayName.trim() || !accountPassword.trim())) {
      return alert('Please fill in username, display name, and account password.');
    }

    setLoading(true);
    const initialState: AppState = {
      inventory: [],
      shoppingList: [],
      recipes: [],
      expenses: [],
      updatedAt: Date.now(),
      houseName: houseName.trim(),
      currency,
    };

    const result = await createFamilyDatabase(initialState, housePassword, buildAuthSeed());
    if (result) {
      onComplete(result);
    } else {
      alert('Failed to create house. Please try again.');
    }
    setLoading(false);
  };

  const handleJoin = async () => {
    if (!houseCode.trim() || !housePassword.trim()) {
      return alert('Please fill in house code and house password.');
    }
    if (!hasSession && (!username.trim() || !displayName.trim() || !accountPassword.trim())) {
      return alert('Please fill in username, display name, and account password.');
    }

    setLoading(true);
    const normalizedCode = houseCode.trim().toUpperCase();
    const result = await joinFamilyHouse(normalizedCode, housePassword, buildAuthSeed());
    if (result) {
      onComplete(result);
    } else {
      alert('House not found or password is incorrect.');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 bg-slate-100 dark:bg-slate-900 overflow-hidden animate-in fade-in duration-500">
        <GlobalBackground />
        
        {/* Animated Brand */}
        <div className={`transition-all duration-700 ease-out transform ${step === 'welcome' ? 'scale-100 translate-y-0' : 'scale-75 -translate-y-12'}`}>
            <div className="w-24 h-24 bg-gradient-to-tr from-cyan-400 to-violet-500 rounded-[2rem] flex items-center justify-center shadow-2xl mb-6 mx-auto animate-blob">
                <Refrigerator size={48} className="text-white" />
            </div>
            <h1 className="text-4xl font-black text-center text-slate-800 dark:text-slate-100 mb-2 text-glass">FoodFlow</h1>
            {step === 'welcome' && <p className="text-center text-slate-500 dark:text-slate-400 font-medium">Smart Inventory & AI Chef</p>}
        </div>

        <div className="w-full max-w-sm relative z-10 perspective">
            {step === 'welcome' && (
                <div className="liquid-glass rounded-[2.5rem] p-8 shadow-2xl animate-in fade-in slide-in-from-bottom-8 duration-700">
                    <button onClick={() => setStep('create')} className="w-full py-5 mb-4 bg-white text-slate-900 rounded-[24px] font-bold shadow-[0_14px_30px_-14px_rgba(15,23,42,0.6)] dark:bg-white dark:text-slate-900 flex items-center justify-center gap-3 transition-transform active:scale-95 group">
                        <Home size={20} /> Create New House
                    </button>
                    <button onClick={() => setStep('join')} className="w-full py-5 bg-white/40 dark:bg-slate-800/40 text-slate-800 dark:text-white rounded-[24px] font-bold border border-white/20 flex items-center justify-center gap-3 transition-colors hover:bg-white/60 dark:hover:bg-slate-700/60">
                        <User size={20} /> Join Existing House
                    </button>
                    {isAddingMore && onCancel && (
                         <button onClick={onCancel} className="mt-4 w-full py-3 text-slate-500 font-bold hover:text-slate-800 dark:hover:text-slate-300 transition-colors">
                             Cancel
                         </button>
                    )}
                </div>
            )}

            {step === 'create' && (
                <div className="liquid-glass rounded-[2.5rem] p-8 shadow-2xl animate-in fade-in slide-in-from-right-8 duration-500">
                    <button onClick={() => setStep('welcome')} className="mb-6 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center gap-2 text-sm font-bold"><ArrowRight className="rotate-180" size={14} /> Back</button>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 mb-6 text-glass">Create House</h2>
                    
                    <div className="space-y-4">
                        {!hasSession ? (
                          <React.Fragment>
                            <div>
                              <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">Username</label>
                              <input value={username} onChange={e => setUsername(e.target.value)} placeholder="chef.john" className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">Display Name</label>
                              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Chef John" className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">Account Password</label>
                              <div className="relative">
                                <input value={accountPassword} type="password" autoComplete="new-password" onChange={e => setAccountPassword(e.target.value)} placeholder="Account password" className="w-full liquid-concave rounded-[20px] p-4 pl-12 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                              </div>
                            </div>
                          </React.Fragment>
                        ) : (
                          <div className="liquid-concave rounded-[20px] p-4 text-xs font-bold text-slate-500">
                            Signed in as {account?.displayName || account?.username}
                          </div>
                        )}
                        <div>
                             <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">House Name</label>
                             <input value={houseName} onChange={e => setHouseName(e.target.value)} placeholder="The Smiths" className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                        </div>
                        <div>
                             <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">House Password</label>
                             <div className="relative">
                                <input value={housePassword} type="password" autoComplete="new-password" onChange={e => setHousePassword(e.target.value)} placeholder="Secret123" className="w-full liquid-concave rounded-[20px] p-4 pl-12 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                             </div>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">Currency</label>
                            <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
                                {currencies.map(c => (
                                    <button key={c} onClick={() => setCurrency(c)} className={`w-12 h-12 rounded-2xl flex-shrink-0 font-bold flex items-center justify-center transition-all ${currency === c ? 'bg-cyan-500 text-white shadow-lg scale-110' : 'liquid-concave text-slate-500'}`}>
                                        {c}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button onClick={handleCreate} disabled={loading} className="w-full py-5 mt-4 bg-cyan-500 hover:bg-cyan-600 text-white rounded-[24px] font-bold shadow-xl flex items-center justify-center gap-2 transition-all active:scale-95">
                            {loading ? <Loader2 className="animate-spin" /> : <><Sparkles size={18} /> Start Cooking</>}
                        </button>
                    </div>
                </div>
            )}

            {step === 'join' && (
                <div className="liquid-glass rounded-[2.5rem] p-8 shadow-2xl animate-in fade-in slide-in-from-right-8 duration-500">
                     <button onClick={() => setStep('welcome')} className="mb-6 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center gap-2 text-sm font-bold"><ArrowRight className="rotate-180" size={14} /> Back</button>
                     <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 mb-6 text-glass">Join House</h2>
                     <div className="space-y-4">
                        {!hasSession ? (
                          <React.Fragment>
                            <div>
                              <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">Username</label>
                              <input value={username} onChange={e => setUsername(e.target.value)} placeholder="chef.jane" className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">Display Name</label>
                              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Chef Jane" className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                            </div>
                            <div>
                              <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">Account Password</label>
                              <div className="relative">
                                <input value={accountPassword} type="password" autoComplete="new-password" onChange={e => setAccountPassword(e.target.value)} placeholder="Account password" className="w-full liquid-concave rounded-[20px] p-4 pl-12 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                              </div>
                            </div>
                          </React.Fragment>
                        ) : (
                          <div className="liquid-concave rounded-[20px] p-4 text-xs font-bold text-slate-500">
                            Signed in as {account?.displayName || account?.username}
                          </div>
                        )}
                        <div>
                             <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">House Code</label>
                             <div className="relative">
                                <input value={houseCode} onChange={e => setHouseCode(e.target.value)} placeholder="Paste-Code-Here" className="w-full liquid-concave rounded-[20px] p-4 pl-12 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                                <KeyRound className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                             </div>
                        </div>
                        <div>
                             <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase">House Password</label>
                             <div className="relative">
                                <input value={housePassword} type="password" autoComplete="current-password" onChange={e => setHousePassword(e.target.value)} placeholder="Secret123" className="w-full liquid-concave rounded-[20px] p-4 pl-12 text-base outline-none text-slate-900 dark:text-white bg-transparent" />
                                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                             </div>
                        </div>
                        <button onClick={handleJoin} disabled={loading} className="w-full py-5 mt-4 bg-violet-500 hover:bg-violet-600 text-white rounded-[24px] font-bold shadow-xl flex items-center justify-center gap-2 transition-all active:scale-95">
                             {loading ? <Loader2 className="animate-spin" /> : <><ArrowRight size={18} /> Join House</>}
                        </button>
                     </div>
                </div>
            )}
        </div>
    </div>
  );
};

const HouseMenu: React.FC<{
  userSettings: UserSettings;
  onSwitch: (houseId: string) => void;
  onAdd: () => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
  onClose: () => void;
  currentHouseName: string;
  currentHouseRole: 'owner' | 'member' | null;
}> = ({ userSettings, onSwitch, onAdd, onOpenAdmin, onLogout, onClose, currentHouseName, currentHouseRole }) => {
    return (
        <div className="fixed inset-0 bg-white/20 dark:bg-black/50 backdrop-blur-xl z-50 flex items-center justify-center p-6 animate-in fade-in duration-200">
            <div className="liquid-glass rounded-[2.5rem] p-6 w-full max-w-sm shadow-2xl relative">
                <button onClick={onClose} className="absolute top-4 right-4 p-2 bg-white/40 dark:bg-slate-800/40 rounded-full text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors"><X size={20} /></button>
                
                <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 mb-6 text-glass flex items-center gap-2"><Home size={24} /> My Houses</h2>
                
                <div className="space-y-3 mb-6 max-h-[40vh] overflow-y-auto no-scrollbar">
                    {userSettings.savedHouses.map(house => {
                        const isActive = house.id === userSettings.activeHouseId;
                        return (
                            <button 
                                key={house.id} 
                                onClick={() => { if (!isActive) onSwitch(house.id); }}
                                className={`w-full p-4 rounded-[20px] flex items-center justify-between transition-all active:scale-95 ${isActive ? 'bg-white text-slate-900 dark:bg-white dark:text-slate-900 shadow-[0_14px_30px_-14px_rgba(15,23,42,0.6)]' : 'liquid-concave hover:bg-white/40 dark:hover:bg-slate-800/40 text-slate-700 dark:text-slate-300'}`}
                            >
                                <div className="flex flex-col items-start">
                                    <span className="font-bold text-base">{house.name}</span>
                                    <span className={`text-[10px] ${isActive ? 'text-slate-400 dark:text-slate-600' : 'text-slate-400'} font-mono`}>{house.id}</span>
                                </div>
                                {isActive && <CheckCircle2 size={20} className="text-emerald-500" />}
                            </button>
                        );
                    })}
                </div>

                <div className="space-y-3">
                    <div className="liquid-concave rounded-[20px] p-3 text-xs font-bold text-slate-600 dark:text-slate-300 flex items-center justify-between">
                        <span className="truncate">{userSettings.account?.displayName || userSettings.account?.username || 'Account'}</span>
                        <span className="flex items-center gap-1">
                          {currentHouseRole === 'owner' ? <Crown size={14} className="text-amber-500" /> : <User size={14} className="text-slate-400" />}
                          {currentHouseRole === 'owner' ? 'Owner' : 'Member'}
                        </span>
                    </div>
                    <button onClick={onAdd} className="w-full py-4 border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-[24px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 font-bold flex items-center justify-center gap-2 transition-colors">
                        <PlusCircle size={20} /> Add / Join House
                    </button>
                    {currentHouseRole === 'owner' && (
                      <button onClick={onOpenAdmin} className="w-full py-3 bg-amber-100/50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300 rounded-[20px] font-bold text-sm flex items-center justify-center gap-2 transition-colors">
                          <Crown size={16} /> Owner Admin Panel
                      </button>
                    )}
                    
                    <button onClick={() => {
                         if (userSettings.activeHouseId) {
                             navigator.clipboard.writeText(userSettings.activeHouseId);
                             alert("House Code copied to clipboard: " + userSettings.activeHouseId);
                         }
                    }} className="w-full py-3 bg-violet-100/50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 rounded-[20px] font-bold text-sm flex items-center justify-center gap-2 transition-colors">
                        <Copy size={16} /> Copy Current House Code
                    </button>

                    <button onClick={onLogout} className="w-full py-4 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 rounded-[24px] font-bold flex items-center justify-center gap-2 transition-colors mt-4">
                        <LogOut size={20} /> Log Out
                    </button>
                </div>
            </div>
        </div>
    );
};

const HouseAdminPanel: React.FC<{
  house: SavedHouse | null;
  members: HouseMember[];
  activity: HouseActivityEvent[];
  isLoading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onRename: (nextName: string) => Promise<void>;
  onChangePassword: (nextPassword: string) => Promise<void>;
  onRemoveMember: (username: string) => Promise<void>;
  onDeleteHouse: () => Promise<void>;
}> = ({ house, members, activity, isLoading, onClose, onRefresh, onRename, onChangePassword, onRemoveMember, onDeleteHouse }) => {
  const [nextName, setNextName] = useState(house?.name || '');
  const [nextPassword, setNextPassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setNextName(house?.name || '');
    setNextPassword('');
    setDeleting(false);
  }, [house]);

  if (!house) return null;

  return (
    <div className="fixed inset-0 bg-white/20 dark:bg-black/50 backdrop-blur-xl z-[60] flex items-center justify-center p-6 animate-in fade-in duration-200">
      <div className="liquid-glass rounded-[2.5rem] p-6 w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto no-scrollbar">
        <button onClick={onClose} className="absolute top-4 right-4 p-2 bg-white/40 dark:bg-slate-800/40 rounded-full text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors">
          <X size={20} />
        </button>

        <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 mb-5 text-glass flex items-center gap-2">
          <Crown size={22} className="text-amber-500" /> Owner Admin
        </h2>

        <div className="space-y-5">
          <div className="liquid-concave rounded-[20px] p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">House Settings</h3>
              <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-amber-100/50 text-amber-700">Owner</span>
            </div>
            <div className="space-y-3">
              <input
                value={nextName}
                onChange={e => setNextName(e.target.value)}
                placeholder="House name"
                className="w-full liquid-concave rounded-[16px] p-3 text-sm outline-none text-slate-900 dark:text-white bg-transparent"
              />
              <button
                onClick={() => void onRename(nextName)}
                className="w-full py-3 bg-white text-slate-900 dark:bg-white dark:text-slate-900 rounded-[16px] font-bold text-sm shadow-[0_10px_22px_-14px_rgba(15,23,42,0.7)]"
              >
                Rename House
              </button>
              <input
                type="password"
                value={nextPassword}
                onChange={e => setNextPassword(e.target.value)}
                placeholder="New house password"
                className="w-full liquid-concave rounded-[16px] p-3 text-sm outline-none text-slate-900 dark:text-white bg-transparent"
              />
              <button
                onClick={() => void onChangePassword(nextPassword)}
                className="w-full py-3 bg-violet-500 text-white rounded-[16px] font-bold text-sm"
              >
                Change House Password
              </button>
            </div>
          </div>

          <div className="liquid-concave rounded-[20px] p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <Users size={16} /> Members
              </h3>
              <button onClick={onRefresh} className="text-xs font-bold text-cyan-600">
                Refresh
              </button>
            </div>
            {isLoading ? (
              <div className="text-xs text-slate-500">Loading...</div>
            ) : (
              <div className="space-y-2">
                {members.map(member => (
                  <div key={member.username} className="flex items-center justify-between rounded-[14px] bg-white/40 dark:bg-slate-800/40 px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{member.displayName}</div>
                      <div className="text-[10px] font-mono text-slate-500 truncate">{member.username}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${member.role === 'owner' ? 'bg-amber-100/70 text-amber-700' : 'bg-slate-100/70 text-slate-600'}`}>
                        {member.role}
                      </span>
                      {member.role !== 'owner' && (
                        <button
                          onClick={() => void onRemoveMember(member.username)}
                          className="p-1.5 rounded-full bg-rose-100/70 text-rose-600"
                          title="Remove member"
                        >
                          <UserMinus size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="liquid-concave rounded-[20px] p-4">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">Usage / Activity</h3>
            <div className="space-y-2 max-h-40 overflow-y-auto no-scrollbar">
              {activity.length === 0 && <div className="text-xs text-slate-500">No activity yet.</div>}
              {activity.map(event => (
                <div key={event.id} className="rounded-[14px] bg-white/40 dark:bg-slate-800/40 px-3 py-2">
                  <div className="text-xs font-bold text-slate-700 dark:text-slate-200">{event.action}</div>
                  <div className="text-[10px] text-slate-500">
                    {event.actorUsername} • {new Date(event.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {!deleting ? (
            <button
              onClick={() => setDeleting(true)}
              className="w-full py-3 bg-rose-500/10 text-rose-600 rounded-[18px] font-bold text-sm flex items-center justify-center gap-2"
            >
              <Trash2 size={16} /> Delete House
            </button>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-rose-600 font-bold text-center">Delete this house permanently?</div>
              <button
                onClick={() => void onDeleteHouse()}
                className="w-full py-3 bg-rose-500 text-white rounded-[18px] font-bold text-sm"
              >
                Yes, Delete House
              </button>
              <button
                onClick={() => setDeleting(false)}
                className="w-full py-3 bg-slate-200/50 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300 rounded-[18px] font-bold text-sm"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>(AppTab.Fridge);
  const [theme, setTheme] = useStickyState<'light' | 'dark'>('light', 'ef_theme');

  // --- User & Onboarding State ---
  // v8 introduces server-backed account sessions and owner/member roles.
  const [userSettings, setUserSettings] = useStickyState<UserSettings>({ 
      account: null,
      currency: '$', 
      activeHouseId: null, 
      savedHouses: [] 
  }, 'ef_user_settings_v8');

  const [inventory, setInventory] = useStickyState<InventoryItem[]>([], 'ef_inventory_v8');
  const [shoppingListState, setShoppingListState] = useStickyState<ShoppingItem[]>([], 'ef_shopping_v8');
  const shoppingList = React.useMemo(
    () => sanitizeShoppingList(shoppingListState),
    [shoppingListState]
  );
  const setShoppingList = React.useCallback((next: React.SetStateAction<ShoppingItem[]>) => {
    setShoppingListState(prevState => {
      const canonicalPrev = sanitizeShoppingList(prevState);
      const resolved =
        typeof next === 'function'
          ? (next as (prev: ShoppingItem[]) => ShoppingItem[])(canonicalPrev)
          : next;
      return sanitizeShoppingList(resolved);
    });
  }, [setShoppingListState]);
  const [recipes, setRecipes] = useStickyState<Recipe[]>([], 'ef_recipes_v8');
  const [expenses, setExpenses] = useStickyState<ExpenseRecord[]>([], 'ef_expenses_v8');
  const [dismissedItems, setDismissedItems] = useStickyState<string[]>([], 'ef_dismissed_v8');
  const [lastSyncTime, setLastSyncTime] = useStickyState<number>(0, 'ef_last_sync_v8');

  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'offline'>('offline');
  const [authReady, setAuthReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [isLiveAssistantOpen, setLiveAssistantOpen] = useState(false);
  const [showAddRecipe, setShowAddRecipe] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [showFinishModal, setShowFinishModal] = useState(false);
  const [showHouseMenu, setShowHouseMenu] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false); // Used when adding a 2nd house
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [houseMembers, setHouseMembers] = useState<HouseMember[]>([]);
  const [houseActivity, setHouseActivity] = useState<HouseActivityEvent[]>([]);

  const [pendingPurchases, setPendingPurchases] = useState<(ShoppingItem & { finalPrice: number })[]>([]);
  const [activeFilter, setActiveFilter] = useState<Category | 'All'>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recipeSortMode, setRecipeSortMode] = useState<'popular' | 'fastest' | 'rating'>('popular');
  const [inventoryRankScores, setInventoryRankScores] = useState<Record<string, number>>({});
  const [recipeRankScores, setRecipeRankScores] = useState<Record<string, number>>({});
  const [manualAddName, setManualAddName] = useState('');
  const [manualAddCategory, setManualAddCategory] = useState<Category>('Other');
  const [quickAddText, setQuickAddText] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const itemImageJobsRef = useRef<Map<string, string>>(new Map());
  const recipeImageJobsRef = useRef<Map<string, string>>(new Map());
  const inventoryRankRequestRef = useRef(0);
  const recipeRankRequestRef = useRef(0);
  const isMountedRef = useRef(true);
  const syncRequestRef = useRef(0);
  const syncFingerprintRef = useRef('');
  const isHouseHydratingRef = useRef(false);

  useEffect(() => {
    // React StrictMode mounts -> unmounts -> remounts in development.
    // Reset this flag on each mount so async guards do not get stuck false.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      isHouseHydratingRef.current = false;
      itemImageJobsRef.current.clear();
      recipeImageJobsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!isCanonicalShoppingList(shoppingListState)) {
      setShoppingListState(sanitizeShoppingList(shoppingListState));
    }
  }, [shoppingListState, setShoppingListState]);

  useEffect(() => {
    setRecipes(prev => {
      const deduped = dedupeRecipes(prev);
      return deduped.length === prev.length ? prev : deduped;
    });
  }, [userSettings.activeHouseId, setRecipes]);

  useEffect(() => {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');
  const getSessionToken = () => userSettings.account?.sessionToken || '';

  const clearPersistedAppStorage = () => {
    const keys = [
      'ef_user_settings_v8',
      'ef_inventory_v8',
      'ef_shopping_v8',
      'ef_recipes_v8',
      'ef_expenses_v8',
      'ef_dismissed_v8',
      'ef_last_sync_v8',
      // Remove previous versions to avoid accidental stale restores.
      'ef_user_settings_v7',
      'ef_inventory_v7',
      'ef_shopping_v7',
      'ef_recipes_v7',
      'ef_expenses_v7',
      'ef_dismissed_v7',
      'ef_last_sync_v7',
    ];
    keys.forEach(key => window.localStorage.removeItem(key));
  };

  const resetToLoggedOutState = () => {
    syncRequestRef.current = 0;
    syncFingerprintRef.current = '';
    isHouseHydratingRef.current = false;
    clearPersistedAppStorage();
    setUserSettings({ account: null, currency: '$', activeHouseId: null, savedHouses: [] });
    setInventory([]);
    setShoppingList([]);
    setRecipes([]);
    setExpenses([]);
    setDismissedItems([]);
    setLastSyncTime(0);
    setSyncStatus('offline');
    setShowHouseMenu(false);
    setShowAdminPanel(false);
    setHouseMembers([]);
    setHouseActivity([]);
  };

  useEffect(() => {
    let cancelled = false;
    let timedOut = false;
    const restoreTimeout = window.setTimeout(() => {
      if (cancelled || !isMountedRef.current) return;
      timedOut = true;
      console.warn('[Auth] Session restore timed out. Falling back to logged-out state.');
      resetToLoggedOutState();
      setAuthReady(true);
    }, 12_000);

    const bootstrap = async () => {
      try {
        const token = userSettings.account?.sessionToken;
        if (!token) {
          return;
        }

        const snapshot = await validateSession(token);
        if (cancelled || timedOut || !isMountedRef.current) return;

        if (!snapshot) {
          resetToLoggedOutState();
          return;
        }

        setUserSettings(prev => {
          const existingActive = prev.activeHouseId;
          const hasActive = existingActive ? snapshot.houses.some(h => h.id === existingActive) : false;
          return {
            ...prev,
            account: { ...snapshot.account, sessionToken: token },
            savedHouses: snapshot.houses,
            activeHouseId: hasActive ? existingActive : (snapshot.houses[0]?.id || null),
          };
        });
      } catch (error) {
        if (cancelled || timedOut || !isMountedRef.current) return;
        console.error('Session restore failed:', error);
        resetToLoggedOutState();
      } finally {
        window.clearTimeout(restoreTimeout);
        if (!cancelled && !timedOut && isMountedRef.current) {
          setAuthReady(true);
        }
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
      window.clearTimeout(restoreTimeout);
    };
  }, []);

  // Background migration: ensure any non-Supabase image URLs are uploaded once.
  useEffect(() => {
    inventory.forEach(item => {
      if (!item.imageUrl) return;
      const keyword = resolveProductKeyword(item.name, item.canonicalName, item.imageKeyword);
      if (!isImageSourceRelevantToKeyword(item.imageUrl, keyword)) {
        setInventory(prev => prev.map(existing => (
          existing.id === item.id ? { ...existing, imageUrl: NEUTRAL_PLACEHOLDER_IMAGE_URL } : existing
        )));
        return;
      }
      if (isSupabasePublicUrl(item.imageUrl)) return;
      if (itemImageJobsRef.current.has(item.id)) return;
      queueItemImageUpload(item.id, item.imageUrl, 640, 0.9);
    });
    recipes.forEach(recipe => {
      if (!recipe.imageUrl) return;
      if (isSupabasePublicUrl(recipe.imageUrl)) return;
      if (recipeImageJobsRef.current.has(recipe.id)) return;
      queueRecipeImageUpload(recipe.id, recipe.imageUrl, 960, 0.9);
    });
  }, [inventory, recipes]);

  useEffect(() => {
    const intent = searchQuery.trim();
    if (!intent) {
      setInventoryRankScores({});
      return;
    }

    const candidates = inventory
      .filter(item => item.quantity > 0)
      .map(item => ({
        id: item.id,
        text: `${item.name} ${item.canonicalName || ''} ${item.category}`,
      }));

    if (candidates.length === 0) {
      setInventoryRankScores({});
      return;
    }

    const requestId = inventoryRankRequestRef.current + 1;
    inventoryRankRequestRef.current = requestId;

    const timeout = setTimeout(() => {
      void (async () => {
        const ranked = await rankContentByIntent(intent, 'search', candidates);
        if (!isMountedRef.current || inventoryRankRequestRef.current !== requestId) return;

        const nextScores: Record<string, number> = {};
        ranked.forEach(entry => {
          nextScores[entry.id] = entry.score;
        });
        setInventoryRankScores(nextScores);
      })();
    }, 250);

    return () => clearTimeout(timeout);
  }, [searchQuery, inventory]);

  useEffect(() => {
    if (recipes.length === 0) {
      setRecipeRankScores({});
      return;
    }

    const pantrySnapshot = inventory
      .filter(item => item.quantity > 0)
      .slice(0, 40)
      .map(item => item.canonicalName || item.name)
      .join(', ');

    const intentByMode: Record<typeof recipeSortMode, string> = {
      popular: 'rank recipes the household is most likely to cook now based on pantry overlap and cooking history',
      fastest: 'rank recipes by practical speed and low preparation effort',
      rating: 'rank recipes by expected quality and user preference fit',
    };

    const intent = `${intentByMode[recipeSortMode]}. pantry: ${pantrySnapshot}`;
    const candidates = recipes.map(recipe => ({
      id: recipe.id,
      text: `${recipe.title} ${recipe.ingredients.map(ing => ing.name).join(' ')}`,
    }));

    const requestId = recipeRankRequestRef.current + 1;
    recipeRankRequestRef.current = requestId;

    const timeout = setTimeout(() => {
      void (async () => {
        const ranked = await rankContentByIntent(intent, 'recipes', candidates);
        if (!isMountedRef.current || recipeRankRequestRef.current !== requestId) return;

        const nextScores: Record<string, number> = {};
        ranked.forEach(entry => {
          nextScores[entry.id] = entry.score;
        });
        setRecipeRankScores(nextScores);
      })();
    }, 350);

    return () => clearTimeout(timeout);
  }, [recipes, recipeSortMode, inventory]);

  // --- House Management ---

  const applyHouseStateToUI = (data: AppState, houseId: string) => {
    syncRequestRef.current += 1;
    const sanitizedInventory = sanitizeInventoryImageSources(data.inventory);
    syncFingerprintRef.current = buildCloudStateFingerprint({
      inventory: sanitizedInventory,
      shoppingList: sanitizeShoppingList(data.shoppingList),
      recipes: data.recipes,
      expenses: data.expenses,
      houseName: data.houseName,
      currency: data.currency,
    });

    setInventory(sanitizedInventory);
    setShoppingList(sanitizeShoppingList(data.shoppingList));
    setRecipes(data.recipes);
    setExpenses(data.expenses);
    setLastSyncTime(data.updatedAt);
    setSyncStatus('synced');
    setUserSettings(prev => ({
      ...prev,
      currency: data.currency || prev.currency,
      savedHouses: prev.savedHouses.map(h =>
        h.id === houseId ? { ...h, currency: data.currency || h.currency || prev.currency } : h
      ),
    }));
  };

  const handleHouseSwitch = async (houseId: string) => {
    const sessionToken = getSessionToken();
    if (!sessionToken) {
      alert('Session expired. Please sign in again.');
      return;
    }

    setLoadingMessage("Switching House...");
    setIsProcessing(true);
    setShowHouseMenu(false);
    setShowAdminPanel(false);
    isHouseHydratingRef.current = true;
    syncRequestRef.current += 1;
    syncFingerprintRef.current = '';
    setLastSyncTime(0);

    // Clear current local state to avoid cross-house visual bleed.
    setInventory([]);
    setShoppingList([]);
    setRecipes([]);
    setExpenses([]);

    setUserSettings(prev => ({ ...prev, activeHouseId: houseId }));

    try {
      const data = await fetchFamilyData(houseId, sessionToken);
      if (data) {
        applyHouseStateToUI(data, houseId);
      } else {
        setSyncStatus('offline');
        alert("Could not load house data.");
      }
    } finally {
      isHouseHydratingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleAccountAuthenticated = async (result: { account: UserAccount; houses: SavedHouse[] }) => {
    const nextActiveHouseId = result.houses[0]?.id || null;
    const nextCurrency = result.houses[0]?.currency || '$';

    syncRequestRef.current += 1;
    syncFingerprintRef.current = '';
    isHouseHydratingRef.current = Boolean(nextActiveHouseId);

    setUserSettings(prev => ({
      ...prev,
      account: result.account,
      savedHouses: result.houses,
      activeHouseId: nextActiveHouseId,
      currency: nextCurrency || prev.currency,
    }));
    setShowHouseMenu(false);
    setShowOnboarding(false);
    setShowAdminPanel(false);
    setHouseMembers([]);
    setHouseActivity([]);

    // Prevent previous account/house data from bleeding into a new sign-in.
    setInventory([]);
    setShoppingList([]);
    setRecipes([]);
    setExpenses([]);
    setDismissedItems([]);
    setLastSyncTime(0);

    if (!nextActiveHouseId) {
      isHouseHydratingRef.current = false;
      setSyncStatus('offline');
      return;
    }

    setLoadingMessage("Loading house...");
    setIsProcessing(true);

    try {
      const data = await fetchFamilyData(nextActiveHouseId, result.account.sessionToken);
      if (!isMountedRef.current) return;

      if (data) {
        applyHouseStateToUI(data, nextActiveHouseId);
      } else {
        setSyncStatus('offline');
      }
    } finally {
      isHouseHydratingRef.current = false;
      if (isMountedRef.current) {
        setIsProcessing(false);
      }
    }
  };

  const handleOnboardingComplete = async (result: { account: UserAccount; house: SavedHouse; state: AppState }) => {
    const { account, house, state } = result;
    const normalizedHouse: SavedHouse = {
      ...house,
      currency: house.currency || state.currency || '$',
    };

    setUserSettings(prev => {
      const exists = prev.savedHouses.find(h => h.id === normalizedHouse.id);
      const newHouses = exists
        ? prev.savedHouses.map(h => (h.id === normalizedHouse.id ? { ...h, ...normalizedHouse } : h))
        : [...prev.savedHouses, normalizedHouse];

      return {
        ...prev,
        account,
        currency: normalizedHouse.currency || prev.currency,
        activeHouseId: normalizedHouse.id,
        savedHouses: newHouses,
      };
    });

    applyHouseStateToUI(state, normalizedHouse.id);
    setAuthReady(true);
    setShowOnboarding(false);
    setShowHouseMenu(false);
    setShowAdminPanel(false);
  };

  const handleLogout = async () => {
    if (confirm("This will log you out and clear current views. You can rejoin using your House Code and Password.")) {
      const sessionToken = getSessionToken();
      if (sessionToken) {
        await logoutSession(sessionToken);
      }

      resetToLoggedOutState();
    }
  };

  const loadOwnerAdminData = async () => {
    const currentHouse = userSettings.savedHouses.find(h => h.id === userSettings.activeHouseId);
    const sessionToken = getSessionToken();
    if (!currentHouse || currentHouse.role !== 'owner' || !sessionToken) return;

    setAdminLoading(true);
    const [members, activity] = await Promise.all([
      fetchHouseMembers(currentHouse.id, sessionToken),
      fetchHouseActivity(currentHouse.id, sessionToken, 30),
    ]);
    if (!isMountedRef.current) return;
    setHouseMembers(members);
    setHouseActivity(activity);
    setAdminLoading(false);
  };

  const handleRenameActiveHouse = async (nextName: string) => {
    const currentHouse = userSettings.savedHouses.find(h => h.id === userSettings.activeHouseId);
    const sessionToken = getSessionToken();
    if (!currentHouse || !sessionToken || !nextName.trim()) return;

    const updated = await renameHouse(currentHouse.id, sessionToken, nextName.trim());
    if (!updated) {
      alert('Failed to rename house.');
      return;
    }
    setUserSettings(prev => ({
      ...prev,
      savedHouses: prev.savedHouses.map(h => (h.id === updated.id ? { ...h, ...updated } : h)),
    }));
    await loadOwnerAdminData();
  };

  const handleChangeActiveHousePassword = async (nextPassword: string) => {
    const currentHouse = userSettings.savedHouses.find(h => h.id === userSettings.activeHouseId);
    const sessionToken = getSessionToken();
    if (!currentHouse || !sessionToken || !nextPassword.trim()) return;

    const success = await changeHousePassword(currentHouse.id, sessionToken, nextPassword.trim());
    if (!success) {
      alert('Failed to update house password.');
      return;
    }
    alert('House password updated.');
    await loadOwnerAdminData();
  };

  const handleRemoveActiveHouseMember = async (username: string) => {
    const currentHouse = userSettings.savedHouses.find(h => h.id === userSettings.activeHouseId);
    const sessionToken = getSessionToken();
    if (!currentHouse || !sessionToken) return;

    const success = await removeHouseMember(currentHouse.id, sessionToken, username);
    if (!success) {
      alert('Failed to remove user.');
      return;
    }
    await loadOwnerAdminData();
  };

  const handleDeleteActiveHouse = async () => {
    const currentHouse = userSettings.savedHouses.find(h => h.id === userSettings.activeHouseId);
    const sessionToken = getSessionToken();
    if (!currentHouse || !sessionToken) return;

    const success = await deleteHouseFromCloud(currentHouse.id, sessionToken);
    if (!success) {
      alert('Failed to delete house.');
      return;
    }

    const remaining = userSettings.savedHouses.filter(h => h.id !== currentHouse.id);
    const nextActive = remaining[0]?.id || null;
    setUserSettings(prev => ({
      ...prev,
      savedHouses: prev.savedHouses.filter(h => h.id !== currentHouse.id),
      activeHouseId: nextActive,
      currency: nextActive ? (remaining.find(h => h.id === nextActive)?.currency || prev.currency) : prev.currency,
    }));

    setShowAdminPanel(false);
    setShowHouseMenu(false);
    setHouseMembers([]);
    setHouseActivity([]);

    if (nextActive) {
      await handleHouseSwitch(nextActive);
      return;
    }

    setInventory([]);
    setShoppingList([]);
    setRecipes([]);
    setExpenses([]);
    setLastSyncTime(0);
  };

  useEffect(() => {
    if (showAdminPanel) {
      void loadOwnerAdminData();
    }
  }, [showAdminPanel, userSettings.activeHouseId]);

  // Sync effect: only runs if we have an activeHouseId
  useEffect(() => {
    const familyId = userSettings.activeHouseId;
    const sessionToken = userSettings.account?.sessionToken;
    if (!authReady || !familyId || !sessionToken) return;
    if (isHouseHydratingRef.current) return;
    
    setSyncStatus('syncing');
    const timeout = setTimeout(async () => {
      const currentHouse = userSettings.savedHouses.find(h => h.id === familyId);
      if (!currentHouse) return;

      const stateForSync: Omit<AppState, 'updatedAt'> = {
        inventory,
        shoppingList,
        recipes,
        expenses,
        houseName: currentHouse.name,
        currency: currentHouse.currency || userSettings.currency || '$',
      };
      const fingerprint = buildCloudStateFingerprint(stateForSync);
      if (fingerprint === syncFingerprintRef.current) {
        setSyncStatus('synced');
        return;
      }

      const requestId = syncRequestRef.current + 1;
      syncRequestRef.current = requestId;
      const candidateUpdatedAt = Date.now();
      const result = await updateFamilyData(
        familyId,
        { ...stateForSync, updatedAt: candidateUpdatedAt },
        sessionToken,
        lastSyncTime
      );
      if (!isMountedRef.current || syncRequestRef.current !== requestId) return;

      if (result.status === 'ok') {
        setLastSyncTime(result.updatedAt);
        syncFingerprintRef.current = fingerprint;
        setSyncStatus('synced');
        return;
      }

      if (result.status === 'stale') {
        const latest = await fetchFamilyData(familyId, sessionToken);
        if (!isMountedRef.current || syncRequestRef.current !== requestId) return;

        if (latest) {
          applyHouseStateToUI(latest, familyId);
          setSyncStatus('synced');
        } else {
          setSyncStatus('offline');
        }
        return;
      }

      setSyncStatus('offline');
    }, 2000);
    return () => clearTimeout(timeout);
  }, [authReady, inventory, shoppingList, recipes, expenses, userSettings.activeHouseId, userSettings.savedHouses, userSettings.account?.sessionToken, lastSyncTime]);

  // Poll effect
  useEffect(() => {
    const familyId = userSettings.activeHouseId;
    const sessionToken = userSettings.account?.sessionToken;
    if (!authReady || !familyId || !sessionToken) return;
    
    const poll = async () => {
      if (isHouseHydratingRef.current) return;
      const currentHouse = userSettings.savedHouses.find(h => h.id === familyId);
      if (!currentHouse) return;

      const data = await fetchFamilyData(familyId, sessionToken);
      if (data && data.updatedAt > lastSyncTime) {
        applyHouseStateToUI(data, familyId);
      }
    };
    const interval = setInterval(poll, 10000);
    void poll();
    return () => clearInterval(interval);
  }, [authReady, userSettings.activeHouseId, userSettings.savedHouses, userSettings.account?.sessionToken, lastSyncTime]);

  const spentThisMonth = expenses.reduce((acc, item) => {
    const date = new Date(item.date);
    const now = new Date();
    return (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) ? acc + item.amount : acc;
  }, 0);

  const currentHouse = userSettings.savedHouses.find(h => h.id === userSettings.activeHouseId);
  const currentCurrency = currentHouse?.currency || userSettings.currency || '$';
  const formatMoney = (val: number) => `${val.toLocaleString()} ${currentCurrency}`;
  const currentHouseName = currentHouse?.name || "My House";
  const currentHouseRole = currentHouse?.role || null;

  const logUploadError = (scope: string, error: unknown) => {
    if (error instanceof UploadImageError) {
      console.error(`[ImageUpload:${scope}] ${error.code}: ${error.message}`);
      return;
    }
    if (error instanceof Error) {
      console.error(`[ImageUpload:${scope}] ${error.message}`);
      return;
    }
    console.error(`[ImageUpload:${scope}] Unknown upload error`);
  };

  // Uploads are backgrounded to keep the UI responsive.
  // Only the latest job for each entity is allowed to write to state.
  const queueItemImageUpload = (itemId: string, imageSource: string | undefined, maxWidth = 640, quality = 0.9) => {
    if (!imageSource) return;
    const jobId = createUploadJobId();
    itemImageJobsRef.current.set(itemId, jobId);

    void (async () => {
      try {
        const uploadedUrl = await prepareAndUploadImage(imageSource, maxWidth, quality);
        if (!isMountedRef.current) return;
        if (itemImageJobsRef.current.get(itemId) !== jobId) return;

        setInventory(prev => prev.map(item => item.id === itemId ? { ...item, imageUrl: uploadedUrl } : item));
      } catch (error) {
        if (itemImageJobsRef.current.get(itemId) === jobId) {
          logUploadError(`item:${itemId}`, error);
        }
      } finally {
        if (itemImageJobsRef.current.get(itemId) === jobId) {
          itemImageJobsRef.current.delete(itemId);
        }
      }
    })();
  };

  const queueRecipeImageUpload = (recipeId: string, imageSource: string | undefined, maxWidth = 960, quality = 0.9) => {
    if (!imageSource) return;
    const jobId = createUploadJobId();
    recipeImageJobsRef.current.set(recipeId, jobId);

    void (async () => {
      try {
        const uploadedUrl = await prepareAndUploadImage(imageSource, maxWidth, quality);
        if (!isMountedRef.current) return;
        if (recipeImageJobsRef.current.get(recipeId) !== jobId) return;

        setRecipes(prev => prev.map(recipe => recipe.id === recipeId ? { ...recipe, imageUrl: uploadedUrl } : recipe));
        setSelectedRecipe(current => current && current.id === recipeId ? { ...current, imageUrl: uploadedUrl } : current);
      } catch (error) {
        if (recipeImageJobsRef.current.get(recipeId) === jobId) {
          logUploadError(`recipe:${recipeId}`, error);
        }
      } finally {
        if (recipeImageJobsRef.current.get(recipeId) === jobId) {
          recipeImageJobsRef.current.delete(recipeId);
        }
      }
    })();
  };

  // --- Background Processing with Resolver ---
  const backgroundProcessItem = async (itemId: string, name: string, initialCategory: Category) => {
    try {
      const deterministicKeyword = normalizeFoodInput(name);
      let result: CanonicalResult = productResolver.resolveProduct(name);

      if (deterministicKeyword !== 'food') {
        const deterministicResult = productResolver.resolveProduct(deterministicKeyword);
        if (deterministicResult.confidence >= result.confidence) {
          result = deterministicResult;
        }
      }

      let smartCategoryHint: Category | null = null;
      if (result.confidence < 0.8) {
        const smartDetails = await getSmartItemDetails(name);
        smartCategoryHint = smartDetails.category;

        const smartCanonical = smartDetails.canonicalName || smartDetails.imageKeyword || name;
        const smartKeyword = normalizeFoodInput(smartCanonical);
        const canTrustSmartKeyword =
          deterministicKeyword === 'food' || smartKeyword === deterministicKeyword;

        if (canTrustSmartKeyword) {
          const smartResult = productResolver.resolveProduct(smartCanonical);
          if (smartResult.confidence > 0.8) {
            result = smartResult;
          } else {
            result = productResolver.createCanonicalProductIfMissing(smartCanonical, smartDetails.category);
          }
        }
      }

      let newCategory = initialCategory;
      if (result.category && Object.keys(CATEGORY_ICONS).includes(result.category)) {
        newCategory = result.category as Category;
      } else if (smartCategoryHint && Object.keys(CATEGORY_ICONS).includes(smartCategoryHint)) {
        newCategory = smartCategoryHint;
      }

      const normalizedKeyword = resolveProductKeyword(name, result.canonicalName, result.canonicalName);
      // Apply canonical/category metadata even if image generation/upload fails.
      setInventory(prev => prev.map(item => item.id === itemId ? {
        ...item,
        category: newCategory,
        canonicalName: result.canonicalName,
        canonicalId: result.canonicalId,
        imageKeyword: normalizedKeyword === 'food' ? (result.canonicalName || item.name) : normalizedKeyword,
      } : item));

      try {
        let imageSource = await generateGroceryImage(normalizedKeyword);

        if (imageSource && !isImageSourceRelevantToKeyword(imageSource, normalizedKeyword)) {
          console.warn('[ImageMismatch] Rejected mismatched generated product image.', {
            input: name,
            normalizedKeyword,
            selectedImageSource: imageSource,
            rejectionReason: 'generated_source_not_relevant_for_keyword',
          });
          imageSource = NEUTRAL_PLACEHOLDER_IMAGE_URL;
        }

        if (imageSource) {
          if (!isDataUrl(imageSource)) {
            setInventory(prev => prev.map(item => item.id === itemId ? { ...item, imageUrl: imageSource } : item));
          }
          if (!isSupabasePublicUrl(imageSource)) {
            queueItemImageUpload(itemId, imageSource, 640, 0.9);
          }
        }
      } catch (imageError) {
        console.warn('[ImagePipeline] Item image generation failed, keeping existing image source.', {
          itemId,
          itemName: name,
          reason: imageError instanceof Error ? imageError.message : 'unknown',
        });
      }
    } catch (e) {
      console.error("Background processing failed", e);
    }
  };

  const handleVoiceToolUse = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    if (tool === 'updateInventory') {
      const itemName = typeof args.itemName === 'string' ? args.itemName : '';
      const quantityChange = Number(args.quantityChange || 0);
      const unit = typeof args.unit === 'string' ? args.unit : 'pcs';

      if (!itemName || !Number.isFinite(quantityChange)) {
        return 'Invalid inventory update command.';
      }

      let message = '';
      setInventory(prev => {
        const matchIndex = findInventoryIndexByKeyword(prev, itemName);
        if (matchIndex === -1 && quantityChange > 0) {
          const newItem: InventoryItem = {
            id: buildVoiceItemId(),
            name: itemName,
            quantity: quantityChange,
            unit,
            category: 'Other',
            addedDate: new Date().toISOString().split('T')[0],
            canonicalName: normalizeFoodInput(itemName),
            imageKeyword: normalizeFoodInput(itemName),
          };
          backgroundProcessItem(newItem.id, newItem.name, 'Other');
          message = `Added ${quantityChange} ${itemName}`;
          return [...prev, newItem];
        }

        if (matchIndex === -1) {
          message = `Could not find ${itemName}`;
          return prev;
        }

        const updated = [...prev];
        const item = updated[matchIndex];
        const newQty = Math.max(0, item.quantity + quantityChange);
        updated[matchIndex] = { ...item, quantity: parseFloat(newQty.toFixed(2)) };
        message = `Updated ${item.name}. New quantity: ${newQty}`;
        return updated;
      });
      return message;
    }

    if (tool === 'addToShoppingList') {
      const item = typeof args.item === 'string' ? args.item : '';
      const quantity = Number(args.quantity || 1);
      if (!item) return 'Invalid shopping list command.';
      setShoppingList(prev => [...prev, { id: createShoppingItemId('voice'), name: item, quantity, checked: false }]);
      return `Added ${item}`;
    }

    if (tool === 'saveRecipe') {
      const title = typeof args.title === 'string' ? args.title : 'Recipe';
      const ingredients = Array.isArray(args.ingredients)
        ? args.ingredients.filter((value): value is string => typeof value === 'string')
        : [];
      const instructionsRaw = typeof args.instructions === 'string' ? args.instructions : '';
      const cookingTime = Number(args.cookingTime || 30);

      const recipeId = Date.now().toString();
      const parsedIngs = ingredients.map((ingredient) => {
        const match = ingredient.match(/^([\d.,]+(?:\s*[a-zA-Zа-яА-Я]+)?)\s+(.*)$/);
        return match
          ? { name: match[2].trim(), quantity: match[1].trim(), category: 'Other' as Category }
          : { name: ingredient, quantity: '', category: 'Other' as Category };
      });

      const newRecipe: Recipe = {
        id: recipeId,
        title,
        ingredients: parsedIngs,
        instructions: instructionsRaw.split('\n').filter(Boolean),
        timesCooked: 0,
        cookingTime: Number.isFinite(cookingTime) ? cookingTime : 30,
        rating: 0,
      };

      setRecipes(prev => [...prev, newRecipe]);
      backgroundProcessRecipeImage(recipeId, title, title);
      return 'Recipe saved.';
    }

    return 'Done';
  };

  const handleScanReceipt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoadingMessage("Analyzing...");
    setIsProcessing(true);

    try {
      const base64 = await blobToBase64Payload(file);
      const items = await analyzeReceipt(base64);
      if (items.length === 0) {
        alert('No receipt items detected. Try a clearer image.');
        return;
      }

      const newItems: InventoryItem[] = items.map((item, idx) => ({
        id: `${Date.now()}-${idx}`,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        category: item.category,
        price: item.price,
        addedDate: new Date().toISOString().split('T')[0],
        canonicalName: item.canonicalName,
        imageKeyword: item.imageKeyword,
      }));

      setInventory(prev => [...prev, ...newItems]);
      setExpenses(prev => [
        ...prev,
        ...items.map(item => ({
          date: new Date().toISOString(),
          amount: item.price,
          category: item.category,
        })),
      ]);
      setActiveTab(AppTab.Fridge);

      newItems.forEach(item => {
        backgroundProcessItem(item.id, item.name, item.category);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      alert(`Failed to analyze receipt: ${message}`);
    } finally {
      setIsProcessing(false);
      e.target.value = '';
    }
  };

  const handleVoiceInput = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      setIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorderRef.current.onstop = async () => {
        setLoadingMessage("Processing...");
        setIsProcessing(true);

        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        try {
          const base64Audio = await blobToBase64Payload(audioBlob);
          const items = await parseVoiceInput(base64Audio, audioBlob.type || 'audio/webm');
          const parsedItems: VoiceItemInput[] = items
            .map(item => ({
              name: item.name,
              quantity: Number(item.quantity),
              unit: item.unit || 'pcs',
              category: item.category,
              canonicalName: item.canonicalName,
              imageKeyword: item.imageKeyword,
            }))
            .filter(item => item.name.trim().length > 0 && Number.isFinite(item.quantity) && item.quantity > 0);

          if (parsedItems.length > 0) {
            const addedItems: Array<{ id: string; name: string; category: Category }> = [];
            setInventory(prev => mergeVoiceItemsIntoInventory(prev, parsedItems, addedItems));
            setActiveTab(AppTab.Fridge);
            addedItems.forEach(item => {
              backgroundProcessItem(item.id, item.name, item.category);
            });
          } else {
            alert('No grocery items detected.');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          alert(`Audio processing failed: ${message}`);
        } finally {
          setIsProcessing(false);
          stream.getTracks().forEach(track => track.stop());
        }
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
    } catch {
      alert("Could not access microphone.");
    }
  };

  const handleSmartOrganize = async () => {
    if (inventory.length === 0) { alert("It's empty here"); return; }
    if (!confirm("This will automatically categorize all items using AI. Continue?")) return;
    setLoadingMessage("Organizing...");
    setIsProcessing(true);
    try {
      const map = await categorizeBatch(inventory.map(i => i.name));
      if (Object.keys(map).length === 0) {
        alert("Failed to organize.");
        return;
      }

      const normalizedMap = new Map<string, Category>();
      Object.entries(map).forEach(([name, category]) => {
        normalizedMap.set(normalizeFoodInput(name), category);
      });

      setInventory(prev => prev.map(item => {
        const direct = map[item.name];
        if (direct) {
          return { ...item, category: direct };
        }

        const normalized = normalizeFoodInput(item.canonicalName || item.name);
        const fallback = normalizedMap.get(normalized);
        if (fallback) {
          return { ...item, category: fallback };
        }

        return item;
      }));
      alert("Done! Items organized.");
    } catch {
      alert("Failed to organize.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = fd.get('name') as string;
    const quantity = parseFloat(fd.get('quantity') as string) || 1;
    const unit = (fd.get('unit') as string) || 'pcs';
    const category = fd.get('category') as Category;
    const price = parseFloat(fd.get('price') as string) || 0;
    if (!name) return;

    setShowManualAdd(false);
    const newItemId = `manual-${Date.now()}`;
    const newItem: InventoryItem = {
      id: newItemId,
      name,
      quantity,
      unit,
      category,
      price,
      addedDate: new Date().toISOString().split('T')[0],
      canonicalName: name.toLowerCase(),
      imageKeyword: name,
    };

    setInventory(prev => [...prev, newItem]);
    if (price > 0) {
      setExpenses(prev => [...prev, { date: new Date().toISOString(), amount: price, category }]);
    }
    setManualAddName('');
    setManualAddCategory('Other');
    setActiveTab(AppTab.Fridge);
    backgroundProcessItem(newItemId, name, category);
  };

  const handleEditSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); if (!editingItem) return; const fd = new FormData(e.currentTarget); setInventory(prev => prev.map(item => item.id === editingItem.id ? { ...item, name: fd.get('name') as string, quantity: parseFloat(fd.get('quantity') as string), unit: fd.get('unit') as string, category: fd.get('category') as Category, price: parseFloat(fd.get('price') as string) } : item)); setEditingItem(null); setDeleteConfirm(false);
  };

  const performDelete = () => {
    if (!editingItem) return;
    setInventory(prev => prev.filter(i => i.id !== editingItem.id));
    setEditingItem(null);
    setDeleteConfirm(false);
  };

  const handleRegenerateImage = async () => {
    if (!editingItem) return;
    const originalItem = editingItem;
    setEditingItem(null);
    setLoadingMessage("Drawing...");
    setIsProcessing(true);
    try {
      const details = await getSmartItemDetails(originalItem.name);
      const deterministicKeyword = normalizeFoodInput(originalItem.name);
      const aiKeyword = resolveProductKeyword(originalItem.name, details.canonicalName, details.imageKeyword);
      const normalizedKeyword = deterministicKeyword === 'food' ? aiKeyword : deterministicKeyword;
      let imageSource = await generateGroceryImage(normalizedKeyword);
      if (imageSource && !isImageSourceRelevantToKeyword(imageSource, normalizedKeyword)) {
        console.warn('[ImageMismatch] Rejected mismatched regenerated product image.', {
          input: originalItem.name,
          normalizedKeyword,
          selectedImageSource: imageSource,
          rejectionReason: 'regenerated_source_not_relevant_for_keyword',
        });
        imageSource = NEUTRAL_PLACEHOLDER_IMAGE_URL;
      }

      if (imageSource) {
        if (!isDataUrl(imageSource)) {
          setInventory(prev => prev.map(i => i.id === originalItem.id ? { ...i, imageUrl: imageSource } : i));
        }
        if (!isSupabasePublicUrl(imageSource)) {
          queueItemImageUpload(originalItem.id, imageSource, 640, 0.9);
        }
        setInventory(prev => prev.map(i => i.id === originalItem.id ? {
          ...i,
          canonicalName: details.canonicalName,
          imageKeyword: normalizedKeyword,
        } : i));
      } else {
        alert('No matching image found for this item.');
      }
    } catch {
      alert('Failed to regenerate image.');
    } finally {
      setIsProcessing(false);
    }
  };

  const consumeItem = (id: string) => {
    const item = inventory.find(i => i.id === id); if (!item) return; setInventory(prev => prev.filter(i => i.id !== id)); if (!shoppingList.some(s => s.name.toLowerCase() === item.name.toLowerCase()) && !dismissedItems.includes(item.name)) { setShoppingList(prev => [...prev, { id: createShoppingItemId('smart'), name: item.name, quantity: 1, checked: false }]); }
  };

  const updateQuantity = (id: string, change: number) => {
    const item = inventory.find(i => i.id === id); if (!item) return; const step = ['kg', 'l'].some(u => item.unit.toLowerCase().includes(u)) ? 0.5 : 1; const newQty = item.quantity + (change * step); if (newQty <= 0) consumeItem(id); else setInventory(prev => prev.map(i => i.id === id ? { ...i, quantity: parseFloat(newQty.toFixed(2)) } : i));
  };

  const backgroundProcessRecipeImage = async (recipeId: string, title: string, keyword: string) => {
    try {
      const dishTitle = (title || keyword || 'prepared dish').trim();
      const imagePrompt = `${dishTitle} plated cooked dish`;
      const imageSource = await generateGroceryImage(imagePrompt);
      if (imageSource) {
        if (!isDataUrl(imageSource)) {
          setRecipes(prev => prev.map(recipe => recipe.id === recipeId ? { ...recipe, imageUrl: imageSource } : recipe));
          setSelectedRecipe(current => current && current.id === recipeId ? { ...current, imageUrl: imageSource } : current);
        }
        queueRecipeImageUpload(recipeId, imageSource, 960, 0.9);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const suggestRecipe = async (item: InventoryItem) => {
    setLoadingMessage(`Processing ${item.name}...`);
    setIsProcessing(true);
    try {
      const data = await generateRecipeForIngredient(item.name);
      const recipeId = Date.now().toString();
      const newRecipe: Recipe = {
        id: recipeId,
        title: data.title,
        ingredients: data.ingredients.map(ingredient => ({ ...ingredient, category: 'Other' })),
        instructions: data.instructions,
        timesCooked: 0,
        cookingTime: data.cookingTime || 30,
        rating: 0,
      };
      let duplicateRecipe: Recipe | null = null;
      setRecipes(prev => {
        duplicateRecipe = findDuplicateRecipe(prev, newRecipe);
        if (duplicateRecipe) return prev;
        return [...prev, newRecipe];
      });
      setActiveTab(AppTab.Recipes);
      setSelectedRecipe(duplicateRecipe || newRecipe);
      if (!duplicateRecipe) {
        backgroundProcessRecipeImage(recipeId, data.title, data.imageKeyword);
      }
    } catch {
      alert("Failed to generate recipe.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddRecipe = async (input: string) => {
    setShowAddRecipe(false);
    setLoadingMessage("Analyzing...");
    setIsProcessing(true);
    try {
      const parsed = await parseRecipe(input);
      const recipeId = Date.now().toString();
      const generatedSource = parsed.imageUrl || undefined;
      const shouldUseGeneratedSource = Boolean(generatedSource && !isNeutralPlaceholderImage(generatedSource));
      const persistedImageUrl =
        shouldUseGeneratedSource && generatedSource && !isDataUrl(generatedSource)
          ? generatedSource
          : undefined;
      const newRecipe: Recipe = {
        id: recipeId,
        ...parsed,
        imageUrl: persistedImageUrl,
        timesCooked: 0,
        cookingTime: parsed.cookingTime || 45,
        rating: 0,
      };
      let duplicateRecipe: Recipe | null = null;
      setRecipes(prev => {
        duplicateRecipe = findDuplicateRecipe(prev, newRecipe);
        if (duplicateRecipe) return prev;
        return [...prev, newRecipe];
      });
      setSelectedRecipe(duplicateRecipe || newRecipe);

      if (!duplicateRecipe && generatedSource && shouldUseGeneratedSource) {
        queueRecipeImageUpload(newRecipe.id, generatedSource, 960, 0.9);
      } else if (!duplicateRecipe && parsed.title) {
        backgroundProcessRecipeImage(recipeId, parsed.title, parsed.imageKeyword || parsed.title);
      }
    } catch {
      alert("Failed to parse recipe.");
    } finally {
      setIsProcessing(false);
    }
  };

  const checkIngredientStock = (ing: RecipeIngredient) => {
    const match = inventory.find(item => isIngredientMatch(item, ing));
    return match && match.quantity > 0;
  };

  const suggestions = React.useMemo(() => {
    const suggs: { id: string, name: string, reason: string, type: 'low' | 'recipe' }[] = []; 
    const listNames = new Set(shoppingList.map(i => i.name.toLowerCase())); 
    const dimissed = new Set(dismissedItems.map(i => i.toLowerCase())); 
    
    inventory.filter(i => i.quantity <= 0).forEach(i => { 
        if (!listNames.has(i.name.toLowerCase()) && !dimissed.has(i.name.toLowerCase())) 
            suggs.push({ id: `sugg-low-${i.id}`, name: i.name, reason: "Out of stock", type: 'low' }); 
    }); 
    
    [...recipes].filter(r => r.timesCooked > 0).sort((a, b) => b.timesCooked - a.timesCooked).slice(0, 5).forEach(r => { 
        r.ingredients.forEach(ing => { 
            const match = inventory.find(item => isIngredientMatch(item, ing)); 
            if ((!match || match.quantity <= 0) && !listNames.has(ing.name.toLowerCase()) && !dimissed.has(ing.name.toLowerCase()) && !suggs.some(s => s.name.toLowerCase() === ing.name.toLowerCase())) { 
                suggs.push({ id: `sugg-recipe-${ing.name}-${r.id}`, name: ing.name, reason: r.title, type: 'recipe' }); 
            } 
        }); 
    }); 
    return suggs.slice(0, 10);
  }, [inventory, recipes, shoppingList, dismissedItems]);

  const handleCookRecipe = (recipe: Recipe) => {
    const newInventory = [...inventory]; 
    let madeChanges = false; 
    
    recipe.ingredients.forEach(ing => { 
        const idx = newInventory.findIndex(i => isIngredientMatch(i, ing)); 
        if (idx >= 0 && newInventory[idx].quantity > 0) { 
            const needed = parseQuantity(ing.quantity);
            const consume = needed > 0 ? needed : 1;
            const toRemove = Math.min(newInventory[idx].quantity, consume);
            
            newInventory[idx] = { 
                ...newInventory[idx], 
                quantity: parseFloat((newInventory[idx].quantity - toRemove).toFixed(2)) 
            }; 
            madeChanges = true; 
        } 
    }); 
    
    if (madeChanges) setInventory(newInventory); 
    setRecipes(prev => prev.map(r => r.id === recipe.id ? { ...r, timesCooked: r.timesCooked + 1 } : r)); 
    setSelectedRecipe(null); 
    alert("Cooked! Inventory updated.");
  };

  const addMissingToShop = (recipe: Recipe) => {
    const missing = recipe.ingredients.filter(ing => !checkIngredientStock(ing)); const newShopItems = missing.filter(m => !shoppingList.some(s => s.name === m.name)).map(m => ({ id: createShoppingItemId('recipe'), name: m.name, quantity: 1, checked: false })); if (newShopItems.length > 0) { setShoppingList(prev => [...prev, ...newShopItems]); alert("Added to shopping list."); } else alert("All ingredients in stock.");
  };

  const handleQuickAdd = () => {
    if (!quickAddText.trim()) return; setShoppingList(prev => [{ id: createShoppingItemId('quick'), name: quickAddText.trim(), quantity: 1, checked: false }, ...prev]); setQuickAddText('');
  };

  const confirmFinishShopping = () => {
    const newItems = pendingPurchases.map((item, idx) => ({
      id: `bought-${Date.now()}-${idx}`,
      name: item.name,
      quantity: item.quantity,
      unit: 'pcs',
      category: 'Other' as Category,
      price: item.finalPrice,
      addedDate: new Date().toISOString().split('T')[0],
      canonicalName: item.name.toLowerCase(),
      imageKeyword: item.name,
    })); 
    const newExp = pendingPurchases.map(item => ({ date: new Date().toISOString(), amount: item.finalPrice * item.quantity, category: 'Other' as Category })); 
    setInventory(prev => [...prev, ...newItems]); 
    setExpenses(prev => [...prev, ...newExp]); 
    const processedIds = pendingPurchases.map(p => p.id); 
    setShoppingList(prev => prev.filter(i => !processedIds.includes(i.id))); 
    setShowFinishModal(false); 
    setPendingPurchases([]); 
    setActiveTab(AppTab.Fridge); 
    
    (async () => {
        for (const item of newItems) {
            await backgroundProcessItem(item.id, item.name, item.category);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    })();
  };

  const renderDashboard = () => {
    const searchIntent = searchQuery.trim().toLowerCase();
    const filtered = inventory.filter(item => {
      if (item.quantity <= 0) return false;
      if (activeFilter !== 'All' && item.category !== activeFilter) return false;
      if (!searchIntent) return true;

      const directMatch =
        item.name.toLowerCase().includes(searchIntent) ||
        (item.canonicalName || '').toLowerCase().includes(searchIntent);
      const semanticMatch = (inventoryRankScores[item.id] || 0) >= 0.15;
      return directMatch || semanticMatch;
    });
    return (
      <div className="pb-40 pt-28 px-6 relative z-10">
        
        {/* Main Crystal Card */}
        <div className="liquid-glass rounded-[2.5rem] p-8 relative overflow-hidden mb-10 transition-all duration-500 hover:scale-[1.01] hover:shadow-[0_20px_50px_rgba(0,0,0,0.1)]">
          <div className="absolute top-0 right-0 w-48 h-48 bg-cyan-400/20 dark:bg-cyan-500/10 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none animate-pulse"></div>
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-violet-400/20 dark:bg-violet-500/10 rounded-full blur-3xl -ml-16 -mb-16 pointer-events-none animate-pulse"></div>
          
          <div className="relative z-10 flex flex-col items-center py-2">
            <span className="text-slate-500 dark:text-slate-400 font-bold text-[10px] uppercase tracking-widest mb-4 text-glass">Spent this month</span>
            <h2 className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-br from-slate-900 to-slate-500 dark:from-white dark:to-slate-400 tracking-tighter mb-6 drop-shadow-sm">{formatMoney(spentThisMonth)}</h2>
            
            <div className="flex gap-3">
              <div className="bg-emerald-500/10 dark:bg-emerald-400/10 text-emerald-700 dark:text-emerald-300 px-5 py-2 rounded-2xl text-xs font-bold border border-emerald-500/20 backdrop-blur-md shadow-sm">In stock: {inventory.filter(i => i.quantity > 0).length}</div>
              <div className="bg-rose-500/10 dark:bg-rose-400/10 text-rose-700 dark:text-rose-300 px-5 py-2 rounded-2xl text-xs font-bold border border-rose-500/20 backdrop-blur-md shadow-sm">Out of stock: {inventory.filter(i => i.quantity === 0).length}</div>
            </div>
          </div>
        </div>

        {/* Liquid Action Bubbles */}
        <div className="flex justify-center gap-8 mb-12">
          <label className="flex flex-col items-center gap-3 group cursor-pointer">
            <div className="w-18 h-18 p-5 liquid-bubble rounded-[2rem] flex items-center justify-center text-cyan-600 dark:text-cyan-400 group-hover:scale-110 active:scale-95 transition-all duration-300">
              <Scan size={28} strokeWidth={2.5} />
              <input type="file" accept="image/*" onChange={handleScanReceipt} className="hidden" />
            </div>
            <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 tracking-tight transition-colors group-hover:text-cyan-600 text-glass">Receipt</span>
          </label>
          <button onClick={handleVoiceInput} className="flex flex-col items-center gap-3 group">
            <div className={`w-18 h-18 p-5 rounded-[2rem] flex items-center justify-center transition-all duration-300 ${isRecording ? 'bg-rose-500 text-white shadow-[0_0_30px_rgba(244,63,94,0.4)] animate-pulse' : 'liquid-bubble text-violet-600 dark:text-violet-400 group-hover:scale-110 active:scale-95'}`}>
              <Mic size={28} strokeWidth={2.5} />
            </div>
            <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 tracking-tight transition-colors group-hover:text-violet-600 text-glass">Voice</span>
          </button>
          <button onClick={() => setShowManualAdd(true)} className="flex flex-col items-center gap-3 group">
            <div className="w-18 h-18 p-5 liquid-bubble rounded-[2rem] flex items-center justify-center text-emerald-600 dark:text-emerald-400 group-hover:scale-110 active:scale-95 transition-all duration-300">
              <PlusCircle size={28} strokeWidth={2.5} />
            </div>
            <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 tracking-tight transition-colors group-hover:text-emerald-600 text-glass">Manual</span>
          </button>
        </div>

        {/* Concave Search Bar */}
        <div className="relative mb-10 z-10">
          <Search size={18} className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 z-20" />
          <input type="text" placeholder="Find product..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full liquid-concave rounded-[24px] py-4 pl-14 pr-4 text-sm font-medium outline-none text-slate-700 dark:text-slate-200 focus:border-white/40 transition-all placeholder:text-slate-400/70" />
        </div>

        {/* Category Grid - Glass Tiles */}
        <div className="mb-10">
          <div className="flex justify-between items-center mb-5 px-2">
            <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm text-glass">Categories</h3>
            <button onClick={() => setActiveFilter('All')} className={`text-[10px] font-bold px-4 py-1.5 rounded-full transition-all ${activeFilter === 'All' ? 'bg-cyan-500 text-white shadow-lg shadow-cyan-500/30' : 'text-cyan-600 dark:text-cyan-400 liquid-bubble'}`}>All</button>
          </div>
          <div className="grid grid-cols-4 gap-4">
            {Object.keys(CATEGORY_ICONS).map((cat) => {
              const category = cat as Category;
              const Icon = CATEGORY_ICONS[category];
              const isActive = activeFilter === category;
              return (
                <button
                  key={category}
                  onClick={() => setActiveFilter(isActive ? 'All' : category)}
                  className={`flex flex-col items-center justify-center p-2 rounded-[20px] transition-all aspect-square duration-300 ${isActive ? 'bg-slate-800 dark:bg-slate-700 text-white shadow-xl scale-110' : 'liquid-glass hover:bg-white/40'}`}
                >
                  <div className={`w-10 h-10 rounded-2xl flex items-center justify-center mb-2 shadow-inner ${isActive ? 'bg-white/10 text-white' : `bg-gradient-to-br ${CATEGORY_THEMES[category]}`}`}>
                    <Icon size={18} strokeWidth={2.5} />
                  </div>
                  <span className={`text-[9px] font-bold text-center leading-tight ${isActive ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`}>{category}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Inventory List - Liquid Strips */}
        <div className="min-h-[200px]">
          {filtered.length === 0 ? (
            <div className="liquid-concave rounded-3xl p-10 text-center">
              <p className="text-slate-400 text-sm font-medium">Nothing found</p>
            </div>
          ) : (
            <div className="space-y-6">
              {(activeFilter === 'All' ? CATEGORY_ORDER : [activeFilter]).map((cat, groupIdx) => {
                const items = filtered
                  .filter(i => i.category === cat)
                  .sort((a, b) => {
                    const rankDelta = (inventoryRankScores[b.id] || 0) - (inventoryRankScores[a.id] || 0);
                    if (Math.abs(rankDelta) > 0.0001) return rankDelta;
                    return a.name.localeCompare(b.name);
                  });
                if (items.length === 0) return null;
                return (
                  <div key={cat}>
                    <div className="flex items-center gap-2 mb-4 px-2">
                      <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm text-glass">{cat}</h3>
                    </div>
                    <div className="space-y-3">
                      {items.map((item, idx) => (
                        <div
                          key={item.id}
                          style={{ animationDelay: `${(groupIdx * 100) + (idx * 50)}ms` }}
                          onClick={() => setEditingItem(item)}
                          className="liquid-glass rounded-[24px] p-3 pr-4 flex items-center gap-4 cursor-pointer active:scale-[0.98] transition-all animate-fade-in-up opacity-0 hover:bg-white/40"
                        >
                          <div className="w-16 h-16 rounded-2xl bg-white/40 dark:bg-slate-800/40 overflow-hidden flex-shrink-0 relative shadow-inner border border-white/20">
                            {item.imageUrl ? (
                              <>
                                <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover mix-blend-overlay opacity-80" />
                                <img src={item.imageUrl} alt={item.name} className="absolute inset-0 w-full h-full object-cover" />
                              </>
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-400">
                                <ImageIcon size={18} />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-bold text-slate-800 dark:text-slate-200 text-base truncate mb-1 text-glass">{item.name}</h4>
                            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300 bg-white/40 dark:bg-slate-700/40 px-3 py-1 rounded-lg inline-block border border-white/20">{formatMoney(item.price || 0)}</span>
                          </div>
                          <div className="flex items-center gap-1 bg-black/5 dark:bg-white/5 p-1 rounded-xl border border-white/10" onClick={e => e.stopPropagation()}>
                            <button onClick={() => updateQuantity(item.id, -1)} className="w-8 h-8 flex items-center justify-center bg-white/60 dark:bg-slate-700/60 text-slate-500 hover:text-rose-500 rounded-lg shadow-sm transition-colors">
                              <Minus size={16} />
                            </button>
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-200 min-w-[32px] text-center">
                              {item.quantity} {item.unit}
                            </span>
                            <button onClick={() => updateQuantity(item.id, 1)} className="w-8 h-8 flex items-center justify-center bg-white/60 dark:bg-slate-700/60 text-slate-500 hover:text-cyan-500 rounded-lg shadow-sm transition-colors">
                              <Plus size={16} />
                            </button>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); suggestRecipe(item); }} className="w-9 h-9 flex items-center justify-center bg-violet-100/40 dark:bg-violet-900/40 text-violet-600 rounded-xl hover:bg-violet-200/50 transition-colors border border-violet-200/30">
                            <ChefHat size={18} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderRecipes = () => {
    const recipeSortOptions: Array<{ id: 'popular' | 'fastest' | 'rating'; label: string; icon: React.ElementType }> = [
      { id: 'popular', label: "Popular", icon: Utensils },
      { id: 'fastest', label: "Fastest", icon: Clock },
      { id: 'rating', label: "Rating", icon: Star },
    ];

    const staticRecipeComparator = (a: Recipe, b: Recipe) =>
      recipeSortMode === 'rating'
        ? (b.rating || 0) - (a.rating || 0)
        : recipeSortMode === 'fastest'
          ? (a.cookingTime || 999) - (b.cookingTime || 999)
          : b.timesCooked - a.timesCooked;

    const sorted = [...recipes].sort((a, b) => {
      const rankDelta = (recipeRankScores[b.id] || 0) - (recipeRankScores[a.id] || 0);
      if (Math.abs(rankDelta) > 0.0001) return rankDelta;
      return staticRecipeComparator(a, b);
    });
    return (
      <div className="p-4 pt-28 pb-40 space-y-4 relative z-10">
        <div className="flex justify-between items-center px-1 mb-4">
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-200 text-glass">Recipe Book</h2>
          <button onClick={() => setShowAddRecipe(true)} className="liquid-bubble w-12 h-12 rounded-full flex items-center justify-center text-slate-700 dark:text-slate-200 active:scale-95 transition-transform">
            <PlusCircle size={24} />
          </button>
        </div>
        <div className="flex gap-3 overflow-x-auto no-scrollbar py-2 px-1">
          {recipeSortOptions.map(opt => (
            <button
              key={opt.id}
              onClick={() => setRecipeSortMode(opt.id)}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-xs font-bold transition-all whitespace-nowrap border ${recipeSortMode === opt.id ? 'bg-slate-800 text-white border-slate-800 shadow-xl scale-105' : 'liquid-glass text-slate-600 dark:text-slate-400 hover:bg-white/40'}`}
            >
              <opt.icon size={14} /> {opt.label}
            </button>
          ))}
        </div>
        {sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-600">
            <BookOpen size={40} className="mb-4 opacity-50" />
            <p className="font-medium text-sm">No saved recipes</p>
          </div>
        )}
        <div className="grid grid-cols-1 gap-5">
        {sorted.map((recipe, idx) => (
          <div
            key={recipe.id}
            onClick={() => setSelectedRecipe(recipe)}
            style={{ animationDelay: `${idx * 50}ms` }}
            className="liquid-glass rounded-[2rem] p-4 flex gap-5 cursor-pointer group animate-fade-in-up opacity-0 hover:bg-white/40 transition-colors"
          >
            <div className="w-24 h-24 bg-white/20 dark:bg-slate-800/20 rounded-2xl overflow-hidden flex-shrink-0 relative shadow-inner border border-white/10">
              {recipe.imageUrl ? (
                <img src={recipe.imageUrl} alt={recipe.title} className="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-700" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-slate-400">
                  <ImageIcon size={20} />
                </div>
              )}
            </div>
            <div className="flex-1 py-1 flex flex-col justify-center">
              <h3 className="font-bold text-slate-800 dark:text-slate-200 text-lg line-clamp-1 text-glass">{recipe.title}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2 leading-relaxed">{recipe.instructions[0]}</p>
              <div className="flex items-center gap-3 mt-3">
                <span className="text-[10px] font-bold bg-amber-100/40 dark:bg-amber-900/40 text-amber-700 px-3 py-1 rounded-lg flex items-center border border-amber-200/20">
                  <Sparkles size={10} className="mr-1" /> {recipe.timesCooked}
                </span>
                {recipe.cookingTime && (
                  <span className="text-[10px] font-bold text-slate-400 flex items-center">
                    <Clock size={10} className="mr-1" /> {recipe.cookingTime} min
                  </span>
                )}
              </div>
            </div>
            <div className="self-center pr-2">
              <div className="w-10 h-10 rounded-full bg-white/40 dark:bg-slate-700/40 flex items-center justify-center text-slate-400 group-hover:bg-slate-800 group-hover:text-white transition-all">
                <ArrowRight size={16} />
              </div>
            </div>
          </div>
        ))}
        </div>
        {selectedRecipe && (
          <div className="fixed inset-0 bg-[#F2F2F7] dark:bg-black z-[70] overflow-y-auto animate-in slide-in-from-bottom duration-500">
             {/* Use global bg inside modal too */}
             <div className="absolute inset-0 pointer-events-none"><GlobalBackground /></div>
            
            <div className="relative h-80 z-10">
              {selectedRecipe.imageUrl ? (
                <img src={selectedRecipe.imageUrl} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-slate-400 bg-white/40 dark:bg-slate-900/40">
                  <ImageIcon size={36} />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-[#F2F2F7] via-transparent to-black/20 dark:from-black"></div>
              <button
                onClick={() => setSelectedRecipe(null)}
                style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
                className="absolute left-6 z-30 p-3 liquid-bubble rounded-full text-white hover:scale-105 transition-transform"
              >
                <ArrowRight className="rotate-180" size={20} />
              </button>
            </div>
            
            <div className="px-6 -mt-10 relative z-20">
              <div className="liquid-glass rounded-t-[3rem] p-8 pb-32 min-h-screen border-t-0 shadow-[0_-20px_60px_rgba(0,0,0,0.1)]">
                <div className="flex justify-between items-start mb-6">
                  <h2 className="text-3xl font-black text-slate-900 dark:text-white leading-tight flex-1 mr-4 text-glass">{selectedRecipe.title}</h2>
                  <div className="flex gap-1 bg-white/30 dark:bg-slate-800/30 p-2 rounded-2xl border border-white/20">
                    {[1, 2, 3, 4, 5].map(star => (
                      <button key={star} onClick={() => setRecipes(prev => prev.map(r => r.id === selectedRecipe.id ? { ...r, rating: star } : r))}>
                        <Star size={18} className={`transition-colors ${star <= (selectedRecipe.rating || 0) ? "fill-amber-400 text-amber-400" : "text-slate-300 dark:text-slate-600"}`} />
                      </button>
                    ))}
                  </div>
                </div>
                
                <h3 className="font-bold text-lg text-slate-800 dark:text-slate-200 mb-5 text-glass">Ingredients</h3>
                <div className="space-y-3 mb-10">
                  {selectedRecipe.ingredients.map((ing, i) => (
                    <div key={i} className="flex items-center justify-between p-4 rounded-2xl bg-white/40 dark:bg-slate-800/40 border border-white/10 shadow-sm">
                      <div><p className="font-bold text-slate-700 dark:text-slate-300 text-sm">{ing.name}</p><p className="text-xs text-slate-400 font-medium">{ing.quantity}</p></div>
                      {checkIngredientStock(ing) ? <CheckCircle2 size={18} className="text-emerald-500" /> : <AlertCircle size={18} className="text-rose-400" />}
                    </div>
                  ))}
                  <button onClick={() => addMissingToShop(selectedRecipe)} className="w-full py-4 mt-2 text-violet-600 dark:text-violet-400 text-sm font-bold border border-violet-200/50 dark:border-violet-900/50 rounded-2xl hover:bg-violet-100/30 transition-colors">Add missing to list</button>
                </div>

                <h3 className="font-bold text-lg text-slate-800 dark:text-slate-200 mb-5 text-glass">Instructions</h3>
                <div className="space-y-8 relative pl-6 border-l-2 border-slate-200/50 dark:border-slate-700/50 ml-3 mb-12">
                  {selectedRecipe.instructions.map((step, i) => (
                    <div key={i} className="relative pl-8">
                      <span className="absolute -left-[35px] top-0 w-8 h-8 rounded-full bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 text-xs font-bold flex items-center justify-center text-slate-400 shadow-sm">{i + 1}</span>
                      <p className="text-slate-600 dark:text-slate-300 font-medium text-base leading-relaxed">{step}</p>
                    </div>
                  ))}
                </div>
                <button onClick={() => handleCookRecipe(selectedRecipe)} className="w-full py-5 bg-white text-slate-900 dark:bg-white dark:text-slate-900 rounded-[24px] font-bold flex items-center justify-center shadow-[0_14px_30px_-14px_rgba(15,23,42,0.62)] active:scale-95 transition-transform text-lg">
                  <ChefHat size={22} className="mr-3" /> Start Cooking
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderList = () => (
    <div className="p-4 pt-28 pb-40 relative z-10">
      <div className="liquid-glass rounded-[2.5rem] shadow-2xl overflow-hidden min-h-[60vh]">
        <div className="p-8 border-b border-white/10 dark:border-white/5 bg-white/5 backdrop-blur-md">
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 text-glass">Shopping List</h2>
          <p className="text-xs text-slate-400 font-bold uppercase tracking-wider mt-2">{shoppingList.filter(i => !i.checked).length} items remaining</p>
        </div>
        
        {suggestions.length > 0 && (
          <div className="mb-4 pt-6 px-2">
            <div className="flex items-center gap-2 mb-4 pl-6">
              <div className="p-1.5 bg-amber-100/50 dark:bg-amber-900/30 rounded-lg text-amber-600">
                <Lightbulb size={16} className="fill-current" />
              </div>
              <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm text-glass">Suggestions</h3>
            </div>
            <div className="flex gap-4 overflow-x-auto no-scrollbar pb-6 -mx-6 px-12 snap-x">
              {suggestions.map(item => (
                <div key={item.id} className="min-w-[160px] max-w-[160px] liquid-bubble rounded-[20px] p-4 flex flex-col snap-start relative group active:scale-95 transition-transform">
                  <button onClick={() => setDismissedItems(prev => [...prev, item.name])} className="absolute top-2 right-2 text-slate-400 hover:text-rose-400 bg-white/50 rounded-full p-1 z-10">
                    <X size={14} />
                  </button>
                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md self-start mb-3 ${item.type === 'low' ? 'bg-rose-100/50 text-rose-600' : 'bg-violet-100/50 text-violet-600'}`}>{item.type === 'low' ? "Out of stock" : "Recipe"}</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200 text-sm mb-1 truncate pr-2">{item.name}</span>
                  <button
                    onClick={() => setShoppingList(prev => [...prev, { id: createShoppingItemId('suggest'), name: item.name, quantity: 1, checked: false }])}
                    className="mt-auto w-full py-2.5 bg-slate-800 dark:bg-slate-600 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-colors shadow-lg"
                  >
                    <Plus size={14} /> Add
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="px-6 pt-2 pb-2">
          <div className="relative flex items-center shadow-inner rounded-[24px] liquid-concave">
            <input
              value={quickAddText}
              onChange={(e) => setQuickAddText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd()}
              placeholder="Quick add..."
              className="w-full bg-transparent rounded-[24px] pl-6 pr-14 py-4 text-sm font-medium outline-none text-slate-700 dark:text-slate-200 placeholder-slate-400"
            />
            <button onClick={handleQuickAdd} className="absolute right-2 p-2.5 bg-slate-900 dark:bg-slate-700 text-white rounded-[18px] shadow-md hover:scale-105 transition-transform">
              <Plus size={18} />
            </button>
          </div>
        </div>

        <div className="p-6">
          {shoppingList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-slate-300 dark:text-slate-600">
              <ShoppingCart size={48} className="mb-4 opacity-50" />
              <p className="font-medium text-sm">List is empty</p>
            </div>
          ) : (
            <div className="space-y-3">
              {shoppingList.map((item, idx) => (
                <div
                  key={item.id}
                  style={{ animationDelay: `${idx * 30}ms` }}
                  className={`flex items-center p-4 rounded-[24px] transition-all animate-fade-in-up opacity-0 ${item.checked ? 'bg-slate-100/20 dark:bg-slate-800/20 opacity-40 blur-[0.5px]' : 'liquid-glass hover:bg-white/40'}`}
                >
                  <button
                    onClick={() => {
                      setShoppingList(prev => prev.map((entry) => (
                        entry.id === item.id ? { ...entry, checked: !entry.checked } : entry
                      )));
                    }}
                    className={`w-7 h-7 rounded-full border-2 mr-4 flex items-center justify-center transition-all duration-300 flex-shrink-0 ${item.checked ? 'border-cyan-500 bg-cyan-500 scale-110 shadow-[0_0_10px_rgba(6,182,212,0.5)]' : 'border-slate-300 dark:border-slate-600 bg-white/20 hover:border-cyan-400'}`}
                  >
                    {item.checked && <CheckCircle2 size={16} className="text-white" strokeWidth={3} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={`font-bold text-sm truncate transition-colors ${item.checked ? 'text-slate-400 line-through' : 'text-slate-800 dark:text-slate-200'}`}>{item.name}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-slate-500 bg-slate-100/50 dark:bg-slate-800/50 px-3 py-1.5 rounded-xl">{item.quantity}</span>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setShoppingList(prev => prev.filter(i => i.id !== item.id));
                        if (String(item.id).includes('auto')) setDismissedItems(prev => [...prev, item.name]);
                      }}
                      className="w-10 h-10 flex items-center justify-center text-slate-300 hover:text-rose-500 rounded-full transition-colors hover:bg-rose-50/50"
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <button
        onClick={() => { const checked = shoppingList.filter(i => i.checked); if (checked.length === 0) return alert("Please check items first."); setPendingPurchases(checked.map(i => ({ ...i, finalPrice: 0 }))); setShowFinishModal(true); }}
        className="mt-6 w-full py-5 bg-white text-slate-900 dark:bg-white dark:text-slate-900 rounded-[28px] font-bold shadow-[0_20px_40px_-18px_rgba(15,23,42,0.6)] flex items-center justify-center active:scale-95 transition-transform text-sm hover:shadow-[0_20px_40px_-14px_rgba(15,23,42,0.58)]"
      >
        Finish shopping <ArrowRight size={18} className="ml-2" />
      </button>
    </div>
  );

  // --- Main Render with Login Check ---

  if (!authReady) {
    return (
      <React.Fragment>
        <div className={`transition-colors duration-700 ${theme === 'dark' ? 'dark' : ''}`}>
          <LoadingOverlay message="Restoring session..." />
        </div>
      </React.Fragment>
    );
  }

  if (!userSettings.account?.sessionToken) {
    return (
      <React.Fragment>
        <div className={`transition-colors duration-700 ${theme === 'dark' ? 'dark' : ''}`}>
          <AccountAuth onAuthenticated={handleAccountAuthenticated} theme={theme} onThemeSelect={setTheme} />
        </div>
      </React.Fragment>
    );
  }

  if (!userSettings.activeHouseId && !showOnboarding) {
      return (
        <React.Fragment>
            <div className={`transition-colors duration-700 ${theme === 'dark' ? 'dark' : ''}`}>
                 <Onboarding account={userSettings.account} onComplete={handleOnboardingComplete} />
            </div>
        </React.Fragment>
      )
  }

  // Adding a second house
  if (showOnboarding) {
      return (
        <React.Fragment>
            <div className={`transition-colors duration-700 ${theme === 'dark' ? 'dark' : ''}`}>
                 <Onboarding 
                    account={userSettings.account}
                    onComplete={handleOnboardingComplete} 
                    onCancel={() => setShowOnboarding(false)}
                    isAddingMore
                 />
            </div>
        </React.Fragment>
      )
  }

  return (
    <div className="min-h-screen font-sans transition-colors duration-700 relative overflow-x-hidden text-slate-900 dark:text-slate-100 selection:bg-cyan-500/30">
      <GlobalBackground />
      {!selectedRecipe && (
        <Header
          title="FoodFlow"
          onAssistant={() => setLiveAssistantOpen(true)}
          onSmartOrganize={handleSmartOrganize}
          onRetrySync={() => setSyncStatus('syncing')}
          onOpenMenu={() => setShowHouseMenu(true)}
          syncStatus={syncStatus}
          theme={theme}
          toggleTheme={toggleTheme}
          houseName={currentHouseName}
        />
      )}
      <main className={`max-w-md mx-auto relative ${selectedRecipe ? 'z-[80]' : 'z-10'}`}>
        {activeTab === AppTab.Fridge && renderDashboard()}
        {activeTab === AppTab.Recipes && renderRecipes()}
        {activeTab === AppTab.List && renderList()}
        {activeTab === AppTab.Stats && <div className="p-4 pt-28 pb-40 relative z-10"><ExpenseAnalytics expenses={expenses} recipes={recipes} currency={currentCurrency} /></div>}
      </main>
      
      {/* Liquid Capsule Navigation */}
      {!selectedRecipe && (
        <nav className="fixed bottom-8 left-1/2 -translate-x-1/2 w-[calc(100%-4rem)] max-w-[320px] liquid-glass rounded-full shadow-[0_24px_60px_-30px_rgba(2,6,23,0.8)] p-2 z-40 flex justify-between items-center transition-all duration-300 hover:scale-[1.01]">
          {[{ id: AppTab.Fridge, icon: LayoutGrid }, { id: AppTab.Recipes, icon: BookOpen }, { id: AppTab.List, icon: ShoppingCart }, { id: AppTab.Stats, icon: PieChart }].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-14 h-14 rounded-full flex items-center justify-center transition-all duration-500 relative ${activeTab === tab.id ? 'text-white' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
            >
              {activeTab === tab.id && (
                  <div className="absolute inset-0 bg-gradient-to-r from-cyan-500 to-violet-500 dark:from-cyan-400 dark:to-violet-400 rounded-full shadow-[0_12px_22px_-10px_rgba(34,211,238,0.8)] transition-all duration-500"></div>
              )}
              <div className="relative z-10">
                <tab.icon size={22} strokeWidth={activeTab === tab.id ? 2.5 : 2} className={`transition-all ${activeTab === tab.id ? 'text-white' : ''}`} />
              </div>
            </button>
          ))}
        </nav>
      )}

      {/* House Switching Menu */}
      {showHouseMenu && (
        <HouseMenu 
            userSettings={userSettings}
            currentHouseName={currentHouseName}
            onClose={() => setShowHouseMenu(false)}
            onSwitch={handleHouseSwitch}
            onAdd={() => setShowOnboarding(true)}
            onOpenAdmin={() => {
              if (currentHouseRole !== 'owner') {
                alert('Only the owner can access admin tools.');
                return;
              }
              setShowHouseMenu(false);
              setShowAdminPanel(true);
            }}
            currentHouseRole={currentHouseRole}
            onLogout={() => { void handleLogout(); }}
        />
      )}

      {showAdminPanel && (
        <HouseAdminPanel
          house={currentHouse || null}
          members={houseMembers}
          activity={houseActivity}
          isLoading={adminLoading}
          onClose={() => setShowAdminPanel(false)}
          onRefresh={() => { void loadOwnerAdminData(); }}
          onRename={handleRenameActiveHouse}
          onChangePassword={handleChangeActiveHousePassword}
          onRemoveMember={handleRemoveActiveHouseMember}
          onDeleteHouse={handleDeleteActiveHouse}
        />
      )}

      {/* Modals updated to use liquid glass styling */}
      {showManualAdd && (
        <div className="fixed inset-0 bg-white/20 dark:bg-black/40 backdrop-blur-2xl z-50 flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div className="liquid-glass rounded-[2.5rem] p-8 w-full max-w-sm shadow-2xl border-t border-white/40">
            <div className="flex justify-between items-center mb-8">
              <h3 className="font-bold text-2xl text-slate-800 dark:text-slate-200 text-glass">Manual Add</h3>
              <button onClick={() => setShowManualAdd(false)} className="p-2.5 bg-white/50 dark:bg-slate-800/50 rounded-full text-slate-500 hover:bg-white/80 transition-colors">
                <X size={22} />
              </button>
            </div>
            <form onSubmit={handleManualSubmit} className="space-y-5">
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase tracking-wide">Name</label>
                <input
                  name="name"
                  required
                  placeholder="e.g. Milk"
                  className="w-full liquid-concave rounded-[20px] p-4 text-base focus:border-white/50 outline-none text-slate-900 dark:text-white transition-all bg-transparent"
                  autoFocus
                  value={manualAddName}
                  onChange={(e) => setManualAddName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase tracking-wide">Quantity</label>
                  <input
                    type="number"
                    step="0.1"
                    name="quantity"
                    defaultValue="1"
                    className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white transition-all bg-transparent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase tracking-wide">Unit</label>
                  <input
                    name="unit"
                    list="units"
                    defaultValue="pcs"
                    className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white transition-all bg-transparent"
                  />
                  <datalist id="units">
                    <option value="pcs" />
                    <option value="kg" />
                    <option value="l" />
                    <option value="pack" />
                  </datalist>
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase tracking-wide">Category</label>
                <div className="relative">
                  <select
                    name="category"
                    className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none appearance-none text-slate-900 dark:text-white transition-all bg-transparent"
                    value={manualAddCategory}
                    onChange={(e) => setManualAddCategory(e.target.value as Category)}
                  >
                    <option value="Other">Auto (AI)</option>
                    {Object.keys(CATEGORY_ICONS).map((key) => (<option key={key} value={key}>{key}</option>))}
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                    <ArrowRight size={16} className="rotate-90" />
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-2 ml-1 uppercase tracking-wide">Price ({currentCurrency})</label>
                <input
                  type="number"
                  step="100"
                  name="price"
                  placeholder="0"
                  className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white transition-all bg-transparent"
                />
              </div>
              <button type="submit" className="w-full py-5 bg-white text-slate-900 dark:bg-white dark:text-slate-900 rounded-[24px] font-bold shadow-[0_14px_30px_-14px_rgba(15,23,42,0.62)] hover:scale-[1.02] mt-4 text-base flex items-center justify-center transition-transform">
                {isProcessing ? <Loader2 className="animate-spin mr-2" size={20} /> : null} Create
              </button>
            </form>
          </div>
        </div>
      )}
      
      {/* Editing Modal - Reused styling */}
      {editingItem && (
        <div className="fixed inset-0 bg-white/20 dark:bg-black/40 backdrop-blur-2xl z-50 flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div className="liquid-glass rounded-[2.5rem] p-8 w-full max-w-sm shadow-2xl">
            <div className="flex justify-between items-center mb-8">
              <h3 className="font-bold text-2xl text-slate-800 dark:text-slate-200 flex items-center gap-2 text-glass">
                <Edit2 size={24} /> Edit Item
              </h3>
              <button onClick={() => { setEditingItem(null); setDeleteConfirm(false); }} className="p-2.5 bg-white/50 dark:bg-slate-800/50 rounded-full text-slate-500 hover:bg-white/80 transition-colors">
                <X size={22} />
              </button>
            </div>
            <form onSubmit={handleEditSubmit} className="space-y-5">
              {/* Inputs use liquid-concave */}
              <div><label className="block text-xs font-bold text-slate-500 mb-2 ml-1">Name</label><input name="name" defaultValue={editingItem.name} className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-xs font-bold text-slate-500 mb-2 ml-1">Quantity</label><input type="number" step="0.1" name="quantity" defaultValue={editingItem.quantity} className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" /></div>
                <div><label className="block text-xs font-bold text-slate-500 mb-2 ml-1">Unit</label><input name="unit" defaultValue={editingItem.unit} className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" /></div>
              </div>
              <div><label className="block text-xs font-bold text-slate-500 mb-2 ml-1">Category</label><div className="relative"><select name="category" defaultValue={editingItem.category} className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none appearance-none text-slate-900 dark:text-white bg-transparent">{Object.keys(CATEGORY_ICONS).map((key) => (<option key={key} value={key}>{key}</option>))}</select><div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400"><ArrowRight size={16} className="rotate-90" /></div></div></div>
              <div><label className="block text-xs font-bold text-slate-500 mb-2 ml-1">Price ({currentCurrency})</label><input type="number" step="100" name="price" defaultValue={editingItem.price || 0} className="w-full liquid-concave rounded-[20px] p-4 text-base outline-none text-slate-900 dark:text-white bg-transparent" /></div>
              
              <button type="submit" className="w-full py-5 bg-white text-slate-900 dark:bg-white dark:text-slate-900 rounded-[24px] font-bold shadow-[0_14px_30px_-14px_rgba(15,23,42,0.62)] mt-4 text-base transition-transform active:scale-95">Save Changes</button>
              
              {!deleteConfirm ? (
                <div className="flex gap-3">
                    <button type="button" onClick={handleRegenerateImage} className="flex-1 py-3 bg-violet-100/30 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 rounded-[20px] font-bold text-xs flex items-center justify-center gap-2 hover:bg-violet-200/40 transition-colors border border-violet-200/20"><ImageIcon size={16} /> New Photo</button>
                    <button type="button" onClick={() => setDeleteConfirm(true)} className="flex-1 py-3 bg-rose-100/30 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 rounded-[20px] font-bold text-xs flex items-center justify-center gap-2 hover:bg-rose-200/40 transition-colors border border-rose-200/20"><Trash2 size={16} /> Delete</button>
                </div>
              ) : (
                <div className="flex gap-3 animate-in fade-in zoom-in-95 duration-200">
                    <button type="button" onClick={() => setDeleteConfirm(false)} className="flex-1 py-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-[20px] font-bold text-xs flex items-center justify-center gap-2 transition-colors">Cancel</button>
                    <button type="button" onClick={performDelete} className="flex-1 py-3 bg-rose-500 text-white rounded-[20px] font-bold text-xs flex items-center justify-center gap-2 shadow-lg hover:bg-rose-600 transition-colors">Yes, delete</button>
                </div>
              )}
            </form>
          </div>
        </div>
      )}
      
      {isProcessing && <LoadingOverlay message={loadingMessage} />}
      
      {showFinishModal && (
        <div className="fixed inset-0 bg-white/20 dark:bg-black/40 backdrop-blur-2xl z-50 flex items-center justify-center p-6 animate-in fade-in zoom-in-95 duration-200">
          <div className="liquid-glass rounded-[2.5rem] p-10 w-full max-w-sm shadow-2xl text-center border-t border-white/40">
            <div className="w-24 h-24 bg-emerald-100/40 dark:bg-emerald-900/40 rounded-full flex items-center justify-center mx-auto mb-6 text-emerald-600 dark:text-emerald-400 shadow-inner border border-emerald-200/20">
              <CheckCircle2 size={48} />
            </div>
            <h3 className="font-bold text-3xl text-slate-800 dark:text-slate-200 mb-3 text-glass">Complete!</h3>
            <p className="text-slate-500 mb-10 text-lg font-medium">{pendingPurchases.length} items added.</p>
            <button onClick={confirmFinishShopping} className="w-full py-5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-[24px] font-bold shadow-xl shadow-emerald-500/30 transition-all text-base active:scale-95">Excellent</button>
          </div>
        </div>
      )}
      
      {isLiveAssistantOpen && <LiveAssistant isActive={isLiveAssistantOpen} onClose={() => setLiveAssistantOpen(false)} onToolUse={handleVoiceToolUse} />}
    </div>
  );
}
