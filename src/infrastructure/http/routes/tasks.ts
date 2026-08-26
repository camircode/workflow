import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  assignUsers,
  completePart,
  createTask,
  getTask,
  listNotificationAttempts,
  listTasks,
} from '../../../application/task-service.js'
import type { NotificationDispatcher } from '../../../application/notification-dispatcher.js'
import type { Database } from '../../../application/ports.js'
import { presentNotificationAttempt, presentTask } from '../presenters.js'
import { runIdempotent } from '../idempotency.js'
import { idempotencyKeyOf } from '../request.js'
import {
  AssignBody,
  CompleteBody,
  CreateTaskBody,
  ErrorResponse,
  IdempotencyHeaders,
  ListTasksQuery,
  MessageResponse,
  NotificationAttemptResponse,
  TaskIdParams,
  TaskResponse,
} from '../schemas.js'

/** A task the moment it was created has no assignees yet. */
const CreatedTaskResponse = TaskResponse

export const tasksRoutes =
  (db: Database, dispatcher: NotificationDispatcher): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/tasks',
      {
        schema: {
          tags: ['tasks'],
          summary: 'Create a task',
          headers: IdempotencyHeaders,
          body: CreateTaskBody,
          response: { 201: CreatedTaskResponse, 400: ErrorResponse, 409: ErrorResponse },
        },
      },
      async (request, reply) => {
        const result = await runIdempotent(
          db,
          idempotencyKeyOf(request),
          'POST /tasks',
          request.body,
          201,
          async (uow) => {
            const task = await createTask(uow, request.body)
            return { body: presentTask({ ...task, assignees: [] }) }
          },
        )
        return reply.status(result.status).send(result.body)
      },
    )

    app.post(
      '/tasks/:idTask/assign',
      {
        schema: {
          tags: ['tasks'],
          summary: 'Assign users to a task',
          params: TaskIdParams,
          headers: IdempotencyHeaders,
          body: AssignBody,
          response: {
            200: MessageResponse,
            400: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
          },
        },
      },
      async (request, reply) => {
        const { idTask } = request.params
        const result = await runIdempotent(
          db,
          idempotencyKeyOf(request),
          `POST /tasks/${idTask}/assign`,
          request.body,
          200,
          async (uow) => {
            await assignUsers(uow, idTask, request.body.userIds)
            return { body: { message: `Assigned to task ${idTask}.` } }
          },
        )
        return reply.status(result.status).send(result.body)
      },
    )

    app.post(
      '/tasks/:idTask/complete',
      {
        schema: {
          tags: ['tasks'],
          summary: "Mark one user's part of a task as done",
          description:
            'When the last outstanding part is completed the task becomes archived ' +
            'and the notification is sent — each exactly once, however many callers ' +
            'complete at the same instant.',
          params: TaskIdParams,
          headers: IdempotencyHeaders,
          body: CompleteBody,
          response: {
            200: MessageResponse,
            400: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
          },
        },
      },
      async (request, reply) => {
        const { idTask } = request.params
        const result = await runIdempotent(
          db,
          idempotencyKeyOf(request),
          `POST /tasks/${idTask}/complete`,
          request.body,
          200,
          async (uow) => {
            const { archived } = await completePart(uow, idTask, request.body.userId)
            return {
              body: {
                message: archived
                  ? `Task ${idTask} is complete and has been archived.`
                  : `Your part of task ${idTask} is complete.`,
              },
              // Only the caller that archived it gets here, so the notification
              // is sent once no matter how many completions arrived together.
              ...(archived ? { afterCommit: () => dispatcher.dispatch(archived) } : {}),
            }
          },
        )
        return reply.status(result.status).send(result.body)
      },
    )

    app.get(
      '/tasks',
      {
        schema: {
          tags: ['tasks'],
          summary: 'List tasks, optionally filtered by status',
          querystring: ListTasksQuery,
          response: { 200: z.array(TaskResponse), 400: ErrorResponse },
        },
      },
      async (request, reply) => {
        const tasks = await db.transaction((uow) => listTasks(uow, request.query.status))
        return reply.send(tasks.map(presentTask))
      },
    )

    app.get(
      '/tasks/:idTask',
      {
        schema: {
          tags: ['tasks'],
          summary: 'Read one task with everyone assigned to it',
          params: TaskIdParams,
          response: { 200: TaskResponse, 404: ErrorResponse },
        },
      },
      async (request, reply) => {
        const task = await db.transaction((uow) => getTask(uow, request.params.idTask))
        return reply.send(presentTask(task))
      },
    )

    app.get(
      '/tasks/:idTask/notifications',
      {
        schema: {
          tags: ['tasks'],
          summary: 'Every attempt made to notify the client system for this task',
          params: TaskIdParams,
          response: { 200: z.array(NotificationAttemptResponse), 404: ErrorResponse },
        },
      },
      async (request, reply) => {
        const attempts = await db.transaction((uow) =>
          listNotificationAttempts(uow, request.params.idTask),
        )
        return reply.send(attempts.map(presentNotificationAttempt))
      },
    )
  }
