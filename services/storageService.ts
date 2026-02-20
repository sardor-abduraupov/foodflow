import { InventoryItem, ShoppingItem, Recipe, ExpenseRecord, SavedHouse, UserAccount, HouseRole } from '../types';

export interface AppState {
  inventory: InventoryItem[];
  shoppingList: ShoppingItem[];
  recipes: Recipe[];
  expenses: ExpenseRecord[];
  updatedAt: number;
  houseName?: string;
  currency?: string;
}

export interface AuthSeed {
  sessionToken?: string;
  username?: string;
  displayName?: string;
  password?: string;
}

export interface HouseBootstrap {
  account: UserAccount;
  house: SavedHouse;
  state: AppState;
}

export interface SessionSnapshot {
  account: Omit<UserAccount, 'sessionToken'>;
  houses: SavedHouse[];
}

export interface HouseMember {
  username: string;
  displayName: string;
  role: HouseRole;
  joinedAt: number;
}

export interface HouseActivityEvent {
  id: number;
  actorUsername: string;
  action: string;
  metadata: string | null;
  createdAt: number;
}

interface CreateJoinResponse {
  account: UserAccount;
  house: {
    id: string;
    name: string;
    currency?: string;
    role?: string;
  };
  state: AppState;
}

interface FetchHouseResponse {
  house: {
    id: string;
    name: string;
    currency?: string;
    role?: string;
  };
  state: AppState;
}

interface HouseUpdateResponse {
  success: boolean;
  updatedAt?: number;
}

interface AuthLoginResponse {
  account: UserAccount;
  houses: Array<{
    id: string;
    name: string;
    currency?: string;
    role?: string;
  }>;
}

interface SessionResponse {
  account: {
    username: string;
    displayName: string;
  };
  houses: Array<{
    id: string;
    name: string;
    currency?: string;
    role?: string;
  }>;
}

interface ListMembersResponse {
  members: Array<{
    username: string;
    displayName: string;
    role: string;
    joinedAt: number;
  }>;
}

interface ActivityResponse {
  events: Array<{
    id: number;
    actorUsername: string;
    action: string;
    metadata: string | null;
    createdAt: number;
  }>;
}

const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/$/, '');
const fallbackApiBases = ((import.meta.env.VITE_API_FALLBACK_BASE_URLS as string | undefined) || '')
  .split(',')
  .map(base => base.trim().replace(/\/$/, ''))
  .filter(Boolean);
const REQUEST_TIMEOUT_MS = 10_000;
const NETWORK_RETRY_DELAYS_MS = [0, 350, 900] as const;
const RETRIABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEBUG_SYNC = String(import.meta.env.VITE_DEBUG_SYNC || '').toLowerCase() === 'true';

class ApiRequestError extends Error {
  public readonly status: number;
  public readonly path: string;

  constructor(path: string, status: number, message: string) {
    super(message);
    this.status = status;
    this.path = path;
    this.name = 'ApiRequestError';
  }
}

const buildApiUrl = (path: string): string => {
  if (!apiBase) return path;
  return `${apiBase}${path}`;
};

const delay = (ms: number): Promise<void> => {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
};

const isAbortError = (error: unknown): error is DOMException => {
  return error instanceof DOMException && error.name === 'AbortError';
};

const isNetworkTransportError = (error: unknown): boolean => {
  return error instanceof TypeError || isAbortError(error);
};

const getCandidateUrls = (path: string): string[] => {
  const candidates = [buildApiUrl(path)];

  for (const base of fallbackApiBases) {
    candidates.push(`${base}${path}`);
  }

  if (typeof window !== 'undefined' && import.meta.env.PROD && path.startsWith('/api/')) {
    candidates.push(`${window.location.origin}${path}`);
  }

  return Array.from(new Set(candidates));
};

