import pg from 'pg'

/**
 * node-postgres hands back bigint as a string, because 2^63 does not fit in a
 * JavaScript number. Every id here is a bigint from an identity column, and none
 * of them will approach 2^53 — so they are parsed as numbers rather than leaking
 * a storage decision into an API whose consumers would have to explain why an id
 * is quoted.
 *
 * Set once, at module load, because it is a property of the driver rather than
 * of any one query.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number.parseInt(value, 10))
