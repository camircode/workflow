import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  assignUsers,
  completePart,
  createTask,
  getTask,
  listNotificationAttempts,
  listTasks,
} from '#application/task-service.js'
import type { NotificationDispatcher } from '#application/notification-dispatcher.js'
import type { Database } from '#application/ports.js'
import { presentNotificationAttempt, presentTask } from '#infrastructure/http/presenters.js'
import { runIdempotent } from '#infrastructure/http/idempotency.js'
import { idempotencyKeyOf } from '#infrastructure/http/request.js'
import {
  AssignBody,
  CompleteBody,
  CreateTaskBody,
  ConflictError,
  NotFoundError,
  IdempotencyHeaders,
  ListTasksQuery,
  MessageResponse,
  NotificationAttemptResponse,
  TaskIdParams,
  ValidationError,
  TaskResponse,
} from '#infrastructure/http/schemas.js'

/** Una tarea recién creada todavía no tiene personas asignadas. */
const CreatedTaskResponse = TaskResponse

export const tasksRoutes =
  (db: Database, dispatcher: NotificationDispatcher): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/tasks',
      {
        schema: {
          tags: ['tasks'],
          summary: 'Crear una tarea',
          headers: IdempotencyHeaders,
          body: CreateTaskBody,
          response: { 201: CreatedTaskResponse, 400: ValidationError, 409: ConflictError },
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
          summary: 'Asignar usuarios a una tarea',
          params: TaskIdParams,
          headers: IdempotencyHeaders,
          body: AssignBody,
          response: {
            200: MessageResponse,
            400: ValidationError,
            404: NotFoundError,
            409: ConflictError,
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
            return { body: { message: `Asignados a la tarea ${idTask}.` } }
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
          summary: 'Marcar como hecha la parte de un usuario en una tarea',
          description:
            'Cuando se completa la última parte pendiente, la tarea pasa a estar ' +
            'archivada y se envía la notificación — cada cosa exactamente una vez, ' +
            'por muchos llamantes que completen en el mismo instante.',
          params: TaskIdParams,
          headers: IdempotencyHeaders,
          body: CompleteBody,
          response: {
            200: MessageResponse,
            400: ValidationError,
            404: NotFoundError,
            409: ConflictError,
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
                  ? `La tarea ${idTask} está completa y ha sido archivada.`
                  : `Tu parte de la tarea ${idTask} está completa.`,
              },
              // Solo llega aquí el llamante que la archivó, así que la
              // notificación se envía una vez por muchas compleciones que hayan
              // llegado juntas.
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
          summary: 'Listar tareas, opcionalmente filtradas por estado',
          querystring: ListTasksQuery,
          response: { 200: z.array(TaskResponse), 400: ValidationError },
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
          summary: 'Leer una tarea con todas las personas asignadas a ella',
          params: TaskIdParams,
          response: { 200: TaskResponse, 404: NotFoundError },
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
          summary: 'Todos los intentos hechos para notificar al sistema cliente sobre esta tarea',
          params: TaskIdParams,
          response: { 200: z.array(NotificationAttemptResponse), 404: NotFoundError },
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
