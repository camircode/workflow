import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { listTasksForUser, listUsers, registerUser } from '../../../application/user-service.js'
import type { Database } from '../../../application/ports.js'
import { presentTaskForUser, presentUser, presentUserWithPendingTasks } from '../presenters.js'
import { runIdempotent } from '../idempotency.js'
import { idempotencyKeyOf } from '../request.js'
import {
  CreateUserBody,
  ConflictError,
  NotFoundError,
  IdempotencyHeaders,
  TaskForUserResponse,
  UserIdParams,
  UserResponse,
  UserWithPendingTasksResponse,
  ValidationError,
} from '../schemas.js'
import { z } from 'zod'

export const usersRoutes =
  (db: Database): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/users',
      {
        schema: {
          tags: ['users'],
          summary: 'Registrar un usuario',
          headers: IdempotencyHeaders,
          body: CreateUserBody,
          response: { 201: UserResponse, 400: ValidationError, 409: ConflictError },
        },
      },
      async (request, reply) => {
        const result = await runIdempotent(
          db,
          idempotencyKeyOf(request),
          'POST /users',
          request.body,
          201,
          async (uow) => ({ body: presentUser(await registerUser(uow, request.body)) }),
        )
        return reply.status(result.status).send(result.body)
      },
    )

    app.get(
      '/users',
      {
        schema: {
          tags: ['users'],
          summary: 'Listar usuarios con las tareas que todavía deben',
          response: { 200: z.array(UserWithPendingTasksResponse) },
        },
      },
      async (request, reply) => {
        const users = await db.transaction(listUsers)
        return reply.send(users.map(presentUserWithPendingTasks))
      },
    )

    app.get(
      '/users/:idUser/tasks',
      {
        schema: {
          tags: ['users'],
          summary: 'Listar las tareas de un usuario y si su parte está hecha',
          params: UserIdParams,
          response: { 200: z.array(TaskForUserResponse), 404: NotFoundError },
        },
      },
      async (request, reply) => {
        const tasks = await db.transaction((uow) =>
          listTasksForUser(uow, request.params.idUser),
        )
        return reply.send(tasks.map(presentTaskForUser))
      },
    )
  }
