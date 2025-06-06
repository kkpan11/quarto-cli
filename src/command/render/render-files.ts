/*
 * render-files.ts
 *
 * Copyright (C) 2020-2022 Posit Software, PBC
 */

// ensures cell handlers are installed
import "../../core/handlers/handlers.ts";

import {
  kExecuteEnabled,
  kFreeze,
  kIncludeInHeader,
  kKeepMd,
  kLang,
  kQuartoRequired,
} from "../../config/constants.ts";
import { isHtmlCompatible } from "../../config/format.ts";
import { mergeConfigs } from "../../core/config.ts";
import { initDayJsPlugins, setDateLocale } from "../../core/date.ts";
import { initDenoDom } from "../../core/deno-dom.ts";
import { HandlerContextResults } from "../../core/handlers/types.ts";
import {
  handleLanguageCells,
  languages,
  resetFigureCounter,
} from "../../core/handlers/base.ts";
import { LanguageCellHandlerOptions } from "../../core/handlers/types.ts";
import { asMappedString, mappedDiff } from "../../core/mapped-text.ts";
import {
  validateDocument,
  validateDocumentFromSource,
} from "../../core/schema/validate-document.ts";
import { createTempContext, TempContext } from "../../core/temp.ts";
import {
  executionEngineKeepMd,
  fileExecutionEngineAndTarget,
} from "../../execute/engine.ts";
import { annotateOjsLineNumbers } from "../../execute/ojs/annotate-source.ts";
import { ojsExecuteResult } from "../../execute/ojs/compile.ts";
import {
  ExecuteOptions,
  ExecuteResult,
  MappedExecuteResult,
} from "../../execute/types.ts";
import { kProjectLibDir, ProjectContext } from "../../project/types.ts";
import { outputRecipe } from "./output.ts";

import { renderPandoc } from "./render.ts";
import { PandocRenderCompletion, RenderServices } from "./types.ts";
import { renderContexts } from "./render-contexts.ts";
import { renderProgress } from "./render-info.ts";
import {
  ExecutedFile,
  PandocRenderer,
  RenderContext,
  RenderedFile,
  RenderedFormat,
  RenderExecuteOptions,
  RenderFile,
  RenderFilesResult,
  RenderFlags,
  RenderOptions,
} from "./types.ts";
import { error, info } from "../../deno_ral/log.ts";
import * as ld from "../../core/lodash.ts";
import { basename, dirname, join, relative } from "../../deno_ral/path.ts";
import { Format } from "../../config/types.ts";
import {
  figuresDir,
  inputFilesDir,
  isServerShiny,
  isServerShinyKnitr,
} from "../../core/render.ts";
import {
  normalizePath,
  removeIfEmptyDir,
  removeIfExists,
} from "../../core/path.ts";
import { resourcePath } from "../../core/resources.ts";
import { YAMLValidationError } from "../../core/yaml.ts";
import { resolveParams } from "./flags.ts";
import {
  copyFromProjectFreezer,
  copyToProjectFreezer,
  defrostExecuteResult,
  freezeExecuteResult,
  freezerFigsDir,
  freezerFreezeFile,
  kProjectFreezeDir,
  removeFreezeResults,
} from "./freeze.ts";
import { isJupyterNotebook } from "../../core/jupyter/jupyter.ts";
import { MappedString } from "../../core/lib/text-types.ts";
import {
  createNamedLifetime,
  Lifetime,
  waitUntilNamedLifetime,
} from "../../core/lifetimes.ts";
import { resolveDependencies } from "./pandoc-dependencies-html.ts";
import {
  getData as getTimingData,
  pop as popTiming,
  push as pushTiming,
  withTiming,
  withTimingAsync,
} from "../../core/timing.ts";
import { satisfies } from "semver/mod.ts";
import { quartoConfig } from "../../core/quarto.ts";
import { ensureNotebookContext } from "../../core/jupyter/jupyter-embed.ts";
import {
  projectIsWebsite,
  projectOutputDir,
} from "../../project/project-shared.ts";
import { NotebookContext } from "../../render/notebook/notebook-types.ts";
import { setExecuteEnvironment } from "../../execute/environment.ts";
import { safeCloneDeep } from "../../core/safe-clone-deep.ts";
import { warn } from "log";

