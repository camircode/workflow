import type { FastifyRequest } from 'fastify'
import { IDEMPOTENCY_HEADER } from './idempotency.js'

/**
 * Una cabecera puede llegar legítimamente más de una vez. Tomar la primera en
 * lugar de unirlas hace que dos claves distintas no puedan combinarse en una
 * tercera que no coincida con nada: se considera que la petición lleva la
 * primera clave que presentó.
 */
export function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const raw = request.headers[IDEMPOTENCY_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
