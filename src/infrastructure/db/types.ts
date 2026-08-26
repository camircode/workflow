import pg from 'pg'

/**
 * node-postgres devuelve bigint como cadena, porque 2^63 no cabe en un número de
 * JavaScript. Todos los id de aquí son bigint de una columna identity, y ninguno
 * se acercará a 2^53 — así que se parsean como números en lugar de filtrar una
 * decisión de almacenamiento hacia una API cuyos consumidores tendrían que
 * explicar por qué un id viene entrecomillado.
 *
 * Se define una sola vez, al cargar el módulo, porque es una propiedad del
 * driver y no de ninguna consulta en particular.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number.parseInt(value, 10))
