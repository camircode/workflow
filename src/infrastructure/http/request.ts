import type { FastifyRequest } from 'fastify'
import { IDEMPOTENCY_HEADER } from './idempotency.js'

/**
 * A header can legally arrive more than once. Taking the first rather than
 * joining them means two different keys cannot combine into a third that matches
 * nothing — the request is treated as carrying the first key it presented.
 */
export function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const raw = request.headers[IDEMPOTENCY_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