const executePost = async (url: string, payload: unknown): Promise<Response> => {
  let lastError: unknown = new Error('Request failed without a concrete error.');

  for (let attempt = 0; attempt < NETWORK_RETRY_DELAYS_MS.length; attempt += 1) {
    const retryDelay = NETWORK_RETRY_DELAYS_MS[attempt];
    if (retryDelay > 0) await delay(retryDelay);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!RETRIABLE_STATUS_CODES.has(response.status) || attempt === NETWORK_RETRY_DELAYS_MS.length - 1) {
        return response;
      }

      lastError = new ApiRequestError(url, response.status, `Retriable status ${response.status}`);
    } catch (error) {
      lastError = error;
      const canRetry = isNetworkTransportError(error) && attempt < NETWORK_RETRY_DELAYS_MS.length - 1;
      if (!canRetry) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
};

const summarizeStateForDebug = (state: AppState): Record<string, unknown> => {
  const inventoryHead = state.inventory.slice(0, 5).map(item => ({
    id: item.id,
    name: item.name,
    imageUrl: item.imageUrl || '',
  }));

  return {
    updatedAt: state.updatedAt,
    inventoryCount: state.inventory.length,
    shoppingCount: state.shoppingList.length,
    recipeCount: state.recipes.length,
    expenseCount: state.expenses.length,
    inventoryHead,
  };
};

const logSyncDebug = (event: string, payload: Record<string, unknown>) => {
  if (!DEBUG_SYNC) return;
  console.info('[CloudSync]', event, payload);
};

const postJson = async <T>(path: string, payload: unknown): Promise<T> => {
  const candidateUrls = getCandidateUrls(path);
  let lastError: unknown = null;

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await executePost(candidateUrl, payload);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`;
        throw new ApiRequestError(path, response.status, message);
      }

      return data as T;
    } catch (error) {
      lastError = error;
      if (error instanceof ApiRequestError) {
        throw error;
      }
    }
  }

  if (isAbortError(lastError)) {
    throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
  }
  if (lastError instanceof TypeError) {
    throw new Error('Network request failed. This may be caused by temporary HTTP/3 (QUIC) transport issues.');
  }
  if (lastError instanceof Error) throw lastError;

  throw new Error('Request failed due to an unknown network error.');
};

const normalizeRole = (role: string | undefined): HouseRole => {
  return role === 'owner' ? 'owner' : 'member';
};

const sanitizeShoppingList = (value: unknown): ShoppingItem[] => {
  if (!Array.isArray(value)) return [];

  const usedIds = new Set<string>();
  const sanitized: ShoppingItem[] = [];

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const source = entry as Record<string, unknown>;
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    if (!name) return;

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
    else id = `legacy-${name.toLowerCase().replace(/\s+/g, '-')}-${index + 1}`;

    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}-${suffix}`)) {
        suffix += 1;
      }
      id = `${id}-${suffix}`;
    }

    usedIds.add(id);
    sanitized.push({ id, name, quantity, checked });
  });

  return sanitized;
};

const sanitizeAppState = (state: AppState): AppState => {
  return {
    inventory: Array.isArray(state.inventory) ? state.inventory : [],
    shoppingList: sanitizeShoppingList(state.shoppingList),
    recipes: Array.isArray(state.recipes) ? state.recipes : [],
    expenses: Array.isArray(state.expenses) ? state.expenses : [],
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : Date.now(),
    houseName: state.houseName,
    currency: state.currency,
  };
};

const normalizeHouse = (
  house: { id: string; name: string; currency?: string; role?: string },
  fallbackCurrency: string
): SavedHouse => ({
  id: house.id,
  name: house.name,
  currency: house.currency || fallbackCurrency,
  role: normalizeRole(house.role),
});

const sanitizeStateForCloud = (state: AppState): AppState => {
  const sanitized = sanitizeAppState(state);
  return {
    inventory: sanitized.inventory,
    shoppingList: sanitized.shoppingList,
    recipes: sanitized.recipes,
    expenses: sanitized.expenses,
    updatedAt: sanitized.updatedAt,
    houseName: sanitized.houseName,
    currency: sanitized.currency,
  };
};

const normalizeAuthPayload = (auth: AuthSeed): Record<string, string> => {
  const payload: Record<string, string> = {};

  const sessionToken = auth.sessionToken?.trim();
  if (sessionToken) payload.sessionToken = sessionToken;

  const username = auth.username?.trim();
  if (username) payload.username = username;

  const displayName = auth.displayName?.trim();
  if (displayName) payload.displayName = displayName;

  const password = auth.password?.trim();
  if (password) payload.password = password;

  return payload;
};

