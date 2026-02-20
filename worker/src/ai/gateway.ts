import { geminiProvider } from './providers/gemini';
import { huggingFaceProvider } from './providers/huggingface';
import {
  AIProviderError,
  AIRequestOptions,
  AIResponseNormalized,
  AITaskType,
} from './types';

export interface AIGatewayEnv {
  GEMINI_API_KEY?: string;
  GEMINI_TIMEOUT_MS?: string;
  HUGGINGFACE_API_KEY?: string;
  HUGGINGFACE_TEXT_MODEL?: string;
  HUGGINGFACE_IMAGE_MODEL?: string;
  GEMINI_USAGE_MODE?: string;
  GEMINI_MAX_REQUESTS_PER_MINUTE?: string;
  GEMINI_MAX_CONCURRENT?: string;
  GEMINI_RATE_LIMIT_COOLDOWN_MS?: string;
}

const GEMINI_MODEL_PRIMARY = 'gemini-3-pro-preview';
const GEMINI_MODEL_CHAIN = ['gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];
const GEMINI_MODEL_PRIMARY_FREE = 'gemini-2.5-flash';
const GEMINI_MODEL_CHAIN_FREE = ['gemini-3-flash-preview', 'gemini-2.5-flash'];

type UsageMode = 'free' | 'paid';

interface UsagePolicy {
  mode: UsageMode;
  maxRequestsPerMinute: number;
  maxConcurrent: number;
  cooldownMs: number;
}

interface GatewayUsageState {
  windowStartMs: number;
  requestsInWindow: number;
  concurrent: number;
  cooldownUntilMs: number;
}

const gatewayUsageState: GatewayUsageState = {
  windowStartMs: 0,
  requestsInWindow: 0,
  concurrent: 0,
  cooldownUntilMs: 0,
};

const parseBoundedInt = (
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number.parseInt(rawValue || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const resolveUsageMode = (env: AIGatewayEnv): UsageMode => {
  const raw = (env.GEMINI_USAGE_MODE || 'auto').trim().toLowerCase();
  if (raw === 'paid') return 'paid';
  if (raw === 'free') return 'free';
  // Safe default for unknown mode: protect key and stay within free-tier-like limits.
  return 'free';
};

const resolveUsagePolicy = (env: AIGatewayEnv): UsagePolicy => {
  const mode = resolveUsageMode(env);
  const defaults =
    mode === 'paid'
      ? { maxRequestsPerMinute: 240, maxConcurrent: 8, cooldownMs: 10_000 }
      : { maxRequestsPerMinute: 40, maxConcurrent: 2, cooldownMs: 25_000 };

  return {
    mode,
    maxRequestsPerMinute: parseBoundedInt(
      env.GEMINI_MAX_REQUESTS_PER_MINUTE,
      defaults.maxRequestsPerMinute,
      1,
      10_000
    ),
    maxConcurrent: parseBoundedInt(env.GEMINI_MAX_CONCURRENT, defaults.maxConcurrent, 1, 256),
    cooldownMs: parseBoundedInt(env.GEMINI_RATE_LIMIT_COOLDOWN_MS, defaults.cooldownMs, 1_000, 300_000),
  };
};

const nowMs = (): number => Date.now();

const refreshUsageWindow = (now: number): void => {
  if (gatewayUsageState.windowStartMs === 0 || now - gatewayUsageState.windowStartMs >= 60_000) {
    gatewayUsageState.windowStartMs = now;
    gatewayUsageState.requestsInWindow = 0;
  }
};

const registerGeminiPressure = (policy: UsagePolicy, reason: 'rate_limited' | 'quota_exceeded'): void => {
  const baseCooldown = reason === 'quota_exceeded' ? policy.cooldownMs * 2 : policy.cooldownMs;
  const nextCooldownUntil = nowMs() + baseCooldown;
  if (nextCooldownUntil > gatewayUsageState.cooldownUntilMs) {
    gatewayUsageState.cooldownUntilMs = nextCooldownUntil;
  }
};

const acquireGeminiPermit = (policy: UsagePolicy): (() => void) => {
  const now = nowMs();
  refreshUsageWindow(now);

  if (gatewayUsageState.cooldownUntilMs > now) {
    const waitMs = gatewayUsageState.cooldownUntilMs - now;
    throw new AIProviderError({
      provider: 'gemini',
      code: 'rate_limited',
      retryable: true,
      status: 429,
      message: `Gateway limiter cooldown active (${waitMs}ms remaining).`,
    });
  }

  if (gatewayUsageState.concurrent >= policy.maxConcurrent) {
    throw new AIProviderError({
      provider: 'gemini',
      code: 'rate_limited',
      retryable: true,
      status: 429,
      message: 'Gateway limiter concurrent request ceiling reached.',
    });
  }

  if (gatewayUsageState.requestsInWindow >= policy.maxRequestsPerMinute) {
    registerGeminiPressure(policy, 'rate_limited');
    throw new AIProviderError({
      provider: 'gemini',
      code: 'rate_limited',
      retryable: true,
      status: 429,
      message: 'Gateway limiter per-minute request ceiling reached.',
    });
  }

  gatewayUsageState.requestsInWindow += 1;
  gatewayUsageState.concurrent += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    gatewayUsageState.concurrent = Math.max(0, gatewayUsageState.concurrent - 1);
  };
};

const isGatewayLimiterError = (error: AIProviderError): boolean => {
  return error.code === 'rate_limited' && error.message.toLowerCase().includes('gateway limiter');
};

const defaultByTask = (task: AITaskType) => {
  if (task === 'image') {
    return {
      geminiModel: 'gemini-2.5-flash-image',
      geminiModelFallbacks: [],
      huggingFaceModel: '',
      temperature: 0.2,
      maxTokens: 600,
      timeoutMs: 10_000,
      allowFallback: true,
      parts: [],
      task,
    };
  }
  if (task === 'json') {
    return {
      geminiModel: GEMINI_MODEL_PRIMARY,
      geminiModelFallbacks: GEMINI_MODEL_CHAIN,
      huggingFaceModel: '',
      temperature: 0.2,
      maxTokens: 1200,
      timeoutMs: 10_000,
      allowFallback: true,
      parts: [],
      task,
    };
  }
  return {
    geminiModel: GEMINI_MODEL_PRIMARY,
    geminiModelFallbacks: GEMINI_MODEL_CHAIN,
    huggingFaceModel: '',
    temperature: 0.3,
    maxTokens: 1200,
    timeoutMs: 10_000,
    allowFallback: true,
    parts: [],
    task,
  };
};

const normalizeOptions = (options: AIRequestOptions): Required<AIRequestOptions> => {
  const task = options.task || 'text';
  const defaults = defaultByTask(task);
  return {
    task,
    timeoutMs: options.timeoutMs ?? defaults.timeoutMs,
    temperature: options.temperature ?? defaults.temperature,
    maxTokens: options.maxTokens ?? defaults.maxTokens,
    geminiModel: options.geminiModel ?? defaults.geminiModel,
    geminiModelFallbacks: options.geminiModelFallbacks ?? defaults.geminiModelFallbacks,
    huggingFaceModel: options.huggingFaceModel ?? defaults.huggingFaceModel,
    parts: options.parts ?? defaults.parts,
    allowFallback: options.allowFallback ?? defaults.allowFallback,
  };
};

const makeRequestId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const toProviderError = (error: unknown): AIProviderError => {
  if (error instanceof AIProviderError) {
    return error;
  }
  return new AIProviderError({
    provider: 'gemini',
    code: 'unknown',
    retryable: false,
    message: error instanceof Error ? error.message : 'Unknown AI error',
  });
};

const isFallbackEligible = (error: AIProviderError, options: Required<AIRequestOptions>): boolean => {
  if (!options.allowFallback) return false;
  if (!error.retryable) return false;
  if (error.code === 'invalid_input' || error.code === 'schema_error' || error.code === 'authentication') {
    return false;
  }
  return true;
};

const buildGeminiAttemptModels = (options: Required<AIRequestOptions>): string[] => {
  const candidates = [options.geminiModel, ...options.geminiModelFallbacks]
    .map(model => model.trim())
    .filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const model of candidates) {
    if (seen.has(model)) continue;
    seen.add(model);
    unique.push(model);
  }
  return unique;
};

const mapModelForUsageMode = (model: string, mode: UsageMode): string => {
  if (mode !== 'free') return model;

  const normalized = model.trim();
  if (normalized === 'gemini-3-pro-preview') return 'gemini-3-flash-preview';
  if (normalized === 'gemini-2.5-pro') return 'gemini-2.5-flash';
  return normalized;
};

const applyUsageModeToOptions = (
  options: Required<AIRequestOptions>,
  policy: UsagePolicy
): Required<AIRequestOptions> => {
  if (policy.mode !== 'free') {
    return options;
  }

  // Free-tier-like operation: prefer flash models to maximize successful throughput.
  const remappedPrimary = mapModelForUsageMode(options.geminiModel, policy.mode);
  const remappedFallbacks = options.geminiModelFallbacks.map(model => mapModelForUsageMode(model, policy.mode));

  const withDefaults = [remappedPrimary, ...remappedFallbacks];
  const defaults = options.task === 'image' ? [] : [GEMINI_MODEL_PRIMARY_FREE, ...GEMINI_MODEL_CHAIN_FREE];

  const mergedModels = [...withDefaults, ...defaults];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const model of mergedModels) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    deduped.push(model);
  }

  return {
    ...options,
    geminiModel: deduped[0] || options.geminiModel,
    geminiModelFallbacks: deduped.slice(1),
  };
};

