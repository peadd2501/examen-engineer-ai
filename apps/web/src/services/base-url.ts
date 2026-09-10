/**
 * URL base de la API.
 *
 * Se lee con acceso opcional porque `import.meta.env` solo existe bajo Vite: los
 * tests de render importan estos servicios en Node y sin la guarda el modulo
 * reventaria al importarse.
 */
const ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export const BASE_URL: string = ENV?.['VITE_API_URL'] ?? 'http://localhost:3001';
