import path from 'path'

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function relativePosix(from: string, to: string): string {
  return toPosix(path.relative(from, to))
}
