export type CoreMessage = {
  role: 'user'
  content: string | Array<{ type: string; [k: string]: unknown }>
}

export const WIKI_CATEGORIES = [
  'entities',
  'concepts',
  'sources',
  'analyses',
  'requirements/frs',
  'requirements/nfrs',
  'requirements/ucs',
  'architecture/overview',
  'architecture/modules',
  'architecture/adrs',
  'features/specs',
  'features/interfaces',
  'features/data-models',
  'scenarios/uc-flows',
  'scenarios/bp-flows',
] as const

export type WikiCategory = typeof WIKI_CATEGORIES[number]
