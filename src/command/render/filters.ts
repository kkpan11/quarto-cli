/*
 * filters.ts
 *
 * Copyright (C) 2020-2022 Posit Software, PBC
 */

import { existsSync } from "../../deno_ral/fs.ts";

import {
  kBibliography,
  kBrand,
  kBrandMode,
  kCitationLocation,
  kCiteMethod,
  kClearCellOptions,
  kClearHiddenClasses,
  kCodeFold,
  kCodeLineNumbers,
  kCodeSummary,
  kCssPropertyProcessing,
  kEnableCrossRef,
  kFigAlign,
  kFigEnv,
  kFigPos,
  kFigResponsive,
  kFormatIdentifier,
  kHeaderIncludes,
  kHtmlMathMethod,
  kHtmlPreTagProcessing,
  kHtmlTableProcessing,
  kIncludeAfter,
  kIncludeAfterBody,
  kIncludeBefore,
  kIncludeBeforeBody,
  kIncludeInHeader,
  kIpynbProduceSourceNotebook,
  kIPynbTitleBlockTemplate,
  kJatsSubarticleId,
  kKeepHidden,
  kLogo,
  kMergeIncludes,
  kOutputDivs,
  kOutputLocation,
  kPdfEngine,
  kQuartoFilters,
  kQuartoPost,
  kQuartoPre,
  kReferenceLocation,
  kReferences,
  kRemoveHidden,
  kResourcePath,
  kShortcodes,
  kTblColwidths,
  kTocTitleDocument,
  kUnrollMarkdownCells,
  kUseRsvgConvert,
} from "../../config/constants.ts";
import { PandocOptions } from "./types.ts";
import {
  Format,
  FormatPandoc,
  isFilterEntryPoint,
  QuartoFilter,
  QuartoFilterEntryPoint,
} from "../../config/types.ts";
import { QuartoFilterSpec } from "./types.ts";
import { Metadata } from "../../config/types.ts";
import { kProjectType } from "../../project/types.ts";
import { bibEngine } from "../../config/pdf.ts";
import { rBinaryPath, resourcePath } from "../../core/resources.ts";
import { crossrefFilterActive, crossrefFilterParams } from "./crossref.ts";
import { layoutFilterParams } from "./layout.ts";
import { pandocMetadataPath } from "./render-paths.ts";
import { removePandocArgs } from "./flags.ts";
import { mergeConfigs } from "../../core/config.ts";
import { projectType } from "../../project/types/project-types.ts";
import { readCodePage } from "../../core/windows.ts";
import { formatHasBootstrap } from "../../format/html/format-html-info.ts";
import { activeProfiles, kQuartoProfile } from "../../quarto-core/profile.ts";
import {
  filterBuiltInExtensions,
  filterExtensions,
} from "../../extension/extension.ts";
import { quartoConfig } from "../../core/quarto.ts";
import { metadataNormalizationFilterActive } from "./normalize.ts";
import { kCodeAnnotations } from "../../format/html/format-html-shared.ts";
import { projectOutputDir } from "../../project/project-shared.ts";
import { relative } from "../../deno_ral/path.ts";
import { citeIndexFilterParams } from "../../project/project-cites.ts";
import { debug } from "../../deno_ral/log.ts";
import { kJatsSubarticle } from "../../format/jats/format-jats-types.ts";
import { shortUuid } from "../../core/uuid.ts";
import { isServerShinyPython } from "../../core/render.ts";
import { pythonExec } from "../../core/jupyter/exec.ts";
import { kTocIndent } from "../../config/constants.ts";
import { isWindows } from "../../deno_ral/platform.ts";
import { tinyTexBinDir } from "../../tools/impl/tinytex-info.ts";

const kQuartoParams = "quarto-params";

const kProjectOffset = "project-offset";
const kFilterProjectOutputDir = "project-output-dir";

const kMediabagDir = "mediabag-dir";

const kResultsFile = "results-file";

const kHasBootstrap = "has-bootstrap";

const kActiveFilters = "active-filters";

const kQuartoVersion = "quarto-version";

const kQuartoCliPath = "quarto-cli-path";

