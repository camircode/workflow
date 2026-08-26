// Declara lo que el setup global entrega a los archivos de prueba, para que
// inject('databaseUrl') esté tipado y no sea una cadena que nadie comprueba.
//
// En su propio archivo, e importando 'vitest', porque una ampliación de módulo
// solo se aplica cuando el módulo ampliado forma parte del programa — y el
// propio archivo de setup importa de 'vitest/node', que es un módulo distinto.
import 'vitest'

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string
  }
}
