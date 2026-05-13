import { Agent } from '@mastra/core/agent'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { buildSystemPrompt, buildAutowikiSystemPrompt, buildSyncSystemPrompt, buildTwoPhaseSystemPrompt } from './prompts.js'
import { createAxiomTools } from './tools.js'
import { createCodebaseTools } from './codebase-tools.js'
import type { AxiomConfig } from '../config/index.js'
import { getOllamaNumCtx } from '../config/models.js'
import { resolveEndpoint } from '../config/endpoints.js'
import type { ProjectSnapshot } from '../core/mapper.js'
import { autoCommit } from '../core/git.js'

export function createAxiomAgent(config: AxiomConfig) {
  const model = resolveModel(config)
  const tools = createAxiomTools(config)

  const agent = new Agent({
    id: 'axiom',
    name: 'axiom',
    instructions: buildTwoPhaseSystemPrompt({ obsidianCompat: config.obsidianCompat, domainMode: true }),
    model,
    tools,
  })

  return Object.assign(agent, {
    commitChanges: async (message: string) => {
      return autoCommit(config.wikiDir, message)
    },
  })
}

export type ContentType = 'code' | 'docs'

export function detectContentType(snapshot: ProjectSnapshot): ContentType {
  const docExts = new Set(['.md', '.txt', '.pdf', '.docx', '.doc', '.html', '.htm', '.rtf', '.odt', '.epub'])
  let docFiles = 0
  let totalFiles = 0
  for (const [ext, count] of Object.entries(snapshot.languages)) {
    totalFiles += count
    if (docExts.has(ext)) docFiles += count
  }
  // If more than half the files are docs/text, treat as a docs folder
  return docFiles > totalFiles * 0.5 ? 'docs' : 'code'
}

export function createAutowikiAgent(config: AxiomConfig, projectRoot: string, snapshot: ProjectSnapshot, mode: 'autowiki' | 'sync' = 'autowiki') {
  const model = resolveModel(config)
  const wikiTools = createAxiomTools(config)
  const codebaseTools = createCodebaseTools(projectRoot, snapshot)
  const tools = { ...wikiTools, ...codebaseTools }

  const contentType = detectContentType(snapshot)
  const compatOpts = { obsidianCompat: config.obsidianCompat }
  const instructions = mode === 'sync'
    ? buildSyncSystemPrompt(contentType, compatOpts)
    : buildAutowikiSystemPrompt(contentType, compatOpts)

  return new Agent({
    id: 'axiom-autowiki',
    name: 'axiom-autowiki',
    instructions,
    model,
    tools,
  })
}

type AnyModel = ReturnType<ReturnType<typeof createGoogleGenerativeAI>>

/** Create an OpenAI-compatible provider client for API gateways that follow the OpenAI /v1 spec. */
function createOpenAICompatible(baseURL: string, apiKey: string, headers?: Record<string, string>, fetchFn?: typeof globalThis.fetch) {
  const opts: Record<string, unknown> = { baseURL, apiKey }
  if (headers) opts.headers = headers
  if (fetchFn) opts.fetch = fetchFn
  return createOpenAI(opts as Parameters<typeof createOpenAI>[0])
}