const kQuartoSource = "quarto-source";

const kHasResourcePath = "has-resource-path";

const kQuartoCustomFormat = "quarto-custom-format";

const kIsShinyPython = "is-shiny-python";
const kShinyPythonExec = "shiny-python-exec";

const kExecutionEngine = "execution-engine";

export async function filterParamsJson(
  args: string[],
  options: PandocOptions,
  defaults: FormatPandoc | undefined,
  filterParams: Record<string, unknown>,
  resultsFile: string,
  dependenciesFile: string,
): Promise<Record<string, unknown>> {
  // extract include params (possibly mutating it's arguments)
  const includes = options.format.render[kMergeIncludes] !== false
    ? extractIncludeParams(
      args,
      options.format.metadata,
      defaults || {},
    )
    : {};

  // extract the filter spec from pandoc options
  const filterSpec = extractFilterSpecParams(
    options.format.metadata,
  );

  // Extract any column params
  const quartoColumnParams = extractColumnParams(
    args,
    options.format.metadata,
    defaults,
  );

  const customFormatParams = extractCustomFormatParams(
    options.format.metadata,
  );

  const isShinyPython = isServerShinyPython(
    options.format,
    options.executionEngine,
  );

  const typstFilterParams = extractTypstFilterParams(
    options.format,
  );

  const params: Metadata = {
    ...includes,
    ...initFilterParams(dependenciesFile),
    ...ipynbFilterParams(options),
    ...await projectFilterParams(options),
    ...quartoColumnParams,
    ...await quartoFilterParams(options, defaults),
    ...crossrefFilterParams(options, defaults),
    ...citeIndexFilterParams(options, defaults),
    ...layoutFilterParams(options.format, defaults),
    ...languageFilterParams(options.format),
    ...jatsFilterParams(options),
    ...notebookContextFilterParams(options),
    ...filterParams,
    ...customFormatParams,
    ...typstFilterParams,
    [kResultsFile]: pandocMetadataPath(resultsFile),
    [kQuartoFilters]: filterSpec,
    [kActiveFilters]: {
      normalization: metadataNormalizationFilterActive(options),
      crossref: crossrefFilterActive(options),
      jats_subarticle: options.format.metadata[kJatsSubarticle],
    },
    [kFormatIdentifier]: options.format.identifier,
    [kIsShinyPython]: isShinyPython,
    [kShinyPythonExec]: isShinyPython ? await pythonExec() : undefined,
    [kExecutionEngine]: options.executionEngine,
    [kBrand]: options.format.render[kBrand],
    "quarto-environment": await quartoEnvironmentParams(options),
  };
  return params;
}

async function quartoEnvironmentParams(_options: PandocOptions) {
  return {
    "paths": {
      "Rscript": await rBinaryPath("Rscript"),
      "TinyTexBinDir": tinyTexBinDir(), // will be undefined if no tinytex found and quarto will look in PATH
    },
  };
}

export function removeFilterParams(metadata: Metadata) {
  delete metadata[kQuartoParams];
}

export function quartoMainFilter() {
  return resourcePath("filters/main.lua");
}

function extractCustomFormatParams(
  metadata: Metadata,
) {
  // pull out custom format spec if provided
  const customFormatParams = metadata[kQuartoCustomFormat];
  if (customFormatParams) {
    delete metadata[kQuartoCustomFormat];
    return {
      [kQuartoCustomFormat]: customFormatParams,
    };
  } else {
    return {};
  }
}

function extractFilterSpecParams(
  metadata: Metadata,
) {
  // pull out the filter spec that resolveFilters created
  const filterSpec = metadata[kQuartoFilters];
  delete metadata[kQuartoFilters];
  return filterSpec;
}

