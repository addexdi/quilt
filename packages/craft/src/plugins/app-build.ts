import type {GetModuleInfo, GetManualChunk} from 'rollup';
import {createProjectPlugin} from '@quilted/sewing-kit';
import type {App, WaterfallHookWithDefault} from '@quilted/sewing-kit';

import {getEntry} from './shared';

export interface AppBuildHooks {
  quiltAssetBaseUrl: WaterfallHookWithDefault<string>;
}

declare module '@quilted/sewing-kit' {
  interface BuildAppOptions {
    /**
     * Indicates that the base build is being generated by `quilt`.
     */
    quilt: boolean;
  }

  interface BuildAppConfigurationHooks extends AppBuildHooks {}
}

export const STEP_NAME = 'Quilt.App.Build';

export function appBuild({assetBaseUrl}: {assetBaseUrl: string}) {
  return createProjectPlugin<App>({
    name: STEP_NAME,
    build({project, workspace, hooks, configure, run}) {
      hooks<AppBuildHooks>(({waterfall}) => ({
        quiltAssetBaseUrl: waterfall({
          default: assetBaseUrl,
        }),
      }));

      configure(
        (
          {
            outputDirectory,
            rollupInput,
            rollupOutputs,
            quiltAsyncManifest,
            quiltAssetBaseUrl,
            quiltAsyncAssetBaseUrl,
          },
          options,
        ) => {
          if (!options.quilt) return;

          quiltAsyncAssetBaseUrl?.(() => quiltAssetBaseUrl!.run());

          quiltAsyncManifest?.(() =>
            workspace.fs.buildPath(
              workspace.apps.length > 1 ? `apps/${project.name}` : 'app',
              'manifests/manifest.json',
            ),
          );

          rollupInput?.(async (inputs) => {
            if (inputs.length > 0) return inputs;

            const entry = await getEntry(project);
            return [entry];
          });

          rollupOutputs?.(async (outputs) => [
            ...outputs,
            {
              format: 'esm',
              entryFileNames: `app.[hash].js`,
              assetFileNames: `[name].[hash].[ext]`,
              chunkFileNames: `[name].[hash].js`,
              manualChunks: createManualChunksSorter(),
              dir: await outputDirectory.run(
                workspace.fs.buildPath(
                  workspace.apps.length > 1 ? `apps/${project.name}` : 'app',
                  'assets',
                ),
              ),
            },
          ]);
        },
      );

      run((step, {configuration}) =>
        step({
          name: STEP_NAME,
          label: `Build app ${project.name}`,
          async run() {
            const [configure, {buildWithRollup}] = await Promise.all([
              configuration({quilt: true, quiltBrowserEntry: true}),
              import('@quilted/sewing-kit-rollup'),
            ]);

            await buildWithRollup(configure);
          },
        }),
      );
    },
  });
}

const FRAMEWORK_CHUNK_NAME = 'framework';
const VENDOR_CHUNK_NAME = 'vendor';
const FRAMEWORK_TEST_STRINGS = [
  '/node_modules/preact/',
  '/node_modules/react/',
  '/node_modules/@quilted/',
];

// When building from source, quilt packages are not in node_modules,
// so we instead add their repo paths to the list of framework test strings.
if (process.env.SEWING_KIT_FROM_SOURCE) {
  FRAMEWORK_TEST_STRINGS.push('/quilt/packages/');
}

interface ImportMetadata {
  fromEntry: boolean;
  fromFramework: boolean;
}

// Inspired by Vite: https://github.com/vitejs/vite/blob/c69f83615292953d40f07b1178d1ed1d72abe695/packages/vite/src/node/build.ts#L567
function createManualChunksSorter(): GetManualChunk {
  const cache = new Map<string, ImportMetadata>();

  return (id, {getModuleInfo}) => {
    if (
      !id.includes('node_modules') &&
      !FRAMEWORK_TEST_STRINGS.some((test) => id.includes(test))
    ) {
      return;
    }

    if (id.endsWith('.css')) return;

    const importMetadata = getImportMetadata(id, getModuleInfo, cache);

    if (!importMetadata.fromEntry) return;

    if (importMetadata.fromFramework) {
      return FRAMEWORK_CHUNK_NAME;
    }

    return VENDOR_CHUNK_NAME;
  };
}

function getImportMetadata(
  id: string,
  getModuleInfo: GetModuleInfo,
  cache: Map<string, ImportMetadata>,
  importStack: string[] = [],
): ImportMetadata {
  if (cache.has(id)) return cache.get(id)!;

  if (importStack.includes(id)) {
    // circular dependencies
    const result = {fromEntry: false, fromFramework: false};
    cache.set(id, result);
    return result;
  }

  const module = getModuleInfo(id);

  if (!module) {
    const result = {fromEntry: false, fromFramework: false};
    cache.set(id, result);
    return result;
  }

  if (module.isEntry) {
    const result = {fromEntry: true, fromFramework: false};
    cache.set(id, result);
    return result;
  }

  const newImportStack = [...importStack, id];
  const importersMetadata = module.importers.map((importer) =>
    getImportMetadata(importer, getModuleInfo, cache, newImportStack),
  );

  const result = {
    fromEntry: importersMetadata.some(({fromEntry}) => fromEntry),
    fromFramework:
      FRAMEWORK_TEST_STRINGS.some((test) => id.includes(test)) ||
      importersMetadata.some((importer) => importer.fromFramework),
  };

  cache.set(id, result);
  return result;
}
