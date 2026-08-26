import { z } from 'zod'
import { ERROR_CODES } from '../../domain/errors.js'

/**
 * One definition per shape, used twice: to validate what arrives and to describe
 * the API at /docs.
 *
 * This is the whole point of the OpenAPI document being generated rather than
 * written. A hand-kept spec is a second source of truth that starts out correct
 * and drifts the first time someone changes a field and forgets — and a wrong
 * spec is worse than none, because it is believed.
 */

const trimmed = (field: string) =>
  z.string({ error: `${field} is required` }).trim().min(1, `${field} cannot be empty`)

// --- requests ---------------------------------------------------------------

export const CreateUserBody = z
  .object({
    name: trimmed('name'),
    lastName: trimmed('lastName'),
    email: z.email('email must be a valid address'),
  })
  .meta({ id: 'CreateUserBody' })

export const CreateTaskBody = z
  .object({
    title: trimmed('title'),
    // Optional by the specification. Absent and null both mean "no description",
    // and both are stored as null rather than preserving a distinction the API
    // would then have to explain.
    description: z.string().trim().nullish().transform((value) => value ?? null),
  })
  .meta({ id: 'CreateTaskBody' })

export const AssignBody = z
  .object({
    userIds: z
      .array(z.number().int().positive())
      .min(1, 'userIds must contain at least one user'),
  })
  .meta({ id: 'AssignBody' })

export const CompleteBody = z
  .object({ userId: z.number().int().positive() })
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
    /** Null when the destination never answered: a timeout has no status code. */
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
 * Documented as a header rather than left implicit, because a reliability
 * feature nobody can see in the API description is a reliability feature nobody
 * uses.
 *
 * Loose, so that validating this one header does not strip every other header
 * off the request on the way past.
 */
export const IdempotencyHeaders = z.looseObject({
  'idempotency-key': z
    .string()
    .min(1)
    .optional()
    .meta({
      description:
        'Send the same key with the same body twice and the operation happens ' +
        'once; both responses are identical. Holds even when the two requests ' +
        'arrive at the same instant. The same key with a different body is ' +
        'refused with 409.',
    }),
})

