import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

export interface PythonChunk {
  content: string
  index: number
  title: string
  level: number
  wordCount: number
  tokenCount: number
}

export interface PythonChunkResult {
  chunks: PythonChunk[]
  stats: {
    totalChunks: number
    tokenStats: {
      min: number
      max: number
      avg: number
    }
  }
}

export interface PythonChunkError {
  error: string
}

function getPythonCommand(): { cmd: string; args: string[] } {
  const venvPython = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
  if (fs.existsSync(venvPython)) {
    return { cmd: venvPython, args: [] }
  }
  return { cmd: 'python', args: [] }
}

export async function chunkWithPython(text: string): Promise<PythonChunkResult> {
  return new Promise((resolve, reject) => {
    const { cmd: pythonCmd, args: pythonArgs } = getPythonCommand()
    const scriptPath = path.join(process.cwd(), 'chunk_server.py')

    console.log(`[DEBUG] Python chunker: cmd=${pythonCmd}, script=${scriptPath}`)

    const child = spawn(pythonCmd, [scriptPath], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    console.log(`[DEBUG] Python chunker: spawned process`)

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      console.log(`[DEBUG] Python chunker: process closed with code=${code}, stderr=${stderr}`)
      if (code !== 0) {
        reject(new Error(`Python chunker failed: ${stderr || 'unknown error'}`))
        return
      }

      try {
        const result = JSON.parse(stdout) as PythonChunkResult | PythonChunkError
        console.log(`[DEBUG] Python chunker: parsed result, has error: ${'error' in result}`)
        if ('error' in result) {
          reject(new Error(result.error))
        } else {
          resolve(result)
        }
      } catch (parseErr) {
        reject(new Error(`Failed to parse Python output: ${stdout}`))
      }
    })

    child.on('error', (err) => {
      console.log(`[DEBUG] Python chunker: error: ${err}`)
      reject(err)
    })

    const inputData = JSON.stringify({ text })
    console.log(`[DEBUG] Python chunker: writing to stdin...`)
    child.stdin?.write(inputData)
    child.stdin?.end()
    console.log(`[DEBUG] Python chunker: stdin closed`)
  })
}