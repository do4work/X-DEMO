export type EndpointId =
  | 'google'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'mistral'
  | 'ollama'
  | 'qwen'
  | 'custom'

export type PreProcessMode =
  | 'none'
  | 'by-chapter'
  // | 'by-char'     // Future: split by character count
  // | 'by-semantic' // Future: split by semantic similarity

export type PreProcessStructure =
  | 'flat'      // All chunks in single folder, named with prefix
  | 'preserve'  // Preserve heading hierarchy as subfolder structure
  // | 'tree'     // Future: full directory tree based on headings

export interface EndpointDef {
  id: EndpointId
  defaultBaseUrl: string
  maxSteps?: number
}

export const DEFAULT_MAX_STEPS = 30

export const FEATURE_FLAGS = {
  llmCallEnabled: true,
} as const

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

export function isFeatureEnabled(flag: FeatureFlagKey): boolean {
  return FEATURE_FLAGS[flag]
}

export function setFeatureFlag(flag: FeatureFlagKey, value: boolean): void {
  ;(FEATURE_FLAGS as Record<string, boolean>)[flag] = value
}

export const ENDPOINTS: Record<EndpointId, EndpointDef> = {
  openai:     { id: 'openai',     defaultBaseUrl: 'https://api.openai.com/v1', maxSteps: DEFAULT_MAX_STEPS },
  anthropic:  { id: 'anthropic',  defaultBaseUrl: 'https://api.anthropic.com', maxSteps: DEFAULT_MAX_STEPS },
  google:     { id: 'google',     defaultBaseUrl: '', maxSteps: DEFAULT_MAX_STEPS },
  openrouter: { id: 'openrouter', defaultBaseUrl: 'https://openrouter.ai/api/v1', maxSteps: DEFAULT_MAX_STEPS },
  deepseek:   { id: 'deepseek',   defaultBaseUrl: 'https://api.deepseek.com', maxSteps: DEFAULT_MAX_STEPS },
  groq:       { id: 'groq',       defaultBaseUrl: 'https://api.groq.com/openai/v1', maxSteps: DEFAULT_MAX_STEPS },
  mistral:    { id: 'mistral',    defaultBaseUrl: 'https://api.mistral.ai/v1', maxSteps: DEFAULT_MAX_STEPS },
  ollama:     { id: 'ollama',     defaultBaseUrl: 'http://localhost:11434/v1', maxSteps: DEFAULT_MAX_STEPS },
  qwen:       { id: 'qwen',       defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', maxSteps: DEFAULT_MAX_STEPS },
  custom:     { id: 'custom',     defaultBaseUrl: 'http://localhost:8000/v1', maxSteps: DEFAULT_MAX_STEPS },
}

export function resolveEndpoint(id: EndpointId, overrideUrl?: string): string {
  return overrideUrl ?? ENDPOINTS[id].defaultBaseUrl
}

export function resolveMaxSteps(provider: EndpointId, overrideMaxSteps?: number): number {
  return overrideMaxSteps ?? ENDPOINTS[provider]?.maxSteps ?? DEFAULT_MAX_STEPS
}