export const createFamilyDatabase = async (
  initialState: AppState,
  housePassword: string,
  auth: AuthSeed
): Promise<HouseBootstrap | null> => {
  const houseName = initialState.houseName?.trim();
  const normalizedPassword = housePassword.trim();

  if (!houseName || !normalizedPassword) return null;

  try {
    const payload = {
      houseName,
      housePassword: normalizedPassword,
      state: sanitizeStateForCloud({
        ...initialState,
        houseName,
        updatedAt: Date.now(),
      }),
      auth: normalizeAuthPayload(auth),
    };

    const data = await postJson<CreateJoinResponse>('/api/houses/create', payload);
    return {
      account: data.account,
      house: normalizeHouse(data.house, payload.state.currency || '$'),
      state: sanitizeAppState(data.state),
    };
  } catch (error) {
    console.error('Cloud create failed', error);
    return null;
  }
};

export const joinFamilyHouse = async (
  houseId: string,
  housePassword: string,
  auth: AuthSeed
): Promise<HouseBootstrap | null> => {
  const normalizedHouseId = houseId.trim().toUpperCase();
  const normalizedPassword = housePassword.trim();
  if (!normalizedHouseId || !normalizedPassword) return null;

  try {
    const data = await postJson<CreateJoinResponse>('/api/houses/join', {
      houseId: normalizedHouseId,
      housePassword: normalizedPassword,
      auth: normalizeAuthPayload(auth),
    });

    return {
      account: data.account,
      house: normalizeHouse(data.house, data.state.currency || '$'),
      state: sanitizeAppState(data.state),
    };
  } catch (error) {
    console.error('Cloud join failed', error);
    return null;
  }
};

export const fetchFamilyData = async (houseId: string, sessionToken?: string): Promise<AppState | null> => {
  if (!houseId || !sessionToken) return null;

  try {
    const data = await postJson<FetchHouseResponse>('/api/houses/fetch', {
      houseId,
      sessionToken,
    });
    if (data?.state) {
      const sanitizedState = sanitizeAppState(data.state);
      logSyncDebug('fetch_response', {
        houseId,
        ...summarizeStateForDebug(sanitizedState),
      });
      return sanitizedState;
    }
    return null;
  } catch (error) {
    console.error('Cloud fetch failed', error);
    return null;
  }
};

export const loginAccount = async (
  username: string,
  password: string,
  displayName?: string
): Promise<{ account: UserAccount; houses: SavedHouse[] } | null> => {
  const normalizedUsername = username.trim().toLowerCase();
  const normalizedPassword = password.trim();
  const normalizedDisplayName = displayName?.trim();
  if (!normalizedUsername || !normalizedPassword) return null;

  try {
    const authPayload: Record<string, string> = {
      username: normalizedUsername,
      password: normalizedPassword,
    };
    if (normalizedDisplayName) {
      authPayload.displayName = normalizedDisplayName;
    }

    const data = await postJson<AuthLoginResponse>('/api/auth/login', { auth: authPayload });
    return {
      account: data.account,
      houses: data.houses.map(house => normalizeHouse(house, house.currency || '$')),
    };
  } catch (error) {
    console.error('Account login failed', error);
    return null;
  }
};

export type HouseUpdateResult =
  | { status: 'ok'; updatedAt: number }
  | { status: 'stale' }
  | { status: 'error' };

export const updateFamilyData = async (
  houseId: string,
  data: AppState,
  sessionToken?: string,
  baseUpdatedAt = 0
): Promise<HouseUpdateResult> => {
  if (!houseId || !sessionToken) return { status: 'error' };

  const sanitized = sanitizeStateForCloud(data);
  logSyncDebug('update_request', {
    houseId,
    baseUpdatedAt,
    ...summarizeStateForDebug(sanitized),
  });

  try {
    const response = await postJson<HouseUpdateResponse>('/api/houses/update', {
      houseId,
      sessionToken,
      baseUpdatedAt,
      state: sanitized,
    });

    if (response.success) {
      const updatedAt = typeof response.updatedAt === 'number' ? response.updatedAt : sanitized.updatedAt;
      logSyncDebug('update_success', {
        houseId,
        updatedAt,
      });
      return { status: 'ok', updatedAt };
    }

    return { status: 'error' };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      logSyncDebug('update_conflict', {
        houseId,
        baseUpdatedAt,
      });
      return { status: 'stale' };
    }
    console.error('Cloud update failed', error);
    return { status: 'error' };
  }
};