function extractIncludeParams(
  args: string[],
  metadata: Metadata,
  defaults: FormatPandoc,
) {
  // pull out string based includes
  const includes = mergeConfigs(
    extractSmartIncludeText(metadata),
    extractSmartIncludeText((defaults as Record<string, unknown>) || {}),
    extractSmartIncludeText(defaults.variables || {}),
    extractIncludeVariables(metadata),
    extractIncludeVariables(defaults.variables || {}),
  );
  if (defaults.variables && Object.keys(defaults.variables).length === 0) {
    delete defaults.variables;
  }

  // pull out file based includes
  const inHeaderFiles: string[] = [];
  const beforeBodyFiles: string[] = [];
  const afterBodyFiles: string[] = [];

  const smartMetadataFiles = extractSmartIncludeFile(metadata);
  const smartDefaultsFiles = extractSmartIncludeFile(
    (defaults as Record<string, unknown>) || {},
  );
  const smartDefaultsVariablesFiles = extractSmartIncludeFile(
    defaults.variables || {},
  );

  inHeaderFiles.push(...(defaults[kIncludeInHeader] || []));
  beforeBodyFiles.push(...(defaults[kIncludeBeforeBody] || []));
  afterBodyFiles.push(...(defaults[kIncludeAfterBody] || []));

  inHeaderFiles.push(...smartMetadataFiles[kIncludeInHeader]);
  beforeBodyFiles.push(...smartMetadataFiles[kIncludeBeforeBody]);
  afterBodyFiles.push(...smartMetadataFiles[kIncludeAfterBody]);

  inHeaderFiles.push(...smartDefaultsFiles[kIncludeInHeader]);
  beforeBodyFiles.push(...smartDefaultsFiles[kIncludeBeforeBody]);
  afterBodyFiles.push(...smartDefaultsFiles[kIncludeAfterBody]);

  inHeaderFiles.push(...smartDefaultsVariablesFiles[kIncludeInHeader]);
  beforeBodyFiles.push(...smartDefaultsVariablesFiles[kIncludeBeforeBody]);
  afterBodyFiles.push(...smartDefaultsVariablesFiles[kIncludeAfterBody]);

  // erase from format/options
  delete defaults[kIncludeInHeader];
  delete defaults[kIncludeAfterBody];
  delete defaults[kIncludeBeforeBody];

  // pull includes out of args
  for (const arg in args) {
    switch (arg) {
      case kIncludeInHeader:
        inHeaderFiles.push(arg);
        break;
      case kIncludeBeforeBody:
        beforeBodyFiles.push(arg);
        break;
      case kIncludeAfterBody:
        afterBodyFiles.push(arg);
        break;
    }
  }

  // remove includs from args
  const removeArgs = new Map<string, boolean>();
  removeArgs.set(kIncludeInHeader, true);
  removeArgs.set(kIncludeBeforeBody, true);
  removeArgs.set(kIncludeAfterBody, true);
  removePandocArgsInPlace(args, removeArgs);
  const result = {
    ...includes,
    [kIncludeInHeader]: inHeaderFiles.map(pandocMetadataPath),
    [kIncludeBeforeBody]: beforeBodyFiles.map(pandocMetadataPath),
    [kIncludeAfterBody]: afterBodyFiles.map(pandocMetadataPath),
  };
  return result;
}

function extractSmartIncludeText(
  obj: { [key: string]: unknown },
): {
  [kHeaderIncludes]: string[];
  [kIncludeBefore]: string[];
  [kIncludeAfter]: string[];
} {
  return extractSmartIncludeInternal(obj, "text");
}

function extractSmartIncludeFile(
  obj: { [key: string]: unknown },
): {
  [kIncludeInHeader]: string[];
  [kIncludeBeforeBody]: string[];
  [kIncludeAfterBody]: string[];
} {
  const inner = extractSmartIncludeInternal(obj, "file");

  return {
    [kIncludeInHeader]: inner[kHeaderIncludes],
    [kIncludeBeforeBody]: inner[kIncludeBefore],
    [kIncludeAfterBody]: inner[kIncludeAfter],
  };
}

