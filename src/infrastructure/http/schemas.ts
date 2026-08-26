import { z } from 'zod'
import { ERROR_CODES } from '../../domain/errors.js'

/**
 * Una definición por forma, usada dos veces: para validar lo que llega y para
 * describir la API en /docs.
 *
 * Este es justamente el motivo de que el documento OpenAPI se genere en lugar de
 * escribirse. Una especificación mantenida a mano es una segunda fuente de verdad
 * que empieza siendo correcta y se desvía la primera vez que alguien cambia un
 * campo y se olvida — y una especificación equivocada es peor que ninguna, porque
 * se cree.
 */

const trimmed = (field: string) =>
  z.string({ error: `${field} es obligatorio` }).trim().min(1, `${field} no puede estar vacío`)

// --- requests ---------------------------------------------------------------

// Cada campo lleva un ejemplo explícito. Sin él, Swagger UI genera uno a partir
// del esquema, y para `email` eso significa fabricar una cadena que cumpla el
// patrón que Zod emite junto al formato: el resultado es un bloque ilegible de
// varias líneas en mitad del cuerpo de ejemplo.
export const CreateUserBody = z
  .object({
    name: trimmed('name').meta({ example: 'Ada' }),
    lastName: trimmed('lastName').meta({ example: 'Lovelace' }),
    email: z.email('email debe ser una dirección válida').meta({ example: 'ada@example.com' }),
  })
  .meta({ id: 'CreateUserBody' })

export const CreateTaskBody = z
  .object({
    title: trimmed('title').meta({ example: 'Preparar la demo' }),
    // Opcional según la especificación. Ausente y null significan ambos "sin
    // descripción", y ambos se guardan como null en lugar de preservar una
    // distinción que la API tendría después que explicar.
    description: z
      .string()
      .trim()
      .nullish()
      .transform((value) => value ?? null)
      .meta({ example: 'Repasar el guion antes del viernes' }),
  })
  .meta({ id: 'CreateTaskBody' })

export const AssignBody = z
  .object({
    userIds: z
      .array(z.number().int().positive())
      .min(1, 'userIds debe contener al menos un usuario')
      .meta({ example: [1, 2] }),
  })
  .meta({ id: 'AssignBody' })

export const CompleteBody = z
  .object({ userId: z.number().int().positive().meta({ example: 1 }) })
  .meta({ id: 'CompleteBody' })

export const TaskIdParams = z.object({ idTask: z.coerce.number().int().positive() })
export const UserIdParams = z.object({ idUser: z.coerce.number().int().positive() })

export const ListTasksQuery = z.object({
  status: z.enum(['open', 'archived']).optional(),
})

// --- responses --------------------------------------------------------------

const timestamp = z.iso.datetime()

export const UserResponse = z
  .object({
    id: z.number().int(),
    name: z.string(),
    lastName: z.string(),
    email: z.email(),
    createdAt: timestamp,
  })
  .meta({ id: 'User' })

export const TaskSummary = z
  .object({
    id: z.number().int(),
    title: z.string(),
    status: z.enum(['open', 'archived']),
  })
  .meta({ id: 'TaskSummary' })

export const UserWithPendingTasksResponse = UserResponse.extend({
  pendingTasks: z.array(TaskSummary),
}).meta({ id: 'UserWithPendingTasks' })

export const AssigneeResponse = z
  .object({
    userId: z.number().int(),
    name: z.string(),
    lastName: z.string(),
    email: z.email(),
    completed: z.boolean(),
    completedAt: timestamp.nullable(),
  })
  .meta({ id: 'Assignee' })

export const TaskResponse = z
  .object({
    id: z.number().int(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(['open', 'archived']),
    archivedAt: timestamp.nullable(),
    createdAt: timestamp,
    assignees: z.array(AssigneeResponse),
  })
  .meta({ id: 'Task' })

export const TaskForUserResponse = z
  .object({
    id: z.number().int(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(['open', 'archived']),
    archivedAt: timestamp.nullable(),
    createdAt: timestamp,
    completed: z.boolean(),
    completedAt: timestamp.nullable(),
  })
  .meta({ id: 'TaskForUser' })

export const NotificationAttemptResponse = z
  .object({
    attemptNumber: z.number().int(),
    attemptedAt: timestamp,
    /** Null cuando el destino nunca respondió: un timeout no tiene código de estado. */
    httpStatus: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'NotificationAttempt' })

export const MessageResponse = z.object({ message: z.string() }).meta({ id: 'Message' })

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
    }),
  })
  .meta({ id: 'Error' })

export type ErrorBody = z.infer<typeof ErrorResponse>

/**
 * Documentada como cabecera en lugar de dejarse implícita, porque una
 * característica de fiabilidad que nadie puede ver en la descripción de la API es
 * una característica de fiabilidad que nadie usa.
 *
 * Laxa, para que validar esta única cabecera no despoje a la petición de todas
 * las demás cabeceras al pasar.
 */
export const IdempotencyHeaders = z.looseObject({
  'idempotency-key': z
    .string()
    .min(1)
    .optional()
    .meta({
      example: '3f1a9c7e-2b44-4d51-9a2f-0c8e5d7b1a63',
      description:
        'Envía la misma clave con el mismo cuerpo dos veces y la operación ocurre ' +
        'una sola vez; ambas respuestas son idénticas. Se cumple incluso cuando las ' +
        'dos peticiones llegan en el mismo instante. La misma clave con un cuerpo ' +
        'distinto se rechaza con 409.',
    }),
})

