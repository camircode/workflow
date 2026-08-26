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
  // Checked rather than inferred from an empty result: a user with no tasks and
  // a user who does not exist are different answers, and returning [] for both
  // hides a typo in an id behind a plausible-looking success.
  const user = await uow.users.findById(userId)
  if (!user) throw userNotFound(userId)

  return uow.users.listTasksFor(userId)
}