function extractSmartIncludeInternal(
  obj: { [key: string]: unknown },
  key: string,
): {
  [kHeaderIncludes]: string[];
  [kIncludeBefore]: string[];
  [kIncludeAfter]: string[];
} {
  const isContent = (v: unknown) => {
    if (typeof v !== "object") {
      return false;
    }
    return typeof ((v as Record<string, unknown>)[key]) === "string";
  };
  const extractVariable = (name: string): string[] => {
    const value = obj[name];
    if (value === undefined) {
      return [];
    }
    if (Array.isArray(value)) {
      const contents = value.filter(isContent);
      const nonContents = value.filter((v) => !isContent(v));
      obj[name] = nonContents;
      return contents.map((v) => v[key]);
    } else if (isContent(value)) {
      delete obj[name];
      // deno-lint-ignore no-explicit-any
      return [(value as any)[key]];
    } else {
      return [];
    }
  };

  return {
    [kHeaderIncludes]: extractVariable(kIncludeInHeader),
    [kIncludeBefore]: extractVariable(kIncludeBeforeBody),
    [kIncludeAfter]: extractVariable(kIncludeAfterBody),
  };
}

function extractIncludeVariables(obj: { [key: string]: unknown }) {
  const extractVariable = (name: string): unknown[] => {
    const value = obj[name];
    delete obj[name];
    if (!value) {
      return [];
    } else if (Array.isArray(value)) {
      return value as unknown[];
    } else {
      return [value];
    }
  };

  return {
    [kHeaderIncludes]: extractVariable(kHeaderIncludes),
    [kIncludeBefore]: extractVariable(kIncludeBefore),
    [kIncludeAfter]: extractVariable(kIncludeAfter),
  };
}

export function extractColumnParams(
  args: string[],
  metadata: Metadata,
  defaults?: FormatPandoc,
) {
  const quartoColumnParams: Metadata = {};
  if (
    defaults?.[kReferenceLocation] === "margin" ||
    referenceLocationArg(args) === "margin"
  ) {
    // Forward the values to our params
    quartoColumnParams[kReferenceLocation] = "margin";

    // Remove from flags
    const removeArgs = new Map<string, boolean>();
    removeArgs.set(`--${kReferenceLocation}`, true);
    removePandocArgsInPlace(args, removeArgs);
    // Remove from pandoc defaults
    if (defaults) {
      delete defaults[kReferenceLocation];
    }
  }
  // Forward citation location
  if (metadata[kCitationLocation]) {
    quartoColumnParams[kCitationLocation] = metadata[kCitationLocation];
  }

  return quartoColumnParams;
}

function removePandocArgsInPlace(
  args: string[],
  removeArgs: Map<string, boolean>,
) {
  const cleanedArgs = removePandocArgs(args, removeArgs);
  if (cleanedArgs.length !== args.length) {
    args.splice(0, args.length);
    args.push(...cleanedArgs);
  }
}

function referenceLocationArg(args: string[]) {
  const argIndex = args.findIndex((arg) => {
    return arg === `--${kReferenceLocation}`;
  });
  if (argIndex > -1 && args.length > argIndex + 1) {
    const referenceLocation = args[argIndex + 1];
    return referenceLocation;
  } else {
    return undefined;
  }
}

function languageFilterParams(format: Format) {
  const language = format.language;
  const params: Metadata = {
    [kCodeSummary]: format.metadata[kCodeSummary] || language[kCodeSummary],
    [kTocTitleDocument]: language[kTocTitleDocument],
  };
  // default prefixes based on titles
  [
    "fig",
    "tbl",
    "lst",
    "thm",
    "lem",
    "cor",
    "prp",
    "cnj",
    "def",
    "exm",
    "exr",
  ].forEach((type) => {
    params[`crossref-${type}-prefix`] = language[`crossref-${type}-title`];
  });
  Object.keys(language).forEach((key) => {
    if (
      key.startsWith("callout-") || key.startsWith("crossref-") ||
      key.startsWith("environment-")
    ) {
      params[key] = language[key];
    }
  });
  return params;
}

async function projectFilterParams(options: PandocOptions) {
  // see if the project wants to provide any filter params
  const projType = projectType(
    options.project?.config?.project?.[kProjectType],
  );
  const params =
    ((projType.filterParams
      ? await projType.filterParams(options)
      : undefined) ||
      {}) as Metadata;

  const additionalParams: Metadata = {};

  if (options.project) {
    const absProjectOutputDir = projectOutputDir(options.project);
    const outputDir = relative(options.project.dir, absProjectOutputDir);
    if (outputDir) {
      additionalParams[kFilterProjectOutputDir] = outputDir;
    }
  }
  if (options.offset) {
    additionalParams[kProjectOffset] = options.offset;
  }

  return {
    ...additionalParams,
    ...params,
  };
}

