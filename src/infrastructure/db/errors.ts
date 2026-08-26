/**
 * Recognising a PostgreSQL error without pulling its shape through the domain.
 *
 * 23505 is unique_violation. Matching on the constraint name as well means a new
 * index added later cannot quietly start being reported as something it is not.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  if (candidate.code !== '23505') return false
  return constraint === undefined || candidate.constraint === constraint
}
