import {
  AIProviderAdapter,
  AIProviderError,
  AIRequestOptions,
  AIRequestPart,
  AIProviderResponse,
} from '../types';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TEXT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_TIMEOUT_MS = 10_000;

interface GeminiEnv {
  GEMINI_API_KEY?: string;
  GEMINI_TIMEOUT_MS?: string;
}

type JsonRecord = Record<string, unknown>;

const parseResponseText = (response: JsonRecord): string => {
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return '';
  }

  const firstCandidate = candidates[0] as JsonRecord;
  const content = firstCandidate.content as JsonRecord | undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];

  for (const part of parts) {
    const partRecord = part as JsonRecord;
    if (typeof partRecord.text === 'string' && partRecord.text.trim()) {
      return partRecord.text;
    }
  }

  return '';
};

const parseInlineImage = (response: JsonRecord): string | null => {
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const firstCandidate = candidates[0] as JsonRecord;
  const content = firstCandidate.content as JsonRecord | undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];

  for (const part of parts) {
    const partRecord = part as JsonRecord;
    const inlineData = partRecord.inlineData as JsonRecord | undefined;
    const data = inlineData?.data;
    const mimeType = inlineData?.mimeType;

    if (typeof data === 'string' && typeof mimeType === 'string') {
      return `data:${mimeType};base64,${data}`;
    }
  }

  return null;
};

const classifyError = (status: number | undefined, message: string) => {
  const lower = message.toLowerCase();

  if (status === 400) {
    if (lower.includes('schema') || lower.includes('json')) {
      return { code: 'schema_error' as const, retryable: false };
    }
    return { code: 'invalid_input' as const, retryable: false };
  }
  if (status === 401 || status === 403) {
    return { code: 'authentication' as const, retryable: false };
  }
  if (status === 429 || lower.includes('rate limit')) {
    return { code: 'rate_limited' as const, retryable: true };
  }
  if (lower.includes('quota') || lower.includes('resource_exhausted')) {
    return { code: 'quota_exceeded' as const, retryable: true };
  }
  if (status !== undefined && status >= 500) {
    return { code: 'server_error' as const, retryable: true };
  }
  return { code: 'unknown' as const, retryable: false };
};

const buildParts = (prompt: string, parts: AIRequestPart[]): AIRequestPart[] => {
  const normalized = [...parts];
  if (prompt.trim()) {
    normalized.push({ text: prompt });
  }
  return normalized;
};

const makeTimeoutMs = (env: GeminiEnv, options: Required<AIRequestOptions>): number => {
  const envTimeout = Number.parseInt(env.GEMINI_TIMEOUT_MS || '', 10);
  if (Number.isFinite(envTimeout) && envTimeout > 0) {
    return envTimeout;
  }
  if (options.timeoutMs > 0) {
    return options.timeoutMs;
  }
  return DEFAULT_TIMEOUT_MS;
};

export const geminiProvider: AIProviderAdapter<GeminiEnv> = {
  provider: 'gemini',
  generate: async (
    env: GeminiEnv,
    prompt: string,
    options: Required<AIRequestOptions>,
    requestId: string
  ): Promise<AIProviderResponse> => {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new AIProviderError({
        provider: 'gemini',
        code: 'authentication',
        retryable: false,
        message: 'Server missing GEMINI_API_KEY',
      });
    }

    const task = options.task;
    const model = options.geminiModel || (task === 'image' ? DEFAULT_IMAGE_MODEL : DEFAULT_TEXT_MODEL);
    const timeoutMs = makeTimeoutMs(env, options);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const parts = buildParts(prompt, options.parts);
      if (parts.length === 0) {
        throw new AIProviderError({
          provider: 'gemini',
          code: 'invalid_input',
          retryable: false,
          message: 'Prompt is required',
        });
      }

      const body: JsonRecord = {
        contents: [{ parts }],
      };

      if (task === 'json') {
        body.generationConfig = {
          responseMimeType: 'application/json',
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
        };
      } else if (task === 'text') {
        body.generationConfig = {
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
        };
      }

      const response = await fetch(
        `${GEMINI_BASE_URL}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );

      const payload = await response.json().catch(() => ({}));
      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        const errorMessage =
          ((payload as JsonRecord).error as JsonRecord | undefined)?.message ||
          `Gemini request failed (${response.status})`;
        const classified = classifyError(response.status, String(errorMessage));
        throw new AIProviderError({
          provider: 'gemini',
          code: classified.code,
          retryable: classified.retryable,
          status: response.status,
          message: String(errorMessage),
        });
      }

      const responseBody = payload as JsonRecord;
      const text = task === 'image' ? parseInlineImage(responseBody) : parseResponseText(responseBody);

      if (!text) {
        throw new AIProviderError({
          provider: 'gemini',
          code: 'provider_unavailable',
          retryable: true,
          message: `Gemini returned empty ${task} output`,
        });
      }

      return { text, latencyMs };
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new AIProviderError({
          provider: 'gemini',
          code: 'timeout',
          retryable: true,
          message: `Gemini timed out after ${timeoutMs}ms`,
        });
      }

      throw new AIProviderError({
        provider: 'gemini',
        code: 'network_error',
        retryable: true,
        message: error instanceof Error ? error.message : 'Gemini request failed',
      });
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