function ipynbFilterParams(options: PandocOptions) {
  const params: Record<string, unknown> = {
    [kIPynbTitleBlockTemplate]:
      options.format.metadata[kIPynbTitleBlockTemplate],
  };
  if (options.format.render[kIpynbProduceSourceNotebook]) {
    params[kEnableCrossRef] = false;
    params[kIpynbProduceSourceNotebook] = true;
  }

  return params;
}

function jatsFilterParams(options: PandocOptions) {
  if (options.format.metadata[kJatsSubarticle]) {
    return {
      [kJatsSubarticleId]: options.format.metadata[kJatsSubarticleId] ||
        shortUuid(),
    };
  } else {
    return {};
  }
}

function notebookContextFilterParams(options: PandocOptions) {
  const nbContext = options.services.notebook;
  const notebooks = nbContext.all(options.project);
  if (notebooks.length > 0) {
    return {
      "notebook-context": notebooks,
    };
  }
}

async function quartoFilterParams(
  options: PandocOptions,
  defaults?: FormatPandoc,
) {
  const format = options.format;
  const params: Metadata = {
    [kOutputDivs]: format.render[kOutputDivs],
  };

  params[kMediabagDir] = options.mediabagDir;

  const figAlign = format.render[kFigAlign];
  if (figAlign) {
    params[kFigAlign] = figAlign;
  }
  const figPos = format.render[kFigPos];
  if (figPos) {
    params[kFigPos] = figPos;
  }
  const figEnv = format.render[kFigEnv];
  if (figEnv) {
    params[kFigEnv] = figEnv;
  }
  const foldCode = format.render[kCodeFold];
  if (foldCode) {
    params[kCodeFold] = foldCode;
  }
  const htmlTableProcessing = format.render[kHtmlTableProcessing];
  if (htmlTableProcessing) {
    params[kHtmlTableProcessing] = htmlTableProcessing;
  }
  const useRsvgConvert = format.render[kUseRsvgConvert];
  if (useRsvgConvert !== undefined) {
    params[kUseRsvgConvert] = useRsvgConvert;
  }

  const tblColwidths = format.render[kTblColwidths];
  if (tblColwidths !== undefined) {
    params[kTblColwidths] = tblColwidths;
  }
  const shortcodes = format.render[kShortcodes];
  if (shortcodes !== undefined) {
    params[kShortcodes] = shortcodes;
  }
  const extShortcodes = await extensionShortcodes(options);
  if (extShortcodes) {
    params[kShortcodes] = params[kShortcodes] || [];
    (params[kShortcodes] as string[]).push(...extShortcodes);
  }
  params[kHtmlMathMethod] = defaults?.[kHtmlMathMethod];

  const figResponsive = format.metadata[kFigResponsive] === true;
  if (figResponsive) {
    params[kFigResponsive] = figResponsive;
  }

  const outputLocation = format.metadata[kOutputLocation];
  if (outputLocation) {
    params[kOutputLocation] = outputLocation;
  }

  const lineNumbers = format.render[kCodeLineNumbers];
  if (lineNumbers) {
    params[kCodeLineNumbers] = lineNumbers;
  }
  const keepHidden = format.render[kKeepHidden];
  if (keepHidden) {
    params[kKeepHidden] = kKeepHidden;
  }

  const removeHidden = format.metadata[kRemoveHidden];
  if (removeHidden) {
    params[kRemoveHidden] = removeHidden;
  }

  const clearHiddenClasses = format.metadata[kClearHiddenClasses];
  if (clearHiddenClasses) {
    params[kClearHiddenClasses] = clearHiddenClasses;
  }

  const unrollMarkdownCells = format.metadata[kUnrollMarkdownCells];
  if (unrollMarkdownCells) {
    params[kUnrollMarkdownCells] = unrollMarkdownCells;
  }

  const clearCellOptions = format.render[kClearCellOptions];
  if (clearCellOptions) {
    params[kClearCellOptions] = clearCellOptions;
  }

  // Provide other params that may be useful to filters
  params[kCiteMethod] = citeMethod(options);
  params[kPdfEngine] = pdfEngine(options);
  params[kHasBootstrap] = formatHasBootstrap(options.format);

  // has resource params
  const hasResourcePath = options.format.pandoc[kResourcePath] !== undefined ||
    options.args.includes("--resource-path");
  params[kHasResourcePath] = hasResourcePath;

  // The source document
  params[kQuartoSource] = options.source;

  // profile as an array
  params[kQuartoProfile.toLowerCase()] = activeProfiles();

  // version
  params[kQuartoVersion] = quartoConfig.version();

  // cli path
  params[kQuartoCliPath] = quartoConfig.cliPath();

  // code-annotations
  params[kCodeAnnotations] = format.metadata[kCodeAnnotations];

  return params;
}

