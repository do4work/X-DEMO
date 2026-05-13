import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { preprocessText } from '../../src/core/preprocess.js'

const testDataDir = path.join(process.cwd(), 'test/data')
const breathDir = path.join(process.cwd(), 'axiom/breath')

describe('preprocess', () => {
  it('splits markdown by chapter headers', async () => {
    const sourceFile = '00-overview.md'
    const text = fs.readFileSync(path.join(testDataDir, sourceFile), 'utf-8')

    const result = await preprocessText(text, 'by-chapter', breathDir, sourceFile)

    expect(result.chunks.length).toBeGreaterThan(1)
    expect(result.savedFiles).toBeDefined()
    expect(result.savedFiles!.length).toBe(result.chunks.length)

    for (const file of result.savedFiles!) {
      expect(fs.existsSync(file)).toBe(true)
      const content = fs.readFileSync(file, 'utf-8')
      expect(content.length).toBeGreaterThan(0)
    }

    console.log('Generated files:')
    for (const file of result.savedFiles!) {
      console.log(`  ${file}`)
    }
  })

  it('returns chunks without saving when no breathDir provided', async () => {
    const text = fs.readFileSync(path.join(testDataDir, '00-overview.md'), 'utf-8')
    const result = await preprocessText(text, 'by-chapter')
    expect(result.chunks.length).toBeGreaterThan(1)
    expect(result.savedFiles).toBeUndefined()
  })

  it('returns original text for mode none', async () => {
    const text = '# Hello\n\nWorld'
    const result = await preprocessText(text, 'none')
    expect(result.chunks.length).toBe(1)
    expect(result.chunks[0].content).toBe(text)
  })
})