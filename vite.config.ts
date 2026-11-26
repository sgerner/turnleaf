import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import {
  DEV_PROXY_PREFIX,
  decodeProxyTarget,
  parseAllowedOrigins,
  proxyRequestHeaders,
  readProxyBody,
  sendProxyResponse,
  DevProxyError,
  fetchProxyTarget,
  validateProxyTarget,
} from './scripts/dev-proxy.ts';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};
const appVersion = process.env.TURNLEAF_VERSION_NAME ?? packageJson.version;

function kavitaDevProxy(): Plugin {
  const allowedOrigins = parseAllowedOrigins();

  return {
    name: 'turnleaf-kavita-dev-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(DEV_PROXY_PREFIX)) {
          next();
          return;
        }

        try {
          const encodedTarget = req.url.slice(DEV_PROXY_PREFIX.length);
          const target = decodeProxyTarget(encodedTarget);
          const targetResult = validateProxyTarget(target, allowedOrigins);
          if (!targetResult.ok) {
            throw new DevProxyError(400, 'The Kavita development proxy target is not allowed.');
          }

          const body = await readProxyBody(req);
          const response = await fetchProxyTarget(targetResult.url, {
            method: req.method ?? 'GET',
            headers: proxyRequestHeaders(req.headers),
            body: body as unknown as BodyInit | undefined,
          });
          await sendProxyResponse(res, response);
        } catch (error) {
          if (res.headersSent) {
            res.destroy();
            return;
          }

          const proxyError =
            error instanceof DevProxyError
              ? error
              : new DevProxyError(502, 'The Kavita development proxy request failed.');
          res.statusCode = proxyError.statusCode;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(proxyError.message);
        }
      });
    },
  };
}

const EPUBJS_XMLDOM_STUB_ID = '\0turnleaf:epubjs-xmldom-stub';
const EPUBJS_EMPTY_STUB_ID = '\0turnleaf:epubjs-empty-stub';

function epubjsDeadModuleStubs(): Plugin {
  return {
    name: 'turnleaf-epubjs-dead-module-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@xmldom/xmldom') return EPUBJS_XMLDOM_STUB_ID;
      if (source === 'localforage') return EPUBJS_EMPTY_STUB_ID;

      const normalizedSource = source.replaceAll('\\', '/');
      if (
        normalizedSource === 'epubjs/src/store' ||
        normalizedSource === 'epubjs/src/store.js' ||
        normalizedSource.startsWith('epubjs/src/managers/continuous')
      ) {
        return EPUBJS_EMPTY_STUB_ID;
      }

      const normalizedImporter = importer?.replaceAll('\\', '/') ?? '';
      if (!normalizedImporter.includes('/node_modules/epubjs/')) return null;

      if (normalizedSource === './store' || normalizedSource === './store.js') {
        return EPUBJS_EMPTY_STUB_ID;
      }
      if (
        normalizedSource === './managers/continuous' ||
        normalizedSource === './managers/continuous/index' ||
        normalizedSource === './managers/continuous/index.js'
      ) {
        return EPUBJS_EMPTY_STUB_ID;
      }
      return null;
    },
    load(id) {
      if (id === EPUBJS_XMLDOM_STUB_ID) {
        return 'export const DOMParser = globalThis.DOMParser;\nexport const XMLSerializer = globalThis.XMLSerializer;\n';
      }
      if (id === EPUBJS_EMPTY_STUB_ID) {
        return 'export default function UnusedEpubModule() {}\n';
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [epubjsDeadModuleStubs(), tailwindcss(), svelte(), kavitaDevProxy()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: process.env.VITEST
    ? {
        conditions: ['browser'],
      }
    : undefined,
  build: {
    target: 'es2022',
    sourcemap: false,
    modulePreload: {
      polyfill: false,
    },
  },
});