export async function renderExecute(
  context: RenderContext,
  output: string,
  options: RenderExecuteOptions,
): Promise<ExecuteResult> {
  // are we running a compatible quarto version for this file?
  const versionConstraint = context
    .format.metadata[kQuartoRequired] as (string | undefined);
  if (versionConstraint) {
    const ourVersion = quartoConfig.version();
    let result: boolean;
    try {
      result = satisfies(ourVersion, versionConstraint);
    } catch (_e) {
      throw new Error(
        `In file ${context.target.source}:\nVersion constraint is invalid: ${versionConstraint}.`,
      );
    }
    if (!result) {
      throw new Error(
        `in file ${context.target.source}:\nQuarto version ${ourVersion} does not satisfy version constraint ${versionConstraint}.`,
      );
    }
  }

  // alias options
  const { resolveDependencies = true, alwaysExecute = false } = options;

  // alias flags
  const flags = context.options.flags || {};

  // compute filesDir
  const filesDir = inputFilesDir(context.target.source);

  // compute project relative files dir (if we are in a project)
  let projRelativeFilesDir: string | undefined;
  if (context.project) {
    const inputDir = relative(
      context.project.dir,
      dirname(context.target.source),
    );
    projRelativeFilesDir = join(inputDir, filesDir);
  }

  // are we eligible to freeze?
  const canFreeze = context.engine.canFreeze &&
    (context.format.execute[kExecuteEnabled] !== false);

  // use previous frozen results if they are available
  if (context.project && !context.project.isSingleFile && !alwaysExecute) {
    // check if we are using the freezer

    const thaw = canFreeze &&
      (context.format.execute[kFreeze] ||
        (context.options.useFreezer ? "auto" : false));

    if (thaw) {
      // copy from project freezer
      const hidden = context.format.execute[kFreeze] === false;
      copyFromProjectFreezer(
        context.project,
        projRelativeFilesDir!,
        hidden,
      );

      const thawedResult = defrostExecuteResult(
        context.target.source,
        output,
        context.options.services.temp,
        thaw === true,
      );
      if (thawedResult) {
        // copy the site_libs dir from the freezer
        const libDir = context.project?.config?.project[kProjectLibDir];
        if (libDir) {
          copyFromProjectFreezer(context.project, libDir, hidden);
        }

        // remove the results dir
        removeFreezeResults(join(context.project.dir, projRelativeFilesDir!));

        // notify engine that we skipped execute
        if (context.engine.executeTargetSkipped) {
          context.engine.executeTargetSkipped(
            context.target,
            context.format,
            context.project,
          );
        }

        // return results
        return thawedResult;
      }
    }
  }

  // calculate figsDir
  const figsDir = join(filesDir, figuresDir(context.format.pandoc.to));

  pushTiming("render-execute");

  const executeOptions: ExecuteOptions = {
    target: context.target,
    resourceDir: resourcePath(),
    tempDir: context.options.services.temp.createDir(),
    dependencies: resolveDependencies,
    libDir: context.libDir,
    format: context.format,
    projectDir: context.project?.dir,
    cwd: flags.executeDir || dirname(normalizePath(context.target.source)),
    params: resolveParams(flags.params, flags.paramsFile),
    quiet: flags.quiet,
    previewServer: context.options.previewServer,
    handledLanguages: languages(),
    project: context.project,
  };
  // execute computations
  setExecuteEnvironment(executeOptions);
  const executeResult = await context.engine.execute(executeOptions);
  popTiming();

  // write the freeze file if we are in a project
  if (context.project && !context.project.isSingleFile && canFreeze) {
    // write the freezer file
    const freezeFile = freezeExecuteResult(
      context.target.source,
      output,
      executeResult,
    );

    // always copy to the hidden freezer
    copyToProjectFreezer(context.project, projRelativeFilesDir!, true, true);

    // copy to the _freeze dir if explicit _freeze is requested
    if (context.format.execute[kFreeze] !== false) {
      copyToProjectFreezer(context.project, projRelativeFilesDir!, false, true);
    } else {
      // otherwise cleanup the _freeze subdir b/c we aren't explicitly freezing anymore

      // figs dir for this target format
      const freezeFigsDir = freezerFigsDir(
        context.project,
        projRelativeFilesDir!,
        basename(figsDir),
      );
      removeIfExists(freezeFigsDir);

      // freezer file
      const projRelativeFreezeFile = relative(context.project.dir, freezeFile);
      const freezerFile = freezerFreezeFile(
        context.project,
        projRelativeFreezeFile,
      );
      removeIfExists(freezerFile);

      // remove empty directories
      removeIfEmptyDir(dirname(freezerFile));
      removeIfEmptyDir(dirname(freezeFigsDir));
      removeIfEmptyDir(join(context.project.dir, kProjectFreezeDir));
    }

    // remove the freeze results file (now that it's safely in the freezer)
    removeFreezeResults(join(context.project.dir, projRelativeFilesDir!));
  }

  // return result
  return executeResult;
}