export function resolveModel(config: AxiomConfig): AnyModel {
  const { provider, model: modelId, apiKey } = config
  if (process.env['AXIOM_DEBUG'] === '1') console.error('[resolveModel]', { provider, modelId, baseUrl: config.baseUrl, ollamaBaseUrl: config.ollamaBaseUrl })
  switch (provider) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId)
    case 'openai':
      return createOpenAI({ apiKey })(modelId)
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId)
    case 'openrouter':
      return createOpenAICompatible(resolveEndpoint('openrouter', config.baseUrl), apiKey, {
        'HTTP-Referer': 'https://github.com/abubakarsiddik31/axiom-wiki',
        'X-Title': 'Axiom Wiki',
      })(modelId)
    case 'deepseek': {
      const baseURL = resolveEndpoint('deepseek', config.baseUrl)
      const deepseekFetch: typeof globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (!url.includes('/chat/completions') || !init?.body || typeof init.body !== 'string') {
          return globalThis.fetch(input, init)
        }
        try {
          const openaiBody = JSON.parse(init.body)
          openaiBody.thinking = { type: 'disabled' }
          init.body = JSON.stringify(openaiBody)
        } catch (e) {
          console.error('[deepseek] error processing body:', e)
        }
        return globalThis.fetch(input, init)
      }
      return createOpenAICompatible(baseURL, apiKey, undefined, deepseekFetch).chat(modelId)
    }
    case 'groq':
      return createOpenAICompatible(resolveEndpoint('groq', config.baseUrl), apiKey)(modelId)
    case 'mistral':
      return createOpenAICompatible(resolveEndpoint('mistral', config.baseUrl), apiKey)(modelId)
    case 'custom':
      return createOpenAICompatible(resolveEndpoint('custom', config.baseUrl), apiKey).chat(modelId)
    case 'qwen': {
      const baseURL = resolveEndpoint('qwen', config.baseUrl)
      const debug = process.env['AXIOM_DEBUG'] === '1'

      const qwenFetch: typeof globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (!url.includes('/chat/completions') || !init?.body || typeof init.body !== 'string') {
          return globalThis.fetch(input, init)
        }

        try {
          const openaiBody = JSON.parse(init.body)

          const convertMessages = (msgs: any[]): any[] => {
            return msgs.map((msg: any) => {
              if (msg.role === 'tool') {
                if (debug) console.error('[qwen] converting role:tool -> function for msg with content length:', msg.content?.length)
                return { ...msg, role: 'function', name: msg.toolName }
              }
              return msg
            })
          }

          openaiBody.messages = convertMessages(openaiBody.messages ?? [])

          openaiBody.max_tokens = Math.max(openaiBody.max_tokens ?? 0, 8192)
          if (debug) console.error('[qwen] max_tokens set to:', openaiBody.max_tokens)

          if (debug) {
            const toolMsgs = openaiBody.messages.filter((m: any) => m.role === 'function')
            console.error('[qwen] after conversion, messages with role:function:', toolMsgs.length)
          }

          init.body = JSON.stringify(openaiBody)
        } catch (e) {
          console.error('[qwen] error processing body:', e)
        }

        return globalThis.fetch(input, init)
      }

      const provider = createOpenAICompatible(baseURL, apiKey, undefined, qwenFetch)
      return provider.chat(modelId)
    }
    case 'ollama': {
      const baseURL = config.ollamaBaseUrl ?? 'http://localhost:11434/v1'
      const numCtx = getOllamaNumCtx(modelId, config.ollamaNumCtx)
      const nativeBase = baseURL.replace(/\/v1\/?$/, '')
      const debug = process.env['AXIOM_DEBUG'] === '1'

      // Intercept /v1/chat/completions requests and redirect to Ollama's
      // native /api/chat endpoint, converting the request format.
      // This lets us pass options.num_ctx which /v1 ignores.
      const ollamaFetch: typeof globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (!url.includes('/chat/completions') || !init?.body || typeof init.body !== 'string') {
          return globalThis.fetch(input, init)
        }

        try {
          const openaiBody = JSON.parse(init.body)
          if (debug) console.error('[ollama] intercepting /v1/chat/completions → /api/chat with num_ctx:', numCtx)

          // Convert OpenAI messages → Ollama native messages
          // OpenAI SDK sends tool_calls.arguments as strings, Ollama native expects objects.
          // OpenAI SDK sends role:"tool" for tool results, Ollama expects the same but
          // prior assistant messages need arguments un-stringified.
          const convertMessages = (msgs: any[]): any[] => {
            return msgs.map((msg: any) => {
              if (msg.role === 'assistant' && msg.tool_calls) {
                return {
                  ...msg,
                  tool_calls: msg.tool_calls.map((tc: any) => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.function?.name,
                      arguments: typeof tc.function?.arguments === 'string'
                        ? (() => { try { return JSON.parse(tc.function.arguments) } catch { return tc.function.arguments } })()
                        : tc.function?.arguments,
                    },
                  })),
                }
              }
              return msg
            })
          }

          const ollamaBody: Record<string, unknown> = {
            model: openaiBody.model ?? modelId,
            messages: convertMessages(openaiBody.messages ?? []),
            stream: false,
            options: { num_ctx: numCtx },
          }
          if (openaiBody.tools) ollamaBody.tools = openaiBody.tools
          if (openaiBody.temperature !== undefined) ollamaBody.options = { ...(ollamaBody.options as Record<string, unknown>), temperature: openaiBody.temperature }

          if (debug) console.error('[ollama] sending', (ollamaBody.messages as any[]).length, 'messages, roles:', (ollamaBody.messages as any[]).map((m: any) => m.role).join(','))

          const nativeRes = await globalThis.fetch(`${nativeBase}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaBody),
          })

          // Convert Ollama native response → OpenAI format
          const ollamaRes = await nativeRes.json() as Record<string, any>
          if (debug) console.error('[ollama] native response eval_count:', ollamaRes.eval_count, 'prompt_eval_count:', ollamaRes.prompt_eval_count)

          // Fix tool_calls format: Ollama native returns arguments as object
          // and omits type:"function", but OpenAI SDK expects both.
          const message = ollamaRes.message ?? { role: 'assistant', content: '' }
          if (message.tool_calls) {
            message.tool_calls = message.tool_calls.map((tc: Record<string, any>) => ({
              id: tc.id ?? `call_${Date.now()}`,
              type: 'function',
              function: {
                name: tc.function?.name ?? '',
                arguments: typeof tc.function?.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function?.arguments ?? {}),
              },
            }))
          }

          const openaiRes = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: ollamaBody.model,
            choices: [{
              index: 0,
              message,
              finish_reason: ollamaRes.done ? 'stop' : 'length',
            }],
            usage: {
              prompt_tokens: ollamaRes.prompt_eval_count ?? 0,
              completion_tokens: ollamaRes.eval_count ?? 0,
              total_tokens: (ollamaRes.prompt_eval_count ?? 0) + (ollamaRes.eval_count ?? 0),
            },
          }

          return new Response(JSON.stringify(openaiRes), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        } catch (err) {
          if (debug) console.error('[ollama] native fallback failed, using /v1:', err)
          return globalThis.fetch(input, init)
        }
      }

      return createOpenAI({ baseURL, apiKey: 'ollama', fetch: ollamaFetch }).chat(modelId)
    }
    default: {
      const _exhaustive: never = provider
      throw new Error(`Unknown provider: ${_exhaustive}`)
    }
  }
}
