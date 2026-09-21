import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Keeps generated, browser-facing contract artifacts separate from source and
  // prevents an obsolete experimental JSON payload from being shipped.
  publicDir: 'static',
});