export async function renderFiles(
  files: RenderFile[],
  options: RenderOptions,
  notebookContext: NotebookContext,
  alwaysExecuteFiles: string[] | undefined,
  pandocRenderer: PandocRenderer | undefined,
  project: ProjectContext,
): Promise<RenderFilesResult> {
  // provide default renderer
  pandocRenderer = pandocRenderer || defaultPandocRenderer(options, project);

  // create temp context
  const tempContext = createTempContext();

  try {
    // make a copy of options so we don't mutate caller context
    options = ld.cloneDeep(options);

    // see if we should be using file-by-file progress
    const progress = options.progress ||
      (project && (files.length > 1) && !options.flags?.quiet);

    // quiet pandoc output if we are doing file by file progress
    const pandocQuiet = !!progress || !!options.quietPandoc;

    // calculate num width
    const numWidth = String(files.length).length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (progress) {
        renderProgress(
          `\r[${String(i + 1).padStart(numWidth)}/${files.length}] ${
            relative(project!.dir, file.path)
          }`,
        );
      }

      // get contexts
      const fileLifetime = await waitUntilNamedLifetime("render-file");
      try {
        await renderFileInternal(
          fileLifetime,
          file,
          options,
          project,
          pandocRenderer,
          files,
          tempContext,
          alwaysExecuteFiles,
          pandocQuiet,
          notebookContext,
        );
      } finally {
        fileLifetime.cleanup();
      }
    }

    if (progress) {
      info("");
    }

    return await pandocRenderer.onComplete(false, options.flags?.quiet);
  } catch (error) {
    if (!(error instanceof Error)) {
      warn("Should not have arrived here:", error);
      throw error;
    }
    return {
      files: (await pandocRenderer.onComplete(true)).files,
      error: error || new Error(),
    };
  } finally {
    tempContext.cleanup();
    if (Deno.env.get("QUARTO_PROFILER_OUTPUT")) {
      Deno.writeTextFileSync(
        Deno.env.get("QUARTO_PROFILER_OUTPUT")!,
        JSON.stringify(getTimingData()),
      );
    }
  }
}

export async function renderFile(
  file: RenderFile,
  options: RenderOptions,
  services: RenderServices,
  project: ProjectContext,
  enforceProjectFormats: boolean = true,
): Promise<RenderFilesResult> {
  // provide default renderer
  const pandocRenderer = defaultPandocRenderer(options, project);

  try {
    // make a copy of options so we don't mutate caller context
    options = ld.cloneDeep(options);

    // quiet pandoc output if we are doing file by file progress
    const pandocQuiet = !!options.quietPandoc;

    // get contexts
    const fileLifetime = createNamedLifetime("render-single-file");
    try {
      await renderFileInternal(
        fileLifetime,
        file,
        options,
        project,
        pandocRenderer,
        [file],
        services.temp,
        [],
        pandocQuiet,
        services.notebook,
        enforceProjectFormats,
      );
    } finally {
      fileLifetime.cleanup();
    }
    return await pandocRenderer.onComplete(false, options.flags?.quiet);
  } catch (error) {
    if (!(error instanceof Error)) {
      warn("Should not have arrived here:", error);
      throw error;
    }
    return {
      files: (await pandocRenderer.onComplete(true)).files,
      error: error || new Error(),
    };
  } finally {
    if (Deno.env.get("QUARTO_PROFILER_OUTPUT")) {
      Deno.writeTextFileSync(
        Deno.env.get("QUARTO_PROFILER_OUTPUT")!,
        JSON.stringify(getTimingData()),
      );
    }
  }
}