const logGatewayEvent = (event: {
  requestId: string;
  provider: 'gemini' | 'huggingface' | 'none';
  fallbackUsed: boolean;
  latencyMs: number;
  status: 'success' | 'failure';
  mode: UsageMode;
  reason?: string;
}) => {
  console.log(
    JSON.stringify({
      event: 'ai_gateway_request',
      request_id: event.requestId,
      provider: event.provider,
      fallback_used: event.fallbackUsed,
      latency_ms: event.latencyMs,
      status: event.status,
      usage_mode: event.mode,
      failure_reason: event.reason || null,
    })
  );
};

// Public gateway interface required by the app.
export const generateAIResponse = async (
  prompt: string,
  options: AIRequestOptions,
  env: AIGatewayEnv
): Promise<AIResponseNormalized> => {
  const requestId = makeRequestId();
  const usagePolicy = resolveUsagePolicy(env);
  const normalized = applyUsageModeToOptions(normalizeOptions(options), usagePolicy);
  const startedAt = Date.now();

  if (!prompt.trim() && normalized.parts.length === 0) {
    throw new AIProviderError({
      provider: 'gemini',
      code: 'invalid_input',
      retryable: false,
      message: 'Prompt is required',
    });
  }

  const geminiModels = buildGeminiAttemptModels(normalized);
  let lastGeminiError: AIProviderError | null = null;

  for (let modelIndex = 0; modelIndex < geminiModels.length; modelIndex += 1) {
    const model = geminiModels[modelIndex];
    let releasePermit: (() => void) | null = null;
    try {
      releasePermit = acquireGeminiPermit(usagePolicy);
      const geminiResult = await geminiProvider.generate(
        env,
        prompt,
        { ...normalized, geminiModel: model },
        requestId
      );

      const totalLatency = Date.now() - startedAt;
      logGatewayEvent({
        requestId,
        provider: 'gemini',
        fallbackUsed: modelIndex > 0,
        latencyMs: totalLatency,
        status: 'success',
        mode: usagePolicy.mode,
      });
      return {
        text: geminiResult.text,
        provider: 'gemini',
        latency_ms: totalLatency,
        fallback_used: modelIndex > 0,
      };
    } catch (geminiUnknownError) {
      const geminiError = toProviderError(geminiUnknownError);
      lastGeminiError = geminiError;

      if (geminiError.code === 'rate_limited' || geminiError.code === 'quota_exceeded') {
        registerGeminiPressure(
          usagePolicy,
          geminiError.code === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited'
        );
      }

      console.log(
        JSON.stringify({
          event: 'ai_gemini_attempt',
          request_id: requestId,
          model,
          attempt: modelIndex + 1,
          usage_mode: usagePolicy.mode,
          code: geminiError.code,
          retryable: geminiError.retryable,
          message: geminiError.message,
        })
      );

      if (isGatewayLimiterError(geminiError)) {
        // Stop trying more Gemini models during local limiter pressure.
        break;
      }

      if (!geminiError.retryable) {
        const totalLatency = Date.now() - startedAt;
        logGatewayEvent({
          requestId,
          provider: 'gemini',
          fallbackUsed: modelIndex > 0,
          latencyMs: totalLatency,
          status: 'failure',
          mode: usagePolicy.mode,
          reason: `${geminiError.code}:${geminiError.message}`,
        });
        throw geminiError;
      }
    } finally {
      if (releasePermit) {
        releasePermit();
      }
    }
  }

  const fallbackSourceError =
    lastGeminiError ||
    new AIProviderError({
      provider: 'gemini',
      code: 'provider_unavailable',
      retryable: true,
      message: 'Gemini provider chain exhausted',
    });

  // Multimodal requests (audio/image parts) must never degrade into text-only fallback.
  // Stripping parts can fabricate content that was never in the input.
  const hasMultimodalParts = normalized.parts.length > 0;
  const canFallback =
    Boolean(env.HUGGINGFACE_API_KEY) &&
    normalized.task !== 'image' &&
    !hasMultimodalParts &&
    isFallbackEligible(fallbackSourceError, normalized);
  if (!canFallback) {
    const totalLatency = Date.now() - startedAt;
    logGatewayEvent({
      requestId,
      provider: 'gemini',
      fallbackUsed: geminiModels.length > 1,
      latencyMs: totalLatency,
      status: 'failure',
      mode: usagePolicy.mode,
      reason: hasMultimodalParts
        ? 'multimodal_fallback_not_supported'
        : `${fallbackSourceError.code}:${fallbackSourceError.message}`,
    });
    throw fallbackSourceError;
  }

  try {
    const fallbackResult = await huggingFaceProvider.generate(env, prompt, normalized, requestId);
    const totalLatency = Date.now() - startedAt;
    logGatewayEvent({
      requestId,
      provider: 'huggingface',
      fallbackUsed: true,
      latencyMs: totalLatency,
      status: 'success',
      mode: usagePolicy.mode,
    });
    return {
      text: fallbackResult.text,
      provider: 'huggingface',
      latency_ms: totalLatency,
      fallback_used: true,
    };
  } catch (hfUnknownError) {
    const hfError = toProviderError(hfUnknownError);
    const totalLatency = Date.now() - startedAt;
    logGatewayEvent({
      requestId,
      provider: 'huggingface',
      fallbackUsed: true,
      latencyMs: totalLatency,
      status: 'failure',
      mode: usagePolicy.mode,
      reason: `${hfError.code}:${hfError.message}`,
    });
    throw hfError;
  }
};
