import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText } from 'ai'
import fs from 'fs'
import path from 'path'
import { ENDPOINTS, resolveEndpoint, type EndpointId } from '../src/config/endpoints.js'
import { PROVIDERS, type ProviderId } from '../src/config/models.js'

const logPath = path.join(process.cwd(), 'axiom/wiki/test-log.md')

const SUPPORTED_PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'google', 'deepseek', 'groq', 'mistral', 'qwen', 'openrouter', 'ollama', 'custom']

function getApiKey(provider: ProviderId): string | null {
  const providerDef = PROVIDERS[provider]
  if (!providerDef) return null

  const envVarName = providerDef.keyEnv
  const apiKey = process.env[envVarName]

  if (!apiKey) {
    console.error(`\n⚠️  API Key not found!`)
    console.error(`Please set the environment variable: ${envVarName}`)
    console.error(`Get your API key from: ${providerDef.keyUrl}\n`)
    return null
  }

  return apiKey
}

function listModels(provider: ProviderId): void {
  const providerDef = PROVIDERS[provider]
  if (!providerDef) return

  console.log(`\n📋 Available models for ${providerDef.label}:`)
  providerDef.models.forEach((model, index) => {
    const recommended = model.recommended ? ' ⭐' : ''
    console.log(`  ${index + 1}. ${model.label} (${model.id})${recommended}`)
    console.log(`     ${model.desc}`)
  })
  console.log()
}

async function testProvider(provider: ProviderId, modelId: string): Promise<void> {
  console.log(`\n=== Testing ${PROVIDERS[provider]?.label || provider} ===\n`)

  const apiKey = getApiKey(provider)
  if (!apiKey) {
    process.exit(1)
  }

  console.log(`API Key: ${apiKey.substring(0, 8)}...`)
  console.log(`Base URL: ${resolveEndpoint(provider as EndpointId)}`)
  console.log(`Model: ${modelId}\n`)

  let model: any
  const baseURL = resolveEndpoint(provider as EndpointId)

  switch (provider) {
    case 'google':
      model = createGoogleGenerativeAI({ apiKey })(modelId)
      break
    case 'anthropic':
      model = createAnthropic({ apiKey })(modelId)
      break
    case 'ollama':
      model = createOpenAI({ baseURL, apiKey: 'ollama' }).chat(modelId)
      break
    default:
      model = createOpenAI({ baseURL, apiKey }).chat(modelId)
  }

  const testMessage = 'Hello! Please respond with a brief greeting.'
  console.log(`Sending: "${testMessage}"`)

  const result = await generateText({
    model,
    messages: [{ role: 'user', content: testMessage }],
  })

  console.log(`\n✅ Response:`)
  console.log(result.text)
  console.log(`\n📊 Metadata:`)
  console.log(`- Finish reason: ${result.finishReason}`)
  console.log(`- Provider: ${(result as any).provider || provider}`)

  const log = `# LLM Connection Test Log
_createdAt: ${new Date().toISOString()}_

## Configuration
- Provider: ${provider}
- Model: ${modelId}
- Base URL: ${baseURL}

## Test Message
${testMessage}

## Response
${result.text}

## Metadata
- Finish Reason: ${result.finishReason}
- Provider: ${(result as any).provider || provider}
`

  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, log)
  console.log(`\n💾 Log saved to: ${logPath}`)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log('\n🔧 LLM Connection Test Tool')
    console.log('==========================\n')
    console.log('Usage:')
    console.log('  npx tsx bin/test-llm.ts <provider> [model]')
    console.log('  npx tsx bin/test-llm.ts deepseek deepseek-v4-flash')
    console.log('  npx tsx bin/test-llm.ts openai gpt-5.4-mini')
    console.log('  npx tsx bin/test-llm.ts qwen')
    console.log('\n📋 Available providers:')
    SUPPORTED_PROVIDERS.forEach(p => {
      const def = PROVIDERS[p]
      if (def) {
        console.log(`  - ${p}: ${def.label}`)
      }
    })
    console.log('\n💡 Examples:')
    console.log('  npx tsx bin/test-llm.ts deepseek')
    console.log('  npx tsx bin/test-llm.ts deepseek deepseek-v4-flash')
    console.log('  npx tsx bin/test-llm.ts qwen qwen-plus')
    console.log('  npx tsx bin/test-llm.ts anthropic claude-sonnet-4-6')
    console.log()
    process.exit(0)
  }

  const providerArg = args[0]?.toLowerCase() as ProviderId

  if (!SUPPORTED_PROVIDERS.includes(providerArg)) {
    console.error(`\n❌ Unknown provider: ${providerArg}`)
    console.error('Available providers:', SUPPORTED_PROVIDERS.join(', '))
    process.exit(1)
  }

  const providerDef = PROVIDERS[providerArg]
  if (!providerDef) {
    console.error(`\n❌ Provider configuration not found: ${providerArg}`)
    process.exit(1)
  }

  if (args.length === 1) {
    listModels(providerArg)
    console.log(`Please specify a model:`)
    console.log(`  npx tsx bin/test-llm.ts ${providerArg} <model-id>\n`)
    process.exit(0)
  }

  const modelId = args[1]

  const validModel = providerDef.models.find(m => m.id === modelId)
  if (!validModel) {
    console.error(`\n❌ Unknown model: ${modelId}`)
    console.error(`Available models for ${providerDef.label}:`)
    providerDef.models.forEach(m => {
      console.error(`  - ${m.id}`)
    })
    process.exit(1)
  }

  await testProvider(providerArg, modelId)
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message || err)
  process.exit(1)
})