async function extensionShortcodes(options: PandocOptions) {
  const extensionShortcodes: string[] = [];
  if (options.services.extension) {
    const allExtensions = await options.services.extension?.extensions(
      options.source,
      options.project?.config,
      options.project?.dir,
    );

    const shortCodeExtensions = filterBuiltInExtensions(
      allExtensions.filter((ext) => {
        return !!ext.contributes.shortcodes;
      }),
    );

    shortCodeExtensions.forEach((extension) => {
      const shortcodes = extension.contributes.shortcodes || [];
      extensionShortcodes.push(...shortcodes);
    });
  }
  return extensionShortcodes;
}

function initFilterParams(dependenciesFile: string) {
  const params: Metadata = {};
  if (isWindows) {
    const value = readCodePage();
    if (value) {
      debug("Windows: Using code page " + value);
      Deno.env.set("QUARTO_WIN_CODEPAGE", value);
    }
  }
  Deno.env.set("QUARTO_FILTER_DEPENDENCY_FILE", dependenciesFile);
  return params;
}

const kQuartoFilterMarker = "quarto";
const kQuartoCiteProcMarker = "citeproc";

// NB: this mutates `pandoc.citeproc`
export async function resolveFilters(
  filters: QuartoFilter[],
  options: PandocOptions,
  pandoc: FormatPandoc,
): Promise<QuartoFilterSpec | undefined> {
  // build list of quarto filters

  // const beforeQuartoFilters: QuartoFilter[] = [];
  // const afterQuartoFilters: QuartoFilter[] = [];

  const quartoFilters: string[] = [];
  quartoFilters.push(quartoMainFilter());

  // Resolve any filters that are provided by an extension
  filters = await resolveFilterExtension(options, filters);
  let quartoLoc = filters.findIndex((filter) => filter === kQuartoFilterMarker);
  if (quartoLoc === -1) {
    quartoLoc = Infinity; // if no quarto marker, put our filters at the beginning
  }

  // if 'quarto' is in the filters, old-style filter declarations
  // before 'quarto' go to the kQuartoPre entry point, and old-style
  // filter declarations after 'quarto' go to the kQuartoPost entry point.
  //
  // if 'quarto' is not in the filter, all declarations go to the kQuartoPre entry point
  //
  // (note that citeproc will in all cases run last)
  const entryPoints: QuartoFilterEntryPoint[] = filters
    .filter((f) => f !== "quarto") // remove quarto marker
    .map((filter, i) => {
      if (isFilterEntryPoint(filter)) {
        return filter; // send entry-point-style filters unchanged
      }
      const at = quartoLoc > i ? kQuartoPre : kQuartoPost;
      const result: QuartoFilterEntryPoint = typeof filter === "string"
        ? {
          "at": at,
          "type": filter.endsWith(".lua") ? "lua" : "json",
          "path": filter,
        }
        : {
          "at": at,
          ...filter,
        };
      return result;
    });

  // citeproc at the very end so all other filters can interact with citations
  filters = filters.filter((filter) => filter !== kQuartoCiteProcMarker);
  const citeproc = citeMethod(options) === kQuartoCiteProcMarker;
  if (citeproc) {
    // If we're explicitely adding the citeproc filter, turn off
    // citeproc: true so it isn't run twice
    // See https://github.com/quarto-dev/quarto-cli/issues/2393
    if (pandoc.citeproc === true) {
      delete pandoc.citeproc;
    }

    quartoFilters.push(kQuartoCiteProcMarker);
  }

  // return filters
  if (
    [
      quartoFilters,
    ].some((x) => x.length)
  ) {
    // temporarily return empty before/after filters
    // until we refactor them out entirely.
    return {
      quartoFilters,
      beforeQuartoFilters: [],
      afterQuartoFilters: [],
      entryPoints,
    };
  } else {
    return undefined;
  }
}

