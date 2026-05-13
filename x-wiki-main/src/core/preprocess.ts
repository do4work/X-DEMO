import fs from 'fs'
import path from 'path'
import type { PreProcessMode, PreProcessStructure } from '../config/endpoints.js'
import { chunkWithPython, type PythonChunkResult } from './pythonChunker.js'

export interface Chunk {
  content: string
  index: number
  title?: string
  level?: number
  path?: string
  wordCount?: number
  tokenEstimate?: number
}

export interface PreprocessResult {
  chunks: Chunk[]
  savedFiles?: string[]
}

interface Heading {
  level: number
  title: string
}

interface ChunkCandidate {
  headings: Heading[]
  content: string[]
  wordCount: number
}

const MAX_HEADERS_TO_USE = 4
const HARD_MAX_CHUNK_WORD_COUNT = 1200
const HARD_MAX_CHUNK_TOKEN_COUNT = 2200
const MIN_CHUNK_WORD_COUNT = 50

function formatTimestamp(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}${m}${d}${h}${min}${s}`
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'untitled'
}

function countWords(text: string): number {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const english = (text.match(/[a-zA-Z]+/g) || []).length
  const others = text.split(/\s+/).filter(w => w.length > 0).length - english
  return chinese + english + others
}

function estimateTokens(text: string): number {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const english = (text.match(/[a-zA-Z]+/g) || []).length
  return Math.ceil(chinese * 1.5 + english * 0.25)
}

function buildChunkPath(headings: Heading[]): string {
  return headings.map((h) => sanitizeFilename(h.title)).join('/')
}

function buildParentHeadings(headings: Heading[], currentTitle: string): string | null {
  if (headings.length === 0) return null
  const lines: string[] = []
  for (const h of headings) {
    if (h.title !== currentTitle) {
      lines.push(`${'#'.repeat(h.level)} ${h.title}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : null
}

function saveChunkToFile(chunk: Chunk, outputDir: string, baseName: string, index: number): string {
  const chunkFileName = chunk.title
    ? `${String(index).padStart(3, '0')}_${sanitizeFilename(chunk.title)}.md`
    : `${String(index).padStart(3, '0')}_${sanitizeFilename(baseName)}.md`
  const chunkPath = path.join(outputDir, chunkFileName)
  fs.writeFileSync(chunkPath, chunk.content, 'utf-8')
  return chunkPath
}

function flushCandidate(candidate: ChunkCandidate, chunks: Chunk[], index: number): number {
  const content = candidate.content.join('\n').trim()
  if (content.length === 0) return index

  const parentHeadings = buildParentHeadings(candidate.headings, '')
  const fullContent = parentHeadings ? `${parentHeadings}\n${content}` : content

  chunks.push({
    content: fullContent,
    index: index,
    title: candidate.headings.length > 0 ? candidate.headings[candidate.headings.length - 1]!.title : 'Untitled',
    level: candidate.headings.length > 0 ? candidate.headings[candidate.headings.length - 1]!.level : 1,
    path: buildChunkPath(candidate.headings),
    wordCount: candidate.wordCount,
    tokenEstimate: estimateTokens(fullContent),
  })
  return index + 1
}

