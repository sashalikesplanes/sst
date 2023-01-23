import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import fsSync from "fs";
import { useProject } from "../../project.js";
import esbuild, { BuildOptions, BuildResult } from "esbuild";
import url from "url";
import { Worker } from "worker_threads";
import { useRuntimeHandlers } from "../handlers.js";
import { useRuntimeWorkers } from "../workers.js";
import { Context } from "../../context/context.js";
import { VisibleError } from "../../error.js";
import { Colors } from "../../cli/colors.js";

export const useNodeHandler = Context.memo(async () => {
  const workers = await useRuntimeWorkers();
  const handlers = useRuntimeHandlers();
  const cache: Record<string, esbuild.BuildResult> = {};
  const project = useProject();
  const threads = new Map<string, Worker>();

  handlers.register({
    shouldBuild: (input) => {
      const result = cache[input.functionID];
      if (!result) return false;
      const relative = path.relative(
        project.paths.root,
        input.file.split(path.sep).join(path.posix.sep)
      );
      return Boolean(result.metafile?.inputs[relative]);
    },
    canHandle: (input) => input.startsWith("nodejs"),
    startWorker: async (input) => {
      new Promise(async () => {
        const worker = new Worker(
          url.fileURLToPath(
            new URL("../../support/nodejs-runtime/index.mjs", import.meta.url)
          ),
          {
            env: {
              ...process.env,
              ...input.environment,
              IS_LOCAL: "true",
            },
            execArgv: ["--enable-source-maps"],
            workerData: input,
            stderr: true,
            stdin: true,
            stdout: true,
          }
        );
        worker.stdout.on("data", (data: Buffer) => {
          workers.stdout(input.workerID, data.toString());
        });
        worker.stderr.on("data", (data: Buffer) => {
          workers.stdout(input.workerID, data.toString());
        });
        worker.on("exit", () => workers.exited(input.workerID));
        threads.set(input.workerID, worker);
      });
    },
    stopWorker: async (workerID) => {
      const worker = threads.get(workerID);
      await worker?.terminate();
    },
    build: async (input) => {
      const exists = cache[input.functionID];
      const parsed = path.parse(input.props.handler!);
      const file = [
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
      ]
        .map((ext) => path.join(parsed.dir, parsed.name + ext))
        .find((file) => {
          return fsSync.existsSync(file);
        })!;
      if (!file)
        throw new Error(
          `Cannot find a handler file for "${input.props.handler}"`
        );

      const nodejs = input.props.nodejs || {};
      const isESM = (nodejs.format || "esm") === "esm";

      const relative = path.relative(
        project.paths.root,
        path.resolve(parsed.dir)
      );

      const extension = isESM ? ".mjs" : ".cjs";
      const target = path.join(
        input.out,
        !relative.startsWith("..") && !path.isAbsolute(relative)
          ? relative
          : "",
        parsed.name + extension
      );
      const handler = path
        .relative(input.out, target.replace(extension, parsed.ext))
        .split(path.sep)
        .join(path.posix.sep);

      if (exists?.rebuild) {
        const result = await exists.rebuild();
        cache[input.functionID] = result;
        return {
          type: "success",
          handler,
        };
      }

      const { external, ...override } = nodejs.esbuild || {};
      const options: BuildOptions = {
        entryPoints: [file],
        platform: "node",
        external: [
          ...(isESM || input.props.runtime === "nodejs18.x" ? [] : ["aws-sdk"]),
          ...(nodejs.install || []),
          ...(external || []),
        ],
        keepNames: true,
        bundle: true,
        logLevel: "silent",
        metafile: true,
        ...(isESM
          ? {
              format: "esm",
              target: "esnext",
              mainFields: isESM ? ["module", "main"] : undefined,
              banner: {
                js: [
                  `import { createRequire as topLevelCreateRequire } from 'module';`,
                  `const require = topLevelCreateRequire(import.meta.url);`,
                  nodejs.banner || "",
                ].join("\n"),
              },
            }
          : {
              format: "cjs",
              target: "node14",
              banner: nodejs.banner
                ? {
                    js: nodejs.banner,
                  }
                : undefined,
            }),
        outfile: target,
        sourcemap: input.mode === "start" ? "linked" : nodejs.sourcemap,
        minify: nodejs.minify,
        ...override,
      };

      try {
        const result = await esbuild.build(options);

        // Install node_modules
        if (options.external?.length) {
          async function find(dir: string, target: string): Promise<string> {
            if (dir === "/")
              throw new VisibleError("Could not find a package.json file");
            if (
              await fs
                .access(path.join(dir, target))
                .then(() => true)
                .catch(() => false)
            )
              return dir;
            return find(path.join(dir, ".."), target);
          }

          if (input.mode === "deploy" && nodejs.install) {
            const src = await find(parsed.dir, "package.json");
            const json = JSON.parse(
              await fs
                .readFile(path.join(src, "package.json"))
                .then((x) => x.toString())
            );
            fs.writeFile(
              path.join(input.out, "package.json"),
              JSON.stringify({
                dependencies: Object.fromEntries(
                  nodejs.install?.map((x) => [x, json.dependencies?.[x] || "*"])
                ),
              })
            );
            await new Promise<void>((resolve) => {
              const process = exec("npm install", {
                cwd: input.out,
              });
              process.on("exit", () => resolve());
            });
          }

          if (input.mode === "start") {
            const dir = path.join(
              await find(parsed.dir, "package.json"),
              "node_modules"
            );
            try {
              await fs.symlink(
                path.resolve(dir),
                path.resolve(path.join(input.out, "node_modules")),
                "dir"
              );
            } catch {}
          }
        }

        cache[input.functionID] = result;
        return {
          type: "success",
          handler,
        };
      } catch (ex: any) {
        const result = ex as BuildResult;
        return {
          type: "error",
          errors: result.errors.flatMap((x) => [
            Colors.bold(x.text),
            x.location?.file || "",
            Colors.dim(x.location?.line, "│", x.location?.lineText),
          ]),
        };
      }
    },
  });
});
