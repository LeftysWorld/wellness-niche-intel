import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The calculation engine is shared with the edge functions: the dashboard's
// what-if sliders run exactly the same code as the server.
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: ['..'] } },
});