async function renderFileInternal(
  lifetime: Lifetime,
  file: RenderFile,
  options: RenderOptions,
  project: ProjectContext,
  pandocRenderer: PandocRenderer,
  files: RenderFile[],
  tempContext: TempContext,
  alwaysExecuteFiles: string[] | undefined,
  pandocQuiet: boolean,
  notebookContext: NotebookContext,
  enforceProjectFormats: boolean = true,
) {
  const outputs: Array<RenderedFormat> = [];
  let contexts: Record<string, RenderContext> | undefined;
  try {
    contexts = await renderContexts(
      file,
      options,
      true,
      notebookContext,
      project,
      false,
      enforceProjectFormats,
    );

    // Allow renderers to filter the contexts
    contexts = pandocRenderer.onFilterContexts(
      file.path,
      contexts,
      files,
      options,
    );
  } catch (e) {
    // bad YAML can cause failure before validation. We
    // reconstruct the context as best we can and try to validate.
    // note that this ignores "validate-yaml: false"
    const { engine, target } = await fileExecutionEngineAndTarget(
      file.path,
      options.flags,
      project,
    );
    const validationResult = await validateDocumentFromSource(
      target.markdown,
      engine.name,
      error,
    );
    if (validationResult.length) {
      throw new RenderInvalidYAMLError();
    } else {
      // rethrow if no validation error happened.
      throw e;
    }
  }
  const mergeHandlerResults = (
    results: HandlerContextResults | undefined,
    executeResult: MappedExecuteResult,
    context: RenderContext,
  ) => {
    if (results === undefined) {
      return;
    }
    if (executeResult.includes) {
      executeResult.includes = mergeConfigs(
        executeResult.includes,
        results.includes,
      );
    } else {
      executeResult.includes = results.includes;
    }
    const extras = resolveDependencies(
      results.extras,
      dirname(context.target.source),
      context.libDir,
      tempContext,
      project,
    );
    if (extras[kIncludeInHeader]) {
      // note that we merge engine execute results back into cell handler
      // execute results so that jupyter widget dependencies appear at the
      // end (so that they don't mess w/ other libs using require/define)
      executeResult.includes[kIncludeInHeader] = [
        ...(extras[kIncludeInHeader] || []),
        ...(executeResult.includes[kIncludeInHeader] || []),
      ];
    }
    executeResult.supporting.push(...results.supporting);
  };

  for (const format of Object.keys(contexts)) {
    pushTiming("render-context");
    const context = safeCloneDeep(contexts[format]); // since we're going to mutate it...

    // disquality some documents from server: shiny
    if (isServerShiny(context.format) && context.project) {
      const src = relative(context.project?.dir!, context.target.source);
      if (projectIsWebsite(context.project)) {
        error(
          `${src} uses server: shiny so cannot be included in a website project ` +
            `(shiny documents require a backend server and so can't be published as static web content).`,
        );
        throw new Error();
      } else if (
        (projectOutputDir(context.project) !==
          normalizePath(context.project.dir)) &&
        isServerShinyKnitr(context.format, context.engine.name)
      ) {
        error(
          `${src} is a knitr engine document that uses server: shiny so cannot be included in a project with an output-dir ` +
            `(shiny document output must be rendered alongside its source document).`,
        );
        throw new Error();
      }
    }

    // get output recipe
    const recipe = outputRecipe(context);
    outputs.push({
      path: recipe.finalOutput || recipe.output,
      isTransient: recipe.isOutputTransient,
      format: context.format,
    });

    if (context.active) {
      // Set the date locale for this render
      // Used for date formatting
      initDayJsPlugins();
      const resolveLang = () => {
        const lang = context.format.metadata[kLang] ||
          options.flags?.pandocMetadata?.[kLang];
        if (typeof lang === "string") {
          return lang;
        } else {
          return undefined;
        }
      };
      const dateFormatLang = resolveLang();
      if (dateFormatLang) {
        await setDateLocale(
          dateFormatLang,
        );
      }

      lifetime.attach({
        cleanup() {
          resetFigureCounter();
        },
      });
      try {
        // one time denoDom init for html compatible formats
        if (isHtmlCompatible(context.format)) {
          await initDenoDom();
        }

        // determine execute options
        const executeOptions = mergeConfigs(
          {
            alwaysExecute: alwaysExecuteFiles?.includes(file.path),
          },
          pandocRenderer.onBeforeExecute(recipe.format),
        );

        const validate = context.format.render?.["validate-yaml"];
        if (validate !== false) {
          const validationResult = await validateDocument(context);
          if (validationResult.length) {
            throw new RenderInvalidYAMLError();
          }
        }

        // FIXME it should be possible to infer this directly now
        // based on the information in the mapped strings.
        //
        // collect line numbers to facilitate runtime error reporting
        const { ojsBlockLineNumbers } = annotateOjsLineNumbers(context);

        // execute
        const baseExecuteResult = await renderExecute(
          context,
          recipe.output,
          executeOptions,
        );

        // recover source map from diff and create a mappedExecuteResult
        // for markdown processing pre-pandoc with mapped strings
        let mappedMarkdown: MappedString;

        withTiming("diff-execute-result", () => {
          if (!isJupyterNotebook(context.target.source)) {
            mappedMarkdown = mappedDiff(
              context.target.markdown,
              baseExecuteResult.markdown,
            );
          } else {
            mappedMarkdown = asMappedString(baseExecuteResult.markdown);
          }
        });

        const resourceFiles: string[] = [];
        if (baseExecuteResult.resourceFiles) {
          resourceFiles.push(...baseExecuteResult.resourceFiles);
        }

        const languageCellHandlerOptions: LanguageCellHandlerOptions = {
          name: "",
          temp: tempContext,
          format: recipe.format,
          markdown: mappedMarkdown!,
          context,
          flags: options.flags || {} as RenderFlags,
          stage: "post-engine",
        };

        let unmappedExecuteResult: ExecuteResult;
        await withTimingAsync("handle-language-cells", async () => {
          // handle language cells
          const { markdown, results } = await handleLanguageCells(
            languageCellHandlerOptions,
          );
          const mappedExecuteResult: MappedExecuteResult = {
            ...baseExecuteResult,
            markdown,
          };

          mergeHandlerResults(
            context.target.preEngineExecuteResults,
            mappedExecuteResult,
            context,
          );
          mergeHandlerResults(results, mappedExecuteResult, context);

          // process ojs
          const { executeResult, resourceFiles: ojsResourceFiles } =
            await ojsExecuteResult(
              context,
              mappedExecuteResult,
              ojsBlockLineNumbers,
            );
          resourceFiles.push(...ojsResourceFiles);

          // keep md if requested
          const keepMd = executionEngineKeepMd(context);
          if (keepMd && context.format.execute[kKeepMd]) {
            Deno.writeTextFileSync(keepMd, executeResult.markdown.value);
          }

          // now get "unmapped" execute result back to send to pandoc
          unmappedExecuteResult = {
            ...executeResult,
            markdown: executeResult.markdown.value,
          };
        });

        // Ensure that we have rendered any notebooks
        await ensureNotebookContext(
          unmappedExecuteResult!.markdown,
          context.options.services,
          project,
        );

        // callback
        pushTiming("render-pandoc");
        await pandocRenderer.onRender(format, {
          context,
          recipe,
          executeResult: unmappedExecuteResult!,
          resourceFiles,
        }, pandocQuiet);
        popTiming();
      } finally {
        popTiming();
      }
    }
  }
  await pandocRenderer.onPostProcess(outputs, project);
}

// default pandoc renderer immediately renders each execute result
function defaultPandocRenderer(
  _options: RenderOptions,
  _project: ProjectContext,
): PandocRenderer {
  const renderCompletions: PandocRenderCompletion[] = [];
  const renderedFiles: RenderedFile[] = [];

  return {
    onFilterContexts: (
      _file: string,
      contexts: Record<string, RenderContext>,
      _files: RenderFile[],
      _options: RenderOptions,
    ) => {
      return contexts;
    },
    onBeforeExecute: (_format: Format) => ({}),
    onRender: async (
      _format: string,
      executedFile: ExecutedFile,
      quiet: boolean,
    ) => {
      renderCompletions.push(await renderPandoc(executedFile, quiet));
    },
    onPostProcess: async (renderedFormats: RenderedFormat[]) => {
      let completion = renderCompletions.pop();
      while (completion) {
        renderedFiles.push(await completion.complete(renderedFormats));
        completion = renderCompletions.pop();
      }
      renderedFiles.reverse();
    },
    onComplete: async () => {
      return {
        files: await Promise.resolve(renderedFiles),
      };
    },
  };
}
class RenderInvalidYAMLError extends YAMLValidationError {
  constructor() {
    super("Render failed due to invalid YAML.");
  }
}
