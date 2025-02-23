import MagicString from "https://esm.sh/magic-string@0.26.1";
import { parseDeps, transform } from "https://deno.land/x/aleph_compiler@0.1.0/mod.ts";
import type { TransformOptions, TransformResult } from "https://deno.land/x/aleph_compiler@0.1.0/types.ts";
import { readCode } from "../lib/fs.ts";
import log from "../lib/log.ts";
import util from "../lib/util.ts";
import { bundleCSS } from "./bundle_css.ts";
import {
  builtinModuleExts,
  getAlephPkgUri,
  getUnoGenerator,
  regFullVersion,
  restoreUrl,
  toLocalPath,
} from "./helpers.ts";
import { isRouteFile } from "./routing.ts";
import { DependencyGraph } from "./graph.ts";
import type { ImportMap, JSXConfig, ModuleLoaderContent } from "./types.ts";

export type TransformerOptions = {
  buildHash: string;
  buildTarget?: TransformOptions["target"];
  importMap: ImportMap;
  isDev: boolean;
  jsxConfig?: JSXConfig;
  loaded?: ModuleLoaderContent;
};

export default {
  test: (pathname: string) => {
    return pathname.startsWith("/-/") ||
      (builtinModuleExts.find((ext) => pathname.endsWith(`.${ext}`)) && !pathname.endsWith(".d.ts")) ||
      pathname.endsWith(".css");
  },
  fetch: async (req: Request, options: TransformerOptions): Promise<Response> => {
    const { isDev, buildHash, loaded } = options;
    const { pathname, searchParams, search } = new URL(req.url);
    const specifier = pathname.startsWith("/-/") ? restoreUrl(pathname + search) : `.${pathname}`;
    const clientDependencyGraph: DependencyGraph | undefined = Reflect.get(globalThis, "clientDependencyGraph");

    let sourceCode: string;
    let mtime: number | undefined;
    let lang: string | undefined;
    let isCSS: boolean;
    let uno: boolean;
    if (loaded) {
      sourceCode = loaded.code;
      mtime = loaded.modtime;
      lang = loaded.lang;
      isCSS = loaded.lang === "css";
      uno = !!loaded.atomicCSS;
    } else {
      let codeType: string;
      [sourceCode, mtime, codeType] = await readCode(specifier);
      isCSS = codeType.startsWith("text/css");
      uno = pathname.endsWith(".jsx") || pathname.endsWith(".tsx");
    }

    const etag = mtime
      ? `${mtime.toString(16)}-${sourceCode.length.toString(16)}-${buildHash.slice(0, 8)}`
      : await util.computeHash("sha-1", sourceCode + buildHash);
    if (req.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304 });
    }

    let resBody = "";
    let resType = "application/javascript";

    if (isCSS) {
      const asJsModule = searchParams.has("module");
      const { code, deps } = await bundleCSS(specifier, sourceCode, {
        // todo: support borwserslist
        targets: {
          android: 95,
          chrome: 95,
          edge: 95,
          firefox: 90,
          safari: 14,
        },
        minify: !isDev,
        cssModules: asJsModule && pathname.endsWith(".module.css"),
        asJsModule,
        hmr: isDev,
      });
      clientDependencyGraph?.mark(specifier, { deps: deps?.map((specifier) => ({ specifier })) });
      resBody = code;
      if (!asJsModule) {
        resType = "text/css";
      }
    } else {
      const alephPkgUri = getAlephPkgUri();
      const { jsxConfig, importMap, buildTarget } = options;
      let ret: TransformResult;
      if (/^https?:\/\/((cdn\.)?esm\.sh|unpkg\.com)\//.test(specifier)) {
        // don't transform modules imported from esm.sh
        const deps = await parseDeps(specifier, sourceCode, { importMap: JSON.stringify(importMap) });
        if (deps.length > 0) {
          const s = new MagicString(sourceCode);
          deps.forEach((dep) => {
            const { importUrl, loc } = dep;
            if (loc) {
              s.overwrite(loc.start, loc.end, `"${toLocalPath(importUrl)}"`);
            }
          });
          ret = { code: s.toString(), deps };
        } else {
          ret = { code: sourceCode, deps };
        }
      } else {
        const graphVersions = clientDependencyGraph?.modules.filter((mod) =>
          !util.isLikelyHttpURL(specifier) && !util.isLikelyHttpURL(mod.specifier) && mod.specifier !== specifier
        ).reduce((acc, { specifier, version }) => {
          acc[specifier] = version.toString(16);
          return acc;
        }, {} as Record<string, string>);
        ret = await transform(specifier, sourceCode, {
          ...jsxConfig,
          lang: lang as TransformOptions["lang"],
          stripDataExport: isRouteFile(specifier),
          target: buildTarget ?? (isDev ? "es2022" : "es2020"),
          alephPkgUri,
          importMap: JSON.stringify(importMap),
          graphVersions,
          initialGraphVersion: clientDependencyGraph?.initialVersion.toString(16),
          isDev,
        });
      }
      let { code, map, deps } = ret;
      let inlineCSS = loaded?.inlineCSS;
      if (uno) {
        const unoGenerator = getUnoGenerator();
        if (unoGenerator) {
          const { css } = await unoGenerator.generate(sourceCode, { id: specifier, minify: !isDev });
          if (inlineCSS) {
            inlineCSS = `${inlineCSS}\n${css}`;
          } else {
            inlineCSS = css;
          }
        }
      }
      if (inlineCSS) {
        code += `\nimport { applyCSS as __applyCSS } from "${
          toLocalPath(alephPkgUri)
        }/framework/core/style.ts";\n__applyCSS(${JSON.stringify(specifier)}, ${JSON.stringify(inlineCSS)});\n`;
        deps = [...(deps || []), { specifier: alephPkgUri + "/framework/core/style.ts" }] as typeof deps;
      }
      clientDependencyGraph?.mark(specifier, { deps });
      if (map) {
        try {
          const m = JSON.parse(map);
          if (!util.isLikelyHttpURL(specifier)) {
            m.sources = [`file://source/${util.trimPrefix(specifier, ".")}`];
          }
          m.sourcesContent = [sourceCode];
          resBody = code +
            `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${btoa(JSON.stringify(m))}\n`;
        } catch (e) {
          log.debug(`[dev] Failed to add source map for '${specifier}'`, e);
          resBody = code;
        }
      } else {
        resBody = code;
      }
    }
    const headers = new Headers({
      "Content-Type": `${resType}; charset=utf-8`,
      "Etag": etag,
    });
    if (searchParams.get("v") || (pathname.startsWith("/-/") && regFullVersion.test(pathname))) {
      headers.append("Cache-Control", "public, max-age=31536000, immutable");
    }
    return new Response(resBody, { headers });
  },
};
