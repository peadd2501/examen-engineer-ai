import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // El workspace @credit/contracts vive fuera de apps/web: hay que permitir su lectura.
    fs: { allow: ['..', '../..'] },
  },
});
