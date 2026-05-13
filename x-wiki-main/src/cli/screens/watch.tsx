import React, { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import SelectInput from 'ink-select-input'
import path from 'path'
import fs from 'fs'
import { getConfig } from '../../config/index.js'
import { resolveMaxSteps, isFeatureEnabled } from '../../config/endpoints.js'
import { createAxiomAgent } from '../../agent/index.js'
import { startWatcher, loadIgnorePatterns } from '../../core/watcher.js'
import { buildIngestMessage, contextLimitMessage } from '../../core/files.js'
import { preprocessText } from '../../core/preprocess.js'
import { updateIndex, updateMOC, appendLog, snapshotWiki, diffWiki } from '../../core/wiki.js'
import { calcCost, appendUsageLog } from '../../core/usage.js'
import { loadState, saveState, recordIngest, computeHash, statePath, migrateFromLog } from '../../core/state.js'
import { acquireLock, releaseLock } from '../../core/lock.js'
import { withRetry } from '../../core/retry.js'
import type { FSWatcher } from 'chokidar'

interface WatchLogEntry {
  time: string
  filename: string
  status: 'ingesting' | 'done' | 'error'
  pageCount?: number
  costUsd?: number | null
  error?: string
}

function llmLogRaw(wikiDir: string, filename: string, type: 'RAW_REQUEST' | 'RAW_RESPONSE', content: string) {
  const logPath = path.join(wikiDir, 'wiki/llm-raw.log')
  const timestamp = new Date().toISOString()
  const entry = `\n[${timestamp}] [${type}] [${filename}]\n${content}\n`
  fs.appendFileSync(logPath, entry, 'utf-8')
}

function llmLog(wikiDir: string, filename: string, role: 'user' | 'assistant' | 'system', content: string) {
  const logPath = path.join(wikiDir, 'wiki/llm-agent.log')
  const timestamp = new Date().toISOString()
  const entry = `\n[${timestamp}] [${role.toUpperCase()}] [${filename}]\n${content}\n`
  fs.appendFileSync(logPath, entry, 'utf-8')
}

function llmLogToolCall(wikiDir: string, filename: string, toolName: string, args: string, result?: string) {
  const logPath = path.join(wikiDir, 'wiki/llm-agent.log')
  const timestamp = new Date().toISOString()
  let entry = `\n[${timestamp}] [TOOL_CALL] [${filename}] ${toolName}\nArgs: ${args}\n`
  if (result) entry += `Result: ${result}\n`
  fs.appendFileSync(logPath, entry, 'utf-8')
}

function llmLogStep(wikiDir: string, filename: string, step: any) {
  const logPath = path.join(wikiDir, 'wiki/llm-agent.log')
  const timestamp = new Date().toISOString()
  const entry = `\n[${timestamp}] [STEP] [${filename}]\n${JSON.stringify(step, null, 2)}\n`
  fs.appendFileSync(logPath, entry, 'utf-8')
}

function nowTime(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

function extractPageCount(text: string): number {
  const m = text.match(/(\d+)\s+pages?\s+(created|updated)/i)
  return m ? parseInt(m[1]!, 10) : 0
}

interface Props {
  onExit?: () => void
}

export function WatchScreen({ onExit }: Props) {
  const { exit } = useApp()
  const doExit = onExit ?? exit
  const config = getConfig()
  const [log, setLog] = useState<WatchLogEntry[]>([])
  const [pendingBreathConfirm, setPendingBreathConfirm] = useState<{ filepath: string, filename: string, breathChunks: Array<{ filepath: string, filename: string }> } | null>(null)
  const [processingMessage, setProcessingMessage] = useState<string | null>(null)
  const watcherRef = useRef<FSWatcher | null>(null)
  const pendingCallbackRef = useRef<((confirm: boolean) => void) | null>(null)

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      watcherRef.current?.close()
      doExit()
    }
  })

  function upsertEntry(filename: string, update: Partial<WatchLogEntry>) {
    setLog((prev) => {
      let idx = -1
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i]!.filename === filename) { idx = i; break }
      }
      if (idx === -1) {
        return [...prev, { time: nowTime(), filename, status: 'ingesting' as const, ...update }].slice(-50)
      }
      const next = [...prev]
      next[idx] = { ...next[idx]!, ...update } as WatchLogEntry
      return next
    })
  }

  useEffect(() => {
    if (processingMessage) {
      const timer = setTimeout(() => setProcessingMessage(null), 2000)
      return () => clearTimeout(timer)
    }
  }, [processingMessage])

  useEffect(() => {
    if (!config) return

    const agent = createAxiomAgent(config)
    const patterns = loadIgnorePatterns(config.rawDir)
    const { wikiDir, rawDir } = config

    const watcher = startWatcher(
      rawDir,
      async (filepath: string) => {
        const filename = path.basename(filepath)

        // Acquire lock — skip if another process is ingesting
        if (!acquireLock(wikiDir)) return

        // Skip unchanged files using SHA-256 hash-based detection
        const stateFile = statePath(wikiDir)
        const state = fs.existsSync(stateFile)
          ? loadState(wikiDir)
          : migrateFromLog(wikiDir, rawDir)
        const currentHash = computeHash(filepath)
        const prev = state.sources[filename]
        if (prev && prev.sha256 === currentHash) {
          releaseLock(wikiDir)
          return
        }

        try {

        upsertEntry(filename, { status: 'ingesting', time: nowTime() })
        const before = snapshotWiki(wikiDir)

        // Preprocessing: split files into breath/ if preProcess is configured
        let breathChunks: Array<{ filepath: string, filename: string }> = []
        const breathDir = path.join(wikiDir, 'breath')

        if (config.preProcess && config.preProcess.mode !== 'none') {
          try {
            llmLog(wikiDir, filename, 'user', `[PREPROCESS] Starting chunking with mode: ${config.preProcess.mode}, structure: ${config.preProcess.structure ?? 'flat'}`)
            const text = fs.readFileSync(filepath, 'utf-8')
            const structure = config.preProcess?.structure ?? 'flat'
            llmLog(wikiDir, filename, 'user', `[PREPROCESS] Read file, calling preprocessText...`)
            const result = await preprocessText(text, config.preProcess.mode, breathDir, filename, structure)
            llmLog(wikiDir, filename, 'user', `[PREPROCESS] preprocessText returned, savedFiles length: ${result.savedFiles?.length ?? 0}`)
            const savedFiles = result.savedFiles ?? []
            if (savedFiles.length > 0) {
              for (const savedFile of savedFiles) {
                breathChunks.push({ filepath: savedFile, filename: path.basename(savedFile) })
              }
              llmLog(wikiDir, filename, 'assistant', `[PREPROCESS] Split into ${breathChunks.length} chunk(s): ${breathChunks.map(c => c.filename).join(', ')}`)
            } else {
              llmLog(wikiDir, filename, 'assistant', `[PREPROCESS] No chunks created, using original file`)
            }
          } catch (err) {
            llmLog(wikiDir, filename, 'assistant', `[PREPROCESS] Failed: ${err instanceof Error ? err.message : String(err)}`)
            // If preprocessing fails, continue with original file
          }
        }

        // Use breath chunks if available, otherwise use original file
        const filesToProcess = breathChunks.length > 0
          ? breathChunks
          : [{ filepath, filename }]

        // If confirmBeforeWatch is enabled and we have chunks, wait for confirmation
        if (breathChunks.length > 0 && (config.preProcess?.confirmBeforeWatch ?? false)) {
          let userChoice: boolean | null = null
          await new Promise<void>((resolve) => {
            setPendingBreathConfirm({ filepath, filename, breathChunks })
            pendingCallbackRef.current = (confirm: boolean) => {
              userChoice = confirm
              setPendingBreathConfirm(null)
              if (!confirm) {
                upsertEntry(filename, { status: 'done' })
                releaseLock(wikiDir)
              }
              resolve()
            }
          })
          if (userChoice === false) {
            return
          }
        }

        for (const { filepath: fp, filename: fn } of filesToProcess) {
          try {
            const message = await buildIngestMessage(fp, !!prev, '', config)
            llmLog(wikiDir, fn, 'user', typeof message === 'string' ? message : JSON.stringify(message))
            llmLogRaw(wikiDir, fn, 'RAW_REQUEST', JSON.stringify([message]))

            const stepFinish = (step: any) => {
              try {
                llmLogStep(wikiDir, fn, step)
                for (const call of step.toolCalls ?? []) {
                  const toolName = call.toolName ?? call.payload?.toolName ?? 'tool'
                  const args = JSON.stringify(call.args ?? call.payload?.args ?? {})
                  llmLogToolCall(wikiDir, fn, toolName, args)
                }
              } catch { /* never crash the agent loop */ }
            }

            if (!isFeatureEnabled('llmCallEnabled')) {
              llmLog(wikiDir, fn, 'assistant', '[DEBUG] llmCallEnabled is false - skipping LLM call')
              upsertEntry(fn, { status: 'done' })
              continue
            }

            const result = await withRetry(() => agent.generate([message], { onStepFinish: stepFinish, maxSteps: resolveMaxSteps(config.provider, config.maxSteps) }))
            llmLog(wikiDir, fn, 'assistant', result.text ?? '')
            llmLogRaw(wikiDir, fn, 'RAW_RESPONSE', JSON.stringify(result))
          } catch (err) {
            const friendly = contextLimitMessage(err)
            upsertEntry(fn, {
              status: 'error',
              error: friendly ?? (err instanceof Error ? err.message : String(err)),
            })
          }
        }

        await updateIndex(wikiDir)
        await updateMOC(wikiDir)
        await appendLog(wikiDir, filename, 'ingest')

        const allChanges = diffWiki(before, wikiDir)
        const pagesFound = allChanges
          .filter(c => c.path.startsWith('wiki/pages/') && c.path.endsWith('.md'))
          .map(c => c.path)
        recordIngest(state, filename, filepath, pagesFound)
        saveState(wikiDir, state)

        const pageCount = allChanges.filter((c) => c.type === 'created').length
        upsertEntry(filename, { status: 'done', pageCount })
      } catch (err) {
        const friendly = contextLimitMessage(err)
        upsertEntry(filename, {
          status: 'error',
          error: friendly ?? (err instanceof Error ? err.message : String(err)),
        })
      } finally {
        releaseLock(wikiDir)
      }
    },
    { ignore: patterns },
  )
  watcherRef.current = watcher
  return () => { watcher.close() }
  }, [])

  if (!config) {
    return (
      <Box padding={1}>
        <Text color="yellow">Not configured. Run <Text color="cyan">axiom-wiki init</Text> first.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={2} paddingY={0}>
        <Text bold color="cyan">axiom watch</Text>
        <Text color="gray">Monitoring: <Text color="white">{config.rawDir}</Text></Text>
        <Text color="gray">Press <Text color="white">q</Text> to stop</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {log.length === 0 ? (
          <Text color="gray">Watching for new files...</Text>
        ) : (
          log.map((entry, i) => (
            <Box key={i} flexDirection="column">
              <Box>
                <Text color="gray">[{entry.time}] </Text>
                {entry.status === 'ingesting' && (
                  <Text color="yellow">⠸ Ingesting <Text color="cyan">{entry.filename}</Text>…</Text>
                )}
                {entry.status === 'done' && (
                  <Text color="green">✓ <Text color="cyan">{entry.filename}</Text>
                    {entry.pageCount ? ` → ${entry.pageCount} pages` : ' → done'}
                    {entry.costUsd != null ? <Text color="gray"> ${entry.costUsd.toFixed(4)}</Text> : null}
                  </Text>
                )}
                {entry.status === 'error' && (
                  <Text color="red">✗ <Text color="cyan">{entry.filename}</Text></Text>
                )}
              </Box>
              {entry.status === 'error' && entry.error && (
                <Text color="red" dimColor>  {entry.error}</Text>
              )}
            </Box>
          ))
        )}
      </Box>

      {log.some((e) => e.status !== 'ingesting') && (
        <Box marginTop={1}>
          <Text color="gray">Watching for new files...</Text>
        </Box>
      )}

      {pendingBreathConfirm && (
        <Box key={pendingBreathConfirm.filename} flexDirection="column" marginTop={1}>
          <Box
            borderStyle="single"
            borderColor="cyan"
            paddingX={1}
            flexDirection="column"
          >
            <Text color="cyan" bold>Pre-processed files ready in breath/</Text>
            <Box marginTop={1}>
              <Text color="gray">Found </Text>
              <Text color="white">{pendingBreathConfirm.breathChunks.length}</Text>
              <Text color="gray"> chunk(s) to process:</Text>
            </Box>
            {pendingBreathConfirm.breathChunks.slice(0, 5).map((f, i) => (
              <Text key={i} color="gray">  • {f.filename}</Text>
            ))}
            {pendingBreathConfirm.breathChunks.length > 5 && (
              <Text color="gray">  ... and {pendingBreathConfirm.breathChunks.length - 5} more</Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text bold>Start loading chunks to LLM?</Text>
            <Box marginTop={1}>
              <SelectInput
                items={[
                  { label: 'Yes - Start processing', value: 'yes' },
                  { label: 'No - Skip this file', value: 'no' },
                ]}
                onSelect={(item) => {
                  if (pendingCallbackRef.current) {
                    setProcessingMessage(`Processing your selection: ${item.label}...`)
                    setPendingBreathConfirm(null)
                    setLog((prev) => [...prev])
                    pendingCallbackRef.current(item.value === 'yes')
                    pendingCallbackRef.current = null
                  }
                }}
              />
            </Box>
          </Box>
        </Box>
      )}

      {processingMessage && (
        <Box marginTop={1}>
          <Text color="cyan" bold>{processingMessage}</Text>
          <Text color="gray"> Please wait...</Text>
        </Box>
      )}
    </Box>
  )
}
