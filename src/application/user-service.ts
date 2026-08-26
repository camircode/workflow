import { userNotFound } from '../domain/errors.js'
import type { TaskForUser, User, UserWithPendingTasks } from '../domain/model.js'
import type { NewUser, UnitOfWork } from './ports.js'

export const registerUser = (uow: UnitOfWork, input: NewUser): Promise<User> =>
  uow.users.create(input)

export const listUsers = (uow: UnitOfWork): Promise<UserWithPendingTasks[]> =>
  uow.users.listWithPendingTasks()

export async function listTasksForUser(
  uow: UnitOfWork,
  userId: number,
): Promise<TaskForUser[]> {
  // Se comprueba en lugar de inferirse de un resultado vacío: un usuario sin
  // tareas y un usuario que no existe son respuestas distintas, y devolver []
  // para ambos esconde una errata en un id detrás de un éxito con toda la
  // apariencia de serlo.
  const user = await uow.users.findById(userId)
  if (!user) throw userNotFound(userId)

  return uow.users.listTasksFor(userId)
}
