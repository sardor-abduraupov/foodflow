export type Category = 'Produce' | 'Fruits' | 'Dairy' | 'Meat' | 'Pantry' | 'Beverages' | 'Frozen' | 'Other';

export interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  category: Category;
  addedDate: string;
  expiryDate?: string; // AI estimated
  price?: number;
  imageUrl?: string;
  // English, singular, base form (e.g. "flour" for "wheat flour", "milk" for "молоко")
  canonicalName?: string; 
  // Stable ID for grouping/caching (e.g. "fruit-apple-default")
  canonicalId?: string;
  // Legacy/Fallback for visual search, often similar to canonicalName
  imageKeyword?: string;
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: number;
  checked: boolean;
}

export interface RecipeIngredient {
  name: string;
  quantity: string; // Keep as string for flexibility (e.g. "2 cups")
  category?: Category;
  // English, singular, base form for matching
  canonicalName?: string;
}

export interface Recipe {
  id: string;
  title: string;
  ingredients: RecipeIngredient[];
  instructions: string[];
  timesCooked: number;
  cookingTime?: number; // minutes
  rating?: number; // 0-5
  imageUrl?: string;
  source?: string;
}

export enum AppTab {
  Fridge = 'fridge',
  Add = 'add',
  Recipes = 'recipes',
  List = 'list',
  Stats = 'stats',
  Assistant = 'assistant'
}

export interface ExpenseRecord {
  date: string;
  amount: number;
  category: Category;
}

export interface SavedHouse {
  id: string;
  name: string;
  currency?: string;
  role: HouseRole;
}

export type HouseRole = 'owner' | 'member';

export interface UserAccount {
  username: string;
  displayName: string;
  sessionToken: string;
}

export interface UserSettings {
  account: UserAccount | null;
  currency: string;
  activeHouseId: string | null;
  savedHouses: SavedHouse[];
}