function splitByChapterFallback(text: string): Chunk[] {
  const chunks: Chunk[] = []
  const lines = text.split('\n')
  const headingStack: Heading[] = []
  let currentCandidate: ChunkCandidate = { headings: [], content: [], wordCount: 0 }
  let chapterIndex = 0

  const headingRegex = /^(#{1,6})\s+(.+)/

  for (const line of lines) {
    const match = line.match(headingRegex)

    if (match) {
      const level = Math.min(match[1]!.length, MAX_HEADERS_TO_USE)
      const title = match[2]!.trim()

      if (currentCandidate.content.length > 0) {
        const candidateWordCount = countWords(currentCandidate.content.join('\n'))

        if (candidateWordCount >= MIN_CHUNK_WORD_COUNT) {
          chapterIndex = flushCandidate(currentCandidate, chunks, chapterIndex)
        }
        currentCandidate = { headings: [], content: [], wordCount: 0 }
      }

      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop()
      }

      headingStack.push({ level, title })
      currentCandidate.headings = [...headingStack]
    } else {
      currentCandidate.content.push(line)
      currentCandidate.wordCount = countWords(currentCandidate.content.join('\n'))

      if (currentCandidate.wordCount > HARD_MAX_CHUNK_WORD_COUNT ||
          estimateTokens(currentCandidate.content.join('\n')) > HARD_MAX_CHUNK_TOKEN_COUNT) {
        if (currentCandidate.content.length > 1) {
          const lastLine = currentCandidate.content.pop()!
          chapterIndex = flushCandidate(currentCandidate, chunks, chapterIndex)
          currentCandidate = { headings: [...headingStack], content: [lastLine], wordCount: countWords(lastLine) }
        }
      }
    }
  }

  if (currentCandidate.content.length > 0 && currentCandidate.wordCount >= MIN_CHUNK_WORD_COUNT) {
    flushCandidate(currentCandidate, chunks, chapterIndex)
  }

  return chunks
}

async function splitByChapterWithPython(text: string): Promise<Chunk[]> {
  try {
    console.log('[DEBUG] splitByChapterWithPython: calling chunkWithPython...')
    const result: PythonChunkResult = await chunkWithPython(text)
    console.log('[DEBUG] splitByChapterWithPython: got result, chunks:', result.chunks.length)

    return result.chunks.map((c) => ({
      content: c.content,
      index: c.index,
      title: c.title || 'Untitled',
      level: c.level,
      wordCount: c.wordCount,
      tokenEstimate: c.tokenCount,
      path: undefined,
    }))
  } catch (error) {
    console.warn(`[DEBUG] Python chunker failed, using fallback: ${error}`)
    return splitByChapterFallback(text)
  }
}

export async function preprocessText(
  text: string,
  mode: PreProcessMode,
  breathDir?: string,
  sourceFilename?: string,
  structure: PreProcessStructure = 'flat',
): Promise<PreprocessResult> {
  switch (mode) {
    case 'none':
      return { chunks: [{ content: text, index: 0 }] }

    case 'by-chapter': {
      let chunks: Chunk[]

      try {
        chunks = await splitByChapterWithPython(text)
      } catch {
        chunks = splitByChapterFallback(text)
      }

      if (!breathDir || !sourceFilename) {
        return { chunks }
      }

      const timestamp = formatTimestamp(new Date())
      const baseName = path.basename(sourceFilename, path.extname(sourceFilename))
      const folderName = `${sanitizeFilename(baseName)}_${timestamp}`
      const outputDir = path.join(breathDir, folderName)

      fs.mkdirSync(outputDir, { recursive: true })

      const savedFiles: string[] = []

      if (structure === 'flat') {
        for (let i = 0; i < chunks.length; i++) {
          savedFiles.push(saveChunkToFile(chunks[i]!, outputDir, baseName, i))
        }
      } else if (structure === 'preserve') {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!
          const chunkDir = chunk.path
            ? path.join(outputDir, path.dirname(chunk.path))
            : outputDir

          if (chunk.path && path.dirname(chunk.path) !== '.') {
            fs.mkdirSync(chunkDir, { recursive: true })
          }

          const subDir = chunk.path ? path.join(outputDir, chunk.path) : outputDir
          const chunkFileName = chunk.title
            ? `${String(i).padStart(3, '0')}_${sanitizeFilename(chunk.title)}.md`
            : `${String(i).padStart(3, '0')}_${sanitizeFilename(baseName)}.md`
          const chunkPath = path.join(subDir, chunkFileName)
          fs.writeFileSync(chunkPath, chunk.content, 'utf-8')
          savedFiles.push(chunkPath)
        }
      }

      return { chunks, savedFiles }
    }

    default:
      return { chunks: [{ content: text, index: 0 }] }
  }
}