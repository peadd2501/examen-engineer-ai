/**
 * URL base de la API.
 *
 * Se lee con acceso opcional porque `import.meta.env` solo existe cuando el
 * modulo corre bajo Vite. Los tests de render importan estos servicios en Node,
 * donde `import.meta.env` es `undefined`; sin la guarda el modulo reventaria al
 * importarse. En el navegador el comportamiento es exactamente el mismo.
 */
const ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export const BASE_URL: string = ENV?.['VITE_API_URL'] ?? 'http://localhost:3001';
