export type AIProvider = 'gemini' | 'huggingface';
export type AITaskType = 'text' | 'json' | 'image';

export interface AIRequestPartText {
  text: string;
}

export interface AIRequestPartInlineData {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export type AIRequestPart = AIRequestPartText | AIRequestPartInlineData;

export interface AIRequestOptions {
  task?: AITaskType;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  geminiModel?: string;
  geminiModelFallbacks?: string[];
  huggingFaceModel?: string;
  parts?: AIRequestPart[];
  allowFallback?: boolean;
}

export interface AIResponseNormalized {
  text: string;
  provider: AIProvider;
  latency_ms: number;
  fallback_used: boolean;
}

export type AIErrorCode =
  | 'invalid_input'
  | 'schema_error'
  | 'authentication'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'network_error'
  | 'provider_unavailable'
  | 'unknown';

export class AIProviderError extends Error {
  public readonly provider: AIProvider;
  public readonly code: AIErrorCode;
  public readonly retryable: boolean;
  public readonly status?: number;

  constructor(params: {
    provider: AIProvider;
    code: AIErrorCode;
    retryable: boolean;
    message: string;
    status?: number;
  }) {
    super(params.message);
    this.name = 'AIProviderError';
    this.provider = params.provider;
    this.code = params.code;
    this.retryable = params.retryable;
    this.status = params.status;
  }
}

export interface AIProviderResponse {
  text: string;
  latencyMs: number;
}

export interface AIProviderAdapter<TEnv> {
  provider: AIProvider;
  generate: (
    env: TEnv,
    prompt: string,
    options: Required<AIRequestOptions>,
    requestId: string
  ) => Promise<AIProviderResponse>;
}
