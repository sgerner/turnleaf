import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { IncomingMessage } from 'http';
import { defineConfig, type Plugin } from 'vite';

function kavitaDevProxy(): Plugin {
  return {
    name: 'turnleaf-kavita-dev-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__kavita__/')) {
          next();
          return;
        }

        const encodedTarget = req.url.slice('/__kavita__/'.length);
        const target = decodeURIComponent(encodedTarget);
        const body = await readBody(req);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value == null) continue;
          const lower = key.toLowerCase();
          if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
          if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
          } else {
            headers.set(key, value);
          }
        }

        const response = await fetch(target, {
          method: req.method,
          headers,
          body,
          redirect: 'manual',
        });

        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (
            lower === 'content-encoding' ||
            lower === 'content-length' ||
            lower === 'transfer-encoding' ||
            lower === 'connection'
          ) {
            return;
          }
          res.setHeader(key, value);
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        res.end(buffer);
      });
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (!req.method || req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export default defineConfig({
  plugins: [tailwindcss(), svelte(), kavitaDevProxy()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
  },
});