export const validateSession = async (sessionToken: string): Promise<SessionSnapshot | null> => {
  const token = sessionToken.trim();
  if (!token) return null;

  try {
    const data = await postJson<SessionResponse>('/api/auth/session', { sessionToken: token });
    return {
      account: data.account,
      houses: data.houses.map(house => normalizeHouse(house, house.currency || '$')),
    };
  } catch {
    return null;
  }
};

export const logoutSession = async (sessionToken: string): Promise<void> => {
  const token = sessionToken.trim();
  if (!token) return;

  try {
    await postJson<{ success: boolean }>('/api/auth/logout', { sessionToken: token });
  } catch {
    // Ignore logout errors to avoid blocking client cleanup.
  }
};

export const renameHouse = async (
  houseId: string,
  sessionToken: string,
  houseName: string
): Promise<SavedHouse | null> => {
  if (!houseId || !sessionToken || !houseName.trim()) return null;

  try {
    const response = await postJson<{ house: { id: string; name: string; currency?: string; role?: string } }>(
      '/api/houses/rename',
      {
        houseId,
        sessionToken,
        houseName,
      }
    );

    return normalizeHouse(response.house, response.house.currency || '$');
  } catch (error) {
    console.error('House rename failed', error);
    return null;
  }
};

export const changeHousePassword = async (
  houseId: string,
  sessionToken: string,
  newPassword: string
): Promise<boolean> => {
  if (!houseId || !sessionToken || !newPassword.trim()) return false;

  try {
    await postJson<{ success: boolean }>('/api/houses/change-password', {
      houseId,
      sessionToken,
      newPassword,
    });
    return true;
  } catch (error) {
    console.error('House password update failed', error);
    return false;
  }
};

export const deleteHouse = async (houseId: string, sessionToken: string): Promise<boolean> => {
  if (!houseId || !sessionToken) return false;

  try {
    await postJson<{ success: boolean }>('/api/houses/delete', {
      houseId,
      sessionToken,
    });
    return true;
  } catch (error) {
    console.error('House delete failed', error);
    return false;
  }
};

export const fetchHouseMembers = async (houseId: string, sessionToken: string): Promise<HouseMember[]> => {
  if (!houseId || !sessionToken) return [];

  try {
    const data = await postJson<ListMembersResponse>('/api/houses/members', {
      houseId,
      sessionToken,
    });

    return data.members.map(member => ({
      username: member.username,
      displayName: member.displayName,
      role: normalizeRole(member.role),
      joinedAt: Number.isFinite(member.joinedAt) ? member.joinedAt : Date.now(),
    }));
  } catch (error) {
    console.error('Members fetch failed', error);
    return [];
  }
};

export const removeHouseMember = async (
  houseId: string,
  sessionToken: string,
  username: string
): Promise<boolean> => {
  if (!houseId || !sessionToken || !username.trim()) return false;

  try {
    await postJson<{ success: boolean }>('/api/houses/remove-member', {
      houseId,
      sessionToken,
      username,
    });
    return true;
  } catch (error) {
    console.error('Member removal failed', error);
    return false;
  }
};

export const fetchHouseActivity = async (
  houseId: string,
  sessionToken: string,
  limit = 25
): Promise<HouseActivityEvent[]> => {
  if (!houseId || !sessionToken) return [];

  try {
    const data = await postJson<ActivityResponse>('/api/houses/activity', {
      houseId,
      sessionToken,
      limit,
    });

    return data.events.map(event => ({
      id: event.id,
      actorUsername: event.actorUsername,
      action: event.action,
      metadata: event.metadata,
      createdAt: Number.isFinite(event.createdAt) ? event.createdAt : Date.now(),
    }));
  } catch (error) {
    console.error('Activity fetch failed', error);
    return [];
  }
};