type CiteMethod = "citeproc" | "natbib" | "biblatex";

function citeMethod(options: PandocOptions): CiteMethod | null {
  // no handler if no references
  const pandoc = options.format.pandoc;
  const metadata = options.format.metadata;

  // determine the engine, if provided
  const engine = bibEngine(options.format.pandoc, options.flags);

  // If the user is explicitly enabling citeproc: true, use this as the citemethod
  // even when there may be no bibliography (see
  // https://github.com/quarto-dev/quarto-cli/issues/2294 for an example of why)
  if (pandoc.citeproc) {
    // If both citeproc and a bib engine are specified, throw an error
    if (engine) {
      throw new Error(
        `The bibliography engine '${engine}' was set when 'citeproc' was also explicitly requested.`,
      );
    }

    return "citeproc";
  }

  // No bibliography or references, and no explicit request, so no engine specified
  if (!metadata[kBibliography] && !metadata[kReferences]) {
    return null;
  }

  // if it's pdf-based output check for natbib or biblatex
  if (engine) {
    return engine;
  }

  // otherwise it's citeproc unless expressly disabled
  if (pandoc.citeproc !== false) {
    return "citeproc";
  } else {
    return null;
  }
}

function pdfEngine(options: PandocOptions): string {
  const pdfEngine = options.flags?.pdfEngine ||
    options.format.pandoc?.[kPdfEngine] as string ||
    "pdflatex";
  return pdfEngine;
}

async function resolveFilterExtension(
  options: PandocOptions,
  filters: QuartoFilter[],
): Promise<QuartoFilter[]> {
  // Resolve any filters that are provided by an extension
  const results: (QuartoFilter | QuartoFilter[])[] = [];
  const getFilter = async (filter: QuartoFilter) => {
    // Look for extension names in the filter list and result them
    // into the filters provided by the extension
    if (
      filter !== kQuartoFilterMarker && filter !== kQuartoCiteProcMarker &&
      typeof filter === "string"
    ) {
      // The filter string points to an executable file which exists
      if (existsSync(filter) && !Deno.statSync(filter).isDirectory) {
        return filter;
      }

      const extensions = await options.services.extension?.find(
        filter,
        options.source,
        "filters",
        options.project?.config,
        options.project?.dir,
      ) || [];

      // Filter this list of extensions
      const filteredExtensions = filterExtensions(
        extensions || [],
        filter,
        "filter",
      );
      // Return any contributed plugins
      if (filteredExtensions.length > 0) {
        // This matches an extension, use the contributed filters
        const filters = extensions[0].contributes.filters;
        if (filters) {
          return filters;
        } else {
          return filter;
        }
      } else if (extensions.length > 0) {
        // There was a matching extension with this name, but
        // it was filtered out, just hide the filter altogether
        return [];
      } else {
        // There were no extensions matching this name, just allow it
        // through
        return filter;
      }
    } else {
      return filter;
    }
  };
  for (const filter of filters) {
    const r = await getFilter(filter);
    results.push(r);
  }
  return results.flat();
}

const extractTypstFilterParams = (format: Format) => {
  return {
    [kTocIndent]: format.metadata[kTocIndent],
    [kLogo]: format.metadata[kLogo],
    [kCssPropertyProcessing]: format.metadata[kCssPropertyProcessing],
    [kBrandMode]: format.metadata[kBrandMode],
    [kHtmlPreTagProcessing]: format.metadata[kHtmlPreTagProcessing],
  };
};
