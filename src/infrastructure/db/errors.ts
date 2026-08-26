/**
 * Reconocer un error de PostgreSQL sin arrastrar su forma a través del dominio.
 *
 * 23505 es unique_violation. Comparar además el nombre de la restricción hace
 * que un índice añadido más adelante no pueda empezar a reportarse en silencio
 * como algo que no es.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  if (candidate.code !== '23505') return false
  return constraint === undefined || candidate.constraint === constraint
}
