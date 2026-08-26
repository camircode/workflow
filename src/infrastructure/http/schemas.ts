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

/**
 * Un ejemplo por modelo de respuesta.
 *
 * Sin ellos, Swagger UI construye el cuerpo de ejemplo a partir del esquema, y
 * lo que produce no le sirve a nadie: `-9007199254740991` para los enteros,
 * porque toma el mínimo declarado; y varias líneas de caracteres aleatorios
 * para `email` y para las fechas, porque genera una cadena que cumpla el patrón
 * que Zod emite junto al formato.
 *
 * A nivel de modelo y no campo por campo, para poder escribir el objeto
 * completo —incluidos los anidados— y que la respuesta de ejemplo se lea como
 * una respuesta real.
 */
const AT = '2026-08-26T04:43:14.221Z'

const USER_EXAMPLE = {
  id: 1,
  name: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  createdAt: AT,
}

const ASSIGNEE_EXAMPLE = {
  userId: 1,
  name: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  completed: true,
  completedAt: AT,
}

const TASK_FIELDS = {
  id: 1,
  title: 'Preparar la demo',
  description: 'Repasar el guion antes del viernes',
  status: 'archived',
  archivedAt: AT,
  createdAt: AT,
}

export const UserResponse = z
  .object({
    id: z.number().int(),
    name: z.string(),
    lastName: z.string(),
    email: z.email(),
    createdAt: timestamp,
  })
  .meta({ id: 'User', example: USER_EXAMPLE })

export const TaskSummary = z
  .object({
    id: z.number().int(),
    title: z.string(),
    status: z.enum(['open', 'archived']),
  })
  .meta({ id: 'TaskSummary', example: { id: 1, title: 'Preparar la demo', status: 'open' } })

export const UserWithPendingTasksResponse = UserResponse.extend({
  pendingTasks: z.array(TaskSummary),
}).meta({
  id: 'UserWithPendingTasks',
  example: {
    ...USER_EXAMPLE,
    pendingTasks: [{ id: 2, title: 'Revisar el presupuesto', status: 'open' }],
  },
})

export const AssigneeResponse = z
  .object({
    userId: z.number().int(),
    name: z.string(),
    lastName: z.string(),
    email: z.email(),
    completed: z.boolean(),
    completedAt: timestamp.nullable(),
  })
  .meta({ id: 'Assignee', example: ASSIGNEE_EXAMPLE })

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
  .meta({ id: 'Task', example: { ...TASK_FIELDS, assignees: [ASSIGNEE_EXAMPLE] } })

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
  .meta({ id: 'TaskForUser', example: { ...TASK_FIELDS, completed: true, completedAt: AT } })

export const NotificationAttemptResponse = z
  .object({
    attemptNumber: z.number().int(),
    attemptedAt: timestamp,
    /** Null cuando el destino nunca respondió: un timeout no tiene código de estado. */
    httpStatus: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .meta({
    id: 'NotificationAttempt',
    example: { attemptNumber: 1, attemptedAt: AT, httpStatus: 200, error: null },
  })

export const MessageResponse = z
  .object({ message: z.string() })
  .meta({ id: 'Message', example: { message: 'La tarea 1 está completa y ha sido archivada.' } })

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
    }),
  })
  .meta({ id: 'Error' })

/**
 * Un ejemplo por estado, sobre la misma forma.
 *
 * Todos conservan el enum completo de códigos, así que el serializador no puede
 * rechazar una respuesta legítima; lo único que cambia es el ejemplo que se ve
 * en /docs. Con un solo ejemplo compartido, el 400 de POST /users mostraba
 * TASK_NOT_FOUND, que ese endpoint no devuelve nunca.
 */
export const ValidationError = ErrorResponse.meta({
  id: 'ValidationError',
  description: 'El cuerpo, los parámetros de ruta o la query no pasaron validación. `code` es siempre `VALIDATION_ERROR`, y `message` enumera todos los problemas encontrados, no sólo el primero.',
  example: { error: { code: 'VALIDATION_ERROR', message: '/email email debe ser una dirección válida' } },
})

export const NotFoundError = ErrorResponse.meta({
  id: 'NotFoundError',
  description: '`code` es `TASK_NOT_FOUND` o `USER_NOT_FOUND` según qué no exista. Cuando falta más de un usuario, `message` los nombra a todos de una vez.',
  example: { error: { code: 'TASK_NOT_FOUND', message: 'No hay ninguna tarea registrada con el id 99.' } },
})

export const ConflictError = ErrorResponse.meta({
  id: 'ConflictError',
  description: 'El recurso existe pero la operación no procede. `code` identifica el caso: `EMAIL_ALREADY_REGISTERED`, `USER_NOT_ASSIGNED`, `TASK_ALREADY_ARCHIVED`, `IDEMPOTENCY_KEY_REUSED` o `IDEMPOTENCY_REQUEST_IN_PROGRESS`.',
  example: {
    error: {
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'La Idempotency-Key 3f1a9c7e-2b44-4d51-9a2f-0c8e5d7b1a63 ya se usó en este endpoint con un cuerpo distinto.',
    },
  },
})

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

